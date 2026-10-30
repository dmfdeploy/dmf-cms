"""Tests for scripts/release-gate.py, the exact-SHA release gate.

GitHub is replaced at the `gh api` boundary. The fixtures follow the real
response shapes: the Actions and Checks endpoints return envelope objects
({"total_count": N, "workflow_runs": [...]}), the ruleset and tag endpoints
return bare arrays, and `gh api --paginate --slurp` wraps every page in one
outer array. The real pagination code runs against those shapes.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "release_gate", Path(__file__).resolve().parents[1] / "scripts" / "release-gate.py"
)
assert _SPEC is not None and _SPEC.loader is not None
gate = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(gate)

REPO = "dmfdeploy/dmf-cms"
SHA = "a" * 40
OTHER_SHA = "c" * 40
MAIN_HEAD = "b" * 40
VERSION = "0.40.0"
PAGE_SIZE = 4  # Small, so every list in the fixtures spans several pages.


def paginate(items: list[Any], key: str | None = None) -> list[Any]:
    """Return what `gh api --paginate --slurp` prints for a list endpoint."""
    chunks = [items[i : i + PAGE_SIZE] for i in range(0, len(items), PAGE_SIZE)] or [[]]
    if key is None:
        return chunks
    return [{"total_count": len(items), key: chunk} for chunk in chunks]


class World:
    """One GitHub repository, as the gate sees it through `gh api`."""

    def __init__(self) -> None:
        self.sha = SHA
        self.compare_status = "ahead"
        self.subject = f"chore(release): v{VERSION}"
        self.body = "Signed-off-by: A Dev <dev@example.invalid>\n"
        self.files = ["VERSION", "pyproject.toml", "charts/dmf-cms/Chart.yaml"]
        self.version_file = f"{VERSION}\n"
        self.pulls: list[dict[str, Any]] = [
            {
                "number": 900,
                "merged_at": "2026-10-30T08:00:00Z",
                "base": {"ref": "main"},
                "body": "Refs dmfdeploy/dmfdeploy#568",
            }
        ]
        self.rulesets: list[dict[str, Any]] = [
            {
                "id": 14,
                "name": "main-protection",
                "target": "branch",
                "source_type": "Repository",
                "source": REPO,
                "enforcement": "active",
            },
            {
                "id": 15,
                "name": "tags-release-protect",
                "target": "tag",
                "source_type": "Repository",
                "source": REPO,
                "enforcement": "active",
            },
        ]
        self.required = [
            {"context": c, "integration_id": gate.CHECK_APP_ID}
            for c in sorted(gate.REQUIRED_CONTEXTS)
        ]
        self.status_rule_ruleset_id = 14
        self.runs: list[dict[str, Any]] = []
        self.check_runs: list[dict[str, Any]] = []
        self.tags: list[dict[str, Any]] = []
        self.annotated: dict[str, dict[str, Any]] = {}
        self.posts: list[tuple[str, dict[str, str], str | None]] = []
        self.fail_post = False
        self.on_post = None
        for index, (path, (name, contexts)) in enumerate(gate.WORKFLOWS.items(), start=1):
            suite = 5000 + index
            self.runs.append(
                {
                    "id": 7000 + index,
                    "name": name,
                    "head_branch": "main",
                    "head_sha": SHA,
                    "path": path,
                    "event": "push",
                    "status": "completed",
                    "conclusion": "success",
                    "check_suite_id": suite,
                    "run_attempt": 1,
                }
            )
            for context in sorted(contexts):
                self.check_runs.append(self.check_run(context, suite))

    @staticmethod
    def check_run(context: str, suite: int, **changes: Any) -> dict[str, Any]:
        run = {
            "id": abs(hash(context)) % 10**9,
            "name": context,
            "head_sha": SHA,
            "status": "completed",
            "conclusion": "success",
            "app": {"id": gate.CHECK_APP_ID, "slug": "github-actions"},
            "check_suite": {"id": suite},
        }
        run.update(changes)
        return run

    def suite_of(self, workflow_path: str) -> int:
        return next(r["check_suite_id"] for r in self.runs if r["path"] == workflow_path)

    def run_for(self, context: str) -> dict[str, Any]:
        return next(c for c in self.check_runs if c["name"] == context)

    def set_check(self, context: str, **changes: Any) -> None:
        self.run_for(context).update(changes)

    def add_tag(self, version: str, sha: str, kind: str = "commit") -> None:
        obj_sha = sha
        if kind == "tag":
            obj_sha = "d" * 40
            self.annotated[obj_sha] = {"object": {"type": "commit", "sha": sha}}
        self.tags.append(
            {
                "ref": f"refs/tags/v{version}",
                "node_id": "REF_x",
                "object": {"sha": obj_sha, "type": kind},
            }
        )

    # -- the `gh api` boundary
    def respond(self, args: list[str], token_env: str | None) -> Any:
        path = args[-1]
        route = path.split("?")[0]
        if args[:2] == ["-X", "POST"]:
            fields = {k.split("=")[0]: k.split("=", 1)[1] for k in args[3:-1:2]}
            self.posts.append((route, fields, token_env))
            if self.fail_post:
                raise gate.GateError("HTTP 422: Reference already exists")
            if self.on_post:
                self.on_post()
            self.tags.append(
                {
                    "ref": fields["ref"],
                    "object": {"sha": fields["sha"], "type": "commit"},
                }
            )
            return {"ref": fields["ref"]}
        if "--paginate" in args:
            assert "--slurp" in args, "paginated calls must slurp so the output is one JSON value"
            return self.pages(route)
        return self.single(route)

    def pages(self, route: str) -> list[Any]:
        if route == f"repos/{REPO}/rulesets":
            return paginate(self.rulesets)
        if route == f"repos/{REPO}/rules/branches/main":
            rules = [
                {"type": "pull_request", "parameters": {}, "ruleset_id": 14},
                {"type": "non_fast_forward", "ruleset_id": 14},
                {
                    "type": "required_status_checks",
                    "parameters": {
                        "strict_required_status_checks_policy": False,
                        "required_status_checks": self.required,
                    },
                    "ruleset_source_type": "Repository",
                    "ruleset_source": REPO,
                    "ruleset_id": self.status_rule_ruleset_id,
                },
            ]
            return paginate(rules)
        if route == f"repos/{REPO}/actions/runs":
            return paginate(self.runs, "workflow_runs")
        if route == f"repos/{REPO}/commits/{self.sha}/check-runs":
            return paginate(self.check_runs, "check_runs")
        if route == f"repos/{REPO}/commits/{self.sha}/pulls":
            return paginate(self.pulls)
        if route == f"repos/{REPO}/git/matching-refs/tags/v":
            return paginate(self.tags)
        raise AssertionError(f"unexpected paginated route {route}")

    def single(self, route: str) -> Any:
        if route == f"repos/{REPO}/compare/{self.sha}...main":
            return {"status": self.compare_status, "ahead_by": 2, "behind_by": 0}
        if route == f"repos/{REPO}/commits/{self.sha}":
            return {
                "sha": self.sha,
                "commit": {"message": f"{self.subject}\n\n{self.body}"},
                "files": [{"filename": f, "status": "modified"} for f in self.files],
            }
        if route == f"repos/{REPO}/contents/VERSION":
            return {
                "type": "file",
                "encoding": "base64",
                "content": base64.b64encode(self.version_file.encode()).decode(),
            }
        if route.startswith(f"repos/{REPO}/git/tags/"):
            return self.annotated[route.rsplit("/", 1)[1]]
        raise AssertionError(f"unexpected route {route}")


class FakeGitHub(gate.GitHub):
    def __init__(self, world: World) -> None:
        self.world = world

    def _run(self, args: list[str], token_env: str | None = None) -> Any:
        return self.world.respond(args, token_env)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def api(world: World) -> FakeGitHub:
    return FakeGitHub(world)


# ------------------------------------------------------------ pagination


def test_unpack_pages_reads_envelope_objects():
    pages = paginate([{"id": i} for i in range(10)], "workflow_runs")
    assert len(pages) == 3
    items = gate.unpack_pages(pages, "workflow_runs", "p")
    assert [i["id"] for i in items] == list(range(10))


def test_unpack_pages_rejects_a_bare_array_where_an_envelope_is_expected():
    # The shape bug in the first design: the Actions endpoints return objects.
    with pytest.raises(gate.GateError, match="no 'jobs' array"):
        gate.unpack_pages([[{"id": 1}]], "jobs", "p")


def test_unpack_pages_rejects_an_envelope_where_a_bare_array_is_expected():
    with pytest.raises(gate.GateError, match="not an array"):
        gate.unpack_pages([{"total_count": 1, "check_runs": []}], None, "p")


def test_unpack_pages_rejects_unslurped_output():
    with pytest.raises(gate.GateError, match="page array"):
        gate.unpack_pages({"total_count": 0, "workflow_runs": []}, "workflow_runs", "p")


def test_pages_runs_gh_with_paginate_and_slurp(monkeypatch):
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command)
        out = json.dumps(paginate([{"id": 1}, {"id": 2}, {"id": 3}, {"id": 4}, {"id": 5}], "jobs"))
        return subprocess.CompletedProcess(command, 0, out, "")

    monkeypatch.setattr(gate.subprocess, "run", fake_run)
    items = gate.GitHub().pages("repos/x/y/actions/runs/1/jobs?per_page=100", key="jobs")
    assert [i["id"] for i in items] == [1, 2, 3, 4, 5]
    assert calls[0][:4] == ["gh", "api", "--paginate", "--slurp"]


def test_post_uses_only_the_release_tag_token(monkeypatch):
    seen = {}

    def fake_run(command, env, **kwargs):
        seen["token"] = env["GH_TOKEN"]
        seen["command"] = command
        return subprocess.CompletedProcess(command, 0, "{}", "")

    monkeypatch.setenv("GH_TOKEN", "read-token")
    monkeypatch.setenv("RELEASE_TAG_TOKEN", "app-token")
    monkeypatch.setattr(gate.subprocess, "run", fake_run)
    gate.GitHub().post("repos/x/y/git/refs", {"ref": "refs/tags/v1.0.0", "sha": SHA})
    assert seen["token"] == "app-token"
    assert "app-token" not in " ".join(seen["command"])


def test_post_without_the_app_token_fails_instead_of_falling_back(monkeypatch):
    monkeypatch.setenv("GH_TOKEN", "read-token")
    monkeypatch.delenv("RELEASE_TAG_TOKEN", raising=False)
    with pytest.raises(gate.GateError, match="RELEASE_TAG_TOKEN"):
        gate.GitHub().post("repos/x/y/git/refs", {"ref": "r", "sha": SHA})


# --------------------------------------------------- checks 1 to 3: the gate


def test_gate_passes_when_all_twelve_contexts_succeed(api):
    verdict = gate.evaluate(api, SHA)
    assert verdict.ready and verdict.version == VERSION
    assert len(gate.REQUIRED_CONTEXTS) == 12


@pytest.mark.parametrize("status", ["diverged", "behind"])
def test_gate_fails_when_the_commit_is_not_reachable_from_main(world, api, status):
    world.compare_status = status
    with pytest.raises(gate.GateError, match="not reachable from main"):
        gate.evaluate(api, SHA)


def test_gate_accepts_the_head_of_main_itself(world, api):
    world.compare_status = "identical"
    assert gate.evaluate(api, SHA).ready


def test_gate_fails_when_the_subject_is_not_a_release_title(world, api):
    world.subject = "feat(x): add a thing"
    with pytest.raises(gate.NotRelease):
        gate.evaluate(api, SHA)


def test_gate_fails_when_the_commit_does_not_change_version(world, api):
    world.files = ["pyproject.toml"]
    with pytest.raises(gate.NotRelease, match="VERSION"):
        gate.evaluate(api, SHA)


def test_gate_fails_when_version_fields_disagree(world, api):
    world.version_file = "0.39.0\n"
    with pytest.raises(gate.GateError, match="VERSION reads"):
        gate.evaluate(api, SHA)


def test_gate_fails_without_a_qualified_issue_reference(world, api):
    world.pulls[0]["body"] = "Refs #568 and closes nothing else"
    with pytest.raises(gate.GateError, match="qualified issue reference"):
        gate.evaluate(api, SHA)


def test_gate_accepts_the_issue_reference_on_the_commit_itself(world, api):
    world.pulls = []
    world.body = "Refs dmfdeploy/dmfdeploy#568\n"
    assert gate.evaluate(api, SHA).ready


def test_gate_ignores_an_unmerged_pull_request_reference(world, api):
    world.pulls[0]["merged_at"] = None
    with pytest.raises(gate.GateError, match="qualified issue reference"):
        gate.evaluate(api, SHA)


def test_missing_context_fails_once_every_workflow_has_completed(world, api):
    world.check_runs = [c for c in world.check_runs if c["name"] != "trivy"]
    with pytest.raises(gate.GateError, match=r"trivy: no check run"):
        gate.evaluate(api, SHA)


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"conclusion": "failure"}, "'failure'"),
        ({"conclusion": "cancelled"}, "'cancelled'"),
        ({"conclusion": "skipped"}, "'skipped'"),
        ({"conclusion": "neutral"}, "'neutral'"),
        ({"conclusion": "stale"}, "'stale'"),
        ({"conclusion": None}, "None"),
        ({"app": {"id": 99999, "slug": "other-ci"}}, "not from GitHub Actions"),
        ({"app": None}, "not from GitHub Actions"),
        ({"head_sha": OTHER_SHA}, "another commit"),
        ({"check_suite": {"id": 1}}, "does not belong to a push run"),
    ],
)
def test_a_context_that_is_not_a_fresh_success_fails(world, api, changes, message):
    world.set_check("gitleaks", **changes)
    with pytest.raises(gate.GateError, match=message):
        gate.evaluate(api, SHA)


def test_duplicate_check_runs_for_one_context_fail(world, api):
    world.check_runs.append(
        World.check_run("dco", world.suite_of(".github/workflows/dco.yml"), id=42)
    )
    with pytest.raises(gate.GateError, match="2 check runs share the name"):
        gate.evaluate(api, SHA)


def test_a_foreign_app_run_cannot_stand_in_next_to_the_real_one(world, api):
    world.check_runs.append(
        World.check_run("dco", world.suite_of(".github/workflows/dco.yml"), app={"id": 7})
    )
    with pytest.raises(gate.GateError, match="dco"):
        gate.evaluate(api, SHA)


def test_a_success_on_the_pull_request_head_only_does_not_count(world, api):
    # The push run's check runs are gone. The only success is a pull_request
    # run whose suite is not the push run's suite.
    world.set_check("frontend", check_suite={"id": 31337})
    with pytest.raises(gate.GateError, match="frontend: .*push run"):
        gate.evaluate(api, SHA)


def test_a_push_run_on_another_sha_is_ignored_and_the_workflow_stays_pending(world, api):
    ci = next(r for r in world.runs if r["name"] == "CI")
    ci["head_sha"] = OTHER_SHA
    world.check_runs = [c for c in world.check_runs if c["name"] not in
                        gate.WORKFLOWS[".github/workflows/ci.yml"][1]]
    verdict = gate.evaluate(api, SHA)
    assert not verdict.ready
    assert set(verdict.pending) == gate.WORKFLOWS[".github/workflows/ci.yml"][1]


def test_a_pull_request_event_run_is_not_a_push_run(world, api):
    ci = next(r for r in world.runs if r["name"] == "CI")
    ci["event"] = "pull_request"
    with pytest.raises(gate.GateError, match="push run"):
        gate.evaluate(api, SHA)


def test_two_push_runs_of_one_workflow_fail(world, api):
    world.runs.append({**world.runs[0], "id": 9999})
    with pytest.raises(gate.GateError, match="more than one push run"):
        gate.evaluate(api, SHA)


def test_run_paths_with_a_ref_suffix_still_map_to_the_workflow(world, api):
    for run in world.runs:
        run["path"] += "@refs/heads/main"
    assert gate.evaluate(api, SHA).ready


# ------------------------------------------------ the live ruleset (check 3)


def test_zero_active_main_protection_rulesets_fail(world, api):
    world.rulesets[0]["enforcement"] = "disabled"
    with pytest.raises(gate.GateError, match="exactly one active main-protection.*found 0"):
        gate.evaluate(api, SHA)


def test_several_active_main_protection_rulesets_fail(world, api):
    world.rulesets.append({**world.rulesets[0], "id": 99})
    with pytest.raises(gate.GateError, match="found 2"):
        gate.evaluate(api, SHA)


def test_a_disabled_twin_of_main_protection_is_ignored(world, api):
    world.rulesets.append({**world.rulesets[0], "id": 99, "enforcement": "evaluate"})
    assert gate.evaluate(api, SHA).ready


def test_a_second_ruleset_requiring_checks_on_main_fails_closed(world, api):
    world.status_rule_ruleset_id = 77
    with pytest.raises(gate.GateError, match="other than main-protection"):
        gate.evaluate(api, SHA)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda required: required.append({"context": "dco", "integration_id": 15368}),
        lambda required: required.append({"context": "  ", "integration_id": 15368}),
        lambda required: required.append({"context": "new-check", "integration_id": 15368}),
        lambda required: required.pop(),
        lambda required: required[0].update(integration_id=1234),
        lambda required: required.clear(),
    ],
    ids=["duplicate", "empty", "unmapped-extra", "unmapped-missing", "foreign-binding", "none"],
)
def test_a_malformed_or_unmapped_context_list_fails(world, api, mutate):
    mutate(world.required)
    with pytest.raises(gate.GateError):
        gate.evaluate(api, SHA)


def test_a_context_without_an_integration_binding_is_accepted(world, api):
    for entry in world.required:
        entry["integration_id"] = None
    assert gate.evaluate(api, SHA).ready


# --------------------------------- pending contexts and the two-run fixture


def _start_workflow(world: World, name: str) -> None:
    """Make one workflow's push run still running, with unfinished check runs."""
    path, (_, contexts) = next((p, v) for p, v in gate.WORKFLOWS.items() if v[0] == name)
    run = next(r for r in world.runs if r["path"] == path)
    run.update(status="in_progress", conclusion=None)
    for context in contexts:
        world.set_check(context, status="in_progress", conclusion=None)


