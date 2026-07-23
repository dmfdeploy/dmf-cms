"""L3 monitoring drain verification — main.py integration (umbrella #202
WP4). Covers the watcher classification hook (D1), the bounded poll +
finalize continuation (D6), mode parity (D7/A8), the manual re-verify
endpoint (D7/A9), and the codex round-1 facility-coherence + ambiguity
fixes (F1/F5/F6/F9/F10) end-to-end. Pure decision-core coverage
(is_eligible, resolve_drain_targets, check_drained, exact-host matching,
F2-F5 fail-closed boundaries) lives in test_drain.py.
"""

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
import dmf_cms.netbox as netbox_module
import dmf_cms.promsd as promsd_module
import dmf_cms.prometheus as prometheus_module
from dmf_cms import drain
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.operations import DIRTY_STATES, OperationState, OperationStore
from dmf_cms.settings import (
    AWXAutoscaleSettings,
    AWXSettings,
    L3Settings,
    NetboxSettings,
    PrometheusSettings,
    PromSDSettings,
    Settings,
)

OPERATOR = ("dmf-console-operator",)
VIEWER = ("dmf-console-viewer",)
RUN_ID = "a" * 32

ENTRY = CatalogEntry(
    key="mxl-videotestsrc",
    display_name="MXL Test-Pattern Source",
    summary="",
    provision={
        "namespace": "mxl",
        "netbox_service": {"name": "mxl-videotestsrc", "protocol": "tcp", "ports": [1234]},
    },
)

DRAINED_TARGET = drain.DrainTarget(cluster_service="mxl-videotestsrc", cluster_namespace="mxl")

# A live Prometheus always scrapes at least itself (F3c liveness sentinel)
# — every test that wants a genuinely "drained" outcome needs a non-empty,
# non-matching activeTargets envelope, not just [].
SELF_SCRAPE = {"labels": {"instance": "prometheus-server:9090", "job": "prometheus"}}


def _mock_promsd_ready(monkeypatch, ready=True):
    monkeypatch.setattr(promsd_module, "ready", lambda **k: ready)


def _mock_prometheus_envelope(monkeypatch, active_targets):
    monkeypatch.setattr(
        prometheus_module, "_request",
        lambda *a, **k: {"status": "success", "data": {"activeTargets": active_targets}},
    )


def _mock_drained(monkeypatch, *, netbox_results=(), promsd_targets=()):
    """Common wiring for "everything says drained": ABSENT/no matching
    NetBox record by default, empty PromSD probe targets, and a live-but-
    non-matching Prometheus envelope."""
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": len(netbox_results), "results": list(netbox_results)})
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: list(promsd_targets))
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])


def _fake_app(*, drain_poll_interval=0, drain_timeout=0, promsd_url="http://promsd.test", prometheus_url="http://prom.test"):
    settings = Settings(
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        netbox=NetboxSettings(api_url="http://nb.test", api_token="t"),
        prometheus=PrometheusSettings(url=prometheus_url),
        promsd=PromSDSettings(url=promsd_url),
        l3=L3Settings(job_poll_interval_seconds=0, drain_poll_interval_seconds=drain_poll_interval, drain_timeout_seconds=drain_timeout),
    )
    ops_store = OperationStore(ttl_seconds=3600)
    app = SimpleNamespace(state=SimpleNamespace(settings=settings, operations=ops_store, operation_tasks=set()))
    return app, ops_store


def _seed_run(ops_store, *, run_id=RUN_ID, catalog_key="mxl-videotestsrc", deploy_state=OperationState.RUN_COMPLETE):
    """Seed a deploy op carrying the run's identity, matching what
    drain.find_deploy_ops_for_run scans for (mirrors _facility_busy_check's
    rollback exemption lookup)."""
    deploy_op = ops_store.create("deploy", catalog_key)
    ops_store.update(deploy_op.operation_id, state=deploy_state, run_id=run_id)
    return deploy_op


