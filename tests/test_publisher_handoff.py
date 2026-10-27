from __future__ import annotations

import json
import os
import re
import subprocess
import textwrap
from pathlib import Path


def test_release_workflow_wrapper_reaches_real_shared_publisher(tmp_path):
    umbrella = os.environ.get("DMFDEPLOY_UMBRELLA")
    if not umbrella:
        # Local runs use the canonical sibling checkout; CI checks it out at
        # the pinned ref before running this test.
        umbrella = str(Path(__file__).resolve().parents[1].parent / "dmfdeploy")
    helper = Path(umbrella) / "bin" / "publish-image-to-ghcr.sh"
    assert helper.is_file(), f"real shared publisher not found: {helper}"
    repo = Path(__file__).resolve().parents[1]
    version = (repo / "VERSION").read_text(encoding="utf-8").strip()
    workflow = (repo / ".github/workflows/release.yml").read_text(encoding="utf-8")
    publish_step = workflow.split("- name: Publish the verified image to GHCR", 1)[1].split(
        "\n      - name:", 1
    )[0]
    user_match = re.search(r"^\s+GHCR_USER:\s+\$\{\{\s*github\.actor\s*\}\}\s*$", publish_step, re.MULTILINE)
    docker_match = re.search(r"^\s+DOCKER_HOST:\s+(unix:///var/run/docker.sock)\s*$", publish_step, re.MULTILINE)
    run_match = re.search(r"^        run: \|\n((?:^          .*\n)+)", publish_step, re.MULTILINE)
    assert user_match, "release workflow must pass GHCR_USER from github.actor"
    assert docker_match, "release workflow must override the shared helper's Colima socket"
    assert run_match, "release workflow publish invocation must be present"
    workflow_command = textwrap.dedent(run_match.group(1))

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    calls = tmp_path / "docker-calls"
    received_token = tmp_path / "received-token"
    docker = fake_bin / "docker"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        'printf "%s|%s\\n" "$*" "${DOCKER_HOST:-}" >> "$DOCKER_CALLS"\n'
        'if [[ "$1" == login ]]; then cat > "$DOCKER_TOKEN"; exit 0; fi\n'
        f'if [[ "$1" == image && "$2" == inspect && "$3" == registry.dmf.example.com/dmf-cms:{version} ]]; then\n'
        '  if [[ "${4:-}" == --format ]]; then echo amd64/linux; fi\n'
        '  exit 0\n'
        'fi\n'
        'if [[ "$1" == image && "$2" == inspect ]]; then echo ghcr.io/dmfdeploy/dmf-cms@sha256:fixture; exit 0; fi\n'
        'exit 0\n',
        encoding="utf-8",
    )
    docker.chmod(0o755)
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"action": "cms-release", "client_payload": {"pr_number": 568}}), encoding="utf-8")
    env = os.environ.copy()
    env.update({
        "PATH": f"{fake_bin}:{env['PATH']}",
        "HOME": str(tmp_path),
        "DOCKER_CALLS": str(calls),
        "DOCKER_TOKEN": str(received_token),
        "RELEASE_TOKEN": "test-token-never-log",
        "DMFDEPLOY_UMBRELLA": str(umbrella),
        "GITHUB_ACTIONS": "true",
        "GITHUB_WORKFLOW": "DMF CMS Release",
        "GITHUB_EVENT_NAME": "repository_dispatch",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_SHA": "a" * 40,
        "GITHUB_RUN_ID": "1234",
        "GITHUB_EVENT_PATH": str(event),
        "DMF_CMS_RELEASE_GATE_PASSED": "true",
        "DMF_CMS_RELEASE_SHA": "a" * 40,
        "GHCR_USER": "github-actions[bot]",
        "DOCKER_HOST": docker_match.group(1),
    })
    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", workflow_command],
        text=True, capture_output=True, env=env, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert received_token.read_text(encoding="utf-8") == "test-token-never-log"
    docker_calls = calls.read_text(encoding="utf-8")
    assert f"tag registry.dmf.example.com/dmf-cms:{version} ghcr.io/dmfdeploy/dmf-cms:{version}|unix:///var/run/docker.sock" in docker_calls
    assert "login ghcr.io -u github-actions[bot] --password-stdin|unix:///var/run/docker.sock" in docker_calls
    assert f"push ghcr.io/dmfdeploy/dmf-cms:{version}|unix:///var/run/docker.sock" in docker_calls
    assert "test-token-never-log" not in result.stdout + result.stderr + docker_calls