def test_a_run_that_is_not_the_last_workflow_to_complete_is_a_quiet_no_op(world, api):
    _start_workflow(world, "CI")
    verdict = gate.evaluate(api, SHA)
    assert not verdict.ready
    assert sorted(verdict.pending) == sorted(gate.WORKFLOWS[".github/workflows/ci.yml"][1])


def test_a_workflow_with_no_push_run_yet_is_pending_not_failed(world, api):
    world.runs = [r for r in world.runs if r["name"] != "issue-link"]
    world.check_runs = [c for c in world.check_runs if c["name"] != "issue-link"]
    assert gate.evaluate(api, SHA).pending == ["issue-link"]


def test_a_failure_is_reported_even_while_another_workflow_is_pending(world, api):
    _start_workflow(world, "CI")
    world.set_check("trivy", conclusion="failure")
    with pytest.raises(gate.GateError, match="trivy"):
        gate.evaluate(api, SHA)


def test_two_release_runs_for_one_sha_only_the_last_one_releases(world, api, tmp_path):
    event = _event(tmp_path, name="DCO")
    # The run started by the first workflow to complete (DCO) sees CI still running.
    _start_workflow(world, "CI")
    first = gate.run_verify(api, SHA, str(event))
    assert first == {"ready": "false", "sha": SHA}
    # CI completes last. Its run sees every context green and continues.
    api.world = World()
    second = gate.run_verify(api, SHA, str(_event(tmp_path, name="CI")))
    assert second == {"ready": "true", "sha": SHA}


