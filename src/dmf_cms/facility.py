"""Facility Detail — read/derive module (S1, dmfdeploy/dmfdeploy#285).

The Facility Detail page answers "what is actually running on the one
facility this console operates" without a Kubernetes client — same two seams
as the rest of the console: ``prometheus.query()`` (kube-state-metrics +
node-exporter series) and NetBox. This module owns the read+derive logic;
``main.py`` only wires ``Settings`` into it and returns the result as JSON.

Fact -> source map (see the WHAT-THE-PAGE-MUST-SHOW list in the tracking
plan):

* Node identity/version  — ``kube_node_info`` (``node``, ``kubelet_version``).
* Node architecture      — ``node_uname_info`` (``machine``), joined to a
  node by its ``nodename`` label. An optional enrichment: a node missing
  from this join shows ``arch: null``, it never fails the whole node list
  (unlike a missing ``kube_node_info`` label, which is a malformed row).
* Node instance class    — DELIBERATELY ABSENT (S1 decision, umbrella #285).
  No default kube-state-metrics series carries a cloud flavour like
  "CAX21", and NetBox does not hold one either: dmf-infra's born-inventory
  role registers each node as a virtual-machine with NO custom_fields at
  all (verified against k3s-lab-bootstrap/roles/common/dmf-born-inventory),
  and the only custom fields it writes anywhere are on the SITE object
  (dmf_env_id, dmf_env_label, dmf_provider, dmf_architecture). Rather than
  render a field that can only ever read back empty, this page states the
  node facts it can actually source. Stamping an instance-type field in
  dmf-infra would make it sourceable; that is an infra change, not a
  console one.
* Platform services + as-deployed versions, and real ingress URLs — ONE
  combined read, see ``read_platform_services``. Both facts are keyed off
  the console's own ``AppContract`` (``config/app-contracts.yaml``) — the
  same 7 services the retired Workspace "Infrastructure Services" table
  listed from that static config, whose ``deep_links.primary`` was always a
  fixed ``https://<key>.dmf.example.com/`` placeholder, never resolved
  against the real cluster. This module keeps the ``<key>.`` host-prefix
  convention the placeholder itself encodes as the join key against real
  ``kube_ingress_path`` rows, and reuses the ingress's own ``namespace`` to
  look up that service's as-deployed image(s) via
  ``kube_pod_container_info``. Namespace can never be assumed a priori (awx/
  forgejo/netbox happen to match their app key; authentik and the zot
  registry do not), so the ingress host is the only honest join key
  available without hand-maintaining a namespace table here that would
  duplicate dmf-infra's own role defaults and drift stale.
* Storage                — ``kube_persistentvolumeclaim_info``
  (``storageclass``) joined to
  ``kube_persistentvolumeclaim_resource_requests_storage_bytes`` by
  (namespace, persistentvolumeclaim). A PVC present in the first series but
  absent from the second reports ``requested_bytes: null`` — never a
  fabricated 0.
* Workload count          — NOT this module. The page reuses the existing
  media-workloads inventory (``/api/media-workloads/grouped``) directly on
  the frontend; re-deriving it here would be a second, divergent count.
* Capacity (allocatable vs requests committed) — ``capacity.read_node_supply``
  verbatim; this module does not re-implement that arithmetic or its
  tolerant parsers, only formats the result. The two figures are surfaced
  under exactly those names — "allocatable" and "requests committed" —
  never "used"/"free": requests-committed is a scheduler bound, not a
  measurement of actual utilisation.

Fail-soft contract: every ``read_*``/``enrich_*`` function here follows
``capacity.read_node_supply``'s two-tier shape — an inner helper that
raises freely (direct dict indexing, no ``.get()`` guards) on any malformed
row, and an outer wrapper that catches every exception (transport failure,
KeyError, TypeError, ...) and returns an explicit reason token instead. No
data, or data that doesn't parse, is ever silently treated as "empty" or
"zero" — see each function's own docstring for what counts as a
legitimate empty result (a live cluster's own invariants) versus a
collapse-to-refusal.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from . import capacity
from . import netbox
from . import prometheus

# Kubernetes' own bookkeeping namespaces are never "the DMF platform" under
# any reading of that phrase — excluded from storage listings so the page
# isn't dominated by kube-system PVCs (there usually are none, but the
# convention costs nothing and matches the same three names main.py's own
# media-workloads seams already treat as never-catalog).
_K8S_SYSTEM_NAMESPACES = frozenset({"kube-system", "kube-node-lease", "kube-public"})


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class NodeFact:
    name: str
    kubelet_version: str
    arch: str | None


def _read_nodes(prom_url: str) -> list[NodeFact]:
    info_rows = prometheus.query(url=prom_url, expr="kube_node_info")
    if not info_rows:
        # A live cluster always has at least one node reporting via KSM
        # (capacity.py's own reasoning for kube_pod_info) — empty means
        # KSM itself is unscraped, not a genuinely nodeless cluster.
        raise RuntimeError("empty kube_node_info")

    # node_uname_info is an OPTIONAL enrichment join (arch), not a liveness
    # sentinel: node-exporter can legitimately be down/unscraped on a subset
    # of nodes while KSM itself is fine cluster-wide, so an empty or
    # partial result here degrades individual nodes' `arch` to None rather
    # than failing the whole node list.
    uname_rows = prometheus.query(url=prom_url, expr="node_uname_info")
    arch_by_node: dict[str, str] = {}
    for row in uname_rows or []:
        metric = row.get("metric") or {}
        node = metric.get("nodename")
        machine = metric.get("machine")
        if isinstance(node, str) and isinstance(machine, str) and node and machine:
            arch_by_node[node] = machine

    nodes: list[NodeFact] = []
    for row in info_rows:
        metric = row["metric"]
        name = metric["node"]  # KeyError -> malformed row, whole read fails
        kubelet_version = metric["kubelet_version"]  # KeyError -> malformed row
        nodes.append(
            NodeFact(
                name=name,
                kubelet_version=kubelet_version,
                arch=arch_by_node.get(name),
            )
        )
    nodes.sort(key=lambda n: n.name)
    return nodes


def read_nodes(prom_url: str) -> tuple[list[NodeFact], str]:
    """Returns ``(nodes, reason)``. ``reason == ""`` on a live read (the
    list itself may be non-empty only — see ``_read_nodes``, an empty
    result there is already collapsed to the refusal below)."""
    try:
        return _read_nodes(prom_url), ""
    except Exception:
        return [], "nodes-unreadable"


# ---------------------------------------------------------------------------
# Platform services + real ingress URLs (one combined read — see module
# docstring for why these two facts share a join)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PlatformServiceFact:
    key: str
    display_name: str
    namespace: str | None  # None => no matching ingress found in the cluster
    url: str | None
    images: tuple[str, ...]  # >1 entries legitimately means a rollout in progress


def _read_platform_services(prom_url: str, apps: list[tuple[str, str]]) -> list[PlatformServiceFact]:
    path_rows = prometheus.query(url=prom_url, expr="kube_ingress_path")
    if not path_rows:
        # Every real DMF env exposes multiple ingresses (netbox, awx,
        # forgejo, the console itself, ...) — empty means the series isn't
        # being scraped/emitted, not a genuinely ingress-free cluster.
        raise RuntimeError("empty kube_ingress_path")
    tls_rows = prometheus.query(url=prom_url, expr="kube_ingress_tls") or []
    container_rows = prometheus.query(url=prom_url, expr="kube_pod_container_info")
    if not container_rows:
        raise RuntimeError("empty kube_pod_container_info")

    parsed_ingress = sorted(
        (
            {
                "namespace": row["metric"]["namespace"],
                "ingress": row["metric"]["ingress"],
                "host": row["metric"]["host"],
                "path": row["metric"].get("path") or "/",
            }
            for row in path_rows
        ),
        key=lambda r: (r["host"], r["namespace"], r["ingress"], r["path"]),
    )
    tls_hosts = {
        row["metric"]["tls_host"]
        for row in tls_rows
        if isinstance(row.get("metric"), dict) and row["metric"].get("tls_host")
    }

    # First (deterministically sorted) match per host-prefix wins — see
    # module docstring: the prefix before the first "." is the app key by
    # the same convention app-contracts.yaml's placeholder domains encode.
    by_prefix: dict[str, dict] = {}
    for row in parsed_ingress:
        prefix = row["host"].split(".", 1)[0]
        by_prefix.setdefault(prefix, row)

    images_by_namespace: dict[str, set[str]] = {}
    for row in container_rows:
        metric = row["metric"]
        namespace = metric["namespace"]  # KeyError -> malformed row, whole read fails
        image = metric.get("image_spec") or metric["image"]
        images_by_namespace.setdefault(namespace, set()).add(image)

    out: list[PlatformServiceFact] = []
    for key, display_name in apps:
        match = by_prefix.get(key)
        if match is None:
            out.append(
                PlatformServiceFact(key=key, display_name=display_name, namespace=None, url=None, images=())
            )
            continue
        scheme = "https" if match["host"] in tls_hosts else "http"
        url = f"{scheme}://{match['host']}{match['path']}"
        images = tuple(sorted(images_by_namespace.get(match["namespace"], ())))
        out.append(
            PlatformServiceFact(
                key=key, display_name=display_name, namespace=match["namespace"], url=url, images=images
            )
        )
    return out


def read_platform_services(prom_url: str, apps: list[tuple[str, str]]) -> tuple[list[PlatformServiceFact], str]:
    """Returns ``(services, reason)`` — one row per ``apps`` entry, always
    (an app absent from the cluster's ingress objects still gets a row with
    ``namespace``/``url``/``images`` all empty — a legitimate "not found",
    never dropped silently). ``reason`` is non-empty only when the
    underlying Prometheus reads themselves failed or returned malformed
    data, per the module's fail-soft contract."""
    try:
        return _read_platform_services(prom_url, apps), ""
    except Exception:
        return [
            PlatformServiceFact(key=key, display_name=display_name, namespace=None, url=None, images=())
            for key, display_name in apps
        ], "platform-services-unreadable"


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VolumeFact:
    namespace: str
    name: str
    storageclass: str | None
    requested_bytes: int | None  # None => the usage-by-request series had no matching row


