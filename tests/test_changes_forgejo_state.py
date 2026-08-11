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