def _run_watcher_and_drain(app, operation_id, job_id, action, key):
    """Run the watcher AND let any drain-verification task it spawns run
    to completion in the SAME event loop — asyncio.run() cancels pending
    tasks once the top-level coroutine returns, so a bare _run_watcher call
    would kill the WP4 continuation before it ever polls."""

    async def _go():
        await main._watch_job_operation(app, operation_id, job_id, action, key)
        pending = list(app.state.operation_tasks)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    asyncio.run(_go())


def _outcome_event(msg, *, task=None, counter=1):
    return {
        "counter": counter,
        "task": task if task is not None else main._L3_OUTCOME_TASK_NAME,
        "event_data": {"res": {"msg": msg}},
    }


@pytest.fixture(autouse=True)
def _catalog(monkeypatch):
    monkeypatch.setattr(main, "load_catalog_entries", lambda: [ENTRY])


# ---------------------------------------------------------------------------
# A1 — the discriminating regression test: MUST fail on origin/main, which
# has no drain.py/no _verify_drain_and_finalize/no post-terminal upgrade —
# a rollback_incomplete surfaces=monitoring marker stays ROLLBACK_INCOMPLETE
# forever there. Drives the SAME public entrypoint (_watch_job_operation)
# that exists on both branches, asserting the eventual observable state.
# ---------------------------------------------------------------------------