def test_verify_is_a_quiet_no_op_for_an_ordinary_push(world, api, tmp_path, capsys):
    world.subject = "fix(auth): handle an empty claim"
    result = gate.run_verify(api, SHA, str(_event(tmp_path)))
    assert result == {"ready": "false", "sha": SHA}
    assert "::error" not in capsys.readouterr().out


def test_verify_fails_loudly_for_a_release_whose_check_failed(world, api, tmp_path):
    world.set_check("frontend-e2e", conclusion="failure")
    with pytest.raises(gate.GateError, match="frontend-e2e"):
        gate.run_verify(api, SHA, str(_event(tmp_path)))


def _event(tmp_path: Path, *, name="CI", event="push", branch="main", sha=SHA) -> Path:
    path = tmp_path / f"event-{name}-{event}-{branch}.json"
    path.write_text(
        json.dumps(
            {
                "action": "completed",
                "workflow_run": {
                    "name": name,
                    "event": event,
                    "head_branch": branch,
                    "head_sha": sha,
                    "conclusion": "success",
                },
            }
        )
    )
    return path


@pytest.mark.parametrize(
    "kwargs",
    [
        {"event": "pull_request"},
        {"event": "schedule"},
        {"branch": "v0.40.0"},
        {"branch": "feature"},
        {"name": "automerge"},
        {"sha": OTHER_SHA},
    ],
)
def test_verify_rejects_an_event_that_is_not_a_main_push_run(world, api, tmp_path, kwargs):
    with pytest.raises(gate.GateError, match="not a push run on main"):
        gate.run_verify(api, SHA, str(_event(tmp_path, **kwargs)))


