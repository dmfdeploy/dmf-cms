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
  node by its ``nodename`` label, FALLING BACK to the NetBox site's
  ``dmf_architecture`` custom field (umbrella #339 item 2: on the live env
  the uname join delivers nothing, and the page rendered its cannot-be-read
  state for a fact NetBox was holding all along). The two sources speak
  different dialects — uname says ``aarch64``, dmf-infra's born-inventory
  role stamps ``arm64`` — and the site field is a facility-level
  declaration rather than a per-node measurement, so each node also carries
  ``arch_source`` and the page says "from NetBox" when that is what it is.
  Still an optional enrichment either way: a node with neither source shows
  ``arch: null``, it never fails the whole node list (unlike a missing
  ``kube_node_info`` label, which is a malformed row).
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
* Platform services: presence + as-deployed versions, and real ingress
  URLs — see ``read_platform_services``. Both facts are keyed off the
  console's own ``AppContract`` (``config/app-contracts.yaml``) — the same 7
  services the retired Workspace "Infrastructure Services" table listed from
  that static config, whose ``deep_links.primary`` was always a fixed
  ``https://<key>.dmf.example.com/`` placeholder, never resolved against the
  real cluster.

  These are TWO independent reads over one shared fetch, and keeping them
  independent is the whole point (umbrella #339 item 1). PRESENCE AND
  VERSION come from ``kube_pod_container_info``, looked up in one namespace
  (see the next paragraph for which) and narrowed to that service's own
  image by the ``image_contains`` token its ``cluster:`` block declares —
  without that narrowing a service's Version column would list its
  neighbours' images as its own. ACCESS comes from
  ``kube_ingress_path`` via the ``<key>.`` host-prefix convention the
  placeholder domains themselves encode. The page shipped with presence
  inferred from the ingress alone, so every service that deliberately has no
  ingress (AWX, explicitly) was reported "not found in this cluster" while
  its PVCs were listed as present two sections below — the overclaim class.
  An ingress is an access route, never evidence of existence.

  Which namespace: the matched ingress's own when there is one, the
  contract's declared one otherwise. The ingress is preferred because it is
  read from the cluster and so cannot go stale, and because it keeps the
  page from ever saying "here is the URL" and "nothing is running" in the
  same row. The contract's declared namespace is what makes the ingressless
  services readable at all; it duplicates dmf-infra's role defaults and can
  drift, so a drifted value surfaces as "no matching pods in cluster
  metrics" — a statement about what was checked, which an operator can
  falsify, rather than a claim about the cluster.
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
    # 'node' (node_uname_info, measured on the node itself) | 'netbox' (the
    # site's dmf_architecture, a facility-level declaration) | None when arch
    # is None. Never inferred from the value: 'arm64' and 'aarch64' are the
    # same machine described by two sources, and only the source says which.
    arch_source: str | None


def _read_nodes(prom_url: str, site_architecture: str | None) -> list[NodeFact]:
    info_rows = prometheus.query(url=prom_url, expr="kube_node_info")
    if not info_rows:
        # Empty is treated as "KSM unscraped", not "nodeless cluster".
        # That inference rests on kube-state-metrics running with its
        # DEFAULT collectors, which is how dmf-infra's Prometheus values
        # configure it — a config-derived expectation, not a universal
        # fact about Kubernetes. If a deployment restricts KSM collectors,
        # this degrades to the honest unreadable reason, which is the
        # correct outcome anyway.
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
        # Measured beats declared: the site field describes the facility, so
        # it only ever fills a node the uname join left blank — it must never
        # overwrite a node that reported its own machine type.
        arch = arch_by_node.get(name)
        arch_source: str | None = "node" if arch else None
        if not arch and site_architecture:
            arch, arch_source = site_architecture, "netbox"
        nodes.append(
            NodeFact(
                name=name,
                kubelet_version=kubelet_version,
                arch=arch,
                arch_source=arch_source,
            )
        )
    nodes.sort(key=lambda n: n.name)
    return nodes


def read_nodes(prom_url: str, site_architecture: str | None = None) -> tuple[list[NodeFact], str]:
    """Returns ``(nodes, reason)``. ``reason == ""`` on a live read (the
    list itself may be non-empty only — see ``_read_nodes``, an empty
    result there is already collapsed to the refusal below).

    ``site_architecture`` is the NetBox fallback for the arch column and is
    read on the NetBox seam, not this one: an unreachable NetBox hands None
    here and the column degrades to cannot-be-read, exactly as it did before
    the fallback existed. A Prometheus failure still fails the whole node
    list — the fallback fills one field, it does not stand in for a node
    inventory nobody could read."""
    try:
        return _read_nodes(prom_url, site_architecture), ""
    except Exception:
        return [], "nodes-unreadable"


# ---------------------------------------------------------------------------
# Platform services: presence + version from container images, access URL
# from ingress (two independent facts over one fetch — see module docstring
# for why they must not be collapsed into one)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PlatformServiceSpec:
    """One expected service, as the console's own contract declares it.
    ``namespace``/``image_contains`` are the ``cluster:`` block; both None
    means the contract declares no cluster location, so presence is never
    checked and never claimed either way."""

    key: str
    display_name: str
    namespace: str | None
    image_contains: str | None


@dataclass(frozen=True)
class PlatformServiceFact:
    key: str
    display_name: str
    # The namespace that WAS searched, so the page can say what it checked.
    # None => nothing was checked, because nothing was declared.
    namespace: str | None
    image_contains: str | None
    url: str | None  # ingress URL when the cluster has one; access, not existence
    # Empty => no container matched. More than one is ordinary, not an
    # anomaly: AWX alone ships a web image and an execution-environment
    # image, and a rollout shows two tags of the same one. The page lists
    # what it found rather than picking a winner.
    images: tuple[str, ...]


def _read_platform_services(
    prom_url: str, apps: list[PlatformServiceSpec]
) -> list[PlatformServiceFact]:
    container_rows = prometheus.query(url=prom_url, expr="kube_pod_container_info")
    if not container_rows:
        # THE liveness sentinel for this section now that presence is read
        # here: a cluster running no containers at all is not a state any DMF
        # env can be in, so empty means unscraped. Config-derived (KSM default
        # collectors per dmf-infra's Prometheus values), not live-probed.
        raise RuntimeError("empty kube_pod_container_info")

    # Ingress is OPTIONAL now, and that is the fix: an env whose platform
    # services deliberately expose no ingress used to collapse this whole
    # section (or report every service missing). Access is simply absent for
    # those services; presence below is read from containers regardless.
    path_rows = prometheus.query(url=prom_url, expr="kube_ingress_path") or []
    tls_rows = prometheus.query(url=prom_url, expr="kube_ingress_tls") or []

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
    for spec in apps:
        match = by_prefix.get(spec.key)
        url = None
        if match is not None:
            scheme = "https" if match["host"] in tls_hosts else "http"
            url = f"{scheme}://{match['host']}{match['path']}"

        # A matched ingress pins the namespace better than the contract can
        # (it is read from the cluster, so it cannot drift), and it stops the
        # page ever pairing a live URL with "nothing is running here".
        namespace = match["namespace"] if match is not None else spec.namespace
        images: tuple[str, ...] = ()
        if namespace is not None:
            candidates = images_by_namespace.get(namespace, set())
            if spec.image_contains:
                candidates = {i for i in candidates if spec.image_contains in i}
            images = tuple(sorted(candidates))

        out.append(
            PlatformServiceFact(
                key=spec.key,
                display_name=spec.display_name,
                namespace=namespace,
                image_contains=spec.image_contains,
                url=url,
                images=images,
            )
        )
    return out


def read_platform_services(
    prom_url: str, apps: list[PlatformServiceSpec]
) -> tuple[list[PlatformServiceFact], str]:
    """Returns ``(services, reason)`` — one row per ``apps`` entry, always
    (a service nothing matched still gets a row, never dropped silently).

    An empty ``images`` tuple means "no container in the namespace we
    searched matched this service", which is what the page says. It does NOT
    mean the service is absent from the cluster, and no caller may render it
    that way: the search is only as good as the contract's declared
    namespace/token. ``reason`` is non-empty only when the underlying
    Prometheus reads themselves failed or returned malformed data, per the
    module's fail-soft contract."""
    try:
        return _read_platform_services(prom_url, apps), ""
    except Exception:
        return [
            PlatformServiceFact(
                key=spec.key,
                display_name=spec.display_name,
                namespace=spec.namespace,
                image_contains=spec.image_contains,
                url=None,
                images=(),
            )
            for spec in apps
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
    empty = {"slug": None, "name": None, "architecture": None}
    if not netbox_configured:
        return dict(empty), "netbox-not-configured"
    try:
        # brief=False: the brief serializer drops custom_fields, and
        # dmf_architecture (the node arch fallback) lives there.
        sites = netbox.list_sites(
            api_url=netbox_api_url,
            api_token=netbox_api_token,
            ssl_verify=netbox_ssl_verify,
            brief=False,
        )
    except Exception:
        return dict(empty), "netbox-unreadable"
    if len(sites) != 1:
        return dict(empty), "site-ambiguous"
    site = sites[0]
    slug = site.get("slug")
    name = site.get("name")
    if not slug or not name:
        return dict(empty), "netbox-unreadable"
    # A site with no dmf_architecture stamped is an ordinary legacy env, not a
    # broken read (the born-inventory role skips the patch when the env has no
    # architecture declared) — identity still resolves, the fallback is just
    # unavailable.
    custom_fields = site.get("custom_fields")
    architecture = custom_fields.get("dmf_architecture") if isinstance(custom_fields, dict) else None
    if not isinstance(architecture, str) or not architecture.strip():
        architecture = None
    return {"slug": slug, "name": name, "architecture": architecture}, ""


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
    apps: list[PlatformServiceSpec],
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
        nodes, nodes_reason = read_nodes(prometheus_url, site.get("architecture"))
        nodes_payload = {
            "reason": nodes_reason,
            "items": [
                {
                    "name": n.name,
                    "kubelet_version": n.kubelet_version,
                    "arch": n.arch,
                    "arch_source": n.arch_source,
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
                    "image_contains": s.image_contains,
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
