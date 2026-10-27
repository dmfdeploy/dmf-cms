from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "release_gate", Path(__file__).resolve().parents[1] / "scripts" / "release-gate.py"
)
assert _SPEC is not None and _SPEC.loader is not None
gate = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(gate)

SHA = "a" * 40
START = "2026-10-27T08:00:00+00:00"
VERSION = "0.4.0"


def _pr(**changes):
    pr = {
        "number": 568,
        "state": "closed",
        "merged": True,
        "merged_at": "2026-10-27T07:55:00Z",
        "draft": False,
        "title": f"chore(release): v{VERSION}",
        "merge_commit_sha": SHA,
        "base": {"ref": "main"},
    }
    pr.update(changes)
    return pr


def test_release_pr_binds_title_version_and_current_main_sha():
    assert gate.validate_release_pr(_pr(), SHA, VERSION) == {
        "sha": SHA,
        "version": VERSION,
        "pr_number": "568",
    }


@pytest.mark.parametrize(
    ("pr_changes", "main_sha", "version", "message"),
    [
        ({"merged": False}, SHA, VERSION, "must be merged"),
        ({"base": {"ref": "release"}}, SHA, VERSION, "must target main"),
        ({"title": "release 0.4.0"}, SHA, VERSION, "title must be exactly"),
        ({}, SHA, "0.3.9", "VERSION at the merged SHA"),
        ({}, "b" * 40, VERSION, "no longer the tip of main"),
        ({"draft": True}, SHA, VERSION, "cannot be a draft"),
        ({"merge_commit_sha": "short"}, SHA, VERSION, "full merged commit SHA"),
    ],
)
def test_invalid_release_pr_fails_closed(pr_changes, main_sha, version, message):
    with pytest.raises(gate.GateError, match=message):
        gate.validate_release_pr(_pr(**pr_changes), main_sha, version)


def test_dispatch_payload_requires_positive_integer():
    assert gate._release_pr_number({"client_payload": {"pr_number": "568"}}) == 568
    for payload in ({}, {"client_payload": {"pr_number": "-1"}},
                    {"client_payload": {"pr_number": True}},
                    {"client_payload": {"pr_number": "568x"}}):
        with pytest.raises(gate.GateError):
            gate._release_pr_number(payload)


def _ruleset():
    return {
        "id": 23,
        "name": gate.REQUIRED_RULESET,
        "target": "branch",
        "enforcement": "active",
        "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
        "rules": [{
            "type": "required_status_checks",
            "parameters": {
                "required_status_checks": [
                    {"context": context, "app_id": gate.CHECK_APP_ID}
                    for context in sorted(set().union(*gate.WORKFLOWS.values()))
                ]
            },
        }],
    }


def _run(path: str, run_id: int):
    return {
        "id": run_id,
        "event": "workflow_dispatch",
        "head_sha": SHA,
        "head_branch": "main",
        "path": f".github/workflows/{path}",
        "created_at": START,
        "status": "completed",
        "conclusion": "success",
    }


def _job(name: str, run_id: int, slot: int):
    check_id = run_id * 1000 + slot
    return {
        "id": check_id,
        "name": name,
        "head_sha": SHA,
        "status": "completed",
        "conclusion": "success",
        "check_run_url": f"https://api.github.com/repos/{gate.REPOSITORY}/check-runs/{check_id}",
    }


def _check(job):
    return {
        "name": job["name"],
        "head_sha": SHA,
        "status": "completed",
        "conclusion": "success",
        "started_at": START,
        "app": {"id": gate.CHECK_APP_ID},
    }


def _install_complete_fake_api(monkeypatch, *, app_id=gate.CHECK_APP_ID, omit_workflow=None):
    runs = {
        name: _run(name, index + 1)
        for index, name in enumerate(gate.WORKFLOWS)
        if name != omit_workflow
    }
    jobs_by_run = {}
    checks_by_path = {}
    for name, run in runs.items():
        jobs = [_job(context, run["id"], index + 1)
                for index, context in enumerate(sorted(gate.WORKFLOWS[name]))]
        jobs_by_run[run["id"]] = jobs
        for job in jobs:
            check = _check(job)
            check["app"]["id"] = app_id
            checks_by_path[job["check_run_url"].split("api.github.com/", 1)[1]] = check

    def api_pages(path):
        if "/rulesets?" in path:
            return [{"id": 23, "name": gate.REQUIRED_RULESET,
                     "target": "branch", "enforcement": "active",
                     "source_type": "Repository", "source": gate.REPOSITORY}]
        if "/actions/runs?" in path:
            return list(runs.values())
        if "/actions/runs/" in path and "/jobs?" in path:
            run_id = int(path.split("/actions/runs/", 1)[1].split("/", 1)[0])
            return jobs_by_run[run_id]
        raise AssertionError(path)

    def api(path, method="GET", fields=None):
        if path.endswith("/rulesets/23"):
            return _ruleset()
        return checks_by_path[path]

    monkeypatch.setattr(gate, "_public_api_pages", api_pages)
    monkeypatch.setattr(gate, "_public_api", api)
    monkeypatch.setattr(gate, "_gh_api_pages", api_pages)
    monkeypatch.setattr(gate, "_gh_api", api)
    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    monkeypatch.setenv("GITHUB_SHA", SHA)
    monkeypatch.setenv("GITHUB_REPOSITORY", gate.REPOSITORY)


