"""Workload-tag stamping seam, dmf-cms side (dmfdeploy/dmfdeploy#239 trio).

Console -> AWX launch body contract (fixed across the 3-repo trio, do not
rename): {"extra_vars": {"workload_slug": "<slug>"}} included ONLY when the
operator supplied a workload, else body stays exactly {} (bit-compatible with
pre-#239 behaviour). Slug rule: ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$.

Two layers:
* unit — launch_job's body construction, mocking the HTTP transport directly;
* integration — /api/catalog/{key}/deploy, both the sync (autoscale-disabled)
  and async (autoscale-enabled) flows, via the launch_job spy pattern already
  established in test_awx_write_gate.py.

Umbrella #202 WP1-B note: this file's fixtures explicitly set
``l3=L3Settings(enabled=False)`` — L3's one documented kill switch (R2-1) —
since R2-1 made "l3.enabled=True but Prometheus unconfigured" a fail-closed
409 rather than a skip, and this file tests the #239 workload seam, not L3.
A skipped envelope (l3_request_id + l3_preflight_verdict='skipped') still
merges into extra_vars alongside workload_slug (or alone, when no workload
was sent), per the plan §3.2 divergence-report's need to correlate a
"console run, preflight skipped" launch by request_id. See
_assert_skipped_l3_envelope.
"""

import logging
import time

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
from dmf_cms import awx
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.operations import OperationState
from dmf_cms.settings import AWXAutoscaleSettings, AWXSettings, L3Settings, Settings


OPERATOR = ("dmf-console-operator",)


# --------------------------------------------------------------------------
# Unit: launch_job body construction
# --------------------------------------------------------------------------

def test_launch_job_body_empty_when_no_extra_vars(monkeypatch):
    calls = []

    def fake_request(api_url, api_token, method, path, body=None, ssl_context=None):
        calls.append(body)
        return {"job": 1}

    monkeypatch.setattr(awx, "_request", fake_request)
    awx.launch_job(api_url="http://awx.test", api_token="t", job_template_id=7)
    assert calls == [{}]  # bit-compatible with pre-#239: body stays exactly {}


def test_launch_job_body_carries_extra_vars_when_given(monkeypatch):
    calls = []

    def fake_request(api_url, api_token, method, path, body=None, ssl_context=None):
        calls.append(body)
        return {"job": 1}

    monkeypatch.setattr(awx, "_request", fake_request)
    awx.launch_job(
        api_url="http://awx.test", api_token="t", job_template_id=7,
        extra_vars={"workload_slug": "studio-a"},
    )
    assert calls == [{"extra_vars": {"workload_slug": "studio-a"}}]


def test_launch_job_body_empty_for_empty_extra_vars_dict(monkeypatch):
    # An empty dict is falsy — treated the same as None (never send an empty
    # extra_vars object).
    calls = []
    monkeypatch.setattr(awx, "_request", lambda *a, **k: calls.append(k.get("body")) or {"job": 1})
    awx.launch_job(api_url="x", api_token="t", job_template_id=1, extra_vars={})
    assert calls == [{}]


# --------------------------------------------------------------------------
# Integration: /api/catalog/{key}/deploy
# --------------------------------------------------------------------------

def _client(groups) -> TestClient:
    # Sync flow only (autoscale disabled) — the async flow needs the app
    # lifespan for app.state.operations, so it uses its own helper below.
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(enabled=False),
        l3=L3Settings(enabled=False),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)  # dev login -> session
    return client


@pytest.fixture
def awx_spy(monkeypatch):
    """Spy on launch_job, recording the full kwargs of each call (dict, not count)."""
    calls = []

    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: None)

    def fake_launch(**kwargs):
        calls.append(kwargs)
        return 4242

    monkeypatch.setattr(main, "launch_job", fake_launch)
    # umbrella #202 WP2: async deploy/teardown now spawns a job watcher
    # right after LAUNCHED, which polls get_job. Mock it to an immediately
    # terminal "successful" job so the watcher resolves on its first poll
    # instead of sleeping/retrying against a real (nonexistent) AWX.
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "2026-01-01T00:00:00Z", "finished": "2026-01-01T00:05:00Z"},
    )
    entry = CatalogEntry(
        key="mxl-videotest-view",
        display_name="MXL video test view",
        summary="MXL video test view",
        configure={"awx_job_template": "dmf-configure"},
        finalise={"awx_job_template": "dmf-finalise"},
    )
    monkeypatch.setattr(main, "load_catalog_entries", lambda: [entry])
    return calls


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


