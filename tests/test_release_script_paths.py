"""Release-script hint-path contracts (dmfdeploy#338).

`bash -n` cannot catch either half of #338: a syntactically valid script can
expand an unset variable under `set -u`, and can compose a path that parses
fine and exists nowhere. Both shipped.

These tests SOURCE AND RUN the real `scripts/lib/hint-paths.sh` that both
release scripts consume. An earlier version of this file re-implemented the
snippet inside the test and asserted on its own copy — it passed while the real
assignments were broken, which is the exact failure mode it existed to prevent.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LIB = REPO_ROOT / "scripts" / "lib" / "hint-paths.sh"
SCRIPTS = [REPO_ROOT / "scripts" / n for n in ("build-image.sh", "release.sh")]


def _source_and_run(snippet: str) -> subprocess.CompletedProcess:
    """Run the REAL lib under nounset with the umbrella variable scrubbed."""
    return subprocess.run(
        ["bash", "-c",
         "set -euo pipefail\nunset DMFDEPLOY_UMBRELLA\n"
         f'source "{LIB}"\n{snippet}'],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )


def test_hint_paths_survive_an_unset_umbrella_under_nounset() -> None:
    """The hint must never decide the exit status.

    Both scripts print their next-steps block AFTER the real work — release.sh
    after sync, commit, tag and build — so aborting here left a partially
    completed release reporting failure.
    """
    r = _source_and_run(f'dmf_hint_paths "{REPO_ROOT}"; echo "$CMS_HINT"; echo "$ENV_HINT"')
    assert r.returncode == 0, f"hint resolution aborted under nounset: {r.stderr}"
    cms, env = r.stdout.strip().splitlines()
    assert cms, "CMS_HINT empty"
    assert env, "ENV_HINT empty"


def test_cms_hint_points_at_a_directory_that_holds_the_publish_script() -> None:
    """The printed `cd` target must be somewhere a human can actually cd to.

    The rejected first fix resolved the umbrella correctly and then appended
    /dmf-cms to it — a path that exists in no layout.
    """
    r = _source_and_run(f'dmf_hint_paths "{REPO_ROOT}"; printf %s "$CMS_HINT"')
    assert r.returncode == 0, r.stderr
    # CMS_HINT is shell-quoted for copy-paste; unwrap for the filesystem check.
    unwrapped = subprocess.run(
        ["bash", "-c", f'printf %s {r.stdout}'], capture_output=True, text=True
    ).stdout
    assert (Path(unwrapped) / "scripts" / "publish-to-ghcr.sh").is_file(), (
        f"CMS_HINT {unwrapped!r} does not contain scripts/publish-to-ghcr.sh"
    )


def test_both_emitted_hints_cd_successfully_from_a_path_containing_spaces(tmp_path) -> None:
    """Both hints must be runnable, not merely quote-shaped.

    Builds a real layout under a parent whose name contains spaces, with
    sibling `dmf-cms` and `dmf-env/bin/run-playbook.sh`, then executes an actual
    `cd` with each emitted token and compares `pwd`.

    The previous version of this test never created the dmf-env marker, so
    ENV_HINT took the placeholder branch and only CMS_HINT was ever inspected —
    removing `printf %q` from the real ENV_HINT assignment left it green. It
    also accepted any output containing a backslash or starting with a quote,
    which is a heuristic about shape rather than proof that the token parses.
    """
    workspace = tmp_path / "work space with spaces"
    cms = workspace / "dmf-cms"
    (cms / "scripts").mkdir(parents=True)
    env_bin = workspace / "dmf-env" / "bin"
    env_bin.mkdir(parents=True)
    (env_bin / "run-playbook.sh").write_text("#!/usr/bin/env bash\n")

    for var, expected in (("CMS_HINT", cms), ("ENV_HINT", workspace / "dmf-env")):
        r = subprocess.run(
            ["bash", "-c",
             "set -euo pipefail\nunset DMFDEPLOY_UMBRELLA\n"
             f'source "{LIB}"\n'
             f'dmf_hint_paths "{cms}"\n'
             f'eval "cd ${var}"\n'
             "pwd"],
            capture_output=True, text=True,
        )
        assert r.returncode == 0, f"cd with {var} failed: {r.stderr}"
        assert Path(r.stdout.strip()).resolve() == expected.resolve(), (
            f"{var} cd landed in {r.stdout.strip()!r}, expected {expected}"
        )


def test_no_script_derives_a_component_path_from_the_umbrella() -> None:
    """Components sit beside each other, not under the umbrella repo."""
    offenders = [
        f"{s.name}: {suffix}"
        for s in SCRIPTS
        for suffix in ("DMFDEPLOY_UMBRELLA/dmf-cms", "DMFDEPLOY_UMBRELLA/dmf-env")
        if suffix in s.read_text()
    ]
    assert not offenders, "component paths derived from the umbrella: " + "; ".join(offenders)


def test_both_scripts_consume_the_shared_resolver() -> None:
    """One implementation. A second copy is how the previous test blinded itself."""
    for s in SCRIPTS:
        body = s.read_text()
        assert "hint-paths.sh" in body and "dmf_hint_paths" in body, (
            f"{s.name} does not source the shared hint resolver"
        )
