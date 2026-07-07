"""Tests for WS5 autoscale operation tracking."""

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from dmf_cms.operations import OperationState, OperationStore
from dmf_cms.settings import Settings, load_settings


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
        )
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
        awx_autoscale=AWXAutoscaleSettings(enabled=False)
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
        )
    )
    return settings


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
