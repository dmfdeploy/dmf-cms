"""Per-instance MXL live-view endpoints (WP-D / G26).

``GET /api/media-workloads/{instance}/mxl/status`` and ``/mxl/preview`` sit
inside the Media Workloads surface (ADR-0037 §5 gate) and proxy an instance's
in-cluster status sidecar. The whole point is the SSRF boundary: coords come
from NetBox custom fields, but the console only ever fetches an allowlisted,
DNS-validated, identity-checked in-cluster URL — and never leaks the coords.
"""

import json
import urllib.error

import pytest
from fastapi.testclient import TestClient

from dmf_cms import mxl
from dmf_cms import netbox as netbox_module
from dmf_cms.main import create_app
from dmf_cms.settings import MediaTenancySettings, NetboxSettings, Settings

MEDIA_ENGINEERS = ("media-engineers",)
OPERATOR = ("dmf-console-operator",)

STATUS_JSON = json.dumps(
    {
        "node": "node-a",
        "provider": "aliyun",
        "role": "receiver",
        "mxl_version": "1.2.3",
        "preview": True,
        "flow": {
            "id": "f1",
            "head_index": 42,
            "latency_ms": 3,
            "latency_grains": 1,
            "active": True,
            "format": "Video",
            "grain_rate": "50/1",
        },
    }
).encode()

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 128


def _service(name: str, custom_fields: dict | None) -> dict:
    svc = {
        "id": 1,
        "name": name,
        "tags": [{"name": "dmf-catalog"}, {"name": f"app:{name}"}, {"name": "lifecycle:active"}],
        "device": {"name": "node-1"},
        "ports": [9000],
    }
    if custom_fields is not None:
        svc["custom_fields"] = custom_fields
    return svc


GOOD_COORDS = {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl", "cluster_port": 9000}


def _client(groups=MEDIA_ENGINEERS, tenancy=None):
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="tok"),
        media_tenancy=tenancy or MediaTenancySettings(mode="single"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)  # dev login -> session
    return client


def _patch_netbox(monkeypatch, services, counter=None):
    def fake_request(api_url, api_token, path, ssl_context=None, **kwargs):
        if counter is not None:
            counter["n"] += 1
        return {"results": services}

    monkeypatch.setattr(netbox_module, "_request", fake_request)


class _Resp:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self, n: int = -1) -> bytes:
        return self._body if (n is None or n < 0) else self._body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _patch_sidecar(monkeypatch, *, status_body=None, preview_body=None, capture=None):
    def fake_urlopen(req, timeout=None):
        url = req.full_url
        if capture is not None:
            capture.append(url)
        if url.endswith("/status"):
            if status_body is None:
                raise urllib.error.URLError("unreachable")
            return _Resp(status_body)
        if url.endswith("/preview.jpg"):
            if preview_body is None:
                raise urllib.error.URLError("unreachable")
            return _Resp(preview_body)
        raise AssertionError(f"unexpected sidecar URL: {url}")

    monkeypatch.setattr(mxl.urllib.request, "urlopen", fake_urlopen)


# --- gate -------------------------------------------------------------------

def test_status_shares_media_workloads_gate():
    below = _client(groups=OPERATOR)
    assert below.get("/api/media-workloads/mxl-videotestsrc/mxl/status").status_code == 403
    assert below.get("/api/media-workloads/mxl-videotestsrc/mxl/preview").status_code == 403


def test_status_anonymous_is_401():
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="tok"),
        media_tenancy=MediaTenancySettings(mode="single"),
    )
    client = TestClient(create_app(settings=settings))
    assert client.get("/api/media-workloads/x/mxl/status").status_code == 401


# --- status: happy path + no leak ------------------------------------------

