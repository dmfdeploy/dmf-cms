"""Tests for WS5 autoscale operation tracking."""

import asyncio
import logging
import os
import threading
import time
import urllib.error
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from dmf_cms.awx import AWXAPIError, call_with_transient_retry
from dmf_cms.catalog import CatalogEntry
from dmf_cms.operations import OperationState, OperationStore
from dmf_cms.settings import L3Settings, Settings, load_settings

# This file exercises autoscale/operation-store/conflict logic, not the L3
# capacity preflight (#202 WP1) — none of these fixtures configure
# Prometheus, and since R2-1 made "l3.enabled=True but prometheus
# unconfigured" a fail-closed 409 (not a skip), every deploy fixture here
# must explicitly disable L3 (the one documented kill switch) to keep
# testing what it was written to test.
_L3_DISABLED = L3Settings(enabled=False)


@pytest.fixture
def enabled_settings():
    """Settings with autoscale enabled and configured."""
    from dmf_cms.settings import AWXSettings, AWXAutoscaleSettings

    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=("dmf-console-operator",),
        awx=AWXSettings(
            api_url="http://awx.test",
            api_token="test-token",
            ssl_verify=False
        ),
        awx_autoscale=AWXAutoscaleSettings(
            enabled=True,
            helper_url="http://helper.test",
            bearer_token="bearer-token",
            max_startup_wait=1260
        ),
        l3=_L3_DISABLED,
    )


@pytest.fixture
def disabled_settings():
    """Settings with autoscale disabled."""
    from dmf_cms.settings import AWXSettings, AWXAutoscaleSettings

    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=("dmf-console-operator",),
        awx=AWXSettings(
            api_url="http://awx.test",
            api_token="test-token",
            ssl_verify=False
        ),
        awx_autoscale=AWXAutoscaleSettings(enabled=False),
        l3=_L3_DISABLED,
    )


@pytest.fixture
def misconfigured_settings():
    """Settings with autoscale enabled but misconfigured."""
    from dmf_cms.settings import AWXSettings, AWXAutoscaleSettings

    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=("dmf-console-operator",),
        awx=AWXSettings(
            api_url="http://awx.test",
            api_token="test-token",
            ssl_verify=False
        ),
        # Missing helper_url and bearer_token -> configured=False
        awx_autoscale=AWXAutoscaleSettings(
            enabled=True,
            helper_url="",
            bearer_token=""
        ),
        l3=_L3_DISABLED,
    )


def test_load_settings_default_max_startup_wait():
    """Test that load_settings() with env unset yields max_startup_wait == 1260."""
    # Ensure env var is unset
    env_backup = os.environ.pop("DMF_CONSOLE_AWX_AUTOSCALE_MAX_STARTUP_WAIT", None)
    try:
        settings = load_settings()
        assert settings.awx_autoscale.max_startup_wait == 1260
    finally:
        # Restore env if it was set
        if env_backup is not None:
            os.environ["DMF_CONSOLE_AWX_AUTOSCALE_MAX_STARTUP_WAIT"] = env_backup


def test_operation_store_atomic_dedupe():
    """Test that get_or_create atomically dedupes concurrent requests."""
    store = OperationStore(ttl_seconds=3600)

    # First call creates
    op1, created1 = store.get_or_create("launch", "workflow-a")
    assert created1 is True
    assert op1.state == OperationState.WAKING

    # Second call with same action+target returns existing
    op2, created2 = store.get_or_create("launch", "workflow-a")
    assert created2 is False
    assert op2.operation_id == op1.operation_id

    # Different target creates new
    op3, created3 = store.get_or_create("launch", "workflow-b")
    assert created3 is True
    assert op3.operation_id != op1.operation_id

    # Different action creates new
    op4, created4 = store.get_or_create("deploy", "workflow-a")
    assert created4 is True
    assert op4.operation_id != op1.operation_id


def test_operation_store_dedupe_respects_terminal_states():
    """Test that terminal states (launched/error) don't block new operations."""
    store = OperationStore(ttl_seconds=3600)

    # Create and launch
    op1, _ = store.get_or_create("launch", "workflow-a")
    store.update(op1.operation_id, state=OperationState.LAUNCHED, job_id=123)

    # New operation for same action+target should create (old one is terminal)
    op2, created = store.get_or_create("launch", "workflow-a")
    assert created is True
    assert op2.operation_id != op1.operation_id
    assert op2.state == OperationState.WAKING


