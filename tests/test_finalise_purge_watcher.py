"""The finalise-purge job watcher branch of ``main._watch_job_operation``
(umbrella #347 WO-A2b-2) — mirrors test_operations_lifecycle.py's own
_fake_app/_run_watcher pattern exactly.

Console Constitution Art. 1: absence is established ONLY by a post-job
refreshed source read — job-success alone is never sufficient. So the two
load-bearing cases are: job success + residue confirmed absent ->
RUN_COMPLETE with purge_verified_at stamped, and job success + residue
STILL present -> RUN_FAILED (never a false-green). The DMF_L3_PURGE_OUTCOME
marker is parsed and surfaced for provenance but never gates the outcome.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import dmf_cms.main as main
from dmf_cms import media_workloads
from dmf_cms.operations import OperationState, OperationStore
from dmf_cms.settings import AWXSettings, L3Settings, NetboxSettings, Settings


def _fake_app(*, poll_interval=0, ttl_seconds=3600):
    settings = Settings(
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        l3=L3Settings(job_poll_interval_seconds=poll_interval),
    )
    ops_store = OperationStore(ttl_seconds=ttl_seconds)
    app = SimpleNamespace(
        state=SimpleNamespace(settings=settings, operations=ops_store, operation_tasks=set())
    )
    return app, ops_store


def _run_watcher(app, operation_id, job_id, key):
    asyncio.run(main._watch_job_operation(app, operation_id, job_id, "finalise-purge", key))


def _purge_outcome_event(msg, *, task=None):
    return {
        "task": task if task is not None else main._L3_PURGE_OUTCOME_TASK_NAME,
        "event_data": {"res": {"msg": msg}},
    }


def test_success_with_residue_absent_is_run_complete_with_purge_verified_at(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("finalise-purge", "studio-a")
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "t0", "finished": "t1", "event_processing_finished": True},
    )
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_purge_outcome_event("DMF_L3_PURGE_OUTCOME: success")],
    )
    monkeypatch.setattr(media_workloads, "purge_residue_present", lambda *a, **k: False)

    _run_watcher(app, op.operation_id, 111, "studio-a")

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_COMPLETE
    assert updated.l3_outcome == "success"
    assert updated.purge_verified_at is not None


def test_success_with_residue_still_present_is_run_failed_never_a_false_green(monkeypatch):
    # THE discriminating case: AWX reported the job successful, but the
    # console's own fresh re-read still finds residue — job-success is
    # never sufficient (Console Constitution Art. 1).
    app, ops_store = _fake_app()
    op = ops_store.create("finalise-purge", "studio-a")
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "t0", "finished": "t1", "event_processing_finished": True},
    )
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_purge_outcome_event("DMF_L3_PURGE_OUTCOME: success")],
    )
    monkeypatch.setattr(media_workloads, "purge_residue_present", lambda *a, **k: True)

    _run_watcher(app, op.operation_id, 111, "studio-a")

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED
    assert updated.purge_verified_at is None
    assert "residue-present" in updated.error


def test_post_job_read_failure_is_run_status_unknown_never_assumed_clean(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("finalise-purge", "studio-a")
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "t0", "finished": "t1", "event_processing_finished": True},
    )
    monkeypatch.setattr(main, "get_job_events_for_task", lambda **k: [])

    def boom(*a, **k):
        raise RuntimeError("netbox unreachable mid-verify")

    monkeypatch.setattr(media_workloads, "purge_residue_present", boom)

    _run_watcher(app, op.operation_id, 111, "studio-a")

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_STATUS_UNKNOWN
    assert updated.error == "purge-verify-unreachable"
    assert updated.purge_verified_at is None


def test_job_failed_is_run_failed_with_refused_marker_detail_surfaced_no_reread(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("finalise-purge", "studio-a")
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "failed", "started": "t0", "finished": "t1", "event_processing_finished": True},
    )
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_purge_outcome_event("DMF_L3_PURGE_OUTCOME: refused detail=preflight")],
    )

    def boom(*a, **k):
        raise AssertionError("a failed job must never trigger the post-job re-read")

    monkeypatch.setattr(media_workloads, "purge_residue_present", boom)

    _run_watcher(app, op.operation_id, 111, "studio-a")

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED
    assert updated.l3_outcome == "refused"
    assert "detail=preflight" in updated.error
    assert updated.purge_verified_at is None


def test_job_failed_no_marker_is_run_failed_with_no_l3_outcome(monkeypatch):
    app, ops_store = _fake_app()
    op = ops_store.create("finalise-purge", "studio-a")
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "failed", "started": "t0", "finished": "t1", "event_processing_finished": True},
    )
    monkeypatch.setattr(main, "get_job_events_for_task", lambda **k: [])

    _run_watcher(app, op.operation_id, 111, "studio-a")

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_FAILED
    assert updated.l3_outcome is None
    assert updated.error == "job-failed"


def test_purge_outcome_marker_on_a_differently_named_task_is_invisible(monkeypatch):
    # The anchor test (mirrors test_fetch_l3_outcome_from_events_wrong_task_name_is_invisible):
    # an identically-formatted marker string on a DIFFERENT task must never match.
    app, ops_store = _fake_app()
    op = ops_store.create("finalise-purge", "studio-a")
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "t0", "finished": "t1", "event_processing_finished": True},
    )
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_purge_outcome_event("DMF_L3_PURGE_OUTCOME: success", task="some-other-debug-task")],
    )
    monkeypatch.setattr(media_workloads, "purge_residue_present", lambda *a, **k: False)

    _run_watcher(app, op.operation_id, 111, "studio-a")

    updated = ops_store.get(op.operation_id)
    # Outcome is still RUN_COMPLETE (the fresh re-read is authoritative,
    # independent of the marker) — but l3_outcome stays unset, proving the
    # wrongly-named event was never picked up.
    assert updated.state == OperationState.RUN_COMPLETE
    assert updated.l3_outcome is None


@pytest.mark.parametrize("action", ["deploy", "teardown", "rollback"])
def test_other_watched_actions_are_unaffected_by_the_finalise_purge_branch(monkeypatch, action):
    # Regression guard: adding the finalise-purge branch must not perturb
    # the existing deploy/teardown/rollback classification at all.
    app, ops_store = _fake_app()
    op = ops_store.create(action, "key1")
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})

    def boom(*a, **k):
        raise AssertionError("purge_residue_present must never run for a non-purge action")

    monkeypatch.setattr(media_workloads, "purge_residue_present", boom)

    asyncio.run(main._watch_job_operation(app, op.operation_id, 111, action, "key1"))

    updated = ops_store.get(op.operation_id)
    if action == "rollback":
        # rollback's own marker-authoritative contract: no marker -> unverified.
        assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    else:
        assert updated.state == OperationState.RUN_COMPLETE


def test_p1_2_incomplete_post_job_paginated_read_is_run_status_unknown(monkeypatch):
    # umbrella #347 fix round FIX-A2b.4 (GATE-A2b.3) — codex's exact P1-2
    # fixture, exercised end-to-end through the REAL purge_residue_present
    # (only the raw NetBox HTTP call is mocked): count=1, non-null next,
    # empty first page — and this time the survivor's page is NEVER
    # returned (next stays set forever), so the completeness-verified fetch
    # itself cannot terminate cleanly. Before this fix, the plain
    # single-page _fetch_services would have seen page 1's empty results
    # and reported RUN_COMPLETE with a false purge_verified_at.
    import dmf_cms.netbox as _netbox_mod

    app, ops_store = _fake_app()
    app.state.settings = Settings(
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        l3=L3Settings(job_poll_interval_seconds=0),
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="tok"),
    )
    op = ops_store.create("finalise-purge", "studio-a")
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "t0", "finished": "t1", "event_processing_finished": True},
    )
    monkeypatch.setattr(main, "get_job_events_for_task", lambda **k: [])

    def never_terminating_page(*args, **kwargs):
        # Every page claims count=1 but returns zero results and always
        # has a `next` — the page cap must trip, never silently stop.
        return {
            "count": 1,
            "next": "http://netbox.test/api/ipam/services/?tag=dmf-catalog&limit=500&offset=999999",
            "results": [],
        }

    monkeypatch.setattr(_netbox_mod, "_request", never_terminating_page)

    _run_watcher(app, op.operation_id, 111, "studio-a")

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_STATUS_UNKNOWN
    assert updated.error == "purge-verify-unreachable"
    assert updated.purge_verified_at is None
