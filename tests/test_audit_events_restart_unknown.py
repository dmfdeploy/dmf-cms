"""A console restart loses the in-process job watchers (dmfdeploy/dmfdeploy#845).

The audit read must not leave such a request at "dispatched". It derives the
answer from the log on every read: a row with no outcome that was written
before this process started reads "unknown", and a request that a retry
attached to the same AWX job shows that job's outcome.
"""

import logging

import pytest

import dmf_cms.audit_events as audit_events
import dmf_cms.main as main
from dmf_cms.operations import OperationState

S = 1_000_000_000
PROCESS_STARTED = 1100 * S
NOW = 1200 * S


def _line(*, action, actor, role, request_id, target, outcome, reason="r", extra=""):
    return (
        "2026-11-06 16:00:00,000 INFO dmf_cms.audit: "
        f"awx write: fmt=2 action={action} actor={actor!r} role={role} real_role= "
        f"request_id={request_id} target={target!r} reason={reason!r} "
        f"outcome={outcome} workload='' capacity=''{extra}"
    )


def dispatch(rid, action="teardown", target="wl"):
    return _line(action=action, actor="alice", role="operator", request_id=rid, target=target, outcome="dispatched")


def attached(rid, job, action="teardown", target="wl"):
    return _line(
        action=action, actor="system:job-watch", role="system", request_id=f"{rid}-attach", target=target,
        outcome="job-attached", extra=f" job_id={job} linked_request_id={rid}",
    )


def terminal(rid, outcome="run_complete", action="teardown", target="wl"):
    return _line(
        action=action, actor="system:job-watch", role="system", request_id=f"{rid}-watch", target=target,
        outcome=outcome, extra=f" linked_request_id={rid}",
    )


def read(monkeypatch, timed_lines, *, process_started_ns=PROCESS_STARTED):
    def query_range(*, url, selector, start_ns, end_ns, limit, timeout=10):
        return [{"stream": {}, "values": [[str(ts * S), line] for ts, line in timed_lines]}]

    monkeypatch.setattr(audit_events.loki, "query_range", query_range)
    monkeypatch.setattr(
        audit_events.loki, "raw_runtime_config",
        lambda *, url, timeout=10: "compactor:\n  retention_enabled: true\nlimits_config:\n  retention_period: 168h\n",
    )
    payload = audit_events.list_audit_events(
        loki_url="http://loki.test", loki_configured=True, role="admin", groups=(),
        now_ns=NOW, max_in_flight_age_seconds=3600, process_started_ns=process_started_ns,
    )
    return {e["request_id"]: e["outcome"] for e in payload["events"]}


def test_a_dispatch_from_before_the_restart_reads_unknown_and_names_the_job(monkeypatch):
    out = read(monkeypatch, [(1000, dispatch("rid-1")), (1010, attached("rid-1", 103))])["rid-1"]
    assert out["state"] == "unknown"
    assert "restarted" in out["headline"]
    assert "103" in out["meaning"]
    assert out["next_step"]


def test_a_dispatch_from_before_the_restart_with_no_job_still_reads_unknown(monkeypatch):
    out = read(monkeypatch, [(1000, dispatch("rid-1"))])["rid-1"]
    assert out["state"] == "unknown"
    assert "number" not in out["meaning"]


def test_a_dispatch_after_the_restart_still_reads_in_flight(monkeypatch):
    out = read(monkeypatch, [(1150, dispatch("rid-1")), (1160, attached("rid-1", 104))])["rid-1"]
    assert out["state"] == "in_flight"


def test_the_restart_check_is_off_without_a_start_time(monkeypatch):
    out = read(monkeypatch, [(1000, dispatch("rid-1"))], process_started_ns=None)["rid-1"]
    assert out["state"] == "in_flight"


def test_a_row_with_its_own_outcome_keeps_it_across_a_restart(monkeypatch):
    out = read(monkeypatch, [(1000, dispatch("rid-1")), (1050, terminal("rid-1"))])["rid-1"]
    assert out["state"] == "succeeded"


def test_the_incident_first_request_takes_the_outcome_of_the_job_the_retry_finished(monkeypatch):
    lines = [
        (1000, dispatch("rid-1")), (1010, attached("rid-1", 103)),
        # restart at 1100; the operator retries and the retry attaches to job 103
        (1110, dispatch("rid-2")), (1111, attached("rid-2", 103)), (1150, terminal("rid-2")),
    ]
    out = read(monkeypatch, lines)
    assert out["rid-2"]["state"] == "succeeded"
    assert out["rid-1"]["state"] == "succeeded"


