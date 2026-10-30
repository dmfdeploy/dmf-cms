"""Contract of .github/workflows/hold-disarm.yml and the automerge triggers.

`hold` stops a merge. The disarm workflow must stay tiny: label event only,
GITHUB_TOKEN only, no code, no secrets.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"
HOLD = WORKFLOWS / "hold-disarm.yml"


def load(path: Path) -> dict:
    data = yaml.safe_load(path.read_text())
    if True in data:  # YAML 1.1 reads bare `on` as True
        data["on"] = data.pop(True)
    return data


def test_name_and_trigger_is_only_pull_request_labeled():
    wf = load(HOLD)
    assert wf["name"] == "hold-disarm"
    assert wf["on"] == {"pull_request": {"types": ["labeled"]}}


def test_only_pull_requests_write():
    wf = load(HOLD)
    assert wf["permissions"] == {}
    (job,) = wf["jobs"].values()
    assert job["permissions"] == {"pull-requests": "write"}


def test_job_runs_only_for_the_hold_label():
    (job,) = load(HOLD)["jobs"].values()
    assert job["if"] == "github.event.label.name == 'hold'"


def test_no_checkout_environment_or_secrets():
    wf = load(HOLD)
    (job,) = wf["jobs"].values()
    assert "environment" not in job
    for step in job["steps"]:
        assert not str(step.get("uses", "")).startswith("actions/checkout")
    assert not re.search(r"secrets\.\w", HOLD.read_text())


def test_run_block_has_no_expressions_and_disarms():
    (job,) = load(HOLD)["jobs"].values()
    (step,) = job["steps"]
    assert "${{" not in step["run"]
    assert "gh pr merge --disable-auto" in step["run"]
    assert step["env"]["GH_TOKEN"] == "${{ github.token }}"
    assert step["env"]["PR_URL"] == "${{ github.event.pull_request.html_url }}"
    assert "continue-on-error" not in step and "|| true" not in step["run"]


def test_automerge_workflow_still_has_no_pull_request_triggers():
    triggers = load(WORKFLOWS / "automerge.yml")["on"]
    assert not {"pull_request", "pull_request_target"} & set(triggers)
