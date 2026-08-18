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
import math
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
        # umbrella #401 — a topology-spawned source instance (one Helm
        # release per declared sources[] entry, no catalog entry of its
        # own by design) carries two provenance tags the launcher stamps
        # at deploy time (dmf-runbooks roles/mxl/defaults/main.yml):
        # topology-parent:<catalog entry key> and
        # topology-source:<declared sources[].id>. Read the SAME generic
        # way app:/lifecycle: already are — no naming-contract knowledge,
        # no parsing of `instance`/function_key, nothing dmf-cms-specific.
        # Both null when the tags are absent: an ordinary instance (never
        # topology-spawned), or a topology-spawned instance provisioned
        # before this tagging existed — both degrade identically to
        # "genuinely unresolvable via this path", never a guess.
        "topology_parent_key": _tag_suffix(names, "topology-parent"),
        "topology_source_id": _tag_suffix(names, "topology-source"),
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


# umbrella #347 fix round FIX-A2b.5 (GATE-A2b.3R P1), hardened FIX-A2b.6
# (GATE-A2b.3R2): the real dmf-promsd probe-target shape (ADR-0038 target
# construction) is <cluster_service>.<namespace>.svc.cluster.local:<port>
# [/path] for an in-cluster Service — but dmf-promsd
# (../dmf-promsd/src/dmf_promsd/sd.py _probe_target, read read-only for
# this fix) ALSO legitimately emits a plain host[:port] target for every
# device/VM/service that has no cluster_service (a physical device probed
# over SNMP/ICMP, a bare-metal service reachable at a DNS name — see that
# repo's own tests/test_sd.py fixtures: "dmf.example.com:9100" for a
# service/VM with a metrics port, bare "dmf.example.com" for an SNMP-only
# device). FIX-A2b.5's own strict parser refused the WHOLE overlay read
# the moment ANY such legitimate non-cluster-service row appeared anywhere
# in the SAME probe_success series — a real facility with even one
# monitored device would deadlock every purge attempt permanently. The
# purge overlay read now classifies every row THREE ways
# (_classify_purge_probe_target):
#   joinable  — the cluster-service shape; extract the identity, join it.
#   ignorable — any OTHER shape dmf-promsd legitimately emits (host[:port]
#               [/path]); skip it for the join, but never refuse the read
#               over it — it simply isn't one of THIS purge's own members.
#   malformed — anything that doesn't even look like a valid target at
#               all; refuse the whole read (layer-1 integrity intact).
#
# Anchored with \A/\Z and matched via fullmatch (GATE-A2b.3R2 P2) — never
# bare .match() with a trailing $, which is satisfiable just before an
# embedded or trailing newline and lets anything after it (including
# outright garbage) silently ride along.
_PURGE_PROBE_TARGET_RE = re.compile(
    r"\A(?:[a-zA-Z][a-zA-Z0-9+.-]*://)?"
    r"(?P<cluster_service>[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)"
    r"\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)"
    r"\.svc\.cluster\.local"
    r":(?P<port>[0-9]+)"
    r"(?:/.*)?\Z"
)

# The legitimate NON-cluster-service target shape dmf-promsd emits (see
# _probe_target/_record_address/_extract_address there): a bare hostname/
# IP, optionally followed by :<port>, optionally followed by /<path> — no
# .svc.cluster.local structure at all. Deliberately permissive on the host
# segment (dmf-promsd's own _extract_address can surface an IP, an FQDN,
# or an arbitrary NetBox-recorded name/value string) — over-matching here
# costs nothing, since anything matching this shape was never going to
# resolve to one of THIS purge's own cluster-service members anyway; it is
# only ever used to decide "ignorable", never to extract an identity.
_PURGE_IGNORABLE_TARGET_RE = re.compile(
    r"\A(?:[a-zA-Z][a-zA-Z0-9+.-]*://)?"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?"
    r"(?::[0-9]+)?"
    r"(?:/.*)?\Z"
)


