"""PromSD API client — NetBox-driven Prometheus service-discovery targets.

umbrella #202 WP4: the console-side read seam used to verify monitoring
drain after a rollback. Mirrors ``prometheus.py`` exactly (URL-only config,
raw urllib GET, 30s timeout, raise-through errors) — no new HTTP surface
beyond this one read.
"""

from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Any, Optional


class PromSDAPIError(Exception):
    """Raised when the PromSD API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"PromSD API {status}: {body}")


def _strip_to_host(target: object) -> Optional[str]:
    """Exact host extraction — scheme/path/port-tolerant, mirrors
    ``media_workloads._cluster_service_from_target``'s stripping, but
    returns the FULL host rather than just its leading DNS label: drain
    verification needs exact-host equality, so ``foo`` can never match
    ``foo-bar`` (A10) — full-string comparison against the drain-set hosts
    is what guarantees that, not a prefix/substring check here.

    codex round-1 F7 (REJECTED, kept host-only): matching stays host-only,
    deliberately not port/path-aware. Being port/path-aware would require
    the caller to independently DERIVE the expected port/probe path — a
    wrong derivation would make a live target invisible to the drain check
    (false-green, the worse failure direction), whereas host-only matching
    can only ever err toward over-matching (a live target on a DIFFERENT
    port/path of the same host still counts as "still present" -> stays
    soft-pending). That's the safe direction: a v1-accepted limitation, not
    a bug — J1's catalog has exactly one probe per Service host, so this
    never bites in practice; a facility with two distinct probes sharing
    one host would see drain verification block on the wrong one's
    presence rather than silently confirm the other drained.

    codex round-4 (F1/F2): lives here, not in drain.py, because it is now
    the single shared authority for "is this candidate string a usable
    target identity" — both this module's own ``list_probe_targets`` and
    drain.py's Prometheus row validation must reject a string using the
    EXACT SAME parser the matching loop applies, not a looser truthiness
    check (``":"``, ``"://"``, and ``"/path-only"`` are all non-empty
    strings that parse to ``None`` here — a validator that only checked
    "is this a non-empty str" would let them through, contributing no
    real candidate host while still counting as "usable"). drain.py
    imports this one implementation rather than keeping a second copy —
    promsd.py has no dependency on drain.py, so drain.py importing this
    at module level creates no cycle.
    """
    if not isinstance(target, str) or not target:
        return None
    host = target
    if "://" in host:
        host = host.split("://", 1)[1]
    host = host.split("/", 1)[0]
    host = host.rsplit(":", 1)[0]
    return host or None


def _request(url: str, path: str) -> Any:
    """Make a GET request to the PromSD API (no auth required).

    codex round-2 F3: an EMPTY response body raises too — ``b""`` is not
    valid JSON, and this seam is drain-only (no other caller needs a
    lenient "empty body means empty result" fallback), so a
    malformed/truncated read must never silently degrade to "no data".
    """
    full_url = url.rstrip("/") + path
    req = urllib.request.Request(full_url, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode() if exc.fp else str(exc)
        raise PromSDAPIError(exc.code, error_body) from exc
    if not raw:
        raise PromSDAPIError(200, "empty response body")
    return json.loads(raw)


def list_probe_targets(*, url: str) -> list[dict]:
    """List the ``probe`` lane's current scrape-target groups.

    Returns the raw ``/sd/probe`` JSON: a list of Prometheus file_sd groups
    ``{"targets": [...], "labels": {...}}``. codex round-1 F3a + round-2
    F3: validates BOTH the top level AND the nested shape — every group
    must be a dict, its ``targets`` must be a LIST. A bare string is
    iterable in Python, so ``{"targets": "not-a-list"}`` would otherwise
    get silently scanned character-by-character by drain.py's
    host-matching loop instead of raising here.

    codex round-4 F2: each target must be USABLE by that same matching
    loop, not merely a non-empty string — ``_strip_to_host(t)`` must
    itself yield a non-empty host (``":"`` is a non-empty string but
    parses to ``None``, so a truthiness-only check let it through while
    contributing no real candidate host). Any violation of this shape
    RAISES — it never silently degrades to "no targets" (the WP1
    HTTP-200-empty lesson: a malformed/unexpected shape must never read
    as real drain evidence).
    """
    result = _request(url, "/sd/probe")
    if not isinstance(result, list):
        raise PromSDAPIError(200, f"malformed /sd/probe payload (not a list): {result!r}")
    for group in result:
        if not isinstance(group, dict):
            raise PromSDAPIError(200, f"malformed /sd/probe group (not a dict): {group!r}")
        targets = group.get("targets")
        if not isinstance(targets, list) or not all(_strip_to_host(t) for t in targets):
            raise PromSDAPIError(200, f"malformed /sd/probe group.targets: {targets!r}")
    return result


def ready(*, url: str) -> bool:
    """GET ``/readyz`` — True only for the CANONICAL ready payload; any
    error (non-2xx, unreachable, ...) OR a malformed/contradictory 200
    body means "not ready" (fail-closed).

    codex round-1 F3a: a cold PromSD adapter (or one whose initial NetBox
    refresh failed) serves HTTP 200 ``[]`` on ``/sd/probe`` while
    ``/readyz`` still reports 503 (dmf-promsd main.py:74-86,
    cache.py:115-119,134-147) — callers MUST check this in the same poll
    cycle before trusting ``/sd/probe``'s emptiness as real drain evidence.

    codex round-3 F2: an any-200-that-decodes check isn't enough — the
    real server's own ``ready_payload()`` (dmf-promsd cache.py:134-148)
    is ``{"status": "ready"|"stale", "ready": bool, ...}`` with
    ``status_code = 200 if ready else 503``, so ``ready``/``status``
    normally agree with the HTTP status. This client is explicitly the
    fail-closed boundary for when they DON'T (a version/proxy
    inconsistency serving 200 with ``ready: false`` must never read as
    ready) — requires a dict with ``ready`` is exactly ``True``, and if
    ``status`` is present it must equal ``"ready"``.
    """
    try:
        result = _request(url, "/readyz")
    except Exception:
        return False
    if not isinstance(result, dict) or result.get("ready") is not True:
        return False
    status = result.get("status")
    if status is not None and status != "ready":
        return False
    return True
