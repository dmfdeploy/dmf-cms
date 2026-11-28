"""Backend layer (B) for dmfdeploy/dmfdeploy#1025.

See docs/changes-forgejo-cases.md for the case list; row ids in test names refer to it.

Each test stubs only ``urllib.request.urlopen``, so the Forgejo client, the
header read and the route run for real. Every parametrized test id is a row id
of the case list (``S3``, ``H8``, ``M8``, ``F-W5.sha-number`` and so on). The
expected JSON comes from ``frontend/src/__tests__/fixtures/changes-contract-1025.json``, the
same file the console tests render, so a drift in either layer fails.
"""

import pytest
from fastapi.testclient import TestClient

from dmf_cms import forgejo
from dmf_cms import main as main_module
from dmf_cms.main import create_app
from dmf_cms.settings import ForgejoSettings, Settings

from _changes_contract_1025 import (
    SEARCH_PATH,
    asked_paths,
    build_transport,
    layer_params,
)

ROUTES = {"pulls": "/api/changes/pulls", "commits": "/api/changes/commits"}


def _client(*, configured: bool = True) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=("dmf-console-viewer",),
        forgejo=ForgejoSettings(api_url="http://forgejo.test", api_token="t")
        if configured
        else ForgejoSettings(),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def _check_row(kind: str, row_id: str, row: dict, monkeypatch) -> None:
    urlopen, requested = build_transport(kind, row["setup"])
    monkeypatch.setattr(forgejo.urllib.request, "urlopen", urlopen)
    resp = _client().get(ROUTES[kind])
    assert resp.status_code == 200, row_id
    assert resp.json() == row[kind]["response"], row_id
    asked = [p for p in requested if p != SEARCH_PATH]
    expected = [] if row["asked"] == "none" else asked_paths(kind, row["setup"])
    assert asked == expected, f"{row_id}: only the first five repos are asked"


@pytest.mark.parametrize(("row_id", "row"), layer_params("B", "pulls"))
def test_pulls_route_matches_the_table_row(row_id, row, monkeypatch):
    _check_row("pulls", row_id, row, monkeypatch)


@pytest.mark.parametrize(("row_id", "row"), layer_params("B", "commits"))
def test_commits_route_matches_the_table_row(row_id, row, monkeypatch):
    _check_row("commits", row_id, row, monkeypatch)


# --- S8 and W18: an untyped exception is never proof that no reply arrived ----


class _Exploding(dict):
    def get(self, *args, **kwargs):
        raise RuntimeError("conversion bug secret-marker")


@pytest.mark.parametrize("kind", ["pulls", "commits"])
def test_S8_untyped_exception_while_handling_the_search_is_read_failed(kind, monkeypatch, caplog):
    def boom(**kwargs):
        raise RuntimeError("search handling bug secret-marker\nFORGED line")

    monkeypatch.setattr(main_module.forgejo, "list_repos", boom)
    with caplog.at_level("WARNING"):
        resp = _client().get(ROUTES[kind])
    assert resp.status_code == 200
    body = resp.json()
    assert body["reason"] == "forgejo-read-failed"
    assert body["skipped_repos"] == 0
    assert body["repos_maybe_incomplete"] is False
    assert "secret-marker" not in resp.text
    logged = [r.getMessage() for r in caplog.records if "secret-marker" in r.getMessage()]
    assert logged and all("\n" not in line for line in logged)


def _search_of(names):
    return forgejo.RepoSearch(
        repos=[{"id": 1, "name": n, "full_name": f"dmf/{n}"} for n in names], total=None
    )


@pytest.mark.parametrize("kind", ["pulls", "commits"])
def test_W18_untyped_exception_in_one_repos_conversion_fails_that_repo(kind, monkeypatch, caplog):
    monkeypatch.setattr(main_module.forgejo, "list_repos", lambda **kw: _search_of(["a"]))
    monkeypatch.setattr(
        main_module.forgejo, f"list_{kind}", lambda **kw: [_Exploding()]
    )
    with caplog.at_level("WARNING"):
        body = _client().get(ROUTES[kind]).json()
    assert body["reason"] == "forgejo-read-failed"
    assert body["pulls" if kind == "pulls" else "repos"] == []
    assert any("secret-marker" in r.getMessage() for r in caplog.records)


# --- Existing response rules the new fields must not change ------------------


@pytest.mark.parametrize("path", ROUTES.values())
def test_unauthorized_keeps_its_error_body(path):
    settings = Settings(runtime_mode="local", dev_login_enabled=True)
    resp = TestClient(create_app(settings=settings)).get(path)
    assert resp.status_code == 401
    assert resp.json() == {"error": "unauthorized"}


def test_unconfigured_replies_carry_the_default_fields():
    pulls = _client(configured=False).get(ROUTES["pulls"]).json()
    assert pulls == {
        "pulls": [],
        "reason": "forgejo-unconfigured",
        "disabled_repos": 0,
        "skipped_repos": 0,
        "repos_maybe_incomplete": False,
    }
    commits = _client(configured=False).get(ROUTES["commits"]).json()
    assert commits == {
        "repos": [],
        "reason": "forgejo-unconfigured",
        "skipped_repos": 0,
        "repos_maybe_incomplete": False,
    }
