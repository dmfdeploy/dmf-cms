#!/usr/bin/env python3
"""Exact-SHA release gate for dmf-cms.

The release workflow (.github/workflows/release.yml) calls this script. It
decides whether one commit on main may be released and, in the serialized
release job, creates the tag.

Checks, in the order the plan numbers them:

1. The commit is reachable from main.
2. The commit is a release bump: its subject is "chore(release): vX.Y.Z", it
   changes VERSION, VERSION reads X.Y.Z, and a qualified umbrella issue
   reference is on the commit or on its merged pull request.
3. Every context that the live "main-protection" ruleset requires has exactly
   one fresh, completed "success" check run from GitHub Actions on this SHA,
   produced by a push run of the owning workflow on main.
   The commit also needs creation of "v*" tags restricted by an active
   "tags-release-create" ruleset (the sole-bypass-actor property is verified
   by an owner at rollout; the job cannot read it).
4. No existing "v*" tag is higher than VERSION. An equal tag is accepted only
   at this SHA.

Subcommands:

    verify          Checks 1 to 3 for the verify job. Not ready is a quiet
                    success; a broken release is a failure.
    check           Checks 1 to 3 for the release job. Not ready fails.
    version-rule    Check 4 only. Reports whether the tag exists.
    tag             Checks 1 to 4 again, then creates the tag if it is absent.
    check-labels    Compares image labels (JSON on stdin) with VERSION and SHA.
    inspect-ghcr    Reports whether the published image exists, and verifies
                    its labels when it does.
    digest          Reads RepoDigests (JSON on stdin) and prints the digest.

Reads use GH_TOKEN. The tag POST uses RELEASE_TAG_TOKEN only, so the release
App token is never used to read and GITHUB_TOKEN is never used to write a tag.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
from typing import Any, NamedTuple

REPOSITORY = "dmfdeploy/dmf-cms"
SOURCE_URL = "https://github.com/dmfdeploy/dmf-cms"
IMAGE = "ghcr.io/dmfdeploy/dmf-cms"
CHECK_APP_ID = 15368  # The GitHub Actions integration.
REQUIRED_RULESET = "main-protection"
TAG_CREATE_RULESET = "tags-release-create"
RELEASE_TAG_PATTERN = "refs/tags/v*"

SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
SEMVER_RE = re.compile(rf"^{SEMVER}$")
RELEASE_SUBJECT_RE = re.compile(rf"^chore\(release\): v(?P<version>{SEMVER})$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
QUALIFIED_ISSUE_RE = re.compile(r"(?<![\w/])dmfdeploy/dmfdeploy#[1-9][0-9]*(?![0-9])")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

# Workflow file -> (display name, the contexts its jobs produce). The display
# name is what `workflow_run.workflows` matches; the contexts are what
# main-protection requires.
WORKFLOWS: dict[str, tuple[str, frozenset[str]]] = {
    ".github/workflows/ci.yml": (
        "CI",
        frozenset(
            {
                "frontend",
                "frontend-e2e",
                "review-comments",
                "test (3.12)",
                "test (3.13)",
                "working-model",
            }
        ),
    ),
    ".github/workflows/guard.yml": (
        "guard",
        frozenset({"actionlint", "commitlint", "gitleaks", "trivy"}),
    ),
    ".github/workflows/dco.yml": ("DCO", frozenset({"dco"})),
    ".github/workflows/issue-link.yml": ("issue-link", frozenset({"issue-link"})),
}
REQUIRED_CONTEXTS = frozenset().union(*(contexts for _, contexts in WORKFLOWS.values()))


class GateError(RuntimeError):
    """A release precondition failed. No tag or publication may follow."""


class NotRelease(GateError):
    """The commit is not a release bump. Not a failure for the verify job."""


# ---------------------------------------------------------------- GitHub API


def unpack_pages(raw: Any, key: str | None, path: str) -> list[Any]:
    """Flatten the output of `gh api --paginate --slurp`.

    `--slurp` wraps every page in one outer array. Most list endpoints return
    a bare array per page. The Actions and Checks endpoints return an
    envelope object, such as {"total_count": 2, "workflow_runs": [...]}, so
    the caller names the key that holds the array.
    """
    if not isinstance(raw, list):
        raise GateError(f"GitHub API pagination {path} did not return a page array")
    items: list[Any] = []
    for page in raw:
        if key is None:
            if not isinstance(page, list):
                raise GateError(f"GitHub API page for {path} is not an array")
            items.extend(page)
        else:
            inner = page.get(key) if isinstance(page, dict) else None
            if not isinstance(inner, list):
                raise GateError(f"GitHub API page for {path} has no {key!r} array")
            items.extend(inner)
    return items


class GitHub:
    """Thin `gh api` wrapper. Tests replace `_run`."""

    def _run(self, args: list[str], token_env: str | None = None) -> Any:
        env = os.environ.copy()
        if token_env is not None:
            token = os.environ.get(token_env, "")
            if not token:
                raise GateError(f"{token_env} is required for this call")
            env["GH_TOKEN"] = token
        result = subprocess.run(
            ["gh", "api", *args], check=False, capture_output=True, text=True, env=env
        )
        if result.returncode:
            raise GateError(f"GitHub API call failed: {' '.join(args)}: {result.stderr.strip()}")
        if not result.stdout.strip():
            return None
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise GateError(f"GitHub API call returned invalid JSON: {' '.join(args)}") from exc

    def get(self, path: str) -> Any:
        return self._run(["-X", "GET", path])

    def pages(self, path: str, key: str | None = None) -> list[Any]:
        return unpack_pages(self._run(["--paginate", "--slurp", path]), key, path)

    def post(self, path: str, fields: dict[str, str]) -> Any:
        args = ["-X", "POST"]
        for name, value in fields.items():
            args += ["-f", f"{name}={value}"]
        return self._run([*args, path], token_env="RELEASE_TAG_TOKEN")


def _repo() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", REPOSITORY)
    if repo != REPOSITORY:
        raise GateError(f"release gate is running in unexpected repository {repo!r}")
    return repo


def _require_sha(sha: str) -> str:
    if not SHA_RE.fullmatch(sha):
        raise GateError("the commit must be a full lowercase SHA")
    return sha


def _as_dict(value: Any, what: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GateError(f"{what} response is malformed")
    return value


# ------------------------------------------------------- checks 1 and 2


def check_reachable(api: GitHub, sha: str) -> None:
    """Check 1: the commit is an ancestor of main, or main itself."""
    comparison = _as_dict(
        api.get(f"repos/{_repo()}/compare/{sha}...main?per_page=1"), "compare"
    )
    # The status describes main relative to the commit.
    if comparison.get("status") not in ("ahead", "identical"):
        raise GateError(f"commit {sha} is not reachable from main")


def check_release_bump(api: GitHub, sha: str) -> str:
    """Check 2: return the version when the commit is a release bump."""
    repo = _repo()
    commit = _as_dict(api.get(f"repos/{repo}/commits/{sha}"), "commit")
    if commit.get("sha") != sha:
        raise GateError("commit lookup returned a different SHA")
    message = _as_dict(commit.get("commit"), "commit").get("message")
    if not isinstance(message, str):
        raise GateError("commit has no message")
    match = RELEASE_SUBJECT_RE.fullmatch(message.splitlines()[0] if message else "")
    if not match:
        raise NotRelease("subject is not 'chore(release): v<VERSION>'")
    version = match.group("version")
    files = commit.get("files")
    if not isinstance(files, list) or not any(
        isinstance(f, dict) and f.get("filename") == "VERSION" for f in files
    ):
        raise NotRelease("commit does not change VERSION")

    content = _as_dict(api.get(f"repos/{repo}/contents/VERSION?ref={sha}"), "contents")
    if content.get("encoding") != "base64" or not isinstance(content.get("content"), str):
        raise GateError("VERSION contents response is malformed")
    try:
        at_sha = base64.b64decode(content["content"]).decode("utf-8").strip()
    except (ValueError, UnicodeDecodeError) as exc:
        raise GateError("VERSION contents cannot be decoded") from exc
    if at_sha != version:
        raise GateError(f"VERSION reads {at_sha!r} but the subject names {version!r}")

    if not QUALIFIED_ISSUE_RE.search(message) and not _merged_pr_has_issue_ref(api, sha):
        raise GateError(
            "release bump has no qualified issue reference (dmfdeploy/dmfdeploy#N) "
            "on the commit or on its merged pull request"
        )
    return version


def _merged_pr_has_issue_ref(api: GitHub, sha: str) -> bool:
    pulls = api.pages(f"repos/{_repo()}/commits/{sha}/pulls?per_page=100")
    for pull in pulls:
        if not isinstance(pull, dict) or not pull.get("merged_at"):
            continue
        base = pull.get("base")
        if not isinstance(base, dict) or base.get("ref") != "main":
            continue
        if QUALIFIED_ISSUE_RE.search(str(pull.get("body") or "")):
            return True
    return False


# ---------------------------------------------------------------- check 3


def required_contexts(api: GitHub) -> set[str]:
    """Read the required contexts from the live main-protection ruleset."""
    repo = _repo()
    rulesets = api.pages(f"repos/{repo}/rulesets?per_page=100")
    active = [
        r
        for r in rulesets
        if isinstance(r, dict)
        and r.get("name") == REQUIRED_RULESET
        and r.get("enforcement") == "active"
        and r.get("target") == "branch"
    ]
    if len(active) != 1:
        raise GateError(
            f"exactly one active {REQUIRED_RULESET} ruleset is required, found {len(active)}"
        )
    ruleset_id = active[0].get("id")

    rules = api.pages(f"repos/{repo}/rules/branches/main?per_page=100")
    status_rules = [
        r for r in rules if isinstance(r, dict) and r.get("type") == "required_status_checks"
    ]
    if any(r.get("ruleset_id") != ruleset_id for r in status_rules):
        raise GateError("a ruleset other than main-protection requires status checks on main")
    if len(status_rules) != 1:
        raise GateError(
            "main-protection must apply exactly one required_status_checks rule to main"
        )
    parameters = status_rules[0].get("parameters")
    checks = parameters.get("required_status_checks") if isinstance(parameters, dict) else None
    if not isinstance(checks, list) or not checks:
        raise GateError("main-protection required-check list is empty or malformed")
    names: list[str] = []
    for check in checks:
        context = check.get("context") if isinstance(check, dict) else None
        if not isinstance(context, str) or not context.strip():
            raise GateError("main-protection holds an empty or malformed check context")
        if context in names:
            raise GateError(f"main-protection lists context {context!r} twice")
        integration = check.get("integration_id")
        if integration not in (None, CHECK_APP_ID):
            raise GateError(f"context {context!r} is bound to integration {integration!r}")
        names.append(context)
    if set(names) != REQUIRED_CONTEXTS:
        raise GateError(
            "live main-protection contexts differ from the contexts this gate maps to "
            f"workflows (live only: {sorted(set(names) - REQUIRED_CONTEXTS)}, "
            f"gate only: {sorted(REQUIRED_CONTEXTS - set(names))})"
        )
    return set(names)


def _workflow_key(path: Any) -> str:
    # Some run payloads append "@<ref>" to the workflow path.
    return str(path).split("@", 1)[0]


def check_contexts(api: GitHub, sha: str) -> list[str]:
    """Check 3. Return the contexts still pending; raise when any one failed.

    Pending means the owning push run has not completed, or its check run has
    not. A pending context never fails the gate: the workflow that completes
    last carries the release. Everything else that is not a fresh success on
    this SHA raises.
    """
    repo = _repo()
    contexts = required_contexts(api)

    runs: dict[str, dict[str, Any]] = {}
    for run in api.pages(
        f"repos/{repo}/actions/runs?head_sha={sha}&event=push&branch=main&per_page=100",
        key="workflow_runs",
    ):
        if not isinstance(run, dict):
            continue
        workflow = _workflow_key(run.get("path"))
        if (
            run.get("head_sha") != sha
            or run.get("event") != "push"
            or run.get("head_branch") != "main"
            or workflow not in WORKFLOWS
        ):
            continue
        if workflow in runs:
            raise GateError(f"more than one push run of {workflow} exists for {sha}")
        runs[workflow] = run

    check_runs = [
        c
        for c in api.pages(f"repos/{repo}/commits/{sha}/check-runs?per_page=100", key="check_runs")
        if isinstance(c, dict)
    ]

    pending: list[str] = []
    failures: list[str] = []
    for workflow, (_, workflow_contexts) in WORKFLOWS.items():
        run = runs.get(workflow)
        run_done = run is not None and run.get("status") == "completed"
        for context in sorted(workflow_contexts & contexts):
            problem = _judge_context(context, check_runs, run, sha)
            if problem == "pending" or (problem == "missing" and not run_done):
                pending.append(context)
            elif problem == "missing":
                failures.append(f"{context}: no check run on this commit")
            elif problem:
                failures.append(f"{context}: {problem}")
    if failures:
        raise GateError("required checks failed: " + "; ".join(failures))
    return pending


def _judge_context(
    context: str, check_runs: list[dict[str, Any]], run: dict[str, Any] | None, sha: str
) -> str | None:
    """Return None for a pass, 'pending', 'missing', or a failure reason."""
    named = [c for c in check_runs if c.get("name") == context]
    if not named:
        return "missing"
    if len(named) > 1:
        return f"{len(named)} check runs share the name"
    check = named[0]
    app = check.get("app")
    if not isinstance(app, dict) or app.get("id") != CHECK_APP_ID:
        return "check run is not from GitHub Actions"
    if check.get("head_sha") != sha:
        return "check run is for another commit"
    suite = check.get("check_suite")
    suite_id = suite.get("id") if isinstance(suite, dict) else None
    if run is None or suite_id is None or suite_id != run.get("check_suite_id"):
        return "check run does not belong to a push run of the owning workflow on main"
    if check.get("status") != "completed":
        return "pending"
    if check.get("conclusion") != "success":
        return f"conclusion is {check.get('conclusion')!r}, not 'success'"
    return None


class Verdict(NamedTuple):
    version: str
    pending: list[str]

    @property
    def ready(self) -> bool:
        return not self.pending


def evaluate(api: GitHub, sha: str) -> Verdict:
    """Checks 1 to 3. Raises NotRelease for an ordinary commit."""
    _require_sha(sha)
    version = check_release_bump(api, sha)
    check_reachable(api, sha)
    check_tag_creation_rule(api)
    return Verdict(version=version, pending=check_contexts(api, sha))


# ------------------------------------------- tag-creation authority (rollout)


def check_tag_creation_rule(api: GitHub) -> None:
    """Fail closed unless creating a v* tag is restricted by tags-release-create.

    Without the rule, any repository writer can create a v* tag outside this
    gate. The job can read the ruleset list and detail with GITHUB_TOKEN. It
    cannot read `bypass_actors`, which GitHub returns only to a caller with
    write access to the ruleset, so this check neither reads nor requires that
    field. That the release App is the sole bypass actor, and that no other
    ruleset grants a bypass, is verified by an owner at rollout (plan step 4).
    """
    repo = _repo()
    named = [
        r
        for r in api.pages(f"repos/{repo}/rulesets?per_page=100")
        if isinstance(r, dict) and r.get("name") == TAG_CREATE_RULESET
    ]
    if len(named) != 1:
        raise GateError(
            f"exactly one {TAG_CREATE_RULESET} ruleset is required to restrict v* tag "
            f"creation, found {len(named)}"
        )
    listed = named[0]
    ruleset_id = listed.get("id")
    if isinstance(ruleset_id, bool) or not isinstance(ruleset_id, int):
        raise GateError(f"{TAG_CREATE_RULESET} ruleset has no valid id")
    if listed.get("enforcement") != "active" or listed.get("target") != "tag":
        raise GateError(f"{TAG_CREATE_RULESET} must be an active ruleset with target 'tag'")

    detail = _as_dict(api.get(f"repos/{repo}/rulesets/{ruleset_id}"), TAG_CREATE_RULESET)
    if (
        detail.get("id") != ruleset_id
        or detail.get("name") != TAG_CREATE_RULESET
        or detail.get("enforcement") != "active"
        or detail.get("target") != "tag"
    ):
        raise GateError(f"{TAG_CREATE_RULESET} detail does not match its list entry")
    conditions = detail.get("conditions")
    refs = conditions.get("ref_name") if isinstance(conditions, dict) else None
    if not isinstance(refs, dict) or not isinstance(refs.get("include"), list) \
            or not isinstance(refs.get("exclude"), list):
        raise GateError(f"{TAG_CREATE_RULESET} has no readable ref_name include and exclude")
    if refs["include"] != [RELEASE_TAG_PATTERN] or refs["exclude"] != []:
        raise GateError(
            f"{TAG_CREATE_RULESET} must include exactly {RELEASE_TAG_PATTERN} and exclude nothing"
        )
    rules = detail.get("rules")
    if not isinstance(rules, list) or not any(
        isinstance(r, dict) and r.get("type") == "creation" for r in rules
    ):
        raise GateError(f"{TAG_CREATE_RULESET} does not contain the creation rule")


# ---------------------------------------------------------------- check 4


def _parse_version(text: str) -> tuple[int, int, int]:
    major, minor, patch = (int(part) for part in text.split("."))
    return major, minor, patch


def version_state(api: GitHub, sha: str, version: str) -> str:
    """Check 4. Return 'create' or 'exists' (an equal tag at this SHA)."""
    repo = _repo()
    wanted = _parse_version(version)
    state = "create"
    refs = api.pages(f"repos/{repo}/git/matching-refs/tags/v?per_page=100")
    for ref in refs:
        name = str(ref.get("ref", "")) if isinstance(ref, dict) else ""
        tag = name.removeprefix("refs/tags/")
        if not tag.startswith("v") or not SEMVER_RE.fullmatch(tag[1:]):
            print(f"::warning::ignoring tag {tag!r}: not a strict v<MAJOR.MINOR.PATCH> tag")
            continue
        found = _parse_version(tag[1:])
        if found > wanted:
            raise GateError(f"tag {tag} is higher than VERSION {version}")
        if found == wanted:
            if _tag_commit(api, ref) != sha:
                raise GateError(f"tag {tag} already names a different commit")
            state = "exists"
    return state


def _tag_commit(api: GitHub, ref: dict[str, Any]) -> str:
    obj = ref.get("object")
    if not isinstance(obj, dict) or not isinstance(obj.get("sha"), str):
        raise GateError("tag reference has no object")
    if obj.get("type") == "tag":  # Annotated: dereference to the commit.
        tag = _as_dict(api.get(f"repos/{_repo()}/git/tags/{obj['sha']}"), "tag object")
        target = tag.get("object")
        if not isinstance(target, dict) or target.get("type") != "commit":
            raise GateError("annotated tag does not name a commit")
        return str(target.get("sha"))
    if obj.get("type") != "commit":
        raise GateError("tag reference does not name a commit")
    return obj["sha"]


def create_tag(api: GitHub, sha: str) -> tuple[str, str]:
    """Checks 1 to 4 again, then create the tag if it is absent.

    Returns (version, 'created' or 'exists').
    """
    verdict = evaluate(api, sha)  # includes the tag-creation rule check
    if not verdict.ready:
        raise GateError("required checks are still pending: " + ", ".join(verdict.pending))
    version = verdict.version
    check_tag_creation_rule(api)  # again, immediately before the ref is created
    if version_state(api, sha, version) == "exists":
        return version, "exists"
    try:
        api.post(f"repos/{_repo()}/git/refs", {"ref": f"refs/tags/v{version}", "sha": sha})
    except GateError:
        # Another run may have created the tag first. Accept only the same SHA.
        if version_state(api, sha, version) == "exists":
            return version, "exists"
        raise
    return version, "created"


# ------------------------------------------------------- image helpers


def check_labels(labels: Any, version: str, sha: str) -> None:
    if not isinstance(labels, dict):
        raise GateError("image has no label map")
    if labels.get("org.opencontainers.image.version") != version:
        raise GateError("image version label differs from VERSION")
    if labels.get("org.opencontainers.image.revision") != sha:
        raise GateError("image revision label differs from the release SHA")
    if labels.get("org.opencontainers.image.source") != SOURCE_URL:
        raise GateError("image source label differs from this repository")


def inspect_existing_image(version: str, sha: str) -> bool:
    """Return True when the GHCR tag exists and its labels match the release."""
    image = f"{IMAGE}:{version}"
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
    check_labels(labels, version, sha)
    return True


def pick_digest(repo_digests: Any) -> str:
    if not isinstance(repo_digests, list):
        raise GateError("RepoDigests is not a list")
    prefix = f"{IMAGE}@"
    found = {d[len(prefix) :] for d in repo_digests if isinstance(d, str) and d.startswith(prefix)}
    if len(found) != 1:
        raise GateError(f"expected exactly one {IMAGE} digest, found {len(found)}")
    digest = found.pop()
    if not DIGEST_RE.fullmatch(digest):
        raise GateError("image digest is malformed")
    return digest


# ----------------------------------------------------------------- CLI


def _write_output(values: dict[str, str]) -> None:
    for key, value in values.items():
        print(f"{key}={value}")
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as stream:
        for key, value in values.items():
            if "\n" in value or "\r" in value:
                raise GateError(f"unsafe line break in output {key}")
            stream.write(f"{key}={value}\n")


def validate_event(path: str | None, sha: str) -> None:
    """Defense in depth: the workflow already filters these in its `if`."""
    if not path:
        raise GateError("GITHUB_EVENT_PATH is required")
    try:
        with open(path, encoding="utf-8") as stream:
            event = json.load(stream)
    except (OSError, json.JSONDecodeError) as exc:
        raise GateError("the workflow_run event payload cannot be read") from exc
    run = event.get("workflow_run") if isinstance(event, dict) else None
    allowed = {name for name, _ in WORKFLOWS.values()}
    if (
        not isinstance(run, dict)
        or run.get("event") != "push"
        or run.get("head_branch") != "main"
        or run.get("head_sha") != sha
        or run.get("name") not in allowed
    ):
        raise GateError("event is not a push run on main of a required workflow for this SHA")


def run_verify(api: GitHub, sha: str, event_path: str | None) -> dict[str, str]:
    _require_sha(sha)
    validate_event(event_path, sha)
    try:
        verdict = evaluate(api, sha)
    except NotRelease as exc:
        print(f"::notice::{sha} is not a release bump ({exc}); nothing to release.")
        return {"ready": "false", "sha": sha}
    if not verdict.ready:
        print(
            f"::notice::Release v{verdict.version} at {sha} is waiting for: "
            + ", ".join(verdict.pending)
            + ". The workflow that completes last continues."
        )
        return {"ready": "false", "sha": sha}
    print(f"::notice::Release v{verdict.version} at {sha} passed checks 1 to 3.")
    return {"ready": "true", "sha": sha}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--sha", required=True)
    verify.add_argument("--event-path", default=os.environ.get("GITHUB_EVENT_PATH"))
    for name in ("check", "version-rule", "tag"):
        sub.add_parser(name).add_argument("--sha", required=True)
    for name in ("check-labels", "inspect-ghcr"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--version", required=True)
        cmd.add_argument("--sha", required=True)
    sub.add_parser("digest")
    args = parser.parse_args(argv)

    api = GitHub()
    try:
        if args.command == "verify":
            _write_output(run_verify(api, args.sha, args.event_path))
        elif args.command == "check":
            verdict = evaluate(api, args.sha)
            if not verdict.ready:
                raise GateError("required checks are pending: " + ", ".join(verdict.pending))
            _write_output({"version": verdict.version})
        elif args.command == "version-rule":
            version = check_release_bump(api, _require_sha(args.sha))
            _write_output({"version": version, "tag_state": version_state(api, args.sha, version)})
        elif args.command == "tag":
            version, outcome = create_tag(api, _require_sha(args.sha))
            print(f"tag v{version}: {outcome}")
        elif args.command == "digest":
            _write_output({"digest": pick_digest(json.load(sys.stdin))})
        else:
            if not SEMVER_RE.fullmatch(args.version):
                raise GateError("version must be strict MAJOR.MINOR.PATCH")
            _require_sha(args.sha)
            if args.command == "check-labels":
                check_labels(json.load(sys.stdin), args.version, args.sha)
            else:
                exists = inspect_existing_image(args.version, args.sha)
                _write_output({"exists": "true" if exists else "false"})
    except GateError as exc:
        print(f"::error::release gate failed: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