def test_all_live_required_contexts_need_successful_exact_sha_dispatch_runs(monkeypatch):
    _install_complete_fake_api(monkeypatch)
    assert gate.checks_complete(SHA, "568", START)


def test_missing_dispatched_workflow_is_incomplete(monkeypatch):
    _install_complete_fake_api(monkeypatch, omit_workflow="dco.yml")
    assert gate.checks_complete(SHA, "568", START) is False


def test_foreign_app_cannot_satisfy_required_context(monkeypatch):
    _install_complete_fake_api(monkeypatch, app_id=1)
    with pytest.raises(gate.GateError, match="not from GitHub Actions"):
        gate.checks_complete(SHA, "568", START)


def test_dispatched_check_workflow_rejects_non_main_or_wrong_sha(monkeypatch):
    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    monkeypatch.setenv("GITHUB_SHA", "b" * 40)
    with pytest.raises(gate.GateError, match="differs from expected_sha"):
        gate._validate_dispatch_environment(SHA, "568")
    monkeypatch.setenv("GITHUB_SHA", SHA)
    monkeypatch.setenv("GITHUB_REF", "refs/heads/release/0.4.0")
    with pytest.raises(gate.GateError, match="refs/heads/main"):
        gate._validate_dispatch_environment(SHA, "568")


def test_invalid_live_ruleset_fails_closed(monkeypatch):
    _install_complete_fake_api(monkeypatch)
    monkeypatch.setattr(gate, "_public_api_pages", lambda _path: [])
    with pytest.raises(gate.GateError, match="exactly one active"):
        gate._ruleset_contexts()


def test_duplicate_live_rule_context_fails_closed(monkeypatch):
    _install_complete_fake_api(monkeypatch)
    ruleset = _ruleset()
    ruleset["rules"][0]["parameters"]["required_status_checks"].append(
        {"context": "dco", "app_id": gate.CHECK_APP_ID}
    )
    monkeypatch.setattr(gate, "_public_api", lambda _path: ruleset)
    with pytest.raises(gate.GateError, match="empty or duplicate"):
        gate._ruleset_contexts()


def _tag_creation_ruleset(**changes):
    result = {
        "id": 24,
        "name": "tags-release-create",
        "target": "tag",
        "enforcement": "active",
        "source_type": "Repository",
        "source": gate.REPOSITORY,
    }
    result.update(changes)
    return result


def _tag_creation_detail(**changes):
    result = {
        "enforcement": "active",
        "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
        "rules": [{"type": "creation"}],
        "bypass_actors": [{"actor_id": 15368, "actor_type": "Integration", "bypass_mode": "always"}],
    }
    result.update(changes)
    return result


def _install_tag_ruleset(monkeypatch, listing=None, detail=None):
    monkeypatch.setattr(gate, "_public_api_pages", lambda _path: [_tag_creation_ruleset()] if listing is None else listing)
    monkeypatch.setattr(gate, "_public_api", lambda _path: _tag_creation_detail() if detail is None else detail)


def test_release_tag_creation_ruleset_accepts_only_actions_bypass(monkeypatch):
    _install_tag_ruleset(monkeypatch)
    gate._release_tag_creation_is_restricted()


