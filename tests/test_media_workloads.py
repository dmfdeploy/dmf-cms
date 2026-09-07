"""Media Workloads read endpoint (ADR-0037, dmfdeploy/dmfdeploy#173 WP2).

Covers the GATE-7 acceptance list for the read path: role gate enforced in
the backend, tenancy fail-closed (dark when undeclared, empty scope for
unmapped groups in scoped mode), single-tenant allow-all only when explicit,
and degraded-payload (never raw 500) on NetBox failure.
"""

from fastapi.testclient import TestClient
import pytest

from dmf_cms import netbox as netbox_module
from dmf_cms.main import create_app
from dmf_cms.settings import MediaTenancySettings, NetboxSettings, Settings


ENGINEER = ("dmf-console-engineer",)
OPERATOR = ("dmf-console-operator",)
MEDIA_ENGINEERS = ("media-engineers",)  # tenancy group, no capability role (#174)


def _client(tenancy: MediaTenancySettings, groups=ENGINEER, netbox=True) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="tok") if netbox else NetboxSettings(),
        media_tenancy=tenancy,
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)  # dev login -> session
    return client


def _service(name: str, tags: list[str], device: str = "node-1") -> dict:
    return {
        "id": 1,
        "name": name,
        "tags": [{"name": t} for t in tags],
        "device": {"name": device},
        "ports": [9000],
        "protocol": {"value": "tcp"},
    }


def test_anonymous_is_401():
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        media_tenancy=MediaTenancySettings(mode="single"),
    )
    client = TestClient(create_app(settings=settings))
    assert client.get("/api/media-workloads").status_code == 401


def test_operator_role_is_403():
    client = _client(MediaTenancySettings(mode="single"), groups=OPERATOR)
    assert client.get("/api/media-workloads").status_code == 403


def test_mxl_status_shares_the_media_workloads_boundary():
    # GATE-20 P3 fold: the live-view endpoints sit inside the Media
    # Workloads surface, so they carry the same ADR-0037 §5 gate.
    below = _client(MediaTenancySettings(mode="single"), groups=OPERATOR)
    assert below.get("/api/mxl/status").status_code == 403
    assert below.get("/api/mxl/preview/receiver").status_code == 403
    member = _client(MediaTenancySettings(mode="single"), groups=MEDIA_ENGINEERS)
    resp = member.get("/api/mxl/status")
    assert resp.status_code == 200
    assert resp.json()["configured"] is False  # unconfigured MXL, not a 403


def test_media_engineers_group_grants_read_without_role(monkeypatch):
    # ADR-0037 §5 / #174: the media-engineers group scopes the surface even
    # though the member's capability role resolves to viewer.
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"results": []})
    client = _client(MediaTenancySettings(mode="single"), groups=MEDIA_ENGINEERS)
    resp = client.get("/api/media-workloads")
    assert resp.status_code == 200
    assert resp.json()["configured"] is True


def test_undeclared_tenancy_is_dark_not_allow_all(monkeypatch):
    called = {"netbox": False}

    def fake_request(*args, **kwargs):  # pragma: no cover - must not run
        called["netbox"] = True
        return {"results": []}

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(MediaTenancySettings(mode=""))
    resp = client.get("/api/media-workloads")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is False
    assert body["instances"] == []
    assert called["netbox"] is False  # dark means NetBox is never queried