def test_a_job_that_failed_is_reported_failed_on_both_requests(monkeypatch):
    lines = [
        (1000, dispatch("rid-1")), (1010, attached("rid-1", 103)),
        (1110, dispatch("rid-2")), (1111, attached("rid-2", 103)), (1150, terminal("rid-2", "run_failed")),
    ]
    out = read(monkeypatch, lines)
    assert out["rid-1"]["state"] == out["rid-2"]["state"] == "failed"


def test_a_different_job_never_lends_its_outcome(monkeypatch):
    lines = [
        (1000, dispatch("rid-1")), (1010, attached("rid-1", 103)),
        (1110, dispatch("rid-2")), (1111, attached("rid-2", 104)), (1150, terminal("rid-2")),
    ]
    out = read(monkeypatch, lines)
    assert out["rid-1"]["state"] == "unknown"
    assert out["rid-2"]["state"] == "succeeded"


def test_a_job_of_another_action_never_lends_its_outcome(monkeypatch):
    lines = [
        (1000, dispatch("rid-1", action="deploy")), (1010, attached("rid-1", 103, action="deploy")),
        (1110, dispatch("rid-2")), (1111, attached("rid-2", 103)), (1150, terminal("rid-2")),
    ]
    assert read(monkeypatch, lines)["rid-1"]["state"] == "unknown"


def test_an_attach_record_is_not_a_row_and_not_an_outcome(monkeypatch):
    out = read(monkeypatch, [(1150, dispatch("rid-1")), (1160, attached("rid-1", 104))])
    assert set(out) == {"rid-1"}
    assert out["rid-1"]["state"] == "in_flight"


def test_a_line_without_a_job_id_still_parses():
    fields = audit_events.parse_awx_write_line(terminal("rid-1"))
    assert fields is not None
    assert fields["job_id"] == ""
    assert fields["linked_request_id"] == "rid-1"


def test_the_job_id_and_link_both_parse():
    fields = audit_events.parse_awx_write_line(attached("rid-1", 103))
    assert fields["job_id"] == "103"
    assert fields["linked_request_id"] == "rid-1"
    assert fields["outcome"] == "job-attached"


def test_a_user_line_cannot_carry_a_job_id():
    forged = _line(
        action="teardown", actor="alice", role="operator", request_id="rid-9", target="wl",
        outcome="dispatched", extra=" job_id=103",
    )
    fields = audit_events.parse_awx_write_line(forged)
    assert fields is not None
    assert fields["job_id"] == ""


@pytest.mark.parametrize("bad", ["abc", "10x", ""])
def test_a_job_id_that_is_not_a_number_is_dropped(bad):
    line = attached("rid-1", bad)
    fields = audit_events.parse_awx_write_line(line)
    assert fields is not None
    assert fields["job_id"] == ""


def test_the_real_emitter_writes_a_line_the_reader_accepts(caplog):
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        main._audit_job_attached("teardown", "wl", "rid-1", 103)
        main._audit_job_attached("rollback", "run-1", "rid-2", 5)  # manual rollback: no record
        main._audit_job_attached("deploy", "wl", None, 6)  # no request id: no record
    lines = [
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s").format(r)
        for r in caplog.records if r.name == "dmf_cms.audit"
    ]
    assert len(lines) == 1
    fields = audit_events.parse_awx_write_line(lines[0])
    assert fields["job_id"] == "103"
    assert fields["linked_request_id"] == "rid-1"
    assert fields["actor"] == "system:job-watch"


def test_the_watcher_start_records_its_job(caplog, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from dmf_cms.operations import OperationStore

    store = OperationStore(ttl_seconds=3600)
    op, _ = store.get_or_create("teardown", "wl", request_id="rid-1")
    app = SimpleNamespace(state=SimpleNamespace(operations=store, operation_tasks=set()))

    async def no_watch(*a, **k):
        return None

    monkeypatch.setattr(main, "_watch_job_operation", no_watch)

    async def run():
        with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
            main._spawn_job_watcher(app, op.operation_id, 103, "teardown", "wl")
        await asyncio.gather(*app.state.operation_tasks)

    asyncio.run(run())
    assert any("outcome=job-attached" in r.getMessage() and "job_id=103" in r.getMessage() for r in caplog.records)
