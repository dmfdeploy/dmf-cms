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
                _service("mxl-hello", ["dmf-catalog", "app:mxl-hello", "lifecycle:active"]),
                _service("nmos-cpp", ["dmf-catalog", "app:nmos-cpp", "lifecycle:bootstrapped"]),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(MediaTenancySettings(mode="single"))
    body = client.get("/api/media-workloads").json()
    assert body["configured"] is True and body["degraded"] is False
    assert body["scope"] == "all"
    by_name = {i["instance"]: i for i in body["instances"]}
    hello = by_name["mxl-hello"]
    # No prometheus configured: observed stays honest-unknown, and an
    # active-desired instance without runtime proof is reconcile_pending.
    assert hello["requested_state"] == "active"
    assert hello["observed_state"] == "unknown"
    assert hello["reconcile_pending"] is True
    assert by_name["nmos-cpp"]["reconcile_pending"] is False
    assert {f["function_key"] for f in body["functions"]} == {"mxl-hello", "nmos-cpp"}


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
        return {"results": [_service("mxl-hello", ["dmf-catalog", "app:mxl-hello", "lifecycle:active"])]}

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(
        MediaTenancySettings(
            mode="scoped",
            group_tenant_map=(("dmf-console-engineer", ("tenant-a",)),),
        )
    )
    body = client.get("/api/media-workloads").json()
    assert body["scope"] == ["tenant-a"]
    assert [i["instance"] for i in body["instances"]] == ["mxl-hello"]
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
        [_service("mxl-hello", ["dmf-catalog", "app:mxl-hello", "lifecycle:bootstrapped"])],
    )
    client = _writer_client(groups=MEDIA_ENGINEERS)
    resp = client.post("/api/media-workloads/mxl-hello/clear", json={"reason": "go"})
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
    calls = _patch_recorder(monkeypatch, [_service("mxl-hello", ["dmf-catalog", "app:mxl-hello", "lifecycle:bootstrapped"])])
    client = _writer_client(
        tenancy=MediaTenancySettings(mode="scoped", group_tenant_map=(("other", ("t1",)),))
    )
    resp = client.post("/api/media-workloads/mxl-hello/clear", json={"reason": "go"})
    assert resp.status_code == 404
    assert calls["patches"] == []


def test_clear_already_active_409_no_side_effect(monkeypatch):
    calls = _patch_recorder(
        monkeypatch, [_service("mxl-hello", ["dmf-catalog", "app:mxl-hello", "lifecycle:active"])]
    )
    client = _writer_client()
    resp = client.post("/api/media-workloads/mxl-hello/clear", json={"reason": "go"})
    assert resp.status_code == 409
    assert calls["patches"] == []


def test_clear_flips_tag_with_writer_token_and_c5(monkeypatch):
    calls = _patch_recorder(
        monkeypatch,
        [_service("mxl-hello", ["dmf-catalog", "app:mxl-hello", "lifecycle:bootstrapped"])],
    )
    client = _writer_client()
    resp = client.post("/api/media-workloads/mxl-hello/clear", json={"reason": "ready for demo"})
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
    assert "dmf-catalog" in tag_names and "app:mxl-hello" in tag_names