def test_status_ok_shapes_flow_and_leaks_no_coords(monkeypatch):
    cap = []
    _patch_netbox(monkeypatch, [_service("mxl-videotestsrc", GOOD_COORDS)])
    _patch_sidecar(monkeypatch, status_body=STATUS_JSON, capture=cap)
    resp = _client().get("/api/media-workloads/mxl-videotestsrc/mxl/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["role"] == "receiver"
    assert body["provider"] == "aliyun"
    assert body["node"] == "node-a"
    assert body["preview"] is True
    assert body["flow"]["head_index"] == 42
    assert body["flow"]["grain_rate"] == "50/1"
    # Composed URL is the promsd contract and was actually fetched...
    assert cap == ["http://mxl-videotestsrc.mxl.svc.cluster.local:9000/status"]
    # ...but nothing about the coords/URL leaks in the public JSON.
    for leak in ("cluster_", "svc.cluster.local", "custom_fields", "mxl.svc"):
        assert leak not in resp.text


# --- status: SSRF — coords that fail the gate are NEVER fetched -------------

@pytest.mark.parametrize(
    "coords",
    [
        {"cluster_service": "authentik", "cluster_namespace": "mxl", "cluster_port": 9000},
        {"cluster_service": "netbox", "cluster_namespace": "mxl", "cluster_port": 9000},
        {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "kube-system", "cluster_port": 9000},
        {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl", "cluster_port": 8080},
        {"cluster_service": "kubernetes.default", "cluster_namespace": "mxl", "cluster_port": 9000},
    ],
)
def test_status_ssrf_targets_never_fetched(monkeypatch, coords):
    cap = []
    _patch_netbox(monkeypatch, [_service("mxl-videotestsrc", coords)])
    _patch_sidecar(monkeypatch, status_body=STATUS_JSON, capture=cap)
    resp = _client().get("/api/media-workloads/mxl-videotestsrc/mxl/status")
    assert resp.status_code == 200
    assert resp.json() == {
        "instance": "mxl-videotestsrc",
        "available": False,
        "reason": "no-sidecar",
    }
    assert cap == []  # urlopen must never have been called


def test_status_out_of_scope_is_404_and_never_fetched(monkeypatch):
    cap = []
    # The scoped list does not contain the requested instance -> 404 parity
    # with clear_for_deployment (out-of-scope == absent).
    _patch_netbox(monkeypatch, [_service("mxl-videotestsrc", GOOD_COORDS)])
    _patch_sidecar(monkeypatch, status_body=STATUS_JSON, capture=cap)
    resp = _client().get("/api/media-workloads/some-other-instance/mxl/status")
    assert resp.status_code == 404
    assert resp.json()["available"] is False
    assert cap == []


def test_status_sidecar_unreachable_is_200_degraded(monkeypatch):
    _patch_netbox(monkeypatch, [_service("mxl-videotestsrc", GOOD_COORDS)])
    _patch_sidecar(monkeypatch, status_body=None)  # sidecar down
    resp = _client().get("/api/media-workloads/mxl-videotestsrc/mxl/status")
    assert resp.status_code == 200
    assert resp.json() == {
        "instance": "mxl-videotestsrc",
        "available": False,
        "reason": "unreachable",
    }


def test_status_dark_surface_degrades_not_500():
    # No netbox / tenancy configured -> degrade, never 500 or leak.
    settings = Settings(runtime_mode="local", dev_login_enabled=True, dev_groups=MEDIA_ENGINEERS)
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    resp = client.get("/api/media-workloads/mxl-videotestsrc/mxl/status")
    assert resp.status_code == 200
    assert resp.json()["available"] is False


# --- preview ---------------------------------------------------------------

def test_preview_ok_returns_jpeg_no_store(monkeypatch):
    _patch_netbox(monkeypatch, [_service("mxl-videotestsrc", GOOD_COORDS)])
    _patch_sidecar(monkeypatch, preview_body=JPEG)
    resp = _client().get("/api/media-workloads/mxl-videotestsrc/mxl/preview")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.headers["cache-control"] == "no-store"
    assert resp.content == JPEG


def test_preview_out_of_scope_is_404(monkeypatch):
    cap = []
    _patch_netbox(monkeypatch, [_service("mxl-videotestsrc", GOOD_COORDS)])
    _patch_sidecar(monkeypatch, preview_body=JPEG, capture=cap)
    resp = _client().get("/api/media-workloads/nope/mxl/preview")
    assert resp.status_code == 404
    assert cap == []


def test_preview_ssrf_target_never_fetched_is_404(monkeypatch):
    cap = []
    bad = {"cluster_service": "authentik", "cluster_namespace": "mxl", "cluster_port": 9000}
    _patch_netbox(monkeypatch, [_service("mxl-videotestsrc", bad)])
    _patch_sidecar(monkeypatch, preview_body=JPEG, capture=cap)
    resp = _client().get("/api/media-workloads/mxl-videotestsrc/mxl/preview")
    assert resp.status_code == 404
    assert cap == []


def test_preview_non_jpeg_body_is_404(monkeypatch):
    _patch_netbox(monkeypatch, [_service("mxl-videotestsrc", GOOD_COORDS)])
    _patch_sidecar(monkeypatch, preview_body=b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    resp = _client().get("/api/media-workloads/mxl-videotestsrc/mxl/preview")
    assert resp.status_code == 404


# --- TTL cache -------------------------------------------------------------

def test_repeated_status_polls_hit_netbox_once(monkeypatch):
    counter = {"n": 0}
    _patch_netbox(monkeypatch, [_service("mxl-videotestsrc", GOOD_COORDS)], counter=counter)
    _patch_sidecar(monkeypatch, status_body=STATUS_JSON)
    client = _client()
    for _ in range(3):
        assert client.get("/api/media-workloads/mxl-videotestsrc/mxl/status").status_code == 200
    # The 5s TTL scope cache means NetBox is queried once, not per poll.
    assert counter["n"] == 1
