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


def test_build_check_does_not_advise_a_pre_merge_tag_push(tmp_path) -> None:
    """dmfdeploy/dmfdeploy#179: build-image.sh must not point at the retired flow.

    The untagged-HEAD warning used to advise `git tag ... && git push --tags`.
    main is protected and merges are rebase-only, so a tag cut before the merge
    points at a commit that never reaches main, and v* tags cannot be moved once
    pushed. The warning now names the supported order.
    """
    repo = make_scratch_repo(tmp_path)
    shutil.copy2(REPO_ROOT / "scripts" / "build-image.sh", repo / "scripts" / "build-image.sh")
    (repo / "scripts" / "sync-version.sh").write_text("#!/usr/bin/env bash\nexit 0\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "stubs")
    r = subprocess.run(
        ["bash", str(repo / "scripts" / "build-image.sh"), "--check"],
        cwd=repo, capture_output=True, text=True, env={**os.environ, **GIT_ENV},
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert "HEAD is not tagged" in r.stdout
    assert "push --tags" not in r.stdout
    assert "origin/main" in r.stdout


def test_hint_rebuilds_from_the_tagged_commit_before_publishing(tmp_path) -> None:
    """The image built before the rebase merge carries an orphan revision label.

    publish-to-ghcr.sh only re-tags the local image, so the hint must send the
    operator to build from the tagged commit first, and must print the label
    check literally.
    """
    repo = make_scratch_repo(tmp_path)
    r = run_release(repo, "patch")
    assert r.returncode == 0, r.stderr
    out = r.stdout
    detach = out.index("git switch --detach v0.1.1")
    build = out.index("scripts/build-image.sh --no-push", detach)
    label = out.index('"org.opencontainers.image.revision"', build)
    publish = out.index("scripts/publish-to-ghcr.sh", label)
    assert detach < build < label < publish
    assert "git rev-parse --short v0.1.1^{commit}" in out


def test_numbered_procedure_rebuilds_before_publishing() -> None:
    """The canonical numbered release procedure must rebuild from the tag first.

    Anchored on the commands, not the prose: in the fenced block under the
    "Release Procedure" heading, every line that runs publish-to-ghcr.sh needs an
    earlier build-image.sh line and an earlier `git rev-parse` line in that block.
    """
    doc = (REPO_ROOT / "docs" / "DEVELOPMENT-AND-BUILD-RULES.md").read_text()
    section = doc.split("## 4. The Release Procedure", 1)[1].split("\n## ", 1)[0]
    blocks = section.split("```")[1::2]
    publishing = [b.splitlines() for b in blocks if "publish-to-ghcr.sh" in b]
    assert publishing, "no fenced block in the release procedure runs publish-to-ghcr.sh"
    for lines in publishing:
        publish = next(i for i, ln in enumerate(lines) if "publish-to-ghcr.sh" in ln)
        before = "\n".join(lines[:publish])
        assert "scripts/build-image.sh" in before, "publish step has no earlier build-image.sh"
        assert "git rev-parse" in before, "publish step has no earlier git rev-parse label check"


PUBLISH_RECIPE_LINE = "1. Publish to GHCR:"


def _use_real_build_image(repo: Path) -> dict:
    """Swap in the real build-image.sh and a fake `docker` that always succeeds."""
    shutil.copy2(REPO_ROOT / "scripts" / "build-image.sh", repo / "scripts" / "build-image.sh")
    # --check passes; any other call bumps like the stub release.sh needs.
    (repo / "scripts" / "sync-version.sh").write_text(
        '#!/usr/bin/env bash\n[[ "${1:-}" == "--check" ]] && exit 0\n' + STUB_SYNC.split("\n", 1)[1]
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "real build script")
    bindir = repo.parent / "fakebin"
    bindir.mkdir()
    (bindir / "docker").write_text("#!/usr/bin/env bash\nexit 0\n")
    (bindir / "docker").chmod(0o755)
    return {**os.environ, **GIT_ENV, "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}"}


def test_release_path_prints_no_direct_publish_recipe(tmp_path) -> None:
    """The real build-image.sh runs before the release PR merges.

    Its own publish recipe would send the operator to publish the image that
    carries the pre-rebase commit, so release.sh must suppress it and print only
    its own post-merge steps.
    """
    repo = make_scratch_repo(tmp_path)
    env = _use_real_build_image(repo)
    r = subprocess.run(
        ["bash", str(repo / "scripts" / "release.sh"), "patch"],
        cwd=repo, capture_output=True, text=True, env=env,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert "BUILD COMPLETE" in r.stdout  # the real build-image.sh did run
    assert PUBLISH_RECIPE_LINE not in r.stdout
    assert "RELEASE v0.1.1 BUILT LOCALLY" in r.stdout


def test_plain_build_image_keeps_its_hint(tmp_path) -> None:
    repo = make_scratch_repo(tmp_path)
    env = _use_real_build_image(repo)

    def run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", str(repo / "scripts" / "build-image.sh"), *args],
            cwd=repo, capture_output=True, text=True, env=env,
        )

    plain = run("--no-push")
    assert plain.returncode == 0, plain.stdout + plain.stderr
    assert PUBLISH_RECIPE_LINE in plain.stdout
    assert "rebuilt from the release tag" in plain.stdout
    quiet = run("--no-push", "--no-hint")
    assert quiet.returncode == 0, quiet.stdout + quiet.stderr
    assert "BUILD COMPLETE" in quiet.stdout
    assert PUBLISH_RECIPE_LINE not in quiet.stdout
