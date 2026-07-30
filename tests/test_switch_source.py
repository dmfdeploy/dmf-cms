"""umbrella #201 WP4 — SwitchSourceCommand domain command + status machine
+ coarse `reconnect` actuator (spec §6: `DMF v0.2b Multi-Source Switch Spec
2026-07-15.md`).

Four layers, mirroring switch_source.py's own module docstring:
* SwitchCommandStore — thread-safe in-memory store, TTL GC, idempotency
  guard (same conventions as test_operations_lifecycle.py's own
  OperationStore coverage).
* resolve_topology_for_receiver / dispatch_switch_source — request-shape
  validation BEFORE a command exists, and the idempotency/re-entry guard.
* ReconnectViaAwxActuator — the coarse actuator's own status-machine
  transitions + failure postures, against a monkeypatched `awx` module
  (same convention as test_operations_lifecycle.py's watcher tests) —
  plus a sequencing-order test built to catch a reordered mutant.
* The §6.3 contract-surface test — a second, fake, non-AWX actuator
  satisfying the SAME SwitchActuator Protocol, proving
  dispatch_switch_source needs zero changes to use it.
"""

import asyncio
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from dmf_cms import awx
from dmf_cms.settings import load_settings
from dmf_cms.switch_source import (
    SWITCH_OUTCOME_PREVIOUS_SOURCE_RESTORED,
    SWITCH_OUTCOME_RECOVERY_UNVERIFIED,
    SWITCH_OUTCOME_SUCCESS,
    SWITCH_OUTCOME_WATCH_LOST,
    SWITCH_OUTCOME_WATCH_TIMEOUT,
    ReconnectViaAwxActuator,
    SwitchCommandStore,
    SwitchSourceCommand,
    SwitchSourceError,
    SwitchStatus,
    classify_switch_job_failure,
    dispatch_switch_source,
)


def _write(directory: Path, filename: str, body: str) -> Path:
    p = directory / filename
    p.write_text(body)
    return p


J1_INSTANCE = """\
topology_params:
  schema_version: 1
  target_facility: dmf-example-site
  sources:
    - id: source-a
      flow_id: "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
      pattern: smpte
    - id: source-b
      flow_id: "b0ae9cba-a989-4568-ac96-8bd19272c966"
      pattern: ball
  viewer:
    id: viewer-a
    source_selection: source-a
"""

_TOPOLOGY_PARAMS = {
    "schema_version": 1,
    "target_facility": "dmf-example-site",
    "sources": [
        {"id": "source-a", "flow_id": "5fbec3b1-1b0f-417d-9059-8b94a47197ed", "pattern": "smpte"},
        {"id": "source-b", "flow_id": "b0ae9cba-a989-4568-ac96-8bd19272c966", "pattern": "ball"},
    ],
    "viewer": {"id": "viewer-a", "source_selection": "source-a"},
}


def _write_receiver(tmp_path: Path, *, with_topology_ref: bool = True) -> None:
    lines = [
        "key: mxl-videotest-view",
        'display_name: "Viewer"',
        'summary: "x"',
        "ebu:",
        "  layer: 5",
        "  media_function_type: view",
    ]
    if with_topology_ref:
        lines.append("topology_ref: topology-params.j1.yaml")
    (tmp_path / "mxl-videotest-view.yaml").write_text("\n".join(lines) + "\n")


def _pending_command(**overrides: Any) -> SwitchSourceCommand:
    defaults: dict[str, Any] = dict(
        command_id="cmd-1",
        receiver_instance="mxl-videotest-view",
        source_instance="source-b",
        reason="operator requested",
    )
    defaults.update(overrides)
    return SwitchSourceCommand(**defaults)


class _BoomActuator:
    """Raises if ever invoked — used to prove a request-shape error or an
    idempotent re-entry never reaches the actuator."""

    async def execute(self, command: SwitchSourceCommand, topology_params: dict[str, Any]) -> None:
        raise AssertionError("actuator must not be invoked here")


# ── SwitchCommandStore — CRUD, idempotency guard, TTL GC ────────────────


