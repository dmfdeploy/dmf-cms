"""Client layer (U) of the case table for dmfdeploy/dmfdeploy#1025.

``forgejo.py`` alone, with ``urlopen`` stubbed. It decides the class of every
call (no answer, failed read, HTTP status) and validates the header total and
the reply shapes, so the route can trust what it receives. Each parametrized id
is a row id of the table.
"""

import json

import pytest

from dmf_cms import forgejo

from _changes_contract_1025 import Reply, build_transport, layer_params

API = {"api_url": "http://forgejo.test", "api_token": "t"}


def _call(call: str):
    if call == "search":
        return lambda: forgejo.list_repos(**API)
    if call == "list_pulls":
        return lambda: forgejo.list_pulls(owner="dmf", repo="a", state="all", **API)
    return lambda: forgejo.list_commits(owner="dmf", repo="a", limit=10, **API)


@pytest.mark.parametrize(("row_id", "row"), layer_params("U"))
def test_client_classifies_the_call_as_the_table_row_says(row_id, row, monkeypatch):
    kind = "commits" if "commits" in row and "pulls" not in row else "pulls"
    urlopen, _ = build_transport(kind, row["setup"])
    monkeypatch.setattr(forgejo.urllib.request, "urlopen", urlopen)
    run = _call(row["client_call"])
    expected = row["client"]
    if isinstance(expected, dict):
        result = run()
        assert result.total == expected["total"], row_id
    elif expected == "ok":
        assert isinstance(run(), list), row_id
    else:
        with pytest.raises(getattr(forgejo, expected)) as caught:
            run()
        assert type(caught.value) is getattr(forgejo, expected), row_id


def test_a_failed_read_is_not_a_failure_to_get_an_answer():
    assert not issubclass(forgejo.ForgejoReadFailed, forgejo.ForgejoNoAnswer)
    assert not issubclass(forgejo.ForgejoNoAnswer, forgejo.ForgejoReadFailed)
    assert not issubclass(forgejo.ForgejoAPIError, forgejo.ForgejoNoAnswer)


def test_http_error_keeps_its_status_and_body(monkeypatch):
    urlopen, _ = build_transport("pulls", {"search": {"repos": [], "outcome": "http:503"}})
    monkeypatch.setattr(forgejo.urllib.request, "urlopen", urlopen)
    with pytest.raises(forgejo.ForgejoAPIError) as caught:
        forgejo.list_repos(**API)
    assert caught.value.status == 503
    assert json.loads(caught.value.body) == {"message": "x"}


def test_request_still_returns_only_the_body(monkeypatch):
    """Other callers of ``_request`` keep getting the decoded body, not a pair."""
    monkeypatch.setattr(
        forgejo.urllib.request,
        "urlopen",
        lambda req, timeout=None: Reply(b'{"a": 1}', {"X-Total-Count": ["9"]}),
    )
    assert forgejo._request("http://forgejo.test", "t", "GET", "/x") == {"a": 1}


def test_header_total_is_read_from_the_search_call_only(monkeypatch):
    seen = []

    def fake_urlopen(req, timeout=None):
        seen.append(req.full_url)
        if req.full_url.endswith("/pulls?state=all&limit=20"):
            return Reply(b"[]", {"X-Total-Count": ["99"]})
        return Reply(
            json.dumps({"ok": True, "data": [{"name": "a", "full_name": "dmf/a"}]}).encode(),
            {"X-Total-Count": [" 7 "]},
        )

    monkeypatch.setattr(forgejo.urllib.request, "urlopen", fake_urlopen)
    search = forgejo.list_repos(**API)
    assert search.total == 7  # surrounding whitespace is trimmed
    assert forgejo.list_pulls(owner="dmf", repo="a", state="all", **API) == []