def _classify_purge_probe_target(instance_target: str) -> tuple[str, Optional[str]]:
    """Classify a Prometheus ``instance`` label for the purge overlay read
    (umbrella #347 fix round FIX-A2b.6, GATE-A2b.3R2) — see the module-level
    comment above ``_PURGE_PROBE_TARGET_RE`` for the full rationale.

    Returns ``("joinable", cluster_service)``, ``("ignorable", None)``, or
    ``("malformed", None)``. A joinable-shaped target whose port is outside
    1-65535 (GATE-A2b.3R2 P1, e.g. port 0) is classified ``malformed``, NOT
    ignorable — it is clearly attempting to be a cluster-service identity
    with broken/suspicious data, not a benign unrelated device row.
    """
    if not isinstance(instance_target, str) or not instance_target:
        return "malformed", None
    match = _PURGE_PROBE_TARGET_RE.fullmatch(instance_target)
    if match:
        port = int(match.group("port"))
        if not (1 <= port <= 65535):
            return "malformed", None
        return "joinable", match.group("cluster_service")
    if _PURGE_IGNORABLE_TARGET_RE.fullmatch(instance_target):
        return "ignorable", None
    return "malformed", None


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

# umbrella #347 fix round FIX-A2b.4 (P1-2, GATE-A2b.3): hard cap on pages a
# completeness-verified purge fetch will follow before refusing — generous
# enough for any real facility's residue, small enough that a runaway
# `next` chain fails fast rather than hanging.
_PURGE_FETCH_MAX_PAGES = 20


def _next_page_path(next_url: str) -> str:
    """NetBox's own paginated ``next`` is a full absolute URL;
    ``netbox._request`` wants a path (it composes ``api_url + path``
    itself) — extract path+query."""
    parsed = urllib.parse.urlsplit(next_url)
    return parsed.path + (f"?{parsed.query}" if parsed.query else "")


def _fetch_services_page_complete(
    netbox_url: str, netbox_token: str, ssl_verify: bool, path: str,
) -> list[dict[str, Any]]:
    """Follow NetBox's own ``next`` pagination to exhaustion and verify the
    collected total against the reported ``count`` (umbrella #347 fix round
    FIX-A2b.4, P1-2, GATE-A2b.3) — never a silent partial read.
    ``_fetch_services`` (the plain, single-page read every other consumer —
    list/grouped/clear — keeps using unchanged, out of this round's scope)
    silently truncates to page 1 of any >500-result set; the finalise-purge
    preflight's purgeability decision and the post-job watcher's SOLE
    absence claim (Console Constitution Art. 1) must never be built on that
    truncation.

    Raises ``RuntimeError`` on any incompleteness — the page cap hit with
    ``next`` still set, a collected/reported-count mismatch, or a malformed
    page — never a partial list. Callers map the exception to a fail-closed
    refusal (preflight: 409 ``source-read-incomplete``; the post-job
    re-read: the existing unreachable-read handling, RUN_STATUS_UNKNOWN,
    never RUN_COMPLETE).
    """
    from . import netbox as _netbox

    ctx = _netbox._ssl_context(ssl_verify)
    collected: list[dict[str, Any]] = []
    reported_count: Optional[int] = None
    next_path: Optional[str] = path
    pages = 0
    while next_path:
        if pages >= _PURGE_FETCH_MAX_PAGES:
            raise RuntimeError(
                f"purge fetch: page cap ({_PURGE_FETCH_MAX_PAGES}) exceeded with more pages remaining"
            )
        pages += 1
        result = _netbox._request(netbox_url, netbox_token, next_path, ssl_context=ctx)
        if not isinstance(result, dict):
            raise RuntimeError("purge fetch: malformed page (not an object)")
        page_results = result.get("results")
        if not isinstance(page_results, list):
            raise RuntimeError("purge fetch: malformed page (results not a list)")
        collected.extend(page_results)
        # FIX-A2b.5 (GATE-A2b.3R P1): count is validated on EVERY page, not
        # just captured once from page 1 — a missing/malformed count used
        # to silently SKIP the completeness comparison below entirely
        # (`reported_count is not None and ...`), and a page count that
        # happened to numerically equal the wrong type (True, 1.0) slipped
        # through un-flagged. A plain, non-negative int, required on every
        # page, and identical across every page — any violation is a
        # malformed/inconsistent read, never partially trusted.
        page_count = result.get("count")
        # FIX-A2b.6 (GATE-A2b.3R2 P2): type(x) is int, not isinstance — a
        # custom int subclass (bool included, but also any other) passes
        # isinstance(x, int) while not actually being the plain int the
        # launcher/NetBox contract requires.
        if type(page_count) is not int or page_count < 0:
            raise RuntimeError(f"purge fetch: malformed page (count is not a plain non-negative int: {page_count!r})")
        if reported_count is None:
            reported_count = page_count
        elif page_count != reported_count:
            raise RuntimeError(
                f"purge fetch: inconsistent count across pages ({reported_count} vs {page_count})"
            )
        next_url = result.get("next")
        next_path = _next_page_path(next_url) if next_url else None
    # The completeness comparison is ALWAYS enforced — never skipped just
    # because reported_count ended up None (which, after the per-page
    # validation above, can only happen if the loop never ran at all).
    if reported_count is None or len(collected) != reported_count:
        raise RuntimeError(
            f"purge fetch: incomplete read (collected {len(collected)}, reported count {reported_count})"
        )
    return collected