def test_command_store_create_get_roundtrip():
    store = SwitchCommandStore()
    cmd = store.create(receiver_instance="r1", source_instance="source-a", reason="x")
    assert store.get(cmd.command_id) is cmd
    assert cmd.status == SwitchStatus.PENDING


def test_command_store_get_unknown_id_is_none():
    store = SwitchCommandStore()
    assert store.get("does-not-exist") is None


def test_find_active_returns_non_terminal_command():
    store = SwitchCommandStore()
    cmd = store.create(receiver_instance="r1", source_instance="source-a", reason="x")
    assert store.find_active("r1") is cmd


def test_find_active_ignores_terminal_commands():
    store = SwitchCommandStore()
    cmd = store.create(receiver_instance="r1", source_instance="source-a", reason="x")
    cmd.status = SwitchStatus.ACTIVE
    assert store.find_active("r1") is None


def test_find_active_scoped_per_receiver():
    store = SwitchCommandStore()
    cmd_r1 = store.create(receiver_instance="r1", source_instance="source-a", reason="x")
    store.create(receiver_instance="r2", source_instance="source-a", reason="x")
    assert store.find_active("r1") is cmd_r1


def test_terminal_command_is_gc_eligible_immediately_with_zero_ttl():
    store = SwitchCommandStore(ttl_seconds=0)
    cmd = store.create(receiver_instance="r1", source_instance="source-a", reason="x")
    cmd.status = SwitchStatus.FAILED_ROLLBACK_REQUIRED
    # Force past-due deterministically rather than relying on real-clock
    # jitter between create() and get() being > 0.
    cmd.updated_at = cmd.updated_at - timedelta(seconds=1)
    assert store.get(cmd.command_id) is None


def test_to_dict_serializes_all_fields():
    store = SwitchCommandStore()
    cmd = store.create(
        receiver_instance="r1",
        source_instance="source-a",
        reason="x",
        request_id="req-1",
        initiator="alice",
        previous_source="source-b",
    )
    d = cmd.to_dict()
    assert d["receiver_instance"] == "r1"
    assert d["source_instance"] == "source-a"
    assert d["status"] == "pending"
    assert d["previous_source"] == "source-b"
    assert d["request_id"] == "req-1"
    assert d["initiator"] == "alice"
    assert isinstance(d["created_at"], str)
    assert isinstance(d["updated_at"], str)


# ── dispatch_switch_source — request-shape validation before any command
# is ever created ────────────────────────────────────────────────────────


def test_receiver_not_found_raises_before_command_created(tmp_path):
    store = SwitchCommandStore()
    with pytest.raises(SwitchSourceError) as exc:
        asyncio.run(dispatch_switch_source(
            receiver_instance="does-not-exist",
            source_instance="source-a",
            reason="test",
            store=store,
            actuator=_BoomActuator(),
            catalog_dir=str(tmp_path),
        ))
    assert exc.value.code == "receiver-not-found"
    assert store.find_active("does-not-exist") is None


def test_receiver_without_topology_ref_raises_before_command_created(tmp_path):
    _write_receiver(tmp_path, with_topology_ref=False)
    store = SwitchCommandStore()
    with pytest.raises(SwitchSourceError) as exc:
        asyncio.run(dispatch_switch_source(
            receiver_instance="mxl-videotest-view",
            source_instance="source-a",
            reason="test",
            store=store,
            actuator=_BoomActuator(),
            catalog_dir=str(tmp_path),
        ))
    assert exc.value.code == "receiver-not-topology"
    assert store.find_active("mxl-videotest-view") is None


def test_invalid_topology_params_raises_before_command_created(tmp_path):
    _write_receiver(tmp_path)
    _write(tmp_path, "topology-params.j1.yaml", "topology_params:\n  schema_version: 2\n")
    store = SwitchCommandStore()
    with pytest.raises(SwitchSourceError) as exc:
        asyncio.run(dispatch_switch_source(
            receiver_instance="mxl-videotest-view",
            source_instance="source-a",
            reason="test",
            store=store,
            actuator=_BoomActuator(),
            catalog_dir=str(tmp_path),
        ))
    assert exc.value.code == "topology-invalid"
    assert store.find_active("mxl-videotest-view") is None


