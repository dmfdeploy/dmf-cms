#!/usr/bin/env python3
"""Fail-closed exact-SHA gate for dmf-cms releases.

The release workflow is the only caller with tag and package write permission.
This script validates a merged release PR, dispatches the existing required
workflows, and accepts only their successful check runs on the merged SHA.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

REPOSITORY = "dmfdeploy/dmf-cms"
SOURCE_URL = "https://github.com/dmfdeploy/dmf-cms"
RELEASE_TITLE = re.compile(
    r"^chore\(release\): v(?P<version>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$"
)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
CHECK_APP_ID = 15368  # GitHub Actions integration.
REQUIRED_RULESET = "main-protection"
WORKFLOWS = {
    "ci.yml": {
        "frontend",
        "frontend-e2e",
        "review-comments",
        "test (3.12)",
        "test (3.13)",
        "working-model",
    },
    "guard.yml": {"actionlint", "commitlint", "gitleaks", "trivy"},
    "dco.yml": {"dco"},
    "issue-link.yml": {"issue-link"},
}


class GateError(RuntimeError):
    """A release precondition failed; no tag or publication may follow."""


def _gh_api(path: str, method: str = "GET", fields: dict[str, str] | None = None) -> Any:
    command = ["gh", "api", "-X", method]
    for key, value in (fields or {}).items():
        command.extend(["-f", f"{key}={value}"])
    command.append(path)
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode:
        raise GateError(f"GitHub API {method} {path} failed: {result.stderr.strip()}")
    if not result.stdout.strip():
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise GateError(f"GitHub API {method} {path} returned invalid JSON") from exc


def _gh_api_pages(path: str) -> list[Any]:
    result = subprocess.run(
        ["gh", "api", "--paginate", "--slurp", path],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise GateError(f"GitHub API pagination {path} failed: {result.stderr.strip()}")
    try:
        pages = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise GateError(f"GitHub API pagination {path} returned invalid JSON") from exc
    if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
        raise GateError(f"GitHub API pagination {path} returned an invalid page shape")
    return [item for page in pages for item in page]


def _public_api(path: str) -> Any:
    """Read public repository metadata without broadening GITHUB_TOKEN."""
    if not path.startswith("repos/dmfdeploy/dmf-cms/rulesets"):
        raise GateError("anonymous GitHub API access is limited to public ruleset metadata")
    request = Request(
        f"https://api.github.com/{path}",
        headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except Exception as exc:
        raise GateError("could not read public main-protection ruleset metadata") from exc


def _public_api_pages(path: str) -> list[Any]:
    if not path.startswith("repos/dmfdeploy/dmf-cms/rulesets?"):
        raise GateError("anonymous GitHub API access is limited to public ruleset metadata")
    request = Request(
        f"https://api.github.com/{path}",
        headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            if 'rel="next"' in response.headers.get("Link", ""):
                raise GateError("public ruleset list exceeds the supported single-page bound")
            data = json.loads(response.read())
    except GateError:
        raise
    except Exception as exc:
        raise GateError("could not read public main-protection ruleset list") from exc
    if not isinstance(data, list):
        raise GateError("public ruleset list response is malformed")
    return data


def _repo() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", REPOSITORY)
    if repo != REPOSITORY:
        raise GateError(f"release workflow is running in unexpected repository {repo!r}")
    return repo


def _release_pr_number(event: dict[str, Any]) -> int:
    payload = event.get("client_payload")
    raw = payload.get("pr_number") if isinstance(payload, dict) else None
    if isinstance(raw, bool) or not isinstance(raw, (str, int)) or not str(raw).isdigit():
        raise GateError("repository_dispatch must include a numeric client_payload.pr_number")
    number = int(raw)
    if number < 1:
        raise GateError("release PR number must be positive")
    return number


def validate_release_pr(pr: dict[str, Any], main_sha: str, version_file: str) -> dict[str, str]:
    if pr.get("state") != "closed" or not pr.get("merged") or not pr.get("merged_at"):
        raise GateError("release PR must be merged before the release dispatch")
    base = pr.get("base")
    if not isinstance(base, dict) or base.get("ref") != "main":
        raise GateError("release PR must target main")
    match = RELEASE_TITLE.fullmatch(str(pr.get("title", "")))
    if not match:
        raise GateError("release PR title must be exactly 'chore(release): v<VERSION>'")
    version = match.group("version")
    if version_file.strip() != version:
        raise GateError("VERSION at the merged SHA does not match the release PR title")
    sha = pr.get("merge_commit_sha")
    if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
        raise GateError("GitHub did not provide a full merged commit SHA")
    if main_sha != sha:
        raise GateError("release commit is no longer the tip of main; retry only after review")
    if pr.get("draft"):
        raise GateError("release PR cannot be a draft")
    return {"sha": sha, "version": version, "pr_number": str(pr.get("number", ""))}


def _validate_dispatch_environment(expected_sha: str, release_pr: str) -> None:
    if not SHA_RE.fullmatch(expected_sha):
        raise GateError("expected_sha must be a full lowercase commit SHA")
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise GateError("release checks must run on refs/heads/main")
    if os.environ.get("GITHUB_SHA") != expected_sha:
        raise GateError("dispatched check workflow SHA differs from expected_sha")
    if not release_pr.isdigit() or int(release_pr) < 1:
        raise GateError("release_pr must be a positive PR number")


def _read_version_at(sha: str) -> str:
    result = subprocess.run(
        ["git", "show", f"{sha}:VERSION"], check=False, capture_output=True, text=True
    )
    if result.returncode:
        raise GateError("could not read VERSION from the merged release commit")
    return result.stdout.strip()


def validate_event() -> dict[str, str]:
    _repo()
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        raise GateError("GITHUB_EVENT_PATH is required")
    try:
        with open(event_path, encoding="utf-8") as event_file:
            event = json.load(event_file)
    except (OSError, json.JSONDecodeError) as exc:
        raise GateError("repository_dispatch event payload cannot be read") from exc
    if event.get("action") != "cms-release":
        raise GateError("only the cms-release repository_dispatch event is accepted")
    number = _release_pr_number(event)
    pr = _gh_api(f"repos/{REPOSITORY}/pulls/{number}")
    if not isinstance(pr, dict) or pr.get("number") != number:
        raise GateError("release PR lookup did not return the requested PR")
    sha = pr.get("merge_commit_sha")
    if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
        raise GateError("release PR has no valid merged SHA")
    main = _gh_api(f"repos/{REPOSITORY}/commits/main")
    main_sha = main.get("sha") if isinstance(main, dict) else None
    info = validate_release_pr(pr, str(main_sha or ""), _read_version_at(sha))
    info["pr_number"] = str(number)
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    if not run_id.isdigit():
        raise GateError("release workflow run ID is missing")
    run = _gh_api(f"repos/{REPOSITORY}/actions/runs/{run_id}")
    if (
        not isinstance(run, dict)
        or run.get("event") != "repository_dispatch"
        or run.get("head_sha") != os.environ.get("GITHUB_SHA")
        or run.get("head_branch") != "main"
        or run.get("path") != ".github/workflows/release.yml"
    ):
        raise GateError("current run is not the trusted default-main release workflow")
    info["dispatch_started_at"] = str(run.get("created_at", ""))
    _parse_time(info["dispatch_started_at"])
    return info


def _write_output(info: dict[str, str]) -> None:
    output = os.environ.get("GITHUB_OUTPUT")
    if not output:
        raise GateError("GITHUB_OUTPUT is required")
    with open(output, "a", encoding="utf-8") as stream:
        for key, value in info.items():
            if "\n" in value or "\r" in value:
                raise GateError(f"unsafe line break in output {key}")
            stream.write(f"{key}={value}\n")


def dispatch_checks(sha: str, pr_number: str) -> None:
    _validate_dispatch_environment(sha, pr_number)
    for workflow in WORKFLOWS:
        _gh_api(
            f"repos/{REPOSITORY}/actions/workflows/{workflow}/dispatches",
            method="POST",
            fields={
                "ref": "main",
                "inputs[expected_sha]": sha,
                "inputs[release_pr]": pr_number,
            },
        )


def _parse_time(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise GateError(f"timestamp lacks timezone: {value!r}")
    return parsed.astimezone(dt.timezone.utc)


def _ruleset_contexts() -> set[str]:
    rulesets = _public_api_pages(f"repos/{REPOSITORY}/rulesets?per_page=100")
    if any(not isinstance(item, dict) for item in rulesets):
        raise GateError("public ruleset list contains a malformed item")
    matches = [
        item
        for item in rulesets
        if item.get("name") == REQUIRED_RULESET
        and item.get("enforcement") == "active"
        and item.get("target") == "branch"
        and item.get("source_type") == "Repository"
        and item.get("source") == REPOSITORY
    ]
    if len(matches) != 1:
        raise GateError("exactly one active main-protection branch ruleset is required")
    ruleset = _public_api(f"repos/{REPOSITORY}/rulesets/{matches[0]['id']}")
    if not isinstance(ruleset, dict) or ruleset.get("enforcement") != "active":
        raise GateError("main-protection ruleset detail is missing or inactive")
    conditions = ruleset.get("conditions")
    refs = conditions.get("ref_name") if isinstance(conditions, dict) else None
    if (
        not isinstance(refs, dict)
        or refs.get("include") != ["~DEFAULT_BRANCH"]
        or refs.get("exclude") != []
    ):
        raise GateError("main-protection must target only the repository default branch")
    rules = ruleset.get("rules")
    if not isinstance(rules, list):
        raise GateError("main-protection rules list is missing")
    check_rules = [rule for rule in rules if rule.get("type") == "required_status_checks"]
    if len(check_rules) != 1:
        raise GateError("main-protection must contain exactly one required-status-checks rule")
    parameters = check_rules[0].get("parameters")
    checks = parameters.get("required_status_checks") if isinstance(parameters, dict) else None
    if not isinstance(checks, list) or not checks:
        raise GateError("main-protection required-check list is empty or malformed")
    names: list[str] = []
    for check in checks:
        if not isinstance(check, dict) or not isinstance(check.get("context"), str):
            raise GateError("main-protection contains a malformed check context")
        name = check["context"].strip()
        if not name or name in names:
            raise GateError("main-protection contains an empty or duplicate check context")
        names.append(name)
        app_id = check.get("app_id")
        if app_id not in (None, CHECK_APP_ID):
            raise GateError(f"ruleset context {name!r} is bound to unexpected app {app_id!r}")
    if set(names) != set().union(*WORKFLOWS.values()):
        raise GateError("live main-protection contexts do not match the dispatched workflow jobs")
    return set(names)


def _workflow_runs(sha: str, started_at: dt.datetime) -> dict[str, dict[str, Any]]:
    runs = _gh_api_pages(
        f"repos/{REPOSITORY}/actions/runs?event=workflow_dispatch&branch=main&head_sha={sha}&per_page=100"
    )
    found: dict[str, dict[str, Any]] = {}
    expected_paths = {f".github/workflows/{name}" for name in WORKFLOWS}
    for run in runs:
        if run.get("event") != "workflow_dispatch" or run.get("head_sha") != sha:
            continue
        if run.get("head_branch") != "main" or run.get("path") not in expected_paths:
            continue
        created = _parse_time(run.get("created_at", ""))
        if created < started_at:
            continue
        path = run["path"].rsplit("/", 1)[-1]
        if path in found:
            raise GateError(f"multiple fresh workflow_dispatch runs found for {path}")
        found[path] = run
    return found


def _workflow_job_check(job: dict[str, Any], sha: str, started_at: dt.datetime) -> dict[str, Any]:
    if job.get("head_sha") != sha:
        raise GateError(f"job {job.get('name')!r} ran on a different commit")
    if job.get("status") != "completed" or job.get("conclusion") != "success":
        raise GateError(f"job {job.get('name')!r} did not complete successfully")
    url = job.get("check_run_url")
    if not isinstance(url, str):
        raise GateError(f"job {job.get('name')!r} has no check-run URL")
    parsed = urlparse(url)
    if parsed.netloc != "api.github.com" or not parsed.path.startswith(f"/repos/{REPOSITORY}/check-runs/"):
        raise GateError(f"job {job.get('name')!r} has an unexpected check-run URL")
    check = _gh_api(parsed.path.lstrip("/"))
    if not isinstance(check, dict):
        raise GateError(f"job {job.get('name')!r} check-run lookup failed")
    if check.get("name") != job.get("name") or check.get("head_sha") != sha:
        raise GateError(f"check run for {job.get('name')!r} has a mismatched name or SHA")
    app = check.get("app")
    if not isinstance(app, dict) or app.get("id") != CHECK_APP_ID:
        raise GateError(f"check run {job.get('name')!r} is not from GitHub Actions")
    if check.get("status") != "completed" or check.get("conclusion") != "success":
        raise GateError(f"required check {job.get('name')!r} did not succeed")
    started = _parse_time(str(check.get("started_at", "")))
    if started < started_at:
        raise GateError(f"check {job.get('name')!r} is older than this release request")
    return check


def checks_complete(sha: str, pr_number: str, started_at: str) -> bool:
    _validate_dispatch_environment(sha, pr_number)
    start = _parse_time(started_at)
    expected_contexts = _ruleset_contexts()
    runs = _workflow_runs(sha, start)
    if set(runs) != set(WORKFLOWS):
        return False
    completed_contexts: set[str] = set()
    for filename, expected_jobs in WORKFLOWS.items():
        run = runs[filename]
        if run.get("status") != "completed":
            return False
        if run.get("conclusion") != "success":
            raise GateError(f"required workflow {filename} did not succeed")
        jobs = _gh_api_pages(f"repos/{REPOSITORY}/actions/runs/{run['id']}/jobs?per_page=100")
        job_names = [job.get("name") for job in jobs]
        actual_jobs = set(job_names)
        if len(job_names) != len(actual_jobs) or actual_jobs != expected_jobs:
            raise GateError(f"workflow {filename} job set differs from expected protected contexts")
        for job in jobs:
            _workflow_job_check(job, sha, start)
            completed_contexts.add(str(job["name"]))
    if completed_contexts != expected_contexts:
        raise GateError("fresh dispatched checks do not cover the live ruleset context set")
    return True


def inspect_existing_ghcr_image(version: str, sha: str) -> bool:
    """Accept an existing public tag only when its OCI labels match this release."""
    image = f"ghcr.io/dmfdeploy/dmf-cms:{version}"
    pull = subprocess.run(["docker", "pull", image], check=False, capture_output=True, text=True)
    if pull.returncode:
        output = f"{pull.stdout}\n{pull.stderr}".lower()
        if "manifest unknown" in output or "manifest not found" in output:
            return False
        raise GateError("could not safely determine whether the GHCR image tag exists")
    inspect = subprocess.run(
        ["docker", "image", "inspect", image, "--format", "{{json .Config.Labels}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if inspect.returncode:
        raise GateError("could not read labels from the existing GHCR image")
    try:
        labels = json.loads(inspect.stdout)
    except json.JSONDecodeError as exc:
        raise GateError("existing GHCR image labels are malformed") from exc
    if not isinstance(labels, dict):
        raise GateError("existing GHCR image has no label map")
    if labels.get("org.opencontainers.image.version") != version:
        raise GateError("existing GHCR image version label conflicts with the release")
    if labels.get("org.opencontainers.image.revision") != sha:
        raise GateError("existing GHCR image revision label conflicts with the release SHA")
    if labels.get("org.opencontainers.image.source") != SOURCE_URL:
        raise GateError("existing GHCR image source label conflicts with this repository")
    return True


def wait_for_checks(sha: str, pr_number: str, started_at: str, timeout: int = 2400) -> None:
    _validate_dispatch_environment(sha, pr_number)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if checks_complete(sha, pr_number, started_at):
            return
        time.sleep(15)
    raise GateError("timed out waiting for exact-SHA required checks")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate-event")
    dispatch = sub.add_parser("dispatch")
    dispatch.add_argument("--sha", required=True)
    dispatch.add_argument("--pr", required=True)
    wait = sub.add_parser("wait")
    wait.add_argument("--sha", required=True)
    wait.add_argument("--pr", required=True)
    wait.add_argument("--started-at", required=True)
    wait.add_argument("--timeout", type=int, default=2400)
    image = sub.add_parser("inspect-ghcr")
    image.add_argument("--version", required=True)
    image.add_argument("--sha", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "validate-event":
            _write_output(validate_event())
        elif args.command == "dispatch":
            dispatch_checks(args.sha, args.pr)
        elif args.command == "wait":
            wait_for_checks(args.sha, args.pr, args.started_at, args.timeout)
        else:
            if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", args.version):
                raise GateError("version must be strict MAJOR.MINOR.PATCH semver")
            if not SHA_RE.fullmatch(args.sha):
                raise GateError("SHA must be a full lowercase commit SHA")
            print("true" if inspect_existing_ghcr_image(args.version, args.sha) else "false")
    except GateError as exc:
        print(f"release gate failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
