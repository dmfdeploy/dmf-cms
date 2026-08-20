"""Recent commits/pulls endpoints' fail-soft contract (dmfdeploy/dmfdeploy#385).

/api/changes/commits and /api/changes/pulls used to answer a genuine Forgejo
failure with a raw 500 whose body was the stringified exception — literally
the UX Constitution's own Art. 8 worked example
(``"Failed to fetch commits: slice(None, 5, None)"``). They also answered
"Forgejo not configured" with a bare ``{"repos": []}`` / ``{"pulls": []}``,
indistinguishable from Forgejo genuinely having answered with nothing — the
same hard-gate-1 shape ``/api/changes/jobs`` was already fixed for
(dmfdeploy/dmfdeploy#285; see test_changes_jobs_state.py). Both endpoints now
mirror that contract: every outcome is a 200 carrying an explicit ``reason``
token, never a raw exception string.
"""

import pytest
from fastapi.testclient import TestClient

from dmf_cms import main as main_module
from dmf_cms.forgejo import ForgejoAPIError
from dmf_cms.main import create_app
from dmf_cms.settings import ForgejoSettings, Settings


def _client(*, forgejo_configured=True, groups=("dmf-console-viewer",)) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        forgejo=ForgejoSettings(api_url="http://forgejo.test", api_token="t")
        if forgejo_configured
        else ForgejoSettings(),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def _raise(exc):
    def _boom(**kwargs):
        raise exc

    return _boom


@pytest.mark.parametrize("path", ["/api/changes/commits", "/api/changes/pulls"])
def test_anonymous_is_401(path):
    settings = Settings(runtime_mode="local", dev_login_enabled=True)
    client = TestClient(create_app(settings=settings))
    assert client.get(path).status_code == 401


def test_commits_unconfigured_is_an_explicit_token_not_silent_emptiness():
    resp = _client(forgejo_configured=False).get("/api/changes/commits")
    assert resp.status_code == 200
    body = resp.json()
    assert body["repos"] == []
    # The old payload was a bare {"repos": []}, which the History lane
    # rendered as "No recent commits" — a claim that Forgejo answered.
    assert body["reason"] == "forgejo-unconfigured"


def test_pulls_unconfigured_is_an_explicit_token_not_silent_emptiness():
    resp = _client(forgejo_configured=False).get("/api/changes/pulls")
    assert resp.status_code == 200
    body = resp.json()
    assert body["pulls"] == []
    assert body["reason"] == "forgejo-unconfigured"


@pytest.mark.parametrize(
    "exc",
    [ForgejoAPIError(503, "unavailable"), ForgejoAPIError(401, "nope"), RuntimeError("boom")],
)
def test_commits_every_failure_is_unreachable_never_a_500(monkeypatch, exc):
    monkeypatch.setattr(main_module.forgejo, "list_repos", _raise(exc))
    resp = _client().get("/api/changes/commits")
    assert resp.status_code == 200
    assert resp.json() == {"repos": [], "reason": "forgejo-unreachable"}


@pytest.mark.parametrize(
    "exc",
    [ForgejoAPIError(503, "unavailable"), ForgejoAPIError(401, "nope"), RuntimeError("boom")],
)
def test_pulls_every_failure_is_unreachable_never_a_500(monkeypatch, exc):
    monkeypatch.setattr(main_module.forgejo, "list_repos", _raise(exc))
    resp = _client().get("/api/changes/pulls")
    assert resp.status_code == 200
    assert resp.json() == {"pulls": [], "reason": "forgejo-unreachable"}


def test_no_raw_exception_string_survives_in_the_body(monkeypatch):
    # The whole point of the change: the response body must never contain
    # the stringified exception (the Art. 8 worked example this fix closes).
    secret_shaped_exc = RuntimeError("slice(None, 5, None)")
    monkeypatch.setattr(main_module.forgejo, "list_repos", _raise(secret_shaped_exc))
    for path in ("/api/changes/commits", "/api/changes/pulls"):
        resp = _client().get(path)
        assert resp.status_code == 200
        assert "slice(None, 5, None)" not in resp.text


def test_commits_success_carries_an_empty_reason(monkeypatch):
    monkeypatch.setattr(
        main_module.forgejo,
        "list_repos",
        lambda **kwargs: [{"full_name": "dmfdeploy/dmf-cms", "name": "dmf-cms"}],
    )
    monkeypatch.setattr(
        main_module.forgejo,
        "list_commits",
        lambda **kwargs: [
            {
                "sha": "abc1234567",
                "commit": {"message": "fix: x", "author": {"name": "a", "date": "2026-08-01T00:00:00Z"}},
                "html_url": "http://forgejo.test/x",
            }
        ],
    )
    body = _client().get("/api/changes/commits").json()
    assert body["reason"] == ""
    assert body["repos"][0]["name"] == "dmfdeploy/dmf-cms"
    assert body["repos"][0]["commits"][0]["sha_short"] == "abc1234"


