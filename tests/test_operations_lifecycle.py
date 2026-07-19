"""L3 run-tracking substrate — state machine + job watcher (umbrella #202 WP2).

The pre-WP2 ops store terminated at LAUNCHED — the console never observed
AWX job completion. WP2 extends the state machine (RUNNING/RUN_COMPLETE/
RUN_FAILED/FAILED_ROLLBACK_REQUIRED) and adds a background watcher
(``main._watch_job_operation``) that polls a dispatched job to its
terminal outcome. Terminality is now ACTION-AWARE: LAUNCHED stays terminal
for the legacy "launch" (generic AWX workflow launch, no watcher attached)
but becomes a mid-flight state for deploy/teardown/rollback.

Three layers:
* operations.py — the state machine itself (terminal_states, dedupe/
  reattach/GC behavior).
* main.py — the watcher's polling loop and its terminal transitions.
* awx.py — the two new AWX API helpers (get_job, get_job_stdout) the
  watcher (and WP2-B's rollback command) read from.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from dmf_cms import awx
from dmf_cms import main
from dmf_cms.operations import Operation, OperationState, OperationStore, terminal_states
from dmf_cms.settings import AWXSettings, L3Settings, Settings

# ---------------------------------------------------------------------------
# operations.py — terminal_states()
# ---------------------------------------------------------------------------


def test_launch_action_keeps_pre_wp2_terminal_set():
    assert terminal_states("launch") == frozenset({OperationState.LAUNCHED, OperationState.ERROR})


@pytest.mark.parametrize("action", ["deploy", "teardown", "rollback"])
def test_watched_actions_get_the_new_terminal_set(action):
    assert terminal_states(action) == frozenset({
        OperationState.RUN_COMPLETE,
        OperationState.RUN_FAILED,
        OperationState.FAILED_ROLLBACK_REQUIRED,
        OperationState.ROLLBACK_INCOMPLETE,
        OperationState.RUN_STATUS_UNKNOWN,
        OperationState.ERROR,
    })


def test_launched_is_terminal_for_launch_only():
    assert OperationState.LAUNCHED in terminal_states("launch")
    assert OperationState.LAUNCHED not in terminal_states("deploy")
    assert OperationState.LAUNCHED not in terminal_states("teardown")
    assert OperationState.LAUNCHED not in terminal_states("rollback")


def test_unknown_action_falls_back_to_launch_terminal_set():
    # A defensive default — an action outside {deploy,teardown,rollback,launch}
    # shouldn't exist today, but if one did, it should get the conservative
    # (smaller non-terminal window) legacy set, not the watched one.
    assert terminal_states("something-new") == terminal_states("launch")


# ---------------------------------------------------------------------------
# operations.py — dedupe/reattach respects the new terminal set
# ---------------------------------------------------------------------------


def test_find_active_reattaches_to_a_running_deploy_op():
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key1")
    store.update(op.operation_id, state=OperationState.RUNNING, job_id=1)
    found = store.find_active("deploy", "key1")
    assert found is not None and found.operation_id == op.operation_id


def test_find_active_reattaches_to_a_launched_deploy_op():
    # codex #202 WP2: LAUNCHED means "handed to AWX, watcher attached" for
    # deploy — still active, a re-click during job execution reattaches
    # instead of spawning a duplicate.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key1")
    store.update(op.operation_id, state=OperationState.LAUNCHED, job_id=1)
    found = store.find_active("deploy", "key1")
    assert found is not None and found.operation_id == op.operation_id


def test_find_active_does_not_reattach_to_a_launched_launch_op():
    # The legacy "launch" action has no watcher — LAUNCHED IS terminal there.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("launch", "workflow-a")
    store.update(op.operation_id, state=OperationState.LAUNCHED, job_id=1)
    assert store.find_active("launch", "workflow-a") is None


def test_get_or_create_reattaches_to_running_op_instead_of_creating_new():
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key1")
    store.update(op.operation_id, state=OperationState.RUNNING, job_id=1)
    reattached, created = store.get_or_create("deploy", "key1")
    assert created is False
    assert reattached.operation_id == op.operation_id


@pytest.mark.parametrize("state", [
    OperationState.RUN_COMPLETE, OperationState.RUN_FAILED,
    OperationState.FAILED_ROLLBACK_REQUIRED, OperationState.ERROR,
])
def test_get_or_create_new_op_after_watched_terminal_state(state):
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key1")
    store.update(op.operation_id, state=state, job_id=1)
    new_op, created = store.get_or_create("deploy", "key1")
    assert created is True
    assert new_op.operation_id != op.operation_id


# ---------------------------------------------------------------------------
# operations.py — new Operation fields (request_id/initiator/l3_outcome)
# ---------------------------------------------------------------------------


def test_create_stores_request_id_and_initiator():
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key1", request_id="req-1", initiator="alice")
    assert op.request_id == "req-1"
    assert op.initiator == "alice"
    d = op.to_dict()
    assert d["request_id"] == "req-1"
    assert d["initiator"] == "alice"
    assert d["l3_outcome"] is None


def test_reattach_does_not_overwrite_request_id_or_initiator():
    store = OperationStore(ttl_seconds=3600)
    op1, created1 = store.get_or_create("deploy", "key1", request_id="req-1", initiator="alice")
    assert created1 is True
    op2, created2 = store.get_or_create("deploy", "key1", request_id="req-2", initiator="bob")
    assert created2 is False
    assert op2.operation_id == op1.operation_id
    assert op2.request_id == "req-1"
    assert op2.initiator == "alice"


def test_update_sets_l3_outcome():
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key1")
    store.update(op.operation_id, l3_outcome="rollback-succeeded")
    assert store.get(op.operation_id).l3_outcome == "rollback-succeeded"


# ---------------------------------------------------------------------------
# operations.py — GC only removes ops in their OWN action's terminal set
# ---------------------------------------------------------------------------


def test_gc_removes_watched_terminal_but_keeps_launched_deploy_op():
    store = OperationStore(ttl_seconds=0)  # terminal ops are GC-eligible immediately
    launched_op = store.create("deploy", "key-launched")
    store.update(launched_op.operation_id, state=OperationState.LAUNCHED, job_id=1)
    completed_op = store.create("deploy", "key-completed")
    store.update(completed_op.operation_id, state=OperationState.RUN_COMPLETE, job_id=2)

    store.list_all()  # any public method triggers _gc() under the lock

    assert store.get(launched_op.operation_id) is not None  # non-terminal for deploy
    assert store.get(completed_op.operation_id) is None  # terminal, GC'd


def test_gc_removes_launched_launch_op():
    store = OperationStore(ttl_seconds=0)
    op = store.create("launch", "workflow-a")
    store.update(op.operation_id, state=OperationState.LAUNCHED, job_id=1)
    store.list_all()
    assert store.get(op.operation_id) is None  # terminal for launch, GC'd


# ---------------------------------------------------------------------------
# main.py — the job watcher
# ---------------------------------------------------------------------------


def _fake_app(*, poll_interval=0, ttl_seconds=3600, auto_rollback=True):
    settings = Settings(
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        l3=L3Settings(job_poll_interval_seconds=poll_interval, auto_rollback=auto_rollback),
    )
    ops_store = OperationStore(ttl_seconds=ttl_seconds)
    app = SimpleNamespace(
        state=SimpleNamespace(settings=settings, operations=ops_store, operation_tasks=set())
    )
    return app, ops_store


def _run_watcher(app, operation_id, job_id, action, key):
    asyncio.run(main._watch_job_operation(app, operation_id, job_id, action, key))


def test_watcher_successful_job_is_run_complete(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    assert ops_store.get(op.operation_id).state == OperationState.RUN_COMPLETE


def test_watcher_failed_never_started_is_run_failed(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": None, "finished": None})
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED
    assert updated.error == "job-failed"


@pytest.mark.parametrize("status", ["failed", "error", "canceled"])
def test_watcher_deploy_failed_after_started_is_failed_rollback_required(monkeypatch, status):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": status, "started": "t0", "finished": "t1"})
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.FAILED_ROLLBACK_REQUIRED, status
    assert updated.error == f"job-{status}"


def test_watcher_teardown_failed_after_started_is_run_failed_not_rollback(monkeypatch):
    # teardown is itself an idempotent cleanup action — an operator retry is
    # the recovery path, not an auto-rollback of a cleanup. Rollback's own
    # failed-after-started handling is entirely different (marker-driven,
    # codex R2-1) — see test_watcher_rollback_no_marker_and_job_failed_is_
    # rollback_incomplete below, split out of this test (rollback no longer
    # shares teardown's plain job-status-driven classification at all).
    app, ops_store = _fake_app()
    op = ops_store.create("teardown", "key1")
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": "t0", "finished": "t1"})
    _run_watcher(app, op.operation_id, 111, "teardown", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED
    assert updated.error == "job-failed"


def test_watcher_promotes_to_running_before_resolving_terminal(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    calls = {"n": 0}
    observed_state_on_second_call = []

    def fake_get_job(**k):
        calls["n"] += 1
        if calls["n"] == 2:
            observed_state_on_second_call.append(ops_store.get(op.operation_id).state)
            return {"status": "successful", "started": "t0", "finished": "t1"}
        return {"status": "running", "started": "t0"}

    monkeypatch.setattr(main, "get_job", fake_get_job)
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")

    assert calls["n"] == 2
    assert observed_state_on_second_call == [OperationState.RUNNING]
    assert ops_store.get(op.operation_id).state == OperationState.RUN_COMPLETE


def test_watcher_tolerates_two_transient_failures_then_succeeds(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    calls = {"n": 0}

    def flaky_get_job(**k):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise TimeoutError("transient")
        return {"status": "successful", "started": "t0", "finished": "t1"}

    monkeypatch.setattr(main, "get_job", flaky_get_job)
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")

    assert calls["n"] == 3
    assert ops_store.get(op.operation_id).state == OperationState.RUN_COMPLETE


def test_watcher_gives_up_after_three_consecutive_failures(monkeypatch):
    def always_fail(**k):
        raise TimeoutError("boom")

    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    monkeypatch.setattr(main, "get_job", always_fail)
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED
    assert updated.error == "job-watch-lost"


def test_watcher_gives_up_on_timeout_without_calling_get_job(monkeypatch):
    def boom(**k):
        raise AssertionError("get_job must not be called once the watch deadline has passed")

    # A normal ttl_seconds (so GC doesn't sweep the op away the instant it
    # turns terminal, unlike ttl_seconds=0) — the deadline is elapsed by
    # backdating created_at instead, independent of the GC window.
    app, ops_store = _fake_app(ttl_seconds=3600)
    op = ops_store.create("deploy", "key1")
    op.created_at = datetime.now(timezone.utc) - timedelta(hours=2)
    monkeypatch.setattr(main, "get_job", boom)
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated is not None
    assert updated.state == OperationState.RUN_FAILED
    assert updated.error == "job-watch-timeout"


# ---------------------------------------------------------------------------
# main.py — watcher robustness (codex R2-4: started-evidence, fail-closed
# outer boundary, malformed-response validation)
# ---------------------------------------------------------------------------


def test_watcher_started_then_deploy_lost_after_three_failures_is_run_status_unknown(monkeypatch):
    # codex R2-4a (remapped by R3-2): seen_started is remembered ACROSS
    # polls, not just read fresh at a terminal poll — the give-up path (3
    # consecutive failures) has no fresh job dict to read `started` from at
    # all, so it must rely on that memory. codex R3-2: a watch-loss NEVER
    # claims FAILED_ROLLBACK_REQUIRED (that's reserved for a CONFIRMED AWX
    # failure, where the auto-trigger contract actually runs) — a deploy
    # whose watch was lost after starting is RUN_STATUS_UNKNOWN instead:
    # dirty (blocks the facility) but explicitly "we don't know", never
    # auto-triggering a rollback that might be premature.
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    calls = {"n": 0}

    def flaky_after_started(**k):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"status": "running", "started": "t0"}
        raise TimeoutError("boom")

    monkeypatch.setattr(main, "get_job", flaky_after_started)
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_STATUS_UNKNOWN
    assert updated.error == "job-watch-lost"
    assert updated.auto_rollback is None  # never auto-triggered from a give-up path


def test_watcher_never_started_then_lost_after_three_failures_is_run_failed(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")

    def always_fail(**k):
        raise TimeoutError("boom")

    monkeypatch.setattr(main, "get_job", always_fail)
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED
    assert updated.error == "job-watch-lost"


def test_watcher_started_then_teardown_lost_is_run_status_unknown(monkeypatch):
    # codex R3-2: teardown is NOT special-cased away from RUN_STATUS_UNKNOWN
    # the way it is from FAILED_ROLLBACK_REQUIRED — a lost watch is a "we
    # don't know" outcome for ANY non-rollback watched action, and must
    # still block the facility until an operator resolves it.
    app, ops_store = _fake_app()
    op = ops_store.create("teardown", "key1")
    calls = {"n": 0}

    def flaky_after_started(**k):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"status": "running", "started": "t0"}
        raise TimeoutError("boom")

    monkeypatch.setattr(main, "get_job", flaky_after_started)
    _run_watcher(app, op.operation_id, 111, "teardown", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_STATUS_UNKNOWN
    assert updated.error == "job-watch-lost"


def test_watcher_started_then_rollback_lost_after_three_failures_is_rollback_incomplete(monkeypatch):
    # codex R3-2: for action=="rollback" specifically, a lost watch after
    # starting maps to ROLLBACK_INCOMPLETE (its OWN existing dirty
    # terminal, R2-1), not the new RUN_STATUS_UNKNOWN — consistent with
    # rollback's marker-driven "never assume clean" posture; a lost watch
    # is just one more way to fail to confirm completion.
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "a" * 32)
    calls = {"n": 0}

    def flaky_after_started(**k):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"status": "running", "started": "t0"}
        raise TimeoutError("boom")

    monkeypatch.setattr(main, "get_job", flaky_after_started)
    _run_watcher(app, op.operation_id, 111, "rollback", "a" * 32)
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert updated.error == "job-watch-lost"


@pytest.mark.parametrize("action,seen_started,expected", [
    ("deploy", True, OperationState.RUN_STATUS_UNKNOWN),
    ("deploy", False, OperationState.RUN_FAILED),
    ("teardown", True, OperationState.RUN_STATUS_UNKNOWN),
    ("teardown", False, OperationState.RUN_FAILED),
    ("rollback", True, OperationState.ROLLBACK_INCOMPLETE),
    ("rollback", False, OperationState.RUN_FAILED),
])
def test_watch_lost_terminal_state_is_conservative(action, seen_started, expected):
    # codex R2-4a/R3-2: _watch_lost_terminal_state is the single shared
    # decision point for EVERY give-up path (3 consecutive failures, TTL
    # timeout, and the fail-closed outer crash handler) — unit-tested
    # directly here since the TTL-timeout path specifically can't be driven
    # through a live watcher run without real-wall-clock flakiness (the
    # deadline is a fixed datetime computed once at watcher start, not
    # re-read per iteration). The 3-consecutive-failures give-up path IS
    # exercised end-to-end by the tests above, which hit this exact
    # function for all three actions.
    assert main._watch_lost_terminal_state(action, seen_started) == expected


def test_watcher_started_then_deploy_ttl_timeout_is_run_status_unknown_no_auto_trigger(monkeypatch):
    # codex R3-2's explicit named case: a started-then-TTL-timed-out deploy
    # -> RUN_STATUS_UNKNOWN, auto_rollback stays None, and
    # _maybe_auto_trigger_rollback is NEVER called from a give-up path
    # (only the CONFIRMED-terminal branch inside the main loop body calls
    # it). Driven via a fake clock (main.datetime patched to a controllable
    # stand-in) rather than backdating created_at up front — backdating
    # BEFORE the watcher starts would make the deadline already-elapsed on
    # the very FIRST loop check, so get_job would never run and
    # seen_started could never become True; advancing the clock mid-run
    # (inside the first get_job call) is the only way to get both
    # seen_started=True AND a TTL timeout without real-wall-clock waiting.
    app, ops_store = _fake_app(ttl_seconds=3600)
    op = ops_store.create("deploy", "key1")
    real_now = [datetime.now(timezone.utc)]

    class _FakeDatetime:
        @staticmethod
        def now(tz=None):
            return real_now[0]

    def fake_get_job(**k):
        real_now[0] = real_now[0] + timedelta(hours=2)  # jump past the 1h TTL
        return {"status": "running", "started": "t0"}

    def boom(*a, **k):
        raise AssertionError("auto-trigger must never run from a give-up path")

    monkeypatch.setattr(main, "datetime", _FakeDatetime)
    monkeypatch.setattr(main, "get_job", fake_get_job)
    monkeypatch.setattr(main, "_maybe_auto_trigger_rollback", boom)

    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_STATUS_UNKNOWN
    assert updated.error == "job-watch-timeout"
    assert updated.auto_rollback is None


def test_watcher_started_deploy_lost_dirty_state_then_blocks_facility(monkeypatch):
    # Follow-through proof: the RUN_STATUS_UNKNOWN this watch-loss produces
    # isn't just a label — it actually blocks a new dispatch elsewhere via
    # _facility_busy_check, same as any other dirty state.
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    calls = {"n": 0}

    def flaky_after_started(**k):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"status": "running", "started": "t0"}
        raise TimeoutError("boom")

    monkeypatch.setattr(main, "get_job", flaky_after_started)
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    assert ops_store.get(op.operation_id).state == OperationState.RUN_STATUS_UNKNOWN

    blocking = main._facility_busy_check(ops_store, current_target="other-key", current_action="deploy")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_watcher_started_rollback_lost_dirty_state_then_blocks_facility(monkeypatch):
    # codex R3-2's explicit named case: started-rollback-3-failures ->
    # ROLLBACK_INCOMPLETE, and it still blocks the facility.
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "a" * 32)
    calls = {"n": 0}

    def flaky_after_started(**k):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"status": "running", "started": "t0"}
        raise TimeoutError("boom")

    monkeypatch.setattr(main, "get_job", flaky_after_started)
    _run_watcher(app, op.operation_id, 111, "rollback", "a" * 32)
    assert ops_store.get(op.operation_id).state == OperationState.ROLLBACK_INCOMPLETE

    blocking = main._facility_busy_check(ops_store, current_target="other-key", current_action="deploy")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_watcher_malformed_get_job_response_is_terminalized_not_stranded(monkeypatch):
    # codex R2-4b/c: get_job returning a shape that isn't {"status": str,
    # ...} (here: a bare list) must terminalize via the fail-closed outer
    # try/except, not strand the op mid-flight or propagate the crash.
    # codex R3-7: op.error carries only the STABLE token, never the
    # exception's own repr (that goes to the server-side logger only).
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    monkeypatch.setattr(main, "get_job", lambda **k: [])
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED  # never started -> conservative default
    assert updated.error == "job-watch-crashed"


def test_watcher_get_job_response_missing_status_is_terminalized(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")
    monkeypatch.setattr(main, "get_job", lambda **k: {"started": "t0"})  # no "status" key at all
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_STATUS_UNKNOWN  # started WAS truthy before the crash
    assert updated.error == "job-watch-crashed"


def test_watcher_missing_operation_returns_without_error(monkeypatch):
    def boom(**k):
        raise AssertionError("get_job must not be called for a missing operation")

    app, _ops_store = _fake_app()
    monkeypatch.setattr(main, "get_job", boom)
    _run_watcher(app, "nonexistent-operation-id", 111, "deploy", "key1")  # must not raise


# ---------------------------------------------------------------------------
# main.py — _extract_run_id_from_job (codex R3-3: reattach identity
# hydration; made ACTION-AWARE + hex32-validated by R4-2/R4-4)
# ---------------------------------------------------------------------------


def test_extract_run_id_from_job_deploy_parses_l3_request_id():
    hex32 = "a" * 32
    job = {"id": 42, "extra_vars": '{"l3_request_id": "' + hex32 + '"}'}
    assert main._extract_run_id_from_job(job, action="deploy") == hex32


def test_extract_run_id_from_job_teardown_parses_l3_request_id():
    hex32 = "a" * 32
    job = {"extra_vars": '{"l3_request_id": "' + hex32 + '"}'}
    assert main._extract_run_id_from_job(job, action="teardown") == hex32


def test_extract_run_id_from_job_rollback_parses_l3_run_id_not_l3_request_id():
    # codex R4-2a: for a ROLLBACK job, the identity is l3_run_id (the
    # snapshot target), NOT l3_request_id (that launch attempt's own
    # dispatch correlator) — the two are deliberately different values on
    # a real rollback job.
    run_id = "a" * 32
    dispatch_correlator = "b" * 32
    job = {"extra_vars": f'{{"l3_run_id": "{run_id}", "l3_request_id": "{dispatch_correlator}"}}'}
    assert main._extract_run_id_from_job(job, action="rollback") == run_id


def test_extract_run_id_from_job_rollback_ignores_l3_request_id_when_l3_run_id_absent():
    # A rollback job's l3_request_id alone must never be mistaken for its
    # l3_run_id — absence of l3_run_id is absence of identity, full stop.
    job = {"extra_vars": '{"l3_request_id": "' + ("b" * 32) + '"}'}
    assert main._extract_run_id_from_job(job, action="rollback") is None


def test_extract_run_id_from_job_missing_extra_vars_key():
    assert main._extract_run_id_from_job({"id": 42}, action="deploy") is None


def test_extract_run_id_from_job_extra_vars_not_a_string():
    # AWX always returns extra_vars as a JSON-encoded STRING, never a
    # nested object — a shape mismatch must never raise.
    assert main._extract_run_id_from_job({"extra_vars": {"l3_request_id": "a" * 32}}, action="deploy") is None


def test_extract_run_id_from_job_extra_vars_unparseable_json():
    assert main._extract_run_id_from_job({"extra_vars": "{not valid json"}, action="deploy") is None


def test_extract_run_id_from_job_extra_vars_json_not_an_object():
    assert main._extract_run_id_from_job({"extra_vars": "[1, 2, 3]"}, action="deploy") is None


def test_extract_run_id_from_job_no_l3_request_id_key():
    assert main._extract_run_id_from_job({"extra_vars": '{"workload_slug": "studio-a"}'}, action="deploy") is None


def test_extract_run_id_from_job_l3_request_id_not_a_string():
    assert main._extract_run_id_from_job({"extra_vars": '{"l3_request_id": 12345}'}, action="deploy") is None


def test_extract_run_id_from_job_l3_request_id_empty_string():
    assert main._extract_run_id_from_job({"extra_vars": '{"l3_request_id": ""}'}, action="deploy") is None


def test_extract_run_id_from_job_value_must_be_hex32(monkeypatch):
    # codex R4-4: the extracted value must fullmatch the SAME lowercase
    # hex-32 shape the manual rollback endpoint validates run_id against
    # (main._RUN_ID_RE) — anything else is treated as absent, not passed
    # through verbatim.
    assert main._extract_run_id_from_job({"extra_vars": '{"l3_request_id": "not-a-uuid"}'}, action="deploy") is None
    assert main._extract_run_id_from_job({"extra_vars": '{"l3_request_id": "' + ("A" * 32) + '"}'}, action="deploy") is None  # uppercase
    assert main._extract_run_id_from_job({"extra_vars": '{"l3_request_id": "' + ("a" * 31) + '"}'}, action="deploy") is None  # too short
    assert main._extract_run_id_from_job({"extra_vars": '{"l3_request_id": "' + ("a" * 33) + '"}'}, action="deploy") is None  # too long


# ---------------------------------------------------------------------------
# main.py — async reattach hydrates run_id from the AWX job's own extra_vars
# (codex R3-3)
# ---------------------------------------------------------------------------


def test_run_deploy_operation_reattach_hydrates_run_id_from_job_extra_vars(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1", request_id="d" * 32, initiator="alice")

    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    monkeypatch.setattr(main, "call_with_transient_retry", lambda fn: fn())
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 9999)  # active job found -> reattach
    monkeypatch.setattr(
        main, "get_job", lambda **k: {"id": 9999, "extra_vars": '{"l3_request_id": "' + ("f" * 32) + '"}'},
    )
    # Prevent the watcher this reattach spawns from making real network calls.
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: "no marker\n")

    asyncio.run(main._run_deploy_operation(app, op.operation_id, "key1", "dmf-configure"))

    updated = ops_store.get(op.operation_id)
    assert updated.job_id == 9999
    # The REATTACHED job's own identity ("z"*32), NOT this op's own
    # request_id ("d"*32) — this console didn't launch job 9999 itself.
    assert updated.run_id == "f" * 32


def test_run_deploy_operation_reattach_tolerates_get_job_failure(monkeypatch):
    # codex R3-3: a failure fetching the reattached job's own detail must
    # never crash the reattach — run_id just stays None (identity unknown).
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1", request_id="d" * 32)

    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    monkeypatch.setattr(main, "call_with_transient_retry", lambda fn: fn())
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 9999)

    def boom(**k):
        raise TimeoutError("no route to AWX")

    monkeypatch.setattr(main, "get_job", boom)

    asyncio.run(main._run_deploy_operation(app, op.operation_id, "key1", "dmf-configure"))

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.LAUNCHED
    assert updated.job_id == 9999
    assert updated.run_id is None


# ---------------------------------------------------------------------------
# main.py — _track_sync_reattach / _track_sync_rollback_reattach idempotency
# (codex R4-3): a SECOND already-active discovery for a target already
# tracked must reattach, not retarget or double-watch.
# ---------------------------------------------------------------------------


def test_track_sync_reattach_second_call_reattaches_without_overwrite_or_second_watcher(monkeypatch):
    app, ops_store = _fake_app()
    watcher_calls = []
    monkeypatch.setattr(
        main, "_spawn_job_watcher",
        lambda app, op_id, job_id, action, target: watcher_calls.append((op_id, job_id)),
    )
    monkeypatch.setattr(main, "get_job", lambda **k: {"extra_vars": '{"l3_request_id": "' + ("a" * 32) + '"}'})

    op_id_1 = main._track_sync_reattach(
        app, ops_store, "req-1", "alice", action="deploy", target="key1", job_id=111,
    )
    op_id_2 = main._track_sync_reattach(
        app, ops_store, "req-2", "bob", action="deploy", target="key1", job_id=222,
    )

    assert op_id_1 == op_id_2
    assert len(watcher_calls) == 1  # exactly one watcher spawned, not two
    op = ops_store.get(op_id_1)
    assert op.job_id == 111  # the SECOND call's job_id (222) never overwrote this
    assert op.initiator == "alice"  # the original dispatch's own identity, unchanged


def test_track_sync_rollback_reattach_second_call_reattaches_without_overwrite_or_second_watcher(monkeypatch):
    app, ops_store = _fake_app()
    run_id = "a" * 32
    watcher_calls = []
    monkeypatch.setattr(
        main, "_spawn_job_watcher",
        lambda app, op_id, job_id, action, target: watcher_calls.append((op_id, job_id)),
    )
    monkeypatch.setattr(
        main, "get_job", lambda **k: {"extra_vars": f'{{"l3_run_id": "{run_id}"}}'},
    )

    op_id_1, mismatch_1 = main._track_sync_rollback_reattach(
        app, ops_store, "req-1", "alice", run_id=run_id, job_id=111,
    )
    op_id_2, mismatch_2 = main._track_sync_rollback_reattach(
        app, ops_store, "req-2", "bob", run_id=run_id, job_id=222,
    )

    assert mismatch_1 is False and mismatch_2 is False
    assert op_id_1 == op_id_2
    assert len(watcher_calls) == 1
    op = ops_store.get(op_id_1)
    assert op.job_id == 111
    assert op.initiator == "alice"


# ---------------------------------------------------------------------------
# main.py — R4-4's named test: an invalid l3_request_id on reattach flows
# all the way through to auto-trigger's identity-unknown handling
# ---------------------------------------------------------------------------


def test_reattached_deploy_with_invalid_extra_vars_uuid_is_identity_unknown_on_auto_trigger(monkeypatch):
    app, ops_store = _fake_app(auto_rollback=True)
    op = ops_store.create("deploy", "key1", request_id="d" * 32)

    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    monkeypatch.setattr(main, "call_with_transient_retry", lambda fn: fn())
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 9999)
    monkeypatch.setattr(
        main, "get_job", lambda **k: {"id": 9999, "extra_vars": '{"l3_request_id": "not-a-uuid"}'},
    )
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: "no marker\n")

    asyncio.run(main._run_deploy_operation(app, op.operation_id, "key1", "dmf-configure"))
    assert ops_store.get(op.operation_id).run_id is None  # codex R4-4: rejected, not passed through

    def boom(*a, **k):
        raise AssertionError("must not dispatch when the run identity is unknown")

    monkeypatch.setattr(main, "_spawn_rollback_task", boom)
    ops_store.update(op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED)
    asyncio.run(main._maybe_auto_trigger_rollback(app, op.operation_id, "key1"))
    assert ops_store.get(op.operation_id).auto_rollback == "identity-unknown"


# ---------------------------------------------------------------------------
# awx.py — get_job / get_job_stdout
# ---------------------------------------------------------------------------


def test_get_job_returns_raw_dict(monkeypatch):
    captured = {}

    def fake_request(api_url, api_token, method, path, body=None, ssl_context=None):
        captured.update(api_url=api_url, api_token=api_token, method=method, path=path)
        return {"id": 42, "status": "successful", "started": "t0", "finished": "t1"}

    monkeypatch.setattr(awx, "_request", fake_request)
    result = awx.get_job(api_url="http://awx.test", api_token="tok", job_id=42)
    assert result == {"id": 42, "status": "successful", "started": "t0", "finished": "t1"}
    assert captured["method"] == "GET"
    assert captured["path"] == "/api/v2/jobs/42/"


def test_get_job_stdout_returns_text_via_request_text(monkeypatch):
    captured = {}
    stdout = "PLAY [demo] ****\nTASK [debug] ****\nok: [localhost]\n"

    def fake_request_text(api_url, api_token, method, path, ssl_context=None):
        captured.update(method=method, path=path)
        return stdout

    monkeypatch.setattr(awx, "_request_text", fake_request_text)
    result = awx.get_job_stdout(api_url="http://awx.test", api_token="tok", job_id=42)
    assert result == stdout
    assert captured["method"] == "GET"
    assert captured["path"] == "/api/v2/jobs/42/stdout/?format=txt"


class _FakeHTTPResponse:
    """A file-like fake matching urllib's response object — codex R3-6:
    ``read(size)`` is chunk-aware (mirrors a real socket-backed response,
    which never has to return exactly ``size`` bytes on the last chunk) and
    records every call's ``size`` argument so a test can assert
    ``_request_text`` never asks for an unbounded (full-body) read.
    """
    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0
        self.read_sizes: list[int | None] = []

    def read(self, size=None):
        self.read_sizes.append(size)
        if size is None or size < 0:
            raise AssertionError("read() must never be called unbounded (full-body read)")
        chunk = self._data[self._pos:self._pos + size]
        self._pos += len(chunk)
        return chunk

    def close(self):
        pass  # HTTPError wraps fp in a tempfile closer that expects this

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def test_get_job_stdout_truncates_to_tail_bound(monkeypatch):
    # codex R2-9/R3-6: only the last _STDOUT_TAIL_BYTES survive — the
    # outcome marker is always the LAST matching line, so the tail is
    # sufficient, and a job's full raw log must never ride further than
    # that fixed cap. Mocked at the urlopen transport layer (not
    # _request_text itself) so this actually exercises the streaming
    # tail-window logic, not just a post-hoc slice.
    sentinel = "UNIQUE-START-OF-LOG-SENTINEL"
    filler = "x" * (awx._STDOUT_TAIL_BYTES * 2)
    marker_line = "DMF_L3_OUTCOME: rollback_complete\n"
    stdout = sentinel + filler + marker_line

    fake_resp = _FakeHTTPResponse(stdout.encode())
    monkeypatch.setattr(
        awx.urllib.request, "urlopen",
        lambda req, timeout=30, context=None: fake_resp,
    )
    result = awx.get_job_stdout(api_url="http://awx.test", api_token="tok", job_id=42)

    assert len(result.encode("utf-8", errors="surrogateescape")) == awx._STDOUT_TAIL_BYTES
    assert result.endswith(marker_line)
    assert sentinel not in result  # the truncated-away log head is gone


def test_get_job_stdout_under_bound_is_unchanged(monkeypatch):
    stdout = "PLAY [demo]\nDMF_L3_OUTCOME: rollback_complete\n"
    fake_resp = _FakeHTTPResponse(stdout.encode())
    monkeypatch.setattr(
        awx.urllib.request, "urlopen",
        lambda req, timeout=30, context=None: fake_resp,
    )
    result = awx.get_job_stdout(api_url="http://awx.test", api_token="tok", job_id=42)
    assert result == stdout


def test_request_text_streams_in_bounded_chunks_never_full_body_read(monkeypatch):
    # codex R3-6 TEST-CRITICAL: discriminates at the read boundary — the
    # fake response's read() raises if ever called unbounded (size=None or
    # negative, the "read everything" convention), which is exactly what a
    # naive `resp.read()` full-body fetch would do. Every recorded call
    # must be a small, fixed positive chunk size, and there must be more
    # than one call for a body bigger than one chunk (proving it's
    # genuinely streamed, not read in one giant "chunk").
    huge_body = ("x" * (awx._TEXT_READ_CHUNK_BYTES * 5)).encode()
    fake_resp = _FakeHTTPResponse(huge_body)
    monkeypatch.setattr(
        awx.urllib.request, "urlopen",
        lambda req, timeout=30, context=None: fake_resp,
    )
    awx._request_text("http://awx.test", "tok", "GET", "/api/v2/jobs/42/stdout/?format=txt")

    assert len(fake_resp.read_sizes) > 1
    assert all(s == awx._TEXT_READ_CHUNK_BYTES for s in fake_resp.read_sizes)


def test_request_text_error_path_bounds_the_read_too(monkeypatch):
    # codex R4-5: the HTTPError path must ALSO never call an unbounded
    # exc.read() — same read-boundary discrimination as the success path,
    # applied to the error body.
    huge_error_body = ("e" * (awx._TEXT_READ_CHUNK_BYTES * 5)).encode()
    fake_fp = _FakeHTTPResponse(huge_error_body)

    def fake_urlopen(req, timeout=30, context=None):
        raise awx.urllib.error.HTTPError(
            "http://awx.test/api/v2/jobs/42/stdout/?format=txt", 500, "Internal Server Error", {}, fake_fp,
        )

    monkeypatch.setattr(awx.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(awx.AWXAPIError) as exc_info:
        awx._request_text("http://awx.test", "tok", "GET", "/api/v2/jobs/42/stdout/?format=txt")

    assert exc_info.value.status == 500
    assert len(fake_fp.read_sizes) >= 1
    assert all(s is not None and s >= 0 for s in fake_fp.read_sizes)  # never an unbounded read
    assert len(exc_info.value.body.encode()) <= awx._TEXT_READ_CHUNK_BYTES


def test_request_text_returns_raw_text_not_json_parsed(monkeypatch):
    # Job stdout is plain text, not valid JSON — _request's json.loads would
    # raise on it. _request_text must return the decoded body as-is, at the
    # actual transport layer (urlopen), not just delegate-and-trust.
    raw_text = "PLAY [demo] ****\nTASK [debug] ****\nok: [localhost]\n"
    monkeypatch.setattr(
        awx.urllib.request, "urlopen",
        lambda req, timeout=30, context=None: _FakeHTTPResponse(raw_text.encode()),
    )
    result = awx._request_text("http://awx.test", "tok", "GET", "/api/v2/jobs/42/stdout/?format=txt")
    assert result == raw_text


# ---------------------------------------------------------------------------
# main.py — _facility_busy_check (advisory facility lock, umbrella #202 WP2 §4.5 P2-2)
# ---------------------------------------------------------------------------


def test_facility_busy_check_blocks_on_cross_target_running_deploy():
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key-a")
    store.update(op.operation_id, state=OperationState.RUNNING, job_id=1)
    blocking = main._facility_busy_check(store, current_target="key-b")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_facility_busy_check_blocks_on_cross_target_running_rollback():
    store = OperationStore(ttl_seconds=3600)
    op = store.create("rollback", "a" * 32)
    store.update(op.operation_id, state=OperationState.RUNNING, job_id=1)
    blocking = main._facility_busy_check(store, current_target="key-b")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_facility_busy_check_blocks_on_cross_target_launched_teardown():
    # Teardown dispatch itself is NOT facility-gated, but an in-flight
    # teardown of ANOTHER entry still counts as "busy" when a NEW
    # deploy/rollback checks — it's the caller (deploy/rollback dispatch)
    # that decides whether to call this helper at all; teardown's own
    # dispatch path never does.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("teardown", "key-a")
    store.update(op.operation_id, state=OperationState.LAUNCHED, job_id=1)
    blocking = main._facility_busy_check(store, current_target="key-b")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_facility_busy_check_same_target_non_terminal_blocks_when_called_directly():
    # codex R3-1: the blanket same-target skip is GONE — called directly
    # (bypassing the real dispatch flow), a same-target non-terminal op now
    # returns as blocking, not exempted. In the REAL flow this exact
    # scenario can't arise: the per-entry dedupe
    # (get_or_create/get_or_create_exclusive) reattaches to a same-target
    # non-terminal op BEFORE this check ever runs — see
    # test_facility_check_ignores_same_target in test_rollback_command.py
    # for that end-to-end guarantee, still intact.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key-a")
    store.update(op.operation_id, state=OperationState.RUNNING, job_id=1)
    blocking = main._facility_busy_check(store, current_target="key-a")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_facility_busy_check_current_operation_id_exempts_self():
    # codex R3-1: this is the mechanism the async deploy/teardown flow
    # relies on in place of the old same-target skip — the JUST-CREATED op
    # for THIS dispatch must never block itself when the facility check
    # runs AFTER creation (get_or_create_exclusive's atomicity requirement
    # — see _facility_busy_check's "Ordering per flow" docstring section).
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key-a")
    store.update(op.operation_id, state=OperationState.WAKING)
    assert main._facility_busy_check(
        store, current_target="key-a", current_operation_id=op.operation_id,
    ) is None


def test_facility_busy_check_dirty_same_target_blocks_a_new_deploy_of_that_target():
    # codex R3-1's headline behavior change: a FAILED_ROLLBACK_REQUIRED
    # deploy of catalog key K now blocks a NEW deploy of K too (not just
    # OTHER targets) — plan §4.5 is "one run at a time, full stop". This is
    # what actually happens end-to-end: get_or_create_exclusive treats the
    # dirty op as terminal (so it creates a genuinely NEW op for K rather
    # than reattaching/conflicting), and THIS check then blocks that new op
    # via same-target dirty-state detection.
    store = OperationStore(ttl_seconds=3600)
    dirty_op = store.create("deploy", "key-a", request_id="e" * 32)
    store.update(dirty_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1)
    new_op = store.create("deploy", "key-a", request_id="f" * 32)
    blocking = main._facility_busy_check(
        store, current_target="key-a", current_action="deploy", current_operation_id=new_op.operation_id,
    )
    assert blocking is not None and blocking.operation_id == dirty_op.operation_id


@pytest.mark.parametrize("state", [OperationState.RUN_COMPLETE, OperationState.RUN_FAILED, OperationState.ERROR])
def test_facility_busy_check_ignores_clean_terminal_ops(state):
    # Clean terminal states (not DIRTY — see below) never block a new
    # dispatch elsewhere.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key-a")
    store.update(op.operation_id, state=state, job_id=1)
    assert main._facility_busy_check(store, current_target="key-b") is None, state


def test_facility_busy_check_ignores_launch_action():
    # A generic AWX workflow launch unrelated to catalog lifecycle must
    # never block a deploy/rollback dispatch.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("launch", "some-workflow")
    store.update(op.operation_id, state=OperationState.LAUNCHED, job_id=1)
    assert main._facility_busy_check(store, current_target="key-b") is None


# ---------------------------------------------------------------------------
# main.py — _facility_busy_check dirty-state model (codex R2-6)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("state", [
    OperationState.FAILED_ROLLBACK_REQUIRED, OperationState.ROLLBACK_INCOMPLETE, OperationState.RUN_STATUS_UNKNOWN,
])
def test_facility_busy_check_blocks_on_dirty_terminal_states(state):
    # codex R2-6: a run that STOPPED but may have left surfaces dirty must
    # still block a new dispatch to a DIFFERENT target, even though the
    # blocking op's own state is terminal for dedupe/GC purposes.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key-a", request_id="e" * 32)
    store.update(op.operation_id, state=state, job_id=1)
    blocking = main._facility_busy_check(store, current_target="key-b")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_facility_busy_check_dirty_state_blocks_teardown_too():
    # codex R2-6: teardown dispatch now also gets the facility check, and a
    # dirty run must block it just like a new deploy/rollback.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key-a", request_id="f" * 32)
    store.update(op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1)
    blocking = main._facility_busy_check(store, current_target="key-b", current_action="teardown")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_facility_busy_check_teardown_vs_teardown_cross_target_now_blocks():
    # codex R3-5: the R2-6(c) teardown-vs-teardown cross-target exemption
    # is REMOVED — plan §4.5 is "one run at a time, full stop", verbatim;
    # the AWX Container Group cap is execution serialization, not a
    # substitute for the advisory refusal.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("teardown", "key-a")
    store.update(op.operation_id, state=OperationState.RUNNING, job_id=1)
    blocking = main._facility_busy_check(store, current_target="key-b", current_action="teardown")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_facility_busy_check_teardown_vs_deploy_cross_target_still_blocks():
    # The teardown-vs-teardown exemption is narrow: a RUNNING deploy of a
    # different entry still blocks a new teardown.
    store = OperationStore(ttl_seconds=3600)
    op = store.create("deploy", "key-a")
    store.update(op.operation_id, state=OperationState.RUNNING, job_id=1)
    blocking = main._facility_busy_check(store, current_target="key-b", current_action="teardown")
    assert blocking is not None and blocking.operation_id == op.operation_id


def test_facility_busy_check_rollback_of_dirty_run_is_not_blocked_by_itself():
    # codex R2-6(d), corrected by R4-1: a rollback dispatch for run_id R
    # must never be blocked by the very deploy op that run_id is rolling
    # back — that op's run_id (HYDRATED identity, not request_id) IS R, and
    # the plan §4.5 retry guarantee requires this exception (excluded even
    # though op.target == "key-a" != current_target == R, which the plain
    # same-target check alone would not catch). A fresh dispatch's run_id
    # equals its request_id, so both are set identically here.
    store = OperationStore(ttl_seconds=3600)
    run_id = "a" * 32
    deploy_op = store.create("deploy", "key-a", request_id=run_id)
    store.update(deploy_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1, run_id=run_id)
    assert main._facility_busy_check(store, current_target=run_id, current_action="rollback") is None


def test_facility_busy_check_rollback_matches_on_run_id_not_request_id():
    # codex R4-1 P1-1: codex's exact probe — a REATTACHED op whose
    # request_id (this dispatch attempt's own bookkeeping id) differs from
    # its run_id (the hydrated AWX-job identity). A rollback of the run_id
    # must pass; a prior draft compared against request_id instead and
    # would have wrongly blocked this.
    store = OperationStore(ttl_seconds=3600)
    run_id = "a" * 32
    dispatch_request_id = "b" * 32
    deploy_op = store.create("deploy", "key-a", request_id=dispatch_request_id)
    store.update(
        deploy_op.operation_id, state=OperationState.RUN_STATUS_UNKNOWN, job_id=1, run_id=run_id,
    )
    assert deploy_op.request_id != deploy_op.run_id
    assert main._facility_busy_check(store, current_target=run_id, current_action="rollback") is None
    # Confirm the request_id itself is NOT what exempts it — a rollback
    # "targeting" the dispatch request_id (which nothing would ever
    # legitimately do, but proves the comparison field) still blocks.
    blocking = main._facility_busy_check(store, current_target=dispatch_request_id, current_action="rollback")
    assert blocking is not None and blocking.operation_id == deploy_op.operation_id


# ---------------------------------------------------------------------------
# main.py — R5: the matching-rollback exemption is scoped to a DIRTY-
# RECOVERABLE DEPLOY only (action=="deploy" AND state in
# {FAILED_ROLLBACK_REQUIRED, RUN_STATUS_UNKNOWN}), not a bare run_id match —
# codex's three named probes.
# ---------------------------------------------------------------------------


def test_facility_busy_check_running_deploy_blocks_rollback_of_its_own_run_id():
    # codex R5 probe 1: a deploy that's still LIVE (RUNNING, not yet dirty)
    # must NOT be exempted just because its run_id matches the rollback
    # target — a rollback of a run that hasn't even finished must wait for
    # it to reach a terminal (dirty) state, not race it. One run at a time.
    store = OperationStore(ttl_seconds=3600)
    run_id = "a" * 32
    deploy_op = store.create("deploy", "key-a", request_id=run_id)
    store.update(deploy_op.operation_id, state=OperationState.RUNNING, job_id=1, run_id=run_id)
    blocking = main._facility_busy_check(store, current_target=run_id, current_action="rollback")
    assert blocking is not None and blocking.operation_id == deploy_op.operation_id


def test_facility_busy_check_rollback_incomplete_op_own_run_id_collision_does_not_exempt():
    # codex R5 probe 2: a ROLLBACK_INCOMPLETE op (action=="rollback")
    # rolling back run A has its OWN run_id set to ITS dispatch correlator
    # (an arbitrary hex32 — see _run_rollback_operation), which can
    # coincidentally equal some UNRELATED run_id B. That coincidence must
    # never exempt this op from blocking a genuinely unrelated new
    # rollback of B — only a deploy op's run_id is a real snapshot-
    # identity claim.
    store = OperationStore(ttl_seconds=3600)
    run_a = "a" * 32
    coincidental_b = "b" * 32
    rollback_op = store.create("rollback", run_a, request_id=coincidental_b)
    store.update(rollback_op.operation_id, state=OperationState.ROLLBACK_INCOMPLETE, job_id=1, run_id=coincidental_b)
    blocking = main._facility_busy_check(store, current_target=coincidental_b, current_action="rollback")
    assert blocking is not None and blocking.operation_id == rollback_op.operation_id


def test_facility_busy_check_run_status_unknown_teardown_own_run_id_collision_does_not_exempt():
    # codex R5 probe 3: same collision, for a RUN_STATUS_UNKNOWN teardown.
    store = OperationStore(ttl_seconds=3600)
    coincidental_target = "c" * 32
    teardown_op = store.create("teardown", "some-key", request_id=coincidental_target)
    store.update(
        teardown_op.operation_id, state=OperationState.RUN_STATUS_UNKNOWN, job_id=1, run_id=coincidental_target,
    )
    blocking = main._facility_busy_check(store, current_target=coincidental_target, current_action="rollback")
    assert blocking is not None and blocking.operation_id == teardown_op.operation_id


def test_facility_busy_check_rollback_retry_of_same_run_passes():
    # codex R2-6(d): a prior ROLLBACK_INCOMPLETE attempt for the SAME run_id
    # must not block a retry of that same run's rollback — already covered
    # by the plain same-target skip (op.target == current_target == run_id),
    # confirmed explicitly here since it's one of the two named R2-6(d) cases.
    store = OperationStore(ttl_seconds=3600)
    run_id = "b" * 32
    prior_attempt = store.create("rollback", run_id, request_id="c" * 32)
    store.update(prior_attempt.operation_id, state=OperationState.ROLLBACK_INCOMPLETE, job_id=1)
    assert main._facility_busy_check(store, current_target=run_id, current_action="rollback") is None


def test_facility_busy_check_dirty_run_still_blocks_an_unrelated_rollback():
    # A dirty deploy op DOES block a rollback of a DIFFERENT run_id — the
    # R2-6(d) exception is narrowly scoped to the matching run only.
    store = OperationStore(ttl_seconds=3600)
    dirty_op = store.create("deploy", "key-a", request_id="d" * 32)
    store.update(dirty_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1)
    other_run_id = "1" * 32
    blocking = main._facility_busy_check(store, current_target=other_run_id, current_action="rollback")
    assert blocking is not None and blocking.operation_id == dirty_op.operation_id


# ---------------------------------------------------------------------------
# main.py — _fetch_l3_outcome (§4.6 outcome marker parsing)
# ---------------------------------------------------------------------------


def _fake_app_for_outcome():
    settings = Settings(awx=AWXSettings(api_url="http://awx.test", api_token="t"))
    return SimpleNamespace(state=SimpleNamespace(settings=settings))


@pytest.mark.parametrize("token", [
    "facility-busy", "no-snapshot", "stale-snapshot", "rollback_complete",
    "rollback_incomplete", "no-fit", "missing-budget", "some-future-token",
])
def test_fetch_l3_outcome_parses_each_known_and_unknown_token(monkeypatch, token):
    app = _fake_app_for_outcome()
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: f"PLAY [x]\nTASK [y]\nDMF_L3_OUTCOME: {token}\n")
    tok, kv = asyncio.run(main._fetch_l3_outcome(app, 42))
    assert tok == token
    assert kv is None


def test_fetch_l3_outcome_captures_kv_detail(monkeypatch):
    app = _fake_app_for_outcome()
    monkeypatch.setattr(
        main, "get_job_stdout",
        lambda **k: "DMF_L3_OUTCOME: rollback_incomplete surfaces=netbox,helm\n",
    )
    tok, kv = asyncio.run(main._fetch_l3_outcome(app, 42))
    assert tok == "rollback_incomplete"
    assert kv == "surfaces=netbox,helm"


# ---------------------------------------------------------------------------
# main.py — _sanitize_kv (codex R2-9/R3-7 §6 public-safety: allow-list with
# STRICT PER-KEY value rules for the outcome marker's kv detail before it
# can reach `error`/an API response — no shared generic charset, no
# free-text key at all)
# ---------------------------------------------------------------------------


def test_sanitize_kv_keeps_surfaces_with_valid_subset():
    assert main._sanitize_kv("surfaces=netbox,helm") == "surfaces=netbox,helm"
    assert main._sanitize_kv("surfaces=monitoring") == "surfaces=monitoring"


def test_sanitize_kv_drops_surfaces_with_unknown_member():
    # codex R3-7: only netbox/helm/monitoring are valid surface names —
    # anything else in the comma list fails the WHOLE value, not just that
    # member (no partial survival within one value).
    assert main._sanitize_kv("surfaces=netbox,unknown") is None
    assert main._sanitize_kv("surfaces=") is None


def test_sanitize_kv_run_id_and_request_id_must_be_bare_hex32():
    hex32 = "a" * 32
    assert main._sanitize_kv(f"run_id={hex32}") == f"run_id={hex32}"
    assert main._sanitize_kv(f"request_id={hex32}") == f"request_id={hex32}"
    # codex R3-7: kill the IP/dotted/colon-shaped leak — a prior draft's
    # broad charset let values like these through. RFC 5737 documentation
    # addresses: IP-shaped for the sanitizer, public-safe for the repo's own
    # dmf-private-network-literal gitleaks rule (which rightly flagged the
    # private-range literals a prior fixture used).
    assert main._sanitize_kv("run_id=203.0.113.7") is None
    assert main._sanitize_kv("run_id=198.51.100.9:8080") is None
    assert main._sanitize_kv(f"run_id={hex32}extra") is None  # too long
    assert main._sanitize_kv(f"run_id={hex32[:-1]}") is None  # too short
    assert main._sanitize_kv(f"run_id={'A' * 32}") is None  # uppercase not hex-lower


def test_sanitize_kv_detail_key_is_dropped_entirely():
    # codex R3-7: the prior draft's generic free-text "detail" key is GONE
    # — there is no key that accepts arbitrary text anymore, regardless of
    # how charset-clean the value looks.
    assert main._sanitize_kv("detail=some-safe-looking-text") is None
    assert main._sanitize_kv("detail=timeout") is None


def test_sanitize_kv_drops_disallowed_key():
    # A key outside {surfaces,request_id,run_id} — the ORIGINAL WP2-B
    # marker prose used "dirty_surfaces", which R2-9/R3-7 disallows.
    assert main._sanitize_kv("dirty_surfaces=netbox,helm") is None


def test_sanitize_kv_keeps_allowed_tokens_and_drops_disallowed_ones_from_a_mixed_line():
    hex32 = "b" * 32
    result = main._sanitize_kv(f"surfaces=netbox evil=`x` run_id={hex32} detail=timeout")
    assert result == f"surfaces=netbox run_id={hex32}"


def test_sanitize_kv_caps_total_length():
    # Multiple valid tokens combined can still exceed the total cap even
    # though each individual value is well-formed and short.
    hex32 = "c" * 32
    surfaces_value = ",".join(["netbox", "helm", "monitoring"] * 40)  # well over 500 chars
    kv = f"surfaces={surfaces_value} run_id={hex32} request_id={hex32}"
    result = main._sanitize_kv(kv)
    assert result is not None
    assert len(result) == main._KV_MAX_LEN


def test_sanitize_kv_none_and_empty_and_all_noise_return_none():
    assert main._sanitize_kv(None) is None
    assert main._sanitize_kv("") is None
    assert main._sanitize_kv("not-a-kv-pair") is None
    assert main._sanitize_kv("badkey=value") is None


def test_fetch_l3_outcome_last_matching_line_wins(monkeypatch):
    # This IS the marker-is-the-final-line case (codex R3-7) — the LAST
    # marker also happens to be the final non-empty line of the stdout,
    # nothing follows it, so it parses.
    app = _fake_app_for_outcome()
    stdout = (
        "DMF_L3_OUTCOME: no-fit\n"
        "some progress\n"
        "DMF_L3_OUTCOME: rollback_complete\n"
    )
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: stdout)
    tok, kv = asyncio.run(main._fetch_l3_outcome(app, 42))
    assert tok == "rollback_complete"


def test_fetch_l3_outcome_trailing_blank_lines_after_marker_still_parse(monkeypatch):
    # codex R3-7: trailing BLANK lines (whitespace-only) after the marker
    # don't count as "meaningful output" — the marker is still effectively
    # the last word.
    app = _fake_app_for_outcome()
    stdout = "DMF_L3_OUTCOME: rollback_complete\n\n   \n"
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: stdout)
    tok, kv = asyncio.run(main._fetch_l3_outcome(app, 42))
    assert tok == "rollback_complete"


def test_fetch_l3_outcome_marker_followed_by_more_output_is_ignored(monkeypatch):
    # codex R3-7 TEST-CRITICAL: the marker must be the FINAL non-empty line
    # of stdout — a play that logs a marker mid-run and then keeps going
    # (a later cleanup step, an unrelated log line) must NOT have that
    # earlier marker mistaken for the run's actual final word. This is
    # stricter than "last MATCHING line wins" (the prior draft's rule,
    # still true when nothing follows — see the sibling test above): here
    # something DOES follow, so the marker doesn't count at all.
    app = _fake_app_for_outcome()
    stdout = (
        "DMF_L3_OUTCOME: rollback_complete\n"
        "cleaning up temp files...\n"
    )
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: stdout)
    tok, kv = asyncio.run(main._fetch_l3_outcome(app, 42))
    assert tok is None
    assert kv is None


def test_fetch_l3_outcome_marker_followed_by_unrelated_log_line_is_ignored(monkeypatch):
    # Same rule, a case closer to a real play: a facility-busy refusal
    # logged, then a later unrelated PLAY RECAP line AWX itself appends.
    app = _fake_app_for_outcome()
    stdout = (
        "DMF_L3_OUTCOME: facility-busy\n"
        "PLAY RECAP *********************************************************\n"
    )
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: stdout)
    tok, kv = asyncio.run(main._fetch_l3_outcome(app, 42))
    assert tok is None


def test_fetch_l3_outcome_ignores_malformed_lines(monkeypatch):
    app = _fake_app_for_outcome()
    stdout = (
        "DMF_L3_OUTCOME rollback_complete\n"  # missing colon -> no match
        "  DMF_L3_OUTCOME: UPPER-not-allowed\n"  # uppercase -> token class rejects it
        "not a marker line at all\n"
    )
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: stdout)
    tok, kv = asyncio.run(main._fetch_l3_outcome(app, 42))
    assert tok is None
    assert kv is None


def test_fetch_l3_outcome_tolerates_stdout_fetch_failure(monkeypatch):
    app = _fake_app_for_outcome()

    def boom(**k):
        raise TimeoutError("no stdout yet")

    monkeypatch.setattr(main, "get_job_stdout", boom)
    tok, kv = asyncio.run(main._fetch_l3_outcome(app, 42))
    assert tok is None
    assert kv is None


# ---------------------------------------------------------------------------
# main.py — watcher × rollback outcome mapping (§4.5 partial-failure posture)
# ---------------------------------------------------------------------------


def test_watcher_rollback_complete_marker_is_run_complete(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "a" * 32)
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: "DMF_L3_OUTCOME: rollback_complete\n")
    _run_watcher(app, op.operation_id, 111, "rollback", "a" * 32)
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_COMPLETE
    assert updated.l3_outcome == "rollback_complete"


def test_watcher_rollback_incomplete_marker_is_rollback_incomplete_even_when_job_successful(monkeypatch):
    # codex R2-1 partial-failure posture: never false-green. The AWX JOB
    # itself may report "successful" while the marker says the rollback
    # left surfaces dirty — the marker wins, and the DIRTY terminal state
    # is ROLLBACK_INCOMPLETE, not RUN_FAILED (R2-6's facility check treats
    # them differently).
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "a" * 32)
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_stdout", lambda **k: "DMF_L3_OUTCOME: rollback_incomplete surfaces=netbox\n"
    )
    _run_watcher(app, op.operation_id, 111, "rollback", "a" * 32)
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert updated.l3_outcome == "rollback_incomplete"
    assert "surfaces=netbox" in updated.error


def test_watcher_rollback_no_marker_but_job_successful_is_rollback_incomplete(monkeypatch):
    # codex R2-1: this is the exact "flip the test that pinned missing-marker
    # success" instruction — RUN_COMPLETE requires BOTH a successful status
    # AND the exact rollback_complete marker. A successful job with NO
    # marker at all is unverified, not clean, and must fail closed.
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "a" * 32)
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: "no marker here\n")
    _run_watcher(app, op.operation_id, 111, "rollback", "a" * 32)
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert updated.error == "rollback-outcome-unverified"
    assert updated.l3_outcome is None


def test_watcher_rollback_no_marker_and_job_failed_is_rollback_incomplete(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "a" * 32)
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: "no marker here\n")
    _run_watcher(app, op.operation_id, 111, "rollback", "a" * 32)
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert updated.error == "rollback-outcome-unverified"
    assert updated.l3_outcome is None


def test_watcher_rollback_stdout_fetch_failure_is_rollback_incomplete(monkeypatch):
    # codex R2-1's explicit "fetch failure" combination: _fetch_l3_outcome
    # tolerates get_job_stdout raising and returns (None, None) — the
    # watcher must treat that identically to "no marker found", never
    # assume success just because the fetch itself broke.
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "a" * 32)
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})

    def boom(**k):
        raise TimeoutError("stdout not ready")

    monkeypatch.setattr(main, "get_job_stdout", boom)
    _run_watcher(app, op.operation_id, 111, "rollback", "a" * 32)
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert updated.error == "rollback-outcome-unverified"


def test_watcher_rollback_failed_job_with_rollback_complete_marker_is_rollback_incomplete(monkeypatch):
    # codex R2-1's "failed+rollback_complete" combination: a job status that
    # ISN'T successful never completes a rollback, even if (implausibly) the
    # marker claims rollback_complete — both conditions are required.
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "a" * 32)
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: "DMF_L3_OUTCOME: rollback_complete\n")
    _run_watcher(app, op.operation_id, 111, "rollback", "a" * 32)
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert updated.l3_outcome == "rollback_complete"


def test_watcher_rollback_successful_job_with_refusal_token_is_rollback_incomplete(monkeypatch):
    # codex R2-1's "successful+refusal-token" combination: a successful job
    # status with some OTHER, non-rollback_complete token never completes.
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "a" * 32)
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: "DMF_L3_OUTCOME: facility-busy\n")
    _run_watcher(app, op.operation_id, 111, "rollback", "a" * 32)
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert updated.l3_outcome == "facility-busy"


@pytest.mark.parametrize(
    "token", ["facility-busy", "no-fit", "missing-budget", "no-snapshot", "stale-snapshot"],
)
def test_watcher_deploy_pre_mutation_token_is_run_failed_no_auto_trigger(monkeypatch, token):
    # codex R2-3: a PRE-MUTATION token means the launcher refused BEFORE
    # mutating anything — "started" here just means the AWX job PROCESS
    # ran, not that the play got past its own preflight. Must never reach
    # FAILED_ROLLBACK_REQUIRED or call the auto-trigger.
    app, ops_store = _fake_app(auto_rollback=True)
    op = ops_store.create("deploy", "key1", request_id="d" * 32)
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(main, "get_job_stdout", lambda **k: f"DMF_L3_OUTCOME: {token}\n")

    def boom(*a, **k):
        raise AssertionError("auto-trigger must not run for a pre-mutation refusal token")

    monkeypatch.setattr(main, "_maybe_auto_trigger_rollback", boom)
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED, token
    assert updated.l3_outcome == token
    assert updated.auto_rollback is None
    assert "job-failed" in updated.error


def test_watcher_deploy_failure_outcome_kv_is_appended_to_error(monkeypatch):
    # A non-pre-mutation token (an unrecognized/forward-compat one, or any
    # token outside _PRE_MUTATION_TOKENS) IS a genuine started-then-failed
    # deploy -> FAILED_ROLLBACK_REQUIRED + auto-trigger. l3_outcome keeps
    # the RAW marker token (never overwritten, codex R2-3) while
    # auto_rollback carries the SEPARATE auto-trigger status. The kv detail
    # is sanitized (R2-9) before landing in `error` — "surfaces" is
    # allow-listed, an arbitrary unlisted key would be dropped (see
    # test_sanitize_kv_drops_disallowed_key).
    app, ops_store = _fake_app(auto_rollback=False)
    op = ops_store.create("deploy", "key1", request_id="d" * 32)
    ops_store.update(op.operation_id, run_id="d" * 32)  # codex R3-3: auto-trigger keys off run_id
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_stdout", lambda **k: "DMF_L3_OUTCOME: unexpected-runtime-error surfaces=netbox\n"
    )
    _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.FAILED_ROLLBACK_REQUIRED
    assert "surfaces=netbox" in updated.error
    assert "job-failed" in updated.error
    assert updated.l3_outcome == "unexpected-runtime-error"  # raw token, untouched
    assert updated.auto_rollback == "disabled"  # separate field carries the auto-trigger status


# ---------------------------------------------------------------------------
# main.py — _maybe_auto_trigger_rollback (§4.5(a) auto-trigger)
# ---------------------------------------------------------------------------


def test_auto_trigger_dispatches_rollback_when_enabled(monkeypatch):
    app, ops_store = _fake_app(auto_rollback=True)
    deploy_op = ops_store.create("deploy", "key1", request_id="a" * 32, initiator="alice")
    ops_store.update(
        deploy_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1, run_id="a" * 32,
    )

    spawned = {}

    def fake_spawn(app_arg, operation_id, run_id, reason):
        spawned.update(operation_id=operation_id, run_id=run_id, reason=reason)

    monkeypatch.setattr(main, "_spawn_rollback_task", fake_spawn)
    asyncio.run(main._maybe_auto_trigger_rollback(app, deploy_op.operation_id, "key1"))

    assert spawned["run_id"] == "a" * 32
    assert "key1" in spawned["reason"]
    assert "failed_rollback_required" in spawned["reason"]

    rollback_op = ops_store.get(spawned["operation_id"])
    assert rollback_op is not None
    assert rollback_op.action == "rollback"
    assert rollback_op.target == "a" * 32
    assert rollback_op.initiator == "system:auto-rollback"

    updated_deploy = ops_store.get(deploy_op.operation_id)
    assert updated_deploy.auto_rollback == "triggered"
    assert updated_deploy.l3_outcome is None  # codex R2-3: never overwritten by auto-trigger bookkeeping


def test_auto_trigger_disabled_sets_marker_without_dispatch(monkeypatch):
    app, ops_store = _fake_app(auto_rollback=False)
    deploy_op = ops_store.create("deploy", "key1", request_id="b" * 32)
    ops_store.update(
        deploy_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1, run_id="b" * 32,
    )

    def boom(*a, **k):
        raise AssertionError("must not spawn a rollback when auto_rollback is disabled")

    monkeypatch.setattr(main, "_spawn_rollback_task", boom)
    asyncio.run(main._maybe_auto_trigger_rollback(app, deploy_op.operation_id, "key1"))

    updated = ops_store.get(deploy_op.operation_id)
    assert updated.auto_rollback == "disabled"
    assert updated.l3_outcome is None  # codex R2-3: never overwritten by auto-trigger bookkeeping
    assert updated.state == OperationState.FAILED_ROLLBACK_REQUIRED  # unchanged


def test_auto_trigger_dedupes_against_concurrent_manual_rollback(monkeypatch):
    app, ops_store = _fake_app(auto_rollback=True)
    run_id = "c" * 32
    deploy_op = ops_store.create("deploy", "key1", request_id=run_id)
    ops_store.update(
        deploy_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1, run_id=run_id,
    )

    # A manual rollback for the same run_id is already in flight.
    _manual_op, created = ops_store.get_or_create(action="rollback", target=run_id, initiator="alice")
    assert created is True

    def boom(*a, **k):
        raise AssertionError("must not spawn a second rollback when one already exists for this run_id")

    monkeypatch.setattr(main, "_spawn_rollback_task", boom)
    asyncio.run(main._maybe_auto_trigger_rollback(app, deploy_op.operation_id, "key1"))

    rollback_ops = [op for op in ops_store.list_all() if op.action == "rollback" and op.target == run_id]
    assert len(rollback_ops) == 1
    assert rollback_ops[0].initiator == "alice"  # the manual dispatch, not overwritten

    # codex R2-8: reattached (not a fresh dispatch) — the deploy op's
    # auto_rollback field reflects that distinct outcome.
    assert ops_store.get(deploy_op.operation_id).auto_rollback == "already-in-progress"


def test_auto_trigger_identity_unknown_when_deploy_op_has_no_run_id(monkeypatch):
    # codex R3-3: auto-trigger targets op.run_id, not op.request_id — a
    # deploy op with no run_id (a REATTACH whose AWX job carried no
    # parseable l3_request_id, most realistically — but also covers the
    # defensive "no request_id at all" case, since a fresh dispatch would
    # always have set run_id=request_id together) must never guess. It
    # stamps auto_rollback="identity-unknown" (not a silent no-op) so the
    # operator sees WHY nothing was dispatched, and never crashes.
    app, ops_store = _fake_app(auto_rollback=True)
    deploy_op = ops_store.create("deploy", "key1")  # no request_id, no run_id
    ops_store.update(deploy_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1)

    def boom(*a, **k):
        raise AssertionError("must not spawn a rollback when the run identity is unknown")

    monkeypatch.setattr(main, "_spawn_rollback_task", boom)
    asyncio.run(main._maybe_auto_trigger_rollback(app, deploy_op.operation_id, "key1"))
    updated = ops_store.get(deploy_op.operation_id)
    assert updated.l3_outcome is None
    assert updated.auto_rollback == "identity-unknown"


def test_auto_trigger_identity_unknown_when_request_id_set_but_run_id_not_hydrated(monkeypatch):
    # The realistic version of the above: a deploy op DOES have a
    # request_id (this console's own dispatch bookkeeping) but its run_id
    # was never hydrated — e.g. a reattach to an AWX job whose extra_vars
    # carried no parseable l3_request_id. Must still never fall back to
    # request_id as a stand-in identity.
    app, ops_store = _fake_app(auto_rollback=True)
    deploy_op = ops_store.create("deploy", "key1", request_id="d" * 32)
    ops_store.update(deploy_op.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, job_id=1)

    def boom(*a, **k):
        raise AssertionError("must not spawn a rollback when the run identity is unknown")

    monkeypatch.setattr(main, "_spawn_rollback_task", boom)
    asyncio.run(main._maybe_auto_trigger_rollback(app, deploy_op.operation_id, "key1"))
    assert ops_store.get(deploy_op.operation_id).auto_rollback == "identity-unknown"
