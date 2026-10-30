"""Every required `main-protection` context must complete on a push to main.

The ruleset requires twelve contexts. A job that is skipped on a push, or a
workflow with no push trigger for main, leaves its context without a result on
the merged commit (dmfdeploy/dmfdeploy#568). The ruleset lives in GitHub
settings, so the context list is pinned here; the test reads the real workflow
files.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"

# context -> (workflow file, job id, workflow display name)
REQUIRED_CONTEXTS: dict[str, tuple[str, str, str]] = {
    "test (3.12)": ("ci.yml", "test", "CI"),
    "test (3.13)": ("ci.yml", "test", "CI"),
    "frontend": ("ci.yml", "frontend", "CI"),
    "frontend-e2e": ("ci.yml", "frontend-e2e", "CI"),
    "review-comments": ("ci.yml", "review-comments", "CI"),
    "working-model": ("ci.yml", "working-model", "CI"),
    "gitleaks": ("guard.yml", "gitleaks", "guard"),
    "trivy": ("guard.yml", "trivy", "guard"),
    "actionlint": ("guard.yml", "actionlint", "guard"),
    "commitlint": ("guard.yml", "commitlint", "guard"),
    "dco": ("dco.yml", "dco", "DCO"),
    "issue-link": ("issue-link.yml", "issue-link", "issue-link"),
}


def _load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text())


def _triggers(workflow: dict) -> dict:
    # PyYAML reads the bare key `on` as the boolean True.
    on = workflow.get("on", workflow.get(True))
    if isinstance(on, str):
        return {on: None}
    if isinstance(on, list):
        return {event: None for event in on}
    return on or {}


def _push_trigger_covers_main(workflow: dict) -> bool:
    triggers = _triggers(workflow)
    if "push" not in triggers:
        return False
    push = triggers["push"] or {}
    branches = push.get("branches")
    if branches is None:
        return "branches-ignore" not in push or "main" not in push["branches-ignore"]
    return "main" in branches


def _if_excludes_push(condition: object) -> bool:
    """True when a job `if` is false for a push event.

    Handles the forms in use: equality against github.event_name, with or
    without a surrounding ${{ }}. Anything that names an event other than push
    and never names push is treated as excluding it.
    """
    if condition is None or condition is True:
        return False
    if condition is False:
        return True
    text = str(condition)
    if "github.event_name" not in text:
        return False
    named = set(re.findall(r"github\.event_name\s*==\s*'([a-z_]+)'", text))
    negated = set(re.findall(r"github\.event_name\s*!=\s*'([a-z_]+)'", text))
    if "push" in negated:
        return True
    return bool(named) and "push" not in named


def _problems() -> list[str]:
    problems = []
    for context, (filename, job_id, display) in REQUIRED_CONTEXTS.items():
        workflow = _load(filename)
        if workflow.get("name") != display:
            problems.append(f"{context}: {filename} name is {workflow.get('name')!r}")
        if not _push_trigger_covers_main(workflow):
            problems.append(f"{context}: {filename} has no push trigger for main")
        job = workflow.get("jobs", {}).get(job_id)
        if job is None:
            problems.append(f"{context}: job {job_id} missing from {filename}")
        elif _if_excludes_push(job.get("if")):
            problems.append(f"{context}: job {job_id} `if` excludes push: {job['if']}")
    return problems


def test_every_required_context_runs_on_push_to_main() -> None:
    assert _problems() == []


def test_workflow_display_names_are_exact() -> None:
    names = {
        f.name: yaml.safe_load(f.read_text()).get("name")
        for f in WORKFLOWS.glob("*.yml")
    }
    assert {names[f] for f in ("ci.yml", "guard.yml", "dco.yml", "issue-link.yml")} == {
        "CI",
        "guard",
        "DCO",
        "issue-link",
    }
    assert names["ci.yml"] == "CI"
    assert names["guard.yml"] == "guard"
    assert names["dco.yml"] == "DCO"
    assert names["issue-link.yml"] == "issue-link"


def test_matrix_contexts_match_the_ci_matrix() -> None:
    versions = _load("ci.yml")["jobs"]["test"]["strategy"]["matrix"]["python-version"]
    assert {f"test ({v})" for v in versions} == {
        c for c in REQUIRED_CONTEXTS if c.startswith("test (")
    }


@pytest.mark.parametrize(
    ("condition", "excluded"),
    [
        (None, False),
        ("github.event_name == 'pull_request'", True),
        ("${{ github.event_name == 'pull_request' }}", True),
        ("github.event_name != 'push'", True),
        ("github.event_name == 'push'", False),
        ("github.event_name == 'push' || github.event_name == 'pull_request'", False),
        ("${{ !cancelled() }}", False),
        (False, True),
    ],
)
def test_if_classifier(condition: object, excluded: bool) -> None:
    assert _if_excludes_push(condition) is excluded


def test_push_trigger_classifier() -> None:
    assert _push_trigger_covers_main({"on": {"push": {"branches": ["main"]}}})
    assert not _push_trigger_covers_main({"on": {"pull_request": {"branches": ["main"]}}})
    assert not _push_trigger_covers_main({"on": {"push": {"branches": ["dev"]}}})