def test_verify_requires_a_full_sha_and_an_event_file(api, tmp_path):
    with pytest.raises(gate.GateError, match="full lowercase SHA"):
        gate.run_verify(api, "main", str(_event(tmp_path)))
    with pytest.raises(gate.GateError, match="GITHUB_EVENT_PATH"):
        gate.run_verify(api, SHA, None)


# ----------------------------------------------- check 4: the version rule


def test_no_tags_means_create(world, api):
    assert gate.version_state(api, SHA, VERSION) == "create"


def test_a_lower_tag_does_not_block(world, api):
    for version in ("0.1.0", "0.39.0", "0.39.9"):
        world.add_tag(version, OTHER_SHA)
    assert gate.version_state(api, SHA, VERSION) == "create"


def test_a_higher_tag_fails_across_pages(world, api):
    for minor in range(1, 9):
        world.add_tag(f"0.{minor}.0", OTHER_SHA)
    world.add_tag("0.41.0", OTHER_SHA)
    with pytest.raises(gate.GateError, match="v0.41.0 is higher"):
        gate.version_state(api, SHA, VERSION)


def test_versions_compare_as_numbers_not_text(world, api):
    world.add_tag("0.9.0", OTHER_SHA)
    assert gate.version_state(api, SHA, "0.10.0") == "create"
    world.add_tag("0.100.0", OTHER_SHA)
    with pytest.raises(gate.GateError, match="higher"):
        gate.version_state(api, SHA, "0.40.0")


