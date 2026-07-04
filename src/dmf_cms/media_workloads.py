"""Media Workloads: NetBox-driven Media Function instance inventory (ADR-0037).

NetBox owns instances + placement (never flows, never live state); this module
reads the ``dmf-catalog``-tagged ipam.Services, derives the *desired* state
from the ``lifecycle:*`` tag, and overlays *observed* runtime state from
Prometheus (``probe_success`` on the ADR-0038 ``netbox-probe`` lane, joined on
the promsd-stamped ``app`` label). Desired and observed are deliberately
separate fields — a flipped tag is intent, not proof of running (GATE-7).

Tenancy: callers pass the permitted tenant slugs (``None`` = unscoped single-
tenant mode; empty tuple = scoped user with no visibility -> empty inventory).
NetBox ipam.Services carry no tenant directly; scope resolves through the
parent device/VM's tenant, so scoped mode filters via a device lookup per
tenant slug. All errors surface as a degraded payload, never a raw 500
(UX Constitution hard gate 4).
"""

from __future__ import annotations

import logging
import urllib.parse
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Aggregation contract from ADR-0037 §2: instances are ipam.Services carrying
# the catalog tag convention app:<key> + dmf-catalog + lifecycle:*.
CATALOG_TAG = "dmf-catalog"


def _tag_names(obj: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for tag_obj in obj.get("tags", []) or []:
        out.append(tag_obj.get("name", "") if isinstance(tag_obj, dict) else str(tag_obj))
    return out


def _tag_suffix(names: list[str], prefix: str) -> Optional[str]:
    for name in names:
        if name.startswith(prefix + ":"):
            return name.split(":", 1)[1]
    return None


def _service_to_instance(svc: dict[str, Any]) -> dict[str, Any]:
    names = _tag_names(svc)
    parent = svc.get("device") or svc.get("virtual_machine") or {}
    return {
        "instance": svc.get("name", ""),
        "netbox_id": svc.get("id"),
        "function_key": _tag_suffix(names, "app"),
        # Desired state: the lifecycle tag is INTENT (what should be running),
        # per ADR-0013/0037. Never render it as runtime truth.
        "requested_state": _tag_suffix(names, "lifecycle") or "unknown",
        "placement": {
            "node": parent.get("name") if isinstance(parent, dict) else None,
            "ports": svc.get("ports", []),
            "protocol": (svc.get("protocol") or {}).get("value")
            if isinstance(svc.get("protocol"), dict)
            else svc.get("protocol"),
        },
        # Observed state is overlaid by list_instances(); default honest-unknown.
        "observed_state": "unknown",
        "reconcile_pending": False,
    }


def _fetch_services(
    netbox_url: str,
    netbox_token: str,
    ssl_verify: bool,
    tenant_slugs: Optional[tuple[str, ...]],
) -> list[dict[str, Any]]:
    """Fetch dmf-catalog-tagged services, tenant-filtered when scoped.

    Raises netbox.NetboxAPIError upward — the endpoint wraps it into a
    degraded payload.
    """
    from . import netbox as _netbox

    ctx = _netbox._ssl_context(ssl_verify)

    device_filter = ""
    if tenant_slugs is not None:
        if not tenant_slugs:
            return []  # scoped, nothing mapped: fail closed to empty
        device_ids: list[int] = []
        for slug in tenant_slugs:
            path = f"/api/dcim/devices/?tenant={urllib.parse.quote(slug)}&brief=true&limit=500"
            result = _netbox._request(netbox_url, netbox_token, path, ssl_context=ctx)
            device_ids.extend(d["id"] for d in result.get("results", []) if d.get("id"))
        if not device_ids:
            return []
        device_filter = "".join(f"&device_id={d}" for d in device_ids)

    path = f"/api/ipam/services/?tag={urllib.parse.quote(CATALOG_TAG)}&limit=500{device_filter}"
    result = _netbox._request(netbox_url, netbox_token, path, ssl_context=ctx)
    return list(result.get("results", []))


def _observed_by_app(prometheus_url: str) -> dict[str, float]:
    """Map promsd-stamped ``app`` label -> probe_success value (netbox-probe lane).

    Empty dict on any failure — observed state degrades to "unknown", it never
    breaks the inventory read.
    """
    from . import prometheus as _prometheus

    try:
        rows = _prometheus.query(url=prometheus_url, expr='probe_success{job="netbox-probe"}')
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("media-workloads: prometheus overlay failed: %s", exc)
        return {}
    out: dict[str, float] = {}
    for row in rows or []:
        app = (row.get("metric") or {}).get("app")
        try:
            value = float(row["value"][1])
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if app:
            # Multiple instances per app: any failing probe drags the app down.
            out[app] = min(out.get(app, 1.0), value)
    return out


def list_instances(
    netbox_url: str,
    netbox_token: str,
    ssl_verify: bool,
    tenant_slugs: Optional[tuple[str, ...]],
    prometheus_url: str = "",
) -> dict[str, Any]:
    """Inventory payload: instances + per-function rollup, desired vs observed."""
    from . import netbox as _netbox

    try:
        services = _fetch_services(netbox_url, netbox_token, ssl_verify, tenant_slugs)
    except _netbox.NetboxAPIError as exc:
        logger.warning("media-workloads: NetBox query failed: %s", exc)
        return {"degraded": True, "reason": "netbox-unreachable", "instances": [], "functions": []}
    except Exception as exc:
        logger.warning("media-workloads: unexpected NetBox error: %s", exc)
        return {"degraded": True, "reason": "netbox-error", "instances": [], "functions": []}

    instances = [_service_to_instance(svc) for svc in services]

    observed = _observed_by_app(prometheus_url) if prometheus_url else {}
    for inst in instances:
        key = inst["function_key"]
        if key is not None and key in observed:
            inst["observed_state"] = "running" if observed[key] >= 1.0 else "failing"
        # Intent says active but runtime proof is absent/failing -> the gap
        # the AWX drift lane exists to converge (ADR-0037 §4).
        inst["reconcile_pending"] = (
            inst["requested_state"] == "active" and inst["observed_state"] != "running"
        )

    functions: dict[str, dict[str, Any]] = {}
    for inst in instances:
        key = inst["function_key"] or "(untagged)"
        agg = functions.setdefault(
            key, {"function_key": key, "count": 0, "running": 0, "reconcile_pending": 0}
        )
        agg["count"] += 1
        if inst["observed_state"] == "running":
            agg["running"] += 1
        if inst["reconcile_pending"]:
            agg["reconcile_pending"] += 1

    return {
        "degraded": False,
        "instances": instances,
        "functions": sorted(functions.values(), key=lambda f: f["function_key"]),
    }