def test_A1_eligible_rollback_drained_upgrades_to_run_complete(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    _mock_drained(monkeypatch)  # ABSENT NetBox record -> drain-expected, both seams clean

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_COMPLETE
    assert updated.l3_outcome == "rollback_complete"
    assert drain.DRAIN_VERIFIED_DETAIL in updated.error

    # facility check passes afterward — RUN_COMPLETE is not a DIRTY_STATE.
    assert updated.state not in DIRTY_STATES


# ---------------------------------------------------------------------------
# A2 — never drains -> after window, stays ROLLBACK_INCOMPLETE + pending;
# facility stays blocked (still a DIRTY_STATE).
# ---------------------------------------------------------------------------


def test_A2_eligible_rollback_never_drains_stays_incomplete_with_pending_detail(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    _mock_drained(monkeypatch, promsd_targets=[{"targets": ["mxl-videotestsrc.mxl.svc.cluster.local:9000"], "labels": {}}])

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert drain.DRAIN_PENDING_DETAIL in updated.error

    assert updated.state in DIRTY_STATES


# ---------------------------------------------------------------------------
# A3 — surfaces is a superset (netbox+monitoring) -> never enters drain
# verification; classification identical to pre-WP4.
# ---------------------------------------------------------------------------


def test_A3_surfaces_superset_never_enters_drain_verification(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    spawned = []
    monkeypatch.setattr(main, "_spawn_drain_verification", lambda *a, **k: spawned.append(a))
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=netbox,monitoring")],
    )

    async def _go():
        await main._watch_job_operation(app, op.operation_id, 111, "rollback", RUN_ID)

    asyncio.run(_go())

    assert spawned == []
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert updated.l3_outcome == "rollback_incomplete"
    assert "surfaces=netbox,monitoring" in updated.error
    assert drain.DRAIN_PENDING_DETAIL not in updated.error
    assert drain.DRAIN_VERIFIED_DETAIL not in updated.error


def test_F2_duplicate_surfaces_key_never_enters_drain_verification(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    spawned = []
    monkeypatch.setattr(main, "_spawn_drain_verification", lambda *a, **k: spawned.append(a))
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring surfaces=netbox")],
    )

    async def _go():
        await main._watch_job_operation(app, op.operation_id, 111, "rollback", RUN_ID)

    asyncio.run(_go())

    assert spawned == []
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE


# ---------------------------------------------------------------------------
# A4 — failed job + any marker -> never upgraded, drain verification never
# spawned (dual-signal preserved).
# ---------------------------------------------------------------------------


def test_A4_failed_job_never_spawns_drain_verification(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    spawned = []
    monkeypatch.setattr(main, "_spawn_drain_verification", lambda *a, **k: spawned.append(a))
    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "failed", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )

    async def _go():
        await main._watch_job_operation(app, op.operation_id, 111, "rollback", RUN_ID)

    asyncio.run(_go())

    assert spawned == []
    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE


# ---------------------------------------------------------------------------
# A5 — retained case: NetBox record still monitoring:probe-tagged AND its
# custom_fields identity EXACTLY match H_run -> excluded; empty drain set
# -> drained trivially -> upgrade.
# ---------------------------------------------------------------------------


def test_A5_retained_monitored_record_is_excluded_and_drains_trivially(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    record = {
        "tags": [{"name": "dmf-catalog"}, {"name": "monitoring:probe"}],
        "custom_fields": {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl"},
    }
    # A naive absence check would hang here — the retained target IS still
    # present in both surfaces. Presence must never block the (empty) drain
    # set from resolving as trivially drained.
    _mock_drained(
        monkeypatch, netbox_results=[record],
        promsd_targets=[{"targets": ["mxl-videotestsrc.mxl.svc.cluster.local:9000"], "labels": {}}],
    )
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE, {"labels": {"instance": "mxl-videotestsrc.mxl.svc.cluster.local:9000"}}])

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.RUN_COMPLETE
    assert updated.l3_outcome == "rollback_complete"


# ---------------------------------------------------------------------------
# A6/F3 — fail-closed boundary: PromSD unconfigured/erroring/not-ready, or
# Prometheus erroring/malformed -> never upgrades, stays pending.
# ---------------------------------------------------------------------------


def test_A6_promsd_unconfigured_never_upgrades(monkeypatch):
    app, ops_store = _fake_app(promsd_url="")
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert drain.DRAIN_PENDING_DETAIL in updated.error


def test_A6_promsd_erroring_never_upgrades(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    _mock_promsd_ready(monkeypatch)

    def boom(**k):
        raise promsd_module.PromSDAPIError(500, "boom")

    monkeypatch.setattr(promsd_module, "list_probe_targets", boom)

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert drain.DRAIN_PENDING_DETAIL in updated.error


def test_A6_prometheus_erroring_never_upgrades(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])

    def boom(*a, **k):
        raise prometheus_module.PrometheusAPIError(500, "boom")

    monkeypatch.setattr(prometheus_module, "_request", boom)

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert drain.DRAIN_PENDING_DETAIL in updated.error


def test_F3_promsd_not_ready_never_upgrades_end_to_end(monkeypatch):
    # codex round-1 F3a repro through the full watcher flow: a cold
    # adapter's 200 [] on /sd/probe must never be trusted while /readyz
    # says not-ready.
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    _mock_promsd_ready(monkeypatch, ready=False)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert drain.DRAIN_PENDING_DETAIL in updated.error


def test_F3_prometheus_malformed_envelope_never_upgrades_end_to_end(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    monkeypatch.setattr(prometheus_module, "_request", lambda *a, **k: {"status": "success", "data": {}})  # missing activeTargets

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert drain.DRAIN_PENDING_DETAIL in updated.error


def test_F5_ambiguous_netbox_record_never_upgrades_end_to_end(monkeypatch):
    # codex round-1 F5 repro through the full watcher flow: two same-name
    # records must never trust records[0].
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    retained = {"tags": [{"name": "monitoring:probe"}], "custom_fields": {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl"}}
    other = {"tags": [], "custom_fields": {}}
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 2, "results": [retained, other]})

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert drain.DRAIN_PENDING_DETAIL in updated.error


# ---------------------------------------------------------------------------
# A7 — only one surface drained -> not drained (both must agree). Reuses
# the A2 fixture (promsd still has it, prometheus doesn't) — already
# asserted above; this adds the mirror (prometheus still has it, promsd
# doesn't).
# ---------------------------------------------------------------------------


def test_A7_only_prometheus_still_has_it_stays_incomplete(monkeypatch):
    app, ops_store = _fake_app()
    _seed_run(ops_store)
    op = ops_store.create("rollback", RUN_ID)

    monkeypatch.setattr(main, "get_job", lambda **k: {"status": "successful", "started": "t0", "finished": "t1"})
    monkeypatch.setattr(
        main, "get_job_events_for_task",
        lambda **k: [_outcome_event("DMF_L3_OUTCOME: rollback_incomplete surfaces=monitoring")],
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE, {"labels": {"instance": "mxl-videotestsrc.mxl.svc.cluster.local:9000"}}])

    _run_watcher_and_drain(app, op.operation_id, 111, "rollback", RUN_ID)

    updated = ops_store.get(op.operation_id)
    assert updated.state == OperationState.ROLLBACK_INCOMPLETE
    assert drain.DRAIN_PENDING_DETAIL in updated.error


# ---------------------------------------------------------------------------
# A8 — sync-mode parity: the sync dispatch branch of api_run_rollback also
# ends up at _spawn_job_watcher (codex R2-5), the SAME entrypoint the
# WP4 eligibility hook lives in — no separate sync-terminal path exists.
# ---------------------------------------------------------------------------


def _sync_settings(groups=OPERATOR):
    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(enabled=False),
        l3=L3Settings(enabled=False, rollback_jt_name="media-rollback-run"),
    )


@contextmanager
def _sync_client(groups=OPERATOR):
    # app.state.operations/operation_tasks are only set inside the ASGI
    # lifespan (main.py's `lifespan()`) — the `with` context manager is
    # what actually triggers startup (matches test_rollback_command.py's
    # own convention for any test that touches ops_store).
    with TestClient(create_app(settings=_sync_settings(groups))) as client:
        client.get("/auth/login", follow_redirects=False)
        yield client


def test_A8_sync_rollback_dispatch_uses_the_same_watcher_entrypoint(monkeypatch):
    spawned = []
    monkeypatch.setattr(main, "_spawn_job_watcher", lambda app, op_id, job_id, action, key: spawned.append((action, key)))
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: None)
    monkeypatch.setattr(main, "launch_job", lambda **k: 999)

    with _sync_client() as client:
        resp = client.post(f"/api/runs/{RUN_ID}/rollback", json={"reason": "test"})

        assert resp.status_code == 200
        assert spawned == [("rollback", RUN_ID)]


