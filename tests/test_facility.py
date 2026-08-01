"""Facility Detail — read/derive logic + endpoint fail-soft contract (S1, #285).

Two layers, mirroring test_capacity.py (pure) + test_workspace_health.py
(endpoint):

* Pure derive-function tests exercise ``dmf_cms.facility`` directly, with
  ``prometheus.query``/``netbox.list_sites``/``netbox._request`` mocked via
  monkeypatch — no network.
* Endpoint tests hit the three ``/api/facility/*`` routes through
  ``TestClient`` and assert the fail-soft contract: unconfigured,
  unreachable, and malformed-series states are all 200-with-reason, never a
  raw 500.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from dmf_cms import facility
from dmf_cms import netbox as netbox_module
from dmf_cms import prometheus as prometheus_module
from dmf_cms.main import create_app
from dmf_cms.settings import NetboxSettings, PrometheusSettings, Settings

MI = 1024**2
GI = 1024**3


def _row(value, **labels):
    return {"metric": labels, "value": [0, str(value)]}


def _exact_dispatcher(expr_to_rows):
    """Same discipline as test_capacity.py's dispatcher: an EXACT expr match
    only, so a wrong/missing PromQL string fails loudly instead of silently
    matching the wrong fixture."""

    def fake_query(*, url, expr):
        if expr not in expr_to_rows:
            raise AssertionError(f"unexpected PromQL expr in test: {expr!r}")
        return expr_to_rows[expr]

    return fake_query


def _supply_routes(node="n1"):
    """The exact PromQL expr strings capacity.read_node_supply sends, wired
    to a minimal single-pod fixture — reused so facility's capacity section
    can be exercised end to end without re-deriving capacity.py's own
    contract (per the WO instruction: read capacity.py, reuse it)."""
    return {
        'kube_node_status_allocatable{resource="cpu",unit="core"}': [_row("2", node=node)],
        'kube_node_status_allocatable{resource="memory",unit="byte"}': [_row(4 * GI, node=node)],
        f'kube_pod_info{{node="{node}"}}': [_row(1, namespace="netbox", pod="netbox-0")],
        'kube_pod_status_phase{phase=~"Running|Pending"} == 1': [
            _row(1, namespace="netbox", pod="netbox-0")
        ],
        f'sum by (namespace,pod) (kube_pod_container_resource_requests{{node="{node}",resource="cpu"}})': [
            _row("0.5", namespace="netbox", pod="netbox-0")
        ],
        f'sum by (namespace,pod) (kube_pod_container_resource_requests{{node="{node}",resource="memory"}})': [
            _row(512 * MI, namespace="netbox", pod="netbox-0")
        ],
        f'kube_pod_init_container_resource_requests{{node="{node}",resource="cpu"}}': [],
        f'kube_pod_init_container_resource_requests{{node="{node}",resource="memory"}}': [],
        "kube_pod_overhead_cpu_cores": [],
        "kube_pod_overhead_memory_bytes": [],
    }


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


def test_read_nodes_joins_arch_by_nodename(monkeypatch):
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_node_info": [
                    _row(1, node="n1", kubelet_version="v1.29.0"),
                    _row(1, node="n2", kubelet_version="v1.29.0"),
                ],
                "node_uname_info": [_row(1, nodename="n1", machine="aarch64")],
            }
        ),
    )
    nodes, reason = facility.read_nodes("http://prom.test")
    assert reason == ""
    by_name = {n.name: n for n in nodes}
    assert by_name["n1"].kubelet_version == "v1.29.0"
    assert by_name["n1"].arch == "aarch64"
    # n2 has no matching node_uname_info row — a per-node degrade, not a
    # whole-read failure (node-exporter can legitimately be unscraped on
    # one node while KSM is fine cluster-wide).
    assert by_name["n2"].arch is None


def test_read_nodes_arch_falls_back_to_netbox_only_where_uname_is_silent(monkeypatch):
    """umbrella #339 item 2: the whole fallback chain in one pass — measured
    beats declared, declared beats nothing, and the source is always stated.
    n1 reports its own machine, n2 does not."""
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_node_info": [
                    _row(1, node="n1", kubelet_version="v1.29.0"),
                    _row(1, node="n2", kubelet_version="v1.29.0"),
                ],
                "node_uname_info": [_row(1, nodename="n1", machine="aarch64")],
            }
        ),
    )
    nodes, reason = facility.read_nodes("http://prom.test", "arm64")
    assert reason == ""
    by_name = {n.name: n for n in nodes}
    # The site value must NOT overwrite a node that reported for itself —
    # 'aarch64' is what n1 said, 'arm64' is what NetBox was told.
    assert (by_name["n1"].arch, by_name["n1"].arch_source) == ("aarch64", "node")
    assert (by_name["n2"].arch, by_name["n2"].arch_source) == ("arm64", "netbox")


def test_read_nodes_arch_is_unreadable_when_neither_source_has_it(monkeypatch):
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_node_info": [_row(1, node="n1", kubelet_version="v1.29.0")],
                "node_uname_info": [],
            }
        ),
    )
    nodes, reason = facility.read_nodes("http://prom.test", None)
    assert reason == ""
    # The designed cannot-be-read state survives as the final fallback: no
    # source, no value, and no source token to imply one.
    assert (nodes[0].arch, nodes[0].arch_source) == (None, None)


def test_read_nodes_empty_kube_node_info_is_unreadable(monkeypatch):
    monkeypatch.setattr(
        prometheus_module, "query", _exact_dispatcher({"kube_node_info": [], "node_uname_info": []})
    )
    nodes, reason = facility.read_nodes("http://prom.test")
    assert nodes == []
    assert reason == "nodes-unreadable"


def test_read_nodes_malformed_row_is_unreadable_not_500(monkeypatch):
    # Missing the required kubelet_version label — a malformed row must
    # collapse the WHOLE read, never silently drop just that node.
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher({"kube_node_info": [_row(1, node="n1")], "node_uname_info": []}),
    )
    nodes, reason = facility.read_nodes("http://prom.test")
    assert nodes == []
    assert reason == "nodes-unreadable"


def test_read_nodes_transport_error_is_unreadable(monkeypatch):
    def boom(*, url, expr):
        raise prometheus_module.PrometheusAPIError(500, "boom")

    monkeypatch.setattr(prometheus_module, "query", boom)
    nodes, reason = facility.read_nodes("http://prom.test")
    assert nodes == []
    assert reason == "nodes-unreadable"


# ---------------------------------------------------------------------------
# Platform services + ingress URLs
# ---------------------------------------------------------------------------

def _spec(key, display_name, namespace=None, image_contains=None):
    return facility.PlatformServiceSpec(
        key=key, display_name=display_name, namespace=namespace, image_contains=image_contains
    )


_APPS = [
    _spec("netbox", "NetBox", namespace="netbox", image_contains="netbox"),
    _spec("awx", "AWX", namespace="awx", image_contains="awx"),
    _spec("librenms", "LibreNMS", namespace="librenms", image_contains="librenms"),
]


def test_read_platform_services_matches_by_host_prefix_and_resolves_images(monkeypatch):
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_ingress_path": [
                    _row(1, namespace="netbox", ingress="netbox", host="netbox.dmf.lab.example", path="/"),
                    _row(1, namespace="awx", ingress="awx", host="awx.dmf.lab.example", path="/"),
                ],
                "kube_ingress_tls": [_row(1, namespace="netbox", ingress="netbox", tls_host="netbox.dmf.lab.example")],
                "kube_pod_container_info": [
                    _row(1, namespace="netbox", pod="netbox-0", container="netbox", image_spec="netboxcommunity/netbox:v4.1.0", image="sha256:abc"),
                    _row(1, namespace="awx", pod="awx-web-0", container="awx-web", image="quay.io/ansible/awx:24.6.1"),
                ],
            }
        ),
    )
    services, reason = facility.read_platform_services("http://prom.test", _APPS)
    assert reason == ""
    by_key = {s.key: s for s in services}

    # netbox: TLS -> https, image_spec preferred over image.
    assert by_key["netbox"].url == "https://netbox.dmf.lab.example/"
    assert by_key["netbox"].images == ("netboxcommunity/netbox:v4.1.0",)

    # awx: no TLS row -> http, falls back to `image` (no image_spec label).
    assert by_key["awx"].url == "http://awx.dmf.lab.example/"
    assert by_key["awx"].images == ("quay.io/ansible/awx:24.6.1",)

    # librenms: nothing in the cluster matched. The row survives with the
    # namespace that WAS searched, so the page can say what it checked
    # rather than claim the service is absent.
    assert by_key["librenms"].url is None
    assert by_key["librenms"].namespace == "librenms"
    assert by_key["librenms"].images == ()


def test_read_platform_services_ingressless_service_is_still_detected(monkeypatch):
    """umbrella #339 item 1, the finding itself: AWX deliberately runs with no
    ingress on this env, and the page reported it "not found in this cluster"
    while listing its PVCs two sections below. Presence must come from the
    containers, so a service with pods and no ingress reads as present with a
    dashed ACCESS — not as missing."""
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_ingress_path": [
                    _row(1, namespace="netbox", ingress="netbox", host="netbox.dmf.lab.example", path="/"),
                ],
                "kube_ingress_tls": [],
                "kube_pod_container_info": [
                    _row(1, namespace="awx", pod="awx-web-0", container="awx-web", image="quay.io/ansible/awx:24.6.1"),
                    _row(1, namespace="netbox", pod="netbox-0", image="netboxcommunity/netbox:v4.1.0"),
                ],
            }
        ),
    )
    services, reason = facility.read_platform_services("http://prom.test", _APPS)
    assert reason == ""
    awx = {s.key: s for s in services}["awx"]
    assert awx.images == ("quay.io/ansible/awx:24.6.1",)
    assert awx.namespace == "awx"
    # Present, and honestly unreachable from here: no ingress, so no link.
    assert awx.url is None


def test_read_platform_services_ingressless_cluster_still_reads_versions(monkeypatch):
    """An env whose platform services expose NO ingress at all used to collapse
    the entire section (empty kube_ingress_path raised). Ingress is an access
    route, so its absence costs URLs and nothing else."""
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_ingress_path": [],
                "kube_ingress_tls": [],
                "kube_pod_container_info": [
                    _row(1, namespace="netbox", pod="netbox-0", image="netboxcommunity/netbox:v4.1.0"),
                ],
            }
        ),
    )
    services, reason = facility.read_platform_services("http://prom.test", _APPS)
    assert reason == ""
    by_key = {s.key: s for s in services}
    assert by_key["netbox"].images == ("netboxcommunity/netbox:v4.1.0",)
    assert by_key["netbox"].url is None


def test_read_platform_services_narrows_to_the_services_own_image(monkeypatch):
    """Sidecars share the namespace: a netbox namespace also runs valkey and
    postgres, and `monitoring` runs prometheus/loki/promtail alongside grafana.
    Listing those under a service's Version column would misattribute other
    software's versions to it."""
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_ingress_path": [],
                "kube_ingress_tls": [],
                "kube_pod_container_info": [
                    _row(1, namespace="netbox", pod="netbox-0", image="netboxcommunity/netbox:v4.1.0"),
                    _row(1, namespace="netbox", pod="netbox-valkey-0", image="docker.io/bitnami/valkey:7.2"),
                    _row(1, namespace="netbox", pod="netbox-pg-0", image="docker.io/library/postgres:16"),
                ],
            }
        ),
    )
    services, reason = facility.read_platform_services("http://prom.test", _APPS)
    assert reason == ""
    assert {s.key: s for s in services}["netbox"].images == ("netboxcommunity/netbox:v4.1.0",)


