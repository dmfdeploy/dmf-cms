"""MXL demo client — aggregates the per-node status sidecars for the MXL Flows page.

Each MXL media node runs a status sidecar (see dmf-media mxl-fabrics-demo chart)
exposing `/status` (JSON: node/provider/role + flow stats from mxl-info) and
`/preview.jpg` (a periodic JPEG snapshot of the received flow). This client fans out
to the configured endpoints and aggregates; it tolerates an endpoint being down so
the page degrades gracefully. No node IPs are ever returned to the UI.
"""
from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.request

# role/provider are contract slugs (producer|receiver|source|view; a cloud
# slug like "aliyun") — enforce a strict lowercase slug grammar.
_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")


def _get_json(url: str, path: str, timeout: float = 2.0) -> dict:
    req = urllib.request.Request(f"{url.rstrip('/')}{path}", method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def fetch_status(endpoints) -> dict:
    """Fan out to every endpoint's /status; aggregate into nodes[] + a flow summary.

    `endpoints` is an iterable of settings.MXLEndpoint (role, provider, url).
    Returns: {"nodes": [...], "flow": {...}, "transport": {...}, "reachable": bool}.
    Node objects expose role/provider/status + the node's flow head index — never the URL/IP.
    """
    nodes: list[dict] = []
    flow: dict = {}
    transport: dict = {}
    any_ok = False

    for ep in endpoints:
        try:
            data = _get_json(ep.url, "/status")
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError, json.JSONDecodeError, TimeoutError):
            continue

        any_ok = True
        node = {
            "role": ep.role,
            "provider": ep.provider,
            "online": True,
            "node": data.get("node"),
            "interface": data.get("interface") or data.get("transport", {}).get("interface"),
            "host": data.get("host", {}),
            "container": data.get("container", {}),
            "infra": data.get("infra", {}),
            "mxl_version": data.get("mxl_version"),
            "flow": data.get("flow", {}),
            "preview": bool(data.get("preview")),
        }
        nodes.append(node)

        # Transport + flow identity are the same across nodes — capture once.
        if not transport:
            transport = data.get("transport", {})
            if data.get("interface") and "interface" not in transport:
                transport["interface"] = data.get("interface")
        f = data.get("flow", {})
        if not flow and f:
            flow = {
                "id": f.get("id"),
                "format": f.get("format"),
                "grain_rate": f.get("grain_rate") or f.get("rate"),
                "active": f.get("active"),
                "mxl_version": data.get("mxl_version"),
            }
        # Receiver carries the cross-host latency that proves arrival.
        if ep.role == "receiver":
            flow["head_index"] = f.get("head_index")
            flow["latency_grains"] = f.get("latency_grains")
            flow["latency_ms"] = f.get("latency_ms")
            flow["active"] = f.get("active", flow.get("active"))
            flow["mxl_version"] = data.get("mxl_version") or flow.get("mxl_version")

    return {"nodes": nodes, "flow": flow, "transport": transport, "reachable": any_ok}


def fetch_preview(endpoints, role: str, timeout: float = 4.0) -> bytes | None:
    """Fetch the JPEG preview from the endpoint with the given role (e.g. 'receiver')."""
    for ep in endpoints:
        if ep.role != role:
            continue
        try:
            req = urllib.request.Request(f"{ep.url.rstrip('/')}/preview.jpg", method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, OSError):
            return None
    return None


# ---------------------------------------------------------------------------
# Per-instance (NetBox-derived) fetchers for the Media Workloads live view
# (WP-D / G26). base_url is composed server-side by
# media_workloads.sidecar_base_url — an allowlisted, DNS-validated,
# identity-checked in-cluster URL — NEVER raw user input. These add the codex
# WP-D P3 hardening: short timeouts, response byte caps, and a JPEG magic-byte
# check, so a compromised or misdirected sidecar can't wedge or poison the
# console.
# ---------------------------------------------------------------------------

def _read_capped(resp, max_bytes: int) -> bytes | None:
    """Read at most ``max_bytes``; return None if the body exceeds the cap.

    Reads one byte past the cap so an over-cap body is detected rather than
    silently truncated (a truncated JPEG would still pass the SOI check).
    """
    data = resp.read(max_bytes + 1)
    return None if len(data) > max_bytes else data


def fetch_status_one(
    base_url: str, *, timeout: float = 2.0, max_bytes: int = 32 * 1024
) -> dict | None:
    """Fetch + parse ONE sidecar's ``/status`` JSON, hardened. None on any failure."""
    try:
        req = urllib.request.Request(f"{base_url.rstrip('/')}/status", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = _read_capped(resp, max_bytes)
    except (urllib.error.URLError, urllib.error.HTTPError, http.client.HTTPException, OSError, TimeoutError, ValueError):
        # http.client.HTTPException covers InvalidURL from any composed-host
        # oddity that slipped the label gate — degrade, never 500 (codex P2).
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _slug_or_none(value) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    return v if _SLUG.fullmatch(v) else None


def _bounded_or_none(value, maxlen: int) -> str | None:
    """A trimmed, length-capped, control-char-free string, else None."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v or len(v) > maxlen:
        return None
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in v):
        return None
    return v


def _num_or_none(value):
    # Numbers only (bool is not a number here); a string can't smuggle a coord.
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def shape_status(instance: str, data: dict) -> dict:
    """Bounded public status payload from raw sidecar JSON (codex WP-D P2).

    The sidecar is our own in-cluster workload, but a compromised/buggy one
    could stuff a URL/coord/IP into a string field. So we return a FIXED field
    set (never passthrough), strict-slug role/provider, length-cap + strip
    control chars on node/version/format/grain_rate, and coerce numeric flow
    fields to number-or-None. Residual: a short in-cluster-DNS-shaped string in
    ``node`` still parses — that's a trusted-infra display value, not a leak of
    the NetBox-stamped coords (which never flow through the sidecar payload).
    """
    flow = data.get("flow")
    if not isinstance(flow, dict):
        flow = {}
    active = flow.get("active")
    return {
        "instance": instance,
        "available": True,
        "role": _slug_or_none(data.get("role")),
        "provider": _slug_or_none(data.get("provider")),
        "preview": bool(data.get("preview")),
        "node": _bounded_or_none(data.get("node"), 64),
        "mxl_version": _bounded_or_none(data.get("mxl_version"), 32),
        "flow": {
            "head_index": _num_or_none(flow.get("head_index")),
            "latency_ms": _num_or_none(flow.get("latency_ms")),
            "latency_grains": _num_or_none(flow.get("latency_grains")),
            "active": active if isinstance(active, bool) else None,
            "format": _bounded_or_none(flow.get("format"), 32),
            "grain_rate": _bounded_or_none(flow.get("grain_rate") or flow.get("rate"), 32),
        },
    }


def fetch_preview_one(
    base_url: str, *, timeout: float = 4.0, max_bytes: int = 256 * 1024
) -> bytes | None:
    """Fetch ONE sidecar's ``/preview.jpg``, hardened. None on any failure.

    A JPEG SOI (``0xFFD8``) magic-byte check runs before we ever proxy the body
    as ``image/jpeg`` — so a non-JPEG or over-cap body is rejected, not relayed.
    """
    try:
        req = urllib.request.Request(f"{base_url.rstrip('/')}/preview.jpg", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = _read_capped(resp, max_bytes)
    except (urllib.error.URLError, urllib.error.HTTPError, http.client.HTTPException, OSError, TimeoutError):
        return None
    if not data or data[:2] != b"\xff\xd8":
        return None
    return data