def test_single_mode_lists_instances_with_desired_vs_observed(monkeypatch):
    def fake_request(api_url, api_token, path, ssl_context=None):
        assert "/api/ipam/services/" in path
        assert "tag=dmf-catalog" in path
        return {
            "results": [
                _service("mxl-videotestsrc", ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:active"]),
                _service("nmos-cpp", ["dmf-catalog", "app:nmos-cpp", "lifecycle:bootstrapped"]),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(MediaTenancySettings(mode="single"))
    body = client.get("/api/media-workloads").json()
    assert body["configured"] is True and body["degraded"] is False
    assert body["scope"] == "all"
    by_name = {i["instance"]: i for i in body["instances"]}
    hello = by_name["mxl-videotestsrc"]
    # No prometheus configured: observed stays honest-unknown, and an
    # active-desired instance without runtime proof is reconcile_pending.
    assert hello["requested_state"] == "active"
    assert hello["observed_state"] == "unknown"
    assert hello["reconcile_pending"] is True
    assert by_name["nmos-cpp"]["reconcile_pending"] is False
    assert {f["function_key"] for f in body["functions"]} == {"mxl-videotestsrc", "nmos-cpp"}


def test_topology_spawned_instance_exposes_recorded_provenance(monkeypatch):
    # umbrella #401 — the two new tags are read the SAME generic way
    # app:/lifecycle: already are (_tag_suffix); dmf-cms never constructs
    # or parses an instance name to arrive at these values.
    def fake_request(api_url, api_token, path, ssl_context=None):
        return {
            "results": [
                _service(
                    "mxl-videotest-view-source-a",
                    [
                        "dmf-catalog",
                        "app:mxl-videotest-view-source-a",
                        "lifecycle:active",
                        "topology-parent:mxl-videotest-view",
                        "topology-source:source-a",
                    ],
                ),
                # An ordinary instance — no topology-parent:/topology-source:
                # tags at all — must expose both fields as null, not a guess.
                _service("mxl-videotest-view", ["dmf-catalog", "app:mxl-videotest-view", "lifecycle:active"]),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(MediaTenancySettings(mode="single"))
    body = client.get("/api/media-workloads").json()
    by_name = {i["instance"]: i for i in body["instances"]}

    spawned = by_name["mxl-videotest-view-source-a"]
    assert spawned["topology_parent_key"] == "mxl-videotest-view"
    assert spawned["topology_source_id"] == "source-a"

    ordinary = by_name["mxl-videotest-view"]
    assert ordinary["topology_parent_key"] is None
    assert ordinary["topology_source_id"] is None


def test_scoped_mode_unmapped_group_sees_nothing(monkeypatch):
    def fake_request(*args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("scoped user with no mapped tenants must not reach NetBox")

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(
        MediaTenancySettings(mode="scoped", group_tenant_map=(("other-group", ("tenant-a",)),))
    )
    body = client.get("/api/media-workloads").json()
    assert body["configured"] is True
    assert body["instances"] == []
    assert body["scope"] == []


def test_scoped_mode_filters_by_mapped_tenant_devices(monkeypatch):
    calls: list[str] = []

    def fake_request(api_url, api_token, path, ssl_context=None):
        calls.append(path)
        if path.startswith("/api/dcim/devices/"):
            assert "tenant=tenant-a" in path
            return {"results": [{"id": 7}]}
        if path.startswith("/api/virtualization/virtual-machines/"):
            assert "tenant=tenant-a" in path
            return {"results": []}
        assert "device_id=7" in path
        return {"results": [_service("mxl-videotestsrc", ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:active"])]}

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(
        MediaTenancySettings(
            mode="scoped",
            group_tenant_map=(("dmf-console-engineer", ("tenant-a",)),),
        )
    )
    body = client.get("/api/media-workloads").json()
    assert body["scope"] == ["tenant-a"]
    assert [i["instance"] for i in body["instances"]] == ["mxl-videotestsrc"]
    # BOTH parent kinds must be consulted (services attach to devices OR VMs).
    assert any(p.startswith("/api/dcim/devices/") for p in calls)
    assert any(p.startswith("/api/virtualization/virtual-machines/") for p in calls)


def test_scoped_mode_includes_vm_backed_services(monkeypatch):
    """VM-backed workloads must not vanish from scoped inventories (GATE-10 P1)."""
    calls: list[tuple[str, str]] = []
    vm_svc = {
        "id": 2,
        "name": "mxl-vm",
        "tags": [{"name": t} for t in ["dmf-catalog", "app:mxl-vm", "lifecycle:bootstrapped"]],
        "virtual_machine": {"name": "vm-1"},
        "ports": [9000],
        "protocol": {"value": "tcp"},
    }

    def fake_request(api_url, api_token, path, ssl_context=None, method="GET", payload=None):
        calls.append((method, path))
        if path.startswith("/api/dcim/devices/"):
            return {"results": []}
        if path.startswith("/api/virtualization/virtual-machines/"):
            return {"results": [{"id": 42}]}
        if method == "PATCH":
            return {}
        assert "virtual_machine_id=42" in path
        return {"results": [vm_svc]}

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    tenancy = MediaTenancySettings(
        mode="scoped", group_tenant_map=(("dmf-console-engineer", ("tenant-a",)),)
    )
    client = _client(tenancy)
    body = client.get("/api/media-workloads").json()
    assert [i["instance"] for i in body["instances"]] == ["mxl-vm"]
    assert body["instances"][0]["placement"]["node"] == "vm-1"

    # And the clear path finds it too (was not-found before the fix).
    writer = _writer_client(tenancy=tenancy)
    resp = writer.post("/api/media-workloads/mxl-vm/clear", json={"reason": "vm go"})
    assert resp.status_code == 200
    patches = [c for c in calls if c[0] == "PATCH"]
    assert patches and patches[0][1] == "/api/ipam/services/2/"


def test_netbox_failure_degrades_never_500(monkeypatch):
    def fake_request(*args, **kwargs):
        raise netbox_module.NetboxAPIError(502, "boom")

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(MediaTenancySettings(mode="single"))
    resp = client.get("/api/media-workloads")
    assert resp.status_code == 200
    body = resp.json()
    assert body["degraded"] is True and body["reason"] == "netbox-unreachable"


def test_netbox_failure_log_line_sanitizes_hostile_body(monkeypatch, caplog):
    # umbrella dmf-cms#108 fix-round 4: NetboxAPIError.body is upstream
    # response content — whatever NetBox's own HTTP response body says,
    # verbatim. This module has 8 sites following this exact pattern
    # (a NetboxAPIError-specific except clause logging str(exc), which
    # embeds .body via the exception's own __init__); this is the most
    # directly reachable one (a plain GET, no write gate), not
    # independently re-driven at each of the other 7.
    import logging

    def fake_request(*args, **kwargs):
        raise netbox_module.NetboxAPIError(502, "boom\nFORGED media-workloads: NetBox query failed: pwned")

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(MediaTenancySettings(mode="single"))
    with caplog.at_level(logging.WARNING, logger="dmf_cms.media_workloads"):
        resp = client.get("/api/media-workloads")
    assert resp.status_code == 200

    lines = [
        r.getMessage() for r in caplog.records
        if r.getMessage().startswith("media-workloads: NetBox query failed")
    ]
    assert len(lines) == 1
    assert "\n" not in lines[0]
    assert "FORGED" in lines[0]


def test_prometheus_overlay_failure_log_line_sanitizes_hostile_body(monkeypatch, caplog):
    # umbrella dmf-cms#108 fix-round 4: same reasoning, the OTHER upstream
    # service this module calls — PrometheusAPIError.body is Prometheus's
    # own raw response body. Direct unit call (not the full endpoint):
    # _observed_by_app is the simplest of the module's three Prometheus
    # call sites and proves the same sanitize_audit_field(str(exc)) wiring
    # the other two share.
    import logging

    from dmf_cms import media_workloads, prometheus as prometheus_module

    def fake_query(*args, **kwargs):
        raise prometheus_module.PrometheusAPIError(502, "boom\nFORGED media-workloads: prometheus overlay failed: pwned")

    monkeypatch.setattr(prometheus_module, "query", fake_query)
    with caplog.at_level(logging.WARNING, logger="dmf_cms.media_workloads"):
        result = media_workloads._observed_by_app("http://prom.test")
    assert result == {}

    lines = [
        r.getMessage() for r in caplog.records
        if r.getMessage().startswith("media-workloads: prometheus overlay failed")
    ]
    assert len(lines) == 1
    assert "\n" not in lines[0]
    assert "FORGED" in lines[0]


def test_netbox_unconfigured_is_degraded_payload():
    client = _client(MediaTenancySettings(mode="single"), netbox=False)
    body = client.get("/api/media-workloads").json()
    assert body["configured"] is True
    assert body["degraded"] is True and body["reason"] == "netbox-not-configured"


def test_group_tenant_map_parser():
    from dmf_cms.settings import _parse_group_tenant_map

    parsed = _parse_group_tenant_map("g1=t1|t2;g2=t3; malformed ;=t4;g3=")
    assert parsed == (("g1", ("t1", "t2")), ("g2", ("t3",)))
    assert _parse_group_tenant_map(None) == ()


# ---------------------------------------------------------------------------
# WP2b: clear-for-deployment write path (GATE-7 write-path checklist).
# ---------------------------------------------------------------------------

def _writer_client(tenancy=None, groups=ENGINEER, writer_token="wtok"):
    from dmf_cms.settings import Settings, NetboxSettings

    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="rtok", writer_token=writer_token),
        media_tenancy=tenancy or MediaTenancySettings(mode="single"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def _patch_recorder(monkeypatch, services):
    """Monkeypatch netbox._request; record PATCH calls, serve reads."""
    calls = {"patches": []}

    def fake_request(api_url, api_token, path, ssl_context=None, method="GET", payload=None):
        if method == "PATCH":
            calls["patches"].append({"path": path, "payload": payload, "token": api_token})
            return {}
        assert method == "GET"
        assert api_token == "rtok", "reads must use the read token"
        return {"results": services}

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    return calls


def test_clear_requires_reason(monkeypatch):
    calls = _patch_recorder(monkeypatch, [])
    client = _writer_client()
    resp = client.post("/api/media-workloads/x/clear", json={})
    assert resp.status_code == 400
    assert resp.json()["error"] == "reason-required"
    assert calls["patches"] == []


def test_clear_non_object_body_is_clean_400_not_a_crash(monkeypatch):
    # fix-round P3 (codex GATE-239CMS-R2): this endpoint used to parse the
    # body inline with its own (body or {}).get("reason", ...), which raised
    # an unhandled AttributeError on a non-object JSON body (dict.get doesn't
    # exist on a list/str/int) — a live-probed 500, not a clean 400. Now
    # routed through the shared _require_reason parser, which guards this.
    calls = _patch_recorder(monkeypatch, [])
    client = _writer_client()
    for bad_body in [["x"], "str", 5]:
        resp = client.post("/api/media-workloads/x/clear", json=bad_body)
        assert resp.status_code == 400, bad_body
        assert resp.json()["error"] == "reason-required"
    assert calls["patches"] == []  # zero NetBox side effects on any bad body


def test_clear_below_engineer_403_no_side_effect(monkeypatch):
    calls = _patch_recorder(monkeypatch, [])
    client = _writer_client(groups=OPERATOR)
    resp = client.post("/api/media-workloads/x/clear", json={"reason": "go"})
    assert resp.status_code == 403
    assert calls["patches"] == []


def test_clear_media_engineers_group_grants_write_without_role(monkeypatch):
    # ADR-0037 §5 scopes the group over both read and the clear write; the C5
    # record still reports the member's true capability role (viewer).
    calls = _patch_recorder(
        monkeypatch,
        [_service("mxl-videotestsrc", ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:bootstrapped"])],
    )
    client = _writer_client(groups=MEDIA_ENGINEERS)
    resp = client.post("/api/media-workloads/mxl-videotestsrc/clear", json={"reason": "go"})
    assert resp.status_code == 200
    assert resp.json()["role"] == "viewer"
    assert len(calls["patches"]) == 1


def test_clear_writer_token_unset_is_dark_503(monkeypatch):
    calls = _patch_recorder(monkeypatch, [])
    client = _writer_client(writer_token="")
    resp = client.post("/api/media-workloads/x/clear", json={"reason": "go"})
    assert resp.status_code == 503
    assert resp.json()["error"] == "netbox-writer-not-configured"
    assert calls["patches"] == []


def test_clear_tenancy_undeclared_is_503(monkeypatch):
    calls = _patch_recorder(monkeypatch, [])
    client = _writer_client(tenancy=MediaTenancySettings(mode=""))
    resp = client.post("/api/media-workloads/x/clear", json={"reason": "go"})
    assert resp.status_code == 503
    assert resp.json()["error"] == "media-tenancy-not-configured"
    assert calls["patches"] == []


def test_clear_out_of_scope_404_no_side_effect(monkeypatch):
    # Scoped user with no mapped tenants: instance invisible -> 404, no PATCH,
    # indistinguishable from nonexistent (no existence leak).
    calls = _patch_recorder(monkeypatch, [_service("mxl-videotestsrc", ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:bootstrapped"])])
    client = _writer_client(
        tenancy=MediaTenancySettings(mode="scoped", group_tenant_map=(("other", ("t1",)),))
    )
    resp = client.post("/api/media-workloads/mxl-videotestsrc/clear", json={"reason": "go"})
    assert resp.status_code == 404
    assert calls["patches"] == []


def test_clear_already_active_409_no_side_effect(monkeypatch):
    calls = _patch_recorder(
        monkeypatch, [_service("mxl-videotestsrc", ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:active"])]
    )
    client = _writer_client()
    resp = client.post("/api/media-workloads/mxl-videotestsrc/clear", json={"reason": "go"})
    assert resp.status_code == 409
    assert calls["patches"] == []


def test_clear_flips_tag_with_writer_token_and_c5(monkeypatch):
    calls = _patch_recorder(
        monkeypatch,
        [_service("mxl-videotestsrc", ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:bootstrapped"])],
    )
    client = _writer_client()
    resp = client.post("/api/media-workloads/mxl-videotestsrc/clear", json={"reason": "ready for demo"})
    assert resp.status_code == 200
    body = resp.json()
    # C5 quartet echoed at the point of action.
    assert body["actor"] == "operator" and body["role"] == "engineer"
    assert body["reason"] == "ready for demo" and body["request_id"]
    assert body["previous_state"] == "bootstrapped" and body["requested_state"] == "active"
    assert "reconcile" in body
    # Exactly one PATCH, on the writer token, replacing only the lifecycle tag.
    assert len(calls["patches"]) == 1
    patch = calls["patches"][0]
    assert patch["token"] == "wtok"
    assert patch["path"] == "/api/ipam/services/1/"
    tag_names = [t["name"] for t in patch["payload"]["tags"]]
    assert "lifecycle:active" in tag_names
    assert "lifecycle:bootstrapped" not in tag_names
    assert "dmf-catalog" in tag_names and "app:mxl-videotestsrc" in tag_names


def test_clear_reconcile_expectation_names_no_nonexistent_actor(monkeypatch):
    # dmfdeploy/dmfdeploy#411: this string used to promise "the platform's
    # automation lane converges it" and that "the drift check will flag the
    # gap until then" — neither exists (zero AWX schedules registered
    # anywhere, and the drift playbook has no job template, so nothing runs
    # it automatically either). Pinned verbatim: this exact string is also
    # what the frontend persists into the Activity audit record, so a
    # regression here silently corrupts that history too.
    _patch_recorder(
        monkeypatch,
        [_service("mxl-videotestsrc", ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:bootstrapped"])],
    )
    client = _writer_client()
    resp = client.post("/api/media-workloads/mxl-videotestsrc/clear", json={"reason": "ready for demo"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["reconcile"]["expectation"] == (
        "Desired state recorded in the facility source of truth. "
        "It shows as pending reconciliation until something deploys "
        "it — today, that's Provision."
    )
    assert "automation lane" not in body["reconcile"]["expectation"].lower()


def test_clear_audit_line_sanitizes_instance_and_actor(monkeypatch, caplog):
    # umbrella dmf-cms#108 fix-round 2: this is the canonical ADR-0028 C5
    # clear-for-deployment record — the one _audit_awx_write's own
    # docstring says the AWX writes were modelled on — and it formats
    # `instance` (a raw path parameter, unvalidated at this point: a
    # nonexistent instance name still reaches this log line via the
    # not-found outcome below) and `actor` (user.subject, an OIDC claim —
    # dev-login's own username field stands in for it here) with plain
    # %s, same injection shape fix-round 1 fixed in _audit_awx_write. A
    # hostile instance name here never matches a real NetBox service, so
    # this exercises the SAME not-found response path
    # test_clear_out_of_scope_404_no_side_effect already covers — the
    # audit call fires before the not-found branch, unconditionally.
    import logging

    from dmf_cms.settings import NetboxSettings, Settings

    _patch_recorder(monkeypatch, [])
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=ENGINEER,
        dev_username="ops\nFORGED actor=admin",
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="rtok", writer_token="wtok"),
        media_tenancy=MediaTenancySettings(mode="single"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post(
            "/api/media-workloads/hostile%0ainjected-instance/clear",
            json={"reason": "go"},
        )
    assert resp.status_code == 404
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("media-workloads clear:")]
    assert len(lines) == 1
    line = lines[0]
    assert "\n" not in line
    assert "\r" not in line
    assert "hostile" in line and "injected-instance" in line
    assert "FORGED" in line


# ---------------------------------------------------------------------------
# WP-D (G26): NetBox-derived per-instance MXL sidecar coords — SSRF gate,
# scoped resolve, TTL cache, and live_view exposure (no coord leak).
# ---------------------------------------------------------------------------
from dmf_cms.media_workloads import (  # noqa: E402
    ScopedServiceCache,
    resolve_sidecar_target,
    sidecar_base_url,
)


def _svc_cf(name: str, custom_fields: dict) -> dict:
    return {
        "id": 1,
        "name": name,
        "tags": [{"name": "dmf-catalog"}, {"name": f"app:{name}"}],
        "device": {"name": "node-1"},
        "ports": [9000],
        "custom_fields": custom_fields,
    }


_GOOD_CF = {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl", "cluster_port": 9000}


def test_sidecar_base_url_composes_promsd_contract():
    # Byte-for-byte the dmf-promsd host:port contract.
    svc = _svc_cf("mxl-videotestsrc", _GOOD_CF)
    assert sidecar_base_url(svc) == "http://mxl-videotestsrc.mxl.svc.cluster.local:9000"


def test_sidecar_base_url_accepts_numeric_string_port():
    svc = _svc_cf("mxl-videotestsrc", {**_GOOD_CF, "cluster_port": "9000"})
    assert sidecar_base_url(svc) == "http://mxl-videotestsrc.mxl.svc.cluster.local:9000"


@pytest.mark.parametrize(
    "name,cf",
    [
        # missing / partial coords
        ("mxl-x", {}),
        ("mxl-x", {"cluster_service": "mxl-x", "cluster_namespace": "mxl"}),  # no port
        ("mxl-x", {"cluster_service": "mxl-x", "cluster_port": 9000}),  # no namespace
        # namespace not allowlisted (classic SSRF pivots)
        ("mxl-x", {"cluster_service": "mxl-x", "cluster_namespace": "kube-system", "cluster_port": 9000}),
        ("mxl-x", {"cluster_service": "mxl-x", "cluster_namespace": "default", "cluster_port": 9000}),
        # port not allowlisted
        ("mxl-x", {"cluster_service": "mxl-x", "cluster_namespace": "mxl", "cluster_port": 8080}),
        ("mxl-x", {"cluster_service": "mxl-x", "cluster_namespace": "mxl", "cluster_port": 80}),
        # not DNS labels
        ("mxl-x", {"cluster_service": "MXL-X", "cluster_namespace": "mxl", "cluster_port": 9000}),
        ("mxl-x", {"cluster_service": "mxl-x", "cluster_namespace": "m x l", "cluster_port": 9000}),
        ("kubernetes.default", {"cluster_service": "kubernetes.default", "cluster_namespace": "mxl", "cluster_port": 9000}),
        # identity mismatch: coords point at a DIFFERENT (allowlisted-ns) target
        ("mxl-x", {"cluster_service": "authentik", "cluster_namespace": "mxl", "cluster_port": 9000}),
        ("mxl-x", {"cluster_service": "netbox", "cluster_namespace": "mxl", "cluster_port": 9000}),
        ("mxl-x", {"cluster_service": "mxl-other", "cluster_namespace": "mxl", "cluster_port": 9000}),
        # bool port must not slip through the int() coercion
        ("mxl-x", {"cluster_service": "mxl-x", "cluster_namespace": "mxl", "cluster_port": True}),
        # custom_fields not a dict
    ],
)
def test_sidecar_base_url_ssrf_rejections(name, cf):
    assert sidecar_base_url(_svc_cf(name, cf)) is None


def test_sidecar_base_url_none_when_custom_fields_absent():
    assert sidecar_base_url({"id": 1, "name": "mxl-x"}) is None


def test_sidecar_base_url_respects_configured_allowlists():
    svc = _svc_cf("mxl-x", {"cluster_service": "mxl-x", "cluster_namespace": "media", "cluster_port": 8443})
    # Default allowlists reject media/8443...
    assert sidecar_base_url(svc) is None
    # ...but an env that widens them composes the URL.
    assert (
        sidecar_base_url(svc, namespaces=frozenset({"media"}), ports=frozenset({8443}))
        == "http://mxl-x.media.svc.cluster.local:8443"
    )


def test_list_instances_exposes_live_view_without_leaking_coords(monkeypatch):
    def fake_request(*args, **kwargs):
        return {
            "results": [
                _svc_cf("mxl-videotestsrc", _GOOD_CF),
                _svc_cf("mxl-mock-nosidecar", {}),  # no sidecar coords
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(MediaTenancySettings(mode="single"))
    resp = client.get("/api/media-workloads")
    assert resp.status_code == 200
    body = resp.json()
    by_name = {i["instance"]: i for i in body["instances"]}
    assert by_name["mxl-videotestsrc"]["live_view"] is True
    assert by_name["mxl-mock-nosidecar"]["live_view"] is False
    # The coords / composed URL must NEVER appear anywhere in the JSON.
    raw = resp.text
    for leak in ("cluster_service", "cluster_namespace", "cluster_port", "svc.cluster.local", "custom_fields"):
        assert leak not in raw


def test_resolve_sidecar_target_scope_and_states(monkeypatch):
    services = [_svc_cf("mxl-videotestsrc", _GOOD_CF), _svc_cf("mxl-mock-nosidecar", {})]
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"results": services})

    ok = resolve_sidecar_target("http://nb", "tok", False, None, "mxl-videotestsrc")
    assert ok["status"] == "ok"
    assert ok["base_url"] == "http://mxl-videotestsrc.mxl.svc.cluster.local:9000"

    no_sidecar = resolve_sidecar_target("http://nb", "tok", False, None, "mxl-mock-nosidecar")
    assert no_sidecar["status"] == "no-sidecar"

    absent = resolve_sidecar_target("http://nb", "tok", False, None, "nope")
    assert absent["status"] == "not-found"


def test_resolve_sidecar_target_netbox_failure_degrades(monkeypatch):
    def boom(*a, **k):
        raise netbox_module.NetboxAPIError("down")

    monkeypatch.setattr(netbox_module, "_request", boom)
    out = resolve_sidecar_target("http://nb", "tok", False, None, "mxl-videotestsrc")
    assert out["status"] == "unreachable"


def test_scoped_service_cache_hits_within_ttl():
    calls = {"n": 0}

    def loader():
        calls["n"] += 1
        return [{"name": "a"}]

    cache = ScopedServiceCache(ttl=100.0)
    assert cache.get(None, loader) == [{"name": "a"}]
    assert cache.get(None, loader) == [{"name": "a"}]
    assert calls["n"] == 1  # second call served from cache


def test_scoped_service_cache_separates_scopes():
    calls = {"n": 0}

    def loader():
        calls["n"] += 1
        return []

    cache = ScopedServiceCache(ttl=100.0)
    cache.get(("tenant-a",), loader)
    cache.get(("tenant-b",), loader)
    cache.get(("tenant-a",), loader)  # cached
    assert calls["n"] == 2


# --- WP-D codex fixes: DNS-label trailing-newline (P2c) + list allowlist (P3a) ---

@pytest.mark.parametrize("bad", ["mxl-x\n", "mxl-x\r", "\nmxl-x", "mxl-x\t"])
def test_sidecar_base_url_rejects_trailing_whitespace_labels(bad):
    # re '$' matches before a trailing newline; fullmatch must reject it so no
    # http.client.InvalidURL (500) can ever be composed (codex P2).
    svc = _svc_cf(bad, {"cluster_service": bad, "cluster_namespace": "mxl", "cluster_port": 9000})
    assert sidecar_base_url(svc) is None


def test_list_instances_live_view_uses_configured_allowlists(monkeypatch):
    # A non-default namespace: default {mxl} would mark live_view False, but the
    # endpoint must pass the CONFIGURED allowlist so list agrees with status.
    coords = {"cluster_service": "mxl-x", "cluster_namespace": "media", "cluster_port": 9000}

    def fake_request(*a, **k):
        return {"results": [_svc_cf("mxl-x", coords)]}

    monkeypatch.setattr(netbox_module, "_request", fake_request)

    from dmf_cms.settings import MXLSettings, NetboxSettings

    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=ENGINEER,
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="tok"),
        media_tenancy=MediaTenancySettings(mode="single"),
        mxl=MXLSettings(sidecar_namespaces=frozenset({"media"}), sidecar_ports=frozenset({9000})),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    body = client.get("/api/media-workloads").json()
    inst = {i["instance"]: i for i in body["instances"]}["mxl-x"]
    assert inst["live_view"] is True  # would be False under the default {mxl}


# ---------------------------------------------------------------------------
# umbrella #452 — topology_source_pattern: the declared test pattern a
# topology-spawned source instance emits, resolved via the SAME loader
# switch_source.resolve_topology_for_receiver uses (catalog.load_topology_instance).
# Unit-level against _resolve_topology_source_pattern directly (same convention
# as _workload_assignment/_derive_workload_lifecycle above): a real tmp_path
# catalog dir, not a mock, matching test_switch_source.py's own J1_INSTANCE shape.
# ---------------------------------------------------------------------------
from pathlib import Path  # noqa: E402

from dmf_cms.media_workloads import (  # noqa: E402
    _resolve_topology_source_pattern,
    list_instances,
    list_workloads_grouped,
)


def _write_parent_entry(tmp_path: Path, *, key: str = "mxl-videotest-view", topology_ref: str | None = "topology-params.j1.yaml") -> None:
    lines = [
        f"key: {key}",
        'display_name: "Viewer"',
        'summary: "x"',
        "ebu:",
        "  layer: 5",
        "  media_function_type: view",
    ]
    if topology_ref:
        lines.append(f"topology_ref: {topology_ref}")
    (tmp_path / f"{key}.yaml").write_text("\n".join(lines) + "\n")


_TOPOLOGY_J1 = """\
topology_params:
  schema_version: 1
  target_facility: dmf-example-site
  sources:
    - id: source-a
      flow_id: "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
      pattern: smpte
    - id: source-b
      flow_id: "b0ae9cba-a989-4568-ac96-8bd19272c966"
      pattern: checkers-8
  viewer:
    id: viewer-a
    source_selection: source-a
"""


def test_topology_source_pattern_resolves_known_id(tmp_path: Path):
    _write_parent_entry(tmp_path)
    (tmp_path / "topology-params.j1.yaml").write_text(_TOPOLOGY_J1)
    assert (
        _resolve_topology_source_pattern("mxl-videotest-view", "source-a", str(tmp_path))
        == "smpte"
    )
    # Mutation: a DIFFERENT sources[].id resolves its OWN pattern, not a
    # copy-pasted constant — proves the lookup actually keys on the id.
    assert (
        _resolve_topology_source_pattern("mxl-videotest-view", "source-b", str(tmp_path))
        == "checkers-8"
    )


def test_topology_source_pattern_none_when_parent_key_unmatched(tmp_path: Path):
    _write_parent_entry(tmp_path)
    (tmp_path / "topology-params.j1.yaml").write_text(_TOPOLOGY_J1)
    # No catalog entry named "does-not-exist" — genuinely unresolvable.
    assert _resolve_topology_source_pattern("does-not-exist", "source-a", str(tmp_path)) is None
    # Mutation: the SAME source id under the REAL parent key resolves —
    # proves the None above is the parent-key miss, not a broken source lookup.
    assert (
        _resolve_topology_source_pattern("mxl-videotest-view", "source-a", str(tmp_path))
        == "smpte"
    )


def test_topology_source_pattern_none_when_source_id_unmatched(tmp_path: Path):
    _write_parent_entry(tmp_path)
    (tmp_path / "topology-params.j1.yaml").write_text(_TOPOLOGY_J1)
    # "source-z" is not a sources[].id in this topology instance.
    assert _resolve_topology_source_pattern("mxl-videotest-view", "source-z", str(tmp_path)) is None
    # Mutation: a real sources[].id under the SAME parent resolves — proves
    # the None above is the id mismatch, not a broken parent/topology load.
    assert (
        _resolve_topology_source_pattern("mxl-videotest-view", "source-a", str(tmp_path))
        == "smpte"
    )


def test_topology_source_pattern_none_when_parent_has_no_topology_ref(tmp_path: Path):
    _write_parent_entry(tmp_path, topology_ref=None)
    (tmp_path / "topology-params.j1.yaml").write_text(_TOPOLOGY_J1)
    # The catalog entry exists but carries no topology_ref at all.
    assert _resolve_topology_source_pattern("mxl-videotest-view", "source-a", str(tmp_path)) is None
    # Mutation: adding topology_ref back (same entry, same source id) now
    # resolves — proves the None above is the missing-topology_ref case,
    # not e.g. a typo'd key that would ALSO fail the earlier test.
    _write_parent_entry(tmp_path, topology_ref="topology-params.j1.yaml")
    assert (
        _resolve_topology_source_pattern("mxl-videotest-view", "source-a", str(tmp_path))
        == "smpte"
    )


# ---------------------------------------------------------------------------
# fix-round r1 (codex 452-r1 gate) — two gaps the r1 gate found:
#
# P2 "single derivation" is asserted only by source inspection: both
# list_instances and list_workloads_grouped visibly pass catalog_dir to
# _service_to_instance, but nothing had ever exercised BOTH real list
# functions against the same fixture and compared their outputs.
#
# P2 "None on miss" boundary: the paired mutation tests above cover a wrong
# id, a wrong parent key, and a missing topology_ref — never a genuinely
# ABSENT tag (topology_parent_key/topology_source_id is None, the ordinary
# case for a non-topology-spawned instance).
# ---------------------------------------------------------------------------


def test_topology_source_pattern_none_when_parent_key_is_none(tmp_path: Path):
    _write_parent_entry(tmp_path)
    (tmp_path / "topology-params.j1.yaml").write_text(_TOPOLOGY_J1)
    # No topology-parent: tag at all (an ordinary, never-topology-spawned
    # instance) — genuinely nothing to resolve from.
    assert _resolve_topology_source_pattern(None, "source-a", str(tmp_path)) is None


def test_topology_source_pattern_none_when_source_id_is_none(tmp_path: Path):
    _write_parent_entry(tmp_path)
    (tmp_path / "topology-params.j1.yaml").write_text(_TOPOLOGY_J1)
    # No topology-source: tag at all.
    assert _resolve_topology_source_pattern("mxl-videotest-view", None, str(tmp_path)) is None


def test_topology_source_pattern_agrees_between_flat_and_grouped_reads(monkeypatch, tmp_path: Path):
    """umbrella #452 fix-round r1 (codex P2): list_instances (flat) and
    list_workloads_grouped both claim to build their instance dicts through
    the SAME _service_to_instance call — this is the test that makes that a
    fact about the real functions, not an inspection of the source. Exercises
    BOTH against the identical NetBox + catalog fixture and asserts the same
    instance's topology_source_pattern is present and EQUAL in both reads.
    """
    _write_parent_entry(tmp_path)
    (tmp_path / "topology-params.j1.yaml").write_text(_TOPOLOGY_J1)

    def fake_request(netbox_url, netbox_token, path, ssl_context=None):
        return {
            "results": [
                _service(
                    "mxl-videotest-view-source-a",
                    [
                        "dmf-catalog",
                        "app:mxl-videotest-view-source-a",
                        "lifecycle:active",
                        "workload:test",
                        "topology-parent:mxl-videotest-view",
                        "topology-source:source-a",
                    ],
                ),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)

    flat = list_instances(
        "http://netbox.test", "tok", True, None, catalog_dir=str(tmp_path)
    )
    grouped = list_workloads_grouped(
        "http://netbox.test", "tok", True, None, catalog_dir=str(tmp_path)
    )

    flat_pattern = flat["instances"][0]["topology_source_pattern"]
    grouped_pattern = grouped["workloads"][0]["instances"][0]["topology_source_pattern"]

    assert flat_pattern == "smpte"
    assert grouped_pattern == "smpte"
    assert flat_pattern == grouped_pattern
