"""dmfdeploy#319: a stale or degraded inventory read licenses no write.

Every mutating catalog and media-workloads route refuses with a 409 while this
process's own inventory read state is stale (a last-good inventory is being
served inside the grace window) or degraded (past the window, or never read
successfully), and works again once a read succeeds. The read state is seeded
through the real read path, so the tests fail if the route stops asking.
"""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from dmf_cms import media_workloads as mw
from dmf_cms import netbox as netbox_module
from dmf_cms.main import create_app
from dmf_cms.settings import (
    AWXAutoscaleSettings,
    AWXSettings,
    MediaTenancySettings,
    NetboxSettings,
    PrometheusSettings,
    Settings,
)

# Operator for the role-gated routes, engineer for the media-engineers gate.
OPERATOR = ("dmf-console-operator", "dmf-console-engineer")
NETBOX = "http://netbox.test"
STALE = "inventory-stale"
DEGRADED = "inventory-degraded"

SERVICE = {
    "id": 1,
    "name": "mxl-vm",
    "tags": [{"name": "dmf-catalog"}, {"name": "app:mxl-videotestsrc"}, {"name": "workload:demo"}],
    "device": {"name": "node-1"},
    "ports": [9000],
    "protocol": {"value": "tcp"},
    "custom_fields": {},
}

# (label, path, body). Each body gets a reason; purge also needs its typed confirmation.
ROUTES = [
    ("deploy", "/api/catalog/none/deploy", {}),
    ("teardown", "/api/catalog/none/teardown", {}),
    ("clear", "/api/media-workloads/inst-1/clear", {}),
    ("purge", "/api/media-workloads/studio-a/purge", {"confirm": "studio-a"}),
    ("switch-source", "/api/media-workloads/inst-1/switch-source", {"source_instance": "src-1"}),
]
ROUTE_IDS = [r[0] for r in ROUTES]


class Source:
    def __init__(self, monkeypatch) -> None:
        self.fail = False
        self.calls = 0
        self.gate: threading.Event | None = None
        monkeypatch.setattr(mw, "_fetch_services", self)
        monkeypatch.setattr(mw, "_observed_by_identity", lambda url: {})

    def __call__(self, *args, **kwargs):
        self.calls += 1
        if self.gate is not None:
            self.gate.wait(10)
        if self.fail:
            raise netbox_module.NetboxAPIError(504, "starved")
        return [dict(SERVICE)]


@pytest.fixture
def source(monkeypatch):
    return Source(monkeypatch)


def _read(kind, mono=time.monotonic):
    fn = mw.list_instances if kind == "flat" else mw.list_workloads_grouped
    return fn(NETBOX, "tok", False, None, catalog_dir="/nonexistent-catalog", monotonic=mono)


def _go_stale(source, kind="flat"):
    _read(kind)
    source.fail = True
    payload = _read(kind)
    assert payload["stale"] is True


def _go_degraded(source, kind="flat"):
    # The last success is older than the grace window, then a read fails.
    _read(kind, mono=lambda: time.monotonic() - mw.READ_GRACE_SECONDS - 60)
    source.fail = True
    payload = _read(kind)
    assert payload["degraded"] is True and payload["stale"] is False


