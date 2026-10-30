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


def publish_step() -> dict:
    workflow = yaml.safe_load((REPO / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    steps = workflow["jobs"]["release"]["steps"]
    return next(s for s in steps if s.get("name", "").startswith("Publish the verified image"))


def run_block(tmp_path: Path, command: str, version: str) -> tuple[subprocess.CompletedProcess, str, Path]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    calls = tmp_path / "docker-calls"
    received = tmp_path / "received-token"
    (fake_bin / "docker").write_text(FAKE_DOCKER, encoding="utf-8")
    (fake_bin / "docker").chmod(0o755)
    step = publish_step()
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


def test_the_publish_step_reaches_the_real_shared_publisher(tmp_path):
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    result, docker_calls, received = run_block(tmp_path, publish_step()["run"], version)
    assert result.returncode == 0, result.stdout + result.stderr
    assert received.read_text(encoding="utf-8") == FAKE_TOKEN
    assert (
        f"tag registry.dmf.example.com/dmf-cms:{version} ghcr.io/dmfdeploy/dmf-cms:{version}"
        f"|{DOCKER_SOCKET}" in docker_calls
    )
    assert f"login ghcr.io -u github-actions[bot] --password-stdin|{DOCKER_SOCKET}" in docker_calls
    assert f"push ghcr.io/dmfdeploy/dmf-cms:{version}|{DOCKER_SOCKET}" in docker_calls
    # The token reaches Docker on standard input only.
    assert FAKE_TOKEN not in result.stdout + result.stderr + docker_calls


def test_the_old_pipeline_without_the_final_newline_fails_before_docker_login(tmp_path):
    """The shared helper reads one line. `printf '%s'` ends without a newline,
    `read` then returns non-zero, and the helper stops before `docker login`."""
    command = publish_step()["run"].replace("printf '%s\\n'", "printf '%s'")
    assert command != publish_step()["run"], "the step must pipe with a terminating newline"
    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    result, docker_calls, _ = run_block(tmp_path, command, version)
    assert result.returncode != 0
    assert "login" not in docker_calls


def test_the_step_pipes_the_token_with_a_terminating_newline():
    assert "printf '%s\\n' \"$publisher_token\" | scripts/publish-to-ghcr.sh" in publish_step()["run"]
