"""L3 rollback command + advisory facility lock (umbrella #202 WP2 §4.5/§4.6).

Two surfaces:
* ``POST /api/runs/{run_id}/rollback`` — role/reason/run_id validation,
  async dedupe/reattach, jt-not-registered, the exact extra_vars contract
  (both sync and async — codex R2-7: the async one now proves l3_request_id
  is the SAME as the dispatch's own C5 request_id, not a fresh mint).
* ``_facility_busy_check``, wired into deploy, teardown, AND rollback
  dispatch (codex R2-6 — a prior draft exempted teardown entirely). codex
  R3-1 removed the old blanket same-target skip entirely (a dirty run now
  blocks a new dispatch to its OWN target too) and R3-5 removed R2-6's
  narrow teardown-vs-teardown cross-target exemption — plan §4.5 is one
  run at a time, full stop. Cross-entry non-terminal ops block,
  same-entry/clean-terminal ops don't, DIRTY terminal ops
  (FAILED_ROLLBACK_REQUIRED/ROLLBACK_INCOMPLETE/RUN_STATUS_UNKNOWN) block
  even though they're terminal for dedupe/GC, a dirty run's own matching
  rollback is never blocked by itself, and a proof that the check itself
  performs zero AWX/Prometheus/k8s IO before refusing.
"""

import logging
import time

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
from dmf_cms import capacity
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.operations import OperationState
from dmf_cms.settings import AWXAutoscaleSettings, AWXSettings, L3Settings, Settings

OPERATOR = ("dmf-console-operator",)
VIEWER = ("dmf-console-viewer",)

RUN_ID = "a" * 32

FIT_ENTRY = CatalogEntry(
    key="mxl-videotestsrc",
    display_name="MXL video test source",
    summary="MXL video test source",
    configure={"awx_job_template": "dmf-configure"},
    finalise={"awx_job_template": "dmf-finalise"},
)


def _settings(groups=OPERATOR, *, autoscale=False, l3_enabled=False) -> Settings:
    # l3_enabled defaults False: these tests are about the facility lock/
    # rollback command, not the capacity preflight — keep L3 out of the
    # way (matches test_awx_write_gate.py/test_autoscale_operations.py).
    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=(
            AWXAutoscaleSettings(enabled=True, helper_url="http://helper.test", bearer_token="b")
            if autoscale
            else AWXAutoscaleSettings(enabled=False)
        ),
        l3=L3Settings(enabled=l3_enabled, rollback_jt_name="media-rollback-run"),
    )


def _client(groups=OPERATOR, **kwargs) -> TestClient:
    client = TestClient(create_app(settings=_settings(groups, **kwargs)))
    client.get("/auth/login", follow_redirects=False)
    return client


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    result = None
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    return result


@pytest.fixture
def awx_spy(monkeypatch):
    """Spy on launch_job; template lookup/active-job checks pass through cleanly."""
    calls = []

    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: None)

    def fake_launch(**kwargs):
        calls.append(kwargs)
        return 4242

    monkeypatch.setattr(main, "launch_job", fake_launch)
    # See test_workload_seam.py's comment: async dispatch spawns a job
    # watcher that polls get_job — mock it to an immediately terminal
    # "successful" job so tests resolve fast and deterministically.
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "t0", "finished": "t1"},
    )
    monkeypatch.setattr(main, "load_catalog_entries", lambda: [FIT_ENTRY])
    return calls


# ---------------------------------------------------------------------------
# POST /api/runs/{run_id}/rollback — role/reason/run_id validation
# ---------------------------------------------------------------------------


def test_rollback_viewer_is_403_and_no_awx_call(awx_spy):
    client = _client(VIEWER)
    resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
    assert resp.status_code == 403
    assert awx_spy == []


def test_rollback_missing_reason_is_400_with_no_awx_call(awx_spy):
    client = _client(OPERATOR)
    for body in ({}, {"reason": ""}, {"reason": "   "}):
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json=body)
        assert resp.status_code == 400, body
        assert resp.json()["error"] == "reason-required"
    assert awx_spy == []