def test_read_platform_services_undeclared_service_is_unchecked_not_absent(monkeypatch):
    """An entry with no `cluster:` block was never looked for. The row carries
    namespace=None so the page can say that, instead of reporting the same
    empty images as a service that WAS searched and not found."""
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_ingress_path": [],
                "kube_ingress_tls": [],
                "kube_pod_container_info": [_row(1, namespace="netbox", pod="netbox-0", image="netboxcommunity/netbox:v4.1.0")],
            }
        ),
    )
    services, reason = facility.read_platform_services("http://prom.test", [_spec("mystery", "Mystery")])
    assert reason == ""
    assert services[0].namespace is None
    assert services[0].images == ()


def test_read_platform_services_empty_containers_is_unreadable(monkeypatch):
    """kube_pod_container_info is THE liveness sentinel now that presence is
    read from it: no DMF env runs zero containers, so empty means unscraped."""
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher({"kube_ingress_path": [], "kube_ingress_tls": [], "kube_pod_container_info": []}),
    )
    services, reason = facility.read_platform_services("http://prom.test", _APPS)
    assert reason == "platform-services-unreadable"
    # Every requested app still gets a row — degraded, never dropped.
    assert [s.key for s in services] == ["netbox", "awx", "librenms"]
    assert all(s.url is None and s.images == () for s in services)


