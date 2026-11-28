"""Shared helpers for the Forgejo changes contract tests (dmfdeploy/dmfdeploy#1025).

See docs/changes-forgejo-cases.md for the case list; row ids in test names refer to it.

``frontend/src/__tests__/fixtures/changes-contract-1025.json`` holds one entry per row of the
case list in docs/changes-forgejo-cases.md. Each entry carries the setup (what Forgejo replies), the
route response both panels must produce, and the lane the console must render
from that response. The backend tests build a transport from the setup and
assert the response. The frontend tests render the same response and assert
the lane. Neither layer proves the other; the fixture ties them together.
"""

from __future__ import annotations

import email.message
import http.client
import io
import json
import socket
import ssl
import urllib.error
import urllib.parse
from pathlib import Path

FIXTURE = Path(__file__).parents[1] / "frontend/src/__tests__/fixtures/changes-contract-1025.json"

SEARCH_PATH = "/api/v1/repos/search"


def load_fixture() -> dict:
    return json.loads(FIXTURE.read_text())


def layer_params(layer: str, kind: str | None = None) -> list:
    """Fixture rows that name ``layer`` (and carry ``kind``, if given)."""
    import pytest

    out = []
    for row_id, row in load_fixture().items():
        if layer in row["layers"] and (kind is None or kind in row):
            out.append(pytest.param(row_id, row, id=row_id))
    return out


# --- Items Forgejo returns, and the console rows they become -----------------


def good_pull(name: str, i: int) -> dict:
    return {
        "number": i + 1,
        "title": f"PR {i + 1} of {name}",
        "state": "open",
        "user": {"login": "ada"},
        "created_at": "2026-11-27T09:00:00Z",
        "html_url": f"http://forgejo.test/dmf/{name}/pulls/{i + 1}",
    }


def pull_row(name: str, i: int) -> dict:
    return {
        "repo": f"dmf/{name}",
        "number": i + 1,
        "title": f"PR {i + 1} of {name}",
        "state": "open",
        "author": "ada",
        "created": "2026-11-27T09:00:00Z",
        "url": f"http://forgejo.test/dmf/{name}/pulls/{i + 1}",
    }


def _sha(name: str, i: int) -> str:
    return f"{ord(name[0]):02x}{i:05x}" + "0" * 33


def good_commit(name: str, i: int) -> dict:
    return {
        "sha": _sha(name, i),
        "html_url": f"http://forgejo.test/dmf/{name}/commit/{i}",
        "commit": {
            "message": f"commit {i} of {name}",
            "author": {"name": "Ada", "date": "2026-11-27T10:00:00Z"},
        },
    }


def commit_row(name: str, i: int) -> dict:
    return {
        "sha_short": _sha(name, i)[:7],
        "message": f"commit {i} of {name}",
        "author": "Ada",
        "date": "2026-11-27T10:00:00Z",
        "url": f"http://forgejo.test/dmf/{name}/commit/{i}",
    }


def good_item(kind: str, name: str, i: int) -> dict:
    return good_pull(name, i) if kind == "pulls" else good_commit(name, i)


# --- Repos the search returns -------------------------------------------------


def _repo_entry(name: str, off) -> dict:
    entry = {"id": 1, "name": name, "full_name": f"dmf/{name}"}
    if off == "off":
        entry["has_pull_requests"] = False
    elif off == "on":
        entry["has_pull_requests"] = True
    elif off == "null":
        entry["has_pull_requests"] = None
    # "missing": the field is left out.
    return entry


def expand_repos(specs: list) -> list:
    """Turn the fixture's repo specs into the search reply's ``data`` list.

    A spec is ``"a"`` (pull requests on), ``"a:off"``, ``"a:missing"``,
    ``"a:null"``, ``{"raw": <any JSON>}`` for a malformed element, or
    ``{"repeat": n, "name": "x", "off": "on"|"off"}`` for ``n`` generated repos.
    """
    data: list = []
    for spec in specs:
        if isinstance(spec, dict) and "raw" in spec:
            data.append(spec["raw"])
        elif isinstance(spec, dict):
            for k in range(spec["repeat"]):
                data.append(_repo_entry(f"{spec['name']}{k}", spec.get("off", "on")))
        else:
            name, _, flag = spec.partition(":")
            data.append(_repo_entry(name, flag or "on"))
    return data


# --- Transport -----------------------------------------------------------------


