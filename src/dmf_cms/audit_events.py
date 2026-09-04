"""Durable Activity History lane — dmfdeploy/dmfdeploy#496.

Read path only. Parses the ``awx write:`` audit line already emitted by
``main.py``'s ``_audit_awx_write`` (and, on the same prefix and the same
``audit_logger``, the auto-rollback dispatch's direct emissions) out of
Loki, applies the per-class authorization gate the spec requires (plan
§4.3), and maps each record's outcome to an honest render state (plan
§4.4/§4.5).

Domain logic only — the Loki transport itself lives in ``loki.py``; this
module is what calls it and knows what the fields mean.

STATUS NOTE for whoever opens this file believing it is production-grade
(operator ruling, 2026-09-03): it is not, and the boundary is exact. The
CLASS MEMBERSHIP TABLE, the PER-CLASS AUTHORIZATION GATES, the OUTCOME
HONESTY RULES (the acceptance allowlist, the unknown-vs-failed-vs-
in-flight-vs-succeeded distinction, never claiming completion a watched
action hasn't reached), the DERIVED RETENTION WINDOW, and the OUTCOME
COMPLETENESS GUARD are the durable design and are meant to survive
whatever replaces the transport underneath them. The LINE PARSER below is
not that — it is a demo-scoped stopgap over a text log format.

THE WRITER FIX (dmfdeploy/dmf-cms#140, 2026-09-03): seven review rounds
finding a new forgery vector after every fix converged on a live, PROVEN
case — not merely unfound — where a forged line and a legitimate one were
byte-identical, so no reader-side check could ever have existed for it.
The operator's decision was to fix the WRITER instead of continuing to
harden the reader: ``main.py``'s ``_audit_awx_write`` (and the
auto-rollback dispatch's identical-prefix, identical-logger direct calls)
quote FIVE fields with ``%r`` — ``target``, ``actor``, ``reason``, ``workload``,
``capacity`` — the same repr treatment ``reason`` has always had.
``action``, ``role``, ``real_role``, ``request_id`` and ``outcome`` stay
plain: every one of them is code-generated with a constrained shape,
never externally sourced (``action`` a fixed literal per call site;
``role``/``real_role`` server-computed from group membership;
``request_id`` always ``uuid.uuid4().hex``; ``outcome`` always one of a
closed, short, server-chosen set of tokens). Every line also carries an
explicit ``fmt=2`` marker immediately after the "awx write: " prefix.

LEGACY LINES ARE NOT RENDERED, and this is an operator decision, not an
implementation shortcut. lkirc's review said it plainly, twice: "The
writer fix protects future records but cannot make retained ones
trustworthy; fail closed/drop or otherwise authenticate legacy records
before rendering them" — correct on principle, since a forged legacy line
and a legitimate one were PROVEN byte-identical, so no reader-side check
could ever authenticate one. ``parse_awx_write_line`` below drops any line
without a valid ``fmt=2`` marker at its first check — not parsed by a
weaker fallback grammar, not surfaced at all. This is a genuine product
cost, not a technicality: the lane shows nothing from before the writer
fix shipped, until new-format lines accumulate.

``test_writer_fix_round_trip_*`` in ``tests/test_audit_events_endpoint.py``
is the actual evidence, not the absence of a failing test: real payloads
through the REAL emitter, parsed by the REAL reader, confirmed to come
back as literal field content, never as forged structure.

TWO SEPARATE MECHANISMS close two SEPARATE claims this parser makes, and
they must be reasoned about independently, not as one "closed" property:

1. FIELD BOUNDARIES — "the fields I extracted from this record are the
   ones the writer put there, not ones a caller's own data forged partway
   through it." Proven by the fmt=2 grammar: target/actor/reason/
   workload/capacity are quote-scanned, never boundary-guessed, so no
   field's content can ever be mistaken for a later field's marker (see
   ``_parse_new_format_line`` below). This is the historical record of
   the SEVEN vectors below, and it is closed BY CONSTRUCTION for every
   line that reaches ``_parse_new_format_line`` — no residual gap in
   THIS mechanism, no second grammar with weaker protections, no
   migration window to bound.

2. PROVENANCE — "this record came from the writer at all, not from
   caller/upstream content that happened to be reflected, verbatim, into
   some UNRELATED log call on the same stdout stream." lkirc's EIGHTH
   finding (2026-09-04) proved mechanism 1 has nothing to say about this:
   quoting a forged line's fields perfectly does not prove the line was
   never forged in the first place, if an attacker can get their own
   well-formed ``awx write: fmt=2 ...`` text echoed inside e.g. an AWX
   error body that a DIFFERENT log call reports verbatim (main.py's
   ``*APIError`` handlers, `_sanitize_audit_field`-escaped for CR/LF
   only, never for this). Closed by REQUIRING the record's actual
   ``logging.Logger`` identity, not by any content check: ``audit_logger``
   (``logging.getLogger("dmf_cms.audit")``) is used for NOTHING else
   anywhere in this codebase, so ``parse_awx_write_line`` below parses
   the fixed asctime/levelname/name/message shape ``_configure_logging``'s
   own formatter always produces STRUCTURALLY — by position, never by
   searching the line for a substring — and requires the parsed name to
   equal ``dmf_cms.audit`` before it will even look at the message.
   Logger identity is a property of which CODE PATH emitted a record, not
   of any value that code path's message happens to contain, so no
   caller/upstream content can ever forge it. A content-shape rule (a
   longer marker string, or requiring the marker merely be the first
   thing in the MESSAGE) was considered and rejected: both are still
   substring searches an attacker who fully controls the reflected text
   can simply include, which is the same class of mistake mechanism 1
   already spent seven rounds learning not to make one level down.

Historical record of the seven FIELD-BOUNDARY vectors mechanism 1 closes
(found by codex across several review rounds, and for the sixth, by a
human reviewer codex's own pass had missed; each mutation-tested at the
time): a caller-controlled field's raw text hijacking a later field's
boundary; detection and extraction disagreeing about what a marker even
is; over-correcting into rejecting legitimate rows whose own text
happened to contain marker-shaped substrings; a truncated genuine reason
marker losing to an injected complete one; a caller-controlled value
legitimately containing marker-shaped text being mistaken for structure
by a check that didn't know it was looking inside an already-safely-
bounded quoted span; and a forged line proven byte-identical to a
legitimate one, unclosable by any reader-side check — the finding that
ended the reader-hardening approach entirely and moved the fix upstream
to the writer, with an explicit format marker so the reader never again
has to guess which grammar a line was written in. The EIGHTH vector,
above, is not a member of this list — it is a different mechanism
closing a different claim, and any future, NINTH finding of the same
provenance shape belongs with it, not folded back into the field-
boundary list it has nothing to do with.
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
# The query — a coarse content match, never a Loki-level logger filter:
# logger name is not an indexed Loki label this query can select on (only
# namespace/job are — see _QUERY_LABELS), it is text this reader itself
# parses back out of each candidate line (see parse_awx_write_line's own
# provenance check, module STATUS NOTE mechanism 2). This `|= "awx
# write:"` filter exists purely to keep the fetched volume down; it is
# NOT the security boundary and deliberately admits lines that will later
# fail the real, structural check (e.g. a reflected body that merely
# CONTAINS the substring) — that is expected and safe, not a gap.
#
# vector-8 fix (2026-09-04): the auto-rollback dispatch used to emit on
# the plain module logger, not the audit child logger — main.py now
# routes it through `audit_logger` too, so `dmf_cms.audit` is EXCLUSIVE
# to genuine records and the provenance check below has something to
# check against for every covered class, not just _audit_awx_write's own.
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
# Line parsing — ONE grammar (dmfdeploy/dmf-cms#140's writer fix), on
# lines PROVEN to come from ``audit_logger`` (dmfdeploy/dmf-cms#140's
# eighth-round, provenance fix). A line failing either check is not
# rendered at all; see the module STATUS NOTE's two-mechanism split.
#
#   <asctime> <levelname> dmf_cms.audit: awx write: fmt=2 action=%s
#       actor=%r role=%s real_role=%s request_id=%s target=%r reason=%r
#       outcome=%s workload=%r capacity=%r [linked_request_id=%s]
#
# `request_id=<id>` is immune to the trailing `linked_request_id=<id>`
# substring that contains it (plan §4.2's named hazard): every plain
# field's search anchors on the NEXT field's own marker starting only
# from just past the current field's marker — sequential, never a
# whole-line search.
# ----------------------------------------------------------------------

# The fixed shape _configure_logging's own Formatter always produces
# (main.py: ``"%(asctime)s %(levelname)s %(name)s: %(message)s"``) —
# asctime/levelname/name are LogRecord attributes the formatter emits
# BEFORE the message, never derived from anything the message contains,
# so no caller/upstream value reflected INTO a message can ever alter
# what this pattern extracts for `name`. Matched by POSITION against the
# whole line, never by searching for a substring anywhere in it — that
# distinction is the entire fix (dmfdeploy/dmf-cms#140, eighth round):
# `line.find("awx write:")` would happily find the marker wherever a
# reflected upstream/caller value put it, on ANY logger's line; this
# requires it to be the first thing the ACTUAL emitting logger's message
# says, and requires that logger to genuinely be `_AUDIT_LOGGER_NAME`.
_LOG_LINE_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} \S+ (?P<name>\S+): (?P<message>.*)\Z",
    re.DOTALL,
)

# `logging.getLogger("dmf_cms.audit")` in main.py — used at exactly ONE
# call site there (`_audit_awx_write`) plus, as of this fix, the
# auto-rollback dispatch's two direct emissions, and NOTHING else in this
# codebase. That exclusivity is what makes this name meaningful evidence
# of provenance rather than another string to match: it is a property of
# which CODE PATH emitted a record, never of any value that code path's
# own message happens to contain.
_AUDIT_LOGGER_NAME = "dmf_cms.audit"

_TRAILING_FIELD = "linked_request_id"

_ALL_MARKER_NAMES = (
    "action", "actor", "role", "real_role", "request_id",
    "target", "reason", "outcome", "workload", "capacity",
    _TRAILING_FIELD,
)


def _marker_pattern(name: str) -> re.Pattern[str]:
    # Left word-boundary only: "request_id=" must never match inside
    # "linked_request_id=" (plan §4.2's own documented substring trap) —
    # a marker only counts if the character before it is not part of a
    # longer identifier. No right-boundary check needed: every name here
    # is immediately followed by "=", which is not an identifier
    # character, so "=" itself terminates the match unambiguously.
    #
    # \w, not [A-Za-z0-9_]: Python 3 str patterns are Unicode-aware by
    # default, so a marker glued directly after a non-ASCII identifier
    # character (e.g. a catalog key ending in an accented letter) stays
    # part of that field's own value, not a boundary.
    return re.compile(r"(?<!\w)" + re.escape(name) + "=")


_MARKER_PATTERNS = {name: _marker_pattern(name) for name in _ALL_MARKER_NAMES}

_FMT_MARKER_RE = re.compile(r"^\s*fmt=(\d+)\s")
_NEW_FORMAT_VERSION = "2"


def _find_marker(tail: str, name: str, start: int) -> int | None:
    """Position of the first occurrence of ``<name>=`` at or after
    ``start``, using the single shared boundary-aware definition
    (``_MARKER_PATTERNS``). Every plain-field search in this module is
    built on it, and every quoted field's own marker is found this way
    too (only the VALUE that follows is parsed differently)."""
    match = _MARKER_PATTERNS[name].search(tail, start)
    return match.start() if match else None


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


def _require_quoted_field(tail: str, name: str, start: int) -> tuple[int, str, int] | None:
    """Locate ``<name>=`` at/after ``start`` and REQUIRE its value to be
    repr-quoted — the fmt=2 grammar's contract for target/actor/reason/
    workload/capacity (dmfdeploy/dmf-cms#140).

    Returns ``(marker_pos, value, value_end)`` on success. Returns
    ``None`` if the marker is missing, its value does not start with a
    quote at all, the quote opens but never validly closes, or it doesn't
    ``literal_eval`` to a str — EVERY one of those is a hard
    classification failure (AC 5b), never a partial admission.

    ``value_end`` is the index just past the closing quote — the caller's
    search for the NEXT field starts there, with no further ambiguity
    check needed for THIS field's own boundary: quote-scanning already
    proved it, unconditionally, regardless of what marker-shaped text the
    value contains.
    """
    marker = _find_marker(tail, name, start)
    if marker is None:
        return None
    value_start = marker + len(f"{name}=")
    if value_start >= len(tail) or tail[value_start] not in ("'", '"'):
        return None  # fmt=2 promises quoting; not quoted at all is a hard failure
    value_end = _scan_repr_string_end(tail, value_start)
    if value_end is None:
        return None  # opened a quote, never closed
    try:
        candidate = ast.literal_eval(tail[value_start:value_end])
    except (ValueError, SyntaxError):
        return None
    if not isinstance(candidate, str):
        return None
    return marker, candidate, value_end


def parse_awx_write_line(line: str) -> dict[str, str] | None:
    """Parse one raw Loki line into a record, or None if it fails either
    of the two independent checks this module's STATUS NOTE describes —
    provenance, then field boundaries (plan §7 AC 5b).

    PROVENANCE (dmfdeploy/dmf-cms#140, eighth round): ``line`` must
    structurally match `_configure_logging`'s own fixed formatter shape,
    matched by POSITION, never by searching for "awx write:" anywhere in
    the line — a caller/upstream value reflected verbatim into some OTHER
    log call's message can never satisfy this, because it never
    determines which ``logging.Logger`` actually emitted the surrounding
    record. The parsed logger name must equal ``_AUDIT_LOGGER_NAME``
    exactly, and the message it carries must begin with "awx write:" as
    its very first characters — not merely contain it — since a genuine
    emission's format string always starts there literally.

    FIELD BOUNDARIES: once provenance is proven, the message tail must
    carry a valid ``fmt=2`` marker (operator decision, 2026-09-03: any
    line without one — malformed marker, unsupported version, or none at
    all — is rejected identically; there is exactly one way to be
    accepted) and then parse under the fmt=2 grammar.
    """
    match = _LOG_LINE_RE.match(line)
    if match is None or match.group("name") != _AUDIT_LOGGER_NAME:
        return None
    message = match.group("message")
    if not message.startswith("awx write:"):
        return None
    tail = message[len("awx write:"):]

    fmt_match = _FMT_MARKER_RE.match(tail)
    if fmt_match is None or fmt_match.group(1) != _NEW_FORMAT_VERSION:
        return None
    return _parse_new_format_line(tail[fmt_match.end():])


def _parse_new_format_line(tail: str) -> dict[str, str] | None:
    """Parse the fmt=2 grammar (dmfdeploy/dmf-cms#140, the writer fix):
    target, actor, reason, workload and capacity are ALL required to be
    repr-quoted — every one of their boundaries is PROVEN by quote-
    scanning, never guessed, so this function needs no ambiguity checks
    anywhere. No field's content can ever be mistaken for another field's
    marker, because none of the quoted fields' boundaries depend on
    searching for the next one — each is independently closed by its own
    quote, and the search for the NEXT field's marker always starts
    exactly where the current one's quote-scan ended.

    ``action``, ``role``, ``real_role``, ``request_id`` and ``outcome``
    stay plain (``%s``) — every one of them is code-generated with a
    constrained shape, never externally sourced.

    Any violation of the fmt=2 contract — a quotable field missing, not
    quoted, or malformed — is a hard classification failure (AC 5b).
    """
    action_marker = _find_marker(tail, "action", 0)
    if action_marker is None:
        return None
    action_value_start = action_marker + len("action=")

    actor_result = _require_quoted_field(tail, "actor", action_value_start)
    if actor_result is None:
        return None
    actor_marker, actor_value, pos = actor_result

    role_marker = _find_marker(tail, "role", pos)
    if role_marker is None:
        return None
    role_value_start = role_marker + len("role=")

    real_role_marker = _find_marker(tail, "real_role", role_value_start)
    if real_role_marker is None:
        return None
    real_role_value_start = real_role_marker + len("real_role=")

    request_id_marker = _find_marker(tail, "request_id", real_role_value_start)
    if request_id_marker is None:
        return None
    request_id_value_start = request_id_marker + len("request_id=")

    target_result = _require_quoted_field(tail, "target", request_id_value_start)
    if target_result is None:
        return None
    target_marker, target_value, pos = target_result

    reason_result = _require_quoted_field(tail, "reason", pos)
    if reason_result is None:
        return None
    _reason_marker, reason_value, pos = reason_result

    outcome_marker = _find_marker(tail, "outcome", pos)
    if outcome_marker is None:
        return None
    outcome_value_start = outcome_marker + len("outcome=")

    workload_result = _require_quoted_field(tail, "workload", outcome_value_start)
    if workload_result is None:
        return None
    workload_marker, workload_value, pos = workload_result

    capacity_result = _require_quoted_field(tail, "capacity", pos)
    if capacity_result is None:
        return None
    _capacity_marker, capacity_value, pos = capacity_result

    values: dict[str, str] = {
        "action": tail[action_value_start:actor_marker].strip(),
        "actor": actor_value,
        "role": tail[role_value_start:real_role_marker].strip(),
        "real_role": tail[real_role_value_start:request_id_marker].strip(),
        "request_id": tail[request_id_value_start:target_marker].strip(),
        "target": target_value,
        "reason": reason_value,
        "outcome": tail[outcome_value_start:workload_marker].strip(),
        "workload": workload_value,
        "capacity": capacity_value,
    }

    # linked_request_id — plain, optional trailing field. No ambiguity
    # check needed: every quotable field between here and the start of
    # the line is independently quote-bound, so nothing upstream can
    # inject a fake marker for this one either.
    trailing_marker = _find_marker(tail, _TRAILING_FIELD, pos)
    values[_TRAILING_FIELD] = (
        tail[trailing_marker + len(f"{_TRAILING_FIELD}="):].strip() if trailing_marker is not None else ""
    )

    if values[_TRAILING_FIELD] and not (
        values["action"] == "rollback" and values["actor"] == _AUTO_ROLLBACK_ACTOR
    ):
        return None

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
#
# "capacity-skipped"/"capacity-override" (deploy only, codex R496-A NEW-1
# — the allowlist's own first pass still missed these two) — both are
# L3-preflight outcomes where the run PROCEEDS regardless: `l3.enabled is
# False` skips the tier and continues (main.py:485-490, docstring: "Skips
# with an audited capacity-skipped outcome"), and an operator override
# continues into dispatch by definition (main.py:553-588, docstring: "the
# run proceeds anyway"). Both are followed by a real dispatch further down
# the same request, so treating them as terminal was the exact inverse
# defect the allowlist inversion (F3) was fixing — a SUCCESSFUL deploy
# preflight rendering as a failed action. Verified against the two
# call sites directly, not assumed from the token names. See
# tests/test_audit_events_outcome_completeness.py for the mechanical
# guard that is meant to catch the NEXT one of these before it ships,
# instead of trusting this list to stay complete by inspection.
_ACCEPTANCE_OUTCOMES: dict[str, frozenset[str]] = {
    "deploy": frozenset({
        "dispatched", "launched", "reattached", "already-active",
        "capacity-skipped", "capacity-override",
    }),
    "teardown": frozenset({"dispatched", "launched", "reattached", "already-active"}),
    "rollback": frozenset({
        "dispatched", "launched", "reattached", "already-active",
        "auto-triggered", "already-in-progress",
    }),
    "finalise-purge": frozenset({"dispatched", "reattached"}),
}


def resolve_outcome_state(action: str, outcome: str) -> str:
    """'in_flight' | 'succeeded' | 'failed' | 'unknown', per plan §4.4's table.

    'unknown' is a THIRD case, never a member of "an unenumerated token is
    terminal" — that rule stays exactly as it was (F3, re-confirmed
    codex R496-B/C) for any REAL, non-blank token. A blank outcome is
    different in kind: it means the record's outcome field is blank on an
    otherwise complete, parseable line — codex R496-C P1-2's finding.
    dmfdeploy/dmfdeploy#553: NOT a truncated/corrupted line — that fails
    one of _parse_new_format_line's required-quoted-field checks and is
    dropped by the caller (`if fields is None: continue`) before this
    function ever runs; only a line that parses in full, with an
    explicitly empty outcome= value, reaches here. "Not proven in flight"
    is NOT "the action failed"; rendering a lost outcome as a definite
    failure would be this lane claiming knowledge it does not have, the
    same defect this whole round exists to remove, just with the
    opposite sign. So this check runs FIRST, before either the
    switch-source or the acceptance-allowlist branch, and neither of
    those ever sees a blank outcome.

    switch-source is the one class with a real verdict — "active" is its
    only success value (same allowlist principle: enumerate the known-good
    shape, not the unbounded space of failure codes). Every other watched
    action is acceptance-only, and ONLY a recognised acceptance token means
    "in flight" — everything else REAL, known refusal or not, is terminal.
    """
    if not outcome:
        return "unknown"
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

# codex R496-C P1-2: an honest THIRD answer, never collapsed into the
# failure copy above — "we could not read this record's outcome" is not
# "this record's action failed".
_UNKNOWN_OUTCOME_COPY = {
    "headline": "Outcome unknown",
    "meaning": "This action's outcome could not be read from the record — it may have succeeded, failed, or still be in progress.",
    "next_step": "If this persists, contact a system engineer with the request id below.",
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
    if state == "unknown":
        return {
            "state": "unknown",
            "headline": _UNKNOWN_OUTCOME_COPY["headline"],
            "meaning": _UNKNOWN_OUTCOME_COPY["meaning"],
            "next_step": _UNKNOWN_OUTCOME_COPY["next_step"],
            "detail": outcome,  # always "" for this state; carried for shape uniformity
        }
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
            # lkirc (dmfdeploy/dmf-cms#140): a single request_id can
            # legitimately carry MULTIPLE rows — e.g. an L3 preflight's
            # own capacity-skipped/capacity-override line (main.py:488,
            # :580) shares its request_id with that same request's later
            # dispatched line (main.py:4868). request_id alone is not a
            # per-ROW identity. `at_ns` is Loki's own raw nanosecond
            # timestamp string for THIS log line, unrounded — `_iso`
            # above is for display and loses precision below
            # microseconds (Python's own datetime ceiling); this is the
            # real, source-of-truth per-log identity the frontend keys
            # rows on, never used for display itself.
            "at_ns": ts_ns_str,
            "outcome": build_outcome(action, fields.get("outcome", "")),
        })

    return {
        "reason": "",
        "window": window_payload,
        "capped": capped,
        "excluded": list(EXCLUDED_DISCLOSURE),
        "events": events,
    }
