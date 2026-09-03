"""Durable Activity History lane — dmfdeploy/dmfdeploy#496.

Read path only. Parses the ``awx write:`` audit line already emitted by
``main.py``'s ``_audit_awx_write`` (and, on the same prefix, the
auto-rollback dispatch's direct module-logger calls) out of Loki, applies
the per-class authorization gate the spec requires (plan §4.3), and maps
each record's outcome to an honest render state (plan §4.4/§4.5).

Domain logic only — the Loki transport itself lives in ``loki.py``; this
module is what calls it and knows what the fields mean.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from datetime import datetime, timezone
import re
import time

import yaml

from . import loki
from .security import MEDIA_ENGINEERS_GROUP, role_at_least


# ----------------------------------------------------------------------
# The query — content match, never a logger-field filter (plan §4.1): the
# auto-rollback dispatch emits the identical "awx write:" shape on the
# module logger, not the audit child logger, so a `logger="dmf_cms.audit"`
# filter would silently drop a covered class.
# ----------------------------------------------------------------------

_NAMESPACE = "dmf-cms"
_JOB = "dmf-cms/dmf-cms"
_QUERY_LABELS = {"namespace": _NAMESPACE, "job": _JOB}
_SELECTOR = f'{{namespace="{_NAMESPACE}", job="{_JOB}"}} |= "awx write:"'

_DEFAULT_TIMEOUT_SECONDS = 10.0

# Technical circuit breakers, NOT retention claims. They exist only so a
# derivation failure never turns into an unbounded Loki query or an
# unbounded result set — the plan's condition 2 is explicit that no
# hardcoded day-count may stand in for a derived window. Neither value is
# ever surfaced as a retention figure: `window.known` reports the real
# derivation outcome regardless of which range/limit the query actually
# used. Chosen far larger than any real profile's period so a KNOWN
# retention window is always the binding constraint when one exists.
_QUERY_RANGE_CEILING_SECONDS = 90 * 24 * 3600
_MAX_RESULT_LINES = 5000


# ----------------------------------------------------------------------
# Line parsing. Format (main.py's _audit_awx_write, plus the auto-rollback
# dispatch's identical-prefix module-logger calls, which append one more
# field):
#
#   awx write: action=%s actor=%s role=%s real_role=%s request_id=%s
#              target=%s reason=%r outcome=%s workload=%s capacity=%s
#              [linked_request_id=%s]
#
# `reason` is a Python repr — quoted, may contain spaces, `=`, and escaped
# quotes — so it is parsed last, via a quote-aware scan, never by treating
# `=` or whitespace as a delimiter. Every other field is parsed by
# anchoring on the NEXT field's own marker starting only from just past the
# current field's marker — sequential, never a whole-line search — which
# is what keeps `request_id=<id>` immune to the trailing
# `linked_request_id=<id>` substring that contains it (plan §4.2's named
# hazard): the search for `request_id=` never runs anywhere near the end
# of the line where `linked_request_id=` lives.
# ----------------------------------------------------------------------

_FIELDS_BEFORE_REASON = ("action", "actor", "role", "real_role", "request_id", "target")
_FIELDS_AFTER_REASON = ("outcome", "workload", "capacity")
_TRAILING_FIELD = "linked_request_id"


def _scan_repr_string_end(text: str, start: int) -> int | None:
    """Return the index just past the closing quote of a Python repr'd str
    literal beginning at ``text[start]``, or None if malformed/unterminated."""
    if start >= len(text):
        return None
    quote = text[start]
    if quote not in ("'", '"'):
        return None
    i = start + 1
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == quote:
            return i + 1
        i += 1
    return None


def parse_awx_write_line(line: str) -> dict[str, str] | None:
    """Parse one ``awx write:`` line's fields, or None if it doesn't parse
    well enough to CLASSIFY the row — action/actor/request_id/target must
    all be cleanly extractable, or the row is dropped, never partially
    admitted (plan §7 AC 5b). A malformed ``reason`` alone does NOT drop
    the row (that's an enrichment failure, not a classification failure —
    see the fallback inline below); the row is retained with a blank
    reason instead.
    """
    idx = line.find("awx write:")
    if idx == -1:
        return None
    tail = line[idx + len("awx write:"):]

    positions: list[int] = []
    pos = 0
    for name in (*_FIELDS_BEFORE_REASON, "reason"):
        marker = f"{name}="
        found = tail.find(marker, pos)
        if found == -1:
            return None
        positions.append(found)
        pos = found + len(marker)

    values: dict[str, str] = {}
    for i, name in enumerate(_FIELDS_BEFORE_REASON):
        start = positions[i] + len(f"{name}=")
        end = positions[i + 1]
        values[name] = tail[start:end].strip()

    reason_start = positions[-1] + len("reason=")
    reason_end = _scan_repr_string_end(tail, reason_start)
    reason_value: str | None = None
    if reason_end is not None:
        try:
            candidate = ast.literal_eval(tail[reason_start:reason_end])
            if isinstance(candidate, str):
                reason_value = candidate
        except (ValueError, SyntaxError):
            pass

    if reason_value is not None:
        values["reason"] = reason_value
        pos = reason_end
    else:
        # AC 5b: a malformed `reason` is an ENRICHMENT failure, not a
        # CLASSIFICATION failure — action/actor/request_id/target already
        # parsed cleanly above, so the row is still fully usable for
        # membership/gating (codex R496-A F5: dropping it here discarded an
        # otherwise-classifiable record over one damaged field). In genuine
        # data this never fires — `reason=%r` is a Python repr, always
        # well-formed — so this path only exists for a truncated/corrupted
        # line, where reason's exact text can no longer be trusted anyway.
        # Best-effort recovery: retain the row with a blank reason and
        # resume parsing at the next bare `outcome=` marker, accepting the
        # same "a stray `outcome=` could truncate early" residual risk
        # reason's quote-aware scan exists to avoid — but only here, on an
        # input that is already broken, never on the well-formed path.
        fallback = tail.find("outcome=", reason_start)
        if fallback == -1:
            return None  # nothing recoverable after this point
        values["reason"] = ""
        pos = fallback

    after_positions: list[int] = []
    for name in _FIELDS_AFTER_REASON:
        marker = f"{name}="
        found = tail.find(marker, pos)
        if found == -1:
            return None
        after_positions.append(found)
        pos = found + len(marker)

    trailing_pos = tail.find(f"{_TRAILING_FIELD}=", pos)
    tail_end = trailing_pos if trailing_pos != -1 else len(tail)
    boundaries = [*after_positions, tail_end]
    for i, name in enumerate(_FIELDS_AFTER_REASON):
        start = boundaries[i] + len(f"{name}=")
        end = boundaries[i + 1]
        values[name] = tail[start:end].strip()

    values[_TRAILING_FIELD] = (
        tail[trailing_pos + len(f"{_TRAILING_FIELD}="):].strip() if trailing_pos != -1 else ""
    )
    return values


# ----------------------------------------------------------------------
# Retention-window derivation (dmfdeploy/dmfdeploy#530's corrected Art. 1):
# the window applicable to the STREAM QUERIED, read from the running Loki
# instance, never rendered inventory. A per-stream `retention_stream`
# selector overrides the global `retention_period` for any stream it
# matches; the global is only the fallback for what nothing else matches.
# ----------------------------------------------------------------------

@dataclass(frozen=True)
class RetentionWindow:
    known: bool
    seconds: int | None
    # "" when known; else "not-enforced" | "unavailable" | "unparseable" —
    # all three are first-class outcomes (plan's condition 2), never
    # collapsed into a guess.
    reason: str


_DURATION_RE = re.compile(r"(\d+)(ms|s|m|h|d|w|y)")
_UNIT_SECONDS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800, "y": 365 * 86400}

_MATCHER_RE = re.compile(r'(\w+)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"')


def _parse_duration_seconds(text: str) -> int | None:
    text = text.strip()
    if not text:
        return None
    matches = _DURATION_RE.findall(text)
    if not matches:
        return None
    if "".join(f"{n}{u}" for n, u in matches) != text:
        return None  # trailing junk after the last recognised unit
    total = sum(int(n) * _UNIT_SECONDS[u] for n, u in matches)
    return int(total)


def _is_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return False


def _selector_matches(selector: str, labels: dict[str, str]) -> bool:
    inner = selector.strip()
    if inner.startswith("{") and inner.endswith("}"):
        inner = inner[1:-1]
    matchers = _MATCHER_RE.findall(inner)
    if not matchers:
        return False  # an empty/unparseable selector is never a silent wildcard
    for label, op, raw_value in matchers:
        value = raw_value.replace('\\"', '"').replace("\\\\", "\\")
        # Prometheus/Loki label-matcher semantics: a label absent from the
        # series is equivalent to that label being present with the value
        # "" — NOT "this matcher can't apply". A negative matcher like
        # {container!="foo"} legitimately matches a query that carries no
        # container label at all (codex R496-A F2b: the earlier `actual is
        # None -> no match` version missed exactly this, silently falling
        # through to a global that may be longer — an over-claim).
        actual = labels.get(label, "")
        try:
            if op == "=" and actual != value:
                return False
            if op == "!=" and actual == value:
                return False
            if op == "=~" and re.fullmatch(value, actual) is None:
                return False
            if op == "!~" and re.fullmatch(value, actual) is not None:
                return False
        except re.error:
            return False  # a broken regex in the deployed config never matches
    return True


def resolve_retention_window(config_yaml: str, labels: dict[str, str]) -> RetentionWindow:
    """Derive the retention window applicable to ``labels`` from Loki's own
    runtime config text (plan condition 1: evaluate the match for real,
    never just read the global)."""
    try:
        config = yaml.safe_load(config_yaml)
    except yaml.YAMLError:
        return RetentionWindow(known=False, seconds=None, reason="unparseable")
    if not isinstance(config, dict):
        return RetentionWindow(known=False, seconds=None, reason="unparseable")

    compactor = config.get("compactor")
    enabled = compactor.get("retention_enabled") if isinstance(compactor, dict) else None
    if not _is_truthy(enabled):
        # Configured but not enforced is not a ceiling (condition 2a).
        return RetentionWindow(known=False, seconds=None, reason="not-enforced")

    limits = config.get("limits_config")
    if not isinstance(limits, dict):
        return RetentionWindow(known=False, seconds=None, reason="unparseable")

    # Collect every matching, parseable rule as (priority, seconds) — codex
    # R496-A F2a: Loki resolves an equal-priority tie by taking the
    # SHORTER period, not "whichever rule was encountered first" (an
    # over-claim risk the same direction #530 exists to prevent). So this
    # can't be a running "best so far" comparison; it needs every matching
    # rule in the top priority tier before it can pick the shortest.
    matches: list[tuple[int, int]] = []
    for rule in limits.get("retention_stream") or []:
        if not isinstance(rule, dict):
            continue
        selector = rule.get("selector")
        period = rule.get("period")
        if not isinstance(selector, str) or not isinstance(period, str):
            continue
        if not _selector_matches(selector, labels):
            continue
        seconds = _parse_duration_seconds(period)
        if seconds is None or seconds <= 0:
            continue  # an unparseable per-stream period never silently wins
        try:
            priority = int(rule.get("priority", 1))
        except (TypeError, ValueError):
            priority = 1
        matches.append((priority, seconds))

    if matches:
        top_priority = max(priority for priority, _ in matches)
        seconds = min(secs for priority, secs in matches if priority == top_priority)
        return RetentionWindow(known=True, seconds=seconds, reason="")

    period_text = limits.get("retention_period")
    if not isinstance(period_text, str) or not period_text.strip():
        return RetentionWindow(known=False, seconds=None, reason="unparseable")

    seconds = _parse_duration_seconds(period_text)
    if seconds is None or seconds <= 0:
        return RetentionWindow(known=False, seconds=None, reason="unparseable")
    return RetentionWindow(known=True, seconds=seconds, reason="")


def _fetch_retention_window(*, loki_url: str, timeout: float) -> RetentionWindow:
    try:
        raw = loki.raw_runtime_config(url=loki_url, timeout=timeout)
    except loki.LokiAPIError:
        return RetentionWindow(known=False, seconds=None, reason="unavailable")
    except Exception:
        return RetentionWindow(known=False, seconds=None, reason="unavailable")
    return resolve_retention_window(raw, _QUERY_LABELS)


# ----------------------------------------------------------------------
# Class membership — the closed table from plan §7 AC 5a. A record class
# absent here fails closed: `classify_record` returns None and the row is
# dropped, never defaulted into covered.
# ----------------------------------------------------------------------

COVERED = "covered"
EXCLUDED_ACCESS = "excluded-access"
EXCLUDED_SCOPE = "excluded-scope"

_GATE_OPERATOR = "operator"
_GATE_MEDIA_WORKLOADS = "media-workloads"

_CLASS_INFO = {
    "deploy": {"status": COVERED, "gate": _GATE_OPERATOR},
    "teardown": {"status": COVERED, "gate": _GATE_OPERATOR},
    "switch-source": {"status": COVERED, "gate": _GATE_MEDIA_WORKLOADS},
    "auto-rollback": {"status": COVERED, "gate": _GATE_OPERATOR},
    "finalise-purge": {"status": EXCLUDED_ACCESS, "gate": None},
    "launch": {"status": EXCLUDED_SCOPE, "gate": None},
    "verify-drain": {"status": EXCLUDED_SCOPE, "gate": None},
    # operator-initiated only — the auto-triggered kind is split out below.
    "rollback": {"status": EXCLUDED_SCOPE, "gate": None},
}

_AUTO_ROLLBACK_ACTOR = "system:auto-rollback"

# What the lane discloses as excluded (plan §7 AC 5), the two reasons kept
# distinct: `finalise-purge` is out because rendering it would WIDEN access
# (its live surface is tenant-scoped, this lane is not); the other three are
# out because this lane cannot render them meaningfully this round — a
# scope decision, reversible, nothing to do with access.
EXCLUDED_DISCLOSURE = (
    {"class": "finalise-purge", "reason": "access"},
    {"class": "launch", "reason": "scope"},
    {"class": "verify-drain", "reason": "scope"},
    {"class": "rollback", "reason": "scope"},
)


def classify_record(action: str, actor: str) -> str | None:
    """Map a parsed row's (action, actor) to a closed class key, or None if
    the action is unrecognised. `rollback` splits by actor BEFORE the table
    lookup — auto-rollback answers to its parent deploy's gate; an
    operator-initiated rollback is excluded regardless of who ran it."""
    if action == "rollback":
        return "auto-rollback" if actor == _AUTO_ROLLBACK_ACTOR else "rollback"
    if action in _CLASS_INFO:
        return action
    return None


def user_passes_gate(cls: str, *, role: str, groups: tuple[str, ...]) -> bool:
    """Per-class authorization (plan §4.3) — the SAME predicate the class's
    own live endpoint uses, applied here after parse, never by widening the
    Loki selector."""
    gate = _CLASS_INFO[cls]["gate"]
    if gate == _GATE_OPERATOR:
        return role_at_least(role, "operator")
    if gate == _GATE_MEDIA_WORKLOADS:
        return role_at_least(role, "engineer") or MEDIA_ENGINEERS_GROUP in groups
    return False  # excluded classes have no gate; never rendered to anyone


# ----------------------------------------------------------------------
# Outcome — per-action semantics (plan §4.4), then the disclosure split
# (plan §4.5): raw system-error strings never render at default.
# ----------------------------------------------------------------------

_AWX_ERROR_PREFIX = "awx-error:"

# ALLOWLIST, not a denylist (codex R496-A F3) — an earlier version of this
# function named the refusal tokens it knew about and treated everything
# else as acceptance. main.py emits FAR more refusal tokens than that list
# named (already-active-other-run, ambiguous-lifecycle-jt, capacity-
# override, confirmation-mismatch, conflict-active-job, entry-not-found,
# invalid-run-id, jt-not-registered, no-job-template, not-purgeable, ... —
# the actual count keeps growing every time a new precondition is added),
# so a denylist silently rendered every one of those as "in flight": the
# lane claiming a thing was still running when it had already, terminally,
# refused. The acceptance vocabulary is the opposite shape — small, stable,
# and fully enumerable from main.py's own `_audit_awx_write(...,
# outcome=...)` call sites, because it names successful DISPATCH/REATTACH
# paths, not every way a precondition can fail. A refusal token added next
# month is terminal automatically; an acceptance token added next month
# needs a one-line addition here, which is the safer failure direction.
#
# "dispatched"/"launched" — the job started (async task-spawn / sync
# launch). "reattached" — get_or_create found an existing op and returned
# it without spawning a new task; the earlier request's dispatch is still
# genuinely running. "already-active" — the sync flow's own idempotency
# guard found an in-flight AWX job and reattached _track_sync_reattach to
# it (same in-flight reality, different code path). "auto-triggered"/
# "already-in-progress" — auto-rollback-specific acceptance shapes (the
# rollback either freshly dispatched or an existing one already covers it;
# either way something is genuinely in flight). "already-active-other-run"
# is DELIBERATELY excluded: it is rollback's identity-mismatch REFUSAL (a
# DIFFERENT run's job was found, so this run's rollback did not dispatch —
# main.py:5315, a 409) and must render failed, not in flight — this was
# the concrete case that proved the old denylist wrong.
_ACCEPTANCE_OUTCOMES: dict[str, frozenset[str]] = {
    "deploy": frozenset({"dispatched", "launched", "reattached", "already-active"}),
    "teardown": frozenset({"dispatched", "launched", "reattached", "already-active"}),
    "rollback": frozenset({
        "dispatched", "launched", "reattached", "already-active",
        "auto-triggered", "already-in-progress",
    }),
    "finalise-purge": frozenset({"dispatched", "reattached"}),
}


def resolve_outcome_state(action: str, outcome: str) -> str:
    """'in_flight' | 'succeeded' | 'failed', per plan §4.4's table.

    switch-source is the one class with a real verdict — "active" is its
    only success value (same allowlist principle: enumerate the known-good
    shape, not the unbounded space of failure codes). Every other watched
    action is acceptance-only, and ONLY a recognised acceptance token means
    "in flight" — everything else, known refusal or not, is terminal.
    """
    if action == "switch-source":
        return "succeeded" if outcome == "active" else "failed"
    acceptance = _ACCEPTANCE_OUTCOMES.get(action)
    if acceptance is not None:
        return "in_flight" if outcome in acceptance else "failed"
    return "failed"  # not a recognised watched action; fail safe, not a crash


_OUTCOME_COPY = {
    "facility-busy": {
        "headline": "Another operation is already using this facility",
        "meaning": "The action could not proceed because a conflicting operation on the same facility is still running.",
        "next_step": "Wait for the in-progress operation to finish, then try again.",
    },
    "awx-not-configured": {
        "headline": "Automation is not connected",
        "meaning": "The console has no working connection to the automation engine, so nothing was dispatched.",
        "next_step": "Contact a system engineer to check the automation engine connection.",
    },
    "template-not-found": {
        "headline": "The automation template could not be found",
        "meaning": "The action refers to an automation template that does not exist or was removed.",
        "next_step": "Contact a system engineer to confirm the catalog and its automation templates are in sync.",
    },
    "capacity-denied": {
        "headline": "Not enough capacity for this action",
        "meaning": "The facility did not have the headroom this action required.",
        "next_step": "Free up capacity, or contact a system engineer, before retrying.",
    },
}

_AWX_ERROR_COPY = {
    "headline": "The automation engine reported an error",
    "meaning": "The action did not complete because the automation engine itself returned an error.",
    "next_step": "Contact a system engineer with the request id below.",
}

_UNRECOGNISED_FAILURE_COPY = {
    "headline": "The action did not complete",
    "meaning": "The action failed. This lane does not yet have specific guidance for the reason recorded.",
    "next_step": "Contact a system engineer with the request id below.",
}


def _describe_failure(outcome: str) -> dict[str, str]:
    if outcome in _OUTCOME_COPY:
        return _OUTCOME_COPY[outcome]
    if outcome.startswith(_AWX_ERROR_PREFIX):
        return _AWX_ERROR_COPY
    # Anything else — including switch-source's own spec-locked SwitchStatus
    # failure codes — falls here: honest and generic, never the raw string,
    # never invented detail this plan didn't specify (plan §4.5).
    return _UNRECOGNISED_FAILURE_COPY


def build_outcome(action: str, outcome: str) -> dict[str, object]:
    state = resolve_outcome_state(action, outcome)
    if state != "failed":
        return {"state": state, "detail": outcome}
    copy = _describe_failure(outcome)
    return {
        "state": "failed",
        "headline": copy["headline"],
        "meaning": copy["meaning"],
        "next_step": copy["next_step"],
        # Raw token, carried on the SAME record (Art. 1: one truth, two
        # resolutions) — the frontend renders this only at expert level,
        # never at default (plan §4.5, AC 2a).
        "detail": outcome,
    }


# ----------------------------------------------------------------------
# Orchestration.
# ----------------------------------------------------------------------

def _iso(ts_ns_str: str) -> str:
    try:
        return datetime.fromtimestamp(int(ts_ns_str) / 1_000_000_000, tz=timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        return ""


def list_audit_events(
    *,
    loki_url: str,
    loki_configured: bool,
    role: str,
    groups: tuple[str, ...],
    now_ns: int | None = None,
    timeout: float = _DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, object]:
    """The full read: retention window, bounded query, parse, gate, shape.

    Always returns a well-formed 200-shaped payload (never raises) — the
    caller (main.py's endpoint) wraps this directly. `reason` distinguishes
    a genuine empty history from "we could not ask" (plan AC 7); `window`
    is a separate, independently-failing axis (plan condition 2).
    """
    if now_ns is None:
        now_ns = time.time_ns()

    if not loki_configured:
        return {
            "reason": "loki-unconfigured",
            "window": {"known": False, "seconds": None, "reason": "unavailable"},
            "capped": False,
            "excluded": list(EXCLUDED_DISCLOSURE),
            "events": [],
        }

    window = _fetch_retention_window(loki_url=loki_url, timeout=timeout)
    range_seconds = window.seconds if window.known else _QUERY_RANGE_CEILING_SECONDS
    start_ns = now_ns - range_seconds * 1_000_000_000
    window_payload = {"known": window.known, "seconds": window.seconds, "reason": window.reason}

    try:
        raw_results = loki.query_range(
            url=loki_url,
            selector=_SELECTOR,
            start_ns=start_ns,
            end_ns=now_ns,
            limit=_MAX_RESULT_LINES,
            timeout=timeout,
        )
    except Exception:
        return {
            "reason": "loki-unreachable",
            "window": window_payload,
            "capped": False,
            "excluded": list(EXCLUDED_DISCLOSURE),
            "events": [],
        }

    rows: list[tuple[str, dict[str, str]]] = []
    total_lines = 0
    for stream in raw_results:
        for entry in stream.get("values", []):
            total_lines += 1
            if not isinstance(entry, (list, tuple)) or len(entry) != 2:
                continue
            ts_ns_str, line = entry
            fields = parse_awx_write_line(line)
            if fields is None:
                continue  # AC 5b: fails to parse -> excluded, not defaulted in
            rows.append((ts_ns_str, fields))

    rows.sort(key=lambda row: row[0], reverse=True)  # newest first, merged across streams

    # codex R496-A F6: a bound that binds must be disclosed, not just
    # applied silently. Two ways this read can be less than exhaustive
    # without LOOKING like it: (1) the window derivation failed, so the
    # query actually ran against the technical ceiling
    # (_QUERY_RANGE_CEILING_SECONDS) instead of a real retention window —
    # there could be real history further back the ceiling never reached;
    # (2) the raw result count hit _MAX_RESULT_LINES, meaning Loki's own
    # limit may have truncated real rows before this function ever saw
    # them. Either way, a response that renders as an ordinary, complete
    # 200 would be exactly the untrue "coverage" claim #530 exists to
    # remove — so both fold into one explicit signal the caller must
    # disclose, distinct from a genuinely exhaustive empty/non-empty read.
    capped = (not window.known) or (total_lines >= _MAX_RESULT_LINES)

    # Structured join map (request_id -> workload), built from PARSED
    # fields only — never a raw-text search. This is what makes the join
    # immune to the `linked_request_id=<id>` / `request_id=<id>` substring
    # trap (plan §4.2): the lookup key below is a cleanly parsed field
    # value, matched by exact equality against other cleanly parsed values,
    # never a substring search over raw log text.
    workload_by_request_id: dict[str, str] = {
        fields["request_id"]: fields["workload"]
        for _ts, fields in rows
        if fields.get("workload") and fields.get("request_id")
    }

    events: list[dict[str, object]] = []
    for ts_ns_str, fields in rows:
        action = fields.get("action", "")
        actor = fields.get("actor", "")
        cls = classify_record(action, actor)
        if cls is None or _CLASS_INFO[cls]["status"] != COVERED:
            continue
        if not user_passes_gate(cls, role=role, groups=groups):
            continue

        workload = fields.get("workload") or ""
        if cls == "auto-rollback" and not workload:
            # Display-only join (plan §4.3): degrades the label, never the
            # row's presence. A missing/blank parent leaves this blank.
            workload = workload_by_request_id.get(fields.get("linked_request_id", ""), "")

        events.append({
            "request_id": fields.get("request_id", ""),
            "class": cls,
            "action": action,
            "target": fields.get("target", ""),
            "workload": workload or None,
            "actor": actor,
            "role": fields.get("role", ""),
            "reason": fields.get("reason", ""),
            "at": _iso(ts_ns_str),
            "outcome": build_outcome(action, fields.get("outcome", "")),
        })

    return {
        "reason": "",
        "window": window_payload,
        "capped": capped,
        "excluded": list(EXCLUDED_DISCLOSURE),
        "events": events,
    }
