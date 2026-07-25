"""GET/POST /api/media-workloads/{instance}/topology + /switch-source
(umbrella #201 WP5, spec §7 — console switch surface).

The domain command/status machine/actuator all live in switch_source.py
(WP4, own coverage in test_switch_source.py) — this file covers the THIN
console seam main.py adds on top: the topology-read seam the switch UI
needs (not itself spec-enumerated — see api_media_workloads_topology's own
docstring), the write's access gate, the C5 pattern (_require_reason + the
new _require_source_instance + _audit_awx_write), and translating
SwitchSourceError/SwitchStatus onto HTTP.

Mocking convention: ``load_catalog_entries``/``load_topology_instance`` are
monkeypatched directly on the ``switch_source`` module (not ``catalog``) —
switch_source.py imports them by name (``from .catalog import ...``), a
name-bound copy that does NOT re-resolve through the catalog module, and
(codex-relevant gotcha) ``CATALOG_DIR`` is baked into
``resolve_topology_for_receiver``/``dispatch_switch_source`` as a DEFAULT
ARGUMENT VALUE at import time — monkeypatching the constant after import
would silently not take effect, so the loader FUNCTIONS are patched
instead, same as test_topology_seam.py's own convention for NetBox's
list_sites. AWX calls are monkeypatched on the ``awx`` module directly, same
as test_switch_source.py's own actuator tests.

Lifespan gotcha (dmf-cms-frontend/backend test conventions): ``app.state.
switch_commands`` is only populated once the app's ``lifespan`` context has
actually run, which a bare ``TestClient(app)`` does NOT trigger — only
``with TestClient(app) as client:`` does (see test_rollback_command.py's own
split between plain ``_client()`` for early-return-only paths and
``with TestClient(...) as client:`` for anything that reaches a real
dispatch). Every test here that reaches ``dispatch_switch_source`` (i.e.
passes the reason/source_instance/awx-configured gates) uses the ``with``
form; pure gate-rejection tests (403/400/503) use the plain client.
"""

import logging

import pytest
from fastapi.testclient import TestClient

from dmf_cms import awx
from dmf_cms import switch_source
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import AWXSettings, Settings

ENGINEER = ("dmf-console-engineer",)
VIEWER = ("dmf-console-viewer",)
MEDIA_ENGINEERS = ("media-engineers",)

J1_TOPOLOGY_PARAMS = {
    "schema_version": 1,
    "target_facility": "dmf-example-site",
    "sources": [
        {"id": "source-a", "flow_id": "5fbec3b1-1b0f-417d-9059-8b94a47197ed", "pattern": "smpte"},
        {"id": "source-b", "flow_id": "b0ae9cba-a989-4568-ac96-8bd19272c966", "pattern": "ball"},
    ],
    "viewer": {"id": "viewer-a", "source_selection": "source-a"},
}

VIEWER_ENTRY = CatalogEntry(
    key="mxl-videotest-view", display_name="Viewer", summary="x",
    topology_ref="topology-params.j1.yaml",
)
NO_TOPOLOGY_ENTRY = CatalogEntry(key="mxl-videotest-view", display_name="Viewer", summary="x")


def _patch_catalog(monkeypatch, *, entries, topology_ok=True, topology_error="broken"):
    def fake_load_topology_instance(catalog_dir, topology_ref):
        if topology_ok:
            return dict(J1_TOPOLOGY_PARAMS), None
        return None, topology_error

    monkeypatch.setattr(switch_source, "load_catalog_entries", lambda catalog_dir: entries)
    monkeypatch.setattr(switch_source, "load_topology_instance", fake_load_topology_instance)


def _mock_awx_terminal(monkeypatch, *, status="successful"):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: {"status": status})


def _settings(groups=ENGINEER, *, awx_configured=True) -> Settings:
    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t") if awx_configured else AWXSettings(),
    )


def _client(groups=ENGINEER, *, awx_configured=True) -> TestClient:
    """For gate-rejection tests that never reach a real dispatch (403/400/503) —
    does NOT trigger lifespan, so app.state.switch_commands is never touched."""
    client = TestClient(create_app(settings=_settings(groups, awx_configured=awx_configured)))
    client.get("/auth/login", follow_redirects=False)
    return client


def _dispatch_client(groups=ENGINEER) -> TestClient:
    """For tests that reach dispatch_switch_source — caller must use this as
    ``with _dispatch_client() as client:`` so lifespan actually runs."""
    return TestClient(create_app(settings=_settings(groups)))


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


def _post(client, instance="mxl-videotest-view", body=None):
    return client.post(f"/api/media-workloads/{instance}/switch-source", json=body or {})


# ── authz gate ────────────────────────────────────────────────────────


def test_viewer_without_media_engineers_is_403(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])

    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog before the authz gate")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client(VIEWER)
    resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    assert resp.status_code == 403


def test_real_media_engineers_group_grants_access_without_role(monkeypatch, caplog):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _mock_awx_terminal(monkeypatch)
    with _dispatch_client(MEDIA_ENGINEERS) as client:
        client.get("/auth/login", follow_redirects=False)
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    assert resp.status_code == 200
    body = resp.json()
    # C5 records the member's true capability role (viewer), matching
    # clear-for-deployment's own media-engineers precedent.
    assert body["role"] == "viewer"


