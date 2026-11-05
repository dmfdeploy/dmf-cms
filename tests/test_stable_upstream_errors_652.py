"""Remaining pollers and health probes answer with stable errors (#652).

Follows #292 (AWX asleep) and #430 (upstream bodies stay in the log). Two
groups: the job pollers must degrade with the ``/api/changes/jobs`` reason
vocabulary instead of raising on an AWX that never answered, and the
Authentik, NetBox and Prometheus probes must not return an upstream body.

Every test drives the real client modules and fakes only
``urllib.request.urlopen``. Injecting an exception into a client function
would skip the wrapping and decoding the clients do, which is where the
defects were.
"""

from __future__ import annotations

import io
import urllib.error
import urllib.parse
import urllib.request

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
from dmf_cms import netbox, prometheus
from dmf_cms.authentik import AuthentikAPIError
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import (
    AuthentikSettings,
    AWXAutoscaleSettings,
    AWXSettings,
    NetboxSettings,
    PrometheusSettings,
    Settings,
)

SENTINEL = "SENTINEL-652-upstream-body"
# Not valid UTF-8, and carries a newline that would forge a second log line.
RAW_BODY = b"bad-\xff-body " + SENTINEL.encode() + b"\nFORGED-LOG-LINE"
ESCAPED_IN_LOG = SENTINEL + "\\nFORGED-LOG-LINE"
ADMIN = ("dmf-console-admin",)

HEALTHY = {
    "awx.test": b'{"results": []}',
    "idp.test": b'{"results": []}',
    "netbox.test": b"{}",
    # The real endpoint answers in plain text, not JSON.
    "prom.test": b"Prometheus Server is Healthy.\n",
}

POLLERS = [
    pytest.param("/api/workflows/jobs/7", id="workflow-job"),
    pytest.param("/api/catalog/mxl-videotest-view/status/7", id="catalog-job"),
]


class _Resp:
    def __init__(self, data: bytes = b"", read_error: BaseException | None = None) -> None:
        self._data = data
        self._read_error = read_error

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self, *_a):
        if self._read_error is not None:
            raise self._read_error
        return self._data


def _http_error(req, code: int, body: bytes) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(req.full_url, code, "err", {}, io.BytesIO(body))


def _fake_urlopen(monkeypatch, **per_host):
    """Fake the transport. ``per_host`` maps a host to an exception, an int
    status (answered with RAW_BODY), or ``("read", exc)`` for a drop while
    reading the body. Hosts not named answer healthily."""

    def urlopen(req, *_a, **_k):
        host = urllib.parse.urlsplit(req.full_url).hostname
        mode = per_host.get(host)
        if isinstance(mode, int):
            raise _http_error(req, mode, RAW_BODY)
        if isinstance(mode, BaseException):
            raise mode
        if isinstance(mode, tuple):
            return _Resp(read_error=mode[1])
        if "/api/v2/jobs/" in req.full_url:
            return _Resp(b'{"id": 7, "status": "running"}')
        return _Resp(HEALTHY[host])

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)


def _client() -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=ADMIN,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(
            enabled=True, helper_url="http://helper.test", bearer_token="b"
        ),
        authentik=AuthentikSettings(api_url="http://idp.test", api_token="t"),
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="t"),
        prometheus=PrometheusSettings(url="http://prom.test"),
    )
    # raise_server_exceptions=True (default): an escaped exception fails the test.
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


@pytest.fixture(autouse=True)
def _catalog(monkeypatch):
    entry = CatalogEntry(key="mxl-videotest-view", display_name="MXL video test view", summary="")
    monkeypatch.setattr(main, "load_catalog_entries", lambda *a, **k: [entry])


def _assert_logged_sanitised(caplog) -> None:
    assert ESCAPED_IN_LOG in caplog.text
    # The raw newline must not start a second log line.
    assert not any(line.startswith("FORGED-LOG-LINE") for line in caplog.text.splitlines())


AWX_FAILURES = [
    pytest.param(
        urllib.error.URLError(ConnectionRefusedError(111, "refused")),
        "awx-not-running",
        id="refused",
    ),
    pytest.param(urllib.error.URLError("name resolution"), "awx-unreachable", id="unreachable"),
    pytest.param(TimeoutError("timed out"), "awx-unreachable", id="connect-timeout"),
    pytest.param(("read", TimeoutError("read timed out")), "awx-unreachable", id="read-timeout"),
    pytest.param(("read", ConnectionResetError(104, "reset")), "awx-unreachable", id="read-reset"),
]


