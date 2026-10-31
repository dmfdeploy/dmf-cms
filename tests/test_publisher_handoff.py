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
        *) echo ghcr.io/dmfdeploy/dmf-cms@sha256:fixture ;;
      esac
    fi
    exit 0 ;;
esac
exit 0
"""


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
            "PATH": f"{fake_bin}:{env['PATH']}",
            "HOME": str(tmp_path),
            "DOCKER_CALLS": str(calls),
            "DOCKER_TOKEN": str(received),
            "DMFDEPLOY_UMBRELLA": str(umbrella_dir()),
        }
    )
    assert step["working-directory"] == "src"  # the checkout of the verified commit
    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", command],
        text=True, capture_output=True, env=env, cwd=REPO, check=False,
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
