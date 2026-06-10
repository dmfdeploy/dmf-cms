#!/usr/bin/env bash
# End-to-end release: bump version, sync, commit, tag, build (local only).
#
# Does NOT push the image. Per the 2026-05-19 ADR-0025 convergence, GHCR is
# the canonical public source and workstation→Zot pushes were removed. After
# this script finishes, publish to GHCR with scripts/publish-to-ghcr.sh, then
# mirror via playbook 630 and deploy via playbook 650.
#
# Usage:
#   scripts/release.sh patch      # 0.2.2 → 0.2.3
#   scripts/release.sh minor      # 0.2.2 → 0.3.0
#   scripts/release.sh major      # 0.2.2 → 1.0.0
#   scripts/release.sh 0.3.5      # explicit version
#
# What it does, in order:
#   1. Validate working tree is clean
#   2. Compute new version
#   3. Run sync-version.sh to update all version files
#   4. Commit "release: vX.Y.Z"
#   5. git tag vX.Y.Z
#   6. Build image locally via build-image.sh --no-push
#   7. Print next-step commands (does NOT auto-publish or deploy)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

usage() {
    cat <<EOF
Usage: $0 (patch|minor|major|X.Y.Z) [--no-deploy-hint]

  patch | minor | major   Bump the corresponding component
  X.Y.Z                   Set explicit version
  --no-deploy-hint        Suppress the next-step instructions at the end

Cannot run with uncommitted changes.

This script builds locally only. To publish + deploy, run
scripts/publish-to-ghcr.sh, then playbooks 630 + 650 (see the hint at the end).
EOF
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

BUMP="$1"
shift

SHOW_DEPLOY_HINT=1
for arg in "$@"; do
    case "$arg" in
        --no-deploy-hint)  SHOW_DEPLOY_HINT=0 ;;
        -h|--help)         usage ;;
        *)                 echo "Unknown arg: $arg" >&2; usage ;;
    esac
done

CURRENT="$(tr -d '[:space:]' < VERSION)"
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
if [[ ! "$CURRENT" =~ $SEMVER_RE ]]; then
    echo "ERROR: current VERSION='$CURRENT' is not valid semver" >&2
    exit 1
fi

# Compute new version
case "$BUMP" in
    patch|minor|major)
        IFS='.' read -r MAJ MIN PAT <<<"$CURRENT"
        case "$BUMP" in
            patch) PAT=$((PAT+1)) ;;
            minor) MIN=$((MIN+1)); PAT=0 ;;
            major) MAJ=$((MAJ+1)); MIN=0; PAT=0 ;;
        esac
        NEW="$MAJ.$MIN.$PAT"
        ;;
    *)
        if [[ ! "$BUMP" =~ $SEMVER_RE ]]; then
            echo "ERROR: '$BUMP' is not patch/minor/major or valid semver" >&2
            exit 1
        fi
        NEW="$BUMP"
        ;;
esac

echo "═══════════════════════════════════════════════════"
echo "  Release: $CURRENT → $NEW"
echo "═══════════════════════════════════════════════════"

# 1. Verify clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: working tree has uncommitted changes. Commit or stash first." >&2
    git status --short >&2
    exit 1
fi

# 2. Verify tag does not already exist
if git rev-parse "v$NEW" >/dev/null 2>&1; then
    echo "ERROR: git tag v$NEW already exists" >&2
    exit 1
fi

# 3. Sync versions
echo ""
echo "[1/4] Syncing version files..."
"$REPO_ROOT/scripts/sync-version.sh" "$NEW"

# 4. Commit
echo ""
echo "[2/4] Committing version bump..."
git add VERSION pyproject.toml frontend/package.json charts/dmf-cms/Chart.yaml charts/dmf-cms/values.yaml
git commit -m "release: v$NEW"

# 5. Tag
echo ""
echo "[3/4] Tagging v$NEW..."
git tag -a "v$NEW" -m "Release v$NEW"

# 6. Build (local only — no push; publish happens via scripts/publish-to-ghcr.sh)
echo ""
echo "[4/4] Building image locally..."
"$REPO_ROOT/scripts/build-image.sh" --no-push

if [[ $SHOW_DEPLOY_HINT -eq 1 ]]; then
    cat <<EOF

═══════════════════════════════════════════════════
  RELEASE v$NEW BUILT LOCALLY
═══════════════════════════════════════════════════

Next steps (per the ADR-0025 GHCR-canonical / Zot-mirror flow).
NOTE: substitute <env-name> with the current Hetzner test env id —
see STATUS.md in the umbrella repo.

  1. Push commit and tag:
       git push origin HEAD
       git push origin v$NEW

  2. Publish image to GHCR (canonical public source):
       cd ~/repos/dmfdeploy/dmf-cms
       # macOS Keychain (token never typed):
       security find-generic-password -s "ghcr.io" -a "<github-username>" -w \\
         | GHCR_USER="<github-username>" scripts/publish-to-ghcr.sh

  3. Mirror GHCR → cluster-internal Zot (playbook 630):
       cd ~/repos/dmfdeploy/dmf-env
       bin/run-playbook.sh <env-name> \\
         ../dmf-infra/k3s-lab-bootstrap/playbooks/630-zot-seed-platform.yml

  4. Helm-deploy (playbook 650 — HEAD-checks Zot, then helm upgrade):
       bin/run-playbook.sh <env-name> \\
         ../dmf-infra/k3s-lab-bootstrap/playbooks/650-dmf-cms.yml

  5. Verify rollout matches local VERSION:
       cd ~/repos/dmfdeploy/dmf-cms
       scripts/verify-cluster.sh

  6. Smoke test:
       curl -sk https://console.dmf.example.com/healthz

EOF
fi
