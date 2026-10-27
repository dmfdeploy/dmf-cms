#!/usr/bin/env bash
# Prepare a release bump: sync VERSION, commit, and build locally.
#
# Does NOT push the image. Per the 2026-05-19 ADR-0025 convergence, GHCR is
# the canonical public source and workstation→Zot pushes were removed. After
# publication is handled by the exact-SHA GitHub Actions release workflow after
# the bump PR merges and its required checks pass.
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
#   4. Commit "chore(release): vX.Y.Z" (conventional + DCO sign-off)
#   5. Build image locally via build-image.sh --no-push
#   6. Print the PR and post-merge release-dispatch steps

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Next-steps hint paths — see scripts/lib/hint-paths.sh for the contract and
# for why this is shared rather than inlined in each script (dmfdeploy#338).
# shellcheck source=scripts/lib/hint-paths.sh
source "$REPO_ROOT/scripts/lib/hint-paths.sh"
dmf_hint_paths "$REPO_ROOT"
cd "$REPO_ROOT"

usage() {
    cat <<EOF
Usage: $0 (patch|minor|major|X.Y.Z) [--no-deploy-hint]

  patch | minor | major   Bump the corresponding component
  X.Y.Z                   Set explicit version
  --no-deploy-hint        Suppress the next-step instructions at the end

Cannot run with uncommitted changes.

This script prepares a release bump and builds locally. The verified release
workflow tags and publishes after the PR merges and all required checks pass.
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
        --tag)             echo "ERROR: tags are created only by the verified release workflow." >&2; exit 1 ;;
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
git add VERSION pyproject.toml frontend/package.json frontend/package-lock.json charts/dmf-cms/Chart.yaml charts/dmf-cms/values.yaml
git commit -s -m "chore(release): v$NEW"

# 3. Defer the release tag until all required checks pass on the merged SHA.
echo ""
echo "[3/4] Tagging deferred to the verified release workflow."

# 6. Build (local only — publication happens only in the verified workflow)
echo ""
echo "[4/4] Building image locally..."
"$REPO_ROOT/scripts/build-image.sh" --no-push --no-hint

if [[ $SHOW_DEPLOY_HINT -eq 1 ]]; then
    # The delimiter is unquoted on purpose: $NEW, $CMS_HINT and $ENV_HINT must
    # expand. That also makes every backtick and $(...) below live, so escape
    # any backtick used as markdown formatting (\`like this\`). See #538.
    cat <<EOF

═══════════════════════════════════════════════════
  RELEASE v$NEW BUILT LOCALLY
═══════════════════════════════════════════════════

Next steps. The release workflow handles the tag and GHCR publication.
NOTE: substitute <env-name> with the current Hetzner test env id —
see STATUS.md in the umbrella repo.

  1. Open the release bump PR from this branch. Include a fully qualified
     umbrella issue reference in the PR body:
       git push -u origin release/$NEW
       gh pr create --title "chore(release): v$NEW" --body "Refs dmfdeploy/dmfdeploy#<N>"

  2. After merge, start the exact-SHA release gate with its PR number:
       gh api repos/dmfdeploy/dmf-cms/dispatches \\
         -f event_type=cms-release -f "client_payload[pr_number]=<PR-NUMBER>"
     The workflow creates v$NEW and publishes only after all live required
     checks pass on the merged commit. The publication wrapper refuses local
     and other-workflow invocations.

  3. Mirror GHCR → cluster-internal Zot (playbook 630):
       cd $ENV_HINT
       bin/run-playbook.sh <env-name> \\
         ../dmf-infra/k3s-lab-bootstrap/playbooks/630-zot-seed-platform.yml

  4. Helm-deploy (playbook 650 — HEAD-checks Zot, then helm upgrade):
       bin/run-playbook.sh <env-name> \\
         ../dmf-infra/k3s-lab-bootstrap/playbooks/650-dmf-cms.yml

  5. Verify rollout matches local VERSION:
       cd $CMS_HINT
       scripts/verify-cluster.sh

  6. Smoke test:
       curl -sk https://console.dmf.example.com/healthz

EOF
fi
