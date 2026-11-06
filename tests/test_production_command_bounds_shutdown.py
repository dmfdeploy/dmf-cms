"""The production start command must bound graceful shutdown
(dmfdeploy/dmfdeploy#845), so open connections or running work cannot hold the
process until the kubelet kills it at the pod's termination grace period.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KUBERNETES_DEFAULT_GRACE_SECONDS = 30


def _dockerfile_cmd() -> list[str]:
    match = re.search(r"^CMD (\[.*\])\s*$", (ROOT / "Dockerfile").read_text(), re.M)
    assert match, "Dockerfile has no exec-form CMD"
    return json.loads(match.group(1))


def test_cmd_carries_a_graceful_shutdown_timeout_under_the_pod_grace_period():
    cmd = _dockerfile_cmd()
    assert cmd[0] == "uvicorn"
    assert "--timeout-graceful-shutdown" in cmd
    seconds = int(cmd[cmd.index("--timeout-graceful-shutdown") + 1])
    assert 0 < seconds <= KUBERNETES_DEFAULT_GRACE_SECONDS // 2


def test_chart_does_not_replace_the_command_or_change_the_grace_period():
    # If either changes, the bound above has to be re-checked against it.
    deployment = (ROOT / "charts/dmf-cms/templates/deployment.yaml").read_text()
    assert not re.search(r"^\s*(command|args):", deployment, re.M)
    assert "terminationGracePeriodSeconds" not in deployment
