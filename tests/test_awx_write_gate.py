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
from dmf_cms.settings import AWXAutoscaleSettings, AWXSettings, L3Settings, Settings


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
        # This file tests the operator+C5 write gate, not the L3 capacity
        # preflight (#202 WP1) — no Prometheus is configured, and since
        # R2-1 that combination fail-closes (409), not skips, unless L3 is
        # explicitly disabled here.
        l3=L3Settings(enabled=False),
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
    # umbrella #202 WP2: async deploy/teardown now spawns a job watcher
    # right after LAUNCHED, which polls get_job. Mock it to an immediately
    # terminal "successful" job so the watcher resolves on its first poll
    # instead of sleeping/retrying against a real (nonexistent) AWX.
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "2026-01-01T00:00:00Z", "finished": "2026-01-01T00:05:00Z"},
    )
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
    import threading

    # Autoscale (async) path needs app.state.operations from the lifespan, so
    # use a context-managed client.
    #
    # The second POST must arrive while the first operation is STILL in
    # flight, or it creates a fresh operation (202) instead of reattaching
    # (200). A no-op wake does not guarantee that — it just makes the
    # background task fast, and which of the two wins is left to scheduler
    # timing. That is exactly how this test went red on the 3.12/3.13 CI
    # legs while passing locally.
    #
    # So hold the operation with a real barrier: the wake blocks until the
    # second POST has been issued, and only then is the background task
    # allowed to proceed. Deterministic on any scheduler.
    #
    # ensure_awx_awake runs inside run_in_threadpool, so a blocking
    # threading.Event.wait() here parks a worker thread, never the event
    # loop. The timeout is a deadlock guard, not the synchronization.
    second_post_issued = threading.Event()

    def held_wake(**kwargs):
        assert second_post_issued.wait(timeout=10), "second POST never issued"

    monkeypatch.setattr(main, "ensure_awx_awake", held_wake)
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
            try:
                second = client.post("/api/workflows/dmf-provision/launch", json={"reason": "x"})
            finally:
                # Release the held operation whatever the second POST did, so
                # a failure here surfaces as an assertion, not a hang.
                second_post_issued.set()
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


# --------------------------------------------------------------------------
# umbrella dmf-cms#108 fix-round 1: audit-line injection. `workflow_name` is
# a raw path parameter, never validated, and reaches `target` on the
# awx-not-configured audit path BEFORE any AWX-reachability check — so an
# operator+ caller controls a value that lands unescaped in a %s-formatted
# log line, even with AWX left dark. A CR/LF in it splits the single audit
# record into multiple physical lines on whatever reads dmf-cms's stdout
# (forging what looks like a second, independent line), corrupting the
# record ADR-0028 C5 depends on.
#
# fix-round 2: parametrized over three C0 characters, not just LF. A bare
# CR alone (no LF) is a DISTINCT threat from LF: in any terminal-backed log
# reader (kubectl logs, journalctl to a tty) CR returns the cursor to
# column 0, so a hostile value can overwrite the VISIBLE part of the real
# record and display forged content in its place — without ever emitting a
# second physical line, so a test that only ever checks "\n not in line"
# cannot see it. Confirmed the gap was real before parametrizing: a
# sanitizer mutated to pass a bare CR through unescaped (`if value and "\r"
# in value and "\n" not in value: return value`) made every test in this
# file pass unchanged. NUL is included as a second, unrelated-to-CR/LF C0
# character, since the fix claims to cover the whole C0 range, not just
# the two whitespace controls.
# --------------------------------------------------------------------------

_HOSTILE_CONTROL_CHARS = [
    pytest.param("\n", "%0a", "\\n", id="LF"),
    pytest.param("\r", "%0d", "\\r", id="bare-CR"),
    pytest.param("\x00", "%00", "\\x00", id="NUL"),
]


@pytest.mark.parametrize("control_char,url_encoded,escaped", _HOSTILE_CONTROL_CHARS)
def test_audit_line_survives_a_hostile_workflow_name_as_one_physical_line(
    awx_spy, caplog, control_char, url_encoded, escaped,
):
    import logging
    client = _client(OPERATOR, awx=False)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post(
            f"/api/workflows/dmf-provision{url_encoded}injected-line/launch",
            json={"reason": "hostile workflow_name"},
        )
    assert resp.status_code == 503
    line = next(m for m in _audit_lines(caplog) if "action=launch" in m)
    # The value survives (escaped, not dropped — an audit record is a
    # complete account of what was requested) but the record stays exactly
    # ONE physical line: no raw control character rides through unescaped.
    assert control_char not in line
    assert "dmf-provision" in line
    assert "injected-line" in line
    assert escaped in line
    assert "outcome=awx-not-configured" in line


@pytest.mark.parametrize("control_char,_url_encoded,escaped", _HOSTILE_CONTROL_CHARS)
def test_audit_line_sanitizes_actor_workload_and_capacity_too(monkeypatch, caplog, control_char, _url_encoded, escaped):
    # Direct call: `_audit_awx_write` is the one place every route that can
    # reach `workload`/`capacity` converges, so this proves the property at
    # its actual source rather than hunting for a live route that lets a
    # hostile value reach them specifically.
    #
    # dmfdeploy/dmfdeploy#140 (the writer fix, 2026-09-03): `target`,
    # `workload` and `capacity` are no longer covered by
    # `_sanitize_audit_field` — they're %r-quoted now (repr(), the same
    # treatment `reason` has always had), which escapes every C0 control
    # character too, just via a different mechanism. Only `actor` (below)
    # is still routed through the sanitizer; this test's own assertions
    # hold for all three regardless of which of the two mechanisms
    # produced the escaping, since both happen to render LF/CR/NUL
    # identically.
    import logging

    from dmf_cms.main import _audit_awx_write
    from dmf_cms.security import UserIdentity

    class _FakeRequest:
        session: dict = {}

    request = _FakeRequest()
    user = UserIdentity(
        subject=f"ops{control_char}FORGED actor=admin", display_name="Ops", email="ops@dmf.example.com",
        role="operator", groups=(),
    )
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _audit_awx_write(
            request, user, action="deploy", target=f"key{control_char}injected",
            request_id="r1", reason="fine", outcome="dispatched",
            workload=f"wl{control_char}injected", capacity=f"cap{control_char}injected",
        )
    line = next(m for m in caplog.records if m.getMessage().startswith("awx write:")).getMessage()
    assert control_char not in line
    # Escaped, not silently dropped.
    assert "FORGED" in line and "injected" in line
    assert escaped in line
