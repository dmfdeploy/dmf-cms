"""The release workflow's publish step must reach the shared GHCR publisher.

The test extracts the real `run:` block from release.yml and runs it with a
fake Docker CLI. The real wrapper (scripts/publish-to-ghcr.sh) and the real
shared helper (the umbrella's bin/publish-image-to-ghcr.sh) run unmodified.

The helper needs the umbrella checkout. Set DMFDEPLOY_UMBRELLA, or keep the
umbrella as a sibling of this repository. CI checks it out at a pinned ref.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
FAKE_TOKEN = "test-token-never-log"
DOCKER_SOCKET = "unix:///var/run/docker.sock"

FAKE_DOCKER = """#!/usr/bin/env bash
set -eu
printf '%s|%s\\n' "$*" "${DOCKER_HOST:-}" >> "$DOCKER_CALLS"
case "$1" in
  login) cat > "$DOCKER_TOKEN"; exit 0 ;;
  info) exit 0 ;;
  image)
    if [[ "$2" == inspect && "${4:-}" == --format ]]; then
      case "$5" in
        *Architecture*) echo amd64/linux ;;
        *Labels*) echo "${FAKE_REVISION:-}" ;;
        *) echo ghcr.io/dmfdeploy/dmf-cms@sha256:fixture ;;
      esac
    fi
    exit 0 ;;
