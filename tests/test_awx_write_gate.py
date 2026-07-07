"""AWX write gate + C5 audit (dmfdeploy/dmfdeploy#185 WP-E).

The three DMF-initiated AWX writes — catalog deploy, catalog teardown, and the
generic workflow launch — were login-only, so a viewer could launch them by
curl. WP-E moves them behind ``_require_min_role(operator)`` and gives them the
same C5 quartet the clear-for-deployment write already carries: a mandatory
``reason`` validated *before* any AWX call, a ``request_id`` echoed on every
path, and an audit line. Coverage:

* a viewer is 403 on all three, and no AWX call is made (the gate fires first);
* an operator passes, and the response echoes ``request_id``;
* a missing / empty reason is 400 with no AWX call;
* an admin viewing-as-viewer is 403 (the B+E composition proof).
"""

from fastapi.testclient import TestClient
import pytest

import dmf_cms.main as main
from dmf_cms.awx import AWXAPIError
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import AWXAutoscaleSettings, AWXSettings, Settings


OPERATOR = ("dmf-console-operator",)
VIEWER = ("dmf-console-viewer",)
ADMIN = ("dmf-console-admin",)


def _client(groups, *, awx=True, autoscale=False) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t") if awx else AWXSettings(),
        awx_autoscale=AWXAutoscaleSettings(
            enabled=True, helper_url="http://helper.test", bearer_token="b"
        ) if autoscale else AWXAutoscaleSettings(enabled=False),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)  # dev login -> session
    return client


@pytest.fixture
def awx_spy(monkeypatch):
    """Spy on the AWX actuator so a test can assert it was (not) called.

    Patches the names as imported into ``dmf_cms.main``. The template lookup
    returns a live template and no in-flight job, so a gated-through request
    reaches ``launch_job`` — which records the call instead of hitting AWX.
    """
    calls = {"launch": 0}

    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: None)

    def fake_launch(**kwargs):
        calls["launch"] += 1
        return 4242

    monkeypatch.setattr(main, "launch_job", fake_launch)
    # deploy / teardown resolve a catalog entry before dispatch.
    entry = CatalogEntry(
        key="mxl-videotest-view",
        display_name="MXL video test view",
        summary="MXL video test view",
        configure={"awx_job_template": "dmf-configure"},
        finalise={"awx_job_template": "dmf-finalise"},
    )
    monkeypatch.setattr(main, "load_catalog_entries", lambda: [entry])
    return calls


# The three writes, addressed uniformly. deploy/teardown carry a catalog key;
# launch carries a workflow name.
WRITES = [
    ("deploy", "/api/catalog/mxl-videotest-view/deploy"),
    ("teardown", "/api/catalog/mxl-videotest-view/teardown"),
    ("launch", "/api/workflows/dmf-provision/launch"),
]


@pytest.mark.parametrize("_name,path", WRITES)
def test_viewer_forbidden_and_no_awx_call(awx_spy, _name, path):
    client = _client(VIEWER)
    resp = client.post(path, json={"reason": "trying"})
    assert resp.status_code == 403
    assert awx_spy["launch"] == 0  # gate fires before any actuator call


