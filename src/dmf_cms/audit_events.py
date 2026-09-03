"""Durable Activity History lane — dmfdeploy/dmfdeploy#496.

Read path only. Parses the ``awx write:`` audit line already emitted by
``main.py``'s ``_audit_awx_write`` (and, on the same prefix, the
auto-rollback dispatch's direct module-logger calls) out of Loki, applies
the per-class authorization gate the spec requires (plan §4.3), and maps
each record's outcome to an honest render state (plan §4.4/§4.5).

Domain logic only — the Loki transport itself lives in ``loki.py``; this
module is what calls it and knows what the fields mean.

STATUS NOTE for whoever opens this file believing it is production-grade
(operator ruling, 2026-09-03): it is not, and the boundary is exact. The
CLASS MEMBERSHIP TABLE, the PER-CLASS AUTHORIZATION GATES, the OUTCOME
HONESTY RULES (the acceptance allowlist, the unknown-vs-failed-vs-
in-flight-vs-succeeded distinction, never claiming completion a watched
action hasn't reached), the DERIVED RETENTION WINDOW, and the OUTCOME
COMPLETENESS GUARD are the durable design and are meant to survive
whatever replaces the transport underneath them. ``parse_awx_write_line``
below is not that — it is a demo-scoped stopgap over a text log format
that was never designed to be unambiguously re-parsed. What CHANGED,
same day: seven review rounds finding a new forgery vector after every
fix converged on a live, PROVEN case (not merely unfound) where a forged
line and a legitimate one were byte-identical — no reader-side check
could ever have existed for it. The operator's decision was to fix the
WRITER instead of continuing to harden the reader: ``target``,
``workload`` and ``capacity`` are now quoted with ``%r`` in
``main.py``'s ``_audit_awx_write`` (and the auto-rollback dispatch's
identical-prefix module-logger calls) — the SAME repr treatment
``reason`` has always had, not merely the control-character escaping
(``_sanitize_audit_field``, staying on one physical stdout line) those
three fields used to get. ``action`` is a fixed literal per call site;
``role``/``real_role`` are server-computed from group membership;
``request_id`` is always ``uuid.uuid4().hex``; ``outcome`` is always one
of a closed, short, server-chosen set of tokens — none of those four go
through any escaping, because their SOURCE constrains them. ``actor``
(``user.subject``) is the one field still routed through
``_sanitize_audit_field`` rather than quoted — out of scope for the
writer fix; see ``_find_unambiguous_marker``'s docstring for why it was
judged not directly caller-controlled in this system's actual
configuration.

WHAT IS CLOSED, and how completely, matters more than a single verdict:
for any line emitted AFTER this fix — target/workload/capacity's
boundaries are PROVABLE by quote-scanning, not guessed, so a
caller-controlled value containing marker-shaped text (however
constructed — glued, truncated, nested, whatever the next reviewer
thinks to try) is recorded FAITHFULLY and structurally CANNOT alter the
parse of any other field. That is every one of the seven vectors found
across this arc closed BY CONSTRUCTION, including the one that was
proven byte-identical to legitimate data and therefore unclosable by any
reader-side check — quoting removes the ambiguity the byte-identity
argument depended on. ``test_writer_fix_round_trip_*`` in
``tests/test_audit_events_endpoint.py`` is the actual evidence: it calls
the REAL emitter with a forged-looking value and confirms the REAL
reader gets back the real, literal content — not the absence of a
failing test.

LINES ALREADY IN LOKI, in the legacy unquoted shape, are UNCHANGED by
any of this and stay parseable by the exact pre-fix mechanism
(``parse_awx_write_line`` tries the new quote-scanned reading first for
each of the three fields and falls back to the legacy
positional/ambiguity-checked handling only when a value doesn't start
with a quote at all — see ``_parse_quotable_field``). Six of the seven
vectors found this arc were ALREADY closed on the legacy path before
this fix (mutation-tested, each named in the fix history below); the
seventh — a forged line and a legitimate one being byte-for-byte
identical — remains structurally unclosable for a legacy-format line,
exactly as it always was, because nothing about re-reading old bytes can
retroactively add a quote nobody wrote. That gap is BOUNDED, not
permanent — but stating the bound is EXACTLY the mistake
dmfdeploy/dmfdeploy#530 exists to prevent, so state it #530's way, not as
a number: THE WINDOW IS THE DEPLOYED RETENTION, WHATEVER THE PROFILE
SETS, never a role default cited as if it were deployed reality. dmf-cms's
own Loki stream carries no per-stream retention override
(dmfdeploy/dmfdeploy#530's three ``retention_stream`` selectors are all
security streams, none matching ``job="dmf-cms/dmf-cms"``), so it falls to
whatever the deploying profile's ``loki_retention`` is. dmf-infra's OWN
role default is 720h/30 days — but a deploying profile overrides that
default, and the sandbox profile this ships to does: dmf-env's
``bin/init-wizard.sh`` sets ``loki_retention: 168h`` (7 days) for the
sandbox — that citation is the committed GENERATOR, not a live reading of
a rendered inventory, which is the only thing that would fully settle it.
So on the environment this actually ships to, a legacy-format line is
gone, unconditionally, within 7 days of this fix shipping — not 30. Do
not "simplify" this back to a single code path before that window has
fully elapsed on whatever environment is actually running this; the dual
handling is what lets old data keep working at all during it.

The five forgery vectors closed on the legacy path, for the historical
record: a caller-controlled field's raw text hijacking a later field's
boundary; detection and extraction disagreeing about what a marker even
is; the fix for the first two over-correcting into rejecting legitimate
rows whose own text happened to contain marker-shaped substrings; a
truncated genuine reason marker losing to an injected complete one; and
target's OWN captured value legitimately containing marker-shaped text
being over-rejected by a duplicate-marker check that didn't know it was
now looking inside an already-safely-bounded quoted span (the same
fix that closes the writer side also had to be taught not to re-flag
its own success). Each was found by an adversarial review round (codex
and, for the sixth, a human reviewer codex's own pass had missed) and
is mutation-tested. Do not treat a clean review pass — on either path —
as proof there is no next case on THAT path; treat it as the ceiling of
what hardening a hand-rolled boundary scanner can promise for data that
was never quoted to begin with. The production answer for the legacy
path, while it still exists, was always the deferred structured envelope
(plan §5); for the current path, quoting the caller-controlled fields
IS that answer, applied narrowly rather than deferred.
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
# field) — CURRENT emitter, dmfdeploy/dmfdeploy#140's writer fix
# (2026-09-03, operator decision after a live, provably-unclosable sixth
# forgery vector on the reader alone: `forged bytes == legitimate bytes`
# for the one remaining shape):
#
#   awx write: action=%s actor=%s role=%s real_role=%s request_id=%s
#              target=%r reason=%r outcome=%s workload=%r capacity=%r
#              [linked_request_id=%s]
#
# `target`, `reason`, `workload` and `capacity` are ALL Python reprs now —
# quoted, may contain spaces, `=`, and escaped quotes — parsed via a
# quote-aware scan, never by treating `=` or whitespace as a delimiter.
# `reason` always has been; `target`/`workload`/`capacity` are the three
# CALLER-INFLUENCED fields the writer fix specifically closes (see the
# module STATUS NOTE below for exactly what "closes" means and for which
# lines). Every other field (action/actor/role/real_role/request_id/
# outcome/linked_request_id) is never caller-controlled and stays `%s`,
# parsed by anchoring on the NEXT field's own marker starting only from
# just past the current field's marker — sequential, never a whole-line
# search — which is what keeps `request_id=<id>` immune to the trailing
# `linked_request_id=<id>` substring that contains it (plan §4.2's named
# hazard): the search for `request_id=` never runs anywhere near the end
# of the line where `linked_request_id=` lives.
#
# LEGACY FORMAT, still live in Loki until it ages out of retention —
# whatever the DEPLOYED profile's retention actually is
# (dmfdeploy/dmfdeploy#530: none of the three security-stream overrides
# match dmf-cms's own job label, so it's whatever `loki_retention` the
# deploying profile sets, never dmf-infra's role default cited as if it
# were reality — see the module STATUS NOTE above for the sandbox's own
# figure, sourced to the committed generator, not a role default):
# target/workload/capacity were `%s` (unquoted, only control-character-
# escaped) before this fix shipped. The parser
# below tries the new, quote-scanned reading for each of these three
# fields FIRST — its boundary is PROVABLE, not guessed, so it is trusted
# regardless of what marker-shaped text it contains — and falls back to
# the exact pre-fix positional/ambiguity-checked handling only when a
# field's value does not begin with a quote at all. A value that opens a
# quote but never validly closes is a HARD failure either way (AC 5b),
# never a fall-through to the weaker legacy path — see
# _parse_quotable_field's own docstring for why that distinction matters.
# ----------------------------------------------------------------------

_FIELDS_BEFORE_REASON = ("action", "actor", "role", "real_role", "request_id", "target")
# The five fields that are NEVER caller-controlled and are NEVER quoted,
# in either the current or the legacy emitter format — `target` is
# handled separately in parse_awx_write_line (quote-aware, see
# _parse_quotable_field) precisely because it ISN'T one of these.
_PLAIN_FIELDS_BEFORE_REASON = ("action", "actor", "role", "real_role", "request_id")
_FIELDS_AFTER_REASON = ("outcome", "workload", "capacity")
_TRAILING_FIELD = "linked_request_id"

# dmf-cms#140 (lkirc, BLOCKING; writer-fixed 2026-09-03) — target,
# workload and capacity used to be %s-formatted in the emitter: control-
# character escaped only (_sanitize_audit_field), never `=`/space
# escaped. `target` was the reported case (a caller-supplied catalog
# key/run id/receiver instance — an UNKNOWN key reaches the audit line on
# the entry-not-found refusal path with no prior validation); `workload`
# shared the exact exposure (`body.get("workload")`, main.py:384,
# unvalidated). Either could carry literal marker text (` reason='x'
# outcome=dispatched workload=pwned capacity=`) that shifted where every
# FOLLOWING field was found — forging a refused deploy into an in-flight
# one for an attacker-chosen target, using perfectly well-formed input,
# no corrupted/truncated line needed. The emitter now quotes all three
# with %r (the same repr treatment `reason` has always had), closing this
# BY CONSTRUCTION for newly emitted lines — see the module STATUS NOTE at
# the top of this file. Everything below still applies IN FULL to lines
# already in Loki in the old, unquoted shape, live until they age out of
# retention.
#
# THE PROPERTY: no caller-influenced field's value may alter the parse of
# any other field. Over this unescaped, space-delimited LEGACY format the
# only structural guarantee available is: every marker name occurs AT
# MOST ONCE per line. Two or more occurrences means its true boundary
# cannot be told apart from an injected one — the row fails to CLASSIFY
# at all (AC 5b: default-deny, drop it), covering lines already stored in
# Loki in the legacy unquoted format, not just future emitter output (this
# module never assumes stored data is trustworthy). A MISSING marker (0
# occurrences) is unaffected by this check — that is the existing
# truncated-line handling below, untouched.
_ALL_MARKER_NAMES = (*_FIELDS_BEFORE_REASON, "reason", *_FIELDS_AFTER_REASON, _TRAILING_FIELD)


def _marker_pattern(name: str) -> re.Pattern[str]:
    # Left word-boundary only: "request_id=" must never match inside
    # "linked_request_id=" (plan §4.2's own documented substring trap) —
    # a marker only counts if the character before it is not part of a
    # longer identifier. No right-boundary check needed: every name here
    # is immediately followed by "=", which is not an identifier
    # character, so "=" itself terminates the match unambiguously.
    #
    # \w, not [A-Za-z0-9_]: Python 3 str patterns are Unicode-aware by
    # default, so this also treats a marker glued directly after a
    # non-ASCII identifier character (e.g. a catalog key ending in an
    # accented letter) as still part of that field's own value, not a
    # boundary — the same "glued means it's data, not a marker" rule an
    # ASCII-only class would only apply inconsistently. Not required to
    # close dmf-cms#140's forgery (this function is now the ONLY
    # definition either the guard or the extractor ever consults, so they
    # cannot disagree regardless of exactly where this class draws the
    # line — see _find_unambiguous_marker's docstring), but there is no reason to
    # leave an ASCII-only gap sitting in the one shared definition.
    return re.compile(r"(?<!\w)" + re.escape(name) + "=")


_MARKER_PATTERNS = {name: _marker_pattern(name) for name in _ALL_MARKER_NAMES}


def _find_marker(tail: str, name: str, start: int) -> int | None:
    """Position of the first occurrence of ``<name>=`` at or after
    ``start``, using the single shared boundary-aware definition
    (``_MARKER_PATTERNS``).

    dmf-cms#140's real root cause (codex's fifth vector, found against an
    earlier fix here): detection and extraction used TWO DIFFERENT
    definitions of "what is a marker" — a boundary-aware regex in one
    place, plain ``str.find()`` in the other — so an injected marker
    glued directly to a preceding character was invisible to one and
    visible to the other, and the guard passed while extraction still
    walked into the forged boundary. There is exactly one definition now,
    and every marker search in this module — plain or ambiguity-checked
    (``_find_unambiguous_marker`` below) — is built on it, so they cannot
    disagree about what counts as a marker.

    As a side effect this also closes what codex separately asked for: a
    marker-shaped substring GLUED inside a caller-controlled field (no
    space before it) is not a boundary at all, so it stays part of that
    field's own value instead of truncating it at a false split —
    legitimate target/workload data survives intact.
    """
    match = _MARKER_PATTERNS[name].search(tail, start)
    return match.start() if match else None


def _find_unambiguous_marker(tail: str, name: str, start: int) -> int | None:
    """Position of ``<name>=`` at or after ``start``, or None if it's
    either absent OR ambiguous — a SECOND occurrence of the same marker
    also exists somewhere later in the tail, so the one found first
    cannot be trusted to be the genuine one rather than an injected decoy
    with the real marker still ahead of it (dmf-cms#140).

    Used for ``workload`` — REQUIRED, not merely defensive (codex F3,
    correcting an earlier version of this audit that understated it):
    ``workload`` is caller-controlled on TWO routes, not one — the deploy
    path's ``body.get("workload")`` (main.py:384), and switch-source's
    ``source_instance`` (main.py:346-352, validated only as "a non-empty
    string", nothing more; passed straight through as ``workload=`` at
    main.py:5869, :5879, :5892, :5941, :5960). Either route can carry
    literal marker text, so this check is what protects ``capacity``'s
    boundary from being hijacked, not a belt-and-suspenders extra.

    Also used, PURELY DEFENSIVELY, for ``outcome``/``capacity`` and the
    trailing ``linked_request_id`` — an adversarial check confirmed each
    of those three genuinely cannot carry caller text on any current
    route (``outcome`` is always a fixed, closed set of tokens; ``capacity``
    is server-computed budget/preflight data, ``_capacity_audit_summary``;
    ``linked_request_id`` is backend-generated, an operation's own
    ``request_id``) — so for THOSE three, unlike ``workload``, this
    ambiguity check protects against nothing reachable today. Left as-is
    per operator ruling (2026-09-03): named as a known, accepted
    imprecision rather than fixed, since none of the three is exploitable
    and further hardening of this parser is explicitly out of scope for
    this round.

    NOT used for ``reason`` itself — see ``_reason_marker_is_unambiguous``
    below for why a plain second-occurrence count is the wrong check for a
    free-text field.
    """
    found = _find_marker(tail, name, start)
    if found is None:
        return None
    if _find_marker(tail, name, found + len(f"{name}=")) is not None:
        return None  # a second occurrence exists — ambiguous, not just present
    return found


def _reason_marker_is_unambiguous(tail: str, reason_end: int) -> bool:
    """True unless a candidate second ``reason=`` occurrence after
    ``reason_end`` COULD BE a real repr'd string — i.e. its ``=`` is
    immediately followed by a quote character. Whether that candidate's
    quoted string ever actually closes does NOT matter (dmf-cms#140,
    lkirc, 2026-09-03 17:24 — the sixth vector, live on ef59280): a
    complete quote-scan is a genuine competing record continuation (the
    original target-injection vector); an UNTERMINATED one means this
    row's own genuine trailing ``reason=`` got truncated, and the earlier
    version of this function treated "didn't finish quote-scanning" as
    "therefore harmless" — which is exactly backwards. A caller-controlled
    field (``target``) can inject a complete, well-formed
    ``reason='fake' outcome=... workload=... capacity=`` tail; if the
    row's REAL, genuine ``reason=`` marker is then truncated after its own
    opening quote (log truncation, not attacker-controlled), the old check
    let it through as coincidental — but the injected fake reason had
    already won by then, forging outcome/workload. Both shapes are
    equally untrustworthy and both must fail AC 5b's classification check
    the same way.

    codex's earlier follow-up finding on dmf-cms#140 (P1, over-rejection)
    still holds and is why this is keyed on "starts with a quote", not
    "any later reason= occurrence at all": reason is the one field that is
    genuinely free text an operator writes, so it can legitimately — and
    ordinarily does — contain the literal substring "reason=" as part of
    an honest sentence ("retry because reason=operator typo"). That text
    sits INSIDE reason's own, already-quote-scanned span (at or before
    ``reason_end``) and this function never looks there — it only
    searches AT/AFTER ``reason_end``. Separately, a coincidental "reason="
    substring can sit inside a LATER field's own raw, unescaped value —
    e.g. an auto-rollback whose ``linked_request_id`` happens to contain
    "reason=" as literal text (``linked_request_id=req-reason=x``) — and
    that candidate's ``=`` is followed by an ordinary character ("x"), not
    a quote, so it can never be mistaken for the start of a repr'd string
    and is correctly treated as harmless. A quote-starting candidate is
    never that kind of coincidence: no other field's raw text has a
    reason to independently begin with a bare quote character right after
    matching this marker's shape.
    """
    candidate = _find_marker(tail, "reason", reason_end)
    while candidate is not None:
        value_start = candidate + len("reason=")
        if value_start < len(tail) and tail[value_start] in ("'", '"'):
            return False  # could be a real repr string, complete or not — ambiguous either way
        candidate = _find_marker(tail, "reason", value_start)
    return True


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


def _parse_quotable_field(
    tail: str, name: str, start: int
) -> tuple[int, int, str | None, int | None] | None:
    """Locate ``<name>=`` at/after ``start`` and, if its value is repr-
    quoted (dmfdeploy/dmfdeploy#140's writer fix, 2026-09-03 — the current
    emitter format for a caller-controlled field), parse it exactly like
    ``reason`` already was: quote-scanned and ``literal_eval``'d, so its
    boundary is PROVABLE rather than guessed — safe regardless of what
    marker-shaped text it contains.

    Returns ``None`` if the marker itself is entirely absent (a
    classification failure, same as any other missing marker) OR if it
    opens a quote that never validly closes / doesn't literal_eval to a
    str (a MALFORMED new-format value — also a classification failure,
    per AC 5b, and deliberately conflated with "marker absent" here
    because the caller's correct response is identical either way:
    ``return None``). This is NEVER a fall-through to the legacy path —
    allowing that would let an attacker open a fake quote specifically to
    force the weaker legacy handling, resurrecting the exact class this
    fix removes.

    On success returns ``(marker_pos, value_start, value, value_end)``:
    ``value`` is the parsed string and ``value_end`` is the index just
    past the closing quote — the caller's search for the NEXT field can
    safely start there, with no further ambiguity check needed for THIS
    field's own boundary (quote-scanning already proved it).

    Returns ``(marker_pos, value_start, None, None)`` when the marker is
    present but its value does NOT start with a quote at all — a legacy,
    pre-writer-fix emission, still live in Loki until it ages out of
    retention — whatever the DEPLOYED profile's retention actually is
    (dmfdeploy/dmfdeploy#530: never dmf-infra's role default cited as if
    it were deployed reality; see the module STATUS NOTE at the top of
    this file). The caller falls back to the exact pre-fix positional/
    ambiguity-checked handling for this field — see
    parse_awx_write_line's own inline comments at each of its three call
    sites (target, workload, capacity) for what that fallback does.
    """
    marker = _find_marker(tail, name, start)
    if marker is None:
        return None
    value_start = marker + len(f"{name}=")
    if value_start >= len(tail) or tail[value_start] not in ("'", '"'):
        return marker, value_start, None, None
    value_end = _scan_repr_string_end(tail, value_start)
    if value_end is None:
        return None  # opened a quote, never closed — hard fail, not a fallback
    try:
        candidate = ast.literal_eval(tail[value_start:value_end])
    except (ValueError, SyntaxError):
        return None
    if not isinstance(candidate, str):
        return None
    return marker, value_start, candidate, value_end


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
    for name in _PLAIN_FIELDS_BEFORE_REASON:
        found = _find_marker(tail, name, pos)
        if found is None:
            return None
        positions.append(found)
        pos = found + len(f"{name}=")

    # target (dmfdeploy/dmfdeploy#140, the writer fix): quote-aware. On a
    # CURRENT line this is safe by construction — its boundary is proven
    # by the quote-scan, not guessed, so the reason= search below can
    # start right after it with no ambiguity risk regardless of what
    # target's own value contains. On a LEGACY line (unquoted — still
    # live in Loki until it ages out of retention) it falls back to the
    # exact pre-fix handling: bounded by wherever reason='s marker is
    # found next, protected by the duplicate-marker check further down.
    target_result = _parse_quotable_field(tail, "target", pos)
    if target_result is None:
        return None
    target_marker, target_value_start, target_value, target_end = target_result
    target_is_quoted = target_value is not None
    reason_search_start = target_end if target_is_quoted else target_value_start

    # reason's OWN marker position: found PLAIN here (no ambiguity check
    # yet — codex's over-rejection finding on an earlier version of this
    # fix, which used the generic unbounded-forward second-occurrence
    # check and rejected a legitimate reason mentioning "reason=" in its
    # own prose). The real ambiguity check runs further down, once
    # reason's value-span is known via quote-scanning — see
    # _reason_marker_is_unambiguous's docstring for why that's the correct
    # boundary to check against instead.
    reason_marker_pos = _find_marker(tail, "reason", reason_search_start)
    if reason_marker_pos is None:
        return None
    positions.append(target_marker)
    positions.append(reason_marker_pos)

    # dmf-cms#140 (codex's fifth-vector finding on an earlier version of
    # this check): the classification markers found above must ALSO be
    # unambiguous, but scoped to BEFORE reason starts — exactly the
    # region their own sequential search traverses, since it always stops
    # at the first "reason=" it finds. A duplicate anywhere else (inside
    # reason's own quoted value, or in outcome/workload/capacity after
    # it) is irrelevant to these fields and must not reject a legitimate
    # row over it — an earlier, unbounded version of this check rejected
    # a genuine reason that simply mentioned "role=" or "target=" in
    # ordinary prose, and a genuinely malformed reason whose own
    # (about-to-be-discarded) text happened to contain "role=admin".
    #
    # `target` is EXCLUDED from this check when it was successfully
    # quote-parsed: the writer fix means its own quoted value can
    # legitimately CONTAIN the substring "target=" (a real catalog key
    # can be named that), and quote-scanning has already proven its
    # boundary unambiguously — re-running a textual duplicate count over
    # content that's already safely bounded would be reason's own
    # honest-prose over-rejection bug again, one field over. A LEGACY
    # (unquoted) target keeps exactly the pre-writer-fix protection.
    before_reason = tail[:reason_marker_pos]
    fields_to_check = _PLAIN_FIELDS_BEFORE_REASON if target_is_quoted else _FIELDS_BEFORE_REASON
    for name in fields_to_check:
        if len(_MARKER_PATTERNS[name].findall(before_reason)) > 1:
            return None

    values: dict[str, str] = {}
    for i, name in enumerate(_PLAIN_FIELDS_BEFORE_REASON):
        start = positions[i] + len(f"{name}=")
        end = positions[i + 1]
        values[name] = tail[start:end].strip()

    values["target"] = (
        target_value if target_is_quoted else tail[target_value_start:reason_marker_pos].strip()
    )

    reason_start = reason_marker_pos + len("reason=")
    reason_end = _scan_repr_string_end(tail, reason_start)
    reason_value: str | None = None
    if reason_end is not None:
        try:
            candidate = ast.literal_eval(tail[reason_start:reason_end])
            if isinstance(candidate, str):
                reason_value = candidate
        except (ValueError, SyntaxError):
            pass

    if reason_value is None:
        # AC 5b: a malformed `reason` is an ENRICHMENT failure, not a
        # CLASSIFICATION failure — action/actor/request_id/target already
        # parsed cleanly above (strictly BEFORE reason_start, from a source
        # region reason's own content can never influence), so the row is
        # still fully usable for membership/gating (codex R496-A F5:
        # dropping it here discarded an otherwise-classifiable record over
        # one damaged field).
        #
        # codex R496-A NEW-2 — SECURITY: an earlier version of this branch
        # then searched FORWARD from reason_start for the next `outcome=`
        # marker to "resume" parsing. `reason` is the mandatory C5 field
        # taken VERBATIM from the operator's own request body
        # (_require_reason) — so once its boundary is lost, ANY text after
        # reason_start must be treated as attacker-influenced, not
        # log-corruption noise. A forward scan let marker-shaped text
        # *inside* a deliberately malformed reason be picked up as the
        # row's real outcome/workload/capacity — forging an audit record's
        # own outcome (e.g. making a refused deploy read as "dispatched")
        # using nothing but the reason text an operator is free to type.
        # There is no way to recover a trustworthy boundary once reason's
        # own end is unknown, so nothing after it is parsed at all: every
        # field below defaults to a value that fails CLOSED, never one an
        # attacker chose. An empty outcome is not in any action's
        # acceptance allowlist (resolve_outcome_state), so it always
        # renders as failed/unknown — never a forged success or in-flight
        # claim. In genuine data this whole branch never fires —
        # `reason=%r` is a Python repr, always well-formed — so it only
        # matters for an already-corrupted or adversarial line, where nothing
        # past this point was ever going to be trustworthy anyway.
        values["reason"] = ""
        values["outcome"] = ""
        values["workload"] = ""
        values["capacity"] = ""
        values[_TRAILING_FIELD] = ""
        return values

    # dmf-cms#140 (lkirc, BLOCKING; hardened twice more after codex found
    # a detect/extract mismatch, then an over-rejection, in earlier
    # versions of this fix): reason just quote-scanned SUCCESSFULLY, which
    # is exactly the shape a forged, attacker-crafted reason needs to
    # hijack the boundary of every field after it (a genuinely truncated/
    # corrupted reason fails the scan instead, hits the branch above, and
    # is already safe — nothing past a broken reason boundary is ever
    # trusted at all). Check whether a GENUINE competing continuation
    # exists — see _reason_marker_is_unambiguous's own docstring for why
    # this is checked as "does an alternate candidate ALSO quote-scan",
    # not "does reason= merely occur again somewhere" (that naive version
    # is what caused the over-rejection: reason is free text, and both a
    # legitimate reason mentioning "reason=" in its own prose and an
    # unrelated later field's raw value coincidentally containing
    # "reason=" would otherwise be misread as a forged second record).
    if not _reason_marker_is_unambiguous(tail, reason_end):
        return None

    values["reason"] = reason_value
    pos = reason_end

    # outcome — unquoted, unchanged: never caller-controlled (always one
    # of a closed, short, server-chosen set of tokens), so it was never
    # part of the writer fix's scope. Same ambiguity check it always had.
    outcome_marker = _find_unambiguous_marker(tail, "outcome", pos)
    if outcome_marker is None:
        return None
    outcome_value_start = outcome_marker + len("outcome=")

    # workload (dmfdeploy/dmfdeploy#140, the writer fix): quote-aware,
    # same mechanism as target — REQUIRED, not merely defensive, since
    # workload is caller-controlled on two routes (deploy's
    # body.get("workload"), main.py:384, and switch-source's
    # source_instance; see _find_unambiguous_marker's own docstring for
    # the full citation). A CURRENT line's workload is safe by
    # construction; a LEGACY line falls back to the exact pre-fix
    # unambiguous-marker check.
    workload_result = _parse_quotable_field(tail, "workload", outcome_value_start)
    if workload_result is None:
        return None
    workload_marker, workload_value_start, workload_value, workload_end = workload_result
    workload_is_quoted = workload_value is not None

    values["outcome"] = tail[outcome_value_start:workload_marker].strip()

    if workload_is_quoted:
        capacity_search_start = workload_end
    else:
        # Legacy/unquoted workload keeps the pre-writer-fix protection: a
        # SECOND "workload=" occurring anywhere later would mean this
        # one's true boundary can't be told apart from an injected decoy
        # (exactly what _find_unambiguous_marker already checked here).
        if _find_marker(tail, "workload", workload_value_start) is not None:
            return None
        capacity_search_start = workload_value_start  # value itself bounded once capacity's marker is known, below

    # capacity — same quote-aware handling, same reasoning: an adversarial
    # check confirmed it cannot carry caller text on any CURRENT route,
    # but quoting it anyway closes the class BY CONSTRUCTION regardless
    # of that, matching "not caller-controlled today is not a reason to
    # leave it open" (the standing principle this whole arc kept
    # re-confirming, right up to the writer-fix decision itself).
    capacity_result = _parse_quotable_field(tail, "capacity", capacity_search_start)
    if capacity_result is None:
        return None
    capacity_marker, capacity_value_start, capacity_value, capacity_end = capacity_result
    capacity_is_quoted = capacity_value is not None

    values["workload"] = (
        workload_value if workload_is_quoted else tail[workload_value_start:capacity_marker].strip()
    )

    if capacity_is_quoted:
        trailing_search_start = capacity_end
    else:
        if _find_marker(tail, "capacity", capacity_value_start) is not None:
            return None
        trailing_search_start = capacity_value_start  # bounded once linked_request_id/end-of-tail is known, below

    trailing_found = _find_unambiguous_marker(tail, _TRAILING_FIELD, trailing_search_start)
    trailing_pos = trailing_found if trailing_found is not None else -1
    tail_end = trailing_pos if trailing_pos != -1 else len(tail)

    values["capacity"] = (
        capacity_value if capacity_is_quoted else tail[capacity_value_start:tail_end].strip()
    )

    values[_TRAILING_FIELD] = (
        tail[trailing_pos + len(f"{_TRAILING_FIELD}="):].strip() if trailing_pos != -1 else ""
    )

    # dmf-cms#140 follow-up (orchestrator's own sweep, live): `capacity` is
    # the one field the ambiguity check above cannot cover for
    # `linked_request_id` specifically, and the reason is structural, not
    # an oversight — `linked_request_id` is OPTIONAL (0 or 1 occurrences
    # is legitimate, unlike every other marker, which is always exactly
    # 1), so an attacker injecting exactly ONE fake occurrence into
    # capacity's own value (which is otherwise unbounded — nothing
    # legitimately follows capacity on a non-auto-rollback line) creates
    # no SECOND occurrence to be caught as ambiguous; it's just the only
    # one, identical in shape to a genuine one. `capacity` is server-computed today
    # (_capacity_audit_summary, never caller input) so this is not
    # currently reachable through THIS field — but treating "not caller-
    # controlled today" as a reason to leave it open is exactly the
    # reasoning this round exists to stop trusting (see this morning's
    # retention-selector hazard for the same shape). Close it
    # structurally instead: `linked_request_id` is only ever genuine on
    # the auto-rollback dispatch's own emission, whose action/actor are
    # both request_id-independent, injection-proof values (a hardcoded
    # literal and role-derived text respectively — never caller %s
    # input, and both are locked in from a source region no later
    # field's content can reach, per the classification-marker ordering
    # above). So a non-blank `linked_request_id` on any OTHER (action,
    # actor) pair is definitive proof of a corrupted boundary somewhere
    # upstream of it, even though nothing rendered from it would be
    # trusted downstream either way (only the auto-rollback join
    # consults this field at all) — reject the whole row, consistent
    # with every other ambiguity this function treats as a
    # classification failure.
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
    different in kind: it means the record's outcome field could not be
    recovered at all — codex R496-C P1-2's finding — reachable without an
    adversary via a truncated/corrupted Loki line (the NEW-2 fail-closed
    parser boundary is precisely the path that produces it). "Not proven
    in flight" is NOT "the action failed"; rendering a lost outcome as a
    definite failure would be this lane claiming knowledge it does not
    have, the same defect this whole round exists to remove, just with
    the opposite sign. So this check runs FIRST, before either the
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
            "outcome": build_outcome(action, fields.get("outcome", "")),
        })

    return {
        "reason": "",
        "window": window_payload,
        "capped": capped,
        "excluded": list(EXCLUDED_DISCLOSURE),
        "events": events,
    }