def test_an_equal_tag_at_the_same_sha_is_accepted(world, api):
    world.add_tag(VERSION, SHA)
    assert gate.version_state(api, SHA, VERSION) == "exists"


def test_an_equal_annotated_tag_at_the_same_sha_is_accepted(world, api):
    world.add_tag(VERSION, SHA, kind="tag")
    assert gate.version_state(api, SHA, VERSION) == "exists"


def test_an_equal_tag_at_another_sha_fails(world, api):
    world.add_tag(VERSION, OTHER_SHA)
    with pytest.raises(gate.GateError, match="different commit"):
        gate.version_state(api, SHA, VERSION)


def test_a_tag_that_is_not_strict_semver_is_ignored_with_a_warning(world, api, capsys):
    world.add_tag("9.9.9-rc1", OTHER_SHA)
    assert gate.version_state(api, SHA, VERSION) == "create"
    assert "::warning::" in capsys.readouterr().out


def test_the_gate_fails_for_a_version_below_an_existing_tag(world, api):
    world.add_tag("0.41.0", OTHER_SHA)
    with pytest.raises(gate.GateError, match="higher than VERSION"):
        gate.create_tag(api, SHA)
    assert world.posts == []


# ---------------------------------------------------------- tag creation


def test_the_tag_is_created_as_the_app_with_the_verified_sha(world, api):
    assert gate.create_tag(api, SHA) == (VERSION, "created")
    [(route, fields, token_env)] = world.posts
    assert route == f"repos/{REPO}/git/refs"
    assert fields == {"ref": f"refs/tags/v{VERSION}", "sha": SHA}
    assert token_env == "RELEASE_TAG_TOKEN"