@pytest.mark.parametrize("path", POLLERS)
@pytest.mark.parametrize("failure,reason", AWX_FAILURES)
def test_job_poller_degrades_when_awx_does_not_answer(monkeypatch, path, failure, reason):
    _fake_urlopen(monkeypatch, **{"awx.test": failure})
    resp = _client().get(path)
    assert resp.status_code == 503
    body = resp.json()
    assert body["reason"] == reason
    assert body["error"]
    # An unread status is never a finished job.
    assert body.get("is_done") is not True


@pytest.mark.parametrize("path", POLLERS)
def test_job_poller_still_reports_a_running_job(monkeypatch, path):
    _fake_urlopen(monkeypatch)
    resp = _client().get(path)
    assert resp.status_code == 200
    assert resp.json()["status"] == "running"


def test_workflow_poller_http_error_omits_upstream_body(monkeypatch, caplog):
    _fake_urlopen(monkeypatch, **{"awx.test": 502})
    resp = _client().get("/api/workflows/jobs/7")
    assert resp.status_code == 502
    assert SENTINEL not in resp.text
    _assert_logged_sanitised(caplog)


def test_health_authentik_http_error_omits_upstream_body(monkeypatch, caplog):
    _fake_urlopen(monkeypatch, **{"idp.test": 502})
    resp = _client().get("/api/admin/health")
    assert resp.status_code == 200
    assert SENTINEL not in resp.text
    assert resp.json()["authentik"] == {"connected": False, "error": "Authentik API 502"}
    _assert_logged_sanitised(caplog)


def test_health_netbox_http_error_omits_upstream_body(monkeypatch, caplog):
    _fake_urlopen(monkeypatch, **{"netbox.test": 500})
    resp = _client().get("/api/admin/health")
    assert resp.status_code == 200
    assert SENTINEL not in resp.text
    assert resp.json()["netbox"] == {"connected": False, "error": "NetBox API 500"}
    _assert_logged_sanitised(caplog)


def test_health_prometheus_http_error_reports_not_connected(monkeypatch, caplog):
    _fake_urlopen(monkeypatch, **{"prom.test": 503})
    resp = _client().get("/api/admin/health")
    assert resp.status_code == 200
    assert SENTINEL not in resp.text
    assert resp.json()["prometheus"] == {"connected": False, "error": "Prometheus API 503"}
    _assert_logged_sanitised(caplog)


TRANSPORT_FAILURES = [
    pytest.param(urllib.error.URLError(ConnectionRefusedError(111, "refused")), id="refused"),
    pytest.param(TimeoutError("timed out"), id="timeout"),
    pytest.param(("read", TimeoutError("read timed out")), id="read-timeout"),
]


@pytest.mark.parametrize("failure", TRANSPORT_FAILURES)
@pytest.mark.parametrize(
    "host,key,message",
    [
        ("idp.test", "authentik", "Authentik is unreachable"),
        ("netbox.test", "netbox", "NetBox is unreachable"),
        ("prom.test", "prometheus", "Prometheus is unreachable"),
    ],
)
def test_health_probe_transport_failure_is_contained(monkeypatch, failure, host, key, message):
    _fake_urlopen(monkeypatch, **{host: failure})
    resp = _client().get("/api/admin/health")
    # One dependency down must not take the other probes with it.
    assert resp.status_code == 200
    body = resp.json()
    assert body[key] == {"connected": False, "error": message}
    assert all(body[other]["connected"] for other in ("authentik", "awx", "netbox", "prometheus") if other != key)


def test_health_prometheus_plain_text_health_is_connected(monkeypatch):
    _fake_urlopen(monkeypatch)
    resp = _client().get("/api/admin/health")
    assert resp.json()["prometheus"]["connected"] is True


@pytest.mark.parametrize(
    "path,api_path",
    [
        ("/api/monitoring/alerts", "/api/v1/alerts"),
        ("/api/monitoring/targets", "/api/v1/targets"),
        ("/api/monitoring/metrics", "/api/v1/query"),
    ],
)
def test_monitoring_endpoints_omit_upstream_body(monkeypatch, caplog, path, api_path):
    _fake_urlopen(monkeypatch, **{"prom.test": 500})
    resp = _client().get(path)
    assert resp.status_code == 500
    assert SENTINEL not in resp.text
    _assert_logged_sanitised(caplog)