def test_unknown_source_instance_raises_before_command_created(tmp_path):
    _write_receiver(tmp_path)
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    store = SwitchCommandStore()
    with pytest.raises(SwitchSourceError) as exc:
        asyncio.run(dispatch_switch_source(
            receiver_instance="mxl-videotest-view",
            source_instance="does-not-exist",
            reason="test",
            store=store,
            actuator=_BoomActuator(),
            catalog_dir=str(tmp_path),
        ))
    assert exc.value.code == "source-not-found"
    assert store.find_active("mxl-videotest-view") is None


# ── dispatch_switch_source — idempotency/re-entry ───────────────────────


def test_idempotent_reentry_returns_existing_non_terminal_command_untouched(tmp_path):
    _write_receiver(tmp_path)
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    store = SwitchCommandStore()
    existing = store.create(
        receiver_instance="mxl-videotest-view", source_instance="source-b", reason="first caller"
    )

    result = asyncio.run(dispatch_switch_source(
        receiver_instance="mxl-videotest-view",
        source_instance="source-a",
        reason="second caller",
        store=store,
        actuator=_BoomActuator(),
        catalog_dir=str(tmp_path),
    ))

    # Same command object, and the SECOND caller's request never overwrote
    # the first's — proves a duplicate dispatch never happened (the
    # _BoomActuator would have raised had one been attempted).
    assert result is existing
    assert result.status == SwitchStatus.PENDING
    assert result.source_instance == "source-b"
    assert result.reason == "first caller"


# ── ReconnectViaAwxActuator._build_extra_vars — pure payload contract ───


def test_build_extra_vars_reassigns_source_selection_and_is_pure():
    command = _pending_command(source_instance="source-b")
    extra_vars = ReconnectViaAwxActuator._build_extra_vars(command, _TOPOLOGY_PARAMS)

    assert extra_vars == {
        "topology_params": {
            **_TOPOLOGY_PARAMS,
            "viewer": {"id": "viewer-a", "source_selection": "source-b"},
        },
        "receiver_instance": "mxl-videotest-view",
        "source_instance": "source-b",
        "reason": "operator requested",
    }
    # Pure — the caller's own topology_params object must be untouched.
    assert _TOPOLOGY_PARAMS["viewer"]["source_selection"] == "source-a"


# ── ReconnectViaAwxActuator.execute() — status-machine + failure postures


def _actuator(**overrides: Any) -> ReconnectViaAwxActuator:
    defaults: dict[str, Any] = dict(
        awx_api_url="http://awx.test",
        awx_api_token="t",
        poll_interval_seconds=0.01,
        timeout_seconds=5.0,
    )
    defaults.update(overrides)
    return ReconnectViaAwxActuator(**defaults)


