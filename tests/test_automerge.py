"""Behavior of scripts/automerge.py against a fake GitHub.

The fake mimics the response shapes of the REST pulls, commits, actions and
merge endpoints and of the GraphQL `enablePullRequestAutoMerge` mutation,
including GitHub's "clean status" arm failure and its rejection of a stale
expected head. Plan: dmfdeploy/dmfdeploy
docs/plans/dmf-cms-exact-sha-release-gate-plan.md, "Required tests".
"""
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "automerge.py"
spec = importlib.util.spec_from_file_location("automerge_script", SCRIPT)
am = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = am
spec.loader.exec_module(am)

REPO = "dmfdeploy/dmf-cms"
STALE_MSG = "Head branch was modified. Review the latest changes and try again."


def sha(n: int) -> str:
    return f"{n:040x}"


def make_pr(number: int, head_sha: str | None = None, **over):
    pr = {
        "number": number,
        "node_id": f"PR_node_{number}",
        "state": "open",
        "merged": False,
        "draft": False,
        "labels": [],
        "auto_merge": None,
        "base": {"ref": "main"},
        "head": {"sha": head_sha or sha(number), "repo": {"full_name": REPO}},
    }
    for key, value in over.items():
        pr[key] = value
    return pr


def ci_run(head: str, conclusion="success", status="completed", name="CI"):
    return {
        "name": name,
        "head_sha": head,
        "status": status,
        "conclusion": conclusion,
    }


class FakeGitHub:
    def __init__(self):
        self.prs: dict[int, dict] = {}
        self.runs: dict[str, list[dict]] = {}
        self.calls: list[tuple] = []
        self.clean: set[int] = set()  # PRs whose checks already passed
        self.arm_errors: dict[int, list[am.GhError]] = {}
        self.merge_errors: dict[int, list[am.GhError]] = {}
        self.disarm_errors: dict[int, list[am.GhError]] = {}
        self.before_write = None  # hook(number) run before arm or merge
        self.after_read = None  # hook(number) run after a live PR read
        self.after_arm_attempt = None  # hook(number) after a clean-status arm

    # transport ------------------------------------------------------
    def api(self, method, path, params=None, read_only=False):
        params = params or {}
        self.calls.append((method, path, dict(params), read_only))
        base = f"repos/{REPO}/"
        assert path.startswith(base), path
        rest = path[len(base):]
        if method == "GET" and rest == "pulls":
            assert params["state"] == "open" and params["base"] == "main"
            per, page = int(params["per_page"]), int(params["page"])
            items = [
                copy.deepcopy(p)
                for p in self.prs.values()
                if p["state"] == "open" and p["base"]["ref"] == "main"
            ]
            return items[(page - 1) * per : page * per]
        if method == "GET" and rest.startswith("commits/"):
            head = rest.split("/")[1]
            return [copy.deepcopy(p) for p in self.prs.values()
                    if p["head"]["sha"] == head]
        if method == "GET" and rest == "actions/runs":
            assert read_only, "Actions runs must use the read token"
            runs = self.runs.get(params["head_sha"], [])
            per, page = int(params["per_page"]), int(params["page"])
            return {
                "total_count": len(runs),
                "workflow_runs": runs[(page - 1) * per : page * per],
            }
        parts = rest.split("/")
        if parts[0] == "pulls" and len(parts) == 2 and method == "GET":
            snapshot = copy.deepcopy(self.prs[int(parts[1])])
            if self.after_read:
                self.after_read(int(parts[1]))
            return snapshot
        if parts[0] == "pulls" and parts[-1] == "merge" and method == "PUT":
            return self._merge(int(parts[1]), params)
        raise AssertionError(f"unexpected call {method} {path}")

    def graphql(self, query, variables):
        self.calls.append(("GRAPHQL", query, dict(variables)))
        pr = next(p for p in self.prs.values() if p["node_id"] == variables["id"])
        n = pr["number"]
        if "disablePullRequestAutoMerge" in query:
            if self.disarm_errors.get(n):
                raise self.disarm_errors[n].pop(0)
            pr["auto_merge"] = None
            return {"disablePullRequestAutoMerge": {"pullRequest": {"number": n}}}
        if self.before_write:
            self.before_write(n)
        if self.arm_errors.get(n):
            raise self.arm_errors[n].pop(0)
        if variables["head"] != pr["head"]["sha"]:
            raise am.GhError(200, STALE_MSG)
        if n in self.clean:
            if self.after_arm_attempt:
                self.after_arm_attempt(n)
            raise am.GhError(200, "Pull request is in clean status")
        pr["auto_merge"] = {"merge_method": "rebase"}
        return {"enablePullRequestAutoMerge": {"pullRequest": {"number": n}}}

    def _merge(self, n, params):
        pr = self.prs[n]
        if self.before_write:
            self.before_write(n)
        if self.merge_errors.get(n):
            raise self.merge_errors[n].pop(0)
        if params["sha"] != pr["head"]["sha"]:
            raise am.GhError(409, STALE_MSG)
        assert params["merge_method"] == "rebase"
        pr["state"], pr["merged"] = "closed", True
        return {"merged": True, "sha": sha(9999)}

    # helpers --------------------------------------------------------
    def add(self, pr, ci=True):
        self.prs[pr["number"]] = pr
        if ci:
            self.runs[pr["head"]["sha"]] = [ci_run(pr["head"]["sha"])]
        return pr

    def writes(self):
        return [c for c in self.calls
                if c[0] == "GRAPHQL" or (c[0] == "PUT")]

    def sweep(self):
        return am.run_sweep(self.api, self.graphql, REPO)

    def event(self, head):
        return am.run_event(self.api, self.graphql, REPO, head)


