"""Shared log-line injection defense (umbrella dmf-cms#108).

Lives in its own module, not main.py, specifically so leaf modules
(catalog.py, media_workloads.py, switch_source.py, ...) that main.py
itself imports FROM can import ``sanitize_audit_field`` too without a
circular import — main.py -> catalog.py -> main.py would be a cycle if
this stayed defined only in main.py. This module imports nothing from
elsewhere in this package and should stay that way.
"""

from __future__ import annotations

import re

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_CONTROL_ESCAPES = {"\n": "\\n", "\r": "\\r", "\t": "\\t"}


def sanitize_audit_field(value: str | None) -> str:
    """Escape control characters out of a value bound for a log line.

    umbrella dmf-cms#108 fix-round 1: every externally-influenced field in
    ``_audit_awx_write``'s record — ``target`` (a raw, unvalidated path
    parameter on several routes — e.g. ``workflow_name``/catalog ``key`` —
    reaching this call on early-return audit paths BEFORE the value is
    ever looked up or validated), ``workload``, ``capacity``, and
    ``actor`` (``user.subject``, an OIDC claim) — used to reach a ``%s``-
    formatted log call unescaped. A value containing a literal CR or LF
    split the single physical audit line into two, or forged the START of
    a second, fabricated line reading as though it came from a different
    call (a hostile ``actor`` value can literally spell ``actor=admin`` on
    its own forged line) — on whatever reads dmf-cms's stdout: journalctl,
    ``kubectl logs``, a SIEM ingesting line-delimited log. Reachable by an
    operator+ role (or lower, on some pre-gate call sites), even with AWX
    left unconfigured. That is a forged entry in the record ADR-0028 C5
    depends on. ``reason`` fields already escape safely via ``%r``
    (``repr``) at their call sites; every OTHER free-text-ish field routes
    through here instead.

    fix-round 4: the same reasoning extends past request-influenced
    values to UPSTREAM RESPONSE CONTENT — a raw HTTP response body from
    Authentik/AWX/NetBox/Forgejo/Prometheus/PromSD (every ``*APIError``
    subclass in this codebase carries one, and it rides straight into
    ``str(exc)`` via each class's own ``__init__``), or a value a THIRD
    PARTY's own API response supplies (e.g. a Forgejo repo's
    ``full_name``). Those are not this module's own request data, but
    they are equally capable of forging a line on the same stream.

    Escapes rather than strips: a log line exists to be a complete,
    honest account of what happened, and silently dropping bytes would
    misrepresent that — ``reason``'s ``repr()`` escaping already sets the
    "show exactly what was sent, escaped, never edited" precedent this
    follows. Only the C0 control range + DEL is in scope (this is about
    staying on ONE physical stdout line, not general text sanitization) —
    ordinary values (the overwhelming majority: catalog keys, workload
    slugs, IdP subjects, upstream response bodies) contain none of these
    and pass through completely UNCHANGED, so the many existing tests
    asserting exact unquoted ``field=%s`` shapes are unaffected.

    PER-SITE, NOT A LOGGING FILTER (fix-round 3, evaluated and rejected
    explicitly): a ``logging.Filter`` that control-character-escaped every
    record's formatted message, installed once on the "dmf_cms" handler,
    would look like it closes this whole class in one place instead of
    one call site at a time. It is the wrong fix here: this codebase has
    roughly a dozen ``logger.exception``/``exc_info=True`` call sites
    across its modules, and their tracebacks — the primary debugging
    artifact for an unexpected crash — are formatted by the handler AFTER
    the record's own message, from the SAME record. A blanket filter
    escaping the rendered output would mangle every one of those
    tracebacks into a single escaped line, destroying exactly the thing
    ``logger.exception`` exists to preserve. Sanitizing per-site, only the
    specific externally-influenced value being interpolated (never the
    message template, never exception text), is what keeps tracebacks
    intact while still closing the injection path. Do not "simplify" this
    into a filter later without solving that problem first.
    """
    if not value:
        return ""
    return _CONTROL_CHAR_RE.sub(
        lambda m: _CONTROL_ESCAPES.get(m.group(), f"\\x{ord(m.group()):02x}"),
        value,
    )