def test_actuator_template_missing_sets_failed_rollback_required(monkeypatch):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: None)
    command = _pending_command()
    asyncio.run(_actuator().execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.error.startswith("switch-job-template-missing")
    # umbrella #320: this failure mode predates ever launching a job (no
    # job to classify) — outcome deliberately stays unclassified, never a
    # fabricated switch_* value.
    assert command.outcome is None
    assert command.outcome_message is None


def test_actuator_launch_exception_sets_launch_failed(monkeypatch):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})

    def boom_launch(**k):
        raise RuntimeError("boom")

    monkeypatch.setattr(awx, "launch_job", boom_launch)
    command = _pending_command()
    asyncio.run(_actuator().execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.error == "switch-launch-failed"
    assert command.outcome is None


def test_actuator_successful_job_reaches_active(monkeypatch):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: {"status": "successful"})
    command = _pending_command()
    asyncio.run(_actuator().execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.ACTIVE
    assert command.error is None
    assert command.outcome == SWITCH_OUTCOME_SUCCESS
    assert command.outcome_message is None


@pytest.mark.parametrize(
    ("status", "expected_outcome"),
    [("failed", "switch_job_failed"), ("error", "switch_job_error"), ("canceled", "switch_job_canceled")],
)
def test_actuator_job_terminal_failure_sets_failed_rollback_required(monkeypatch, status, expected_outcome):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: {"status": status})
    # umbrella #320: the actuator now fetches stdout to classify the
    # outcome — mocked here to plain unmarked text (no rollback/refused
    # prefix), which must fall back to the generic job-status mapping.
    monkeypatch.setattr(awx, "get_job_stdout", lambda **k: "PLAY RECAP *** ok=1 changed=0 failed=1")
    command = _pending_command()
    asyncio.run(_actuator().execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.error == f"switch-job-{status}"
    assert command.outcome == expected_outcome
    assert command.outcome_message is None


def test_actuator_terminal_failure_classifies_previous_source_restored(monkeypatch):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: {"status": "failed"})
    monkeypatch.setattr(
        awx, "get_job_stdout",
        lambda **k: (
            'fatal: [receiver]: FAILED! => {"msg": "rollback_verified previous_source_restored: '
            'receiver_instance=mxl-videotest-view request_id=abc restored_active_source=source-a."}'
        ),
    )
    command = _pending_command()
    asyncio.run(_actuator().execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.error == "switch-job-failed"  # coarse field unchanged, per the frozen contract
    assert command.outcome == SWITCH_OUTCOME_PREVIOUS_SOURCE_RESTORED
    assert command.outcome_message == (
        "Switch did not complete; the previous source was restored. Safe to retry."
    )


def test_actuator_terminal_failure_classifies_recovery_unverified(monkeypatch):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: {"status": "failed"})
    monkeypatch.setattr(
        awx, "get_job_stdout",
        lambda **k: (
            'fatal: [receiver]: FAILED! => {"msg": "rollback_verification_failed: '
            'receiver_instance=mxl-videotest-view request_id=abc."}'
        ),
    )
    command = _pending_command()
    asyncio.run(_actuator().execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.outcome == SWITCH_OUTCOME_RECOVERY_UNVERIFIED
    assert command.outcome_message == (
        "Switch did not complete; automatic recovery did not verify. "
        "Output may be parked; follow the recovery path."
    )


def test_actuator_terminal_failure_classifies_refused_detail(monkeypatch):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: {"status": "failed"})
    monkeypatch.setattr(
        awx, "get_job_stdout",
        lambda **k: (
            'fatal: [receiver]: FAILED! => {"msg": "DMF_L3_SWITCH_REFUSED: '
            'detail=switch-source-instance-mismatch request_id=abc."}'
        ),
    )
    command = _pending_command()
    asyncio.run(_actuator().execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.outcome == "switch_refused_switch-source-instance-mismatch"
    assert command.outcome_message is None


def test_actuator_stdout_fetch_failure_falls_back_to_generic_outcome(monkeypatch):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: {"status": "failed"})

    def boom_stdout(**k):
        raise RuntimeError("AWX API unreachable")

    monkeypatch.setattr(awx, "get_job_stdout", boom_stdout)
    command = _pending_command()
    asyncio.run(_actuator().execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.outcome == "switch_job_failed"
    assert command.outcome_message is None


def test_actuator_watch_lost_after_three_consecutive_poll_failures(monkeypatch):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)

    def boom_get_job(**k):
        raise RuntimeError("network blip")

    monkeypatch.setattr(awx, "get_job", boom_get_job)
    command = _pending_command()
    asyncio.run(_actuator(poll_interval_seconds=0.001).execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.error == "switch-watch-lost"
    assert command.outcome == SWITCH_OUTCOME_WATCH_LOST


@pytest.mark.parametrize("bad_job", [{"no_status_key": True}, {"status": 123}, "not-a-dict", None])
def test_actuator_malformed_job_response_sets_watch_crashed(monkeypatch, bad_job):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: bad_job)
    command = _pending_command()
    asyncio.run(_actuator(poll_interval_seconds=0.001).execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.error == "switch-watch-crashed"
    assert command.outcome is None


def test_actuator_timeout_sets_watch_timeout(monkeypatch):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: {"status": "running"})
    command = _pending_command()
    asyncio.run(_actuator(timeout_seconds=0.05, poll_interval_seconds=0.01).execute(command, _TOPOLOGY_PARAMS))
    assert command.status == SwitchStatus.FAILED_ROLLBACK_REQUIRED
    assert command.error == "switch-watch-timeout"
    assert command.outcome == SWITCH_OUTCOME_WATCH_TIMEOUT