def actions(results):
    return {r.number: r.action for r in results}


# ---- event path ------------------------------------------------------

def test_event_arms_pr_with_rebase_bound_to_head():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    results = gh.event(sha(1))
    assert actions(results) == {1: "armed"}
    (_, query, variables) = gh.writes()[0]
    assert "mergeMethod: REBASE" in query
    assert "expectedHeadOid" in query
    assert variables == {"id": "PR_node_1", "head": sha(1)}
    assert am.report(results) == 0


@pytest.mark.parametrize(
    "over, why",
    [
        ({"head": {"sha": sha(1), "repo": {"full_name": "someone/fork"}}}, "fork"),
        ({"draft": True}, "draft"),
        ({"state": "closed"}, "closed"),
        ({"labels": [{"name": "hold"}]}, "hold"),
        ({"base": {"ref": "release"}}, "other base"),
        ({"labels": None}, "unreadable labels"),
    ],
)
def test_event_skips_ineligible_pr(over, why):
    gh = FakeGitHub()
    gh.add(make_pr(1, **over))
    results = gh.event(sha(1))
    assert gh.writes() == [], why
    assert not any(r.is_error for r in results)


def test_event_skips_when_head_moved_after_lookup():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    original_api = gh.api

    def api(method, path, params=None, read_only=False):
        out = original_api(method, path, params, read_only)
        if path.endswith("/commits/" + sha(1) + "/pulls"):
            gh.prs[1]["head"]["sha"] = sha(77)  # author pushes after lookup
        return out

    results = am.run_event(api, gh.graphql, REPO, sha(1))
    assert gh.writes() == []
    assert actions(results) == {1: "skipped"}


def test_event_ignores_pr_that_only_contains_the_commit():
    gh = FakeGitHub()
    gh.add(make_pr(1, head_sha=sha(500)))
    assert gh.event(sha(1)) == []


def test_event_rejects_malformed_sha():
    gh = FakeGitHub()
    with pytest.raises(SystemExit):
        gh.event("main; rm -rf /")


# ---- fast-check race -------------------------------------------------

def test_race_clean_status_falls_back_to_rebase_merge():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.clean.add(1)  # all required checks passed before the arm
    results = gh.event(sha(1))
    assert actions(results) == {1: "merged"}
    kinds = [c[0] for c in gh.writes()]
    assert kinds == ["GRAPHQL", "PUT"]
    put = gh.writes()[1]
    assert put[2] == {"merge_method": "rebase", "sha": sha(1)}
    assert gh.prs[1]["merged"] is True
    assert am.report(results) == 0


def test_race_merge_with_stale_head_matches_nothing():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.clean.add(1)
    gh.merge_errors[1] = [am.GhError(409, STALE_MSG)]
    results = gh.event(sha(1))
    assert actions(results) == {1: "stale"}
    assert gh.prs[1]["merged"] is False
    assert am.report(results) == 0


def test_race_transient_arm_failure_retries_on_next_trigger():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.arm_errors[1] = [am.GhError(502, "Bad Gateway")]
    first = gh.event(sha(1))
    assert actions(first) == {1: "error"}
    assert am.report(first) == 1
    assert gh.prs[1]["auto_merge"] is None
    second = gh.event(sha(1))  # next CI completion or schedule run
    assert actions(second) == {1: "armed"}
    assert am.report(second) == 0