class Reply(io.BytesIO):
    """What ``urlopen`` returns: a readable context manager with headers."""

    def __init__(self, body: bytes, headers: dict[str, list[str]] | None = None):
        super().__init__(body)
        self.headers = email.message.Message()
        for key, values in (headers or {}).items():
            for value in values:
                self.headers.add_header(key, value)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _BrokenBody(Reply):
    def __init__(self, exc: Exception, headers=None):
        super().__init__(b"", headers)
        self._exc = exc

    def read(self, *args, **kwargs):
        raise self._exc


class _UnreadableError(io.RawIOBase):
    def read(self, *args, **kwargs):
        raise socket.timeout("timed out reading the error body")


_NOANSWER = {
    "refused": lambda: urllib.error.URLError(ConnectionRefusedError(61, "Connection refused")),
    "timeout": lambda: urllib.error.URLError(socket.timeout("timed out")),
    "dns": lambda: urllib.error.URLError(socket.gaierror(8, "nodename nor servname provided")),
    "tls": lambda: urllib.error.URLError(ssl.SSLError("handshake failure")),
}

_BODYFAIL = {
    "timeout": lambda: socket.timeout("timed out"),
    "reset": lambda: ConnectionResetError(54, "Connection reset by peer"),
    "short": lambda: http.client.IncompleteRead(b"[", 100),
    "tls": lambda: ssl.SSLError("bad record mac"),
}


def _http_error(url: str, code: int, body: bytes | None) -> urllib.error.HTTPError:
    fp = _UnreadableError() if body is None else io.BytesIO(body)
    return urllib.error.HTTPError(url, code, "status", email.message.Message(), fp)


def _resolve(kind: str, name: str, spec):
    """One call's outcome. Returns a Reply or raises what ``urlopen`` would."""

    def good(n):
        return [good_item(kind, name, i) for i in range(n)]

    def fill(value):
        if isinstance(value, list):
            return [good_item(kind, name, 0) if v == "$GOOD" else v for v in value]
        return value

    if isinstance(spec, str):
        head, _, arg = spec.partition(":")
        if head == "rows":
            return Reply(json.dumps(good(int(arg or 1))).encode())
        if head == "empty":
            return Reply(b"[]")
        if head == "http":
            raise _http_error("http://forgejo.test", int(arg), json.dumps({"message": "x"}).encode())
        if head == "http-unreadable":
            raise _http_error("http://forgejo.test", int(arg), None)
        if head == "http-nonutf8":
            raise _http_error("http://forgejo.test", int(arg), b"\xff\xfe\x80 not utf-8")
        if head == "noanswer":
            raise _NOANSWER[arg]()
        if head == "bodyfail":
            return _BrokenBody(_BODYFAIL[arg]())
        if head == "raw":
            return Reply(arg.encode())
    if isinstance(spec, dict) and "json" in spec:
        return Reply(json.dumps(fill(spec["json"])).encode())
    raise AssertionError(f"unknown outcome {spec!r}")


def build_transport(kind: str, setup: dict):
    """A ``urlopen`` replacement serving ``setup``, plus the list of paths asked."""
    requested: list[str] = []
    search = setup["search"]
    per_repo = setup.get("repos", {})
    headers = {"X-Total-Count": search["header"]} if search.get("header") else None

    def fake_urlopen(req, timeout=None):
        parsed = urllib.parse.urlparse(req.full_url)
        requested.append(parsed.path)
        assert req.get_header("Authorization") == "token t"
        if parsed.path == SEARCH_PATH:
            outcome = search.get("outcome")
            if outcome is not None:
                return _resolve(kind, "search", outcome)
            data = expand_repos(search["repos"])
            if "data" in search:
                body = search["data"]
            else:
                body = {"ok": True, "data": data}
            return Reply(json.dumps(body).encode(), headers)
        suffix = "/pulls" if kind == "pulls" else "/commits"
        assert parsed.path.endswith(suffix), parsed.path
        name = parsed.path.split("/")[-2]
        return _resolve(kind, name, per_repo.get(name, "empty"))

    return fake_urlopen, requested


def asked_paths(kind: str, setup: dict) -> list[str]:
    """The per-repo paths the route must ask: the first five it can ask."""
    names = []
    for spec in setup["search"].get("repos", []):
        if isinstance(spec, dict) and "raw" in spec:
            continue
        for entry in expand_repos([spec]):
            askable = kind == "commits" or entry.get("has_pull_requests") is not False
            if askable:
                names.append(entry["name"])
    suffix = "pulls" if kind == "pulls" else "commits"
    return [f"/api/v1/repos/dmf/{n}/{suffix}" for n in names[:5]]