# ── classify_switch_job_failure — pure parser unit tests (umbrella #320) ─


def test_classify_switch_job_failure_generic_statuses_with_no_stdout():
    assert classify_switch_job_failure("failed", None) == ("switch_job_failed", None)
    assert classify_switch_job_failure("error", None) == ("switch_job_error", None)
    assert classify_switch_job_failure("canceled", None) == ("switch_job_canceled", None)


def test_classify_switch_job_failure_generic_statuses_with_unmarked_stdout():
    stdout = "PLAY [switch] ****\nTASK [some other task] ***\nok: [x]\nPLAY RECAP *** failed=1"
    assert classify_switch_job_failure("failed", stdout) == ("switch_job_failed", None)


def test_classify_switch_job_failure_detects_previous_source_restored():
    stdout = (
        'fatal: [r]: FAILED! => {"msg": "rollback_verified previous_source_restored: '
        'receiver_instance=r request_id=abc restored_active_source=source-a."}'
    )
    outcome, message = classify_switch_job_failure("failed", stdout)
    assert outcome == SWITCH_OUTCOME_PREVIOUS_SOURCE_RESTORED
    assert message == "Switch did not complete; the previous source was restored. Safe to retry."


def test_classify_switch_job_failure_detects_recovery_unverified():
    stdout = 'fatal: [r]: FAILED! => {"msg": "rollback_verification_failed: receiver_instance=r."}'
    outcome, message = classify_switch_job_failure("failed", stdout)
    assert outcome == SWITCH_OUTCOME_RECOVERY_UNVERIFIED
    assert message == (
        "Switch did not complete; automatic recovery did not verify. "
        "Output may be parked; follow the recovery path."
    )


def test_classify_switch_job_failure_detects_refused_detail_token():
    stdout = 'fatal: [r]: FAILED! => {"msg": "DMF_L3_SWITCH_REFUSED: detail=topology-invalid request_id=abc."}'
    assert classify_switch_job_failure("failed", stdout) == ("switch_refused_topology-invalid", None)


def test_classify_switch_job_failure_ignores_unrecognized_refused_detail():
    """A detail= value NOT in the shared KV_DETAIL_TOKENS allowlist must
    never be echoed verbatim into a fabricated switch_refused_<x> — falls
    back to the generic job-status mapping instead (fail-closed, same
    posture as main.py's own _kv_value_ok enum check)."""
    stdout = 'fatal: [r]: FAILED! => {"msg": "DMF_L3_SWITCH_REFUSED: detail=not-a-real-token request_id=abc."}'
    assert classify_switch_job_failure("failed", stdout) == ("switch_job_failed", None)


def test_classify_switch_job_failure_rollback_prefix_takes_priority_over_refused():
    """Should never co-occur in real runbooks output (mutually exclusive
    `when:` guards in the playbook), but the priority order is still
    asserted directly so it's pinned, not incidental."""
    stdout = (
        'rollback_verified previous_source_restored: ... '
        'DMF_L3_SWITCH_REFUSED: detail=topology-invalid'
    )
    outcome, _ = classify_switch_job_failure("failed", stdout)
    assert outcome == SWITCH_OUTCOME_PREVIOUS_SOURCE_RESTORED


# ── DMF_CONSOLE_L3_SWITCH_SOURCE_TIMEOUT_SECONDS (umbrella #306) ────────
#
# The actuator's own _DEFAULT_ACTUATOR_TIMEOUT_SECONDS (120.0, above) is the
# CLASS default used when no caller supplies timeout_seconds at all. The
# console's switch-source endpoint (main.py) instead always passes
# settings.l3.switch_source_timeout_seconds explicitly — these two tests
# cover THAT settings-layer default/override; the endpoint's own wiring
# (that the configured value actually reaches the ReconnectViaAwxActuator
# call) is covered in test_switch_source_endpoint.py.


