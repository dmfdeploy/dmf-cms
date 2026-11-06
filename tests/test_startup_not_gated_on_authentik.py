"""Startup must not wait for Authentik (dmfdeploy/dmfdeploy#845).

Group seeding is best-effort. With an Authentik that accepts connections and
never answers, the app still has to serve /healthz within seconds, or the
liveness probe restarts the pod before it ever comes up.
"""

import socket
import threading
import time

import pytest
from fastapi.testclient import TestClient

from dmf_cms.main import create_app
from dmf_cms.settings import AuthentikSettings, Settings


@pytest.fixture
def silent_authentik():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(16)
    held, stop = [], threading.Event()

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


def test_healthz_answers_while_group_seeding_hangs(silent_authentik):
    settings = Settings(authentik=AuthentikSettings(api_url=silent_authentik, api_token="t"))
    app = create_app(settings=settings)

    started = time.monotonic()
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200
        elapsed = time.monotonic() - started
    assert elapsed < 1.5