def test_read_platform_services_malformed_row_is_unreadable_not_500(monkeypatch):
    # An ingress_path row missing the required `host` label. Still collapses
    # the section: a row we cannot parse means the ACCESS join is untrusted,
    # and half a table with no warning is the state this contract forbids.
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_ingress_path": [_row(1, namespace="netbox", ingress="netbox", path="/")],
                "kube_ingress_tls": [],
                "kube_pod_container_info": [_row(1, namespace="netbox", image="x")],
            }
        ),
    )
    services, reason = facility.read_platform_services("http://prom.test", _APPS)
    assert reason == "platform-services-unreadable"


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def test_read_storage_joins_bytes_and_excludes_k8s_system_namespaces(monkeypatch):
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_persistentvolumeclaim_info": [
                    _row(1, namespace="netbox", persistentvolumeclaim="netbox-data", storageclass="local-path"),
                    _row(1, namespace="netbox", persistentvolumeclaim="netbox-media", storageclass="local-path"),
                    _row(1, namespace="kube-system", persistentvolumeclaim="some-internal-pvc", storageclass="local-path"),
                ],
                "kube_persistentvolumeclaim_resource_requests_storage_bytes": [
                    _row(10 * GI, namespace="netbox", persistentvolumeclaim="netbox-data"),
                ],
            }
        ),
    )
    volumes, reason = facility.read_storage("http://prom.test")
    assert reason == ""
    assert [v.name for v in volumes] == ["netbox-data", "netbox-media"]
    assert volumes[0].requested_bytes == 10 * GI
    # No matching request-bytes row for netbox-media — None, never a
    # fabricated 0.
    assert volumes[1].requested_bytes is None