# ── C5 request-shape gates — before any dispatch ────────────────────────


def test_reason_required_400_before_dispatch(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])

    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog before reason is validated")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client()
    resp = _post(client, body={"source_instance": "source-b"})
    assert resp.status_code == 400
    assert resp.json()["error"] == "reason-required"


def test_source_instance_required_400_before_dispatch(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog before source_instance is validated")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client()
    for bad_body in [{"reason": "go"}, {"reason": "go", "source_instance": ""}, {"reason": "go", "source_instance": "  "}]:
        resp = _post(client, body=bad_body)
        assert resp.status_code == 400, bad_body
        assert resp.json()["error"] == "source-instance-required"


def test_awx_not_configured_503_before_dispatch(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog when AWX isn't configured")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client(awx_configured=False)
    resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    assert resp.status_code == 503
    assert resp.json()["error"] == "AWX API not configured"


# ── request-shape validation past the gates, before a command is created


def test_receiver_not_found_is_404(monkeypatch):
    _patch_catalog(monkeypatch, entries=[])
    with _dispatch_client() as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, instance="does-not-exist", body={"source_instance": "source-a", "reason": "go"})
    assert resp.status_code == 404
    assert resp.json()["error"] == "receiver-not-found"
    assert resp.json()["request_id"]


def test_receiver_without_topology_ref_is_404(monkeypatch):
    _patch_catalog(monkeypatch, entries=[NO_TOPOLOGY_ENTRY])
    with _dispatch_client() as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, body={"source_instance": "source-a", "reason": "go"})
    assert resp.status_code == 404
    assert resp.json()["error"] == "receiver-not-topology"


def test_invalid_topology_params_is_422(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY], topology_ok=False, topology_error="schema_version must equal 1")
    with _dispatch_client() as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, body={"source_instance": "source-a", "reason": "go"})
    assert resp.status_code == 422
    assert resp.json()["error"] == "topology-invalid"
    assert "schema_version" in resp.json()["detail"]


def test_unknown_source_instance_is_422(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    with _dispatch_client() as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, body={"source_instance": "does-not-exist", "reason": "go"})
    assert resp.status_code == 422
    assert resp.json()["error"] == "source-not-found"


# ── happy path + C5 audit content ────────────────────────────────────────


def test_happy_path_reaches_active_with_c5_audit(monkeypatch, caplog):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _mock_awx_terminal(monkeypatch, status="successful")
    with _dispatch_client() as client:
        client.get("/auth/login", follow_redirects=False)
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = _post(client, body={"source_instance": "source-b", "reason": "operator requested"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "active"
    assert body["error"] is None
    assert body["receiver_instance"] == "mxl-videotest-view"
    assert body["source_instance"] == "source-b"
    assert body["previous_source"] == "source-a"
    assert body["reason"] == "operator requested"
    assert body["actor"] == "operator"
    assert body["role"] == "engineer"
    assert body["request_id"]
    assert body["command_id"]

    lines = _audit_lines(caplog)
    assert len(lines) == 1
    line = lines[0]
    assert "action=switch-source" in line
    assert "actor=operator" in line
    assert "role=engineer" in line
    assert f"request_id={body['request_id']}" in line
    assert "target=mxl-videotest-view" in line
    assert "reason='operator requested'" in line
    assert "outcome=active" in line
    assert "workload=source-b" in line  # source_instance rides the workload slot


def test_failed_rollback_required_is_200_not_an_http_error(monkeypatch, caplog):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _mock_awx_terminal(monkeypatch, status="failed")
    with _dispatch_client() as client:
        client.get("/auth/login", follow_redirects=False)
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    # Not an HTTP error — dispatch_switch_source's own contract: an
    # actuator-level failure is a normal (if unhappy) response.
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed_rollback_required"
    assert body["error"] == "switch-job-failed"
    assert any("outcome=failed_rollback_required" in m for m in _audit_lines(caplog))


# ── GET .../topology — the switch UI's source-discovery read seam ───────


def test_topology_read_requires_media_workloads_access(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog before the authz gate")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client(VIEWER)
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 403


def test_topology_read_happy_path(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    client = _client()
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 200
    body = resp.json()
    assert body["receiver_instance"] == "mxl-videotest-view"
    assert [s["id"] for s in body["sources"]] == ["source-a", "source-b"]
    assert body["active_source"] == "source-a"


def test_topology_read_receiver_not_found_is_404(monkeypatch):
    _patch_catalog(monkeypatch, entries=[])
    client = _client()
    resp = client.get("/api/media-workloads/does-not-exist/topology")
    assert resp.status_code == 404
    assert resp.json()["error"] == "receiver-not-found"


def test_topology_read_receiver_without_topology_ref_is_404(monkeypatch):
    _patch_catalog(monkeypatch, entries=[NO_TOPOLOGY_ENTRY])
    client = _client()
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 404
    assert resp.json()["error"] == "receiver-not-topology"


def test_topology_read_invalid_topology_params_is_422(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY], topology_ok=False, topology_error="schema_version must equal 1")
    client = _client()
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 422
    assert resp.json()["error"] == "topology-invalid"