@pytest.mark.parametrize("bad_run_id", [
    "not-hex-at-all",
    "a" * 31,       # too short
    "a" * 33,       # too long
    "A" * 32,       # uppercase not allowed
    "g" * 32,       # non-hex character
    "a" * 32 + "!",  # trailing garbage
])
def test_rollback_invalid_run_id_is_400_with_no_awx_call(awx_spy, caplog, bad_run_id):
    client = _client(OPERATOR)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post(f"/api/runs/{bad_run_id}/rollback", json={"reason": "x"})
    assert resp.status_code == 400, bad_run_id
    assert resp.json()["error"] == "invalid-run-id"
    assert resp.json()["request_id"]
    assert awx_spy == []
    assert any("outcome=invalid-run-id" in m for m in _audit_lines(caplog))


def test_rollback_valid_run_id_passes_validation(awx_spy):
    client = _client(OPERATOR)
    resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "launched"


# ---------------------------------------------------------------------------
# Async dedupe/reattach
# ---------------------------------------------------------------------------


def test_rollback_async_dedupe_reattaches_same_run_id(monkeypatch, awx_spy):
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        seeded = client.app.state.operations.create(action="rollback", target=RUN_ID)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["operation_id"] == seeded.operation_id
    assert awx_spy == []  # never dispatched a fresh launch


def test_rollback_async_fresh_dispatch_returns_202(monkeypatch, awx_spy):
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
        assert resp.status_code == 202, resp.text
        op_id = resp.json()["operation_id"]

        def _job_id_set():
            op = client.app.state.operations.get(op_id)
            return op if op and op.job_id is not None else None

        op = _wait_for(_job_id_set)
        assert op is not None and op.job_id == 4242
        assert op.action == "rollback"
        assert op.target == RUN_ID


# ---------------------------------------------------------------------------
# sync already-active identity verification (codex R4-2b) — the rollback JT
# is SHARED across every run being rolled back, so "some rollback job is
# active" doesn't mean it's THIS run_id's rollback.
# ---------------------------------------------------------------------------


def test_rollback_sync_already_active_matching_run_id_reattaches(monkeypatch):
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 555)
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"id": 555, "extra_vars": f'{{"l3_run_id": "{RUN_ID}", "l3_request_id": "{"c" * 32}"}}'},
    )

    with TestClient(create_app(settings=_settings(OPERATOR))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["job_id"] == 555
        assert resp.json()["operation_id"]

        op = client.app.state.operations.get(resp.json()["operation_id"])
    assert op is not None
    assert op.run_id == RUN_ID
    assert op.job_id == 555


def test_rollback_sync_already_active_other_run_is_409_no_op_created(monkeypatch):
    # codex R4-2's exact probe: an active rollback job actually rolling
    # back run A (l3_run_id=A) — a POST for a DIFFERENT run B must refuse,
    # never attribute A's job (and thus A's eventual outcome marker) to B.
    run_a = "a" * 32
    run_b = "b" * 32
    dispatch_correlator_c = "c" * 32

    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 555)
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"id": 555, "extra_vars": f'{{"l3_run_id": "{run_a}", "l3_request_id": "{dispatch_correlator_c}"}}'},
    )

    def boom(**k):
        raise AssertionError("launch_job must not be called for an already-active job")

    monkeypatch.setattr(main, "launch_job", boom)

    with TestClient(create_app(settings=_settings(OPERATOR))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post(f"/api/runs/{run_b}/rollback", json={"reason": "x"})
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"] == "already-active-other-run"
        assert resp.json()["request_id"]
        # Nothing at all was created for run B — not even a wedged op.
        assert client.app.state.operations.list_all() == []


def test_rollback_sync_already_active_unparseable_identity_is_409_no_op_created(monkeypatch):
    # Same refusal when the active job's identity can't be verified at all
    # (no l3_run_id key, malformed extra_vars, ...) — "unverifiable" is
    # never treated as "safe to attribute".
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 555)
    monkeypatch.setattr(main, "get_job", lambda **k: {"id": 555, "extra_vars": "not json at all"})

    with TestClient(create_app(settings=_settings(OPERATOR))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"] == "already-active-other-run"
        assert client.app.state.operations.list_all() == []


def test_rollback_sync_already_active_get_job_failure_is_409_no_op_created(monkeypatch):
    # Can't even FETCH the active job's detail to verify identity -> same
    # fail-closed refusal, never a silent blind attribution.
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 555)

    def boom(**k):
        raise TimeoutError("no route to AWX")

    monkeypatch.setattr(main, "get_job", boom)

    with TestClient(create_app(settings=_settings(OPERATOR))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"] == "already-active-other-run"
        assert client.app.state.operations.list_all() == []


def test_rollback_sync_already_active_no_lifespan_returns_bare_already_active(monkeypatch):
    # getattr-guard path: no ops store at all -> no identity check possible
    # (nothing to create/reattach either way) -> falls through to the bare
    # already-active response, same as before R4-2 for this test-only case.
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 555)

    def boom(**k):
        raise AssertionError("get_job must not be called when there's no ops store to verify against")

    monkeypatch.setattr(main, "get_job", boom)

    client = TestClient(create_app(settings=_settings(OPERATOR)))  # no `with` — lifespan never runs
    client.get("/auth/login", follow_redirects=False)
    resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["job_id"] == 555
    assert "operation_id" not in resp.json()


