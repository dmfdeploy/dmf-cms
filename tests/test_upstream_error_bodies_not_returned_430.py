"""Upstream error bodies never reach API clients (#430).

AWX and Authentik error pages are untrusted text. Each handler below used to
embed ``exc.body`` in its JSON response. A unique sentinel body proves the
client now gets a stable message and a status, while the detail goes to the
server log only.
"""

from __future__ import annotations

import logging
import urllib.error
import io
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
from dmf_cms import security
from dmf_cms.authentik import AuthentikAPIError
from dmf_cms.awx import AWXAPIError
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import AuthentikSettings, AWXSettings, L3Settings, OIDCSettings, Settings

SENTINEL = "SENTINEL-upstream-body-7f3a91"
OPERATOR = ("dmf-console-operator",)
ADMIN = ("dmf-console-admin",)
RUN_ID = "a" * 32


def _client(groups, **extra) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        l3=L3Settings(enabled=False),
        **extra,
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def _boom(*_a, **_k):
    raise AWXAPIError(503, SENTINEL)


@pytest.fixture(autouse=True)
def _awx_fails(monkeypatch):
    entry = CatalogEntry(
        key="mxl-videotest-view",
        display_name="MXL video test view",
        summary="",
        configure={"awx_job_template": "dmf-configure"},
        finalise={"awx_job_template": "dmf-finalise"},
    )
    monkeypatch.setattr(main, "load_catalog_entries", lambda *a, **k: [entry])
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: None)
    monkeypatch.setattr(main, "launch_job", _boom)
    monkeypatch.setattr(main, "list_job_templates", _boom)
    monkeypatch.setattr(main, "get_job_status", _boom)


def _assert_sanitised(resp, status=503):
    assert resp.status_code == status
    assert SENTINEL not in resp.text
    assert resp.json().get("error") == "upstream request failed"


POSTS = [
    ("/api/workflows/dmf-provision/launch", "launch"),
    ("/api/catalog/mxl-videotest-view/deploy", "deploy"),
    ("/api/catalog/mxl-videotest-view/teardown", "teardown"),
    (f"/api/runs/{RUN_ID}/rollback", "rollback"),
]


@pytest.mark.parametrize("path,_name", POSTS)
def test_write_error_returns_stable_message(path, _name, caplog):
    client = _client(OPERATOR)
    with caplog.at_level(logging.ERROR, logger="dmf_cms.main"):
        resp = client.post(path, json={"reason": "x"})
    _assert_sanitised(resp)
    assert resp.json()["request_id"]
    # The detail is kept for operators, in the server log.
    assert SENTINEL in caplog.text


def test_workflows_list_error_is_sanitised():
    _assert_sanitised(_client(OPERATOR).get("/api/workflows"))


def test_workflow_job_status_error_is_sanitised():
    _assert_sanitised(_client(OPERATOR).get("/api/workflows/jobs/5"))


def test_catalog_job_status_error_omits_body():
    resp = _client(OPERATOR).get("/api/catalog/mxl-videotest-view/status/5")
    assert resp.status_code == 200
    assert SENTINEL not in resp.text
    assert resp.json()["status"] == "error"


def test_admin_groups_error_is_sanitised(monkeypatch):
    def boom(**_k):
        raise AuthentikAPIError(502, SENTINEL)

    monkeypatch.setattr(main, "list_groups", boom)
    client = _client(
        ADMIN, authentik=AuthentikSettings(api_url="http://ak.test", api_token="t")
    )
    resp = client.get("/api/admin/groups")
    _assert_sanitised(resp, status=502)


def test_oidc_token_exchange_error_omits_upstream_body(caplog):
    err = urllib.error.HTTPError(
        "http://idp.test/token", 400, "bad", {}, io.BytesIO(SENTINEL.encode())
    )
    oidc = OIDCSettings(
        enabled=True, issuer_url="http://idp.test", client_id="c", client_secret="s",
    )
    with patch("urllib.request.urlopen", side_effect=err):
        with caplog.at_level(logging.ERROR, logger="dmf_cms.security"):
            with pytest.raises(RuntimeError) as info:
                security.exchange_code_for_token(
                    {"token_endpoint": "http://idp.test/token"}, oidc, "code",
                    "http://x/cb", None,
                )
    assert SENTINEL not in str(info.value)
    assert "400" in str(info.value)
    assert SENTINEL in caplog.text
