"""The gates that run scripts/validate_pr_gate.py must judge a pull request
with the base branch's workflow and script.

`pull_request` runs the workflow file from the PR's merge commit, so a PR could
edit the gate and report its own green check. `pull_request_target` runs the
base branch's copy. These jobs also must not check out the PR head or hold a
write token.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"
GATES = ["commitlint.yml", "dco.yml", "issue-link.yml"]


def load(name: str) -> dict:
    data = yaml.safe_load((WORKFLOWS / name).read_text())
    if True in data:  # YAML 1.1 reads bare `on` as True
        data["on"] = data.pop(True)
    return data


# commitlint.yml is new and trusted only. dco.yml and issue-link.yml keep their
# pull_request listener for one transition step; a follow-up removes it and
# tightens this set to {"pull_request_target", "push"} for every gate.
TRANSITION = {"dco.yml", "issue-link.yml"}


@pytest.mark.parametrize("name", GATES)
def test_runs_on_pull_request_target_and_push(name: str) -> None:
    allowed = {"pull_request_target", "push"} | ({"pull_request"} if name in TRANSITION else set())
    events = set(load(name)["on"])
    assert {"pull_request_target", "push"} <= events <= allowed


@pytest.mark.parametrize("name", GATES)
def test_checks_out_only_the_base_without_credentials(name: str) -> None:
    for job in load(name)["jobs"].values():
        checkouts = [s for s in job["steps"] if str(s.get("uses", "")).startswith("actions/checkout")]
        assert len(checkouts) == 1
        # No `ref:` means the base branch (or the pushed commit on a push).
        assert checkouts[0]["with"] == {"persist-credentials": False}


@pytest.mark.parametrize("name", GATES)
def test_tokens_are_read_only(name: str) -> None:
    wf = load(name)
    scopes = [wf.get("permissions", {})] + [j.get("permissions", {}) for j in wf["jobs"].values()]
    for scope in scopes:
        assert not any(level == "write" for level in scope.values())


def test_issue_link_runs_again_on_the_remedies_its_message_names() -> None:
    types = load("issue-link.yml")["on"]["pull_request_target"]["types"]
    assert {"edited", "labeled", "unlabeled"} <= set(types)


def test_guard_keeps_no_job_that_runs_the_gate_script() -> None:
    assert "validate_pr_gate" not in (WORKFLOWS / "guard.yml").read_text()
    assert "commitlint" not in load("guard.yml")["jobs"]


def test_only_commitlint_yml_runs_a_commitlint_job_on_push() -> None:
    # The release gate refuses two check runs with the same name on one commit,
    # and a job skipped by `if:` still creates a check run. So no other
    # push-triggered workflow may define a job named commitlint.
    on_push = [p.name for p in WORKFLOWS.glob("*.yml") if "push" in (load(p.name).get("on") or {})]
    owners = [n for n in on_push if "commitlint" in load(n).get("jobs", {})]
    assert owners == ["commitlint.yml"]


def test_the_transition_workflow_runs_on_pull_requests_only() -> None:
    # A follow-up deletes commitlint-transition.yml once the trusted workflow is proven.
    assert set(load("commitlint-transition.yml")["on"]) == {"pull_request"}


def test_issue_link_runs_one_validation_per_pull_request() -> None:
    # Keyed by the pull request (push: the commit), never by github.ref, which is
    # the base branch for every pull request under pull_request_target.
    conc = load("issue-link.yml")["concurrency"]
    assert conc["group"] == "issue-link-${{ github.event_name }}-${{ github.event.pull_request.number || github.sha }}"
    assert conc["cancel-in-progress"] is True