# ---------------------------------------------------------------------------
# A9 — verify-drain endpoint: drained-now upgrade; ineligible -> explicit
# refusal; role + audit enforced.
# ---------------------------------------------------------------------------


def _verify_drain_settings(groups=OPERATOR, **overrides):
    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        netbox=NetboxSettings(api_url="http://nb.test", api_token="t"),
        prometheus=PrometheusSettings(url="http://prom.test"),
        promsd=PromSDSettings(url="http://promsd.test"),
        l3=L3Settings(enabled=False),
        **overrides,
    )


@contextmanager
def _verify_drain_client(groups=OPERATOR, **overrides):
    with TestClient(create_app(settings=_verify_drain_settings(groups, **overrides))) as client:
        client.get("/auth/login", follow_redirects=False)
        yield client


def _seed_pending_rollback(app, *, run_id=RUN_ID, catalog_key="mxl-videotestsrc", deploy_state=OperationState.RUN_COMPLETE):
    ops_store = app.state.operations
    _seed_run(ops_store, run_id=run_id, catalog_key=catalog_key, deploy_state=deploy_state)
    op = ops_store.create("rollback", run_id)
    ops_store.update(
        op.operation_id, state=OperationState.ROLLBACK_INCOMPLETE,
        error=f"rollback-incomplete:rollback_incomplete surfaces=monitoring detail={drain.DRAIN_PENDING_DETAIL}",
        l3_outcome="rollback_incomplete",
    )
    return op


def test_A9_verify_drain_upgrades_when_now_drained(monkeypatch):
    with _verify_drain_client() as client:
        app = client.app
        _seed_pending_rollback(app)
        _mock_drained(monkeypatch)

        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["drained"] is True
        assert body["state"] == "run_complete"
        assert body["l3_outcome"] == "rollback_complete"


def test_A9_verify_drain_not_yet_drained_is_200_drained_false(monkeypatch):
    # codex round-3 F2: renamed from the stale "...stays_409" — the
    # not-drained branch is a legitimate check result (HTTP 200,
    # drained:false), not a conflict; 409 is reserved for ineligible ops
    # and the correlation-changed-mid-poll refusal (see the F1 tests).
    with _verify_drain_client() as client:
        app = client.app
        _seed_pending_rollback(app)
        _mock_drained(monkeypatch, promsd_targets=[{"targets": ["mxl-videotestsrc.mxl.svc.cluster.local:9000"], "labels": {}}])

        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["drained"] is False
        assert body["state"] == "rollback_incomplete"