def test_read_storage_empty_info_is_unreadable(monkeypatch):
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {"kube_persistentvolumeclaim_info": [], "kube_persistentvolumeclaim_resource_requests_storage_bytes": []}
        ),
    )
    volumes, reason = facility.read_storage("http://prom.test")
    assert volumes == []
    assert reason == "storage-unreadable"


# ---------------------------------------------------------------------------
# Site identity
# ---------------------------------------------------------------------------


def test_read_site_identity_not_configured():
    site, reason = facility.read_site_identity(
        netbox_configured=False, netbox_api_url="", netbox_api_token="", netbox_ssl_verify=False
    )
    assert reason == "netbox-not-configured"
    assert site == {"slug": None, "name": None, "architecture": None}


def test_read_site_identity_single_site(monkeypatch):
    monkeypatch.setattr(netbox_module, "list_sites", lambda **k: [{"name": "DMF Lab", "slug": "dmf-lab"}])
    site, reason = facility.read_site_identity(
        netbox_configured=True, netbox_api_url="http://nb.test", netbox_api_token="tok", netbox_ssl_verify=False
    )
    assert reason == ""
    # A legacy env with no dmf_architecture stamped still resolves its
    # identity — only the arch fallback is unavailable.
    assert site == {"slug": "dmf-lab", "name": "DMF Lab", "architecture": None}


