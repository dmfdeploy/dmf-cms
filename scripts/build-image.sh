#!/usr/bin/env bash
# Build the DMF Console image locally and tag it
# registry.dmf.example.com/dmf-cms:<VERSION>.
#
# This script does NOT push. Per the 2026-05-19 ADR-0025 convergence the
# canonical publish path is scripts/publish-to-ghcr.sh (image → GHCR), then
# playbook 630-zot-seed-platform.yml mirrors GHCR → cluster-internal Zot.
# Workstation→Zot pushes were removed in that convergence.
#
# Reads VERSION from the repo root — never accepts a tag override.
#
# Usage:
#   scripts/build-image.sh           # build (no push)
#   scripts/build-image.sh --no-push # synonym, kept for callers that still pass it
#   scripts/build-image.sh --check   # verify versions in sync, no build
#
# Refuses to run if:
#   - VERSION is not in semver MAJOR.MINOR.PATCH form
#   - sync-version.sh --check fails
#   - working tree has uncommitted changes (use --dirty to override for local test)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

REGISTRY="${DMF_CMS_REGISTRY:-registry.dmf.example.com}"
IMAGE_NAME="${DMF_CMS_IMAGE_NAME:-dmf-cms}"
DOCKERFILE="${DMF_CMS_DOCKERFILE:-Dockerfile}"

ALLOW_DIRTY=0
CHECK_ONLY=0

usage() {
    cat <<EOF
Usage: $0 [--no-push] [--dirty] [--check]

  --no-push    No-op, accepted for compatibility (this script never pushes)
  --dirty      Allow build with uncommitted changes (NOT for cluster deployment)
  --check      Verify version sync and git state, do not build

Environment:
  DMF_CMS_REGISTRY     default: registry.dmf.example.com (local tag prefix only;
                       publish-to-ghcr.sh re-tags this image for GHCR)
  DMF_CMS_IMAGE_NAME   default: dmf-cms
  DMF_CMS_DOCKERFILE   default: Dockerfile
EOF
    exit 1
}

for arg in "$@"; do
    case "$arg" in
        --no-push)  ;;  # accepted for compatibility; no-op
        --dirty)    ALLOW_DIRTY=1 ;;
        --check)    CHECK_ONLY=1 ;;
        -h|--help)  usage ;;
        *)          echo "Unknown arg: $arg" >&2; usage ;;
    esac
done

VERSION="$(tr -d '[:space:]' < VERSION)"
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$'

if [[ ! "$VERSION" =~ $SEMVER_RE ]]; then
    echo "ERROR: VERSION='$VERSION' is not valid semver" >&2
    exit 1
fi

IMAGE_TAG="$REGISTRY/$IMAGE_NAME:$VERSION"

echo "═══════════════════════════════════════════════════"
echo "  DMF Console Build"
echo "  Version:  $VERSION"
echo "  Image:    $IMAGE_TAG"
echo "═══════════════════════════════════════════════════"

# Check 1: versions in sync
echo ""
echo "[1/3] Verifying version sync..."
"$REPO_ROOT/scripts/sync-version.sh" --check

# Check 2: git state
echo ""
echo "[2/3] Verifying git state..."
if [[ -n "$(git status --porcelain)" ]]; then
    if [[ $ALLOW_DIRTY -eq 0 ]]; then
        echo "ERROR: working tree is dirty. Commit or stash changes, or pass --dirty." >&2
        git status --short >&2
        exit 1
    fi
    echo "  ⚠ working tree dirty (--dirty allowed)"
else
    echo "  ✓ working tree clean"
fi

# Embed git SHA in image label for traceability
GIT_SHA="$(git rev-parse --short HEAD)"
GIT_TAG_EXACT="$(git describe --tags --exact-match 2>/dev/null || echo "")"
if [[ "$GIT_TAG_EXACT" != "v$VERSION" && "$GIT_TAG_EXACT" != "$VERSION" ]]; then
    echo "  ⚠ HEAD is not tagged as v$VERSION or $VERSION (got: '${GIT_TAG_EXACT:-none}')"
    echo "    For released images, run: git tag -a v$VERSION -m \"v$VERSION\" && git push --tags"
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
    echo ""
    echo "✓ All checks passed. Run without --check to build."
    exit 0
fi

# Build
echo ""
echo "[3/3] Building image..."
docker build \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.revision=$GIT_SHA" \
    --label "org.opencontainers.image.source=https://github.com/dmfdeploy/dmf-cms" \
    -t "$IMAGE_TAG" \
    -f "$DOCKERFILE" \
    .

echo "  ✓ built $IMAGE_TAG"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  BUILD COMPLETE: $IMAGE_TAG"
echo "═══════════════════════════════════════════════════"
echo ""
echo "The image is local only. To publish + deploy (ADR-0025 GHCR-canonical flow)."
echo "Substitute <env-name> with the current Hetzner test env id — see STATUS.md."
echo "  1. Publish to GHCR:"
echo "       cd ~/repos/dmfdeploy/dmf-cms"
echo "       security find-generic-password -s 'ghcr.io' -a '<github-username>' -w \\"
echo "         | GHCR_USER='<github-username>' scripts/publish-to-ghcr.sh"
echo "  2. Mirror GHCR → Zot (playbook 630):"
echo "       cd ~/repos/dmfdeploy/dmf-env"
echo "       bin/run-playbook.sh <env-name> \\"
echo "         ../dmf-infra/k3s-lab-bootstrap/playbooks/630-zot-seed-platform.yml"
echo "  3. Helm-deploy (playbook 650):"
echo "       bin/run-playbook.sh <env-name> \\"
echo "         ../dmf-infra/k3s-lab-bootstrap/playbooks/650-dmf-cms.yml"
echo "  4. Verify:"
echo "       cd ~/repos/dmfdeploy/dmf-cms && scripts/verify-cluster.sh"