def test_A9_verify_drain_ineligible_op_not_pending_is_409():
    with _verify_drain_client() as client:
        app = client.app
        ops_store = app.state.operations
        _seed_run(ops_store)
        op = ops_store.create("rollback", RUN_ID)
        ops_store.update(op.operation_id, state=OperationState.ROLLBACK_INCOMPLETE, error="rollback-incomplete:rollback_incomplete surfaces=netbox,monitoring")

        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 409
        assert resp.json()["error"] == "not-eligible"


def test_A9_verify_drain_no_such_run_is_404():
    with _verify_drain_client() as client:
        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 404
        assert resp.json()["error"] == "not-found"


def test_A9_verify_drain_already_complete_op_is_409():
    with _verify_drain_client() as client:
        app = client.app
        ops_store = app.state.operations
        _seed_run(ops_store)
        op = ops_store.create("rollback", RUN_ID)
        ops_store.update(op.operation_id, state=OperationState.RUN_COMPLETE, l3_outcome="rollback_complete")

        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 409
        assert resp.json()["error"] == "not-eligible"


def test_A9_verify_drain_requires_operator_role():
    with _verify_drain_client(groups=VIEWER) as client:
        app = client.app
        _seed_pending_rollback(app)

        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 403


def test_A9_verify_drain_requires_reason():
    with _verify_drain_client() as client:
        app = client.app
        _seed_pending_rollback(app)

        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={})
        assert resp.status_code == 400


def test_A9_verify_drain_is_audited(monkeypatch, caplog):
    with _verify_drain_client() as client:
        app = client.app
        _seed_pending_rollback(app)
        _mock_drained(monkeypatch)

        with caplog.at_level("INFO"):
            client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})

        audit_lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]
        assert any("action=verify-drain" in line and "outcome=drained" in line for line in audit_lines)


# ---------------------------------------------------------------------------
# F1 — facility-coherence: a verified drain must resolve the run's
# correlated deploy op AND any superseded rollback attempts, or
# _facility_busy_check keeps blocking the facility until TTL GC.
# ---------------------------------------------------------------------------


def test_F1_verified_drain_resolves_deploy_op_and_clears_facility_block(monkeypatch):
    with _verify_drain_client() as client:
        app = client.app
        ops_store = app.state.operations
        # The exact codex round-1 repro: deploy D at FAILED_ROLLBACK_REQUIRED
        # with run_id=R, rollback B targeting R.
        deploy_op = _seed_run(ops_store, deploy_state=OperationState.FAILED_ROLLBACK_REQUIRED)
        _seed_pending_rollback(app)
        _mock_drained(monkeypatch)

        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 200
        assert resp.json()["drained"] is True

        updated_deploy = ops_store.get(deploy_op.operation_id)
        assert updated_deploy.state == OperationState.RUN_FAILED
        assert drain.ROLLBACK_VERIFIED_DETAIL in (updated_deploy.error or "")
        assert updated_deploy.state not in DIRTY_STATES

        # F1's whole point: _facility_busy_check must ACTUALLY be invoked
        # and must NOT see this deploy op as blocking a new dispatch to a
        # DIFFERENT catalog target anymore.
        blocking = main._facility_busy_check(ops_store, current_target="some-other-key", current_action="deploy")
        assert blocking is None


