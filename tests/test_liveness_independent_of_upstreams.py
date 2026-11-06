"""Liveness must not depend on NetBox (dmfdeploy/dmfdeploy#845).

A NetBox stall once failed the console's liveness probe and got the container
restarted. These tests hold NetBox open without answering and check that the
event loop still serves ``/healthz`` promptly, and that NetBox reads give up
inside the probe window.
"""

import asyncio
import socket
import threading
import time
import urllib.request

import httpx
import pytest

from dmf_cms import netbox
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.operations import OperationStore
from dmf_cms.settings import NetboxSettings, Settings

# Kubelet fails the pod after 3 probes 20 s apart (charts/dmf-cms deployment).
LIVENESS_WINDOW_SECONDS = 60
HEALTHZ_BUDGET_SECONDS = 1.0


@pytest.fixture
def silent_netbox():
    """A TCP listener that accepts connections and never replies."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(16)
    held = []
    stop = threading.Event()

    def accept():
        server.settimeout(0.1)
        while not stop.is_set():
            try:
                held.append(server.accept()[0])
            except OSError:
                continue

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.getsockname()[1]}"
    stop.set()
    thread.join()
    for conn in held:
        conn.close()
    server.close()


def test_netbox_timeout_is_well_inside_the_liveness_window():
    assert netbox.READ_TIMEOUT_SECONDS * 2 <= LIVENESS_WINDOW_SECONDS


@pytest.mark.parametrize("method", ["PATCH", "POST", "PUT", "DELETE"])
def test_writes_keep_the_longer_budget(method):
    assert netbox.request_timeout(method) == netbox.WRITE_TIMEOUT_SECONDS == 30
    assert netbox.request_timeout("GET") == netbox.READ_TIMEOUT_SECONDS


def test_a_patch_that_answers_after_the_read_budget_still_succeeds(monkeypatch):
    """The reply arrives after the read budget but inside the write budget."""
    import http.server

    class Slow(http.server.BaseHTTPRequestHandler):
        def do_PATCH(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            time.sleep(1.5)
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Scaled down: 1 s read budget, 4 s write budget, 1.5 s reply.
    monkeypatch.setattr(netbox, "READ_TIMEOUT_SECONDS", 1)
    monkeypatch.setattr(netbox, "WRITE_TIMEOUT_SECONDS", 4)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        assert netbox._request(base, "t", "/api/ipam/services/1/", method="PATCH", payload={"a": 1}) == {"ok": True}
    finally:
        server.shutdown()
        thread.join()


def test_netbox_requests_use_the_bounded_timeout(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout=None, context=None):
        seen["timeout"] = timeout
        raise OSError("stop")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(OSError):
        netbox._request("http://nb.invalid", "t", "/api/status/")
    assert seen["timeout"] == netbox.READ_TIMEOUT_SECONDS


@pytest.mark.parametrize("path", ["/api/catalog", "/api/catalog/entries"])
def test_healthz_stays_fast_while_a_catalog_read_hangs_on_netbox(monkeypatch, silent_netbox, path):
    entry = CatalogEntry(
        key="mxl-videotest-view",
        display_name="MXL",
        summary="s",
        provision={"netbox_service": {"name": "mxl-videotest-view"}},
    )
    monkeypatch.setattr("dmf_cms.main.load_catalog_entries", lambda: [entry])
    # Short enough to keep the suite quick, longer than the healthz budget.
    monkeypatch.setattr(netbox, "READ_TIMEOUT_SECONDS", 3, raising=False)
    settings = Settings(netbox=NetboxSettings(api_url=silent_netbox, api_token="t"))
    app = create_app(settings=settings)

    async def scenario() -> float:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://console") as client:
            await client.get("/auth/login", follow_redirects=False)
            slow = asyncio.create_task(client.get(path))
            # The clock starts before the sleep: a blocked loop delays the
            # wake-up itself, not only the request that follows it.
            started = time.monotonic()
            await asyncio.sleep(0.3)  # let the NetBox read start and hang
            health = await client.get("/healthz")
            elapsed = time.monotonic() - started - 0.3
            assert health.status_code == 200
            await slow
            return elapsed

    assert asyncio.run(scenario()) < HEALTHZ_BUDGET_SECONDS


def test_admin_health_pings_run_off_the_loop_and_side_by_side(monkeypatch):
    """Four pings that each hang 1.5 s must not delay /healthz, and one admin
    request must cost about one ping, not four."""
    from dmf_cms import prometheus
    from dmf_cms.settings import AuthentikSettings, AWXSettings, PrometheusSettings

    def hang(*args, **kwargs):
        time.sleep(1.5)
        return []

    monkeypatch.setattr("dmf_cms.main.list_users", hang)
    monkeypatch.setattr("dmf_cms.main.list_job_templates", hang)
    monkeypatch.setattr(netbox, "ping", hang)
    monkeypatch.setattr(prometheus, "ping", hang)
    settings = Settings(
        dev_groups=("dmf-console-admin",),
        authentik=AuthentikSettings(api_url="http://a.invalid", api_token="t"),
        awx=AWXSettings(api_url="http://b.invalid", api_token="t"),
        netbox=NetboxSettings(api_url="http://c.invalid", api_token="t"),
        prometheus=PrometheusSettings(url="http://d.invalid"),
    )
    app = create_app(settings=settings)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://console") as client:
            await client.get("/auth/login", follow_redirects=False)
            started = time.monotonic()
            admin = asyncio.create_task(client.get("/api/admin/health"))
            await asyncio.sleep(0.3)
            health = await client.get("/healthz")
            health_delay = time.monotonic() - started - 0.3
            response = await admin
            return health.status_code, health_delay, response.status_code, time.monotonic() - started

    health_status, health_delay, admin_status, admin_total = asyncio.run(scenario())
    assert health_status == 200 and admin_status == 200
    assert health_delay < HEALTHZ_BUDGET_SECONDS
    assert admin_total < 3.0  # four sequential pings would take 6 s


@pytest.mark.parametrize(
    ("path", "patch_target"),
    [
        ("/api/admin/users", "dmf_cms.main.list_users"),
        ("/api/admin/groups", "dmf_cms.main.list_groups"),
        ("/api/admin/jobs", "dmf_cms.main.list_recent_jobs"),
        ("/api/workflows", "dmf_cms.main.list_job_templates"),
        ("/api/changes/jobs", "dmf_cms.main.list_recent_jobs"),
    ],
)
def test_offloaded_routes_never_block_healthz(monkeypatch, path, patch_target):
    """A blocking upstream call in an async handler stalls /healthz for as long
    as it blocks; moving any of these back onto the loop fails this test."""
    from dmf_cms.settings import AuthentikSettings, AWXSettings

    def hang(*args, **kwargs):
        time.sleep(1.0)
        return []

    monkeypatch.setattr(patch_target, hang)
    settings = Settings(
        dev_groups=("dmf-console-admin",),
        authentik=AuthentikSettings(api_url="http://a.invalid", api_token="t"),
        awx=AWXSettings(api_url="http://b.invalid", api_token="t"),
    )
    app = create_app(settings=settings)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://console") as client:
            await client.get("/auth/login", follow_redirects=False)
            started = time.monotonic()
            slow = asyncio.create_task(client.get(path))
            await asyncio.sleep(0.2)  # a blocked loop delays this wake-up too
            health = await client.get("/healthz")
            delay = time.monotonic() - started - 0.2
            response = await slow
            return health.status_code, delay, response.status_code

    status, delay, route_status = asyncio.run(scenario())
    assert status == 200
    assert delay < 0.5
    assert route_status != 404  # the route exists and was reached


_REATTACH_RUN_ID = "a" * 32


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/catalog/reattach-entry/deploy", {"reason": "reattach"}),
        ("/api/catalog/reattach-entry/teardown", {"reason": "reattach"}),
        (f"/api/runs/{_REATTACH_RUN_ID}/rollback", {"reason": "reattach"}),
    ],
)
def test_already_active_reattach_never_blocks_healthz(monkeypatch, path, body):
    """When AWX already runs the job, the route reads that job's detail to
    learn its identity. That read must go off the loop: AWX stalling after the
    active-job lookup succeeded must not stall /healthz."""
    from dmf_cms.settings import AWXAutoscaleSettings, AWXSettings, L3Settings

    entry = CatalogEntry(
        key="reattach-entry",
        display_name="Reattach entry",
        summary="Reattach entry",
        configure={"awx_job_template": "dmf-configure"},
        finalise={"awx_job_template": "dmf-finalise"},
    )

    def hang(*args, **kwargs):
        time.sleep(1.0)
        return {
            "id": 555,
            "status": "running",
            "extra_vars": f'{{"l3_run_id": "{_REATTACH_RUN_ID}"}}',
        }

    monkeypatch.setattr("dmf_cms.main.load_catalog_entries", lambda *a, **k: [entry])
    monkeypatch.setattr("dmf_cms.main.lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr("dmf_cms.main.find_active_job_for_template", lambda **k: 555)
    monkeypatch.setattr("dmf_cms.main.get_job", hang)
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=("dmf-console-operator",),
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(enabled=False),
        l3=L3Settings(enabled=False, rollback_jt_name="media-rollback-run"),
    )
    app = create_app(settings=settings)
    # The reattach branch only runs when an operations store exists, and the
    # lifespan that creates it does not run under ASGITransport.
    app.state.operations = OperationStore(ttl_seconds=3600)
    app.state.operation_tasks = set()

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://console") as client:
            await client.get("/auth/login", follow_redirects=False)
            started = time.monotonic()
            slow = asyncio.create_task(client.post(path, json=body))
            await asyncio.sleep(0.2)  # a blocked loop delays this wake-up too
            health = await client.get("/healthz")
            delay = time.monotonic() - started - 0.2
            response = await slow
            return health.status_code, delay, response.status_code

    status, delay, route_status = asyncio.run(scenario())
    assert status == 200
    assert delay < 0.5
    assert route_status == 200  # reached the already-active reattach branch
    assert app.state.operations.list_all()  # ...and tracked the running job