def test_a_retry_after_a_successful_tag_at_the_same_sha_does_not_recreate_it(world, api):
    world.add_tag(VERSION, SHA)
    assert gate.create_tag(api, SHA) == (VERSION, "exists")
    assert world.posts == []


def test_two_runs_in_sequence_for_one_version_create_exactly_one_tag(world, api):
    assert gate.create_tag(api, SHA)[1] == "created"
    assert gate.create_tag(api, SHA)[1] == "exists"
    assert len(world.posts) == 1
    assert [t["ref"] for t in world.tags] == [f"refs/tags/v{VERSION}"]


def test_a_race_lost_to_the_same_sha_is_a_success_not_a_failure(world, api):
    world.fail_post = True
    original_post = world.respond

    def lose_the_race(args, token_env):
        if args[:2] == ["-X", "POST"]:
            world.add_tag(VERSION, SHA)  # The other run created it first.
        return original_post(args, token_env)

    world.respond = lose_the_race  # type: ignore[method-assign]
    assert gate.create_tag(api, SHA) == (VERSION, "exists")


def test_a_failed_post_with_no_matching_tag_is_a_failure(world, api):
    world.fail_post = True
    with pytest.raises(gate.GateError, match="already exists"):
        gate.create_tag(api, SHA)


def test_a_pending_context_blocks_the_tag(world, api):
    _start_workflow(world, "guard")
    with pytest.raises(gate.GateError, match="still pending"):
        gate.create_tag(api, SHA)
    assert world.posts == []