def test_F1_superseded_rollback_ops_also_resolve(monkeypatch):
    with _verify_drain_client() as client:
        app = client.app
        ops_store = app.state.operations
        _seed_run(ops_store)

        # A superseded EARLIER rollback attempt at the same run_id — codex
        # round-2 F4's own repro: a DIFFERENT launcher outcome
        # (stale-snapshot, not even rollback_incomplete) that must never
        # be overwritten. Created (and thus least-recently-updated)
        # BEFORE the primary op, so _find_rollback_op_for_run's
        # most-recently-updated selection deterministically targets the
        # primary op below, not this one.
        superseded = ops_store.create("rollback", RUN_ID)
        ops_store.update(
            superseded.operation_id, state=OperationState.ROLLBACK_INCOMPLETE,
            l3_outcome="stale-snapshot",
            error=f"rollback-incomplete:stale-snapshot detail=snapshot-collision detail={drain.DRAIN_PENDING_DETAIL}",
        )
        primary = _seed_pending_rollback(app)

        _mock_drained(monkeypatch)
        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 200
        assert resp.json()["operation_id"] == primary.operation_id

        updated_primary = ops_store.get(primary.operation_id)
        assert updated_primary.state == OperationState.RUN_COMPLETE
        assert updated_primary.l3_outcome == "rollback_complete"

        # The superseded op resolves to a non-dirty terminal too (facility
        # unblocks), but F4 (codex round-2, REVERSES round-1's directive)
        # forbids falsifying its own outcome: RUN_FAILED (truthful — that
        # attempt did NOT complete), l3_outcome and the retained error
        # content stay EXACTLY what the launcher reported (stale-snapshot
        # / snapshot-collision survive verbatim), only the superseding
        # detail is appended (the pending token is still stripped, F9).
        updated_superseded = ops_store.get(superseded.operation_id)
        assert updated_superseded.state == OperationState.RUN_FAILED
        assert updated_superseded.l3_outcome == "stale-snapshot"
        assert "rollback-incomplete:stale-snapshot" in updated_superseded.error
        assert "detail=snapshot-collision" in updated_superseded.error
        assert drain.SUPERSEDED_BY_VERIFIED_ROLLBACK_DETAIL in updated_superseded.error
        assert drain.DRAIN_PENDING_DETAIL not in updated_superseded.error

        from dmf_cms.operations import DIRTY_STATES as _DIRTY
        assert updated_superseded.state not in _DIRTY


def test_F1_TOCTOU_correlation_ambiguous_at_finalize_time_upgrades_nothing():
    # codex round-2 R2b-1: correlation was UNAMBIGUOUS when
    # _prepare_drain_verification resolved it (poll start), but a second
    # deploy op disagreeing on target for the SAME run_id appears before
    # the drain check actually completes (a race — a reattach/manual-track
    # elsewhere). _mark_drain_verified re-derives the correlation FRESH at
    # finalize time and must refuse to upgrade ANYTHING — not even the
    # primary rollback op itself — against a now-disputed identity.
    app, ops_store = _fake_app()
    deploy_op = _seed_run(ops_store, deploy_state=OperationState.FAILED_ROLLBACK_REQUIRED)
    op = ops_store.create("rollback", RUN_ID)
    ops_store.update(
        op.operation_id, state=OperationState.ROLLBACK_INCOMPLETE,
        error=f"rollback-incomplete:rollback_incomplete surfaces=monitoring detail={drain.DRAIN_PENDING_DETAIL}",
    )

    # The race: a second deploy op claims the SAME run_id but a DIFFERENT
    # catalog target, appearing only now — after prepare would have
    # already resolved cleanly.
    racing = ops_store.create("deploy", "some-other-target")
    ops_store.update(racing.operation_id, run_id=RUN_ID)

    main._mark_drain_verified(ops_store, op.operation_id, RUN_ID)

    updated_rollback = ops_store.get(op.operation_id)
    assert updated_rollback.state == OperationState.ROLLBACK_INCOMPLETE
    assert drain.DRAIN_PENDING_DETAIL in updated_rollback.error
    assert drain.DRAIN_VERIFIED_DETAIL not in updated_rollback.error

    # The original (still-legitimately-correlated) deploy op is untouched
    # too — nothing upgrades on either side of an ambiguous correlation.
    updated_deploy = ops_store.get(deploy_op.operation_id)
    assert updated_deploy.state == OperationState.FAILED_ROLLBACK_REQUIRED
    assert drain.ROLLBACK_VERIFIED_DETAIL not in (updated_deploy.error or "")


