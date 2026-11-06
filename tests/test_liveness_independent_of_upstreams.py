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
    assert netbox.REQUEST_TIMEOUT_SECONDS * 2 <= LIVENESS_WINDOW_SECONDS


def test_netbox_requests_use_the_bounded_timeout(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout=None, context=None):
        seen["timeout"] = timeout
        raise OSError("stop")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(OSError):
        netbox._request("http://nb.invalid", "t", "/api/status/")
    assert seen["timeout"] == netbox.REQUEST_TIMEOUT_SECONDS


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
    monkeypatch.setattr(netbox, "REQUEST_TIMEOUT_SECONDS", 3, raising=False)
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
