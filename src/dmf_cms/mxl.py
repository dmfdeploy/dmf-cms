"""MXL demo client — aggregates the per-node status sidecars for the MXL Flows page.

Each MXL media node runs a status sidecar (see dmf-media mxl-fabrics-demo chart)
exposing `/status` (JSON: node/provider/role + flow stats from mxl-info) and
`/preview.jpg` (a periodic JPEG snapshot of the received flow). This client fans out
to the configured endpoints and aggregates; it tolerates an endpoint being down so
the page degrades gracefully. No node IPs are ever returned to the UI.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request


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
    req = urllib.request.Request(f"{base_url.rstrip('/')}/status", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = _read_capped(resp, max_bytes)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, TimeoutError, ValueError):
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def fetch_preview_one(
    base_url: str, *, timeout: float = 4.0, max_bytes: int = 256 * 1024
) -> bytes | None:
    """Fetch ONE sidecar's ``/preview.jpg``, hardened. None on any failure.

    A JPEG SOI (``0xFFD8``) magic-byte check runs before we ever proxy the body
    as ``image/jpeg`` — so a non-JPEG or over-cap body is rejected, not relayed.
    """
    req = urllib.request.Request(f"{base_url.rstrip('/')}/preview.jpg", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = _read_capped(resp, max_bytes)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, TimeoutError):
        return None
    if not data or data[:2] != b"\xff\xd8":
        return None
    return data
