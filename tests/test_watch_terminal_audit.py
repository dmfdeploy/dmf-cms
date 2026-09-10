"""The terminal-outcome join write (dmfdeploy/dmfdeploy#419/#554) —
main.py's ``_audit_watch_terminal``, both as a direct round-trip against
the real parser (same convention as test_audit_events_endpoint.py's
writer-fix round-trip tests) and as an integration through
``_watch_job_operation`` itself (mirrors test_operations_lifecycle.py's
own ``_fake_app``/``_run_watcher`` pattern — deliberately NOT shared via
import, same as test_finalise_purge_watcher.py's own local copy).

This is what turns "Deploy dispatched for X" into "Deploy succeeded/
failed for X" on the read side (see tests/test_audit_events_endpoint.py's
own terminal-join section for that half) — this file proves the WRITE
side actually happens, from the real call sites, with the real shape.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import logging
from types import SimpleNamespace

import dmf_cms.audit_events as audit_events
import dmf_cms.main as main
from dmf_cms.operations import OperationState, OperationStore
from dmf_cms.settings import AWXSettings, L3Settings, Settings


def _formatted_line(record: logging.LogRecord) -> str:
    # Same reproduction test_audit_events_endpoint.py's own round-trip
    # tests use — caplog's record.getMessage() is just the %s/%r
    # substitution result, not the asctime/levelname/name-prefixed line
    # the real reader requires structurally (dmfdeploy/dmf-cms#140,
    # eighth round).
    return logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s").format(record)


def _audit_lines(caplog) -> list[str]:
    return [
        _formatted_line(r) for r in caplog.records
        if r.name == "dmf_cms.audit" and r.getMessage().startswith("awx write:")
    ]


# ----------------------------------------------------------------------
# _audit_watch_terminal — direct round-trip against the real parser.
# ----------------------------------------------------------------------

def test_round_trip_emits_a_line_the_real_parser_accepts_as_a_job_watch_join(caplog):
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        main._audit_watch_terminal("deploy", "wl-a", "rid-parent", OperationState.RUN_COMPLETE, None)
    lines = _audit_lines(caplog)
    assert len(lines) == 1
    fields = audit_events.parse_awx_write_line(lines[0])
    assert fields is not None
    assert fields["action"] == "deploy"
    assert fields["actor"] == "system:job-watch"
    assert fields["target"] == "wl-a"
    assert fields["outcome"] == "run_complete"
    assert fields["linked_request_id"] == "rid-parent"


def test_round_trip_carries_the_l3_outcome_as_a_suffix_on_the_state_token(caplog):
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        main._audit_watch_terminal(
            "teardown", "wl-b", "rid-parent-2", OperationState.RUN_FAILED, "pre-mutation-refused",
        )
    fields = audit_events.parse_awx_write_line(_audit_lines(caplog)[0])
    assert fields is not None
    assert fields["outcome"] == "run_failed:pre-mutation-refused"


def test_a_target_forged_to_look_like_a_complete_line_survives_as_literal_content(caplog):
    # The same proof _audit_awx_write's own writer-fix round-trip tests
    # give its quoted fields -- target rides through the SAME %r-quoted
    # field here, so the same guarantee must hold: forged-looking content
    # comes back as target's own literal value, never as structure that
    # overrides outcome/reason/linked_request_id.
    crafted_key = "evil reason='fake' outcome=run_complete workload=pwned capacity='' linked_request_id=hijacked"
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        main._audit_watch_terminal("deploy", crafted_key, "rid-parent-3", OperationState.RUN_FAILED, None)
    fields = audit_events.parse_awx_write_line(_audit_lines(caplog)[0])
    assert fields is not None
    assert fields["target"] == crafted_key
    assert fields["outcome"] == "run_failed"  # the REAL state, never the forged one
    assert fields["linked_request_id"] == "rid-parent-3"  # the REAL correlation, never "hijacked"


def test_no_op_for_a_manual_rollback_or_an_uncovered_action(caplog):
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        main._audit_watch_terminal("rollback", "run-1", "rid-x", OperationState.ROLLBACK_INCOMPLETE, None)
        main._audit_watch_terminal("finalise-purge", "slug-1", "rid-y", OperationState.RUN_COMPLETE, None)
    assert _audit_lines(caplog) == []


def test_no_op_when_the_original_dispatch_never_got_a_request_id(caplog):
    # "Never guess" -- same posture as _maybe_auto_trigger_rollback's own
    # run_id-is-None handling: nothing to correlate against, so no write
    # at all, never a join record with a blank/fabricated key.
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        main._audit_watch_terminal("deploy", "wl-a", None, OperationState.RUN_COMPLETE, None)
    assert _audit_lines(caplog) == []


# ----------------------------------------------------------------------
# Integration — driven through the real _watch_job_operation, same
# harness shape as test_operations_lifecycle.py / test_finalise_purge_
# watcher.py.
# ----------------------------------------------------------------------

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


def test_watcher_success_writes_a_run_complete_join_correlated_to_the_dispatch(monkeypatch, caplog):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1", request_id="rid-dispatch-1")
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    assert ops_store.get(op.operation_id).state == OperationState.RUN_COMPLETE
    lines = _audit_lines(caplog)
    assert len(lines) == 1
    fields = audit_events.parse_awx_write_line(lines[0])
    assert fields["action"] == "deploy"
    assert fields["actor"] == "system:job-watch"
    assert fields["outcome"] == "run_complete"
    assert fields["linked_request_id"] == "rid-dispatch-1"


def test_watcher_deploy_confirmed_failure_writes_a_failed_rollback_required_join(monkeypatch, caplog):
    # auto_rollback=False isolates THIS write from the auto-rollback
    # dispatch's own separate audit line (system:auto-rollback, a
    # different actor entirely) -- covered on its own terms elsewhere.
    app, ops_store = _fake_app(auto_rollback=False)
    op = ops_store.create("deploy", "key1", request_id="rid-dispatch-2")
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": "t0", "finished": "t1"})
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    assert ops_store.get(op.operation_id).state == OperationState.FAILED_ROLLBACK_REQUIRED
    fields = audit_events.parse_awx_write_line(_audit_lines(caplog)[0])
    assert fields["action"] == "deploy"
    assert fields["outcome"] == "failed_rollback_required"
    assert fields["linked_request_id"] == "rid-dispatch-2"


def test_watcher_deploy_never_started_failure_writes_a_run_failed_join(monkeypatch, caplog):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1", request_id="rid-dispatch-3")
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": None, "finished": None})
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    assert ops_store.get(op.operation_id).state == OperationState.RUN_FAILED
    fields = audit_events.parse_awx_write_line(_audit_lines(caplog)[0])
    assert fields["outcome"] == "run_failed"
    assert fields["linked_request_id"] == "rid-dispatch-3"


def test_watcher_teardown_failure_writes_a_run_failed_join_not_failed_rollback_required(monkeypatch, caplog):
    app, ops_store = _fake_app()
    op = ops_store.create("teardown", "key1", request_id="rid-dispatch-4")
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": "t0", "finished": "t1"})
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "teardown", "key1")
    assert ops_store.get(op.operation_id).state == OperationState.RUN_FAILED
    fields = audit_events.parse_awx_write_line(_audit_lines(caplog)[0])
    assert fields["action"] == "teardown"
    assert fields["outcome"] == "run_failed"


def test_watcher_started_then_ttl_timeout_writes_the_honest_unknown_join(monkeypatch, caplog):
    # The watcher's give-up path (TTL/lost/crash) is exactly the case the
    # honesty requirement names: no confirmed job read, so the join must
    # say 'run_status_unknown' -- never a guessed success or failure. Same
    # fake-clock technique as test_operations_lifecycle.py's own
    # started-then-TTL-timeout test (backdating created_at up front would
    # make the deadline already-elapsed before the first get_job call,
    # so seen_started could never become True).
    app, ops_store = _fake_app(ttl_seconds=3600)
    op = ops_store.create("deploy", "key1", request_id="rid-dispatch-5")
    real_now = [datetime.now(timezone.utc)]

    class _FakeDatetime:
        @staticmethod
        def now(tz=None):
            return real_now[0]

    def fake_get_job(**k):
        real_now[0] = real_now[0] + timedelta(hours=2)  # jump past the 1h TTL
        return {"status": "running", "started": "t0"}

    monkeypatch.setattr(main, "datetime", _FakeDatetime)
    monkeypatch.setattr(main, "get_job", fake_get_job)

    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "deploy", "key1")

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_STATUS_UNKNOWN
    fields = audit_events.parse_awx_write_line(_audit_lines(caplog)[0])
    assert fields["outcome"] == "run_status_unknown"
    assert fields["linked_request_id"] == "rid-dispatch-5"


def test_watcher_never_started_then_ttl_timeout_reports_unknown_but_keeps_run_failed_internally(monkeypatch):
    # gate round 4 (lkirc B2): the OTHER give-up outcome (never observed
    # to have started) still resolves the INTERNAL ops-store state to
    # plain RUN_FAILED, UNCHANGED — rollback eligibility and
    # _facility_busy_check's dirty-state handling both still need that
    # exact distinction from RUN_STATUS_UNKNOWN (see
    # _watch_lost_terminal_state's own docstring), and this proves it.
    # But the AUDIT claim is now unconditionally the honest
    # run_status_unknown regardless — nobody ever observed this job to
    # fail (no get_job call was ever even made), so the row must never
    # assert a confirmed failure it did not see.
    app, ops_store = _fake_app(ttl_seconds=3600)
    op = ops_store.create("deploy", "key1", request_id="rid-dispatch-6")
    real_now = [op.created_at + timedelta(hours=2)]  # already past the deadline on tick 1

    class _FakeDatetime:
        @staticmethod
        def now(tz=None):
            return real_now[0]

    def _boom(**k):
        raise AssertionError("get_job must never be called once the deadline has already elapsed")

    monkeypatch.setattr(main, "datetime", _FakeDatetime)
    monkeypatch.setattr(main, "get_job", _boom)

    caplog_records: list[logging.LogRecord] = []
    handler = logging.Handler()
    handler.emit = caplog_records.append
    audit_logger = logging.getLogger("dmf_cms.audit")
    audit_logger.addHandler(handler)
    audit_logger.setLevel(logging.INFO)
    try:
        _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    finally:
        audit_logger.removeHandler(handler)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED
    assert updated.error == "job-watch-timeout"

    lines = [_formatted_line(r) for r in caplog_records if r.getMessage().startswith("awx write:")]
    assert len(lines) == 1
    fields = audit_events.parse_awx_write_line(lines[0])
    assert fields["outcome"] == "run_status_unknown"


def test_watcher_three_failed_get_job_reads_reports_unknown_never_a_confirmed_failure(monkeypatch, caplog):
    # gate round 4 (lkirc B2): the other cited give-up path — three
    # consecutive get_job failures, never having observed the job start.
    # Same fix, same proof shape as the TTL site above.
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1", request_id="rid-dispatch-8")

    def _always_fails(**k):
        raise RuntimeError("AWX unreachable")

    monkeypatch.setattr(main, "get_job", _always_fails)

    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "deploy", "key1")

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED  # internal state unchanged
    assert updated.error == "job-watch-lost"

    fields = audit_events.parse_awx_write_line(_audit_lines(caplog)[0])
    assert fields["outcome"] == "run_status_unknown"  # audit claim: honest, not a confirmed failure


def test_watcher_manual_rollback_never_writes_an_activity_join(monkeypatch, caplog):
    # Manual rollbacks are deliberately excluded from Activity History.
    app, ops_store = _fake_app()
    op = ops_store.create("rollback", "run-1", request_id="rid-dispatch-7")
    monkeypatch.setattr(
        main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"},
    )
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "rollback", "run-1")
    assert _audit_lines(caplog) == []


def test_watcher_manual_rollback_with_colliding_subject_never_writes_an_activity_join(monkeypatch, caplog):
    # #560 round 4 (lkirc): the actual collision — a MANUAL rollback whose
    # dispatching subject happens to be literally "system:auto-rollback"
    # (api_run_rollback sets initiator=user.subject with no reserved-
    # namespace check on it). Before this fix, is_auto_rollback compared
    # op.initiator to that exact string, so this op would have been
    # misread as automatic and joined into Activity History despite never
    # being dispatched by _maybe_auto_trigger_rollback — the exact
    # provenance-vs-string-match confusion #560 round 4 exists to close.
    # auto_rollback_dispatch is never set here (defaults False, as a real
    # manual dispatch through api_run_rollback never sets it either), so
    # this must resolve identically to any other manual rollback: no join.
    app, ops_store = _fake_app()
    op = ops_store.create(
        "rollback", "run-1", request_id="rid-dispatch-collide", initiator="system:auto-rollback",
    )
    assert op.auto_rollback_dispatch is False
    monkeypatch.setattr(
        main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"},
    )
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "rollback", "run-1")
    assert _audit_lines(caplog) == []


def test_watcher_auto_rollback_writes_a_terminal_join(monkeypatch, caplog):
    # Discriminating producer proof for #560: deleting the rollback branch's
    # _audit_watch_terminal call leaves the operation state intact but makes
    # this endpoint-consumable terminal record disappear.
    #
    # round 4 (lkirc): auto_rollback_dispatch=True, not just a
    # "system:auto-rollback" initiator — that string alone is no longer
    # trusted (see test_watcher_manual_rollback_with_colliding_subject_
    # never_writes_an_activity_join below for the discriminating case this
    # protects against).
    app, ops_store = _fake_app()
    op = ops_store.create(
        "rollback", "run-1", request_id="rid-auto-rollback", initiator="system:auto-rollback",
        auto_rollback_dispatch=True,
    )
    monkeypatch.setattr(
        main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"},
    )
    monkeypatch.setattr(main, "get_job_events_for_task", lambda **k: [])
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "rollback", "run-1")
    fields = audit_events.parse_awx_write_line(_audit_lines(caplog)[0])
    assert fields["action"] == "rollback"
    assert fields["outcome"] == "rollback_incomplete"
    assert fields["linked_request_id"] == "rid-auto-rollback"


def test_watcher_lost_auto_rollback_writes_an_unknown_join(monkeypatch, caplog):
    app, ops_store = _fake_app()
    op = ops_store.create(
        "rollback", "run-1", request_id="rid-auto-rollback-lost", initiator="system:auto-rollback",
        auto_rollback_dispatch=True,
    )

    def _always_fails(**_kwargs):
        raise RuntimeError("AWX unreachable")

    monkeypatch.setattr(main, "get_job", _always_fails)
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "rollback", "run-1")
    fields = audit_events.parse_awx_write_line(_audit_lines(caplog)[0])
    assert fields["outcome"] == "run_status_unknown"
    assert fields["linked_request_id"] == "rid-auto-rollback-lost"


def test_watcher_never_writes_a_join_when_the_dispatch_op_has_no_request_id(monkeypatch, caplog):
    app, ops_store = _fake_app()
    op = ops_store.create("deploy", "key1")  # no request_id passed
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        _run_watcher(app, op.operation_id, 111, "deploy", "key1")
    assert ops_store.get(op.operation_id).state == OperationState.RUN_COMPLETE  # op itself still resolves
    assert _audit_lines(caplog) == []  # but nothing to durably join it to Activity with