esac
exit 0
"""


def release_workflow_name() -> str:
    workflow = yaml.safe_load((REPO / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    return workflow["name"]


# What a GitHub Actions runner sets for a job in the release workflow.
ACTIONS_ENV = {"GITHUB_ACTIONS": "true", "GITHUB_WORKFLOW": release_workflow_name()}


def umbrella_dir() -> Path:
    umbrella = os.environ.get("DMFDEPLOY_UMBRELLA") or str(REPO.parent / "dmfdeploy")
    helper = Path(umbrella) / "bin" / "publish-image-to-ghcr.sh"
    if not helper.is_file():
        pytest.fail(
            f"real shared publisher not found at {helper}; set DMFDEPLOY_UMBRELLA to an "
            "umbrella checkout. This test does not skip, because a skipped handoff "
            "test would hide a broken publish step."
        )
    return Path(umbrella)


def make_checkout(tmp_path: Path, *, tag: str | None = None, extra_commit: bool = False) -> tuple[Path, str]:
    """A small git checkout holding the real wrapper, so the revision check
    sees a known commit and a clean tree whatever state this repository is in.
    Returns the checkout and its HEAD commit."""
    checkout = tmp_path / "checkout"
    (checkout / "scripts").mkdir(parents=True)
    shutil.copy(REPO / "scripts" / "publish-to-ghcr.sh", checkout / "scripts")
    shutil.copy(REPO / "VERSION", checkout)
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()

    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
            cwd=checkout, text=True, capture_output=True, check=True,
        ).stdout.strip()

    git("init", "-q")
    git("add", ".")
    git("commit", "-q", "-m", "release")
    if tag == "first":
        git("tag", f"v{version}")
    if extra_commit:
        (checkout / "notes").write_text("later\n", encoding="utf-8")
        git("add", ".")
        git("commit", "-q", "-m", "later")
    if tag == "head":
        git("tag", f"v{version}")
    if tag == "broken":
        # A tag ref whose object is missing: show-ref exits 128.
        (checkout / ".git" / "refs" / "tags" / f"v{version}").write_text(
            "0123456789abcdef0123456789abcdef01234567\n", encoding="utf-8"
        )
    return checkout, git("rev-parse", "HEAD")


def release_steps() -> list[dict]:
    workflow = yaml.safe_load((REPO / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    return workflow["jobs"]["release"]["steps"]


def publish_step(arch: str = "arm64") -> dict:
    return next(
        s for s in release_steps() if s.get("name", "").startswith(f"Publish the verified {arch}")
    )


def run_block(tmp_path: Path, command: str, arch: str) -> tuple[subprocess.CompletedProcess, str, Path]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    calls = tmp_path / "docker-calls"
    received = tmp_path / "received-token"
    (fake_bin / "docker").write_text(FAKE_DOCKER, encoding="utf-8")
    (fake_bin / "docker").chmod(0o755)
    step = publish_step(arch)
    # The step sets these from the Actions context. Resolve each one the way
    # Actions does, so the test fails if the step stops setting it.
    context = {"github.actor": "github-actions[bot]", "github.token": FAKE_TOKEN,
               "github.workspace": str(tmp_path / "workspace")}
    env_in_step = {
        key: re.sub(r"\$\{\{\s*([\w.]+)\s*\}\}", lambda m: context[m.group(1)], str(value))
        for key, value in step["env"].items()
    }
    assert env_in_step["GHCR_USER"] == "github-actions[bot]"
    assert env_in_step["DOCKER_HOST"] == DOCKER_SOCKET
    assert env_in_step["RELEASE_TOKEN"] == FAKE_TOKEN
    assert env_in_step["IMAGE_TAG_SUFFIX"] == f"-{arch}"
    env = os.environ.copy()
    env.update(env_in_step)
    env.update(
        {
            **ACTIONS_ENV,
            "PATH": f"{fake_bin}:{env['PATH']}",
            "HOME": str(tmp_path),
            "DOCKER_CALLS": str(calls),
            "DOCKER_TOKEN": str(received),
            "DMFDEPLOY_UMBRELLA": str(umbrella_dir()),
        }
    )
    assert step["working-directory"] == "src"  # the checkout of the verified commit
    checkout, head = make_checkout(tmp_path)
    env["FAKE_REVISION"] = head
    # The job, not the step, sets the verified commit; steps inherit it.
    workflow = yaml.safe_load((REPO / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    assert "RELEASE_SHA" in workflow["jobs"]["release"]["env"]
    env["RELEASE_SHA"] = head
    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", command],
        text=True, capture_output=True, env=env, cwd=checkout, check=False,
    )
    return result, (calls.read_text(encoding="utf-8") if calls.exists() else ""), received


@pytest.mark.parametrize("arch", ["arm64", "amd64"])
def test_the_publish_step_reaches_the_real_shared_publisher(tmp_path, arch):
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    result, docker_calls, received = run_block(tmp_path, publish_step(arch)["run"], arch)
    assert result.returncode == 0, result.stdout + result.stderr
    assert received.read_text(encoding="utf-8") == FAKE_TOKEN
    local = f"registry.dmf.example.com/dmf-cms:{version}-{arch}"
    remote = f"ghcr.io/dmfdeploy/dmf-cms:{version}-{arch}"
    assert f"tag {local} {remote}|{DOCKER_SOCKET}" in docker_calls
    assert f"login ghcr.io -u github-actions[bot] --password-stdin|{DOCKER_SOCKET}" in docker_calls
    assert f"push {remote}|{DOCKER_SOCKET}" in docker_calls
    # The version tag itself is never pushed by this step: only the index owns it.
    assert f"push ghcr.io/dmfdeploy/dmf-cms:{version}|" not in docker_calls
    # The token reaches Docker on standard input only.
    assert FAKE_TOKEN not in result.stdout + result.stderr + docker_calls


@pytest.mark.parametrize("arch", ["arm64", "amd64"])
def test_the_old_pipeline_without_the_final_newline_fails_before_docker_login(tmp_path, arch):
    """The shared helper reads one line. `printf '%s'` ends without a newline,
    `read` then returns non-zero, and the helper stops before `docker login`."""
    command = publish_step(arch)["run"].replace("printf '%s\\n'", "printf '%s'")
    assert command != publish_step(arch)["run"], "the step must pipe with a terminating newline"
    result, docker_calls, _ = run_block(tmp_path, command, arch)
    assert result.returncode != 0
    assert "login" not in docker_calls


@pytest.mark.parametrize("arch", ["arm64", "amd64"])
def test_the_step_pipes_the_token_with_a_terminating_newline(arch):
    assert "printf '%s\\n' \"$publisher_token\" | scripts/publish-to-ghcr.sh" in publish_step(arch)["run"]


def run_wrapper(
    tmp_path: Path,
    suffix: str | None,
    actions_env: dict[str, str] | None = None,
    *,
    revision: str | None = None,
    tag: str | None = None,
    extra_commit: bool = False,
    dirty: bool = False,
    release_sha: str | None = "head",
) -> tuple[subprocess.CompletedProcess, str]:
    """`revision` is the image's revision label: None means the checkout's HEAD,
    "" means no label. `release_sha` is the workflow's verified commit: "head" means
    the checkout's HEAD, None leaves it unset."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    calls = tmp_path / "docker-calls"
    (fake_bin / "docker").write_text(FAKE_DOCKER, encoding="utf-8")
    (fake_bin / "docker").chmod(0o755)
    env = {
        k: v for k, v in os.environ.items()
        if k not in {"IMAGE_TAG_SUFFIX", "GITHUB_ACTIONS", "GITHUB_WORKFLOW"}
    }
    env.update(ACTIONS_ENV if actions_env is None else actions_env)
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "HOME": str(tmp_path),
            "DOCKER_CALLS": str(calls),
            "DOCKER_TOKEN": str(tmp_path / "received-token"),
            "DMFDEPLOY_UMBRELLA": str(umbrella_dir()),
            "GHCR_USER": "github-actions[bot]",
        }
    )
    if suffix is not None:
        env["IMAGE_TAG_SUFFIX"] = suffix
    checkout, head = make_checkout(tmp_path, tag=tag, extra_commit=extra_commit)
    env["FAKE_REVISION"] = head if revision is None else revision
    env.pop("RELEASE_SHA", None)
    if release_sha is not None:
        env["RELEASE_SHA"] = head if release_sha == "head" else release_sha
    if dirty:
        (checkout / "untracked").write_text("x\n", encoding="utf-8")
    result = subprocess.run(
        ["bash", str(checkout / "scripts" / "publish-to-ghcr.sh")],
        input=FAKE_TOKEN + "\n", text=True, capture_output=True, env=env, cwd=checkout, check=False,
    )
    return result, (calls.read_text(encoding="utf-8") if calls.exists() else "")


