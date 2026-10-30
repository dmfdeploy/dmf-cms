#!/usr/bin/env python3
"""Arm or perform auto-merge on dmf-cms pull requests with a GitHub App token.

The `automerge` workflow calls this script from the default branch. It never
checks out or runs pull request code. It reads every pull request through the
API and never trusts an event payload for labels, draft state, or head SHA.

Usage:
    automerge.py event --sha <40-hex head SHA of the finished CI run>
    automerge.py sweep

Environment:
    GITHUB_REPOSITORY  owner/name of the repository.
    GH_TOKEN           GitHub App installation token. Used for every call
                       except the Actions run lookup.
    GH_READ_TOKEN      Optional token with `actions: read`, used only to list
                       Actions runs. Falls back to GH_TOKEN.

Exit status is non-zero when any pull request hit an unexpected error. A pull
request that is not eligible, or whose CI has not passed, is not an error.

Design: dmfdeploy/dmfdeploy docs/plans/dmf-cms-exact-sha-release-gate-plan.md,
section "Merge".
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

BASE_BRANCH = "main"
HOLD_LABEL = "hold"
CI_WORKFLOW_NAME = "CI"
PAGE_SIZE = 100
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

ARM_MUTATION = """
mutation($id: ID!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: {
    pullRequestId: $id, mergeMethod: REBASE, expectedHeadOid: $head
  }) { pullRequest { number autoMergeRequest { enabledAt } } }
}
""".strip()

DISARM_MUTATION = """
mutation($id: ID!) {
  disablePullRequestAutoMerge(input: {pullRequestId: $id}) {
    pullRequest { number }
  }
}
""".strip()


class GhError(Exception):
    """A GitHub call failed. `status` is the HTTP status, or 0 if unknown."""

    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}" if status else message)
        self.status = status
        self.message = message


# api(method, path, params=None, read_only=False) -> parsed JSON
# graphql(query, variables) -> parsed JSON "data" object
Api = Callable[..., Any]
Graphql = Callable[[str, "dict[str, str]"], Any]


@dataclass
class Result:
    number: int
    action: str  # armed, merged, already-armed, disarmed, skipped, stale, error
    detail: str = ""

    @property
    def is_error(self) -> bool:
        return self.action == "error"


# --------------------------------------------------------------------------
# gh transport
# --------------------------------------------------------------------------

_STATUS_RE = re.compile(r"\(HTTP (\d{3})\)")


def _gh(args: list[str], token: str | None) -> str:
    env = dict(os.environ)
    if token:
        env["GH_TOKEN"] = token
    proc = subprocess.run(
        ["gh", *args], capture_output=True, text=True, env=env, check=False
    )
    if proc.returncode != 0:
        text = (proc.stdout + "\n" + proc.stderr).strip()
        match = _STATUS_RE.search(text)
        message = text
        try:
            body = json.loads(proc.stdout)
            if isinstance(body, dict):
                if body.get("message"):
                    message = str(body["message"])
                elif body.get("errors"):
                    message = "; ".join(
                        str(e.get("message", e)) if isinstance(e, dict) else str(e)
                        for e in body["errors"]
                    )
        except ValueError:
            pass
        raise GhError(int(match.group(1)) if match else 0, message)
    return proc.stdout


def make_transport(read_token: str | None) -> tuple[Api, Graphql]:
    def api(
        method: str,
        path: str,
        params: dict[str, str] | None = None,
        read_only: bool = False,
    ) -> Any:
        args = ["api", "-X", method, path]
        for key, value in (params or {}).items():
            args += ["-f", f"{key}={value}"]
        out = _gh(args, read_token if read_only else None)
        return json.loads(out) if out.strip() else {}

    def graphql(query: str, variables: dict[str, str]) -> Any:
        args = ["api", "graphql", "-f", f"query={query}"]
        for key, value in variables.items():
            args += ["-f", f"{key}={value}"]
        body = json.loads(_gh(args, None) or "{}")
        if body.get("errors"):
            raise GhError(
                200,
                "; ".join(str(e.get("message", e)) for e in body["errors"]),
            )
        return body.get("data")

    return api, graphql


# --------------------------------------------------------------------------
# Eligibility and lookups
# --------------------------------------------------------------------------


def ineligible_reason(pr: dict[str, Any], repo: str) -> str | None:
    """Return why a live pull request must be left alone, or None."""
    if pr.get("state") != "open" or pr.get("merged"):
        return "not open"
    if pr.get("draft") is not False:
        return "draft"
    if (pr.get("base") or {}).get("ref") != BASE_BRANCH:
        return f"base is not {BASE_BRANCH}"
    head_repo = ((pr.get("head") or {}).get("repo") or {}).get("full_name")
    if head_repo != repo:
        return "head is not in this repository"
    labels = pr.get("labels")
    if not isinstance(labels, list):
        return "labels unreadable"
    if any((label or {}).get("name") == HOLD_LABEL for label in labels):
        return "hold label"
    return None


def paginate(api: Api, path: str, params: dict[str, str], key: str | None = None):
    """Yield items from every page. Stops on a page shorter than PAGE_SIZE."""
    page = 1
    while True:
        body = api(
            "GET",
            path,
            {**params, "per_page": str(PAGE_SIZE), "page": str(page)},
            read_only=key is not None,
        )
        items = body[key] if key else body
        yield from items
        if len(items) < PAGE_SIZE:
            return
        page += 1


def ci_succeeded(api: Api, repo: str, sha: str) -> bool:
    """True if a completed `CI` run with conclusion success exists for sha."""
    runs = paginate(
        api, f"repos/{repo}/actions/runs", {"head_sha": sha}, key="workflow_runs"
    )
    return any(
        run.get("name") == CI_WORKFLOW_NAME
        and run.get("head_sha") == sha
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        for run in runs
    )


# --------------------------------------------------------------------------
# Arm or merge
# --------------------------------------------------------------------------


def _is_stale_head(err: GhError) -> bool:
    text = err.message.lower()
    return "head branch was modified" in text or "expected head" in text


def _is_clean_status(err: GhError) -> bool:
    return "clean status" in err.message.lower()


def _is_already_armed(err: GhError) -> bool:
    text = err.message.lower()
    return "auto merge" in text and "already" in text


def arm_or_merge(
    api: Api, graphql: Graphql, repo: str, pr: dict[str, Any], expected_head: str
) -> Result:
    """Arm rebase auto-merge bound to expected_head. Merge if already clean."""
    number = pr["number"]
    if pr.get("auto_merge"):
        return Result(number, "already-armed")
    try:
        graphql(ARM_MUTATION, {"id": pr["node_id"], "head": expected_head})
        return Result(number, "armed", expected_head)
    except GhError as err:
        if _is_stale_head(err):
            return Result(number, "stale", "head changed before arming")
        if _is_already_armed(err):
            return Result(number, "already-armed")
        if not _is_clean_status(err):
            raise
    # Checks passed before arming: the pull request is mergeable now, so
    # merge with the same token. `sha` makes GitHub reject a changed head.
    try:
        api(
            "PUT",
            f"repos/{repo}/pulls/{number}/merge",
            {"merge_method": "rebase", "sha": expected_head},
        )
        return Result(number, "merged", expected_head)
    except GhError as err:
        if err.status == 409 or _is_stale_head(err):
            return Result(number, "stale", "head changed before merging")
        live = api("GET", f"repos/{repo}/pulls/{number}")
        if live.get("merged") or live.get("state") == "closed":
            return Result(number, "skipped", "already closed or merged")
        raise


def _is_held_and_armed(pr: dict[str, Any]) -> bool:
    labels = pr.get("labels")
    return (
        pr.get("state") == "open"
        and (pr.get("base") or {}).get("ref") == BASE_BRANCH
        and bool(pr.get("auto_merge"))
        and isinstance(labels, list)
        and any((label or {}).get("name") == HOLD_LABEL for label in labels)
    )


def handle_pr(
    api: Api,
    graphql: Graphql,
    repo: str,
    number: int,
    expected_head: str,
    require_ci: bool,
) -> Result:
    """Process one pull request. Never raises: errors become Result("error").

    The sweep (require_ci) also disarms a held pull request that has
    auto-merge enabled; `hold` is the brake that stops a merge.
    """
    try:
        pr = api("GET", f"repos/{repo}/pulls/{number}")
        if require_ci and _is_held_and_armed(pr):
            graphql(DISARM_MUTATION, {"id": pr["node_id"]})
            return Result(number, "disarmed", "hold label")
        if require_ci and not ci_succeeded(api, repo, expected_head):
            return Result(number, "skipped", "no completed CI success for head")
        reason = ineligible_reason(pr, repo)
        if reason:
            return Result(number, "skipped", reason)
        if pr["head"]["sha"] != expected_head:
            return Result(number, "skipped", "head moved since the read")
        return arm_or_merge(api, graphql, repo, pr, expected_head)
    except GhError as err:
        return Result(number, "error", str(err))
    except (KeyError, TypeError, ValueError) as err:
        return Result(number, "error", f"unexpected response shape: {err!r}")


# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------


def run_event(api: Api, graphql: Graphql, repo: str, sha: str) -> list[Result]:
    """Event path: the pull request whose head is the finished CI run's SHA."""
    if not SHA_RE.match(sha):
        raise SystemExit(f"not a 40-character lowercase hex SHA: {sha!r}")
    candidates = api("GET", f"repos/{repo}/commits/{sha}/pulls")
    numbers = [
        pr["number"]
        for pr in candidates
        if (pr.get("head") or {}).get("sha") == sha
        and pr.get("state") == "open"
        and (pr.get("base") or {}).get("ref") == BASE_BRANCH
    ]
    return [handle_pr(api, graphql, repo, n, sha, require_ci=False) for n in numbers]