def test_enabled_but_misconfigured_returns_503(misconfigured_settings):
    """Test that enabled but misconfigured autoscale returns 503."""
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    app = create_app(settings=misconfigured_settings)
    with TestClient(app) as client:
        client.get("/auth/login", follow_redirects=False)  # operator session (WP-E gate)
        response = client.post("/api/workflows/test-workflow/launch", json={"reason": "test"})
        assert response.status_code == 503
        assert "misconfigured" in response.json()["error"].lower()


def test_disabled_autoscale_uses_sync_path(disabled_settings):
    """Test that disabled autoscale uses the existing sync path."""
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    app = create_app(settings=disabled_settings)
    with TestClient(app) as client:
        client.get("/auth/login", follow_redirects=False)  # operator session (WP-E gate)
        with patch("dmf_cms.main.lookup_job_template_by_name") as mock_lookup, \
             patch("dmf_cms.main.launch_job") as mock_launch:

            mock_lookup.return_value = {"id": 123, "name": "test-workflow"}
            mock_launch.return_value = 456

            response = client.post("/api/workflows/test-workflow/launch", json={"reason": "test"})

            # Should return sync response with job_id
            assert response.status_code == 200
            data = response.json()
            assert "job_id" in data
            assert data["job_id"] == 456
            assert data["status"] == "launched"

            # Should NOT create an operation
            assert "operation_id" not in data


def test_concurrent_duplicate_posts_yield_one_operation(enabled_settings):
    """Test that concurrent duplicate POSTs yield exactly one operation."""
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    app = create_app(settings=enabled_settings)
    with TestClient(app) as client:
        client.get("/auth/login", follow_redirects=False)  # operator session (WP-E gate)
        with patch("dmf_cms.main.ensure_awx_awake"), \
             patch("dmf_cms.main.lookup_job_template_by_name") as mock_lookup, \
             patch("dmf_cms.main.launch_job") as mock_launch:

            mock_lookup.return_value = {"id": 123}
            mock_launch.return_value = 456

            # First POST creates operation
            response1 = client.post("/api/workflows/test-workflow/launch", json={"reason": "test"})
            assert response1.status_code == 202
            data1 = response1.json()
            assert "operation_id" in data1
            op_id = data1["operation_id"]

            # Second POST returns existing operation (200, not 202)
            response2 = client.post("/api/workflows/test-workflow/launch", json={"reason": "test"})
            assert response2.status_code == 200
            data2 = response2.json()
            assert data2["operation_id"] == op_id

            # Verify only one task was spawned
            assert len(app.state.operation_tasks) == 1


def test_operation_error_sanitization(enabled_settings):
    """Test that operation errors are sanitized (no raw upstream bodies)."""
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app
    from dmf_cms.awx import AWXAutoscaleError

    app = create_app(settings=enabled_settings)
    with TestClient(app) as client:
        client.get("/auth/login", follow_redirects=False)  # operator session (WP-E gate)
        # Make ensure_awx_awake raise an error with a raw body
        raw_error_body = "Internal server error: database connection failed at db.internal.example:5432"
        with patch("dmf_cms.main.ensure_awx_awake", side_effect=AWXAutoscaleError(500, raw_error_body)):

            # POST to create operation (will fail in background task)
            response = client.post("/api/workflows/test-workflow/launch", json={"reason": "test"})
            assert response.status_code == 202
            op_id = response.json()["operation_id"]

            # Wait for background task to complete
            import time
            for _ in range(50):  # 5 seconds max
                op = app.state.operations.get(op_id)
                if op and op.state == OperationState.ERROR:
                    break
                time.sleep(0.1)

            # Verify operation is in error state
            op = app.state.operations.get(op_id)
            assert op is not None
            assert op.state == OperationState.ERROR

            # Verify error message is sanitized (not the raw body)
            assert op.error == "AWX wake failed"
            assert raw_error_body not in op.error


