"""Status pollers degrade, not 500, when AWX is asleep or unreachable (#292).

AWX at zero replicas refuses connections (``URLError(ConnectionRefusedError)``)
and a half-woken AWX can time out. Both are expected states. The three
pollers must answer with a defined degraded body and never raise.
"""

from __future__ import annotations

import urllib.error

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
from dmf_cms.main import create_app
from dmf_cms.settings import AWXAutoscaleSettings, AWXSettings, Settings

ADMIN = ("dmf-console-admin",)

FAILURES = [
    pytest.param(
        urllib.error.URLError(ConnectionRefusedError(111, "refused")),
        "awx-not-running",
        id="url-error-refused",
    ),
    pytest.param(ConnectionRefusedError(111, "refused"), "awx-not-running", id="refused"),
    pytest.param(urllib.error.URLError("name resolution"), "awx-unreachable", id="url-error"),
    pytest.param(TimeoutError("timed out"), "awx-unreachable", id="timeout"),
]


def _client() -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=ADMIN,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(
            enabled=True, helper_url="http://helper.test", bearer_token="b"
        ),
    )
    # raise_server_exceptions=True (default): an escaped exception fails the test.
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def _raiser(exc):
    def fn(**_k):
        raise exc

    return fn


@pytest.mark.parametrize("exc,reason", FAILURES)
def test_workflows_list_degrades(monkeypatch, exc, reason):
    monkeypatch.setattr(main, "list_job_templates", _raiser(exc))
    resp = _client().get("/api/workflows")
    assert resp.status_code == 200
    assert resp.json() == {"templates": [], "reason": reason}


@pytest.mark.parametrize("exc,reason", FAILURES)
def test_admin_health_reports_awx_state(monkeypatch, exc, reason):
    monkeypatch.setattr(main, "list_job_templates", _raiser(exc))
    resp = _client().get("/api/admin/health")
    assert resp.status_code == 200
    awx = resp.json()["awx"]
    assert awx["connected"] is False
    assert awx["reason"] == reason
    assert awx["note"]


@pytest.mark.parametrize("exc,reason", FAILURES)
def test_changes_jobs_degrades(monkeypatch, exc, reason):
    # Already fail-soft since #285; pinned here so the contract stays.
    monkeypatch.setattr(main, "list_recent_jobs", _raiser(exc))
    resp = _client().get("/api/changes/jobs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["jobs"] == []
    assert body["reason"] == reason


def test_admin_health_awx_http_error_omits_upstream_body(monkeypatch):
    from dmf_cms.awx import AWXAPIError

    monkeypatch.setattr(main, "list_job_templates", _raiser(AWXAPIError(500, "SENTINEL-292")))
    resp = _client().get("/api/admin/health")
    assert resp.status_code == 200
    assert "SENTINEL-292" not in resp.text
    assert resp.json()["awx"]["connected"] is False