def test_read_site_identity_reads_architecture_off_the_non_brief_serializer(monkeypatch):
    """NetBox's brief serializer omits custom_fields entirely, so asking for
    brief rows would silently deliver architecture=None forever (umbrella #339
    item 2). Assert the request itself, not just the parse."""
    calls = {}

    def fake_list_sites(**kwargs):
        calls.update(kwargs)
        return [
            {
                "name": "DMF Lab",
                "slug": "dmf-lab",
                "custom_fields": {"dmf_provider": "hetzner", "dmf_architecture": "arm64"},
            }
        ]

    monkeypatch.setattr(netbox_module, "list_sites", fake_list_sites)
    site, reason = facility.read_site_identity(
        netbox_configured=True, netbox_api_url="http://nb.test", netbox_api_token="tok", netbox_ssl_verify=False
    )
    assert reason == ""
    assert calls["brief"] is False
    assert site == {"slug": "dmf-lab", "name": "DMF Lab", "architecture": "arm64"}


def test_read_site_identity_blank_architecture_is_absent_not_empty_string(monkeypatch):
    monkeypatch.setattr(
        netbox_module,
        "list_sites",
        lambda **k: [{"name": "DMF Lab", "slug": "dmf-lab", "custom_fields": {"dmf_architecture": "  "}}],
    )
    site, _ = facility.read_site_identity(
        netbox_configured=True, netbox_api_url="http://nb.test", netbox_api_token="tok", netbox_ssl_verify=False
    )
    # A blank custom field must not become an arch string the page renders as
    # a fact — it degrades to the cannot-be-read state instead.
    assert site["architecture"] is None


def test_read_site_identity_ambiguous_when_not_exactly_one(monkeypatch):
    monkeypatch.setattr(netbox_module, "list_sites", lambda **k: [])
    site, reason = facility.read_site_identity(
        netbox_configured=True, netbox_api_url="http://nb.test", netbox_api_token="tok", netbox_ssl_verify=False
    )
    assert reason == "site-ambiguous"
    assert site == {"slug": None, "name": None, "architecture": None}


def test_read_site_identity_transport_error_is_unreadable(monkeypatch):
    def boom(**k):
        raise netbox_module.NetboxAPIError(500, "boom")

    monkeypatch.setattr(netbox_module, "list_sites", boom)
    site, reason = facility.read_site_identity(
        netbox_configured=True, netbox_api_url="http://nb.test", netbox_api_token="tok", netbox_ssl_verify=False
    )
    assert reason == "netbox-unreadable"


# ---------------------------------------------------------------------------
# build_detail_payload — the orchestrator
# ---------------------------------------------------------------------------


def test_build_detail_payload_neither_configured():
    payload = facility.build_detail_payload(
        prometheus_configured=False,
        prometheus_url="",
        netbox_configured=False,
        netbox_api_url="",
        netbox_api_token="",
        netbox_ssl_verify=False,
        apps=_APPS,
    )
    assert payload["prometheus_configured"] is False
    assert payload["netbox_configured"] is False
    assert payload["site"]["reason"] == "netbox-not-configured"
    assert payload["nodes"]["reason"] == "prometheus-not-configured"
    assert payload["nodes"]["items"] == []
    assert payload["platform_services"]["reason"] == "prometheus-not-configured"
    assert payload["storage"]["reason"] == "prometheus-not-configured"
    assert payload["capacity"]["reason"] == "prometheus-not-configured"
    assert payload["capacity"]["allocatable_cpu_m"] is None
    assert payload["capacity"]["requests_committed_cpu_m"] is None


