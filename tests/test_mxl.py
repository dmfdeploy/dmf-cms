import json
import urllib.error

import pytest

from dmf_cms import mxl
from dmf_cms.mxl import fetch_status
from dmf_cms.settings import MXLEndpoint


class _FakeResp:
    """Context-managed stand-in for an http.client.HTTPResponse."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self, n: int = -1) -> bytes:
        return self._body if (n is None or n < 0) else self._body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _patch_urlopen(monkeypatch, *, body=b"", exc=None, capture=None):
    def fake_urlopen(req, timeout=None):
        if capture is not None:
            capture.append((req.full_url, timeout))
        if exc is not None:
            raise exc
        return _FakeResp(body)

    monkeypatch.setattr(mxl.urllib.request, "urlopen", fake_urlopen)


def test_fetch_status_skips_unreachable_endpoints(monkeypatch):
    def fake_get_json(url: str, path: str, timeout: float = 2.0):
        if "reachable" in url:
            return {
                "node": "node-a",
                "preview": True,
                "transport": {"provider": "tcp"},
                "flow": {"id": "flow-1", "format": "Video", "active": True},
            }
        raise TimeoutError("timed out")

    monkeypatch.setattr("dmf_cms.mxl._get_json", fake_get_json)

    data = fetch_status(
        (
            MXLEndpoint(role="source", provider="aliyun", url="http://reachable:9000"),
            MXLEndpoint(role="view", provider="aliyun", url="http://offline:9000"),
        )
    )

    assert data["reachable"] is True
    assert len(data["nodes"]) == 1
    assert data["nodes"][0]["role"] == "source"
    assert data["nodes"][0]["online"] is True
    assert data["flow"]["id"] == "flow-1"


# --- WP-D per-instance hardened fetchers (fetch_status_one / fetch_preview_one) ---

def test_fetch_status_one_parses_json_and_hits_status_path(monkeypatch):
    cap = []
    _patch_urlopen(
        monkeypatch,
        body=json.dumps({"role": "receiver", "flow": {"head_index": 5}}).encode(),
        capture=cap,
    )
    data = mxl.fetch_status_one("http://mxl-x.mxl.svc.cluster.local:9000")
    assert data == {"role": "receiver", "flow": {"head_index": 5}}
    assert cap[0][0] == "http://mxl-x.mxl.svc.cluster.local:9000/status"


def test_fetch_status_one_rejects_oversized_body(monkeypatch):
    big = json.dumps({"x": "a" * 40000}).encode()
    _patch_urlopen(monkeypatch, body=big)
    assert mxl.fetch_status_one("http://h:9000", max_bytes=1024) is None


def test_fetch_status_one_none_on_transport_error(monkeypatch):
    _patch_urlopen(monkeypatch, exc=urllib.error.URLError("boom"))
    assert mxl.fetch_status_one("http://h:9000") is None


def test_fetch_status_one_none_on_bad_json(monkeypatch):
    _patch_urlopen(monkeypatch, body=b"<html>not json</html>")
    assert mxl.fetch_status_one("http://h:9000") is None


def test_fetch_status_one_none_on_non_object_json(monkeypatch):
    _patch_urlopen(monkeypatch, body=b"[1, 2, 3]")
    assert mxl.fetch_status_one("http://h:9000") is None


def test_fetch_preview_one_returns_jpeg_and_hits_preview_path(monkeypatch):
    jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 100
    cap = []
    _patch_urlopen(monkeypatch, body=jpeg, capture=cap)
    assert mxl.fetch_preview_one("http://h:9000") == jpeg
    assert cap[0][0] == "http://h:9000/preview.jpg"


def test_fetch_preview_one_rejects_non_jpeg_soi(monkeypatch):
    _patch_urlopen(monkeypatch, body=b"\x89PNG\r\n\x1a\n" + b"\x00" * 50)
    assert mxl.fetch_preview_one("http://h:9000") is None


def test_fetch_preview_one_rejects_oversized_body(monkeypatch):
    jpeg = b"\xff\xd8" + b"\x00" * 300000
    _patch_urlopen(monkeypatch, body=jpeg)
    assert mxl.fetch_preview_one("http://h:9000", max_bytes=1024) is None


def test_fetch_preview_one_none_on_transport_error(monkeypatch):
    _patch_urlopen(monkeypatch, exc=urllib.error.HTTPError("u", 502, "bad", {}, None))
    assert mxl.fetch_preview_one("http://h:9000") is None