@pytest.mark.parametrize("suffix", [None, ""])
def test_the_wrapper_refuses_to_push_the_bare_version_tag(tmp_path, suffix):
    """A single-platform image at the version tag would block the two-platform
    index for good, because version tags are immutable."""
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    result, docker_calls = run_wrapper(tmp_path, suffix)
    assert result.returncode != 0
    assert "refusing to push the version tag" in result.stderr
    assert "release workflow" in result.stderr
    assert docker_calls == ""  # no login, no tag, no push
    assert f"push ghcr.io/dmfdeploy/dmf-cms:{version}" not in docker_calls


def test_the_wrapper_still_pushes_a_staging_tag(tmp_path):
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    result, docker_calls = run_wrapper(tmp_path, "-arm64")
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"push ghcr.io/dmfdeploy/dmf-cms:{version}-arm64|" in docker_calls


@pytest.mark.parametrize(
    "actions_env",
    [
        {},
        {"GITHUB_ACTIONS": "true"},
        {"GITHUB_WORKFLOW": "release"},
        {"GITHUB_ACTIONS": "false", "GITHUB_WORKFLOW": "release"},
        {"GITHUB_ACTIONS": "true", "GITHUB_WORKFLOW": "some other workflow"},
    ],
)
def test_the_wrapper_refuses_to_push_outside_the_release_workflow(tmp_path, actions_env):
    """A workstation run, or a run in another workflow, must not reach Docker,
    even with a valid suffix and a token on standard input."""
    result, docker_calls = run_wrapper(tmp_path, "-arm64", actions_env)
    assert result.returncode != 0
    assert 'only from the "release" workflow' in result.stderr
    assert "build-image.sh --no-push" in result.stderr
    assert docker_calls == ""  # no login, no tag, no push


def test_the_wrapper_accepts_the_release_workflow_environment(tmp_path):
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    result, docker_calls = run_wrapper(tmp_path, "-amd64", dict(ACTIONS_ENV))
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"push ghcr.io/dmfdeploy/dmf-cms:{version}-amd64|" in docker_calls


