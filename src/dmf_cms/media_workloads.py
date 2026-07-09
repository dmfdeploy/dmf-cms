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
import re
import threading
import time
import urllib.parse
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# Aggregation contract from ADR-0037 §2: instances are ipam.Services carrying
# the catalog tag convention app:<key> + dmf-catalog + lifecycle:*.
CATALOG_TAG = "dmf-catalog"

# RFC1123 DNS label (Kubernetes Service/namespace name): lowercase alnum + '-',
# no leading/trailing '-', 1..63 chars. Gates the NetBox-stamped sidecar coords
# before they can ever be composed into an in-cluster URL. Always applied with
# .fullmatch (NOT .match): re '$' matches before a trailing '\n', so 'mxl-x\n'
# would slip past .match and then raise http.client.InvalidURL when composed —
# fullmatch anchors the whole string and rejects that (codex WP-D P2).
_DNS_LABEL = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")

# Default SSRF allowlists (overridden by MXLSettings). Kept here too so
# sidecar_base_url / _service_to_instance are safe to call without wiring.
_DEFAULT_SIDECAR_NAMESPACES = frozenset({"mxl"})
_DEFAULT_SIDECAR_PORTS = frozenset({9000})


def sidecar_base_url(
    svc: dict[str, Any],
    *,
    namespaces: frozenset[str] = _DEFAULT_SIDECAR_NAMESPACES,
    ports: frozenset[int] = _DEFAULT_SIDECAR_PORTS,
) -> Optional[str]:
    """Compose an instance's in-cluster status-sidecar base URL, or None.

    Reads the ADR-0038 Amendment-A coords the catalog launcher stamps
    (``cluster_service``/``cluster_namespace``/``cluster_port`` custom fields)
    and composes ``http://<svc>.<ns>.svc.cluster.local:<port>`` — byte-for-byte
    the dmf-promsd contract. The SSRF gate (codex WP-D P1) is the whole point:

    * ``cluster_service`` and ``cluster_namespace`` must be RFC1123 DNS labels;
    * ``cluster_namespace`` must be in the configured allowlist (default {mxl});
    * ``cluster_port`` must be in the configured allowlist (default {9000});
    * ``cluster_service`` must equal THIS instance's own service name — the
      concrete identity, not merely the same app family (codex R2 note) — so a
      NetBox writer stamping arbitrary coords cannot retarget the proxy at
      ``authentik``/``netbox``/``kubernetes.default`` or a peer workload.

    Any missing/invalid field returns None (no live view), never raises.
    """
    cf = svc.get("custom_fields")
    if not isinstance(cf, dict):
        return None
    service = cf.get("cluster_service")
    namespace = cf.get("cluster_namespace")
    if not isinstance(service, str) or not isinstance(namespace, str):
        return None
    if not _DNS_LABEL.fullmatch(service) or not _DNS_LABEL.fullmatch(namespace):
        return None
    if namespace not in namespaces:
        return None
    # Port may arrive as int or numeric string from NetBox; bool is rejected
    # (True/False are ints in Python but never a valid port stamp).
    port = cf.get("cluster_port")
    if isinstance(port, bool):
        return None
    try:
        port_num = int(port)
    except (TypeError, ValueError):
        return None
    if port_num not in ports:
        return None
    # Concrete-identity bind: the sidecar Service name MUST be this instance's
    # own name. In the shipped catalog svc.name == launcher mxl_release ==
    # cluster_service (dmf-runbooks roles/mxl); requiring equality blocks
    # retargeting even to another workload inside the mxl namespace.
    #
    # Threat model (codex WP-D P2): this defends against a writer that can only
    # tamper with custom_fields. The ADR-0032 scoped catalog writer can also
    # change a Service's `name`, so it controls BOTH sides of this equality —
    # but that writer is a trusted in-cluster component (a compromise of it
    # already grants lifecycle-tag flips i.e. deploys), and the only reachable
    # target is a peer mxl:9000 status sidecar the same media-engineer can
    # already view. NetBox is the source of truth here; no immutable
    # controller-owned identity exists to bind to instead.
    if service != svc.get("name"):
        return None
    return f"http://{service}.{namespace}.svc.cluster.local:{port_num}"


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


