"""ADR-0046 decisions 3 + 5 — workload-first grouping + grouped API tests.

Exercises the NEW grouped endpoint /api/media-workloads/grouped and the
underlying list_workloads_grouped() logic. The existing flat endpoint
and its tests in test_media_workloads.py are UNTOUCHED.

Discriminating cases:
- Identity-join: two instances of the same function_key in DIFFERENT
  workloads must NOT collapse (fails on app-label rollup).
- Invalid-multiple workload tags → degraded, never multi-placed.
- Unassigned bucket for zero-workload services.
- Workload lifecycle derivation (provision / configure / operate).
- Finalise is NEVER inferred from absence.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from dmf_cms import netbox as netbox_module
from dmf_cms import prometheus as prometheus_module
from dmf_cms.main import create_app
from dmf_cms.media_workloads import (
    _derive_workload_lifecycle,
    _workload_assignment,
    list_workloads_grouped,
)
from dmf_cms.settings import MediaTenancySettings, NetboxSettings, Settings


ENGINEER = ("dmf-console-engineer",)


def _client(tenancy: MediaTenancySettings, groups=ENGINEER, netbox=True) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="tok") if netbox else NetboxSettings(),
        media_tenancy=tenancy,
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def _service(
    name: str,
    tags: list[str],
    device: str = "node-1",
    svc_id: int = 1,
    custom_fields: dict | None = None,
) -> dict:
    return {
        "id": svc_id,
        "name": name,
        "tags": [{"name": t} for t in tags],
        "device": {"name": device},
        "ports": [9000],
        "protocol": {"value": "tcp"},
        "custom_fields": custom_fields or {},
    }


# ── Unit tests: _workload_assignment ───────────────────────────────────


def test_workload_assignment_single_tag():
    slug, status = _workload_assignment(["workload:videotest", "dmf-catalog"])
    assert slug == "videotest"
    assert status == "ok"


def test_workload_assignment_no_tag():
    slug, status = _workload_assignment(["dmf-catalog", "app:mxl-videotestsrc"])
    assert slug == "unassigned"
    assert status == "unassigned"


def test_workload_assignment_multiple_tags():
    slug, status = _workload_assignment(
        ["workload:alpha", "workload:beta", "dmf-catalog"]
    )
    assert status == "invalid-multiple"


# ── Unit tests: _derive_workload_lifecycle ─────────────────────────────


def _inst(requested: str = "bootstrapped", observed: str = "unknown",
          reconcile: bool = False) -> dict:
    return {
        "requested_state": requested,
        "observed_state": observed,
        "reconcile_pending": reconcile,
    }


def test_lifecycle_provision_all_bootstrapped():
    assert _derive_workload_lifecycle([_inst("bootstrapped"), _inst("bootstrapped")]) == "provision"


def test_lifecycle_configure_active_but_not_healthy():
    assert _derive_workload_lifecycle([
        _inst("active", "unknown", reconcile=True),
        _inst("active", "unknown", reconcile=True),
    ]) == "configure"


def test_lifecycle_operate_all_active_and_healthy():
    assert _derive_workload_lifecycle([
        _inst("active", "running"),
        _inst("active", "running"),
    ]) == "operate"


def test_lifecycle_configure_mixed_active_and_bootstrapped():
    assert _derive_workload_lifecycle([
        _inst("active", "running"),
        _inst("bootstrapped"),
    ]) == "configure"


def test_lifecycle_never_infers_finalise():
    """Absence of signals must NOT produce 'finalise'."""
    result = _derive_workload_lifecycle([_inst("unknown")])
    assert result != "finalise"


def test_lifecycle_empty_is_unknown():
    assert _derive_workload_lifecycle([]) == "unknown"


# ── Grouping integration tests ─────────────────────────────────────────


def test_grouped_basic_workload_grouping(monkeypatch):
    """Instances with workload:<slug> tag are grouped correctly."""
    def fake_request(*args, **kwargs):
        return {
            "results": [
                _service("mxl-videotestsrc",
                         ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:active", "workload:videotest"],
                         svc_id=1),
                _service("mxl-videotest-view",
                         ["dmf-catalog", "app:mxl-videotest-view", "lifecycle:active", "workload:videotest"],
                         svc_id=2),
                _service("nmos-cpp",
                         ["dmf-catalog", "app:nmos-cpp", "lifecycle:bootstrapped"],
                         svc_id=3),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    result = list_workloads_grouped("http://nb", "tok", True, None)

    assert result["degraded"] is False
    slugs = {w["slug"] for w in result["workloads"]}
    assert "videotest" in slugs
    assert "unassigned" in slugs

    videotest = next(w for w in result["workloads"] if w["slug"] == "videotest")
    assert len(videotest["instances"]) == 2
    instance_names = {i["instance"] for i in videotest["instances"]}
    assert instance_names == {"mxl-videotestsrc", "mxl-videotest-view"}

    unassigned = next(w for w in result["workloads"] if w["slug"] == "unassigned")
    assert len(unassigned["instances"]) == 1
    assert unassigned["instances"][0]["instance"] == "nmos-cpp"
    assert unassigned["name"] == "Unassigned"


def test_grouped_invalid_multiple_not_multi_placed(monkeypatch):
    """Instance with >1 workload:* tag → degraded, surfaced with conflicting slugs."""
    def fake_request(*args, **kwargs):
        return {
            "results": [
                _service("bad-svc",
                         ["dmf-catalog", "app:bad", "lifecycle:active",
                          "workload:alpha", "workload:beta"],
                         svc_id=1),
                _service("good-svc",
                         ["dmf-catalog", "app:good", "lifecycle:bootstrapped", "workload:ok"],
                         svc_id=2),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    result = list_workloads_grouped("http://nb", "tok", True, None)

    assert result["degraded"] is True

    # Invalid instances surfaced with conflicting workload slugs
    assert len(result["invalid_instances"]) == 1
    bad = result["invalid_instances"][0]
    assert bad["instance"] == "bad-svc"
    assert set(bad["conflicting_workloads"]) == {"alpha", "beta"}

    # The invalid instance must NOT appear in any workload
    all_instances = []
    for w in result["workloads"]:
        all_instances.extend(i["instance"] for i in w["instances"])
    assert "bad-svc" not in all_instances

    # The good workload still appears (valid workloads NOT hidden)
    ok_wl = next((w for w in result["workloads"] if w["slug"] == "ok"), None)
    assert ok_wl is not None
    assert len(ok_wl["instances"]) == 1


def test_grouped_identity_join_no_collapse(monkeypatch):
    """DISCRIMINATING: two instances of the same function_key in DIFFERENT
    workloads must NOT collapse in observed state.

    Uses the REAL Prometheus label shape: instance = full probe target URL
    (e.g. 'src-prod.mxl.svc.cluster.local:9000/status'). No cluster_service
    label exists on the metric. The join goes through NetBox custom_fields
    cluster_service → extracted leading DNS label of the instance target.

    Must FAIL on app-label rollup (both would be failing since min(1,0)=0)
    AND on the old cluster_service-label-only code (would match nothing).
    """
    def fake_netbox(*args, **kwargs):
        return {
            "results": [
                _service("src-prod",
                         ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:active", "workload:production"],
                         svc_id=1,
                         custom_fields={"cluster_service": "src-prod", "cluster_namespace": "mxl", "cluster_port": 9000}),
                _service("src-staging",
                         ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:active", "workload:staging"],
                         svc_id=2,
                         custom_fields={"cluster_service": "src-staging", "cluster_namespace": "mxl", "cluster_port": 9000}),
            ]
        }

    def fake_prometheus(*args, **kwargs):
        # Real label shape: instance = full probe target, app = shared key
        return [
            {"metric": {"instance": "src-prod.mxl.svc.cluster.local:9000/status",
                        "app": "mxl-videotestsrc", "job": "netbox-probe"},
             "value": [0, "1"]},
            {"metric": {"instance": "src-staging.mxl.svc.cluster.local:9000/status",
                        "app": "mxl-videotestsrc", "job": "netbox-probe"},
             "value": [0, "0"]},
        ]

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", fake_prometheus)

    result = list_workloads_grouped("http://nb", "tok", True, None, prometheus_url="http://prom")

    prod_wl = next(w for w in result["workloads"] if w["slug"] == "production")
    staging_wl = next(w for w in result["workloads"] if w["slug"] == "staging")

    # The discriminating assertion: same function_key, different identity
    prod_inst = prod_wl["instances"][0]
    staging_inst = staging_wl["instances"][0]
    assert prod_inst["observed_state"] == "running"
    assert staging_inst["observed_state"] == "failing"
    # If we used app-label rollup, BOTH would be "failing" (min of the two)


def test_grouped_single_service_operate_with_real_labels(monkeypatch):
    """A single healthy active service resolves to operate with real-shaped labels.

    This is the today-bug repro: with the old cluster_service-label code,
    the join would match nothing → observed stays unknown → lifecycle=configure
    instead of operate.
    """
    def fake_netbox(*args, **kwargs):
        return {
            "results": [
                _service("mxl-videotestsrc",
                         ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:active", "workload:videotest"],
                         svc_id=1,
                         custom_fields={"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl", "cluster_port": 9000}),
            ]
        }

    def fake_prometheus(*args, **kwargs):
        return [
            {"metric": {"instance": "mxl-videotestsrc.mxl.svc.cluster.local:9000/status",
                        "app": "mxl-videotestsrc", "job": "netbox-probe"},
             "value": [0, "1"]},
        ]

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", fake_prometheus)

    result = list_workloads_grouped("http://nb", "tok", True, None, prometheus_url="http://prom")

    wl = result["workloads"][0]
    assert wl["slug"] == "videotest"
    assert wl["instances"][0]["observed_state"] == "running"
    assert wl["lifecycle"] == "operate"


def test_grouped_lifecycle_derivation(monkeypatch):
    """Workload lifecycle derived from member states."""
    def fake_request(*args, **kwargs):
        return {
            "results": [
                # All bootstrapped → provision
                _service("a1", ["dmf-catalog", "app:a", "lifecycle:bootstrapped", "workload:prov-wl"], svc_id=1),
                _service("a2", ["dmf-catalog", "app:a", "lifecycle:bootstrapped", "workload:prov-wl"], svc_id=2),
                # All active + healthy → operate
                _service("b1", ["dmf-catalog", "app:b", "lifecycle:active", "workload:op-wl"], svc_id=3,
                         custom_fields={"cluster_service": "b1", "cluster_namespace": "mxl", "cluster_port": 9000}),
            ]
        }

    def fake_prometheus(*args, **kwargs):
        # Real label shape: instance = full probe target
        return [
            {"metric": {"instance": "b1.mxl.svc.cluster.local:9000", "app": "b", "job": "netbox-probe"}, "value": [0, "1"]},
        ]

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    monkeypatch.setattr(prometheus_module, "query", fake_prometheus)

    result = list_workloads_grouped("http://nb", "tok", True, None, prometheus_url="http://prom")

    prov_wl = next(w for w in result["workloads"] if w["slug"] == "prov-wl")
    assert prov_wl["lifecycle"] == "provision"

    op_wl = next(w for w in result["workloads"] if w["slug"] == "op-wl")
    assert op_wl["lifecycle"] == "operate"


def test_grouped_unassigned_bucket_name(monkeypatch):
    """Services with no workload:* tag go to 'unassigned' bucket with display name."""
    def fake_request(*args, **kwargs):
        return {
            "results": [
                _service("nmos-cpp", ["dmf-catalog", "app:nmos-cpp", "lifecycle:bootstrapped"], svc_id=1),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    result = list_workloads_grouped("http://nb", "tok", True, None)

    assert len(result["workloads"]) == 1
    wl = result["workloads"][0]
    assert wl["slug"] == "unassigned"
    assert wl["name"] == "Unassigned"


def test_grouped_netbox_unreachable_degrades(monkeypatch):
    """NetBox failure → degraded payload, never raw 500."""
    def boom(*args, **kwargs):
        raise netbox_module.NetboxAPIError(502, "service unavailable")

    monkeypatch.setattr(netbox_module, "_request", boom)
    result = list_workloads_grouped("http://nb", "tok", True, None)

    assert result["degraded"] is True
    assert result["reason"] == "netbox-unreachable"
    assert result["workloads"] == []


# ── API endpoint tests ─────────────────────────────────────────────────


def test_grouped_endpoint_anonymous_is_401():
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        media_tenancy=MediaTenancySettings(mode="single"),
    )
    client = TestClient(create_app(settings=settings))
    assert client.get("/api/media-workloads/grouped").status_code == 401


def test_grouped_endpoint_tenancy_not_configured():
    client = _client(MediaTenancySettings(mode=""))
    resp = client.get("/api/media-workloads/grouped")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is False
    assert body["reason"] == "media-tenancy-not-configured"


def test_grouped_endpoint_success(monkeypatch):
    def fake_request(*args, **kwargs):
        return {
            "results": [
                _service("mxl-videotestsrc",
                         ["dmf-catalog", "app:mxl-videotestsrc", "lifecycle:active", "workload:videotest"],
                         svc_id=1),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(MediaTenancySettings(mode="single"))
    resp = client.get("/api/media-workloads/grouped")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is True
    assert body["scope"] == "all"
    assert len(body["workloads"]) == 1
    assert body["workloads"][0]["slug"] == "videotest"


def test_grouped_endpoint_does_not_affect_flat(monkeypatch):
    """The grouped endpoint must not change the flat /api/media-workloads response."""
    def fake_request(*args, **kwargs):
        return {
            "results": [
                _service("nmos-cpp",
                         ["dmf-catalog", "app:nmos-cpp", "lifecycle:bootstrapped"],
                         svc_id=1),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    client = _client(MediaTenancySettings(mode="single"))

    flat = client.get("/api/media-workloads").json()
    assert "instances" in flat
    assert "workloads" not in flat

    grouped = client.get("/api/media-workloads/grouped").json()
    assert "workloads" in grouped
    assert "instances" not in grouped
