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
    assert any(p.startswith("/api/dcim/devices/") for p in calls)


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
