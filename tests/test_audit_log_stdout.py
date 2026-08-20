"""umbrella #425 — the C5 audit line must actually reach a deployed pod's log.

VERIFICATION TRAP (see the issue's own note, and the docstring below): a
pytest test asserting ``caplog`` captures the ``awx write: ...`` line PASSES
REGARDLESS of whether ``dmf_cms``'s loggers have a real handler anywhere,
because ``caplog`` installs its OWN handler directly and works by forcing
the target logger's level for the duration of the test — it never goes
through ``logging.lastResort`` at all, so it cannot see this defect. Every
one of the ~15 caplog-based "awx write:" tests elsewhere in this suite
(``test_awx_write_gate.py``, ``test_finalise_purge_endpoint.py``, ...) was
already green at v0.24.0 — the exact version where this line never once
reached a real deployed pod's log (see the issue's own live evidence).

This file is deliberately NOT a caplog test. It runs the app the way it is
actually served — a real ``uvicorn`` subprocess, no pytest logging
fixtures in the loop at all — drives a gated AWX write through it, and
reads the audit line back off the *process's own stdout*. This is the only
check in the suite that can distinguish "the line is logged" (always true)
from "the line reaches a stream anyone could read" (what #425 is about).
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_healthz(base_url: str, deadline: float) -> None:
    last_exc: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/healthz", timeout=1) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, OSError) as exc:
            last_exc = exc
        time.sleep(0.2)
    raise AssertionError(f"uvicorn subprocess never became healthy: {last_exc!r}")


def _pump_stdout(proc: subprocess.Popen, sink: "queue.Queue[str]") -> None:
    assert proc.stdout is not None
    for line in proc.stdout:
        sink.put(line)


def test_awx_write_audit_line_reaches_process_stdout_under_real_uvicorn():
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"

    env = os.environ.copy()
    # Deterministic "AWX not configured" outcome regardless of whatever the
    # ambient environment happens to have set — this test needs the
    # AUDITED-REFUSAL path (still calls _audit_awx_write, per the issue's
    # own "asymmetry" note about failure paths auditing too), not a real
    # AWX round-trip.
    env.pop("DMF_CONSOLE_AWX_API_URL", None)
    env.pop("DMF_CONSOLE_AWX_API_TOKEN", None)
    env["DMF_CONSOLE_OIDC_ENABLED"] = "false"
    env["DMF_CONSOLE_RUNTIME_MODE"] = "local"
    env["DMF_CONSOLE_DEV_LOGIN_ENABLED"] = "true"
    # operator+ is the launch endpoint's own gate — the default dev group
    # (dmf-console-viewer) would 403 before ever reaching the audit call.
    env["DMF_CONSOLE_DEV_GROUPS"] = "dmf-console-operator"

    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn", "dmf_cms.main:app",
            "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning",
        ],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    lines: "queue.Queue[str]" = queue.Queue()
    pump = threading.Thread(target=_pump_stdout, args=(proc, lines), daemon=True)
    pump.start()
    try:
        _wait_for_healthz(base_url, deadline=time.monotonic() + 20)

        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        # Dev-login redirects to "/" — the cookie jar picks up the session
        # cookie SessionMiddleware sets along the way.
        with opener.open(f"{base_url}/auth/login", timeout=5) as resp:
            assert resp.status == 200

        body = json.dumps({"reason": "umbrella#425 subprocess stdout check"}).encode()
        req = urllib.request.Request(
            f"{base_url}/api/workflows/does-not-matter/launch",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            opener.open(req, timeout=5)
            raise AssertionError("expected a 503 (AWX API not configured)")
        except urllib.error.HTTPError as exc:
            assert exc.code == 503
            payload = json.loads(exc.read())
            assert payload["error"] == "AWX API not configured"
            request_id = payload["request_id"]

        deadline = time.monotonic() + 10
        seen: list[str] = []
        matched: str | None = None
        while time.monotonic() < deadline and matched is None:
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                continue
            seen.append(line)
            if "dmf_cms.audit" in line and "awx write:" in line and request_id in line:
                matched = line

        assert matched is not None, (
            "the awx write: audit line never reached the process's stdout "
            "— captured subprocess output:\n" + "".join(seen)
        )
        assert "action=launch" in matched
        assert "outcome=awx-not-configured" in matched
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        pump.join(timeout=5)
