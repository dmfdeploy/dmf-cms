"""Server-side duplicate-deploy refusal (#341).

``POST /api/catalog/{key}/deploy`` used to read no lifecycle at all, so the
client guard was the only protection against deploying an entry that is
already active. The endpoint now reads the entry's lifecycle from NetBox, the
same source ``GET /api/catalog`` uses, and answers 409 ``entry-already-active``
when it is ``active``. Any other value dispatches, and an in-flight job still
reattaches instead of being refused.
"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
from dmf_cms import netbox
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import (
    AWXAutoscaleSettings,
    AWXSettings,
    L3Settings,
    NetboxSettings,
    Settings,
)

KEY = "mxl-videotest-view"
SERVICE = "mxl-videotest-view-svc"
DEPLOY = f"/api/catalog/{KEY}/deploy"


def _settings(*, autoscale: bool, netbox_configured: bool = True) -> Settings:
    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=("dmf-console-operator",),
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=(
            AWXAutoscaleSettings(enabled=True, helper_url="http://helper.test", bearer_token="b")
            if autoscale
            else AWXAutoscaleSettings(enabled=False)
        ),
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="t") if netbox_configured else NetboxSettings(),
        l3=L3Settings(enabled=False),
    )


@pytest.fixture
def state(monkeypatch):
    """Mutable NetBox lifecycle plus counters for the AWX and NetBox seams."""
    st = {"lifecycle": None, "launch": 0, "netbox_reads": 0, "active_job": None}
    entry = CatalogEntry(
        key=KEY,
        display_name="MXL video test view",
        summary="",
        configure={"awx_job_template": "dmf-configure"},
        finalise={"awx_job_template": "dmf-finalise"},
        provision={"netbox_service": {"name": SERVICE}},
    )
    monkeypatch.setattr(main, "load_catalog_entries", lambda *a, **k: [entry])

    def fake_netbox(api_url, api_token, path, ssl_context=None, method="GET", payload=None):
        st["netbox_reads"] += 1
        tags = [{"name": "dmf-catalog"}]
        if st["lifecycle"] is not None:
            tags.append({"name": f"lifecycle:{st['lifecycle']}"})
        return {"results": [{"name": SERVICE, "tags": tags}]}

    monkeypatch.setattr(netbox, "_request", fake_netbox)
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: st["active_job"])

    def fake_launch(**_k):
        st["launch"] += 1
        return 4242

    monkeypatch.setattr(main, "launch_job", fake_launch)
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "2026-01-01T00:00:00Z", "finished": "2026-01-01T00:05:00Z"},
    )
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    return st


def _post(client: TestClient):
    return client.post(DEPLOY, json={"reason": "scheduled provision"})


def _deploy(settings: Settings, st: dict, lifecycle):
    st["lifecycle"] = lifecycle
    with TestClient(create_app(settings=settings)) as client:
        client.get("/auth/login", follow_redirects=False)
        return _post(client)


MODES = [pytest.param(False, id="sync"), pytest.param(True, id="async")]


@pytest.mark.parametrize("autoscale", MODES)
def test_deploy_of_an_active_entry_is_refused_without_a_launch(state, autoscale, caplog):
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = _deploy(_settings(autoscale=autoscale), state, "active")
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "entry-already-active"
    assert body["lifecycle"] == "active"
    assert body["request_id"]
    assert state["launch"] == 0
    refusals = [
        r.getMessage() for r in caplog.records
        if r.getMessage().startswith("awx write:") and "outcome=entry-already-active" in r.getMessage()
    ]
    assert len(refusals) == 1
    assert "action=deploy" in refusals[0]


# A first deploy (no lifecycle tag yet), a provisioned-but-not-configured
# entry, a torn-down entry and a failed NetBox read must all still dispatch.
@pytest.mark.parametrize("autoscale", MODES)
@pytest.mark.parametrize("lifecycle", [None, "bootstrapped", "finalised"])
def test_deploy_of_a_non_active_entry_still_dispatches(state, autoscale, lifecycle):
    resp = _deploy(_settings(autoscale=autoscale), state, lifecycle)
    assert resp.status_code in (200, 202), resp.text
    assert resp.json().get("error") is None


@pytest.mark.parametrize("autoscale", MODES)
def test_netbox_read_failure_does_not_block_a_deploy(state, monkeypatch, autoscale):
    def boom(*_a, **_k):
        raise netbox.NetboxAPIError(500, "boom")

    monkeypatch.setattr(netbox, "_request", boom)
    with TestClient(create_app(settings=_settings(autoscale=autoscale))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client)
    assert resp.status_code in (200, 202), resp.text


@pytest.mark.parametrize("autoscale", MODES)
def test_netbox_not_configured_skips_the_lifecycle_read(state, autoscale):
    resp = _deploy(_settings(autoscale=autoscale, netbox_configured=False), state, "active")
    assert resp.status_code in (200, 202), resp.text
    assert state["netbox_reads"] == 0


def test_sync_in_flight_job_still_reattaches_when_the_entry_is_active(state):
    state["active_job"] = 99
    resp = _deploy(_settings(autoscale=False), state, "active")
    assert resp.status_code == 200
    assert resp.json()["status"] == "already-active"
    assert state["launch"] == 0


def test_async_refusal_releases_the_exclusive_lock(state):
    # The refused request created an operation first; it must end ERROR, or
    # the (deploy, entry) lock would block every later deploy until GC.
    state["lifecycle"] = "active"
    with TestClient(create_app(settings=_settings(autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        assert _post(client).status_code == 409
        state["lifecycle"] = "finalised"
        resp = _post(client)
    assert resp.status_code == 202, resp.text
