"""``awx._request`` bounds its success and error body reads (#264)."""

from __future__ import annotations

import io
import urllib.error
from unittest.mock import patch

import pytest

from dmf_cms import awx

HUGE = 50 * 1024 * 1024


class _SizedBody:
    """A response body of ``total`` bytes that honours read(size).

    An unbounded read() hands back the whole body, so a test can tell the
    two cases apart by what the client asked for. ``max_asked`` records the
    largest request (``None`` means an unbounded read was made).
    """

    def __init__(self, total: int, fill: bytes = b"x") -> None:
        self._remaining = total
        self._fill = fill
        self.max_asked: int | None = 0
        self.unbounded = False

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            self.unbounded = True
            size = self._remaining
        else:
            self.max_asked = max(self.max_asked or 0, size)
        size = min(size, self._remaining)
        self._remaining -= size
        return self._fill * size

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_oversize_success_body_is_rejected_without_full_read() -> None:
    body = _SizedBody(HUGE)
    with patch("urllib.request.urlopen", return_value=body):
        with pytest.raises(awx.AWXTransportError) as info:
            awx._request("http://awx.test", "tok", "GET", "/api/v2/ping/")
    assert info.value.phase == "oversize"
    assert not body.unbounded
    assert (body.max_asked or 0) <= awx._MAX_JSON_BYTES + 1


def test_body_at_the_cap_still_decodes() -> None:
    payload = b'{"k": "' + b"a" * 1000 + b'"}'
    body = io.BytesIO(payload)
    body.__enter__ = lambda self=body: self  # type: ignore[method-assign]
    body.__exit__ = lambda *a: False  # type: ignore[method-assign]
    with patch("urllib.request.urlopen", return_value=body):
        out = awx._request("http://awx.test", "tok", "GET", "/api/v2/ping/")
    assert out["k"] == "a" * 1000


def test_error_body_read_is_a_bounded_prefix() -> None:
    fp = _SizedBody(HUGE, fill=b"E")
    err = urllib.error.HTTPError("http://awx.test", 500, "boom", {}, fp)  # type: ignore[arg-type]
    with patch("urllib.request.urlopen", side_effect=err):
        with pytest.raises(awx.AWXAPIError) as info:
            awx._request("http://awx.test", "tok", "GET", "/api/v2/ping/")
    assert not fp.unbounded
    assert len(info.value.body) <= awx._MAX_ERROR_BODY_BYTES
    assert info.value.status == 500