def _fetch_services_complete(
    netbox_url: str,
    netbox_token: str,
    ssl_verify: bool,
    tenant_slugs: Optional[tuple[str, ...]],
) -> list[dict[str, Any]]:
    """Completeness-verified counterpart to ``_fetch_services`` (umbrella
    #347 fix round FIX-A2b.4, P1-2) — used ONLY by the finalise-purge
    preflight (``resolve_purge_target``) and the post-job residue check
    (``purge_residue_present``). See ``_fetch_services_page_complete``'s
    own docstring for why this is a parallel function rather than a change
    to the shared one every other consumer keeps using.
    """
    base = f"/api/ipam/services/?tag={urllib.parse.quote(CATALOG_TAG)}&limit=500"

    if tenant_slugs is None:
        return _fetch_services_page_complete(netbox_url, netbox_token, ssl_verify, base)

    if not tenant_slugs:
        return []  # scoped, nothing mapped: fail closed to empty

    from . import netbox as _netbox

    ctx = _netbox._ssl_context(ssl_verify)
    device_ids: list[int] = []
    vm_ids: list[int] = []
    for slug in tenant_slugs:
        quoted = urllib.parse.quote(slug)
        result = _netbox._request(
            netbox_url, netbox_token,
            f"/api/dcim/devices/?tenant={quoted}&brief=true&limit=500",
            ssl_context=ctx,
        )
        device_ids.extend(d["id"] for d in result.get("results", []) if d.get("id"))
        result = _netbox._request(
            netbox_url, netbox_token,
            f"/api/virtualization/virtual-machines/?tenant={quoted}&brief=true&limit=500",
            ssl_context=ctx,
        )
        vm_ids.extend(v["id"] for v in result.get("results", []) if v.get("id"))

    if not device_ids and not vm_ids:
        return []

    by_id: dict[Any, dict[str, Any]] = {}
    if device_ids:
        path = base + "".join(f"&device_id={d}" for d in device_ids)
        for svc in _fetch_services_page_complete(netbox_url, netbox_token, ssl_verify, path):
            by_id[svc.get("id")] = svc
    if vm_ids:
        path = base + "".join(f"&virtual_machine_id={v}" for v in vm_ids)
        for svc in _fetch_services_page_complete(netbox_url, netbox_token, ssl_verify, path):
            by_id[svc.get("id")] = svc
    return list(by_id.values())