# --------------------------------------------------------------------------
# #134 — call_with_transient_retry helper
# --------------------------------------------------------------------------

def test_transient_retry_recovers_after_two_5xx():
    fn = MagicMock(side_effect=[AWXAPIError(500, "x"), AWXAPIError(502, "x"), "value"])
    result = call_with_transient_retry(fn, sleep=lambda s: None)
    assert result == "value"
    assert fn.call_count == 3


def test_transient_retry_recovers_after_urlerror():
    fn = MagicMock(side_effect=[urllib.error.URLError("refused"), "value"])
    result = call_with_transient_retry(fn, sleep=lambda s: None)
    assert result == "value"
    assert fn.call_count == 2


def test_transient_retry_does_not_retry_4xx():
    fn = MagicMock(side_effect=AWXAPIError(404, "x"))
    with pytest.raises(AWXAPIError):
        call_with_transient_retry(fn, sleep=lambda s: None)
    assert fn.call_count == 1


def test_transient_retry_exhausts_attempts_and_reraises():
    fn = MagicMock(side_effect=[AWXAPIError(500, "x")] * 3)
    with pytest.raises(AWXAPIError):
        call_with_transient_retry(fn, attempts=3, sleep=lambda s: None)
    assert fn.call_count == 3


# --------------------------------------------------------------------------
# #134 — post-wake transient retry, runner level (deploy/teardown)
# --------------------------------------------------------------------------

def _catalog_entry_134():
    return CatalogEntry(
        key="test-postwake-entry",
        display_name="Test postwake entry",
        summary="Test postwake entry",
        configure={"awx_job_template": "dmf-configure"},
        finalise={"awx_job_template": "dmf-finalise"},
    )


