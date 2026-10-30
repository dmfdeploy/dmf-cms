"""Structural tests for .github/workflows/release.yml.

The release workflow holds the only key that can create a release tag, so its
shape is the security property. These tests parse the workflow and fail on any
change that widens the trigger, moves a write permission, or routes the App
key through `env`.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"
RELEASE = WORKFLOWS_DIR / "release.yml"

_SPEC = importlib.util.spec_from_file_location(
    "release_gate", REPO_ROOT / "scripts" / "release-gate.py"
)
assert _SPEC is not None and _SPEC.loader is not None
gate = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(gate)

WRITE_TOKENS_ONLY_FOR_RELEASE = ("packages", "id-token", "attestations")
PINNED_USES = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")


def load(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    # YAML 1.1 reads the key `on` as the boolean True.
    if True in data and "on" not in data:
        data["on"] = data.pop(True)
    return data


def all_workflows() -> dict[str, dict[str, Any]]:
    return {p.name: load(p) for p in sorted(WORKFLOWS_DIR.glob("*.yml"))}


@pytest.fixture(scope="module")
def release() -> dict[str, Any]:
    return load(RELEASE)


def steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    return job["steps"]


def write_scopes(permissions: Any) -> set[str]:
    if permissions in (None, {}):
        return set()
    if permissions == "write-all":
        return {"*"}
    return {k for k, v in permissions.items() if v == "write"}


# ------------------------------------------------------------ the trigger


def test_release_triggers_only_on_workflow_run_for_main(release):
    assert set(release["on"]) == {"workflow_run"}
    trigger = release["on"]["workflow_run"]
    assert trigger["types"] == ["completed"]
    assert trigger["branches"] == ["main"]


def test_release_has_no_dispatch_trigger_and_no_inputs(release):
    on = release["on"]
    for forbidden in ("repository_dispatch", "workflow_dispatch", "workflow_call", "push",
                      "pull_request", "pull_request_target", "schedule"):
        assert forbidden not in on
    text = RELEASE.read_text(encoding="utf-8")
    for token in ("inputs.", "github.event.inputs", "client_payload", "workflow_dispatch",
                  "repository_dispatch"):
        # The header comment names none of these, so any hit is a real use.
        assert token not in text, f"release.yml must not read or accept {token!r}"


def test_release_never_takes_the_commit_from_github_sha(release):
    # github.sha is the head of main, which can differ from the commit under
    # test. The verified commit comes from workflow_run.head_sha only.
    code = "\n".join(
        line for line in RELEASE.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#")
    )
    assert "github.sha" not in code
    assert "workflow_run.head_sha" in code


def test_every_trigger_name_is_the_name_of_an_existing_workflow(release):
    names = {w["name"] for w in all_workflows().values()}
    listed = release["on"]["workflow_run"]["workflows"]
    assert listed, "workflow_run.workflows must not be empty"
    assert len(listed) == len(set(listed))
    for entry in listed:
        assert entry in names, f"workflow_run lists {entry!r}, which is no workflow's name:"


def test_all_four_workflows_that_produce_the_required_contexts_are_listed(release):
    listed = set(release["on"]["workflow_run"]["workflows"])
    assert listed == {name for name, _ in gate.WORKFLOWS.values()}
    # The gate's file -> name map must agree with the files themselves.
    for filename, (name, _) in gate.WORKFLOWS.items():
        assert load(REPO_ROOT / filename)["name"] == name


def test_the_release_workflow_does_not_trigger_on_itself_or_on_automerge(release):
    listed = set(release["on"]["workflow_run"]["workflows"])
    assert release["name"] not in listed
    assert "automerge" not in listed


def test_the_gate_workflow_map_covers_exactly_the_twelve_required_contexts():
    assert gate.REQUIRED_CONTEXTS == {
        "actionlint", "commitlint", "dco", "gitleaks", "issue-link", "test (3.12)",
        "test (3.13)", "trivy", "working-model", "frontend", "frontend-e2e", "review-comments",
    }


# ------------------------------------------------------- the inert default


def test_verify_runs_only_when_release_enabled_is_true(release):
    condition = " ".join(release["jobs"]["verify"]["if"].split())
    assert "vars.RELEASE_ENABLED == 'true'" in condition
    # No other path reads the variable differently, and no job depends on a secret
    # being absent to stay inert.
    assert condition.startswith("vars.RELEASE_ENABLED == 'true' &&")


def test_release_only_runs_after_a_ready_verify(release):
    job = release["jobs"]["release"]
    assert job["needs"] == "verify"
    assert job["if"] == "needs.verify.outputs.ready == 'true'"
    assert "always()" not in job["if"]


def test_verify_filters_to_push_runs_on_main_in_this_repository(release):
    condition = " ".join(release["jobs"]["verify"]["if"].split())
    assert "github.event.workflow_run.event == 'push'" in condition
    assert "github.event.workflow_run.head_branch == 'main'" in condition
    assert "head_repository.full_name == github.repository" in condition


# --------------------------------------------- the lint-style permission rules


def test_workflow_has_a_read_only_top_level_permissions_block(release):
    assert release["permissions"] == {"contents": "read"}


def test_only_the_release_job_has_the_group_the_environment_and_write_permission(release):
    jobs = release["jobs"]
    assert set(jobs) == {"verify", "release"}
    for name, job in jobs.items():
        carries = {
            "concurrency": "concurrency" in job,
            "environment": "environment" in job,
            "write": bool(write_scopes(job.get("permissions"))),
        }
        if name == "release":
            assert all(carries.values()), carries
        else:
            assert not any(carries.values()), f"{name} must stay read-only: {carries}"


def test_verify_permissions_are_explicit_and_read_only(release):
    permissions = release["jobs"]["verify"]["permissions"]
    assert permissions and all(v == "read" for v in permissions.values())


def test_release_job_requests_exactly_the_documented_write_permissions(release):
    assert write_scopes(release["jobs"]["release"]["permissions"]) == {
        "contents", "packages", "id-token", "attestations",
    }


def test_release_concurrency_group_does_not_cancel_the_run_in_progress(release):
    concurrency = release["jobs"]["release"]["concurrency"]
    assert concurrency["cancel-in-progress"] is False
    assert isinstance(concurrency["group"], str) and "${{" not in concurrency["group"]
    assert "concurrency" not in release  # a workflow-level group would also queue verify


def test_release_environment_is_named_release(release):
    assert release["jobs"]["release"]["environment"] == "release"


@pytest.mark.parametrize("scope", WRITE_TOKENS_ONLY_FOR_RELEASE)
def test_no_other_workflow_job_gets_package_oidc_or_attestation_write(scope):
    for filename, workflow in all_workflows().items():
        holders = [("<workflow>", workflow.get("permissions"))] + [
            (name, job.get("permissions")) for name, job in workflow["jobs"].items()
        ]
        for holder, permissions in holders:
            if filename == "release.yml" and holder == "release":
                continue
            assert scope not in write_scopes(permissions), f"{filename}:{holder} grants {scope}"


def test_the_release_job_takes_only_the_sha_from_verify(release):
    text = " ".join(
        str(step) for step in steps(release["jobs"]["release"])
    ) + str(release["jobs"]["release"].get("env"))
    values = set(re.findall(r"needs\.verify\.outputs\.(\w+)", text))
    assert values == {"sha"}


def test_the_release_job_repeats_checks_one_to_four_from_the_sha(release):
    commands = [s.get("run", "") for s in steps(release["jobs"]["release"])]
    joined = "\n".join(commands)
    assert 'release-gate.py check --sha "$RELEASE_SHA"' in joined
    assert 'release-gate.py version-rule --sha "$RELEASE_SHA"' in joined
    assert 'release-gate.py tag --sha "$RELEASE_SHA"' in joined


# ----------------------------------------------------------- the App key


def _env_blocks(workflow: dict[str, Any]):
    yield "workflow", workflow.get("env")
    for job_name, job in workflow["jobs"].items():
        yield f"job {job_name}", job.get("env")
        for index, step in enumerate(job.get("steps", [])):
            yield f"job {job_name} step {index}", step.get("env")


def test_no_workflow_passes_a_secret_through_env():
    # Secrets that exist for a reason can be added to a step's `with`. The
    # release App key is the strict case; the rule here covers every secret
    # except GITHUB_TOKEN, which the plan allows in env.
    for filename, workflow in all_workflows().items():
        for where, env in _env_blocks(workflow):
            for key, value in (env or {}).items():
                for secret in re.findall(r"secrets\.(\w+)", str(value)):
                    assert secret == "GITHUB_TOKEN", f"{filename} {where}: env {key} reads secrets.{secret}"


def test_the_app_key_appears_only_as_an_input_of_the_pinned_token_action(release):
    holders = []
    for filename, workflow in all_workflows().items():
        for job_name, job in workflow["jobs"].items():
            for step in job.get("steps", []):
                if "RELEASE_APP" in yaml.safe_dump(step) or "app-id" in yaml.safe_dump(step):
                    holders.append((filename, job_name, step))
    assert len(holders) == 1
    filename, job_name, step = holders[0]
    assert (filename, job_name) == ("release.yml", "release")
    assert step["uses"].startswith("actions/create-github-app-token@")
    assert set(step["with"]) == {"client-id", "private-key", "permission-contents"}
    assert "app-id" not in step["with"]  # deprecated input; the Client ID is the identity
    assert step["with"]["client-id"] == "${{ secrets.RELEASE_APP_CLIENT_ID }}"
    assert step["with"]["private-key"] == "${{ secrets.RELEASE_APP_PRIVATE_KEY }}"
    assert step["with"]["permission-contents"] == "write"
    assert "env" not in step


def test_no_other_workflow_references_the_release_app_secrets():
    for filename, workflow in all_workflows().items():
        if filename == "release.yml":
            continue
        dumped = yaml.safe_dump(workflow)
        for name in ("RELEASE_APP_CLIENT_ID", "RELEASE_APP_PRIVATE_KEY", "RELEASE_APP"):
            assert name not in dumped, f"{filename} references {name}"


def test_the_release_workflow_names_only_the_two_documented_secrets():
    text = RELEASE.read_text(encoding="utf-8")
    used = set(re.findall(r"secrets\.(\w+)", text))
    assert used == {"RELEASE_APP_CLIENT_ID", "RELEASE_APP_PRIVATE_KEY"}


def test_every_action_in_the_release_workflow_is_pinned_by_commit_sha(release):
    text = RELEASE.read_text(encoding="utf-8")
    for job in release["jobs"].values():
        for step in job["steps"]:
            if "uses" in step:
                assert PINNED_USES.match(step["uses"]), step["uses"]
    for line in text.splitlines():
        if re.search(r"^\s+(- )?uses:", line):
            assert re.search(r"@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+", line), line


def test_the_tag_is_created_last_and_with_the_app_token_not_github_token(release):
    job_steps = steps(release["jobs"]["release"])
    mint = next(s for s in job_steps if str(s.get("uses", "")).startswith("actions/create-github-app-token@"))
    tag = job_steps[-1]
    assert "release-gate.py tag" in tag["run"]
    assert tag["env"]["RELEASE_TAG_TOKEN"] == f"${{{{ steps.{mint['id']}.outputs.token }}}}"
    # GITHUB_TOKEN only reads in that step.
    assert tag["env"]["GH_TOKEN"] == "${{ github.token }}"
    for step in job_steps[:-1]:
        assert "release-gate.py tag" not in step.get("run", "")
    index = job_steps.index
    attest = next(s for s in job_steps if str(s.get("uses", "")).startswith("actions/attest-build-provenance@"))
    publish = next(s for s in job_steps if s.get("name", "").startswith("Publish the verified image"))
    assert index(publish) < index(attest) < index(tag)


def test_the_token_is_minted_before_anything_is_built_or_pushed(release):
    job_steps = steps(release["jobs"]["release"])
    names = [s.get("name", s.get("uses", "")) for s in job_steps]
    mint = next(i for i, s in enumerate(job_steps)
                if str(s.get("uses", "")).startswith("actions/create-github-app-token@"))
    build = next(i for i, n in enumerate(names) if n.startswith("Build the image"))
    publish = next(i for i, n in enumerate(names) if n.startswith("Publish the verified image"))
    assert mint < build < publish


def test_the_attestation_names_the_ghcr_image_and_the_published_digest(release):
    attest = next(s for s in steps(release["jobs"]["release"])
                  if str(s.get("uses", "")).startswith("actions/attest-build-provenance@"))
    assert attest["with"]["subject-name"] == "ghcr.io/dmfdeploy/dmf-cms"
    assert re.fullmatch(r"\$\{\{ steps\.\w+\.outputs\.digest \}\}", attest["with"]["subject-digest"])


def test_the_image_labels_are_checked_before_any_push(release):
    job_steps = steps(release["jobs"]["release"])
    labels = next(i for i, s in enumerate(job_steps) if "check-labels" in s.get("run", ""))
    publish = next(i for i, s in enumerate(job_steps)
                   if s.get("name", "").startswith("Publish the verified image"))
    assert labels < publish


def test_the_publish_step_skips_an_image_that_already_exists(release):
    publish = next(s for s in steps(release["jobs"]["release"])
                   if s.get("name", "").startswith("Publish the verified image"))
    assert publish["if"] == "steps.ghcr_image.outputs.exists != 'true'"


def test_every_umbrella_checkout_is_pinned_by_full_sha_and_holds_no_credentials():
    found = 0
    for filename, workflow in all_workflows().items():
        for job in workflow["jobs"].values():
            for step in job.get("steps", []):
                with_ = step.get("with") or {}
                if with_.get("repository") != "dmfdeploy/dmfdeploy":
                    continue
                if filename == "ci.yml" and with_.get("path") == ".umbrella" and \
                        not re.fullmatch(r"[0-9a-f]{40}", str(with_.get("ref"))):
                    # The working-model job tracks the umbrella template by ref on purpose.
                    continue
                found += 1
                assert re.fullmatch(r"[0-9a-f]{40}", str(with_.get("ref"))), (filename, with_)
                assert with_.get("persist-credentials") is False, (filename, with_)
                assert "token" not in with_ and "ssh-key" not in with_, (filename, with_)
                assert "secrets." not in yaml.safe_dump(step), (filename, step)
    assert found >= 2  # the release job and the ci.yml handoff test