def _read_storage(prom_url: str) -> list[VolumeFact]:
    info_rows = prometheus.query(url=prom_url, expr="kube_persistentvolumeclaim_info")
    if not info_rows:
        # A legitimately volumeless cluster is a real possibility here
        # (unlike nodes/ingresses) — but this module cannot distinguish
        # "no PVCs" from "KSM unscraped" from an empty result alone, and
        # the fail-soft contract says never guess in the optimistic
        # direction. Collapsing to the refusal is the conservative call;
        # revisit if a genuinely volumeless env turns out to need a
        # distinct "verified empty" state.
        raise RuntimeError("empty kube_persistentvolumeclaim_info")

    request_rows = prometheus.query(url=prom_url, expr="kube_persistentvolumeclaim_resource_requests_storage_bytes")
    bytes_by_pvc: dict[tuple[str, str], int] = {}
    for row in request_rows or []:
        metric = row["metric"]
        key = (metric["namespace"], metric["persistentvolumeclaim"])
        value = float(row["value"][1])
        bytes_by_pvc[key] = int(value)

    volumes: list[VolumeFact] = []
    for row in info_rows:
        metric = row["metric"]
        namespace = metric["namespace"]
        if namespace in _K8S_SYSTEM_NAMESPACES:
            continue
        name = metric["persistentvolumeclaim"]
        storageclass = metric.get("storageclass") or None
        volumes.append(
            VolumeFact(
                namespace=namespace,
                name=name,
                storageclass=storageclass,
                requested_bytes=bytes_by_pvc.get((namespace, name)),
            )
        )
    volumes.sort(key=lambda v: (v.namespace, v.name))
    return volumes