# ---------------------------------------------------------------------------
# jt-not-registered
# ---------------------------------------------------------------------------


def test_rollback_sync_jt_not_registered_is_404(monkeypatch):
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: None)
    client = _client(OPERATOR)
    resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
    assert resp.status_code == 404
    assert "not found" in resp.json()["error"]


def test_rollback_async_jt_not_registered_is_op_error(monkeypatch):
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: None)

    def boom(**k):
        raise AssertionError("launch_job must not be called when the rollback JT isn't registered")

    monkeypatch.setattr(main, "launch_job", boom)

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
        assert resp.status_code == 202, resp.text
        op_id = resp.json()["operation_id"]

        def _reached_error():
            op = client.app.state.operations.get(op_id)
            return op if op and op.state == OperationState.ERROR else None

        op = _wait_for(_reached_error)
    assert op is not None
    assert op.state == OperationState.ERROR
    assert op.error == "rollback-jt-not-registered"


# ---------------------------------------------------------------------------
# extra_vars contract: {"l3_run_id", "l3_rollback_reason", "l3_request_id"}
# ---------------------------------------------------------------------------


def test_rollback_sync_extra_vars_contract(monkeypatch):
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: None)
    calls = []
    monkeypatch.setattr(main, "launch_job", lambda **k: calls.append(k) or 4242)

    client = _client(OPERATOR)
    resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "rollback please"})
    assert resp.status_code == 200, resp.text

    extra_vars = calls[-1]["extra_vars"]
    assert set(extra_vars.keys()) == {"l3_run_id", "l3_rollback_reason", "l3_request_id"}
    assert extra_vars["l3_run_id"] == RUN_ID
    assert extra_vars["l3_rollback_reason"] == "rollback please"
    assert extra_vars["l3_request_id"] == resp.json()["request_id"]