def test_load_settings_default_switch_source_timeout_seconds(monkeypatch):
    monkeypatch.delenv("DMF_CONSOLE_L3_SWITCH_SOURCE_TIMEOUT_SECONDS", raising=False)
    settings = load_settings()
    assert settings.l3.switch_source_timeout_seconds == 360


def test_load_settings_switch_source_timeout_seconds_env_override(monkeypatch):
    monkeypatch.setenv("DMF_CONSOLE_L3_SWITCH_SOURCE_TIMEOUT_SECONDS", "45")
    settings = load_settings()
    assert settings.l3.switch_source_timeout_seconds == 45


def test_actuator_sequencing_lookup_before_launch_before_terminal_status(monkeypatch):
    """Mutant-detectable ordering probe (Python-level; the ACTUAL
    quiesce -> re-point -> select sequencing of spec §6.2 lives inside
    WP4b's own AWX playbook, not here — see ReconnectViaAwxActuator's own
    docstring). A mutant that launches before looking up the template, or
    that sets ACTIVE without ever observing a genuine terminal poll, fails
    this."""
    call_order: list[str] = []
    status_at_call: dict[str, SwitchStatus] = {}

    def fake_lookup(**k):
        call_order.append("lookup")
        status_at_call["lookup"] = command.status
        return {"id": 7}

    def fake_launch(**k):
        call_order.append("launch")
        status_at_call["launch"] = command.status
        return 42

    def fake_get_job(**k):
        call_order.append("get_job")
        status_at_call["get_job"] = command.status
        return {"status": "successful"}

    monkeypatch.setattr(awx, "lookup_job_template_by_name", fake_lookup)
    monkeypatch.setattr(awx, "launch_job", fake_launch)
    monkeypatch.setattr(awx, "get_job", fake_get_job)

    command = _pending_command()
    asyncio.run(_actuator().execute(command, _TOPOLOGY_PARAMS))

    assert call_order == ["lookup", "launch", "get_job"]
    assert status_at_call["lookup"] == SwitchStatus.RECONNECTING
    assert status_at_call["launch"] == SwitchStatus.RECONNECTING
    # Still RECONNECTING at the moment get_job is called — ACTIVE is only
    # set AFTER this call returns a terminal status, never before.
    assert status_at_call["get_job"] == SwitchStatus.RECONNECTING
    assert command.status == SwitchStatus.ACTIVE


# ── §6.3 contract-surface test ───────────────────────────────────────────


class _FakeNonAwxActuator:
    """A second SwitchActuator satisfying the SAME Protocol, deliberately
    touching NOTHING AWX-related — proves swapping the concrete actuator
    changes nothing at the SwitchSourceCommand/dispatch_switch_source
    layer (spec §6.3)."""

    def __init__(self) -> None:
        self.executed_with: list[tuple[SwitchSourceCommand, dict[str, Any]]] = []

    async def execute(self, command: SwitchSourceCommand, topology_params: dict[str, Any]) -> None:
        self.executed_with.append((command, topology_params))
        command.status = SwitchStatus.ACTIVE


def test_contract_surface_second_actuator_swaps_with_zero_command_layer_changes(tmp_path):
    _write_receiver(tmp_path)
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    store = SwitchCommandStore()
    fake_actuator = _FakeNonAwxActuator()

    result = asyncio.run(dispatch_switch_source(
        receiver_instance="mxl-videotest-view",
        source_instance="source-b",
        reason="contract test",
        store=store,
        actuator=fake_actuator,
        catalog_dir=str(tmp_path),
    ))

    assert result.status == SwitchStatus.ACTIVE
    assert result.previous_source == "source-a"
    assert result.source_instance == "source-b"
    assert len(fake_actuator.executed_with) == 1
    executed_command, executed_topology = fake_actuator.executed_with[0]
    assert executed_command is result
    assert executed_topology["sources"][0]["id"] == "source-a"