def test_the_wrapper_guard_names_the_workflow_in_release_yml():
    script = (REPO / "scripts" / "publish-to-ghcr.sh").read_text(encoding="utf-8")
    assert f'RELEASE_WORKFLOW_NAME="{release_workflow_name()}"' in script


@pytest.mark.parametrize("arch", ["arm64", "amd64"])
def test_every_workflow_publish_step_sets_a_suffix(arch):
    """The workflow never relies on the bare tag: both steps pass a suffix."""
    step = publish_step(arch)
    assert step["env"]["IMAGE_TAG_SUFFIX"] == f"-{arch}"


# ------------------------------------------------ the revision check

OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567"


def assert_nothing_pushed(docker_calls: str) -> None:
    assert "login" not in docker_calls
    assert "push " not in docker_calls
    assert "tag " not in docker_calls


def test_the_wrapper_refuses_an_image_built_from_another_commit(tmp_path):
    """After a rebase merge the tag names a new commit, and an image built
    before the merge still carries the old one."""
    result, docker_calls = run_wrapper(tmp_path, "-arm64", revision=OTHER_COMMIT, tag="head")
    assert result.returncode != 0
    assert "revision label differs" in result.stderr
    assert OTHER_COMMIT in result.stderr
    assert re.search(r"expected commit: [0-9a-f]{40}", result.stderr)
    assert "--platform linux/arm64 --tag-suffix -arm64" in result.stderr
    assert_nothing_pushed(docker_calls)


def test_the_wrapper_accepts_an_image_built_from_the_tagged_commit(tmp_path):
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    result, docker_calls = run_wrapper(tmp_path, "-arm64", tag="head")
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"push ghcr.io/dmfdeploy/dmf-cms:{version}-arm64|" in docker_calls


def test_the_wrapper_fails_closed_when_the_image_has_no_revision_label(tmp_path):
    result, docker_calls = run_wrapper(tmp_path, "-arm64", revision="", tag="head")
    assert result.returncode != 0
    assert "no org.opencontainers.image.revision label" in result.stderr
    assert "<missing>" in result.stderr
    assert_nothing_pushed(docker_calls)


def test_the_wrapper_refuses_a_checkout_that_is_not_at_the_tagged_commit(tmp_path):
    """The label matches HEAD, yet the tag names an earlier commit."""
    result, docker_calls = run_wrapper(tmp_path, "-arm64", tag="first", extra_commit=True)
    assert result.returncode != 0
    assert "not at the commit" in result.stderr
    assert_nothing_pushed(docker_calls)


def test_an_unreadable_tag_is_not_an_absent_tag(tmp_path):
    """Git cannot read the tag, so the verified commit must not stand in."""
    result, docker_calls = run_wrapper(tmp_path, "-arm64", tag="broken")
    assert result.returncode != 0
    assert "could not read tag" in result.stderr
    assert_nothing_pushed(docker_calls)


def test_without_a_tag_the_wrapper_accepts_an_image_of_the_verified_commit(tmp_path):
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    result, docker_calls = run_wrapper(tmp_path, "-arm64")
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"push ghcr.io/dmfdeploy/dmf-cms:{version}-arm64|" in docker_calls


def test_without_a_tag_the_image_must_match_the_verified_commit(tmp_path):
    result, docker_calls = run_wrapper(tmp_path, "-arm64", revision=OTHER_COMMIT, release_sha="head")
    assert result.returncode != 0
    assert "differs from the release workflow's verified commit" in result.stderr
    assert_nothing_pushed(docker_calls)


def test_without_a_tag_the_checkout_must_be_the_verified_commit(tmp_path):
    result, docker_calls = run_wrapper(tmp_path, "-arm64", release_sha=OTHER_COMMIT, revision=OTHER_COMMIT)
    assert result.returncode != 0
    assert "not at the release workflow's verified commit" in result.stderr
    assert_nothing_pushed(docker_calls)


def test_without_a_tag_or_a_verified_commit_the_wrapper_refuses(tmp_path):
    result, docker_calls = run_wrapper(tmp_path, "-arm64", release_sha=None)
    assert result.returncode != 0
    assert "no commit to check against" in result.stderr
    assert_nothing_pushed(docker_calls)