def run_sweep(api: Api, graphql: Graphql, repo: str) -> list[Result]:
    """Schedule path: every open pull request into main, CI success required."""
    results: list[Result] = []
    listing = paginate(
        api, f"repos/{repo}/pulls", {"state": "open", "base": BASE_BRANCH}
    )
    for item in listing:
        results.append(
            handle_pr(
                api,
                graphql,
                repo,
                item["number"],
                item["head"]["sha"],
                require_ci=True,
            )
        )
    return results


def report(results: list[Result]) -> int:
    failed = 0
    for r in results:
        line = f"#{r.number}: {r.action}" + (f" ({r.detail})" if r.detail else "")
        if r.is_error:
            failed += 1
            print(f"::error::{line}")
        else:
            print(line)
    if not results:
        print("no pull requests to act on")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="mode", required=True)
    event = sub.add_parser("event")
    event.add_argument("--sha", required=True)
    sub.add_parser("sweep")
    args = parser.parse_args(argv)

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not re.match(r"^[\w.-]+/[\w.-]+$", repo):
        raise SystemExit("GITHUB_REPOSITORY is not set to owner/name")
    api, graphql = make_transport(os.environ.get("GH_READ_TOKEN"))
    try:
        if args.mode == "event":
            results = run_event(api, graphql, repo, args.sha)
        else:
            results = run_sweep(api, graphql, repo)
    except GhError as err:
        print(f"::error::listing pull requests failed: {err}")
        return 1
    return report(results)


if __name__ == "__main__":
    sys.exit(main())
