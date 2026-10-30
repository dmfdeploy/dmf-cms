"""Trigger and binding contract of .github/workflows/automerge.yml.

The key for the automerge App must only ever reach a job that runs from the
default branch and never touches pull request code. Plan: dmfdeploy/dmfdeploy
docs/plans/dmf-cms-exact-sha-release-gate-plan.md, "Merge".
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
AUTOMERGE = WORKFLOWS / "automerge.yml"
TOKEN_ACTION = "actions/create-github-app-token"


def load(path: Path = AUTOMERGE) -> dict:
    data = yaml.safe_load(path.read_text())
    # YAML 1.1 parses the bare key `on` as the boolean True.
    if True in data:
        data["on"] = data.pop(True)
    return data


def all_steps(wf: dict):
    for job in wf["jobs"].values():
        yield from job.get("steps", [])


def test_never_uses_pull_request_target():
    wf = load()
    triggers = wf["on"]
    names = triggers if isinstance(triggers, (list, dict)) else [triggers]
    assert "pull_request_target" not in names
    assert "pull_request" not in names
    assert set(names) == {"workflow_run", "schedule"}


def test_workflow_run_lists_only_the_ci_workflow():
    wf = load()
    listed = wf["on"]["workflow_run"]["workflows"]
    ci_name = load(WORKFLOWS / "ci.yml")["name"]
    assert listed == [ci_name] == ["CI"]
    assert wf["on"]["workflow_run"]["types"] == ["completed"]


def test_schedule_is_present_and_off_the_hour_boundary():
    crons = [s["cron"] for s in load()["on"]["schedule"]]
    assert len(crons) == 1
    minutes = crons[0].split()[0].split(",")
    assert "0" not in minutes and "*" not in minutes[0]


def test_no_checkout_step():
    wf = load()
    for step in all_steps(wf):
        assert not str(step.get("uses", "")).startswith("actions/checkout")
        assert "git clone" not in step.get("run", "")
        assert "git fetch" not in step.get("run", "")


def test_job_uses_automerge_environment():
    (job,) = load()["jobs"].values()
    assert job["environment"] == "automerge"


def test_token_action_is_pinned_and_scoped():
    steps = [s for s in all_steps(load())
             if str(s.get("uses", "")).startswith(TOKEN_ACTION)]
    assert len(steps) == 1
    assert re.fullmatch(rf"{TOKEN_ACTION}@[0-9a-f]{{40}}", steps[0]["uses"])
    with_ = steps[0]["with"]
    perms = {k: v for k, v in with_.items() if k.startswith("permission-")}
    assert perms == {"permission-contents": "write",
                     "permission-pull-requests": "write"}
    assert "AUTOMERGE_APP_PRIVATE_KEY" in with_["private-key"]


def test_private_key_is_a_step_input_never_env():
    wf = load()
    for step in all_steps(wf):
        for value in (step.get("env") or {}).values():
            assert "PRIVATE_KEY" not in str(value)
    text = AUTOMERGE.read_text()
    assert text.count("AUTOMERGE_APP_PRIVATE_KEY") == 1


def test_workflow_token_is_read_only():
    wf = load()
    assert wf["permissions"] == {"contents": "read"}
    (job,) = wf["jobs"].values()
    assert job["permissions"] == {"actions": "read"}


def test_pull_request_data_never_reaches_a_shell():
    for step in all_steps(load()):
        script = step.get("run", "")
        assert "github.event.pull_request" not in script
        assert "head_ref" not in script
        assert "${{" not in script, "pass expressions through env"


def test_script_runs_from_default_branch_commit():
    wf = load()
    fetch = next(s for s in all_steps(wf) if "SCRIPT_SHA" in str(s.get("env")))
    assert fetch["env"]["SCRIPT_SHA"] == "${{ github.sha }}"