def test_build_detail_payload_full_success(monkeypatch):
    routes = {
        "kube_node_info": [_row(1, node="n1", kubelet_version="v1.29.0")],
        "node_uname_info": [_row(1, nodename="n1", machine="aarch64")],
        "kube_ingress_path": [_row(1, namespace="netbox", ingress="netbox", host="netbox.dmf.lab.example", path="/")],
        "kube_ingress_tls": [],
        "kube_pod_container_info": [
            _row(1, namespace="netbox", pod="netbox-0", container="netbox", image="netboxcommunity/netbox:v4.1.0"),
        ],
        "kube_persistentvolumeclaim_info": [
            _row(1, namespace="netbox", persistentvolumeclaim="netbox-data", storageclass="local-path"),
        ],
        "kube_persistentvolumeclaim_resource_requests_storage_bytes": [
            _row(5 * GI, namespace="netbox", persistentvolumeclaim="netbox-data"),
        ],
        **_supply_routes(node="n1"),
    }
    monkeypatch.setattr(prometheus_module, "query", _exact_dispatcher(routes))
    monkeypatch.setattr(netbox_module, "list_sites", lambda **k: [{"name": "DMF Lab", "slug": "dmf-lab"}])
    monkeypatch.setattr(
        netbox_module,
        "_request",
        lambda *a, **k: {"results": [{"name": "n1", "custom_fields": {"dmf_instance_type": "CAX21"}}]},
    )

    payload = facility.build_detail_payload(
        prometheus_configured=True,
        prometheus_url="http://prom.test",
        netbox_configured=True,
        netbox_api_url="http://nb.test",
        netbox_api_token="tok",
        netbox_ssl_verify=False,
        apps=[_spec("netbox", "NetBox", namespace="netbox", image_contains="netbox")],
    )

    assert payload["site"] == {
        "slug": "dmf-lab",
        "name": "DMF Lab",
        "architecture": None,
        "reason": "",
    }
    assert payload["nodes"]["reason"] == ""
    assert payload["nodes"]["items"] == [
        {"name": "n1", "kubelet_version": "v1.29.0", "arch": "aarch64", "arch_source": "node"}
    ]
    assert payload["platform_services"]["reason"] == ""
    assert payload["platform_services"]["items"] == [
        {
            "key": "netbox",
            "display_name": "NetBox",
            "namespace": "netbox",
            "image_contains": "netbox",
            "url": "http://netbox.dmf.lab.example/",
            "images": ["netboxcommunity/netbox:v4.1.0"],
        }
    ]
    assert payload["storage"]["reason"] == ""
    assert payload["storage"]["items"] == [
        {"namespace": "netbox", "name": "netbox-data", "storageclass": "local-path", "requested_bytes": 5 * GI}
    ]
    # The scheduler-truth labels, verbatim — never "used"/"free".
    cap = payload["capacity"]
    assert cap["reason"] == ""
    assert cap["allocatable_cpu_m"] == 2000
    assert cap["allocatable_mem_b"] == 4 * GI
    assert cap["requests_committed_cpu_m"] == 500
    assert cap["requests_committed_mem_b"] == 512 * MI


# ---------------------------------------------------------------------------
# Endpoints — fail-soft contract, never a raw 500
# ---------------------------------------------------------------------------


def _client(netbox=None, prometheus=None) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=("dmf-console-viewer",),
        netbox=netbox or NetboxSettings(),
        prometheus=prometheus or PrometheusSettings(),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def test_summary_anonymous_is_401():
    client = TestClient(create_app(settings=Settings(runtime_mode="local", dev_login_enabled=True)))
    assert client.get("/api/facility/summary").status_code == 401