@pytest.mark.parametrize(
    ("listing", "detail", "message"),
    [
        ([], None, "exactly one active tags-release-create"),
        ([_tag_creation_ruleset(enforcement="disabled")], None, "exactly one active tags-release-create"),
        ([_tag_creation_ruleset(enforcement="evaluate")], None, "exactly one active tags-release-create"),
        ([_tag_creation_ruleset(target="branch")], None, "exactly one active tags-release-create"),
        (None, _tag_creation_detail(conditions={"ref_name": {"include": ["~ALL"], "exclude": []}}), "must target only refs/tags/v"),
        (None, _tag_creation_detail(conditions={"ref_name": {"include": ["refs/tags/v*"], "exclude": ["refs/tags/v0.*"]}}), "must target only refs/tags/v"),
        (None, _tag_creation_detail(rules=[]), "must enable the creation rule"),
        (None, _tag_creation_detail(bypass_actors=[]), "must allow only the GitHub Actions integration"),
        (None, _tag_creation_detail(bypass_actors=[{"actor_id": 1, "actor_type": "User", "bypass_mode": "always"}]), "must allow only the GitHub Actions integration"),
        (None, _tag_creation_detail(bypass_actors=[{"actor_id": 15368, "actor_type": "Integration", "bypass_mode": "always"}, {"actor_id": 1, "actor_type": "Team", "bypass_mode": "always"}]), "must allow only the GitHub Actions integration"),
        (None, _tag_creation_detail(bypass_actors=[{"actor_id": 15368, "actor_type": "Integration", "bypass_mode": "always_except_pull_requests"}]), "must allow only the GitHub Actions integration"),
    ],
)
def test_release_tag_creation_ruleset_mismatch_fails_closed(monkeypatch, listing, detail, message):
    _install_tag_ruleset(monkeypatch, listing, detail)
    with pytest.raises(gate.GateError, match=message):
        gate._release_tag_creation_is_restricted()


def test_stale_check_run_cannot_satisfy_release(monkeypatch):
    _install_complete_fake_api(monkeypatch)
    original = gate._gh_api

    def stale_check(path, method="GET", fields=None):
        result = original(path, method, fields)
        if path.startswith("repos/") and "/check-runs/" in path:
            result["started_at"] = "2026-10-27T07:00:00Z"
        return result

    monkeypatch.setattr(gate, "_gh_api", stale_check)
    with pytest.raises(gate.GateError, match="older than this release request"):
        gate.checks_complete(SHA, "568", START)


def _docker_pull(monkeypatch, *, returncode=0, stdout="", stderr=""):
    from subprocess import CompletedProcess

    def run(command, **_kwargs):
        if command[:2] == ["docker", "pull"]:
            return CompletedProcess(command, returncode, stdout, stderr)
        if command[:3] == ["docker", "image", "inspect"]:
            return CompletedProcess(
                command,
                0,
                '{"org.opencontainers.image.version":"0.4.0",'
                f'"org.opencontainers.image.revision":"{SHA}",'
                f'"org.opencontainers.image.source":"{gate.SOURCE_URL}"}}',
                "",
            )
        raise AssertionError(command)

    monkeypatch.setattr(gate.subprocess, "run", run)


def test_matching_existing_public_image_is_safe_retry(monkeypatch):
    _docker_pull(monkeypatch)
    assert gate.inspect_existing_ghcr_image("0.4.0", SHA) is True


def test_missing_public_image_allows_first_publish(monkeypatch):
    _docker_pull(monkeypatch, returncode=1, stderr="manifest unknown")
    assert gate.inspect_existing_ghcr_image("0.4.0", SHA) is False


def test_existing_image_for_another_commit_blocks_publish(monkeypatch):
    _docker_pull(monkeypatch)
    original = gate.subprocess.run

    def mismatched(command, **kwargs):
        result = original(command, **kwargs)
        if command[:3] == ["docker", "image", "inspect"]:
            result.stdout = result.stdout.replace(SHA, "b" * 40)
        return result

    monkeypatch.setattr(gate.subprocess, "run", mismatched)
    with pytest.raises(gate.GateError, match="revision label conflicts"):
        gate.inspect_existing_ghcr_image("0.4.0", SHA)


def test_existing_image_from_another_source_blocks_publish(monkeypatch):
    _docker_pull(monkeypatch)
    original = gate.subprocess.run

    def mismatched(command, **kwargs):
        result = original(command, **kwargs)
        if command[:3] == ["docker", "image", "inspect"]:
            result.stdout = result.stdout.replace(gate.SOURCE_URL, "https://example.invalid/other")
        return result

    monkeypatch.setattr(gate.subprocess, "run", mismatched)
    with pytest.raises(gate.GateError, match="source label conflicts"):
        gate.inspect_existing_ghcr_image("0.4.0", SHA)