def read_storage(prom_url: str) -> tuple[list[VolumeFact], str]:
    try:
        return _read_storage(prom_url), ""
    except Exception:
        return [], "storage-unreadable"


# ---------------------------------------------------------------------------
# Site identity (NetBox) — single-facility model, mirrors main.py's
# ``_resolve_topology_seam`` resolution rule: exactly one NetBox site is the
# only legal shape.
# ---------------------------------------------------------------------------


def read_site_identity(
    *,
    netbox_configured: bool,
    netbox_api_url: str,
    netbox_api_token: str,
    netbox_ssl_verify: bool,
) -> tuple[dict, str]:
    if not netbox_configured:
        return {"slug": None, "name": None}, "netbox-not-configured"
    try:
        sites = netbox.list_sites(api_url=netbox_api_url, api_token=netbox_api_token, ssl_verify=netbox_ssl_verify)
    except Exception:
        return {"slug": None, "name": None}, "netbox-unreadable"
    if len(sites) != 1:
        return {"slug": None, "name": None}, "site-ambiguous"
    site = sites[0]
    slug = site.get("slug")
    name = site.get("name")
    if not slug or not name:
        return {"slug": None, "name": None}, "netbox-unreadable"
    return {"slug": slug, "name": name}, ""


# ---------------------------------------------------------------------------
# Orchestrator — assembles the full page payload. Never raises: every
# sub-read above already collapses its own exceptions to a reason token.
# ---------------------------------------------------------------------------