@pytest.mark.parametrize("_name,path", WRITES)
def test_operator_passes_and_request_id_echoed(awx_spy, _name, path):
    client = _client(OPERATOR)
    resp = client.post(path, json={"reason": "scheduled provision"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "launched"
    assert body["job_id"] == 4242
    assert body["request_id"]  # C5: echoed on the success path
    assert awx_spy["launch"] == 1


@pytest.mark.parametrize("_name,path", WRITES)
def test_missing_reason_is_400_with_no_awx_call(awx_spy, _name, path):
    client = _client(OPERATOR)
    for body in ({}, {"reason": ""}, {"reason": "   "}):
        resp = client.post(path, json=body)
        assert resp.status_code == 400, body
        assert resp.json()["error"] == "reason-required"
    assert awx_spy["launch"] == 0  # reason precondition fires before AWX


@pytest.mark.parametrize("_name,path", WRITES)
def test_admin_view_as_viewer_is_forbidden(awx_spy, _name, path):
    # B+E composition: an admin who downgrades to viewer is 403 server-side on
    # the write — the gate reads the EFFECTIVE role, not the real one.
    client = _client(ADMIN)
    client.post("/api/me/view-as", json={"role": "viewer"})
    resp = client.post(path, json={"reason": "should not pass"})
    assert resp.status_code == 403
    assert awx_spy["launch"] == 0


# --------------------------------------------------------------------------
# C5 on EVERY post-auth return path (codex WP-E P2-1 / P3): request_id echoed
# + an audit line, including the config-503 early returns; a missing reason is
# still a 400 even when AWX is dark.
# --------------------------------------------------------------------------

def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


@pytest.mark.parametrize("_name,path", WRITES)
def test_awx_not_configured_503_still_reason_gated_audited_and_request_id(awx_spy, caplog, _name, path):
    import logging
    client = _client(OPERATOR, awx=False)
    # Missing reason is a 400 BEFORE the AWX-dark 503 (reason is validated first).
    assert client.post(path, json={}).status_code == 400
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post(path, json={"reason": "why"})
    assert resp.status_code == 503
    assert resp.json()["request_id"]  # echoed even on the dark-AWX path
    assert any("outcome=awx-not-configured" in m for m in _audit_lines(caplog))
    assert awx_spy["launch"] == 0


def test_deploy_entry_not_found_echoes_request_id(awx_spy):
    client = _client(OPERATOR)
    resp = client.post("/api/catalog/does-not-exist/deploy", json={"reason": "x"})
    assert resp.status_code == 404
    assert resp.json()["request_id"]


def test_sync_already_active_echoes_request_id(monkeypatch, awx_spy):
    # An in-flight job for the template → 200 already-active with request_id.
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 999)
    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotest-view/deploy", json={"reason": "x"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "already-active"
    assert body["job_id"] == 999
    assert body["request_id"]
    assert awx_spy["launch"] == 0  # no new launch


def test_sync_awx_error_echoes_request_id(monkeypatch, awx_spy):
    def boom(**kwargs):
        raise AWXAPIError(502, "upstream boom")
    monkeypatch.setattr(main, "launch_job", boom)
    client = _client(OPERATOR)
    resp = client.post("/api/workflows/dmf-provision/launch", json={"reason": "x"})
    assert resp.status_code == 502
    assert resp.json()["request_id"]


def test_async_dispatch_and_reattach_echo_request_id_and_audit(monkeypatch, awx_spy, caplog):
    import logging
    # Autoscale (async) path needs app.state.operations from the lifespan, so
    # use a context-managed client. Hold the wake so the op stays in-flight and
    # the second POST reattaches (200) instead of racing to completion.
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=OPERATOR,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(
            enabled=True, helper_url="http://helper.test", bearer_token="b"
        ),
    )
    with TestClient(create_app(settings=settings)) as client:
        client.get("/auth/login", follow_redirects=False)
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            first = client.post("/api/workflows/dmf-provision/launch", json={"reason": "x"})
            second = client.post("/api/workflows/dmf-provision/launch", json={"reason": "x"})
    assert first.status_code == 202
    assert first.json()["request_id"]
    assert first.json()["operation_id"]
    # Second POST reattaches to the in-flight operation (200), still echoing id.
    assert second.status_code == 200
    assert second.json()["request_id"]
    outcomes = " ".join(_audit_lines(caplog))
    assert "outcome=dispatched" in outcomes
    assert "outcome=reattached" in outcomes


def test_admin_view_as_viewer_audit_shows_real_role(monkeypatch, awx_spy, caplog):
    import logging
    # A real admin (not downgraded) launching records real_role only when a
    # view-as is active; here (no downgrade) the real_role field stays blank.
    client = _client(ADMIN)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        client.post("/api/workflows/dmf-provision/launch", json={"reason": "x"})
    line = next(m for m in _audit_lines(caplog) if "action=launch" in m)
    assert "role=admin" in line and "real_role=" in line
