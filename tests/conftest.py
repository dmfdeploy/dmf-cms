import pytest

from dmf_cms import media_workloads


def _reset() -> None:
    reset = getattr(media_workloads, "_reset_read_grace", None)
    if reset is not None:
        reset()


@pytest.fixture(autouse=True)
def _fresh_media_workloads_read_grace():
    """The last-good inventory cache is process-wide; keep tests independent."""
    _reset()
    yield
    _reset()


@pytest.fixture
def inventory_already_read(monkeypatch):
    """For tests of what a write does after the inventory guard passes.

    The guard reads the inventory first when this process has never read the
    caller's scope. These tests stub the routes' own NetBox calls, not that
    read, so this fixture records a successful read for the scope instead.
    The guard's own behaviour is tested in test_inventory_write_guard.py.
    """

    def seed(netbox_url, tenant_slugs, read, timeout=0):
        key = media_workloads._read_key("grouped", netbox_url, tenant_slugs)
        ticket, started, started_mono = media_workloads._begin_read(
            media_workloads.time.time, media_workloads.time.monotonic
        )
        media_workloads._remember_success(
            key,
            {"degraded": False, "workloads": [], "invalid_instances": []},
            ticket, started, started_mono, media_workloads.time.monotonic,
        )

    monkeypatch.setattr(media_workloads, "ensure_inventory_read", seed)