def _capacity_payload(prom_url: str) -> dict:
    supply = capacity.read_node_supply(prom_url=prom_url)
    if isinstance(supply, str):
        # 'multi-node-unsupported' | 'budget-unavailable' — both are
        # already fail-soft refusal tokens from capacity.py; used verbatim
        # as this section's reason (never re-interpreted, per capacity.py
        # being the sole authority on this arithmetic).
        return {
            "reason": supply,
            "node_name": None,
            "allocatable_cpu_m": None,
            "allocatable_mem_b": None,
            "requests_committed_cpu_m": None,
            "requests_committed_mem_b": None,
            "pod_count": None,
        }
    return {
        "reason": "",
        "node_name": supply.node_name,
        "allocatable_cpu_m": supply.alloc_cpu_m,
        "allocatable_mem_b": supply.alloc_mem_b,
        "requests_committed_cpu_m": supply.requested_cpu_m,
        "requests_committed_mem_b": supply.requested_mem_b,
        "pod_count": supply.pod_count,
    }


def build_detail_payload(
    *,
    prometheus_configured: bool,
    prometheus_url: str,
    netbox_configured: bool,
    netbox_api_url: str,
    netbox_api_token: str,
    netbox_ssl_verify: bool,
    apps: list[tuple[str, str]],
) -> dict:
    """Assemble the whole Facility Detail payload. ``main.py`` wraps the
    result in a 200 JSONResponse unconditionally — this function itself
    never raises and never fabricates a section it couldn't read."""
    site, site_reason = read_site_identity(
        netbox_configured=netbox_configured,
        netbox_api_url=netbox_api_url,
        netbox_api_token=netbox_api_token,
        netbox_ssl_verify=netbox_ssl_verify,
    )

    if not prometheus_configured:
        nodes_payload = {"reason": "prometheus-not-configured", "items": []}
        platform_services_payload = {"reason": "prometheus-not-configured", "items": []}
        storage_payload = {"reason": "prometheus-not-configured", "items": []}
        capacity_payload = {
            "reason": "prometheus-not-configured",
            "node_name": None,
            "allocatable_cpu_m": None,
            "allocatable_mem_b": None,
            "requests_committed_cpu_m": None,
            "requests_committed_mem_b": None,
            "pod_count": None,
        }
    else:
        nodes, nodes_reason = read_nodes(prometheus_url)
        nodes_payload = {
            "reason": nodes_reason,
            "items": [
                {
                    "name": n.name,
                    "kubelet_version": n.kubelet_version,
                    "arch": n.arch,
                }
                for n in nodes
            ],
        }

        services, services_reason = read_platform_services(prometheus_url, apps)
        platform_services_payload = {
            "reason": services_reason,
            "items": [
                {
                    "key": s.key,
                    "display_name": s.display_name,
                    "namespace": s.namespace,
                    "url": s.url,
                    "images": list(s.images),
                }
                for s in services
            ],
        }

        volumes, storage_reason = read_storage(prometheus_url)
        storage_payload = {
            "reason": storage_reason,
            "items": [
                {
                    "namespace": v.namespace,
                    "name": v.name,
                    "storageclass": v.storageclass,
                    "requested_bytes": v.requested_bytes,
                }
                for v in volumes
            ],
        }

        capacity_payload = _capacity_payload(prometheus_url)

    return {
        "prometheus_configured": prometheus_configured,
        "netbox_configured": netbox_configured,
        "site": {**site, "reason": site_reason},
        "nodes": nodes_payload,
        "platform_services": platform_services_payload,
        "storage": storage_payload,
        "capacity": capacity_payload,
    }