def test_summary_unconfigured_is_200_with_reason():
    resp = _client().get("/api/facility/summary")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reason"] == "netbox-not-configured"
    assert body["sites"] == []


def test_summary_unreachable_is_200_never_500(monkeypatch):
    def boom(**k):
        raise netbox_module.NetboxAPIError(500, "connection refused")

    monkeypatch.setattr(netbox_module, "list_sites", boom)
    resp = _client(netbox=NetboxSettings(api_url="http://nb.test", api_token="tok")).get("/api/facility/summary")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reason"] == "netbox-unreachable"
    assert "connection refused" not in resp.text


def test_summary_success_includes_slug_for_the_detail_link(monkeypatch):
    monkeypatch.setattr(netbox_module, "list_sites", lambda **k: [{"name": "DMF Lab", "slug": "dmf-lab"}])
    monkeypatch.setattr(netbox_module, "list_devices", lambda **k: [])
    resp = _client(netbox=NetboxSettings(api_url="http://nb.test", api_token="tok")).get("/api/facility/summary")
    body = resp.json()
    assert body["reason"] == ""
    assert body["sites"] == [{"name": "DMF Lab", "slug": "dmf-lab", "device_count": 0}]


def test_devices_unconfigured_is_200_with_reason():
    resp = _client().get("/api/facility/devices")
    assert resp.status_code == 200
    assert resp.json() == {"reason": "netbox-not-configured", "devices": []}


def test_devices_unreachable_is_200_never_500(monkeypatch):
    def boom(**k):
        raise netbox_module.NetboxAPIError(500, "boom")

    monkeypatch.setattr(netbox_module, "list_devices", boom)
    resp = _client(netbox=NetboxSettings(api_url="http://nb.test", api_token="tok")).get("/api/facility/devices")
    assert resp.status_code == 200
    assert resp.json()["reason"] == "netbox-unreachable"


def test_detail_anonymous_is_401():
    client = TestClient(create_app(settings=Settings(runtime_mode="local", dev_login_enabled=True)))
    assert client.get("/api/facility/dmf-lab/detail").status_code == 401


def test_detail_neither_configured_is_200_with_reasons_and_echoes_site():
    resp = _client().get("/api/facility/dmf-lab/detail")
    assert resp.status_code == 200
    body = resp.json()
    assert body["requested_site"] == "dmf-lab"
    assert body["prometheus_configured"] is False
    assert body["netbox_configured"] is False
    assert body["nodes"]["reason"] == "prometheus-not-configured"
    assert body["capacity"]["reason"] == "prometheus-not-configured"


def test_detail_malformed_series_is_200_never_500(monkeypatch):
    # kube_node_info rows missing the required `node` label.
    monkeypatch.setattr(
        prometheus_module,
        "query",
        _exact_dispatcher(
            {
                "kube_node_info": [{"metric": {"kubelet_version": "v1.29.0"}, "value": [0, "1"]}],
                "node_uname_info": [],
                "kube_ingress_path": [],
                "kube_ingress_tls": [],
                "kube_pod_container_info": [],
                "kube_persistentvolumeclaim_info": [],
                "kube_persistentvolumeclaim_resource_requests_storage_bytes": [],
                **_supply_routes(node="n1"),
            }
        ),
    )
    resp = _client(prometheus=PrometheusSettings(url="http://prom.test")).get("/api/facility/dmf-lab/detail")
    assert resp.status_code == 200
    body = resp.json()
    assert body["nodes"]["reason"] == "nodes-unreadable"
    assert body["nodes"]["items"] == []


def test_detail_transport_unreachable_is_200_never_500(monkeypatch):
    def boom(*, url, expr):
        raise prometheus_module.PrometheusAPIError(503, "unreachable")

    monkeypatch.setattr(prometheus_module, "query", boom)
    resp = _client(prometheus=PrometheusSettings(url="http://prom.test")).get("/api/facility/dmf-lab/detail")
    assert resp.status_code == 200
    body = resp.json()
    assert body["nodes"]["reason"] == "nodes-unreadable"
    assert body["platform_services"]["reason"] == "platform-services-unreadable"
    assert body["storage"]["reason"] == "storage-unreadable"
    assert body["capacity"]["reason"] == "budget-unavailable"
    assert "unreachable" not in resp.text  # no raw exception text leaks (Art. 8)


