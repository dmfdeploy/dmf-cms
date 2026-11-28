"""The Changes routes read Forgejo's real reply shapes (dmfdeploy/dmfdeploy#1025).

Forgejo's ``/api/v1/repos/search`` wraps its list as ``{"ok": true, "data": [...]}``,
while the commits and pulls endpoints answer with bare lists. The other tests in
this directory replace ``forgejo.list_repos`` with a fake, so they cannot see the
wrapper. This test replaces only the HTTP transport (``urllib.request.urlopen``),
so the real ``forgejo`` client code runs end to end.
"""

import io
import json
import urllib.error
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
    search = forgejo.list_repos(api_url="http://forgejo.test", api_token="t")
    assert search.repos == _SEARCH["data"]


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
    with pytest.raises(forgejo.ForgejoReadFailed):
        forgejo.list_repos(api_url="http://forgejo.test", api_token="t")


@pytest.mark.parametrize(
    ("route", "empty_key"),
    [("/api/changes/commits", "repos"), ("/api/changes/pulls", "pulls")],
)
def test_routes_report_a_failed_read_for_a_failed_search_reply(
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
    assert body["reason"] == "forgejo-read-failed"
    assert body[empty_key] == []


# --- Repos with pull requests turned off (dmfdeploy/dmfdeploy#1025) ---------

_PULLS_404 = {"message": "The target couldn't be found.", "url": "http://forgejo.test/api/swagger"}


def _repo(name: str, **fields) -> dict:
    return {"id": 1, "name": name, "full_name": f"dmf/{name}", "archived": False, **fields}


def _serve(monkeypatch, repos, pulls_by_repo=None):
    """Serve ``repos`` through the search wrapper.

    ``pulls_by_repo`` maps a repo name to a bare pull list, ``"404"`` (Forgejo's
    reply for a repo with pull requests turned off) or ``"conn"`` (a connection
    error). Every path requested is recorded.
    """
    requested: list[str] = []
    pulls_by_repo = pulls_by_repo or {}

    def fake_urlopen(req, timeout=None):
        parsed = urllib.parse.urlparse(req.full_url)
        requested.append(parsed.path)
        if parsed.path == "/api/v1/repos/search":
            return _Reply(json.dumps({"ok": True, "data": repos}).encode())
        assert parsed.path.endswith("/pulls"), parsed.path
        name = parsed.path.split("/")[-2]
        outcome = pulls_by_repo.get(name, [])
        if outcome == "404":
            raise urllib.error.HTTPError(
                req.full_url, 404, "Not Found", {}, io.BytesIO(json.dumps(_PULLS_404).encode())
            )
        if outcome == "conn":
            raise urllib.error.URLError("connection refused")
        return _Reply(json.dumps(outcome).encode())

    monkeypatch.setattr(forgejo.urllib.request, "urlopen", fake_urlopen)
    return requested


def _body(pulls, reason, *, disabled=0, skipped=0, incomplete=False) -> dict:
    return {
        "pulls": pulls,
        "reason": reason,
        "disabled_repos": disabled,
        "skipped_repos": skipped,
        "repos_maybe_incomplete": incomplete,
    }


def _pulls_requested(requested):
    return [p for p in requested if p.endswith("/pulls")]


def test_pulls_route_skips_repos_with_pull_requests_off(monkeypatch):
    repos = [
        _repo("dmf-infra", mirror=True, has_pull_requests=False),
        _repo("dmf-media", mirror=True, has_pull_requests=False),
        _repo("dmf-runbooks", mirror=True, has_pull_requests=False),
    ]
    requested = _serve(monkeypatch, repos)
    body = _client().get("/api/changes/pulls").json()
    assert body == _body([], "forgejo-pulls-disabled", disabled=3)
    assert _pulls_requested(requested) == []


def test_pulls_route_mixes_repos_with_pull_requests_off_and_on(monkeypatch):
    repos = [
        _repo("dmf-infra", mirror=True, has_pull_requests=False),
        _repo("dmf-cms", mirror=False, has_pull_requests=True),
    ]
    requested = _serve(monkeypatch, repos, {"dmf-cms": _PULLS})
    body = _client().get("/api/changes/pulls").json()
    assert body["reason"] == ""
    assert [p["repo"] for p in body["pulls"]] == ["dmf/dmf-cms"]
    assert _pulls_requested(requested) == ["/api/v1/repos/dmf/dmf-cms/pulls"]


def test_pulls_off_repos_do_not_use_up_the_five_repo_cap(monkeypatch):
    repos = [_repo(f"mirror-{i}", has_pull_requests=False) for i in range(5)]
    repos.append(_repo("dmf-cms", has_pull_requests=True))
    _serve(monkeypatch, repos, {"dmf-cms": _PULLS})
    body = _client().get("/api/changes/pulls").json()
    assert body["reason"] == ""
    assert [p["repo"] for p in body["pulls"]] == ["dmf/dmf-cms"]


def test_pulls_404_on_a_repo_with_pull_requests_on_is_still_a_failure(monkeypatch):
    repos = [
        _repo("dmf-cms", has_pull_requests=True),
        _repo("dmf-infra", has_pull_requests=True),
    ]
    _serve(monkeypatch, repos, {"dmf-cms": _PULLS, "dmf-infra": "404"})
    body = _client().get("/api/changes/pulls").json()
    assert body["reason"] == "forgejo-partial"
    assert [p["repo"] for p in body["pulls"]] == ["dmf/dmf-cms"]


def test_E3_M8_pulls_404_on_every_repo_with_pull_requests_on_is_a_failed_read(monkeypatch):
    """The search answered, so no per-repository result can say "unreachable"."""
    repos = [_repo("dmf-cms", has_pull_requests=True)]
    _serve(monkeypatch, repos, {"dmf-cms": "404"})
    body = _client().get("/api/changes/pulls").json()
    assert body == _body([], "forgejo-read-failed")


def test_pulls_connection_error_on_a_repo_with_pull_requests_on_is_a_failure(monkeypatch):
    repos = [
        _repo("dmf-infra", has_pull_requests=False),
        _repo("dmf-cms", has_pull_requests=True),
    ]
    _serve(monkeypatch, repos, {"dmf-cms": "conn"})
    body = _client().get("/api/changes/pulls").json()
    # The off repo answered, so Forgejo is reachable: partial, not unreachable.
    assert body == _body([], "forgejo-partial", disabled=1)


def test_pulls_route_queries_a_repo_object_without_the_field(monkeypatch):
    repos = [_repo("dmf-cms")]
    requested = _serve(monkeypatch, repos, {"dmf-cms": _PULLS})
    body = _client().get("/api/changes/pulls").json()
    assert body["reason"] == ""
    assert len(body["pulls"]) == 1
    assert _pulls_requested(requested) == ["/api/v1/repos/dmf/dmf-cms/pulls"]


# `reason` says whether reads failed. `disabled_repos` says how many repos were
# left out because pull requests are turned off. The two facts are independent,
# so each case below asserts both.


def test_pulls_one_off_one_on_with_no_pull_requests_reports_the_off_repo(monkeypatch):
    repos = [
        _repo("dmf-infra", mirror=True, has_pull_requests=False),
        _repo("dmf-cms", has_pull_requests=True),
    ]
    requested = _serve(monkeypatch, repos, {"dmf-cms": []})
    body = _client().get("/api/changes/pulls").json()
    assert body == _body([], "", disabled=1)
    assert _pulls_requested(requested) == ["/api/v1/repos/dmf/dmf-cms/pulls"]


def test_pulls_one_off_one_on_with_a_row_reports_the_row_and_the_off_repo(monkeypatch):
    repos = [
        _repo("dmf-infra", mirror=True, has_pull_requests=False),
        _repo("dmf-cms", has_pull_requests=True),
    ]
    _serve(monkeypatch, repos, {"dmf-cms": _PULLS})
    body = _client().get("/api/changes/pulls").json()
    assert body["reason"] == ""
    assert body["disabled_repos"] == 1
    assert [p["repo"] for p in body["pulls"]] == ["dmf/dmf-cms"]


def test_pulls_no_repo_off_and_no_pull_requests_reports_nothing_off(monkeypatch):
    repos = [_repo("dmf-cms", has_pull_requests=True)]
    _serve(monkeypatch, repos, {"dmf-cms": []})
    body = _client().get("/api/changes/pulls").json()
    assert body == _body([], "")


def test_pulls_one_off_one_failed_with_no_rows_keeps_both_facts(monkeypatch):
    repos = [
        _repo("dmf-infra", has_pull_requests=False),
        _repo("dmf-cms", has_pull_requests=True),
    ]
    _serve(monkeypatch, repos, {"dmf-cms": "404"})
    body = _client().get("/api/changes/pulls").json()
    assert body == _body([], "forgejo-partial", disabled=1)


def test_pulls_one_off_one_failed_one_read_keeps_the_row_and_both_facts(monkeypatch):
    repos = [
        _repo("dmf-infra", has_pull_requests=False),
        _repo("dmf-cms", has_pull_requests=True),
        _repo("dmf-media", has_pull_requests=True),
    ]
    _serve(monkeypatch, repos, {"dmf-cms": _PULLS, "dmf-media": "conn"})
    body = _client().get("/api/changes/pulls").json()
    assert body["reason"] == "forgejo-partial"
    assert body["disabled_repos"] == 1
    assert [p["repo"] for p in body["pulls"]] == ["dmf/dmf-cms"]


def test_E3_M9_pulls_no_answer_from_every_repo_after_a_good_search_is_a_failed_read(monkeypatch):
    repos = [_repo("dmf-cms", has_pull_requests=True)]
    _serve(monkeypatch, repos, {"dmf-cms": "conn"})
    body = _client().get("/api/changes/pulls").json()
    assert body == _body([], "forgejo-read-failed")