def resolve_purge_target(
    netbox_url: str,
    read_token: str,
    ssl_verify: bool,
    tenant_slugs: Optional[tuple[str, ...]],
    prometheus_url: str,
    slug: str,
) -> dict[str, Any]:
    """Fresh finalise-purge preflight read (umbrella #347 WO-A2b-2, operator
    ruling 2026-08-02; hardened by fix round FIX-A2b.4 / GATE-A2b.3).

    NEVER a cached snapshot: every call re-reads NetBox (the tagged Service
    members + the standalone workload Tag object) and re-queries Prometheus,
    using the SAME identity-join ``list_workloads_grouped`` uses (ADR-0046
    §3) — preflight truth and the grouped view's own truth can never
    diverge. Fail-closed throughout (Console Constitution Art. 1): a purge
    never proceeds unverified, so any read failure refuses rather than
    guessing.

    The zero-running check is THREE-LAYERED (FIX-A2b.4 P1-1 — GATE-A2b.3
    proved the prior two-state version fails OPEN on an invisible-running
    member: a real running sample present in Prometheus under an identity
    the join simply never matched):
      1. Overlay integrity — the Prometheus fetch itself, AND every row it
         returns, must parse cleanly (a joinable ``cluster_service`` +
         numeric value). A damaged overlay is never partially trusted: one
         malformed row refuses the WHOLE read, it is not silently skipped.
      2. A member whose ``custom_fields.cluster_service`` is non-empty
         CLAIMS a monitoring identity — it must resolve to a CONCLUSIVE
         sample (found in the overlay, running or failing). No sample at
         all for a claimed identity is ``members-unverifiable``, never
         silently "unknown".
      3. A member with NO monitoring identity (cleared at finalise — the
         NORMAL, expected purge candidate) is acceptable-unknown; nothing
         to verify, nothing to refuse on this axis.

    Returns one of:
      {"error": "netbox-unreachable" | "netbox-error"}
      {"error": "source-read-incomplete"}     -- FIX-A2b.4 P1-2: the
                                                  completeness-verified
                                                  member fetch could not
                                                  confirm it saw every page;
                                                  ALSO (FIX-A2b.9, GATE-
                                                  A2b.5R P1) a scoped
                                                  caller's completeness-of-
                                                  authority comparison came
                                                  back neither equal nor a
                                                  clean superset — the
                                                  scoped and unscoped reads
                                                  of the SAME workload
                                                  contradict each other,
                                                  which is a read problem,
                                                  not an authorization one
      {"error": "source-inconsistent"}        -- FIX-A2b.4 P2-2: a member's
                                                  own id violates the
                                                  launcher's frozen
                                                  positive-int contract
      {"error": "not-purgeable"}              -- unassigned slug, or a
                                                  service carrying >1
                                                  workload:* tag naming
                                                  this slug (checked BEFORE
                                                  the slug-match skip,
                                                  FIX-A2b.4 P2-1 — order no
                                                  longer matters)
      {"error": "workload-not-found"}         -- no members AND no Tag
                                                  residue
      {"error": "workload-not-fully-visible"} -- FIX-A2b.8 (GATE-A2b.5
                                                  P1): a scoped caller's
                                                  visible members are a
                                                  strict subset of the
                                                  workload's true (unscoped)
                                                  membership
      {"error": "observability-unavailable"}  -- Prometheus unconfigured,
                                                  unreachable, or its
                                                  overlay was malformed
      {"members": [{"id", "name", "requested_state", "observed_state"}],
       "tag_present": bool}                   -- observed_state is one of
                                                  "running" | "failing" |
                                                  "unverifiable" | "unknown"
    """
    from . import netbox as _netbox

    if slug == "unassigned":
        return {"error": "not-purgeable"}

    try:
        services = _fetch_services_complete(netbox_url, read_token, ssl_verify, tenant_slugs)
    except _netbox.NetboxAPIError as exc:
        logger.warning("media-workloads: purge preflight lookup failed: %s", exc)
        return {"error": "netbox-unreachable"}
    except RuntimeError as exc:
        logger.warning("media-workloads: purge preflight read incomplete: %s", exc)
        return {"error": "source-read-incomplete"}
    except Exception as exc:
        logger.warning("media-workloads: purge preflight unexpected error: %s", exc)
        return {"error": "netbox-error"}

    members: list[dict[str, Any]] = []
    for svc in services:
        names = _tag_names(svc)
        # FIX-A2b.4 P2-1 (GATE-A2b.3): detect a multi-workload-tag service
        # BEFORE the slug-match skip below — _workload_assignment only ever
        # reports the FIRST workload:* tag, so checking status AFTER
        # filtering on member_slug == slug missed this slug entirely
        # whenever it wasn't that first tag. Any service naming this slug
        # among MORE than one workload:* tag makes it not-purgeable,
        # regardless of tag order.
        workload_tags = [n.split(":", 1)[1] for n in names if n.startswith("workload:")]
        if len(workload_tags) > 1 and slug in workload_tags:
            return {"error": "not-purgeable"}
        member_slug, _status = _workload_assignment(names)
        if member_slug != slug:
            continue
        members.append(svc)

    tag_name = f"workload:{slug}"
    try:
        tag_present = _netbox.tag_exists(
            api_url=netbox_url, api_token=read_token, ssl_verify=ssl_verify, name=tag_name,
        )
    except _netbox.NetboxAPIError as exc:
        logger.warning("media-workloads: purge tag lookup failed: %s", exc)
        return {"error": "netbox-unreachable"}
    except Exception as exc:
        logger.warning("media-workloads: purge tag lookup unexpected error: %s", exc)
        return {"error": "netbox-error"}

    # FIX-A2b.7 (operator review 2026-08-03, tenancy escape): a SCOPED
    # caller's empty member list is workload-not-found REGARDLESS of
    # tag_present — NetBox Tag objects carry no tenant field at all, so
    # tag_exists() can never prove a scoped caller actually owns this
    # workload. Without this, a scoped operator targeting another
    # tenant's slug got members=[] (correctly scoped) + tag_present=True
    # (the tag exists, just not in THEIR tenant) and reached the
    # legitimate-looking "tag-only residue" path below — dispatching a
    # purge against out-of-scope residue. tag_exists() is still called
    # unconditionally above (same timing profile either way); its result
    # is simply never consulted here for a scoped caller with no scoped
    # members — existence disclosure (via the response, an error kind, or
    # timing) is itself part of the vulnerability, so this refuses
    # byte-identically to the genuinely-absent case, never a distinct
    # kind. Unscoped callers (tenant_slugs is None — the admin/global
    # case) keep the tag-only path unchanged: that IS the legitimate
    # "residue after a partial purge" case, with no tenant boundary to
    # cross.
    if not members and (tenant_slugs is not None or not tag_present):
        return {"error": "workload-not-found"}

    # FIX-A2b.8 (GATE-A2b.5 P1, umbrella #347), rule replaced by FIX-A2b.9
    # (GATE-A2b.5R): completeness of authority. A SCOPED caller's non-empty
    # ``members`` only proves PARTIAL visibility — the ``workload:<slug>``
    # Tag carries no tenant field at all, so a caller who can see SOME
    # tagged services can still dispatch a purge whose AWX extra_vars
    # (purge_expected_service_ids) cover only their visible subset, while
    # the launcher's global Tag deletion removes every tenant's grouping
    # regardless. Re-resolve membership UNSCOPED — strictly an internal
    # comparison, never returned, never logged with ids.
    #
    # FIX-A2b.9: membership for THIS comparison is "the slug appears among
    # the service's workload:* tags, any position" — the same test the
    # not-purgeable multi-tag check above already applies — computed
    # identically for both sides, NOT ``_workload_assignment()``'s
    # first-tag-only return (GATE-A2b.5R P1: an out-of-scope service
    # carrying ``workload:other`` THEN ``workload:studio-a`` was silently
    # dropped from the true set, since ``_workload_assignment`` only ever
    # reports the first tag). And the two sets must be EXACTLY EQUAL, not
    # merely scoped-is-subset-of-true: a strict superset (true_ids has
    # members scoped_ids lacks) is the ordinary straddle — an authorization
    # refusal. Any OTHER inequality (scoped_ids has members true_ids
    # lacks, or the two are simply disjoint) is not an authorization
    # question at all — it is two reads of the same workload contradicting
    # each other, which fails closed as a READ problem instead (GATE-A2b.5R
    # P1: an inverse/empty unscoped read against a non-empty scoped read
    # satisfied the old subset test and dispatched).
    if tenant_slugs is not None and members:
        try:
            all_services = _fetch_services_complete(netbox_url, read_token, ssl_verify, None)
        except _netbox.NetboxAPIError as exc:
            logger.warning("media-workloads: purge preflight authority-scope lookup failed: %s", exc)
            return {"error": "netbox-unreachable"}
        except RuntimeError as exc:
            logger.warning("media-workloads: purge preflight authority-scope read incomplete: %s", exc)
            return {"error": "source-read-incomplete"}
        except Exception as exc:
            logger.warning("media-workloads: purge preflight authority-scope unexpected error: %s", exc)
            return {"error": "netbox-error"}

        def _tagged_with(svc: dict[str, Any]) -> bool:
            tags = [n.split(":", 1)[1] for n in _tag_names(svc) if n.startswith("workload:")]
            return slug in tags

        scoped_ids = {svc.get("id") for svc in services if _tagged_with(svc)}
        true_ids = {svc.get("id") for svc in all_services if _tagged_with(svc)}
        if scoped_ids != true_ids:
            if true_ids > scoped_ids:
                logger.warning(
                    "media-workloads: purge preflight refused — scoped caller's visibility "
                    "of a workload is incomplete relative to its true membership",
                )
                return {"error": "workload-not-fully-visible"}
            logger.warning(
                "media-workloads: purge preflight refused — scoped and unscoped membership "
                "reads for a workload contradict each other",
            )
            return {"error": "source-read-incomplete"}

    if not prometheus_url:
        return {"error": "observability-unavailable"}
    try:
        from . import prometheus as _prometheus
        rows = _prometheus.query(url=prometheus_url, expr='probe_success{job="netbox-probe"}')
    except Exception as exc:
        logger.warning("media-workloads: purge observed-state overlay unreachable: %s", exc)
        return {"error": "observability-unavailable"}

    # Layer 1 — overlay integrity (FIX-A2b.4 P1-1, hardened FIX-A2b.5/
    # FIX-A2b.6 GATE-A2b.3R/R2): unlike _observed_by_identity/
    # list_workloads_grouped's own join (which silently `continue`s past a
    # row it can't parse), a purge preflight must never partially trust a
    # damaged overlay — a genuinely MALFORMED row (never a legitimate
    # non-cluster-service target dmf-promsd itself would emit — see
    # _classify_purge_probe_target) refuses the WHOLE read. A joinable
    # row's numeric value must also be present and FINITE (never NaN/inf
    # silently feeding a lifecycle classification).
    observed: dict[str, float] = {}
    for row in rows or []:
        metric = row.get("metric") if isinstance(row, dict) else None
        if not isinstance(metric, dict):
            return {"error": "observability-unavailable"}
        kind, cluster_svc = _classify_purge_probe_target(metric.get("instance", ""))
        if kind == "malformed":
            return {"error": "observability-unavailable"}
        if kind == "ignorable":
            # A legitimate dmf-promsd target this purge simply has no
            # member under (a monitored device/VM/non-cluster service) —
            # skip the join, never refuse the read over it.
            continue
        try:
            value = float(row["value"][1])
        except (KeyError, IndexError, TypeError, ValueError):
            return {"error": "observability-unavailable"}
        if not math.isfinite(value):
            return {"error": "observability-unavailable"}
        observed[cluster_svc] = min(observed.get(cluster_svc, 1.0), value)

    result_members = []
    for svc in members:
        names = _tag_names(svc)
        svc_id = svc.get("id")
        # FIX-A2b.4 P2-2 (GATE-A2b.3): the launcher's frozen contract
        # (playbooks/finalise-purge.yml) asserts purge_expected_service_ids
        # are plain positive ints — a NetBox id surfacing as a numeric
        # STRING (or any other non-int shape) means the source read is
        # inconsistent with what the launcher will accept; refuse before
        # any operation is created rather than dispatch a doomed launch.
        # FIX-A2b.6 (GATE-A2b.3R2 P2): type(x) is int, not isinstance —
        # same custom-int-subclass hole as the count check above.
        if type(svc_id) is not int or svc_id <= 0:
            logger.warning(
                "media-workloads: purge preflight found a non-positive-int service id: %r", svc_id,
            )
            return {"error": "source-inconsistent"}
        cf = svc.get("custom_fields")
        cs = cf.get("cluster_service") if isinstance(cf, dict) else None
        claims_observability = isinstance(cs, str) and bool(cs)
        if claims_observability:
            # Layer 2 — a member that still declares a monitoring identity
            # must resolve to a CONCLUSIVE sample; no sample found for a
            # claimed identity is unverifiable, never silently "unknown"
            # (the exact invisible-running gap GATE-A2b.3 proved).
            if cs in observed:
                observed_state = "running" if observed[cs] >= 1.0 else "failing"
            else:
                observed_state = "unverifiable"
        else:
            # Layer 3 — no monitoring identity left (the normal,
            # fully-finalised purge candidate): acceptable-unknown.
            observed_state = "unknown"
        result_members.append({
            "id": svc_id,
            "name": svc.get("name"),
            "requested_state": _tag_suffix(names, "lifecycle") or "unknown",
            "observed_state": observed_state,
        })
    return {"members": result_members, "tag_present": tag_present}


