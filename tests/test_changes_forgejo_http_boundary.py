"""The Changes routes read Forgejo's real reply shapes (dmfdeploy/dmfdeploy#1025).

Forgejo's ``/api/v1/repos/search`` wraps its list as ``{"ok": true, "data": [...]}``,
while the commits and pulls endpoints answer with bare lists. The other tests in
this directory replace ``forgejo.list_repos`` with a fake, so they cannot see the
wrapper. This test replaces only the HTTP transport (``urllib.request.urlopen``),
so the real ``forgejo`` client code runs end to end.
"""

import io
import json
import urllib.parse

import pytest
from fastapi.testclient import TestClient

from dmf_cms import forgejo
from dmf_cms.main import create_app
from dmf_cms.settings import ForgejoSettings, Settings

_SEARCH = {
    "ok": True,
    "data": [
        {"id": 1, "name": "dmf-cms", "full_name": "dmf/dmf-cms"},
        {"id": 2, "name": "dmf-infra", "full_name": "dmf/dmf-infra"},
    ],
}

_COMMITS = [
    {
        "sha": "0123456789abcdef0123456789abcdef01234567",
        "html_url": "http://forgejo.test/dmf/dmf-cms/commit/0123456",
        "commit": {
            "message": "fix: something",
            "author": {"name": "Ada", "date": "2026-11-27T10:00:00Z"},
        },
    }
]

_PULLS = [
    {
        "number": 7,
        "title": "Add a thing",
        "state": "open",
        "user": {"login": "ada"},
        "created_at": "2026-11-27T09:00:00Z",
        "html_url": "http://forgejo.test/dmf/dmf-cms/pulls/7",
    }
]


class _Reply(io.BytesIO):
    """Stands in for the object ``urlopen`` returns: a readable context manager."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def forgejo_transport(monkeypatch):
    """Serve Forgejo's real reply shapes and record every path requested."""
    requested: list[str] = []

    def fake_urlopen(req, timeout=None):
        parsed = urllib.parse.urlparse(req.full_url)
        requested.append(parsed.path)
        assert req.get_header("Authorization") == "token t"
        if parsed.path == "/api/v1/repos/search":
            body = _SEARCH
        elif parsed.path.endswith("/commits"):
            body = _COMMITS
        elif parsed.path.endswith("/pulls"):
            body = _PULLS
        else:
            raise AssertionError(f"unexpected Forgejo path {parsed.path}")
        return _Reply(json.dumps(body).encode())

    monkeypatch.setattr(forgejo.urllib.request, "urlopen", fake_urlopen)
    return requested


def _client() -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=("dmf-console-viewer",),
        forgejo=ForgejoSettings(api_url="http://forgejo.test", api_token="t"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def test_commits_route_reads_the_search_reply(forgejo_transport):
    resp = _client().get("/api/changes/commits")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reason"] == ""
    assert [r["name"] for r in body["repos"]] == ["dmf/dmf-cms", "dmf/dmf-infra"]
    for repo in body["repos"]:
        assert repo["commits"] == [
            {
                "sha_short": "0123456",
                "message": "fix: something",
                "author": "Ada",
                "date": "2026-11-27T10:00:00Z",
                "url": "http://forgejo.test/dmf/dmf-cms/commit/0123456",
            }
        ]
    assert "/api/v1/repos/dmf/dmf-cms/commits" in forgejo_transport


def test_pulls_route_reads_the_search_reply(forgejo_transport):
    resp = _client().get("/api/changes/pulls")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reason"] == ""
    assert [p["repo"] for p in body["pulls"]] == ["dmf/dmf-cms", "dmf/dmf-infra"]
    assert body["pulls"][0] == {
        "repo": "dmf/dmf-cms",
        "number": 7,
        "title": "Add a thing",
        "state": "open",
        "author": "ada",
        "created": "2026-11-27T09:00:00Z",
        "url": "http://forgejo.test/dmf/dmf-cms/pulls/7",
    }
    assert "/api/v1/repos/dmf/dmf-infra/pulls" in forgejo_transport


def test_list_repos_returns_the_inner_list(forgejo_transport):
    repos = forgejo.list_repos(api_url="http://forgejo.test", api_token="t")
    assert repos == _SEARCH["data"]


@pytest.mark.parametrize(
    "reply",
    [{"ok": True}, {"ok": True, "data": None}, [], "x", {"ok": False, "data": []}],
)
def test_list_repos_rejects_a_reply_without_a_data_list(monkeypatch, reply):
    monkeypatch.setattr(
        forgejo.urllib.request,
        "urlopen",
        lambda req, timeout=None: _Reply(json.dumps(reply).encode()),
    )
    with pytest.raises(forgejo.ForgejoAPIError):
        forgejo.list_repos(api_url="http://forgejo.test", api_token="t")


@pytest.mark.parametrize(
    ("route", "empty_key"),
    [("/api/changes/commits", "repos"), ("/api/changes/pulls", "pulls")],
)
def test_routes_report_unreachable_for_a_failed_search_reply(
    monkeypatch, route, empty_key
):
    """A reply marked ``ok: false`` is a failure even when it carries a list."""
    monkeypatch.setattr(
        forgejo.urllib.request,
        "urlopen",
        lambda req, timeout=None: _Reply(
            json.dumps({"ok": False, "data": []}).encode()
        ),
    )
    resp = _client().get(route)
    assert resp.status_code == 200
    body = resp.json()
    assert body["reason"] == "forgejo-unreachable"
    assert body[empty_key] == []