def test_rollback_sync_creates_a_tracked_operation(monkeypatch):
    # codex R2-5: the sync rollback branch now also tracks its launch as an
    # Operation + watcher — requires a lifespan'd TestClient (see the
    # getattr-guard, matching the sync deploy/teardown tests).
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: None)
    monkeypatch.setattr(main, "launch_job", lambda **k: 4242)
    monkeypatch.setattr(
        main, "get_job",
        # R3b: event_processing_finished=True avoids the new bounded
        # ingestion-readiness wait (_await_event_ingestion_finished) —
        # this real TestClient/asyncio flow uses the REAL (10s default)
        # job_poll_interval_seconds, not a test-only poll_interval=0, so
        # an unset flag here would make the wait loop blow well past
        # _wait_for's 5s timeout.
        lambda **k: {"status": "successful", "started": "t0", "finished": "t1", "event_processing_finished": True},
    )
    # codex R2-1: a rollback op's outcome is ALWAYS marker-fetched
    # (regardless of job status) — must mock get_job_events_for_task too
    # (WP3 R2b: job-events transport, anchored by task name), or the
    # (unmocked, real-network) fetch fails and the op fails closed to
    # ROLLBACK_INCOMPLETE instead of RUN_COMPLETE.
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [{"task": "dmf-l3-outcome", "event_data": {"res": {"msg": "DMF_L3_OUTCOME: rollback_complete"}}}],
    )

    with TestClient(create_app(settings=_settings(OPERATOR))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "rollback please"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["operation_id"]  # codex R3-4

        def _resolved():
            ops = client.app.state.operations.list_all()
            return ops if ops and ops[0].state == OperationState.RUN_COMPLETE else None

        ops = _wait_for(_resolved)

    assert ops is not None and len(ops) == 1
    assert ops[0].operation_id == resp.json()["operation_id"]
    assert ops[0].action == "rollback"
    assert ops[0].target == RUN_ID
    assert ops[0].job_id == 4242
    assert ops[0].request_id == resp.json()["request_id"]
    assert ops[0].run_id == resp.json()["request_id"]  # codex R3-3


def test_rollback_async_extra_vars_contract_uses_the_dispatch_request_id(monkeypatch, awx_spy):
    # codex R2-7: l3_request_id is the DISPATCHING op's own request_id (the
    # audited/echoed C5 one), NOT a fresh mint at launch time — a prior
    # WP2-B draft minted a fresh id here, causing the launcher-side
    # extra_vars and the console's own audited request_id to diverge for no
    # reason.
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "auto test"})
        assert resp.status_code == 202, resp.text
        dispatch_request_id = resp.json()["request_id"]
        _wait_for(lambda: awx_spy or None)

    assert len(awx_spy) == 1
    extra_vars = awx_spy[-1]["extra_vars"]
    assert set(extra_vars.keys()) == {"l3_run_id", "l3_rollback_reason", "l3_request_id"}
    assert extra_vars["l3_run_id"] == RUN_ID
    assert extra_vars["l3_rollback_reason"] == "auto test"
    assert extra_vars["l3_request_id"] == dispatch_request_id
    assert len(extra_vars["l3_request_id"]) == 32


# ---------------------------------------------------------------------------
# Advisory facility lock — wired into deploy, teardown, AND rollback (codex
# R2-6; a prior WP2-B draft exempted teardown entirely)
# ---------------------------------------------------------------------------


def test_facility_busy_blocks_cross_entry_deploy(awx_spy):
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        busy_op = client.app.state.operations.create("deploy", "other-key")
        client.app.state.operations.update(busy_op.operation_id, state=OperationState.RUNNING, job_id=1)
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "facility-busy"
    assert body["advisory"] is True
    assert body["blocking_operation"]["operation_id"] == busy_op.operation_id
    assert awx_spy == []


def test_facility_busy_blocks_cross_entry_rollback(awx_spy):
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        busy_op = client.app.state.operations.create("deploy", "some-other-key")
        client.app.state.operations.update(busy_op.operation_id, state=OperationState.RUNNING, job_id=1)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "facility-busy"
    assert awx_spy == []