def _wait_for_state(app, op_id, state, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        op = app.state.operations.get(op_id)
        if op and op.state == state:
            return op
        time.sleep(0.1)
    return app.state.operations.get(op_id)


def test_async_deploy_recovers_from_transient_5xx_then_success(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch("dmf_cms.awx.time.sleep"), \
         patch("dmf_cms.main.ensure_awx_awake"), \
         patch("dmf_cms.main.find_active_job_for_template", return_value=None), \
         patch("dmf_cms.main.launch_job", return_value=999), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             # 3rd element: #24's opposite-JT cross-guard lookup (finalise JT),
             # after the own-JT (configure) retry-then-succeed above.
             side_effect=[AWXAPIError(500, "boom"), {"id": 7}, {"id": 8}],
         ):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post(f"/api/catalog/{entry.key}/deploy", json={"reason": "test"})
            assert resp.status_code == 202, resp.text
            op = _wait_for_state(client.app, resp.json()["operation_id"], OperationState.LAUNCHED)

    assert op is not None and op.state == OperationState.LAUNCHED


def test_async_deploy_recovers_from_urlerror_then_success(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch("dmf_cms.awx.time.sleep"), \
         patch("dmf_cms.main.ensure_awx_awake"), \
         patch("dmf_cms.main.find_active_job_for_template", return_value=None), \
         patch("dmf_cms.main.launch_job", return_value=999), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             # 3rd element: #24's opposite-JT cross-guard lookup (finalise JT).
             side_effect=[urllib.error.URLError("reset"), {"id": 7}, {"id": 8}],
         ):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post(f"/api/catalog/{entry.key}/deploy", json={"reason": "test"})
            assert resp.status_code == 202, resp.text
            op = _wait_for_state(client.app, resp.json()["operation_id"], OperationState.LAUNCHED)

    assert op is not None and op.state == OperationState.LAUNCHED


def test_async_teardown_recovers_from_transient_5xx_then_success(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch("dmf_cms.awx.time.sleep"), \
         patch("dmf_cms.main.ensure_awx_awake"), \
         patch("dmf_cms.main.find_active_job_for_template", return_value=None), \
         patch("dmf_cms.main.launch_job", return_value=999), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             # 3rd element: #24's opposite-JT cross-guard lookup (configure JT).
             side_effect=[AWXAPIError(500, "boom"), {"id": 7}, {"id": 8}],
         ):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post(f"/api/catalog/{entry.key}/teardown", json={"reason": "test"})
            assert resp.status_code == 202, resp.text
            op = _wait_for_state(client.app, resp.json()["operation_id"], OperationState.LAUNCHED)

    assert op is not None and op.state == OperationState.LAUNCHED


def test_async_deploy_urlerror_sanitizes_error_field(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    secret_detail = "secret-host-detail"
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch("dmf_cms.awx.time.sleep"), \
         patch("dmf_cms.main.ensure_awx_awake"), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             side_effect=urllib.error.URLError(secret_detail),
         ):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post(f"/api/catalog/{entry.key}/deploy", json={"reason": "test"})
            assert resp.status_code == 202, resp.text
            op = _wait_for_state(client.app, resp.json()["operation_id"], OperationState.ERROR)

    assert op is not None and op.state == OperationState.ERROR
    assert op.error == "AWX unreachable while deploying"
    assert secret_detail not in op.error


# --------------------------------------------------------------------------
# #24 — per-entry lifecycle lock (OperationStore.get_or_create_exclusive)
# --------------------------------------------------------------------------

def test_exclusive_blocks_on_conflicting_active_op():
    store = OperationStore(ttl_seconds=3600)
    deploy_op, _ = store.get_or_create("deploy", "key-a")

    op, created, conflict = store.get_or_create_exclusive(
        "teardown", "key-a", conflicts=("deploy",)
    )

    assert op is None
    assert created is False
    assert conflict is not None and conflict.operation_id == deploy_op.operation_id


def test_exclusive_reattach_unchanged():
    store = OperationStore(ttl_seconds=3600)
    deploy_op, _ = store.get_or_create("deploy", "key-a")

    op, created, conflict = store.get_or_create_exclusive(
        "deploy", "key-a", conflicts=("teardown",)
    )

    assert created is False
    assert conflict is None
    assert op is not None and op.operation_id == deploy_op.operation_id


def test_exclusive_terminal_ops_never_conflict():
    store = OperationStore(ttl_seconds=3600)

    launched = store.create("deploy", "key-launched")
    store.update(launched.operation_id, state=OperationState.LAUNCHED, job_id=1)
    op1, created1, conflict1 = store.get_or_create_exclusive(
        "teardown", "key-launched", conflicts=("deploy",)
    )
    assert created1 is True
    assert conflict1 is None

    errored = store.create("deploy", "key-errored")
    store.update(errored.operation_id, state=OperationState.ERROR, error="boom")
    op2, created2, conflict2 = store.get_or_create_exclusive(
        "teardown", "key-errored", conflicts=("deploy",)
    )
    assert created2 is True
    assert conflict2 is None


# --------------------------------------------------------------------------
# #24 — endpoint-level cross-action 409 (discriminating: 202 on fa78cd6)
# --------------------------------------------------------------------------

def test_async_deploy_409_when_teardown_active(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            client.app.state.operations.get_or_create("teardown", entry.key)
            resp = client.post(f"/api/catalog/{entry.key}/deploy", json={"reason": "test"})

    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "conflicting lifecycle operation in progress"
    assert body["conflicting_operation"]["action"] == "teardown"
    assert body["conflicting_operation"]["target"] == entry.key


def test_async_teardown_409_when_deploy_active(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            client.app.state.operations.get_or_create("deploy", entry.key)
            resp = client.post(f"/api/catalog/{entry.key}/teardown", json={"reason": "test"})

    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "conflicting lifecycle operation in progress"
    assert body["conflicting_operation"]["action"] == "deploy"
    assert body["conflicting_operation"]["target"] == entry.key


def test_async_deploy_conflict_audit_outcome(enabled_settings, caplog):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            client.app.state.operations.get_or_create("teardown", entry.key)
            with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
                resp = client.post(f"/api/catalog/{entry.key}/deploy", json={"reason": "test"})

    assert resp.status_code == 409
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]
    assert any("outcome=conflict-active-operation" in m for m in lines)


# --------------------------------------------------------------------------
# #24 — runner-level cross-JT guard (discriminating: LAUNCHED on fa78cd6)
# --------------------------------------------------------------------------

def test_async_deploy_runner_blocked_by_active_opposite_job(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    launch_mock = MagicMock(return_value=999)
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch("dmf_cms.main.ensure_awx_awake"), \
         patch("dmf_cms.main.launch_job", launch_mock), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             side_effect=[{"id": 7}, {"id": 8}],
         ), \
         patch(
             "dmf_cms.main.find_active_job_for_template",
             side_effect=lambda **k: {7: None, 8: 4321}[k["job_template_id"]],
         ):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post(f"/api/catalog/{entry.key}/deploy", json={"reason": "test"})
            assert resp.status_code == 202, resp.text
            op = _wait_for_state(client.app, resp.json()["operation_id"], OperationState.ERROR)

    assert op is not None and op.state == OperationState.ERROR
    assert op.error == "Conflicting lifecycle operation in progress"
    launch_mock.assert_not_called()


# --------------------------------------------------------------------------
# #24 fix round 1 (codex GATE-24 P1) — generic /api/workflows/{name}/launch
# on a catalog lifecycle JT must resolve to the same per-entry lock, not the
# unlocked "launch" action namespace.
# --------------------------------------------------------------------------

def test_workflow_launch_of_finalise_jt_conflicts_with_active_deploy(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            client.app.state.operations.get_or_create("deploy", entry.key)
            resp = client.post(
                f"/api/workflows/{entry.finalise['awx_job_template']}/launch",
                json={"reason": "test"},
            )

    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "conflicting lifecycle operation in progress"
    assert body["conflicting_operation"]["action"] == "deploy"
    assert body["conflicting_operation"]["target"] == entry.key


def test_workflow_launch_of_configure_jt_conflicts_with_active_teardown(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            client.app.state.operations.get_or_create("teardown", entry.key)
            resp = client.post(
                f"/api/workflows/{entry.configure['awx_job_template']}/launch",
                json={"reason": "test"},
            )

    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "conflicting lifecycle operation in progress"
    assert body["conflicting_operation"]["action"] == "teardown"
    assert body["conflicting_operation"]["target"] == entry.key


def test_workflow_launch_conflict_audit_uses_effective_action(enabled_settings, caplog):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            client.app.state.operations.get_or_create("deploy", entry.key)
            with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
                resp = client.post(
                    f"/api/workflows/{entry.finalise['awx_job_template']}/launch",
                    json={"reason": "test"},
                )

    assert resp.status_code == 409
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]
    # The C5 record must reflect the EFFECTIVE action/target on the catalog
    # entry (deploy vs. teardown), not the generic "launch" wrapper.
    assert any(
        "action=teardown" in m and f"target={entry.key}" in m and "outcome=conflict-active-operation" in m
        for m in lines
    )
    assert not any("action=launch" in m and "outcome=conflict-active-operation" in m for m in lines)


def test_workflow_launch_and_catalog_deploy_share_lock_namespace(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    hold = threading.Event()

    def _blocking_ensure_awake(**kwargs):
        hold.wait(timeout=5)

    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch("dmf_cms.main.ensure_awx_awake", side_effect=_blocking_ensure_awake):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp1 = client.post(
                f"/api/workflows/{entry.configure['awx_job_template']}/launch",
                json={"reason": "test"},
            )
            assert resp1.status_code == 202, resp1.text
            op1 = resp1.json()

            # ensure_awx_awake is still blocked, so the operation dispatched
            # above is still active (WAKING) — the deploy endpoint must
            # reattach to it rather than creating a second one.
            resp2 = client.post(f"/api/catalog/{entry.key}/deploy", json={"reason": "test"})
            hold.set()

    assert op1["action"] == "deploy"
    assert op1["target"] == entry.key
    assert resp2.status_code == 200, resp2.text
    body2 = resp2.json()
    assert body2["operation_id"] == op1["operation_id"]
    assert body2["action"] == "deploy"


def test_workflow_launch_non_catalog_jt_unaffected_by_active_catalog_op(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch("dmf_cms.main.ensure_awx_awake"), \
         patch("dmf_cms.main.lookup_job_template_by_name", return_value=None):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            client.app.state.operations.get_or_create("deploy", entry.key)
            resp = client.post(
                "/api/workflows/some-internal-spike-jt/launch",
                json={"reason": "test"},
            )

    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["action"] == "launch"
    assert body["target"] == "some-internal-spike-jt"


def test_sync_deploy_conflict_active_opposite_job_returns_409(disabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    templates_by_name = {"dmf-configure": {"id": 7}, "dmf-finalise": {"id": 8}}
    active_by_id = {7: None, 8: 4321}
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             side_effect=lambda **k: templates_by_name[k["name"]],
         ), \
         patch(
             "dmf_cms.main.find_active_job_for_template",
             side_effect=lambda **k: active_by_id[k["job_template_id"]],
         ):
        app = create_app(settings=disabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post(f"/api/catalog/{entry.key}/deploy", json={"reason": "test"})

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "conflicting lifecycle operation in progress"


def test_sync_teardown_conflict_active_opposite_job_returns_409(disabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    templates_by_name = {"dmf-configure": {"id": 7}, "dmf-finalise": {"id": 8}}
    active_by_id = {7: 1234, 8: None}
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             side_effect=lambda **k: templates_by_name[k["name"]],
         ), \
         patch(
             "dmf_cms.main.find_active_job_for_template",
             side_effect=lambda **k: active_by_id[k["job_template_id"]],
         ):
        app = create_app(settings=disabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post(f"/api/catalog/{entry.key}/teardown", json={"reason": "test"})

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "conflicting lifecycle operation in progress"


# --------------------------------------------------------------------------
# #24 fix round 2 (codex GATE-24R2 finding 2) — the generic
# /api/workflows/{name}/launch sync path's cross-JT guard was untested;
# these are written against that endpoint, not the catalog routes, so they
# fail if the generic sync guard block is deleted.
# --------------------------------------------------------------------------

def test_workflow_launch_sync_finalise_jt_conflict_active_configure_job(disabled_settings, caplog):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    templates_by_name = {"dmf-configure": {"id": 7}, "dmf-finalise": {"id": 8}}
    active_by_id = {7: 1234, 8: None}
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             side_effect=lambda **k: templates_by_name[k["name"]],
         ), \
         patch(
             "dmf_cms.main.find_active_job_for_template",
             side_effect=lambda **k: active_by_id[k["job_template_id"]],
         ):
        app = create_app(settings=disabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
                resp = client.post(
                    f"/api/workflows/{entry.finalise['awx_job_template']}/launch",
                    json={"reason": "test"},
                )

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "conflicting lifecycle operation in progress"
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]
    assert any(
        "action=teardown" in m and f"target={entry.key}" in m and "outcome=conflict-active-job" in m
        for m in lines
    )


def test_workflow_launch_sync_configure_jt_conflict_active_finalise_job(disabled_settings, caplog):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    templates_by_name = {"dmf-configure": {"id": 7}, "dmf-finalise": {"id": 8}}
    active_by_id = {7: None, 8: 4321}
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             side_effect=lambda **k: templates_by_name[k["name"]],
         ), \
         patch(
             "dmf_cms.main.find_active_job_for_template",
             side_effect=lambda **k: active_by_id[k["job_template_id"]],
         ):
        app = create_app(settings=disabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
                resp = client.post(
                    f"/api/workflows/{entry.configure['awx_job_template']}/launch",
                    json={"reason": "test"},
                )

    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "conflicting lifecycle operation in progress"
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]
    assert any(
        "action=deploy" in m and f"target={entry.key}" in m and "outcome=conflict-active-job" in m
        for m in lines
    )


# --------------------------------------------------------------------------
# #24 fix round 2 (codex GATE-24R2 finding 1) — ambiguous lifecycle JT names
# must fail closed, not silently last-win to the wrong lock namespace.
# --------------------------------------------------------------------------

def _catalog_entries_shared_configure_jt():
    entry_a = CatalogEntry(
        key="entry-a",
        display_name="Entry A",
        summary="Entry A",
        configure={"awx_job_template": "shared-configure-jt"},
        finalise={"awx_job_template": "dmf-finalise-a"},
    )
    entry_b = CatalogEntry(
        key="entry-b",
        display_name="Entry B",
        summary="Entry B",
        configure={"awx_job_template": "shared-configure-jt"},
        finalise={"awx_job_template": "dmf-finalise-b"},
    )
    return [entry_a, entry_b]


def _catalog_entry_same_jt_both_stages():
    return CatalogEntry(
        key="entry-same-jt",
        display_name="Entry same JT",
        summary="Entry same JT",
        configure={"awx_job_template": "same-jt"},
        finalise={"awx_job_template": "same-jt"},
    )


def test_workflow_launch_shared_configure_jt_is_ambiguous_async(enabled_settings, caplog):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entries = _catalog_entries_shared_configure_jt()
    with patch("dmf_cms.main.load_catalog_entries", return_value=entries):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
                resp = client.post(
                    "/api/workflows/shared-configure-jt/launch", json={"reason": "test"}
                )

    assert resp.status_code == 500, resp.text
    assert resp.json()["error"] == "ambiguous catalog lifecycle mapping for this job template"
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]
    assert any(
        "action=launch" in m
        and "target=shared-configure-jt" in m
        and "outcome=ambiguous-lifecycle-jt" in m
        for m in lines
    )


def test_workflow_launch_shared_configure_jt_is_ambiguous_sync(disabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entries = _catalog_entries_shared_configure_jt()
    with patch("dmf_cms.main.load_catalog_entries", return_value=entries), \
         patch("dmf_cms.main.launch_job") as launch_mock:
        app = create_app(settings=disabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post(
                "/api/workflows/shared-configure-jt/launch", json={"reason": "test"}
            )

    assert resp.status_code == 500, resp.text
    assert resp.json()["error"] == "ambiguous catalog lifecycle mapping for this job template"
    launch_mock.assert_not_called()


def test_workflow_launch_same_jt_both_stages_is_ambiguous(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_same_jt_both_stages()
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post("/api/workflows/same-jt/launch", json={"reason": "test"})

    assert resp.status_code == 500, resp.text
    assert resp.json()["error"] == "ambiguous catalog lifecycle mapping for this job template"


def test_workflow_launch_unambiguous_jt_still_maps_alongside_ambiguous(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    clean_entry = _catalog_entry_134()
    entries = _catalog_entries_shared_configure_jt() + [clean_entry]
    with patch("dmf_cms.main.load_catalog_entries", return_value=entries):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)

            resp_ambiguous = client.post(
                "/api/workflows/shared-configure-jt/launch", json={"reason": "test"}
            )
            assert resp_ambiguous.status_code == 500, resp_ambiguous.text

            # The ambiguous entries must not poison the rest of the map: a
            # clean entry's JT still maps normally to its own catalog key.
            client.app.state.operations.get_or_create("teardown", clean_entry.key)
            resp_ok = client.post(
                f"/api/workflows/{clean_entry.configure['awx_job_template']}/launch",
                json={"reason": "test"},
            )

    assert resp_ok.status_code == 409, resp_ok.text
    assert resp_ok.json()["conflicting_operation"]["action"] == "teardown"
    assert resp_ok.json()["conflicting_operation"]["target"] == clean_entry.key


def test_async_teardown_runner_blocked_by_active_opposite_job(enabled_settings):
    from fastapi.testclient import TestClient
    from dmf_cms.main import create_app

    entry = _catalog_entry_134()
    launch_mock = MagicMock(return_value=999)
    with patch("dmf_cms.main.load_catalog_entries", return_value=[entry]), \
         patch("dmf_cms.main.ensure_awx_awake"), \
         patch("dmf_cms.main.launch_job", launch_mock), \
         patch(
             "dmf_cms.main.lookup_job_template_by_name",
             side_effect=[{"id": 8}, {"id": 7}],
         ), \
         patch(
             "dmf_cms.main.find_active_job_for_template",
             side_effect=lambda **k: {7: 1234, 8: None}[k["job_template_id"]],
         ):
        app = create_app(settings=enabled_settings)
        with TestClient(app) as client:
            client.get("/auth/login", follow_redirects=False)
            resp = client.post(f"/api/catalog/{entry.key}/teardown", json={"reason": "test"})
            assert resp.status_code == 202, resp.text
            op = _wait_for_state(client.app, resp.json()["operation_id"], OperationState.ERROR)

    assert op is not None and op.state == OperationState.ERROR
    assert op.error == "Conflicting lifecycle operation in progress"
    launch_mock.assert_not_called()