def purge_residue_present(
    netbox_url: str,
    read_token: str,
    ssl_verify: bool,
    slug: str,
) -> bool:
    """Fresh, unscoped existence check (umbrella #347): True iff any Service
    still carries ``workload:<slug>`` OR the ``workload:<slug>`` Tag object
    itself still exists.

    The console's own post-job absence claim (Console Constitution Art. 1)
    — called by the finalise-purge job watcher after AWX reports job
    success, NEVER derived from the bare job status alone. Unscoped
    (``tenant_slugs=None``) deliberately: this is a completion check, not a
    user-facing listing, and the workload was already gate-approved
    tenant-scoped at dispatch time — it must see every tenant's records to
    confirm true absence. Exceptions propagate (NetboxAPIError AND, since
    FIX-A2b.4 P1-2, RuntimeError from an incomplete paginated read included)
    — the watcher itself decides how to fail closed on an unreachable/
    incomplete re-read (RUN_STATUS_UNKNOWN, never RUN_COMPLETE).

    Uses the SAME completeness-verified fetch as the preflight
    (``_fetch_services_complete``), not the plain ``_fetch_services`` —
    GATE-A2b.3 proved a partial page-1-only read here would silently
    report absence while a surviving member sat on a later page, false-
    greening the operation's own ``purge_verified_at`` claim.
    """
    from . import netbox as _netbox

    services = _fetch_services_complete(netbox_url, read_token, ssl_verify, None)
    tag_name = f"workload:{slug}"
    if any(tag_name in _tag_names(s) for s in services):
        return True
    return _netbox.tag_exists(api_url=netbox_url, api_token=read_token, ssl_verify=ssl_verify, name=tag_name)


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