def test_F1_endpoint_race_during_check_drained_returns_409_nothing_upgraded(monkeypatch, caplog):
    # codex round-2 F1's own endpoint-level repro: _prepare_drain_verification
    # resolves cleanly (correlation is unambiguous at that moment), but a
    # disagreeing deploy op for the SAME run_id appears DURING
    # check_drained's own seam reads (a race elsewhere) — before
    # _mark_drain_verified re-derives correlation at finalize time. The
    # endpoint must never report success in this window: no HTTP 200
    # drained:true with a body that still says state=rollback_incomplete.
    with _verify_drain_client() as client:
        app = client.app
        ops_store = app.state.operations
        deploy_op = _seed_run(ops_store, deploy_state=OperationState.FAILED_ROLLBACK_REQUIRED)
        rollback_op = _seed_pending_rollback(app)

        def racing_check_drained(*args, **kwargs):
            # Side effect during the drain check itself: a second,
            # disagreeing deploy op for the SAME run_id appears mid-check.
            racing = ops_store.create("deploy", "some-other-target")
            ops_store.update(racing.operation_id, run_id=RUN_ID)
            return True

        monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
        monkeypatch.setattr(drain, "check_drained", racing_check_drained)

        with caplog.at_level("INFO"):
            resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})

        audit_lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]
        assert any("action=verify-drain" in line and "outcome=correlation-changed" in line for line in audit_lines)
        assert not any("outcome=drained" in line for line in audit_lines)

        assert resp.status_code == 409
        body = resp.json()
        assert body["error"] == "correlation-changed-mid-poll"
        assert body["drained"] is False
        assert body["state"] == "rollback_incomplete"

        # Nothing upgraded — the rollback op stays pending, the
        # originally-correlated deploy op is untouched.
        updated_rollback = ops_store.get(rollback_op.operation_id)
        assert updated_rollback.state == OperationState.ROLLBACK_INCOMPLETE
        assert drain.DRAIN_PENDING_DETAIL in updated_rollback.error
        assert drain.DRAIN_VERIFIED_DETAIL not in updated_rollback.error
        updated_deploy = ops_store.get(deploy_op.operation_id)
        assert updated_deploy.state == OperationState.FAILED_ROLLBACK_REQUIRED


def test_F6_ambiguous_run_correlation_stays_pending_nothing_upgraded(monkeypatch):
    with _verify_drain_client() as client:
        app = client.app
        ops_store = app.state.operations
        # Two deploy ops claim the SAME run_id but DIFFERENT catalog
        # targets — OperationStore doesn't enforce uniqueness. Must fail
        # closed, never order-selected.
        wrong = ops_store.create("deploy", "wrong-target")
        ops_store.update(wrong.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, run_id=RUN_ID)
        actual = ops_store.create("deploy", "mxl-videotestsrc")
        ops_store.update(actual.operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED, run_id=RUN_ID)

        rollback_op = ops_store.create("rollback", RUN_ID)
        ops_store.update(
            rollback_op.operation_id, state=OperationState.ROLLBACK_INCOMPLETE,
            error=f"rollback-incomplete:rollback_incomplete surfaces=monitoring detail={drain.DRAIN_PENDING_DETAIL}",
        )

        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 409
        assert resp.json()["error"] == "unrecoverable"

        # Nothing upgraded — both deploy ops and the rollback op stay
        # exactly where they were.
        assert ops_store.get(wrong.operation_id).state == OperationState.FAILED_ROLLBACK_REQUIRED
        assert ops_store.get(actual.operation_id).state == OperationState.FAILED_ROLLBACK_REQUIRED
        assert ops_store.get(rollback_op.operation_id).state == OperationState.ROLLBACK_INCOMPLETE


def test_F9_no_contradictory_details_after_recheck(monkeypatch):
    # A late recheck (after the poll window already appended
    # monitoring-drain-pending) must never leave BOTH pending and verified
    # visible on the final surface.
    with _verify_drain_client() as client:
        app = client.app
        _seed_run(app.state.operations)
        _seed_pending_rollback(app)
        _mock_drained(monkeypatch)

        resp = client.post(f"/api/runs/{RUN_ID}/verify-drain", json={"reason": "recheck"})
        assert resp.status_code == 200
        body = resp.json()
        assert drain.DRAIN_VERIFIED_DETAIL in body["error"]
        assert drain.DRAIN_PENDING_DETAIL not in body["error"]