def test_a_failed_check_creates_no_tag(world, api):
    world.set_check("test (3.13)", conclusion="failure")
    with pytest.raises(gate.GateError):
        gate.create_tag(api, SHA)
    assert world.posts == []


def test_a_merge_after_verification_still_tags_the_verified_commit(world, api):
    # Main moved on: the verified commit is an ancestor, so the compare
    # status is still "ahead". The new head stays untagged.
    world.compare_status = "ahead"
    assert gate.create_tag(api, SHA)[1] == "created"
    assert world.posts[0][1]["sha"] == SHA != MAIN_HEAD


def test_an_unreachable_commit_exits_without_a_tag(world, api):
    world.compare_status = "diverged"
    with pytest.raises(gate.GateError, match="not reachable"):
        gate.create_tag(api, SHA)
    assert world.posts == []


def test_a_commit_that_becomes_unreachable_before_the_tag_is_not_tagged(world, api):
    # The earlier check passed. The tag step repeats it and now fails.
    assert gate.evaluate(api, SHA).ready
    world.compare_status = "diverged"
    with pytest.raises(gate.GateError, match="not reachable"):
        gate.create_tag(api, SHA)
    assert world.posts == []


def test_a_higher_tag_appearing_between_two_runs_blocks_the_lower_version(world, api):
    assert gate.version_state(api, SHA, VERSION) == "create"  # first run's early check
    world.add_tag("0.41.0", OTHER_SHA)  # a later release lands first
    with pytest.raises(gate.GateError, match="higher"):
        gate.create_tag(api, SHA)
    assert world.posts == []


