"""The Authentik group seeding must never hold up process exit
(dmfdeploy/dmfdeploy#845). A worker-pool thread would keep the interpreter
alive until its blocking call returned, past the pod's termination grace.
"""

import subprocess
import sys
import textwrap
import time

BLOCK_SECONDS = 5

CHILD = textwrap.dedent(
    """
    import time
    from fastapi.testclient import TestClient
    import dmf_cms.main as main
    from dmf_cms.settings import Settings

    def slow_bootstrap(settings):
        time.sleep({block})

    main._bootstrap_console_groups = slow_bootstrap
    with TestClient(main.create_app(settings=Settings())) as client:
        assert client.get("/healthz").status_code == 200
    print("lifespan-done", flush=True)
    """
).format(block=BLOCK_SECONDS)


def test_process_exits_while_the_bootstrap_is_still_blocked():
    started = time.monotonic()
    result = subprocess.run(
        [sys.executable, "-c", CHILD], capture_output=True, text=True, timeout=30,
    )
    elapsed = time.monotonic() - started
    assert result.returncode == 0, result.stderr
    assert "lifespan-done" in result.stdout
    assert elapsed < BLOCK_SECONDS - 1.5


def test_the_bootstrap_runs_on_a_daemon_thread(monkeypatch):
    # The subprocess test above only shows exit time in this interpreter's
    # worker-pool behaviour; a daemon thread is the property that holds in any.
    import threading

    import dmf_cms.main as main
    from dmf_cms.settings import Settings

    release = threading.Event()
    monkeypatch.setattr(main, "_bootstrap_console_groups", lambda settings: release.wait(10))
    thread = main._start_console_group_bootstrap(Settings())
    try:
        assert thread.daemon
        assert thread.is_alive()
    finally:
        release.set()
        thread.join(2)
