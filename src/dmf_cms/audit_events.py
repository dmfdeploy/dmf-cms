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
whatever replaces the transport underneath them. The LINE PARSER below is
not that — it is a demo-scoped stopgap over a text log format that was
never designed to be unambiguously re-parsed.

THE WRITER FIX (dmfdeploy/dmfdeploy#140, 2026-09-03): seven review rounds
finding a new forgery vector after every fix converged on a live, PROVEN
case — not merely unfound — where a forged line and a legitimate one were
byte-identical, so no reader-side check could ever have existed for it.
The operator's decision was to fix the WRITER instead of continuing to
harden the reader: ``main.py``'s ``_audit_awx_write`` (and the
auto-rollback dispatch's identical-prefix module-logger calls) now quote
FIVE fields with ``%r`` — the same repr treatment ``reason`` has always
had. Which five, and why:

- ``target`` — a caller-supplied catalog key/run id/receiver instance,
  reaching the audit line with no prior validation on several refusal
  paths.
- ``actor`` (``user.subject``) — an OIDC claim. ``user_from_claims``
  applies ZERO validation to whatever the IdP asserts; "IdP-controlled" is
  not "constrained", it is just a different party controlling it. Quoted
  as of THIS round, not the original writer fix: the first version of
  this fix left it plain, reasoning it was "not directly caller-controlled
  in this system's actual configuration" — true today, but actor is
  parsed BEFORE target in the classification scan, so on a
  per-field-guessing design it sat exactly upstream of the one thing
  proving everything after it, the single externally-sourced field the
  first version of this fix left unclosed. Operator ruling: quote it, not
  a defensive duplicate check — this arc has spent six rounds learning
  that proving a boundary beats detecting a violation.
- ``reason`` — always has been quoted; the mandatory C5 field taken
  verbatim from the operator's own request body.
- ``workload`` — caller-controlled on TWO routes: deploy's
  ``body.get("workload")`` (main.py:384) and switch-source's
  ``source_instance`` (main.py:346-352, validated only as "a non-empty
  string").
- ``capacity`` — server-computed today (``_capacity_audit_summary``,
  never caller input on any current route) but quoted anyway: "not
  caller-controlled today" was never treated as a reason to leave a field
  open across this whole arc, and quoting it closes the class BY
  CONSTRUCTION regardless of whether a future route ever makes it
  reachable.

``action``, ``role``, ``real_role``, ``request_id`` and ``outcome`` stay
plain (``%s``) — every one of them is code-generated with a constrained
shape, never externally sourced, so quoting would add nothing: ``action``
is a fixed literal per call site; ``role``/``real_role`` are
server-computed from group membership; ``request_id`` is always
``uuid.uuid4().hex``; ``outcome`` is always one of a closed, short,
server-chosen set of tokens.

THE DISPATCH PROBLEM the first version of this fix had, and the reason
this file now looks the way it does: quoting the writer is necessary but
was not sufficient on its own. The first reader-side implementation tried
each field's own leading character to decide "is this line new-format or
legacy" — PER FIELD, guessed from content. Codex found two live defects
in exactly that guess, both data loss (not forgery, but squarely in scope
under the operator's ruling that a legitimate row vanishing is a
demo-visible defect):

- a genuinely NEW-format, properly quoted ``workload``/``capacity`` whose
  own value legitimately contained literal text like
  ``reason='operator typo'`` tripped the legacy reason-ambiguity check,
  which had no way to know it was looking inside an already-safely-bounded
  quoted span, and the row was dropped;
- a LEGACY (unquoted) line whose ``target``/``workload`` merely BEGAN
  with a literal apostrophe was routed into the new quote-parser and hard
  failed, because a legacy leading quote and a genuine new-format quote
  are THE SAME CHARACTER — unrecoverable by inspecting the value.

Both defects trace to one root cause: the reader had to GUESS, per value,
which grammar a line was written in, and that guess was itself a format
ambiguity — the identical disease one level up from the one the writer
fix had just cured. An alternative that was considered and rejected: try
the whole line under the strict new grammar first, fall back to the
legacy grammar wholesale on any failure. That narrows the guess from
per-field to per-line, but does not remove it — "did parsing succeed" is
still an inference from the bytes, and a legacy line could in principle
still parse successfully but wrongly under the new grammar by
coincidence. THE FIX ADOPTED INSTEAD: an explicit, positional format
marker. Every line emitted by the CURRENT writer carries ``fmt=2``
immediately after the "awx write: " prefix; every line already in Loki
from before this marker existed does not, and never will (nothing about
re-reading old bytes can retroactively add a marker nobody wrote).
``parse_awx_write_line`` below checks for that marker ONCE, at a fixed
position, and dispatches to one of two FULLY SEPARATE parsing functions —
no line is ever run through both, and no field's content is ever
inspected to decide which grammar applies:

- ``_parse_new_format_line`` — target/actor/reason/workload/capacity are
  ALL REQUIRED to be quote-scannable. A value that isn't, or doesn't
  validly close, is a hard classification failure (AC 5b), never a guess
  and never a fall-through to the legacy grammar (an attacker forcing
  that fallback by opening a fake quote and then breaking the promise
  would just resurrect the exact class this fix removes). No ambiguity
  checks anywhere in this function, because none are needed: every
  quoted field's boundary is proven by its own quote-scan, independent of
  every other field's content, so nothing can inject a marker into
  anything else — see the function's own docstring for the full
  reasoning.
- ``_parse_legacy_format_line`` — the EXACT mechanism as it stood before
  this fix, byte-for-byte: target/workload/capacity unquoted and
  boundary-guessed, the classification-field duplicate check, the
  unambiguous-marker check for workload/capacity, and reason's own
  quote-aware ambiguity discriminator (the sixth-vector fix), all
  unchanged. This is what lines already in Loki keep working against.

``test_writer_fix_round_trip_*`` and ``test_format_dispatch_*`` in
``tests/test_audit_events_endpoint.py`` are the actual evidence, not the
absence of a failing test: real payloads through the REAL emitter,
parsed by the REAL reader, confirmed to come back as literal field
content — including the two payloads codex found, and one aimed at
actor, new this round. The dispatch's own exclusivity is asserted and
mutation-verified directly: delete the marker check and the tests that
assert "no line is accepted by both parsers" fail loudly.

SIX of the seven forgery vectors found across this arc were closed on
the LEGACY path before this round (mutation-tested, each named below);
the seventh — a forged line and a legitimate one being byte-for-byte
identical — is STILL open there, exactly as it always was, because
nothing about re-reading old, unquoted bytes can prove a boundary that
was never written. On the NEW path, all seven are closed BY
CONSTRUCTION, including the one that was proven byte-identical to
legitimate data: quoting removes the ambiguity the byte-identity
argument depended on, in a way no amount of additional reader-side
detection ever could.

THAT GAP IS BOUNDED, NOT PERMANENT — but stating the bound is EXACTLY the
mistake dmfdeploy/dmfdeploy#530 exists to prevent, so state it #530's
way, not as a number: THE WINDOW IS THE DEPLOYED RETENTION, WHATEVER THE
PROFILE SETS, never a role default cited as if it were deployed reality.
dmf-cms's own Loki stream carries no per-stream retention override
(dmfdeploy/dmfdeploy#530's three ``retention_stream`` selectors are all
security streams, none matching ``job="dmf-cms/dmf-cms"``), so it falls
to whatever the deploying profile's ``loki_retention`` is. dmf-infra's
OWN role default is 720h/30 days — but a deploying profile overrides
that default, and the sandbox profile this ships to does: dmf-env's
``bin/init-wizard.sh`` sets ``loki_retention: 168h`` (7 days) for the
sandbox. IF that generator is what actually rendered the deployed
inventory — a live reading of the running environment's own inventory
is the only thing that would fully settle it, and none has been taken
— THEN a legacy-format line on that environment is gone within 7 days
of this fix shipping. That conditional is the whole claim this note is
entitled to make: 7 days is the best-sourced figure available given what
has actually been checked, not a settled fact about any specific running
deployment, and it moves the moment a live inventory reading says
otherwise. Do not "simplify" this back to a single code path before that
window has fully elapsed on whatever environment is actually running
this; the dual dispatch is what lets old data keep working at all
during it.

The five forgery vectors closed on the legacy path, for the historical
record: a caller-controlled field's raw text hijacking a later field's
boundary; detection and extraction disagreeing about what a marker even
is; the fix for the first two over-correcting into rejecting legitimate
rows whose own text happened to contain marker-shaped substrings; a
truncated genuine reason marker losing to an injected complete one; and
target's own captured value legitimately containing marker-shaped text
being over-rejected by a duplicate-marker check that didn't know it was
looking inside an already-safely-bounded quoted span. Each was found by
an adversarial review round (codex and, for the sixth vector, a human
reviewer codex's own pass had missed) and is mutation-tested. Do not
treat a clean review pass — on either path — as proof there is no next
case on THAT path; treat it as the ceiling of what hardening a
hand-rolled boundary scanner can promise for data that was never quoted
to begin with. The production answer for the legacy path, while it still
exists, was always the deferred structured envelope (plan §5); for the
current path, quoting the caller-controlled fields and dispatching on an
explicit marker IS that answer, applied narrowly rather than deferred.
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
# Line parsing. Two grammars, dispatched by an explicit marker — see the
# module STATUS NOTE above for the full design and history.
#
# CURRENT format (dmfdeploy/dmfdeploy#140's writer fix):
#
#   awx write: fmt=2 action=%s actor=%r role=%s real_role=%s
#              request_id=%s target=%r reason=%r outcome=%s workload=%r
#              capacity=%r [linked_request_id=%s]
#
# LEGACY format, still live in Loki until it ages out of retention (see
# the module STATUS NOTE for exactly how long that is and why the number
# is conditional, not a fact):
#
#   awx write: action=%s actor=%s role=%s real_role=%s request_id=%s
#              target=%s reason=%r outcome=%s workload=%s capacity=%s
#              [linked_request_id=%s]
#
# `request_id=<id>` is immune to the trailing `linked_request_id=<id>`
# substring that contains it on BOTH grammars (plan §4.2's named hazard):
# every plain field's search anchors on the NEXT field's own marker
# starting only from just past the current field's marker — sequential,
# never a whole-line search — so `request_id=` never runs anywhere near
# the end of the line where `linked_request_id=` lives.
# ----------------------------------------------------------------------

_FIELDS_BEFORE_REASON = ("action", "actor", "role", "real_role", "request_id", "target")
# The five fields that are NEVER caller-controlled and stay plain on the
# LEGACY grammar — `target` is handled separately in
# _parse_legacy_format_line precisely because it ISN'T one of these.
_PLAIN_FIELDS_BEFORE_REASON = ("action", "actor", "role", "real_role", "request_id")
_FIELDS_AFTER_REASON = ("outcome", "workload", "capacity")
_TRAILING_FIELD = "linked_request_id"

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
    # ASCII-only class would only apply inconsistently. Relevant to the
    # LEGACY grammar only now (the new grammar's quotable fields never
    # rely on marker boundaries at all), but there is no reason to leave
    # an ASCII-only gap sitting in the one shared definition.
    return re.compile(r"(?<!\w)" + re.escape(name) + "=")


_MARKER_PATTERNS = {name: _marker_pattern(name) for name in _ALL_MARKER_NAMES}

# The fmt= marker is a DISPATCH KEY, not a data field: it is matched
# positionally (must be the very first thing after "awx write: "), never
# searched for like the fields above, and it is never a field a caller
# could inject text through — main.py's writer emits it as a fixed
# literal. Kept out of _ALL_MARKER_NAMES/_MARKER_PATTERNS deliberately —
# mixing a positional dispatch key into a registry of searched field
# markers would blur a distinction this whole redesign exists to make
# explicit.
_FMT_MARKER_RE = re.compile(r"^\s*fmt=(\d+)\s")

_NEW_FORMAT_VERSION = "2"


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
    legitimate target/workload data survives intact. Used by BOTH
    grammars: the new format's quotable-field boundaries never depend on
    it, but its own MARKER (the "name=" token itself) is still found this
    way on both, and every plain field on both grammars uses it directly.
    """
    match = _MARKER_PATTERNS[name].search(tail, start)
    return match.start() if match else None


def _find_unambiguous_marker(tail: str, name: str, start: int) -> int | None:
    """Position of ``<name>=`` at or after ``start``, or None if it's
    either absent OR ambiguous — a SECOND occurrence of the same marker
    also exists somewhere later in the tail, so the one found first
    cannot be trusted to be the genuine one rather than an injected decoy
    with the real marker still ahead of it (dmf-cms#140).

    LEGACY GRAMMAR ONLY (dmfdeploy/dmfdeploy#140, the writer fix): the
    new format's quotable fields never call this — their boundaries are
    proven by quote-scanning, unconditionally, so there is nothing left
    for a duplicate-marker check to be ambiguous about. This function
    still protects the exact same things it always did, for lines still
    written in the legacy shape:

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
    and further hardening of the legacy parser is explicitly out of scope.

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
    lkirc, 2026-09-03 17:24 — the sixth vector): a complete quote-scan is
    a genuine competing record continuation (the original target-injection
    vector); an UNTERMINATED one means this row's own genuine trailing
    ``reason=`` got truncated, and an earlier version of this function
    treated "didn't finish quote-scanning" as "therefore harmless" —
    which is exactly backwards. Both shapes are equally untrustworthy and
    both must fail AC 5b's classification check the same way.

    LEGACY GRAMMAR ONLY: on the new format, target is ALSO independently
    quote-bound, so the search for reason='s own marker starts exactly
    where target's quote-scan ended — never from "find the first reason=
    anywhere" — and this whole question stops being askable. That is why
    ``_parse_new_format_line`` never calls this function at all, not
    because the question was re-answered differently, but because
    nothing upstream of reason on that grammar can inject a competing
    candidate in the first place.

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


def _require_quoted_field(tail: str, name: str, start: int) -> tuple[int, str, int] | None:
    """Locate ``<name>=`` at/after ``start`` and REQUIRE its value to be
    repr-quoted — the fmt=2 grammar's contract for target/actor/reason/
    workload/capacity (dmfdeploy/dmfdeploy#140). Used ONLY by
    ``_parse_new_format_line``: on that grammar there is no "maybe
    quoted, maybe not" question to ask, because the line already declared
    which grammar it uses via the fmt= marker before this function is
    ever called — see ``parse_awx_write_line``'s dispatch.

    Returns ``(marker_pos, value, value_end)`` on success. Returns
    ``None`` if the marker is missing, its value does not start with a
    quote at all, the quote opens but never validly closes, or it doesn't
    ``literal_eval`` to a str — EVERY one of those is a hard
    classification failure (AC 5b), never a partial admission and NEVER a
    fall-through to the legacy grammar. That last point is deliberate,
    not an oversight: a line that claims fmt=2 and then doesn't deliver a
    properly quoted field cannot be trusted at all, not just on that one
    field — allowing a fall-through would let an attacker declare the
    marker, open a fake quote, and force the weaker legacy handling on
    purpose, resurrecting the exact class this fix removes.

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
        return None  # fmt=2 promises quoting; not quoted at all is a hard failure here
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
    """Parse one ``awx write:`` line, or None if it doesn't parse well
    enough to CLASSIFY the row (plan §7 AC 5b).

    Dispatches on an EXPLICIT, positional format marker
    (dmfdeploy/dmfdeploy#140) rather than inferring the grammar from any
    field's content — see the module STATUS NOTE for why an earlier,
    per-field-guessing version of this function was wrong, and what it
    cost. A line carrying ``fmt=2`` immediately after the "awx write: "
    prefix is parsed by ``_parse_new_format_line`` (strict: every
    quotable field required, no ambiguity checks needed); a line WITHOUT
    that marker — every line already in Loki from before this marker
    existed — is parsed by ``_parse_legacy_format_line`` (the exact
    pre-fix mechanism, unchanged). A recognised-but-different fmt=
    version (a future format this code doesn't know about yet) fails
    closed rather than guessing which grammar might apply. No line is
    ever run through both parsers.
    """
    idx = line.find("awx write:")
    if idx == -1:
        return None
    tail = line[idx + len("awx write:"):]

    fmt_match = _FMT_MARKER_RE.match(tail)
    if fmt_match is None:
        return _parse_legacy_format_line(tail)
    if fmt_match.group(1) != _NEW_FORMAT_VERSION:
        return None  # an unrecognised format version — fail closed, never guess
    return _parse_new_format_line(tail[fmt_match.end():])


def _parse_new_format_line(tail: str) -> dict[str, str] | None:
    """Parse the fmt=2 grammar (dmfdeploy/dmfdeploy#140, the writer fix):
    target, actor, reason, workload and capacity are ALL required to be
    repr-quoted — every one of their boundaries is PROVEN by quote-
    scanning, never guessed, so this function needs no ambiguity checks
    anywhere. That is the entire point of dispatching on an explicit
    marker rather than sniffing each value's own leading character: once
    the LINE ITSELF states which grammar it uses, no field's content can
    ever be mistaken for another field's marker, because none of the
    quoted fields' boundaries depend on searching for the next one — each
    is independently closed by its own quote, and the search for the
    NEXT field's marker always starts exactly where the current one's
    quote-scan ended.

    ``action``, ``role``, ``real_role``, ``request_id`` and ``outcome``
    stay plain (``%s``) — every one of them is code-generated with a
    constrained shape, never externally sourced: ``action`` is a fixed
    literal per call site; ``role``/``real_role`` are server-computed
    from group membership; ``request_id`` is always
    ``uuid.uuid4().hex``; ``outcome`` is always one of a closed, short,
    server-chosen set of tokens.

    Any violation of the fmt=2 contract — a quotable field missing, not
    quoted, or malformed — is a hard classification failure (AC 5b).
    There is deliberately no fallback to the legacy grammar from here —
    see ``_require_quoted_field``'s own docstring for why.
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

    # linked_request_id — plain, optional trailing field, same semantics
    # as the legacy grammar. No ambiguity check needed: every quotable
    # field between here and the start of the line is independently
    # quote-bound, so nothing upstream can inject a fake marker for this
    # one either.
    trailing_marker = _find_marker(tail, _TRAILING_FIELD, pos)
    values[_TRAILING_FIELD] = (
        tail[trailing_marker + len(f"{_TRAILING_FIELD}="):].strip() if trailing_marker is not None else ""
    )

    if values[_TRAILING_FIELD] and not (
        values["action"] == "rollback" and values["actor"] == _AUTO_ROLLBACK_ACTOR
    ):
        return None

    return values


def _parse_legacy_format_line(tail: str) -> dict[str, str] | None:
    """Parse the pre-fix, unquoted grammar — byte-for-byte the mechanism
    that stood before dmfdeploy/dmfdeploy#140's writer fix, unchanged by
    this round. Every line already in Loki without an ``fmt=`` marker
    (``parse_awx_write_line``'s dispatch) is parsed here, and stays
    parseable this way until it ages out of retention — see the module
    STATUS NOTE for exactly how long that is.

    action/actor/request_id/target must all be cleanly extractable, or
    the row is dropped, never partially admitted (plan §7 AC 5b). A
    malformed ``reason`` alone does NOT drop the row (that's an
    enrichment failure, not a classification failure — see the fallback
    inline below); the row is retained with a blank reason instead.
    """
    positions: list[int] = []
    pos = 0
    for name in _FIELDS_BEFORE_REASON:
        found = _find_marker(tail, name, pos)
        if found is None:
            return None
        positions.append(found)
        pos = found + len(f"{name}=")

    # reason's OWN marker position: found PLAIN here (no ambiguity check
    # yet — codex's over-rejection finding on an earlier version of this
    # fix, which used the generic unbounded-forward second-occurrence
    # check and rejected a legitimate reason mentioning "reason=" in its
    # own prose). The real ambiguity check runs further down, once
    # reason's value-span is known via quote-scanning — see
    # _reason_marker_is_unambiguous's docstring for why that's the correct
    # boundary to check against instead.
    reason_marker_pos = _find_marker(tail, "reason", pos)
    if reason_marker_pos is None:
        return None
    positions.append(reason_marker_pos)

    # dmf-cms#140 (codex's fifth-vector finding on an earlier version of
    # this check): the six classification markers found above must ALSO
    # be unambiguous, but scoped to BEFORE reason starts — exactly the
    # region their own sequential search traverses, since it always stops
    # at the first "reason=" it finds. A duplicate anywhere else (inside
    # reason's own quoted value, or in outcome/workload/capacity after
    # it) is irrelevant to THESE six fields and must not reject a
    # legitimate row over it — an earlier, unbounded version of this
    # check rejected a genuine reason that simply mentioned "role=" or
    # "target=" in ordinary prose, and a genuinely malformed reason whose
    # own (about-to-be-discarded) text happened to contain "role=admin".
    before_reason = tail[:reason_marker_pos]
    for name in _FIELDS_BEFORE_REASON:
        if len(_MARKER_PATTERNS[name].findall(before_reason)) > 1:
            return None

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

    after_positions: list[int] = []
    for name in _FIELDS_AFTER_REASON:
        found = _find_unambiguous_marker(tail, name, pos)
        if found is None:
            return None
        after_positions.append(found)
        pos = found + len(f"{name}=")

    trailing_found = _find_unambiguous_marker(tail, _TRAILING_FIELD, pos)
    trailing_pos = trailing_found if trailing_found is not None else -1
    tail_end = trailing_pos if trailing_pos != -1 else len(tail)
    boundaries = [*after_positions, tail_end]
    for i, name in enumerate(_FIELDS_AFTER_REASON):
        start = boundaries[i] + len(f"{name}=")
        end = boundaries[i + 1]
        values[name] = tail[start:end].strip()

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