def test_pulls_success_carries_an_empty_reason(monkeypatch):
    monkeypatch.setattr(
        main_module.forgejo,
        "list_repos",
        lambda **kwargs: [{"full_name": "dmfdeploy/dmf-cms", "name": "dmf-cms"}],
    )
    monkeypatch.setattr(
        main_module.forgejo,
        "list_pulls",
        lambda **kwargs: [
            {
                "number": 1,
                "title": "t",
                "state": "open",
                "user": {"login": "a"},
                "created_at": "2026-08-01T00:00:00Z",
                "html_url": "http://forgejo.test/pr/1",
            }
        ],
    )
    body = _client().get("/api/changes/pulls").json()
    assert body["reason"] == ""
    assert body["pulls"][0]["repo"] == "dmfdeploy/dmf-cms"


def test_reachable_forgejo_with_no_repos_is_a_genuine_empty(monkeypatch):
    # reason "" is what lets the widget honestly say "No recent commits" —
    # Forgejo answered and there was nothing to show.
    monkeypatch.setattr(main_module.forgejo, "list_repos", lambda **kwargs: [])
    assert _client().get("/api/changes/commits").json() == {"repos": [], "reason": ""}
    assert _client().get("/api/changes/pulls").json() == {"pulls": [], "reason": ""}


# ---------------------------------------------------------------------------
# fix-round P1-2 (PR #81): the per-repo commits/pulls call used to be wrapped
# in its own bare `except Exception: pass` — a failure there was invisible
# to BOTH the UI (this handler still answered `reason: ""` as long as
# `list_repos` itself succeeded, which the widget reads as "genuinely
# empty") AND to monitoring (no log line at all). Both tests below fail
# against the pre-fix-round head: it returns `{"repos": [], "reason": ""}` /
# `{"pulls": [], "reason": ""}` off a fully-failed read, and logs nothing.
# ---------------------------------------------------------------------------

_TWO_REPOS = [
    {"full_name": "dmfdeploy/dmf-cms", "name": "dmf-cms"},
    {"full_name": "dmfdeploy/dmfdeploy", "name": "dmfdeploy"},
]


def test_commits_all_repos_fail_is_unreachable_never_a_silent_empty(monkeypatch, caplog):
    monkeypatch.setattr(main_module.forgejo, "list_repos", lambda **kwargs: _TWO_REPOS)
    monkeypatch.setattr(main_module.forgejo, "list_commits", _raise(RuntimeError("boom")))
    with caplog.at_level("WARNING"):
        body = _client().get("/api/changes/commits").json()
    assert body == {"repos": [], "reason": "forgejo-unreachable"}
    # Previously invisible to monitoring: every failed repo now logs.
    assert sum("dmf-cms" in r.message for r in caplog.records) >= 1
    assert sum("dmfdeploy" in r.message for r in caplog.records) >= 1


def test_pulls_all_repos_fail_is_unreachable_never_a_silent_empty(monkeypatch, caplog):
    monkeypatch.setattr(main_module.forgejo, "list_repos", lambda **kwargs: _TWO_REPOS)
    monkeypatch.setattr(main_module.forgejo, "list_pulls", _raise(RuntimeError("boom")))
    with caplog.at_level("WARNING"):
        body = _client().get("/api/changes/pulls").json()
    assert body == {"pulls": [], "reason": "forgejo-unreachable"}
    assert sum("dmf-cms" in r.message for r in caplog.records) >= 1


