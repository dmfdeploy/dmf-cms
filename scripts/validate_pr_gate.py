#!/usr/bin/env python3
"""Run the dco, issue-link and commitlint gates for a pull request or a push.

On a pull_request event the gates read the pull request named by the event. On
a push to main they find the merged pull request for the pushed commit and
validate that pull request and its own commits. A rebase merge rewrites
commit SHAs, so the pushed commit is never one of the pull request's commits.

A push that no merged pull request explains fails. So does a push that
several pull requests claim.

Usage: validate_pr_gate.py {dco|issue-link|commitlint}

Environment:
  GITHUB_EVENT_NAME  pull_request or push
  GITHUB_REPOSITORY  owner/name
  GITHUB_SHA         pushed commit (push only)
  GH_TOKEN           token for the gh CLI
  PR_NUMBER          pull request number (pull_request only)
  PR_BODY, PR_LABELS body and space-separated label names from the event
                     payload (pull_request only; a re-run replays them)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable
from typing import Any

BASE_BRANCH = "main"
SIGNOFF_RE = re.compile(r"^Signed-off-by: .+ <.+@.+>", re.IGNORECASE | re.MULTILINE)
CONVENTIONAL_RE = re.compile(
    r"^(feat|fix|docs|chore|refactor|test|build|ci|perf|revert|style)"
    r"(\([a-z0-9._-]+\))?!?: .+"
)
ISSUE_REF_RE = re.compile(
    r"(close[sd]?|fix(e[sd])?|resolve[sd]?|refs?)[\s:]+"
    r"(dmfdeploy/dmfdeploy#[0-9]+|https://github\.com/dmfdeploy/dmfdeploy/issues/[0-9]+)",
    re.IGNORECASE,
)
NO_ISSUE_LABEL = "no-issue"
LOOKUP_ATTEMPTS = 4
LOOKUP_DELAY_SECONDS = 5

Api = Callable[[str], Any]


class GateError(Exception):
    """A gate failure that carries a message for the log."""


def gh_api(path: str) -> Any:
    out = subprocess.run(
        ["gh", "api", path], check=True, capture_output=True, text=True
    ).stdout
    return json.loads(out)


def paginate(api: Api, path: str) -> list[Any]:
    items: list[Any] = []
    page = 1
    sep = "&" if "?" in path else "?"
    while True:
        batch = api(f"{path}{sep}per_page=100&page={page}")
        if not batch:
            return items
        items.extend(batch)
        page += 1


def find_merged_pr(
    api: Api,
    repo: str,
    sha: str,
    sleep: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """Return the one merged pull request into main for a pushed commit."""
    sleep = sleep or time.sleep
    candidates: list[dict[str, Any]] = []
    for attempt in range(LOOKUP_ATTEMPTS):
        prs = paginate(api, f"repos/{repo}/commits/{sha}/pulls")
        candidates = [
            pr
            for pr in prs
            if pr.get("merged_at") and pr.get("base", {}).get("ref") == BASE_BRANCH
        ]
        if candidates:
            break
        if attempt < LOOKUP_ATTEMPTS - 1:
            sleep(LOOKUP_DELAY_SECONDS)
    if not candidates:
        raise GateError(
            f"no merged pull request into {BASE_BRANCH} found for commit {sha}. "
            "Every commit on main must arrive through a pull request."
        )
    if len(candidates) > 1:
        numbers = ", ".join(f"#{pr['number']}" for pr in candidates)
        raise GateError(
            f"commit {sha} maps to several merged pull requests ({numbers}); "
            "cannot pick one to validate."
        )
    return candidates[0]


def pr_commits(api: Api, repo: str, number: int) -> list[dict[str, Any]]:
    commits = paginate(api, f"repos/{repo}/pulls/{number}/commits")
    if not commits:
        raise GateError(f"pull request #{number} has no commits to validate.")
    return commits


def check_dco(commits: list[dict[str, Any]]) -> list[str]:
    return [
        f"commit {c['sha']} missing Signed-off-by trailer (run: git commit -s)"
        for c in commits
        if not SIGNOFF_RE.search(c["commit"]["message"])
    ]


def check_commitlint(commits: list[dict[str, Any]]) -> list[str]:
    errors = []
    for c in commits:
        lines = c["commit"]["message"].splitlines()
        subject = lines[0] if lines else ""
        if subject.startswith("Merge "):
            continue
        if not CONVENTIONAL_RE.match(subject):
            errors.append(f"non-conventional commit subject: {subject}")
    return errors


def check_issue_link(body: str, labels: list[str]) -> list[str]:
    if NO_ISSUE_LABEL in labels:
        return []
    if ISSUE_REF_RE.search(body or ""):
        return []
    return [
        (
            "PR body must reference its tracking issue FULLY QUALIFIED, e.g. "
            "'Refs dmfdeploy/dmfdeploy#32'. Bare #N points at THIS repo, not the "
            "canonical backlog. Trivial change? Add the 'no-issue' label."
        )
    ]


def run_gate(gate: str, env: dict[str, str], api: Api | None = None) -> list[str]:
    """Return the list of failures for a gate; raise GateError if it cannot run."""
    api = api or gh_api
    repo = env["GITHUB_REPOSITORY"]
    event = env["GITHUB_EVENT_NAME"]
    if event == "pull_request":
        number = int(env["PR_NUMBER"])
        body = env.get("PR_BODY", "")
        labels = env.get("PR_LABELS", "").split()
    elif event == "push":
        pr = find_merged_pr(api, repo, env["GITHUB_SHA"])
        number = pr["number"]
        body = pr.get("body") or ""
        labels = [label["name"] for label in pr.get("labels", [])]
        print(f"Validating merged pull request #{number} for {env['GITHUB_SHA']}")
    else:
        raise GateError(f"unsupported event: {event}")

    if gate == "issue-link":
        return check_issue_link(body, labels)
    commits = pr_commits(api, repo, number)
    if gate == "dco":
        return check_dco(commits)
    if gate == "commitlint":
        return check_commitlint(commits)
    raise GateError(f"unknown gate: {gate}")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in {"dco", "issue-link", "commitlint"}:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        errors = run_gate(argv[1], dict(os.environ))
    except GateError as exc:
        print(f"::error::{exc}")
        return 1
    except (KeyError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"::error::{argv[1]} could not run: {exc!r}")
        return 1
    for message in errors:
        print(f"::error::{message}")
    if not errors:
        print(f"OK: {argv[1]}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
