"""release.sh's printed next-steps must be printed, never executed.

dmfdeploy/dmfdeploy#538: the hint block is an unquoted heredoc, and one line
wrapped a side-effecting command in markdown backticks. Bash read the backticks
as command substitution and ran `git checkout main && git pull` while printing
the sentence that warns against running it.

These tests run the REAL release.sh from a scratch git repo. The version-sync
and image-build steps are replaced by stubs, so nothing touches the network,
Docker or this checkout.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
}

STUB_SYNC = """#!/usr/bin/env bash
set -euo pipefail
echo "$1" > VERSION
for f in pyproject.toml frontend/package.json frontend/package-lock.json \\
         charts/dmf-cms/Chart.yaml charts/dmf-cms/values.yaml; do
  echo "$1" >> "$f"
done
"""

STUB_BUILD = "#!/usr/bin/env bash\nexit 0\n"


def _git(repo: Path, *args: str) -> str:
    r = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True,
        env={**os.environ, **GIT_ENV},
    )
    assert r.returncode == 0, f"git {' '.join(args)} failed: {r.stderr}"
    return r.stdout


def make_scratch_repo(tmp_path: Path) -> Path:
    """A repo shaped like dmf-cms, on a feature branch, with a local `main`."""
    repo = tmp_path / "dmf-cms"
    (repo / "scripts" / "lib").mkdir(parents=True)
    for rel in ("scripts/release.sh", "scripts/lib/hint-paths.sh"):
        shutil.copy2(REPO_ROOT / rel, repo / rel)
    (repo / "scripts" / "sync-version.sh").write_text(STUB_SYNC)
    (repo / "scripts" / "build-image.sh").write_text(STUB_BUILD)
    for rel in ("scripts/sync-version.sh", "scripts/build-image.sh"):
        (repo / rel).chmod(0o755)
    for rel in ("pyproject.toml", "frontend/package.json",
                "frontend/package-lock.json", "charts/dmf-cms/Chart.yaml",
                "charts/dmf-cms/values.yaml"):
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text("0.1.0\n")
    (repo / "VERSION").write_text("0.1.0\n")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "initial")
    _git(repo, "checkout", "-q", "-b", "feature")
    return repo


def run_release(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(repo / "scripts" / "release.sh"), *args],
        cwd=repo, capture_output=True, text=True,
        env={**os.environ, **GIT_ENV},
    )


def test_hint_block_prints_the_git_commands_without_running_them(tmp_path) -> None:
    repo = make_scratch_repo(tmp_path)
    r = run_release(repo, "patch")
    assert r.returncode == 0, r.stderr

    # The branch is where the operator left it.
    assert _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "feature"
    # Nothing ran `git checkout` after the scratch repo was set up.
    assert "moving from feature to" not in _git(repo, "reflog", "show", "HEAD")
    # The working tree holds no side effects of the hint.
    assert _git(repo, "status", "--porcelain").strip() == ""
    # The warning reads whole, with the command printed literally.
    assert "`git checkout main && git pull`" in r.stdout
    # The deliberate interpolations still work.
    assert "RELEASE v0.1.1 BUILT LOCALLY" in r.stdout
    assert 'git tag -a v0.1.1 -m "Release v0.1.1" origin/main' in r.stdout