# ---------------------------------------------------------------------------
# GATE-S1 P2a: malformed / nullable rows. Codex reproduced a live 500 from a
# VALID NetBox read whose device row carried site=None — the read succeeded,
# the SHAPING blew up outside the guard. These pin the repro directly: the
# transport-error tests above never covered it, because nothing was wrong
# with the transport.
# ---------------------------------------------------------------------------


def test_summary_valid_site_plus_null_site_device_is_200_with_reason(monkeypatch):
    monkeypatch.setattr(netbox_module, "list_sites", lambda **k: [{"name": "DMF Lab", "slug": "dmf-lab"}])
    monkeypatch.setattr(netbox_module, "list_devices", lambda **k: [{"name": "orphan", "site": None}])
    resp = _client(netbox=NetboxSettings(api_url="http://nb.test", api_token="tok")).get("/api/facility/summary")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # The valid site still renders; the orphan device simply does not count
    # against it. A null field must never take the page down.
    assert body["sites"] == [{"name": "DMF Lab", "slug": "dmf-lab", "device_count": 0}]
    assert body["device_count"] == 1


def test_devices_null_site_role_and_type_is_200_never_500(monkeypatch):
    monkeypatch.setattr(
        netbox_module,
        "list_devices",
        lambda **k: [{"id": 1, "name": "orphan", "site": None, "role": None, "device_type": None,
                      "status": None, "primary_ip": None}],
    )
    resp = _client(netbox=NetboxSettings(api_url="http://nb.test", api_token="tok")).get("/api/facility/devices")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reason"] == ""
    assert body["devices"] == [
        {"id": 1, "name": "orphan", "type": None, "site": None, "status": None, "ip": None, "role": None}
    ]


def test_summary_non_dict_rows_do_not_500(monkeypatch):
    monkeypatch.setattr(netbox_module, "list_sites", lambda **k: [{"name": "DMF Lab", "slug": "dmf-lab"}, "junk"])
    monkeypatch.setattr(netbox_module, "list_devices", lambda **k: [{"site": {"name": "DMF Lab"}}, "junk"])
    resp = _client(netbox=NetboxSettings(api_url="http://nb.test", api_token="tok")).get("/api/facility/summary")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["sites"] == [{"name": "DMF Lab", "slug": "dmf-lab", "device_count": 1}]
    # Skipping a row must SAY so — silence would claim a completeness the
    # payload does not have (GATE-S1-RV P2).
    assert body["reason"] == "netbox-rows-unparseable"


def test_devices_unparseable_row_sets_a_reason_not_silence(monkeypatch):
    monkeypatch.setattr(netbox_module, "list_devices", lambda **k: [{"id": 1, "name": "ok"}, "junk"])
    resp = _client(netbox=NetboxSettings(api_url="http://nb.test", api_token="tok")).get("/api/facility/devices")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["devices"]) == 1
    assert body["reason"] == "netbox-rows-unparseable"


def test_clean_rows_carry_no_degradation_reason(monkeypatch):
    """The discriminator: the reason must appear ONLY when something was
    actually dropped, or it stops meaning anything."""
    monkeypatch.setattr(netbox_module, "list_sites", lambda **k: [{"name": "DMF Lab", "slug": "dmf-lab"}])
    monkeypatch.setattr(netbox_module, "list_devices", lambda **k: [{"site": {"name": "DMF Lab"}}])
    resp = _client(netbox=NetboxSettings(api_url="http://nb.test", api_token="tok")).get("/api/facility/summary")
    assert resp.json()["reason"] == ""
