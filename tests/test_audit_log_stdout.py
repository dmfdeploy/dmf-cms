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

umbrella dmf-cms#108 fix-round 1: stdout and stderr are read as TWO
SEPARATE pipes, and every match below is against stdout alone. Merging
them (``stderr=subprocess.STDOUT``, the original shape of this test) would
let a regression that sent the audit line to stderr instead — or a config
that installs only a root *stderr* handler — pass this test while the
actual contract (the line is on *stdout*, matching uvicorn's own access
log and PYTHONUNBUFFERED-friendly container log collection) stays broken.
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

import pytest

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


def _pump(stream, sink: "queue.Queue[str]") -> None:
    for line in stream:
        sink.put(line)


class _RunningConsole:
    def __init__(self, proc, base_url, opener, stdout_lines, stderr_lines):
        self.proc = proc
        self.base_url = base_url
        self.opener = opener
        self.stdout_lines = stdout_lines
        self.stderr_lines = stderr_lines


@pytest.fixture
def running_console():
    """A real ``dmf_cms.main:app`` served by ``uvicorn`` in a subprocess,
    dev-login authenticated as an operator, AWX deliberately left
    unconfigured (env-scrubbed, deterministic regardless of the ambient
    environment) — the shared setup both tests in this file drive a gated
    write against.
    """
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"

    env = os.environ.copy()
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
        # Deliberately NOT subprocess.STDOUT — see the module docstring.
        # stderr is still drained (into its own queue, unread unless a
        # failure needs it for diagnostics) so uvicorn's stderr writes
        # (its startup banner, access/error logs by default) can never
        # fill the pipe buffer and block the child.
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None and proc.stderr is not None
    stdout_lines: "queue.Queue[str]" = queue.Queue()
    stderr_lines: "queue.Queue[str]" = queue.Queue()
    stdout_pump = threading.Thread(target=_pump, args=(proc.stdout, stdout_lines), daemon=True)
    stderr_pump = threading.Thread(target=_pump, args=(proc.stderr, stderr_lines), daemon=True)
    stdout_pump.start()
    stderr_pump.start()
    try:
        _wait_for_healthz(base_url, deadline=time.monotonic() + 20)

        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        # Dev-login redirects to "/" — the cookie jar picks up the session
        # cookie SessionMiddleware sets along the way.
        with opener.open(f"{base_url}/auth/login", timeout=5) as resp:
            assert resp.status == 200

        yield _RunningConsole(proc, base_url, opener, stdout_lines, stderr_lines)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        stdout_pump.join(timeout=5)
        stderr_pump.join(timeout=5)


def _drive_gated_write(console: _RunningConsole) -> str:
    """POST a workflow launch with AWX left unconfigured — deterministically
    hits the ``outcome=awx-not-configured`` audit path (still calls
    ``_audit_awx_write``, per the issue's own "asymmetry" note about
    failure paths auditing too) — and return the request_id it echoes.
    """
    body = json.dumps({"reason": "umbrella#425 subprocess stdout check"}).encode()
    req = urllib.request.Request(
        f"{console.base_url}/api/workflows/does-not-matter/launch",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        console.opener.open(req, timeout=5)
        raise AssertionError("expected a 503 (AWX API not configured)")
    except urllib.error.HTTPError as exc:
        assert exc.code == 503
        payload = json.loads(exc.read())
        assert payload["error"] == "AWX API not configured"
        return payload["request_id"]


def _collect_audit_lines(
    stdout_lines: "queue.Queue[str]", request_id: str, *, overall_timeout: float = 10.0, quiet_grace: float = 1.0,
) -> tuple[list[str], list[str]]:
    """Drain ``stdout_lines``, returning every line matching the audit
    record for ``request_id`` (plus everything seen, for diagnostics).

    Keeps draining for ``quiet_grace`` seconds of silence AFTER the first
    match rather than returning immediately on it — umbrella dmf-cms#108
    fix-round 1 (DECIDE+DOCUMENT — propagate): a double-emission bug would
    show up as a SECOND matching line arriving right behind the first, and
    a helper that stops at "found one" can never see that.
    """
    deadline = time.monotonic() + overall_timeout
    matches: list[str] = []
    all_seen: list[str] = []
    quiet_until: float | None = None
    while time.monotonic() < deadline:
        poll = 0.3 if quiet_until is None else max(0.01, min(0.3, quiet_until - time.monotonic()))
        try:
            line = stdout_lines.get(timeout=poll)
        except queue.Empty:
            if quiet_until is not None and time.monotonic() >= quiet_until:
                break
            continue
        all_seen.append(line)
        if "dmf_cms.audit" in line and "awx write:" in line and request_id in line:
            matches.append(line)
            quiet_until = time.monotonic() + quiet_grace
    return matches, all_seen


def test_awx_write_audit_line_reaches_process_stdout_under_real_uvicorn(running_console):
    request_id = _drive_gated_write(running_console)
    matches, seen = _collect_audit_lines(running_console.stdout_lines, request_id)

    if not matches:
        stderr_seen: list[str] = []
        while True:
            try:
                stderr_seen.append(running_console.stderr_lines.get_nowait())
            except queue.Empty:
                break
        raise AssertionError(
            "the awx write: audit line never reached the process's STDOUT "
            "— captured stdout:\n" + "".join(seen) +
            "\n— captured stderr (NOT where this test looks; here only "
            "for diagnosis):\n" + "".join(stderr_seen)
        )
    line = matches[0]
    assert "action=launch" in line
    assert "outcome=awx-not-configured" in line


def test_awx_write_audit_line_appears_exactly_once_on_stdout_under_deployed_config(running_console):
    """umbrella dmf-cms#108 fix-round 1 (DECIDE+DOCUMENT — propagate):
    ``dmf_cms.audit`` is left at its default ``propagate=True`` (see
    ``_configure_logging``'s own docstring for the reasoning — 19
    caplog-based assertions elsewhere in this suite depend on records
    reaching the root logger). That is safe only because the DEPLOYED
    configuration installs exactly one handler anywhere in the chain, so
    propagation past "dmf_cms" currently lands on nothing.

    This pins the property that makes it safe: under the real, deployed
    logging setup, a single audit write reaches stdout exactly once — not
    zero (that is #425), and not twice (a future root handler — e.g. some
    later ``logging.basicConfig()`` — would silently duplicate every
    audit line via that same propagation path; this is the test that
    would catch it).
    """
    request_id = _drive_gated_write(running_console)
    matches, seen = _collect_audit_lines(running_console.stdout_lines, request_id)
    assert len(matches) == 1, (
        f"expected exactly one audit line for request_id={request_id}, got {len(matches)}:\n"
        + "".join(matches or seen)
    )