def test_a_replaced_pending_release_fails_the_version_rule_when_re_run(world, api):
    world.add_tag("0.41.0", OTHER_SHA)  # the later release was tagged
    with pytest.raises(gate.GateError, match="higher"):
        gate.create_tag(api, SHA)
    assert world.posts == []


# ------------------------------------------------------ image helper checks


GOOD_LABELS = {
    "org.opencontainers.image.version": VERSION,
    "org.opencontainers.image.revision": SHA,
    "org.opencontainers.image.source": gate.SOURCE_URL,
}


def test_labels_that_match_pass():
    gate.check_labels(GOOD_LABELS, VERSION, SHA)


@pytest.mark.parametrize(
    ("label", "value", "message"),
    [
        ("org.opencontainers.image.version", "0.39.0", "version label"),
        ("org.opencontainers.image.revision", OTHER_SHA, "revision label"),
        ("org.opencontainers.image.revision", SHA[:7], "revision label"),
        ("org.opencontainers.image.source", "https://example.invalid/x", "source label"),
        ("org.opencontainers.image.version", None, "version label"),
    ],
)
def test_labels_that_differ_fail(label, value, message):
    labels = {**GOOD_LABELS, label: value}
    with pytest.raises(gate.GateError, match=message):
        gate.check_labels(labels, VERSION, SHA)


def test_a_missing_label_map_fails():
    with pytest.raises(gate.GateError, match="no label map"):
        gate.check_labels(None, VERSION, SHA)


def test_digest_is_taken_from_the_ghcr_repo_digest_only():
    digest = "sha256:" + "f" * 64
    assert gate.pick_digest([f"other.example/x@sha256:{'e' * 64}", f"{gate.IMAGE}@{digest}"]) == digest


@pytest.mark.parametrize(
    "value",
    [[], None, [f"{gate.IMAGE}@sha256:short"],
     [f"{gate.IMAGE}@sha256:{'1' * 64}", f"{gate.IMAGE}@sha256:{'2' * 64}"]],
)
def test_a_missing_ambiguous_or_malformed_digest_fails(value):
    with pytest.raises(gate.GateError):
        gate.pick_digest(value)


def _docker(monkeypatch, pull_rc, pull_err, labels):
    def fake_run(command, **kwargs):
        if command[:2] == ["docker", "pull"]:
            return subprocess.CompletedProcess(command, pull_rc, "", pull_err)
        return subprocess.CompletedProcess(command, 0, json.dumps(labels), "")

    monkeypatch.setattr(gate.subprocess, "run", fake_run)


def test_an_absent_image_is_reported_absent(monkeypatch):
    _docker(monkeypatch, 1, "Error response from daemon: manifest unknown", {})
    assert gate.inspect_existing_image(VERSION, SHA) is False


def test_a_registry_error_is_not_mistaken_for_an_absent_image(monkeypatch):
    _docker(monkeypatch, 1, "toomanyrequests: rate limited", {})
    with pytest.raises(gate.GateError, match="safely determine"):
        gate.inspect_existing_image(VERSION, SHA)


def test_an_existing_image_with_matching_labels_is_accepted(monkeypatch):
    _docker(monkeypatch, 0, "", GOOD_LABELS)
    assert gate.inspect_existing_image(VERSION, SHA) is True


def test_an_existing_image_with_a_mismatched_revision_is_never_overwritten(monkeypatch):
    _docker(monkeypatch, 0, "", {**GOOD_LABELS, "org.opencontainers.image.revision": OTHER_SHA})
    with pytest.raises(gate.GateError, match="revision label"):
        gate.inspect_existing_image(VERSION, SHA)


def test_the_gate_refuses_to_run_in_another_repository(monkeypatch, api):
    monkeypatch.setenv("GITHUB_REPOSITORY", "someone/else")
    with pytest.raises(gate.GateError, match="unexpected repository"):
        gate.evaluate(api, SHA)