def test_registry_error_is_not_treated_as_missing_image(monkeypatch):
    _docker_pull(monkeypatch, returncode=1, stderr="denied: access forbidden")
    with pytest.raises(gate.GateError, match="could not safely determine"):
        gate.inspect_existing_ghcr_image("0.4.0", SHA)


def test_dispatch_targets_only_the_four_existing_workflows_on_main(monkeypatch):
    calls = []
    monkeypatch.setattr(gate, "_gh_api", lambda path, method="GET", fields=None:
                        calls.append((path, method, fields)))
    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    monkeypatch.setenv("GITHUB_SHA", SHA)
    gate.dispatch_checks(SHA, "568")
    assert [call[0].split("/workflows/")[1].split("/dispatches")[0]
            for call in calls] == list(gate.WORKFLOWS)
    assert all(call[1] == "POST" for call in calls)
    assert all(call[2] == {
        "ref": "main",
        "inputs[expected_sha]": SHA,
        "inputs[release_pr]": "568",
    } for call in calls)


def test_release_event_binds_to_a_trusted_repository_dispatch_run(tmp_path, monkeypatch):
    event_path = tmp_path / "event.json"
    event_path.write_text('{"action":"cms-release","client_payload":{"pr_number":568}}')
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event_path))
    monkeypatch.setenv("GITHUB_REPOSITORY", gate.REPOSITORY)
    monkeypatch.setenv("GITHUB_RUN_ID", "12345")
    monkeypatch.setenv("GITHUB_SHA", SHA)
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(gate, "_release_tag_creation_is_restricted", lambda: None)
    calls = []

    def api(path, method="GET", fields=None):
        calls.append(path)
        if path.endswith("/pulls/568"):
            return _pr()
        if path.endswith("/commits/main"):
            return {"sha": SHA}
        if path.endswith("/actions/runs/12345"):
            return {
                "event": "repository_dispatch",
                "head_sha": SHA,
                "head_branch": "main",
                "path": ".github/workflows/release.yml",
                "created_at": START,
            }
        raise AssertionError(path)

    monkeypatch.setattr(gate, "_gh_api", api)
    monkeypatch.setattr(gate, "_read_version_at", lambda _sha: VERSION)
    result = gate.validate_event()
    assert result["sha"] == SHA
    assert result["version"] == VERSION
    assert result["dispatch_started_at"] == START
    assert calls[-1].endswith("/actions/runs/12345")


def test_release_event_rejects_wrong_workflow_run(tmp_path, monkeypatch):
    event_path = tmp_path / "event.json"
    event_path.write_text('{"action":"cms-release","client_payload":{"pr_number":568}}')
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event_path))
    monkeypatch.setenv("GITHUB_REPOSITORY", gate.REPOSITORY)
    monkeypatch.setenv("GITHUB_RUN_ID", "12345")
    monkeypatch.setenv("GITHUB_SHA", SHA)
    monkeypatch.setattr(gate, "_release_tag_creation_is_restricted", lambda: None)
    monkeypatch.setattr(gate, "_read_version_at", lambda _sha: VERSION)

    def api(path, method="GET", fields=None):
        if path.endswith("/pulls/568"):
            return _pr()
        if path.endswith("/commits/main"):
            return {"sha": SHA}
        return {"event": "workflow_dispatch", "head_sha": SHA}

    monkeypatch.setattr(gate, "_gh_api", api)
    with pytest.raises(gate.GateError, match="trusted default-main"):
        gate.validate_event()


def test_release_workflow_has_only_explicit_dispatch_trigger():
    workflow = Path(__file__).resolve().parents[1] / ".github/workflows/release.yml"
    text = workflow.read_text()
    assert "repository_dispatch:" in text
    assert "types: [cms-release]" in text
    assert "workflow_dispatch:" not in text
    assert "push:" not in text
    assert "pull_request:" not in text


def test_publish_wrapper_refuses_local_invocation():
    script = Path(__file__).resolve().parents[1] / "scripts/publish-to-ghcr.sh"
    env = dict(os.environ)
    for name in (
        "GITHUB_ACTIONS", "GITHUB_WORKFLOW", "GITHUB_EVENT_NAME", "GITHUB_REF",
        "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_EVENT_PATH",
        "DMF_CMS_RELEASE_GATE_PASSED", "DMF_CMS_RELEASE_SHA",
    ):
        env.pop(name, None)
    result = subprocess.run(["bash", str(script)], check=False, env=env, text=True, capture_output=True)
    assert result.returncode != 0
    assert "restricted to the verified DMF CMS Release workflow" in result.stderr