def test_facility_check_blocks_teardown_on_cross_target_running_deploy(awx_spy):
    # codex R2-6: teardown dispatch now ALSO gets the facility check — a
    # non-terminal cross-target deploy blocks it just like it would block a
    # new deploy/rollback elsewhere.
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        busy_op = client.app.state.operations.create("deploy", "other-key")
        client.app.state.operations.update(busy_op.operation_id, state=OperationState.RUNNING, job_id=1)
        resp = client.post("/api/catalog/mxl-videotestsrc/teardown", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "facility-busy"
    assert awx_spy == []


def test_facility_check_teardown_vs_teardown_cross_target_now_blocks(awx_spy):
    # codex R3-5: the prior R2-6(c) teardown-vs-teardown exemption is
    # REMOVED — plan §4.5 is one run at a time, full stop.
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        busy_op = client.app.state.operations.create("teardown", "other-key")
        client.app.state.operations.update(busy_op.operation_id, state=OperationState.RUNNING, job_id=1)
        resp = client.post("/api/catalog/mxl-videotestsrc/teardown", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "facility-busy"
    assert awx_spy == []


def test_facility_check_ignores_same_target(awx_spy):
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        same_op = client.app.state.operations.create("deploy", "mxl-videotestsrc")
        client.app.state.operations.update(same_op.operation_id, state=OperationState.RUNNING, job_id=1)
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    # Reattaches to the same-target op instead — per-entry guards' business,
    # not the facility check's.
    assert resp.status_code == 200, resp.text
    assert resp.json()["operation_id"] == same_op.operation_id


def test_facility_check_ignores_terminal_ops(awx_spy):
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        completed_op = client.app.state.operations.create("deploy", "other-key")
        client.app.state.operations.update(completed_op.operation_id, state=OperationState.RUN_COMPLETE, job_id=1)
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 202, resp.text


# ---------------------------------------------------------------------------
# Dirty-facility model (codex R2-6): FAILED_ROLLBACK_REQUIRED/
# ROLLBACK_INCOMPLETE are terminal for dedupe/GC but still BLOCK a cross-
# target dispatch, and a dirty run's own matching rollback is exempt.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("dirty_state", [OperationState.FAILED_ROLLBACK_REQUIRED, OperationState.ROLLBACK_INCOMPLETE])
def test_facility_check_dirty_state_blocks_cross_target_deploy(awx_spy, dirty_state):
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        dirty_op = client.app.state.operations.create("deploy", "other-key", request_id="e" * 32)
        client.app.state.operations.update(dirty_op.operation_id, state=dirty_state, job_id=1)
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 409, dirty_state
    assert resp.json()["error"] == "facility-busy"
    assert awx_spy == []


def test_facility_check_dirty_state_blocks_cross_target_teardown(awx_spy):
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        dirty_op = client.app.state.operations.create("deploy", "other-key", request_id="f" * 32)
        client.app.state.operations.update(dirty_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1)
        resp = client.post("/api/catalog/mxl-videotestsrc/teardown", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "facility-busy"
    assert awx_spy == []


def test_facility_check_rollback_of_its_own_dirty_run_is_not_blocked(awx_spy):
    # codex R2-6(d), corrected by R4-1: a rollback of run_id R must never
    # be blocked by the very deploy op that R is rolling back — even
    # though that op is DIRTY (FAILED_ROLLBACK_REQUIRED) and targets a
    # DIFFERENT catalog key than the run_id. The exemption compares
    # op.run_id (hydrated identity), not op.request_id.
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        dirty_op = client.app.state.operations.create("deploy", "mxl-videotestsrc", request_id=RUN_ID)
        client.app.state.operations.update(
            dirty_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1, run_id=RUN_ID,
        )
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
    assert resp.status_code == 202, resp.text


def test_facility_check_rollback_matches_on_hydrated_run_id_not_dispatch_request_id(awx_spy):
    # codex R4-1's exact probe, at HTTP level: a REATTACHED deploy op whose
    # request_id (this console's own dispatch bookkeeping) differs from its
    # run_id (hydrated from the AWX job's own extra_vars). A rollback of
    # the run_id must pass.
    dispatch_request_id = "9" * 32
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        dirty_op = client.app.state.operations.create("deploy", "mxl-videotestsrc", request_id=dispatch_request_id)
        client.app.state.operations.update(
            dirty_op.operation_id, state=OperationState.RUN_STATUS_UNKNOWN, job_id=1, run_id=RUN_ID,
        )
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
    assert resp.status_code == 202, resp.text


def test_facility_check_dirty_run_still_blocks_an_unrelated_rollback(awx_spy):
    # The R2-6(d) exception above is narrowly scoped to the matching run —
    # a dirty deploy op DOES block a rollback of a DIFFERENT run_id.
    other_run_id = "9" * 32
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        dirty_op = client.app.state.operations.create("deploy", "mxl-videotestsrc", request_id=RUN_ID)
        client.app.state.operations.update(dirty_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1)
        resp = client.post(f"/api/runs/{other_run_id}/rollback", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "facility-busy"


def test_facility_check_retry_rollback_of_incomplete_run_passes(awx_spy):
    # A prior ROLLBACK_INCOMPLETE attempt for the SAME run_id must not
    # block a retry — ROLLBACK_INCOMPLETE is terminal for dedupe/GC (so
    # get_or_create makes a genuinely new op for a retry) and the facility
    # check's plain same-target skip (op.target == current_target == R)
    # applies, no special-casing needed beyond that.
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        prior = client.app.state.operations.create("rollback", RUN_ID, request_id="c" * 32)
        client.app.state.operations.update(prior.operation_id, state=OperationState.ROLLBACK_INCOMPLETE, job_id=1)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "retry"})
    assert resp.status_code == 202, resp.text
    assert resp.json()["operation_id"] != prior.operation_id


def test_facility_busy_check_performs_no_network_io_before_refusing(monkeypatch):
    # codex #202 WP2 §4.5 P2-2 TEST-CRITICAL: strict mocks that raise on any
    # AWX/Prometheus call, a cross-entry RUNNING deploy op pre-seeded, a new
    # deploy for ANOTHER entry -> 409 facility-busy, mocks never touched.
    def boom(*a, **k):
        raise AssertionError("no AWX/Prometheus/k8s call may happen before a facility-busy refusal")

    monkeypatch.setattr(main, "lookup_job_template_by_name", boom)
    monkeypatch.setattr(main, "find_active_job_for_template", boom)
    monkeypatch.setattr(main, "launch_job", boom)
    monkeypatch.setattr(main, "ensure_awx_awake", boom)
    monkeypatch.setattr(capacity, "read_node_supply", boom)
    monkeypatch.setattr(capacity, "read_ee_reserve", boom)
    monkeypatch.setattr(main, "load_catalog_entries", lambda: [FIT_ENTRY])

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        busy_op = client.app.state.operations.create("deploy", "other-key")
        client.app.state.operations.update(busy_op.operation_id, state=OperationState.RUNNING, job_id=1)
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "facility-busy"


def test_facility_busy_check_performs_no_network_io_before_refusing_rollback(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("no AWX call may happen before a facility-busy refusal on rollback")

    monkeypatch.setattr(main, "lookup_job_template_by_name", boom)
    monkeypatch.setattr(main, "find_active_job_for_template", boom)
    monkeypatch.setattr(main, "launch_job", boom)
    monkeypatch.setattr(main, "ensure_awx_awake", boom)

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        busy_op = client.app.state.operations.create("deploy", "other-key")
        client.app.state.operations.update(busy_op.operation_id, state=OperationState.RUNNING, job_id=1)
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "facility-busy"


def test_facility_busy_check_performs_no_network_io_before_refusing_teardown(monkeypatch):
    # codex R2-6: teardown gets the same TEST-CRITICAL no-network-IO
    # guarantee now that it's wired into the facility check.
    def boom(*a, **k):
        raise AssertionError("no AWX call may happen before a facility-busy refusal on teardown")

    monkeypatch.setattr(main, "lookup_job_template_by_name", boom)
    monkeypatch.setattr(main, "find_active_job_for_template", boom)
    monkeypatch.setattr(main, "launch_job", boom)
    monkeypatch.setattr(main, "ensure_awx_awake", boom)
    monkeypatch.setattr(main, "load_catalog_entries", lambda: [FIT_ENTRY])

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        busy_op = client.app.state.operations.create("deploy", "other-key")
        client.app.state.operations.update(busy_op.operation_id, state=OperationState.RUNNING, job_id=1)
        resp = client.post("/api/catalog/mxl-videotestsrc/teardown", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "facility-busy"