def _assert_skipped_l3_envelope(extra_vars, *, workload_slug=None):
    """Assert extra_vars carries exactly the skipped L3 envelope (+ workload_slug if given).

    This file's Settings() never configure Prometheus, so every launch's L3
    preflight is 'skipped' (#202 WP1-B) — but the envelope still merges in
    (see module docstring). l3_request_id is a random uuid4 hex per request,
    so it's checked for presence, not an exact value.
    """
    assert extra_vars is not None
    assert extra_vars.get("l3_preflight_verdict") == "skipped"
    assert extra_vars.get("l3_request_id")
    expected_keys = {"l3_request_id", "l3_preflight_verdict"}
    if workload_slug is not None:
        assert extra_vars.get("workload_slug") == workload_slug
        expected_keys.add("workload_slug")
    assert set(extra_vars.keys()) == expected_keys


# ---- sync flow (autoscale disabled) ----

def test_sync_deploy_with_valid_workload_passes_extra_vars(awx_spy):
    client = _client(OPERATOR)
    resp = client.post(
        "/api/catalog/mxl-videotest-view/deploy",
        json={"reason": "x", "workload": "studio-a"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "launched"
    _assert_skipped_l3_envelope(awx_spy[-1]["extra_vars"], workload_slug="studio-a")


def test_sync_deploy_without_workload_omits_extra_vars(awx_spy):
    # Pre-#239 behaviour (no workload_slug key) is unchanged when no workload
    # is sent; #202 WP1-B adds the skipped L3 envelope regardless (this
    # file's fixtures never configure Prometheus).
    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotest-view/deploy", json={"reason": "x"})
    assert resp.status_code == 200, resp.text
    _assert_skipped_l3_envelope(awx_spy[-1].get("extra_vars"))


def test_sync_deploy_invalid_slug_is_400_and_no_awx_call(awx_spy, caplog):
    client = _client(OPERATOR)
    for bad in ["Studio-A", "-leading-dash", "trailing-dash-", "has a space", "x" * 41, "$$$"]:
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = client.post(
                "/api/catalog/mxl-videotest-view/deploy",
                json={"reason": "x", "workload": bad},
            )
        assert resp.status_code == 400, bad
        assert resp.json()["error"] == "invalid workload slug"
        assert resp.json()["request_id"]
    assert awx_spy == []  # AWX never reached on any invalid slug
    assert any("outcome=invalid-workload" in m for m in _audit_lines(caplog))


def test_sync_deploy_accepts_boundary_slugs(awx_spy):
    # Single char and the 40-char max are both valid.
    client = _client(OPERATOR)
    for ok in ["a", "a" * 40, "studio-a-1"]:
        resp = client.post(
            "/api/catalog/mxl-videotest-view/deploy",
            json={"reason": "x", "workload": ok},
        )
        assert resp.status_code == 200, ok
        _assert_skipped_l3_envelope(awx_spy[-1]["extra_vars"], workload_slug=ok)


def test_sync_deploy_rejects_trailing_newline_slugs(awx_spy, caplog):
    # codex GATE-239CMS P2: Python re.match's trailing $ anchor matches just
    # before a final newline, so a naive .match() lets "studio-a\n" through —
    # which would land a raw newline in AWX extra_vars and the audit log line
    # (log-splitting surface). fullmatch closes this.
    client = _client(OPERATOR)
    for bad in ["studio-a\n", "\n", "studio-a\r\n"]:
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = client.post(
                "/api/catalog/mxl-videotest-view/deploy",
                json={"reason": "x", "workload": bad},
            )
        assert resp.status_code == 400, repr(bad)
        assert resp.json()["error"] == "invalid workload slug"
    assert awx_spy == []
    assert any("outcome=invalid-workload" in m for m in _audit_lines(caplog))


def test_sync_deploy_rejects_non_string_workload_even_when_falsy(awx_spy, caplog):
    # codex GATE-239CMS P3-1: 0 / false / [] / {} are JSON values a client
    # could plausibly send by mistake — `if not workload` would silently treat
    # them as "no workload" (wrong: they're malformed, not omitted). Only
    # absent-key / null / "" are legitimate omission; every other non-string
    # value is a 400, including the falsy ones.
    client = _client(OPERATOR)
    for bad in [0, False, [], {"x": 1}, 5, True, ["a"]]:
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = client.post(
                "/api/catalog/mxl-videotest-view/deploy",
                json={"reason": "x", "workload": bad},
            )
        assert resp.status_code == 400, bad
        assert resp.json()["error"] == "invalid workload slug"
    assert awx_spy == []
    assert any("outcome=invalid-workload" in m for m in _audit_lines(caplog))


def test_sync_deploy_treats_null_and_empty_string_workload_as_omitted(awx_spy):
    # Explicit JSON null and "" are the two other legitimate-omission shapes
    # besides an absent key (already covered by
    # test_sync_deploy_without_workload_omits_extra_vars).
    client = _client(OPERATOR)
    for omitted in [None, ""]:
        resp = client.post(
            "/api/catalog/mxl-videotest-view/deploy",
            json={"reason": "x", "workload": omitted},
        )
        assert resp.status_code == 200, omitted
        _assert_skipped_l3_envelope(awx_spy[-1].get("extra_vars"))


def test_sync_deploy_non_object_body_is_clean_400_not_a_crash(awx_spy):
    # codex GATE-239CMS P3-2: a non-dict JSON body (bare array/string/number)
    # used to raise an unhandled AttributeError inside _require_reason's
    # (body or {}).get(...) before workload validation ever ran. Must be a
    # clean 400 reason-required, same shape as a missing body, with zero AWX
    # calls — not a 500.
    client = _client(OPERATOR)
    for bad_body in [["x"], "str", 5]:
        resp = client.post("/api/catalog/mxl-videotest-view/deploy", json=bad_body)
        assert resp.status_code == 400, bad_body
        assert resp.json()["error"] == "reason-required"
    assert awx_spy == []


# ---- async flow (autoscale enabled) ----
# Autoscale (async) path needs app.state.operations from the lifespan, so use
# a context-managed client directly (mirrors test_awx_write_gate.py).

def _autoscale_settings() -> Settings:
    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=OPERATOR,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(
            enabled=True, helper_url="http://helper.test", bearer_token="b"
        ),
        l3=L3Settings(enabled=False),
    )


def _wait_for_launch(app, op_id):
    # codex #202 WP2: LAUNCHED is no longer a resting state for deploy/
    # teardown ops — the job watcher spawned right after it can race straight
    # through to RUN_COMPLETE before this poll loop ever observes LAUNCHED
    # itself. job_id is set at the same moment and never changes afterward,
    # so it's the robust "launch happened" signal to wait on.
    for _ in range(50):  # 5s max
        op = app.state.operations.get(op_id)
        if op and op.job_id is not None:
            return op
        time.sleep(0.1)
    return app.state.operations.get(op_id)


def test_async_deploy_with_valid_workload_passes_extra_vars(monkeypatch, awx_spy):
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    with TestClient(create_app(settings=_autoscale_settings())) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post(
            "/api/catalog/mxl-videotest-view/deploy",
            json={"reason": "x", "workload": "studio-b"},
        )
        assert resp.status_code == 202, resp.text
        op = _wait_for_launch(client.app, resp.json()["operation_id"])
        assert op is not None and op.job_id == 4242

    _assert_skipped_l3_envelope(awx_spy[-1]["extra_vars"], workload_slug="studio-b")


def test_async_deploy_without_workload_omits_extra_vars(monkeypatch, awx_spy):
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    with TestClient(create_app(settings=_autoscale_settings())) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post("/api/catalog/mxl-videotest-view/deploy", json={"reason": "x"})
        assert resp.status_code == 202, resp.text
        op = _wait_for_launch(client.app, resp.json()["operation_id"])
        assert op is not None and op.job_id == 4242

    _assert_skipped_l3_envelope(awx_spy[-1].get("extra_vars"))


def test_async_deploy_invalid_slug_is_400_and_no_dispatch(awx_spy, caplog):
    with TestClient(create_app(settings=_autoscale_settings())) as client:
        client.get("/auth/login", follow_redirects=False)
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = client.post(
                "/api/catalog/mxl-videotest-view/deploy",
                json={"reason": "x", "workload": "Bad Slug!"},
            )
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid workload slug"
    assert awx_spy == []
    assert any("outcome=invalid-workload" in m for m in _audit_lines(caplog))