def _service_to_instance(
    svc: dict[str, Any],
    *,
    sidecar_namespaces: frozenset[str] = _DEFAULT_SIDECAR_NAMESPACES,
    sidecar_ports: frozenset[int] = _DEFAULT_SIDECAR_PORTS,
) -> dict[str, Any]:
    names = _tag_names(svc)
    parent = svc.get("device") or svc.get("virtual_machine") or {}
    return {
        "instance": svc.get("name", ""),
        "netbox_id": svc.get("id"),
        "function_key": _tag_suffix(names, "app"),
        # ONLY a boolean leaves the backend — never the coords/URL/IP. WP-C
        # uses it to decide which tiles poll the live-view endpoints.
        "live_view": sidecar_base_url(
            svc, namespaces=sidecar_namespaces, ports=sidecar_ports
        )
        is not None,
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
    base = f"/api/ipam/services/?tag={urllib.parse.quote(CATALOG_TAG)}&limit=500"

    if tenant_slugs is None:
        result = _netbox._request(netbox_url, netbox_token, base, ssl_context=ctx)
        return list(result.get("results", []))

    if not tenant_slugs:
        return []  # scoped, nothing mapped: fail closed to empty

    # Services attach to a parent device OR virtual machine (ADR-0037 §2);
    # tenant scope must resolve through BOTH parents or VM-backed workloads
    # silently vanish from scoped inventories (and clear-for-deployment
    # would 404 them). NetBox ANDs distinct filter params, so device- and
    # VM-scoped services need separate queries, unioned by service id.
    device_ids: list[int] = []
    vm_ids: list[int] = []
    for slug in tenant_slugs:
        quoted = urllib.parse.quote(slug)
        result = _netbox._request(
            netbox_url,
            netbox_token,
            f"/api/dcim/devices/?tenant={quoted}&brief=true&limit=500",
            ssl_context=ctx,
        )
        device_ids.extend(d["id"] for d in result.get("results", []) if d.get("id"))
        result = _netbox._request(
            netbox_url,
            netbox_token,
            f"/api/virtualization/virtual-machines/?tenant={quoted}&brief=true&limit=500",
            ssl_context=ctx,
        )
        vm_ids.extend(v["id"] for v in result.get("results", []) if v.get("id"))

    if not device_ids and not vm_ids:
        return []

    by_id: dict[Any, dict[str, Any]] = {}
    if device_ids:
        path = base + "".join(f"&device_id={d}" for d in device_ids)
        result = _netbox._request(netbox_url, netbox_token, path, ssl_context=ctx)
        for svc in result.get("results", []):
            by_id[svc.get("id")] = svc
    if vm_ids:
        path = base + "".join(f"&virtual_machine_id={v}" for v in vm_ids)
        result = _netbox._request(netbox_url, netbox_token, path, ssl_context=ctx)
        for svc in result.get("results", []):
            by_id[svc.get("id")] = svc
    return list(by_id.values())


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
    sidecar_namespaces: frozenset[str] = _DEFAULT_SIDECAR_NAMESPACES,
    sidecar_ports: frozenset[int] = _DEFAULT_SIDECAR_PORTS,
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

    instances = [
        _service_to_instance(
            svc, sidecar_namespaces=sidecar_namespaces, sidecar_ports=sidecar_ports
        )
        for svc in services
    ]

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


# ── ADR-0046 decisions 3 + 5: workload-first grouping ──────────────────────


def _cluster_service_from_target(instance_target: str) -> Optional[str]:
    """Extract the cluster_service name from a Prometheus ``instance`` target.

    The real label shape (confirmed via dmf-promsd + dmf-infra blackbox
    relabel configs): ``instance`` = the full probe target URL host+port+path,
    e.g. ``mxl-videotestsrc.mxl.svc.cluster.local:9000/status``.  The leading
    DNS label is the ``cluster_service`` value that dmf-promsd used to compose
    the target (ADR-0038 target construction).

    Returns the leading DNS label, or None if the target is unparseable.
    """
    if not isinstance(instance_target, str) or not instance_target:
        return None
    # Strip any scheme (e.g. "http://...")
    host = instance_target
    if "://" in host:
        host = host.split("://", 1)[1]
    # Strip path (e.g. ":9000/status" -> ":9000")
    host = host.split("/", 1)[0]
    # Strip port (e.g. "svc.ns.svc.cluster.local:9000" -> "svc.ns.svc.cluster.local")
    host = host.rsplit(":", 1)[0]
    # Leading DNS label = cluster_service
    if not host:
        return None
    return host.split(".", 1)[0]


def _observed_by_identity(prometheus_url: str) -> dict[str, float]:
    """Map cluster_service (from probe target) -> probe_success (ADR-0046 §3).

    Unlike ``_observed_by_app`` (which collapses by shared ``app`` label),
    this extracts the per-instance identity from the Prometheus ``instance``
    label — which is the full probe target URL. The leading DNS label of the
    target host is the ``cluster_service`` value (dmf-promsd composes the
    target as ``<cluster_service>.<namespace>.svc.cluster.local:<port>``).

    The returned dict maps ``cluster_service -> probe_success value``.
    Callers join this to instances via the NetBox ``cluster_service`` custom
    field, NOT the service name (they may differ, e.g. nmos-cpp service has
    cluster_service=nmos-cpp-registry).

    Empty dict on any failure — observed degrades to "unknown", never breaks.
    """
    from . import prometheus as _prometheus

    try:
        rows = _prometheus.query(url=prometheus_url, expr='probe_success{job="netbox-probe"}')
    except Exception as exc:
        logger.warning("media-workloads: identity prometheus overlay failed: %s", exc)
        return {}
    out: dict[str, float] = {}
    for row in rows or []:
        metric = row.get("metric") or {}
        instance_target = metric.get("instance", "")
        cluster_svc = _cluster_service_from_target(instance_target)
        try:
            value = float(row["value"][1])
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if cluster_svc:
            out[cluster_svc] = min(out.get(cluster_svc, 1.0), value)
    return out


def _workload_assignment(names: list[str]) -> tuple[str, str]:
    """Determine workload assignment from tag names (ADR-0046 §2).

    Returns (slug, status) where status is one of:
      "ok"               — exactly one workload:<slug> tag
      "unassigned"       — zero workload:* tags → goes to "unassigned" bucket
      "invalid-multiple"  — more than one workload:* tag → degraded
    """
    slugs = [
        name.split(":", 1)[1]
        for name in names
        if name.startswith("workload:")
    ]
    if len(slugs) == 0:
        return "unassigned", "unassigned"
    if len(slugs) == 1:
        return slugs[0], "ok"
    return slugs[0], "invalid-multiple"


def _derive_workload_lifecycle(instances: list[dict[str, Any]]) -> str:
    """Derive workload lifecycle from member instances (ADR-0046 §3).

    v0.2 derives only:
      provision — members exist / bootstrapped (no active intent yet)
      configure — active intent exists but observed/flow incomplete
      operate   — required members active AND observed healthy

    Design / Plan / Finalise → declared/unknown.
    NEVER infer finalise from absence.
    """
    if not instances:
        return "unknown"

    requested = {inst["requested_state"] for inst in instances}
    observed = {inst["observed_state"] for inst in instances}

    all_bootstrapped = requested <= {"bootstrapped", "unknown"}
    any_active = "active" in requested
    all_active = requested >= {"active"} and "bootstrapped" not in requested and "unknown" not in requested
    all_healthy = all(inst["observed_state"] == "running" for inst in instances if inst["requested_state"] == "active")
    any_reconcile = any(inst["reconcile_pending"] for inst in instances)

    if all_bootstrapped:
        return "provision"
    if all_active and all_healthy and not any_reconcile:
        return "operate"
    if any_active:
        return "configure"
    return "unknown"


def list_workloads_grouped(
    netbox_url: str,
    netbox_token: str,
    ssl_verify: bool,
    tenant_slugs: Optional[tuple[str, ...]],
    prometheus_url: str = "",
    sidecar_namespaces: frozenset[str] = _DEFAULT_SIDECAR_NAMESPACES,
    sidecar_ports: frozenset[int] = _DEFAULT_SIDECAR_PORTS,
) -> dict[str, Any]:
    """Grouped workload-first payload (ADR-0046 decisions 3 + 5).

    Returns workloads grouped by ``workload:<slug>`` tag, with per-workload
    lifecycle derivation and identity-joined observed state. The flat
    instance shape within each workload is identical to ``list_instances``
    for frontend reuse.
    """
    from . import netbox as _netbox

    try:
        services = _fetch_services(netbox_url, netbox_token, ssl_verify, tenant_slugs)
    except _netbox.NetboxAPIError as exc:
        logger.warning("media-workloads: NetBox query failed: %s", exc)
        return {"degraded": True, "reason": "netbox-unreachable", "workloads": [], "invalid_instances": []}
    except Exception as exc:
        logger.warning("media-workloads: unexpected NetBox error: %s", exc)
        return {"degraded": True, "reason": "netbox-error", "workloads": [], "invalid_instances": []}

    instances = [
        _service_to_instance(
            svc, sidecar_namespaces=sidecar_namespaces, sidecar_ports=sidecar_ports
        )
        for svc in services
    ]

    # Build a name→cluster_service lookup from NetBox custom fields.
    # The Prometheus instance label contains the cluster_service (leading DNS
    # label of the probe target), NOT the NetBox service name. They may differ
    # (e.g. nmos-cpp service → cluster_service=nmos-cpp-registry).
    svc_cluster_service: dict[str, str] = {}
    for svc in services:
        cf = svc.get("custom_fields")
        if isinstance(cf, dict):
            cs = cf.get("cluster_service")
            if isinstance(cs, str) and cs:
                svc_cluster_service[svc.get("name", "")] = cs

    # Identity-join: per-instance observed state via cluster_service (ADR-0046 §3)
    observed = _observed_by_identity(prometheus_url) if prometheus_url else {}
    for inst in instances:
        cs = svc_cluster_service.get(inst["instance"], inst["instance"])
        if cs in observed:
            inst["observed_state"] = "running" if observed[cs] >= 1.0 else "failing"
        inst["reconcile_pending"] = (
            inst["requested_state"] == "active" and inst["observed_state"] != "running"
        )

    # Build a name→tags lookup from the raw service records for grouping.
    svc_tags_by_name: dict[str, list[str]] = {
        svc.get("name", ""): _tag_names(svc) for svc in services
    }

    # Group by workload assignment
    workload_groups: dict[str, list[dict[str, Any]]] = {}
    invalid_instances: list[dict[str, Any]] = []

    for inst in instances:
        names = svc_tags_by_name.get(inst["instance"], [])
        slug, status = _workload_assignment(names)

        if status == "invalid-multiple":
            # Surface the conflicting workload slugs so the operator can
            # identify and fix the mis-tagged service (ADR-0046 §2).
            conflicting = [
                n.split(":", 1)[1] for n in names if n.startswith("workload:")
            ]
            invalid_instances.append({
                **inst,
                "workload_assignment": "invalid-multiple",
                "conflicting_workloads": conflicting,
            })
            # Do NOT place in multiple workloads (ADR-0046 §2).
            continue

        inst["workload_assignment"] = status
        workload_groups.setdefault(slug, []).append(inst)

    # Build workload objects
    workloads: list[dict[str, Any]] = []
    for slug, members in sorted(workload_groups.items()):
        members_sorted = sorted(members, key=lambda i: i["instance"])
        lifecycle = _derive_workload_lifecycle(members_sorted)

        # Per-workload function rollup within this workload
        functions: dict[str, dict[str, Any]] = {}
        for inst in members_sorted:
            key = inst["function_key"] or "(untagged)"
            agg = functions.setdefault(
                key, {"function_key": key, "count": 0, "running": 0, "reconcile_pending": 0}
            )
            agg["count"] += 1
            if inst["observed_state"] == "running":
                agg["running"] += 1
            if inst["reconcile_pending"]:
                agg["reconcile_pending"] += 1

        workloads.append({
            "slug": slug,
            "name": "Unassigned" if slug == "unassigned" else slug,
            "lifecycle": lifecycle,
            "health": "ok",
            "instances": members_sorted,
            "functions": sorted(functions.values(), key=lambda f: f["function_key"]),
        })

    return {
        "degraded": len(invalid_instances) > 0,
        "workloads": workloads,
        "invalid_instances": invalid_instances,
    }

def clear_for_deployment(
    netbox_url: str,
    writer_token: str,
    ssl_verify: bool,
    tenant_slugs: Optional[tuple[str, ...]],
    read_token: str,
    instance_name: str,
) -> dict[str, Any]:
    """Flip an instance's lifecycle tag bootstrapped -> active (ADR-0037 WP2b).

    "Clear for deployment" IS the desired-state flip: ``lifecycle:active`` is
    the intent signal the AWX lane understands (the tag taxonomy is binary,
    ADR-0013). NetBox is the ONLY thing the console writes; convergence is
    the catalog launch / drift-detection loop's job — never k3s from here.

    Scope is enforced independently on this write path: the instance is
    looked up WITHIN the caller's tenant scope, so an out-of-scope name is
    indistinguishable from a nonexistent one (``not-found``, no side effect,
    no existence leak). The tag rewrite preserves every non-``lifecycle:*``
    tag. Reads use *read_token*; the single PATCH uses *writer_token*
    (ADR-0032 scoped writer).

    Returns a dict with either ``error`` (not-found | already-active |
    netbox-unreachable | netbox-error) or the new state.
    """
    from . import netbox as _netbox

    ctx = _netbox._ssl_context(ssl_verify)
    try:
        services = _fetch_services(netbox_url, read_token, ssl_verify, tenant_slugs)
    except _netbox.NetboxAPIError as exc:
        logger.warning("media-workloads: clear lookup failed: %s", exc)
        return {"error": "netbox-unreachable"}
    except Exception as exc:
        logger.warning("media-workloads: clear lookup unexpected error: %s", exc)
        return {"error": "netbox-error"}

    svc = next((s for s in services if s.get("name") == instance_name), None)
    if svc is None or not svc.get("id"):
        return {"error": "not-found"}

    names = _tag_names(svc)
    current = _tag_suffix(names, "lifecycle") or "unknown"
    if current == "active":
        return {"error": "already-active", "requested_state": "active"}

    new_tags = [{"name": n} for n in names if not n.startswith("lifecycle:")]
    new_tags.append({"name": "lifecycle:active"})
    try:
        _netbox._request(
            netbox_url,
            writer_token,
            f"/api/ipam/services/{svc['id']}/",
            ssl_context=ctx,
            method="PATCH",
            payload={"tags": new_tags},
        )
    except _netbox.NetboxAPIError as exc:
        logger.warning("media-workloads: clear PATCH failed: %s", exc)
        return {"error": "netbox-unreachable"}
    except Exception as exc:
        logger.warning("media-workloads: clear PATCH unexpected error: %s", exc)
        return {"error": "netbox-error"}

    return {
        "instance": instance_name,
        "requested_state": "active",
        "previous_state": current,
    }


class ScopedServiceCache:
    """5s TTL cache of the scope-filtered ipam.Service list, keyed by tenant scope.

    The live-view endpoints poll per-tile (status ~2s, preview ~1.5s); without
    this every poll re-queries NetBox for the whole catalog. Keyed by the
    caller's tenant scope (``None`` unscoped, or the sorted tenant tuple) so two
    users with the same visibility share an entry and scope can never bleed
    across. One instance per app (created in ``create_app``) — no module global,
    so tests get a fresh cache per app and there is no cross-test bleed.
    """

    def __init__(self, ttl: float = 5.0) -> None:
        self._ttl = ttl
        self._lock = threading.Lock()
        self._entries: dict[Any, tuple[float, list[dict[str, Any]]]] = {}

    def get(
        self,
        tenant_slugs: Optional[tuple[str, ...]],
        loader: Callable[[], list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        # None (unscoped) and a tenant tuple are both hashable; a fresh sorted
        # tuple canonicalises scope order so equivalent scopes share an entry.
        key: Any = None if tenant_slugs is None else tuple(sorted(tenant_slugs))
        now = time.monotonic()
        with self._lock:
            hit = self._entries.get(key)
            if hit is not None and now - hit[0] < self._ttl:
                return hit[1]
        services = loader()  # may raise NetboxAPIError — caller wraps it
        with self._lock:
            self._entries[key] = (now, services)
        return services


def resolve_sidecar_target(
    netbox_url: str,
    read_token: str,
    ssl_verify: bool,
    tenant_slugs: Optional[tuple[str, ...]],
    instance_name: str,
    *,
    sidecar_namespaces: frozenset[str] = _DEFAULT_SIDECAR_NAMESPACES,
    sidecar_ports: frozenset[int] = _DEFAULT_SIDECAR_PORTS,
    cache: Optional[ScopedServiceCache] = None,
) -> dict[str, Any]:
    """Scoped lookup of an instance's status-sidecar base URL for the live view.

    Returns one of:

    * ``{"status": "not-found"}``            -> endpoint 404s (out-of-scope OR
      absent are indistinguishable; scope parity with clear_for_deployment,
      so membership never leaks);
    * ``{"status": "no-sidecar"}``           -> 200 ``available:false`` (in scope
      but no valid/allowlisted coords);
    * ``{"status": "unreachable"}``          -> 200 ``available:false`` (NetBox
      lookup failed — we can't verify scope, so we degrade rather than 404);
    * ``{"status": "ok", "base_url": ...}``  -> caller fetches the sidecar.

    The composed base URL never leaves the backend; only the caller passes it to
    the hardened fetchers in ``mxl``.
    """
    from . import netbox as _netbox

    def _load() -> list[dict[str, Any]]:
        return _fetch_services(netbox_url, read_token, ssl_verify, tenant_slugs)

    try:
        services = cache.get(tenant_slugs, _load) if cache is not None else _load()
    except _netbox.NetboxAPIError as exc:
        logger.warning("media-workloads: sidecar lookup failed: %s", exc)
        return {"status": "unreachable"}
    except Exception as exc:
        logger.warning("media-workloads: sidecar lookup unexpected error: %s", exc)
        return {"status": "unreachable"}

    svc = next((s for s in services if s.get("name") == instance_name), None)
    if svc is None:
        return {"status": "not-found"}
    base_url = sidecar_base_url(
        svc, namespaces=sidecar_namespaces, ports=sidecar_ports
    )
    if base_url is None:
        return {"status": "no-sidecar"}
    return {"status": "ok", "base_url": base_url}