@pytest.mark.parametrize("arch", ["arm64", "amd64"])
def test_the_rebuild_advice_names_the_platform_of_the_suffix(tmp_path, arch):
    result, _ = run_wrapper(tmp_path, f"-{arch}", revision=OTHER_COMMIT)
    assert f"--platform linux/{arch} --tag-suffix -{arch}" in result.stderr


def test_the_wrapper_refuses_a_dirty_tree(tmp_path):
    result, docker_calls = run_wrapper(tmp_path, "-arm64", tag="head", dirty=True)
    assert result.returncode != 0
    assert "uncommitted changes" in result.stderr
    assert_nothing_pushed(docker_calls)


# ------------------------------------------------ the index join (imagetools)

ARM = "sha256:" + "1" * 64
AMD = "sha256:" + "2" * 64
FAKE_INDEX_DOCKER = """#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$1 ${2:-} ${3:-}" in
  "login ghcr.io -u") cat > "$DOCKER_TOKEN"; exit 0 ;;
  "buildx imagetools inspect")
    if [[ "${PROBE:-missing}" == present ]]; then echo '{}'; exit 0; fi
    if [[ "${PROBE:-missing}" == broken ]]; then echo 'ERROR: Head: 502 Bad Gateway' >&2; exit 1; fi
    echo "ERROR: $4: not found" >&2; exit 1 ;;
  "buildx imagetools create") exit 0 ;;
esac
exit 0
"""


def run_index(tmp_path, *, probe="missing", args=None, stdin=None):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "docker").write_text(FAKE_INDEX_DOCKER, encoding="utf-8")
    (fake_bin / "docker").chmod(0o755)
    calls = tmp_path / "calls"
    token = tmp_path / "token"
    env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}", "DOCKER_CALLS": str(calls),
           "DOCKER_TOKEN": str(token), "GHCR_USER": "github-actions[bot]", "PROBE": probe}
    result = subprocess.run(
        ["bash", str(REPO / "scripts" / "publish-index-to-ghcr.sh"),
         *(args if args is not None else ["--arm64", ARM, "--amd64", AMD])],
        input=FAKE_TOKEN + "\n" if stdin is None else stdin,
        text=True, capture_output=True, env=env, check=False,
    )
    return result, (calls.read_text() if calls.exists() else ""), token


def test_the_index_script_joins_exactly_the_two_digests_under_the_version_tag(tmp_path):
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    result, calls, token = run_index(tmp_path)
    assert result.returncode == 0, result.stderr
    repo = "ghcr.io/dmfdeploy/dmf-cms"
    assert f"buildx imagetools create -t {repo}:{version} {repo}@{ARM} {repo}@{AMD}" in calls
    assert token.read_text() == FAKE_TOKEN
    assert FAKE_TOKEN not in result.stdout + result.stderr + calls


def test_the_index_script_never_overwrites_an_existing_version_tag(tmp_path):
    result, calls, _ = run_index(tmp_path, probe="present")
    assert result.returncode != 0 and "refusing to overwrite" in result.stderr
    assert "imagetools create" not in calls


def test_the_index_script_stops_when_it_cannot_tell_whether_the_tag_exists(tmp_path):
    result, calls, _ = run_index(tmp_path, probe="broken")
    assert result.returncode != 0 and "could not tell" in result.stderr
    assert "imagetools create" not in calls


@pytest.mark.parametrize(
    "args",
    [[], ["--arm64", ARM], ["--arm64", ARM, "--amd64", "sha256:short"],
     ["--arm64", ARM, "--amd64", ARM], ["--arm64", ARM, "--amd64", AMD, "--extra", "x"]],
)
def test_the_index_script_rejects_bad_digests_before_logging_in(tmp_path, args):
    result, calls, _ = run_index(tmp_path, args=args)
    assert result.returncode != 0
    assert "login" not in calls and "imagetools create" not in calls


def test_the_index_script_needs_a_token_on_standard_input(tmp_path):
    result, calls, _ = run_index(tmp_path, stdin="")
    assert result.returncode != 0
    assert "login" not in calls