def test_race_transient_merge_failure_retries_and_merges():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.clean.add(1)
    gh.merge_errors[1] = [am.GhError(502, "Bad Gateway")]
    assert actions(gh.event(sha(1))) == {1: "error"}
    assert actions(gh.event(sha(1))) == {1: "merged"}


def test_arming_is_idempotent():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.event(sha(1))
    gh.calls.clear()
    results = gh.event(sha(1))
    assert actions(results) == {1: "already-armed"}
    assert gh.writes() == []


def test_already_armed_message_is_success():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.arm_errors[1] = [am.GhError(200, "Auto merge is already enabled")]
    assert actions(gh.event(sha(1))) == {1: "already-armed"}


def test_merged_pr_is_not_touched_again():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.clean.add(1)
    gh.event(sha(1))
    gh.calls.clear()
    gh.event(sha(1))
    assert gh.writes() == []


def test_unexpected_arm_error_is_an_error():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.arm_errors[1] = [
        am.GhError(200, "Auto merge is not allowed for this repository")
    ]
    results = gh.event(sha(1))
    assert actions(results) == {1: "error"}
    assert am.report(results) == 1


# ---- schedule path ---------------------------------------------------

def test_sweep_without_ci_run_does_nothing_and_is_not_an_error():
    gh = FakeGitHub()
    gh.add(make_pr(1), ci=False)
    results = gh.sweep()
    assert gh.writes() == []
    assert am.report(results) == 0


@pytest.mark.parametrize(
    "run",
    [
        ci_run(sha(1), conclusion=None, status="in_progress"),
        ci_run(sha(1), conclusion="cancelled"),
        ci_run(sha(1), conclusion="failure"),
        ci_run(sha(1), conclusion="skipped"),
        ci_run(sha(1), name="guard"),  # success, but not the CI workflow
        ci_run(sha(2)),  # success, but for another SHA
    ],
)
def test_sweep_acts_only_on_completed_ci_success(run):
    gh = FakeGitHub()
    gh.add(make_pr(1), ci=False)
    gh.runs[sha(1)] = [run]
    results = gh.sweep()
    assert gh.writes() == []
    assert am.report(results) == 0


def test_sweep_arms_when_a_later_run_succeeded_after_a_failed_one():
    gh = FakeGitHub()
    gh.add(make_pr(1), ci=False)
    gh.runs[sha(1)] = [ci_run(sha(1), "failure"), ci_run(sha(1))]
    assert actions(gh.sweep()) == {1: "armed"}


def test_sweep_head_change_between_read_and_call_matches_nothing():
    gh = FakeGitHub()
    gh.add(make_pr(1))

    def push(n):
        gh.prs[n]["head"]["sha"] = sha(88)

    gh.after_read = push  # head moves after the live read, before the call
    results = gh.sweep()
    assert actions(results) == {1: "stale"}
    assert gh.writes()[0][2]["head"] == sha(1)  # the stale expected head
    assert gh.prs[1]["auto_merge"] is None
    assert am.report(results) == 0
    # The next run sees the new head, which has no CI run yet.
    gh.after_read = None
    assert actions(gh.sweep()) == {1: "skipped"}


def test_sweep_head_change_on_merge_fallback_matches_nothing():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.clean.add(1)

    def push(n):  # between the arm attempt and the merge call
        gh.prs[n]["head"]["sha"] = sha(88)

    gh.after_arm_attempt = push
    assert actions(gh.sweep()) == {1: "stale"}
    assert gh.prs[1]["merged"] is False


def test_sweep_draft_marked_ready_is_armed():
    gh = FakeGitHub()
    gh.add(make_pr(1, draft=True))
    assert gh.writes() == [] and actions(gh.sweep()) == {1: "skipped"}
    gh.prs[1]["draft"] = False  # no CI run starts for this change
    assert actions(gh.sweep()) == {1: "armed"}


def test_sweep_draft_marked_ready_with_clean_checks_is_merged():
    gh = FakeGitHub()
    gh.add(make_pr(1, draft=True))
    gh.clean.add(1)
    gh.sweep()
    gh.prs[1]["draft"] = False
    assert actions(gh.sweep()) == {1: "merged"}


def test_sweep_hold_removed_is_armed():
    gh = FakeGitHub()
    gh.add(make_pr(1, labels=[{"name": "hold"}]))
    assert actions(gh.sweep()) == {1: "skipped"}
    gh.prs[1]["labels"] = []
    assert actions(gh.sweep()) == {1: "armed"}