def test_commits_per_repo_failure_log_line_sanitizes_hostile_full_name_and_body(monkeypatch, caplog):
    # umbrella dmf-cms#108 fix-round 4: full_name is Forgejo response
    # content (whoever can create a repo in the configured org/user names
    # it), and ForgejoAPIError.body is Forgejo's own raw response body.
    # Both are upstream response content, both land in this per-repo
    # handler's log line. The commits/pulls outer (all-repos-fail) handler
    # shares the identical sanitize_audit_field(str(exc)) call — not
    # independently re-driven here.
    hostile_repos = [
        {"full_name": "dmfdeploy/dmf-cms\nFORGED actor=admin", "name": "dmf-cms"},
    ]
    monkeypatch.setattr(main_module.forgejo, "list_repos", lambda **kwargs: hostile_repos)
    monkeypatch.setattr(
        main_module.forgejo, "list_commits",
        _raise(ForgejoAPIError(500, "boom\nFORGED recent changes: Forgejo commits fetch failed: pwned")),
    )
    with caplog.at_level("WARNING"):
        body = _client().get("/api/changes/commits").json()
    assert body == {"repos": [], "reason": "forgejo-unreachable"}

    lines = [
        r.getMessage() for r in caplog.records
        if r.getMessage().startswith("recent changes: Forgejo commits fetch failed for")
    ]
    assert len(lines) == 1
    assert "\n" not in lines[0]
    assert "FORGED actor=admin" in lines[0]  # full_name survives, escaped
    assert "FORGED recent changes" in lines[0]  # exc body survives, escaped


def test_commits_mixed_success_is_partial_and_keeps_the_successful_rows(monkeypatch, caplog):
    monkeypatch.setattr(main_module.forgejo, "list_repos", lambda **kwargs: _TWO_REPOS)

    def _list_commits(*, owner, repo, **kwargs):
        if repo == "dmf-cms":
            return [
                {
                    "sha": "abc1234567",
                    "commit": {"message": "fix: x", "author": {"name": "a", "date": "2026-08-01T00:00:00Z"}},
                    "html_url": "http://forgejo.test/x",
                }
            ]
        raise RuntimeError("boom")

    monkeypatch.setattr(main_module.forgejo, "list_commits", _list_commits)
    with caplog.at_level("WARNING"):
        body = _client().get("/api/changes/commits").json()

    # Partial, not "": the aggregate is honest that one repo's rows are
    # missing, while the successful repo's real rows are still shown —
    # dropping them entirely would be worse than incomplete-but-labelled.
    assert body["reason"] == "forgejo-partial"
    assert [r["name"] for r in body["repos"]] == ["dmfdeploy/dmf-cms"]
    assert sum("dmfdeploy/dmfdeploy" in r.message for r in caplog.records) >= 1


def test_pulls_mixed_success_is_partial_and_keeps_the_successful_rows(monkeypatch, caplog):
    monkeypatch.setattr(main_module.forgejo, "list_repos", lambda **kwargs: _TWO_REPOS)

    def _list_pulls(*, owner, repo, **kwargs):
        if repo == "dmf-cms":
            return [
                {
                    "number": 1,
                    "title": "t",
                    "state": "open",
                    "user": {"login": "a"},
                    "created_at": "2026-08-01T00:00:00Z",
                    "html_url": "http://forgejo.test/pr/1",
                }
            ]
        raise RuntimeError("boom")

    monkeypatch.setattr(main_module.forgejo, "list_pulls", _list_pulls)
    with caplog.at_level("WARNING"):
        body = _client().get("/api/changes/pulls").json()

    assert body["reason"] == "forgejo-partial"
    assert [p["repo"] for p in body["pulls"]] == ["dmfdeploy/dmf-cms"]
    assert sum("dmfdeploy/dmfdeploy" in r.message for r in caplog.records) >= 1


# fix-round P2 (PR #81, second pass): pulls aggregation used to choose
# forgejo-partial vs forgejo-unreachable off `all_pulls` truthiness (item
# COUNT), not off how many repos were actually READ. A repo can be
# successfully read and legitimately return zero PRs, contributing no items
# — so one empty-but-successful repo plus one failed repo produced
# `forgejo-unreachable`, misreporting a partially-successful read as a
# total failure. This is the case the mixed-success test above cannot see,
# because its successful repo happens to return one PR.
def test_pulls_one_empty_success_plus_one_failure_is_partial_not_unreachable(monkeypatch, caplog):
    monkeypatch.setattr(main_module.forgejo, "list_repos", lambda **kwargs: _TWO_REPOS)

    def _list_pulls(*, owner, repo, **kwargs):
        if repo == "dmf-cms":
            return []  # successfully read, genuinely zero PRs
        raise RuntimeError("boom")

    monkeypatch.setattr(main_module.forgejo, "list_pulls", _list_pulls)
    with caplog.at_level("WARNING"):
        body = _client().get("/api/changes/pulls").json()

    assert body["pulls"] == []
    # The dmf-cms repo WAS reachable — this must not read as total failure.
    assert body["reason"] == "forgejo-partial"
    assert sum("dmfdeploy/dmfdeploy" in r.message for r in caplog.records) >= 1
