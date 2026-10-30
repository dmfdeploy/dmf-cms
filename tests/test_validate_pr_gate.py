"""Fixture tests for scripts/validate_pr_gate.py (dco, issue-link, commitlint)."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "validate_pr_gate.py"
spec = importlib.util.spec_from_file_location("validate_pr_gate", SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

REPO = "dmfdeploy/dmf-cms"
PUSHED = "f" * 40
GOOD_BODY = "Summary.\n\nRefs dmfdeploy/dmfdeploy#568\n"
SIGNOFF = "\n\nSigned-off-by: A Dev <dev@example.com>"


def commit(subject: str, signoff: bool = True, sha: str = "a" * 40) -> dict[str, Any]:
    return {"sha": sha, "commit": {"message": subject + (SIGNOFF if signoff else "")}}


def pr(number: int = 7, merged: bool = True, base: str = "main", body: str = GOOD_BODY,
       labels: tuple[str, ...] = ()) -> dict[str, Any]:
    return {
        "number": number,
        "merged_at": "2026-10-30T00:00:00Z" if merged else None,
        "base": {"ref": base},
        "body": body,
        "labels": [{"name": n} for n in labels],
    }


class FakeApi:
    """Serves one page of data per path, then an empty page."""

    def __init__(self, prs: list[dict], commits: list[dict]) -> None:
        self.prs = prs
        self.commits = commits
        self.calls: list[str] = []

    def __call__(self, path: str) -> Any:
        self.calls.append(path)
        page = int(path.rsplit("page=", 1)[1])
        if "/commits/" in path and "/pulls" in path:
            data = self.prs
        elif "/pulls/" in path and path.split("?")[0].endswith("/commits"):
            data = self.commits
        else:
            raise AssertionError(path)
        return data if page == 1 else []


def push_env() -> dict[str, str]:
    return {"GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": REPO, "GITHUB_SHA": PUSHED}


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gate.time, "sleep", lambda _s: None)


@pytest.mark.parametrize("name", ["dco", "issue-link", "commitlint"])
def test_push_with_clean_merged_pr_passes(name: str) -> None:
    api = FakeApi([pr()], [commit("fix(ci): x")])
    assert gate.run_gate(name, push_env(), api) == []


def test_push_uses_pr_commits_not_pushed_sha() -> None:
    api = FakeApi([pr(number=7)], [commit("fix(ci): x")])
    gate.run_gate("dco", push_env(), api)
    assert any("/pulls/7/commits" in c for c in api.calls)


def test_dco_flags_each_missing_trailer() -> None:
    api = FakeApi([pr()], [commit("fix: a"), commit("fix: b", signoff=False, sha="b" * 40)])
    errors = gate.run_gate("dco", push_env(), api)
    assert len(errors) == 1 and "b" * 40 in errors[0]


def test_commitlint_flags_non_conventional_and_skips_merge() -> None:
    api = FakeApi([pr()], [commit("Fix things"), commit("Merge branch x"), commit("feat(a): ok")])
    errors = gate.run_gate("commitlint", push_env(), api)
    assert errors == ["non-conventional commit subject: Fix things"]


@pytest.mark.parametrize("name", ["dco", "issue-link", "commitlint"])
@pytest.mark.parametrize(
    "prs",
    [
        [],
        [pr(merged=False)],
        [pr(base="release")],
        [pr(number=1), pr(number=2)],
    ],
    ids=["none", "unmerged", "other-base", "ambiguous"],
)
def test_unresolvable_lookup_fails_every_gate(name: str, prs: list[dict]) -> None:
    api = FakeApi(prs, [commit("fix: x")])
    with pytest.raises(gate.GateError):
        gate.run_gate(name, push_env(), api)


def test_empty_commit_list_fails() -> None:
    api = FakeApi([pr()], [])
    with pytest.raises(gate.GateError):
        gate.run_gate("dco", push_env(), api)


def test_issue_link_variants() -> None:
    ok = FakeApi([pr(body="Closes dmfdeploy/dmfdeploy#12")], [])
    assert gate.run_gate("issue-link", push_env(), ok) == []
    url = FakeApi([pr(body="Refs https://github.com/dmfdeploy/dmfdeploy/issues/9")], [])
    assert gate.run_gate("issue-link", push_env(), url) == []
    bare = FakeApi([pr(body="Closes #12")], [])
    assert len(gate.run_gate("issue-link", push_env(), bare)) == 1
    empty = FakeApi([pr(body=None)], [])
    assert len(gate.run_gate("issue-link", push_env(), empty)) == 1
    waived = FakeApi([pr(body="none", labels=("no-issue",))], [])
    assert gate.run_gate("issue-link", push_env(), waived) == []


def test_pull_request_event_reads_payload_and_given_number() -> None:
    env = {
        "GITHUB_EVENT_NAME": "pull_request",
        "GITHUB_REPOSITORY": REPO,
        "PR_NUMBER": "42",
        "PR_BODY": "Refs dmfdeploy/dmfdeploy#1",
        "PR_LABELS": "bug",
    }
    api = FakeApi([], [commit("fix: x")])
    assert gate.run_gate("issue-link", env, api) == []
    assert gate.run_gate("dco", env, api) == []
    assert all("/pulls/42/commits" in c for c in api.calls)
    env["PR_BODY"] = ""
    assert len(gate.run_gate("issue-link", env, api)) == 1
    env["PR_LABELS"] = "bug no-issue"
    assert gate.run_gate("issue-link", env, api) == []


def test_lookup_retries_before_giving_up() -> None:
    seen: list[int] = []

    class Late(FakeApi):
        def __call__(self, path: str) -> Any:
            if path.startswith(f"repos/{REPO}/commits/{PUSHED}/pulls") and path.endswith("&page=1"):
                seen.append(1)
                if len(seen) < 3:
                    return []
            return super().__call__(path)

    api = Late([pr()], [commit("fix: x")])
    assert gate.run_gate("dco", push_env(), api) == []
    assert len(seen) == 3


def test_main_exit_codes(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    monkeypatch.setattr(gate, "gh_api", FakeApi([], []))
    for k, v in push_env().items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(gate, "LOOKUP_ATTEMPTS", 1)
    assert gate.main(["x", "dco"]) == 1
    assert "::error::no merged pull request" in capsys.readouterr().out
    assert gate.main(["x", "bogus"]) == 2