@pytest.mark.parametrize("count", [100, 101, 250])
def test_sweep_follows_pagination(count):
    gh = FakeGitHub()
    for n in range(1, count + 1):
        gh.add(make_pr(n))
    results = gh.sweep()
    assert len(results) == count
    assert set(actions(results).values()) == {"armed"}
    pages = [
        c[2]["page"] for c in gh.calls if c[1] == f"repos/{REPO}/pulls"
    ]
    assert pages == [str(p) for p in range(1, count // 100 + 2)]
    assert all(c[2]["per_page"] == "100"
               for c in gh.calls if c[1] == f"repos/{REPO}/pulls")


def test_sweep_one_error_does_not_stop_the_others():
    gh = FakeGitHub()
    for n in (1, 2, 3):
        gh.add(make_pr(n))
    gh.arm_errors[2] = [am.GhError(500, "Server Error")]
    results = gh.sweep()
    assert actions(results) == {1: "armed", 2: "error", 3: "armed"}
    assert am.report(results) == 1


def test_sweep_malformed_response_is_isolated():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.add(make_pr(2))
    del gh.prs[1]["head"]["repo"]
    results = gh.sweep()
    assert actions(results)[2] == "armed"
    assert actions(results)[1] == "skipped"  # head repo unknown: not this repo


def test_sweep_skips_fork_even_with_green_ci():
    gh = FakeGitHub()
    gh.add(make_pr(
        1, head={"sha": sha(1), "repo": {"full_name": "someone/fork"}}))
    gh.runs[sha(1)] = [ci_run(sha(1))]
    gh.sweep()
    assert gh.writes() == []


def test_ci_lookup_uses_read_token_only():
    gh = FakeGitHub()
    gh.add(make_pr(1))
    gh.sweep()
    runs_calls = [c for c in gh.calls if c[1].endswith("actions/runs")]
    assert runs_calls and all(c[3] for c in runs_calls)
    other = [c for c in gh.calls
             if c[0] != "GRAPHQL" and not c[1].endswith("actions/runs")]
    assert not any(c[3] for c in other)


def test_report_with_nothing_to_do_succeeds(capsys):
    assert am.report([]) == 0
    assert "no pull requests" in capsys.readouterr().out


# ---- hold disarms ----------------------------------------------------

def armed(pr_number=1, **over):
    return make_pr(pr_number, auto_merge={"merge_method": "rebase"}, **over)


def test_sweep_disarms_armed_pr_with_hold():
    gh = FakeGitHub()
    gh.add(armed(labels=[{"name": "hold"}]))
    results = gh.sweep()
    assert actions(results) == {1: "disarmed"}
    assert gh.prs[1]["auto_merge"] is None
    assert "disablePullRequestAutoMerge" in gh.writes()[0][1]
    assert am.report(results) == 0


def test_sweep_disarms_held_pr_even_without_green_ci():
    gh = FakeGitHub()
    gh.add(armed(labels=[{"name": "hold"}]), ci=False)
    assert actions(gh.sweep()) == {1: "disarmed"}


def test_sweep_leaves_armed_pr_without_hold_alone():
    gh = FakeGitHub()
    gh.add(armed())
    results = gh.sweep()
    assert actions(results) == {1: "already-armed"}
    assert gh.writes() == []


def test_sweep_hold_disarm_is_idempotent():
    gh = FakeGitHub()
    gh.add(armed(labels=[{"name": "hold"}]))
    gh.sweep()
    gh.calls.clear()
    assert actions(gh.sweep()) == {1: "skipped"}
    assert gh.writes() == []


def test_sweep_disarm_error_is_isolated_and_fails_the_run():
    gh = FakeGitHub()
    gh.add(armed(1, labels=[{"name": "hold"}]))
    gh.add(make_pr(2))
    gh.disarm_errors[1] = [am.GhError(500, "Server Error")]
    results = gh.sweep()
    assert actions(results) == {1: "error", 2: "armed"}
    assert am.report(results) == 1


def test_event_path_never_arms_or_disarms_held_pr():
    gh = FakeGitHub()
    gh.add(make_pr(1, labels=[{"name": "hold"}]))
    assert actions(gh.event(sha(1))) == {1: "skipped"}
    assert gh.writes() == []
    gh.add(armed(2, labels=[{"name": "hold"}]))
    gh.event(sha(2))
    assert gh.writes() == []