def _client() -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=OPERATOR,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(enabled=False),
        netbox=NetboxSettings(api_url=NETBOX, api_token="tok", writer_token="w"),
        media_tenancy=MediaTenancySettings(mode="single"),
        prometheus=PrometheusSettings(url="http://prom.test"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def _write(client, path, extra):
    return client.post(path, json={"reason": "scheduled change", **extra})


@pytest.mark.parametrize("label,path,extra", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("kind", ["flat", "grouped"])
def test_write_refused_while_inventory_is_stale(source, label, path, extra, kind):
    _go_stale(source, kind)
    resp = _write(_client(), path, extra)
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"] == STALE
    assert body["request_id"]
    assert "No change was sent" in body["detail"]


@pytest.mark.parametrize("label,path,extra", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("kind", ["flat", "grouped"])
def test_write_refused_while_inventory_is_degraded_after_a_success(source, label, path, extra, kind):
    _go_degraded(source, kind)
    resp = _write(_client(), path, extra)
    assert resp.status_code == 409
    assert resp.json()["error"] == DEGRADED


@pytest.mark.parametrize("label,path,extra", ROUTES, ids=ROUTE_IDS)
def test_write_refused_while_inventory_never_read_successfully(source, label, path, extra):
    source.fail = True
    assert _read("flat")["degraded"] is True
    resp = _write(_client(), path, extra)
    assert resp.status_code == 409
    assert resp.json()["error"] == DEGRADED


@pytest.mark.parametrize("label,path,extra", ROUTES, ids=ROUTE_IDS)
def test_write_not_refused_by_the_guard_when_inventory_is_fresh(source, label, path, extra):
    _read("flat")
    resp = _write(_client(), path, extra)
    assert resp.json().get("error") not in (STALE, DEGRADED)


@pytest.mark.parametrize("label,path,extra", ROUTES, ids=ROUTE_IDS)
def test_cold_process_with_netbox_failing_refuses_the_write(source, label, path, extra):
    """No read state yet: the guard reads first, and a failed read refuses."""
    source.fail = True
    resp = _write(_client(), path, extra)
    assert resp.status_code == 409
    assert resp.json()["error"] == DEGRADED
    assert source.calls >= 1


@pytest.mark.parametrize("label,path,extra", ROUTES, ids=ROUTE_IDS)
def test_cold_process_with_netbox_healthy_lets_the_write_proceed_and_records_the_read(
    source, label, path, extra
):
    resp = _write(_client(), path, extra)
    assert resp.json().get("error") not in (STALE, DEGRADED)
    assert source.calls >= 1
    assert mw.inventory_write_block(NETBOX, None, require_read=True) is None
    # The recorded read is a real snapshot: a later failure serves it as stale.
    source.fail = True
    assert _read("grouped")["stale"] is True


def test_cold_read_that_raises_before_recording_refuses(source, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("catalog unreadable")

    monkeypatch.setattr(mw, "list_workloads_grouped", boom)
    resp = _write(_client(), "/api/catalog/none/deploy", {})
    assert resp.status_code == 409
    assert resp.json()["error"] == DEGRADED


def test_cold_read_that_times_out_refuses(source, monkeypatch):
    monkeypatch.setattr(mw, "COLD_READ_TIMEOUT_SECONDS", 0.2)
    source.gate = threading.Event()
    try:
        started = time.monotonic()
        resp = _write(_client(), "/api/catalog/none/deploy", {})
        assert time.monotonic() - started < 5
    finally:
        source.gate.set()
    assert resp.status_code == 409
    assert resp.json()["error"] == DEGRADED


def test_a_warm_scope_is_not_read_again_by_the_guard(source):
    _read("flat")
    calls = source.calls
    client = _client()
    _write(client, "/api/catalog/none/deploy", {})
    _write(client, "/api/catalog/none/teardown", {})
    assert source.calls == calls


def test_concurrent_cold_writes_share_one_read_and_record_one_state(source):
    """Eight cold writers: the first reads, the rest wait for that read."""
    source.gate = threading.Event()
    results: list[str | None] = []
    lock = threading.Lock()

    def read():
        mw.list_workloads_grouped(
            NETBOX, "tok", False, None, catalog_dir="/nonexistent-catalog"
        )

    def writer():
        mw.ensure_inventory_read(NETBOX, None, read, timeout=10)
        code = mw.inventory_write_block(NETBOX, None, require_read=True)
        with lock:
            results.append(code)

    threads = [threading.Thread(target=writer) for _ in range(8)]
    for t in threads:
        t.start()
    deadline = time.monotonic() + 5
    while source.calls < 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    time.sleep(0.2)  # the other seven reach the wait while the read is held
    source.gate.set()
    for t in threads:
        t.join(10)
    assert source.calls == 1
    assert results == [None] * 8
    state = mw._read_states[mw._read_key("grouped", NETBOX, None)]
    assert state.success_ticket > 0
    assert state.failure_since is None


def test_cold_read_failure_is_recorded_once_for_concurrent_writers(source):
    source.fail = True
    source.gate = threading.Event()
    results: list[str | None] = []
    lock = threading.Lock()

    def read():
        mw.list_workloads_grouped(
            NETBOX, "tok", False, None, catalog_dir="/nonexistent-catalog"
        )

    def writer():
        mw.ensure_inventory_read(NETBOX, None, read, timeout=10)
        code = mw.inventory_write_block(NETBOX, None, require_read=True)
        with lock:
            results.append(code)

    threads = [threading.Thread(target=writer) for _ in range(4)]
    for t in threads:
        t.start()
    time.sleep(0.3)
    source.gate.set()
    for t in threads:
        t.join(10)
    assert source.calls == 1
    assert results == [DEGRADED] * 4


@pytest.mark.parametrize("label,path,extra", ROUTES, ids=ROUTE_IDS)
def test_a_successful_read_lifts_the_refusal(source, label, path, extra):
    _go_stale(source)
    client = _client()
    assert _write(client, path, extra).status_code == 409
    source.fail = False
    assert _read("flat")["stale"] is False
    assert _write(client, path, extra).json().get("error") not in (STALE, DEGRADED)


def test_either_inventory_read_failing_blocks_the_write(source):
    """The grouped read is stale although the flat read last succeeded."""
    _read("flat")
    _go_stale(source, "grouped")
    assert mw.inventory_write_block(NETBOX, None) == STALE


def test_refusal_is_audited_for_deploy_and_teardown(source, caplog):
    _go_stale(source)
    client = _client()
    with caplog.at_level("INFO"):
        _write(client, "/api/catalog/none/deploy", {})
        _write(client, "/api/catalog/none/teardown", {})
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]
    assert any("action=deploy" in l and "outcome=inventory-unconfirmed" in l for l in lines)
    assert any("action=teardown" in l and "outcome=inventory-unconfirmed" in l for l in lines)


def test_a_failure_in_another_scope_does_not_block_this_scope(source):
    _go_stale(source)
    assert mw.inventory_write_block(NETBOX, None) == STALE
    assert mw.inventory_write_block(NETBOX, ("tenant-b",)) is None
    assert mw.inventory_write_block("http://other-netbox.test", None) is None


def test_stale_turns_degraded_when_the_window_passes(source):
    _go_stale(source)
    later = lambda: time.monotonic() + mw.READ_GRACE_SECONDS + 1
    assert mw.inventory_write_block(NETBOX, None) == STALE
    assert mw.inventory_write_block(NETBOX, None, monotonic=later) == DEGRADED
