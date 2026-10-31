#!/usr/bin/env bash
# publish-to-ghcr.sh — push the locally-built dmf-cms image to GHCR.
#
# Thin wrapper around the umbrella's bin/publish-image-to-ghcr.sh. The
# umbrella script handles secrets (token via stdin, isolated DOCKER_CONFIG
# with cleanup trap, never argv).
#
# This script pushes per-platform staging tags only (<VERSION>-arm64,
# <VERSION>-amd64). It refuses to push the bare <VERSION> tag: version tags are
# immutable, and only the release workflow creates one, as a two-platform index
# (publish-index-to-ghcr.sh). A single-platform image at <VERSION> would block
# that index for good. Set IMAGE_TAG_SUFFIX to a platform suffix.
#
# Per the public container registry publishing plan §5.3: the IMAGE_TAG
# must match the repo's VERSION file. This wrapper asserts that
# precondition before invoking the umbrella push.
#
# Usage:
#
#   # From the gh CLI (token never typed, never in argv):
#   gh auth token | GHCR_USER="<github-username>" IMAGE_TAG_SUFFIX=-arm64 \
#     ~/repos/dmfdeploy/dmf-cms/scripts/publish-to-ghcr.sh
#
# The piped credential must be a token carrying write:packages
# ('gh auth refresh -s write:packages' if 'gh auth status' does not list it).
# An account password is not a substitute: GHCR rejects one with exactly the
# same 'denied: denied' as a bad token, so the failure looks like a scope
# problem and is not.
#
# Env knobs:
#   GHCR_USER         GitHub username (default: prompt)
#   GHCR_NAMESPACE    GHCR namespace (default: dmfdeploy)
#   IMAGE_TAG         Tag (default: read from ./VERSION)
#   IMAGE_TAG_SUFFIX  Appended to the source and destination tag, for a
#                     per-platform staging tag such as -arm64 (required).
#                     The release workflow joins the staging tags into one
#                     index under the version tag (publish-index-to-ghcr.sh).
#   SOURCE_REGISTRY   Local registry prefix
#                     (default: registry.dmf.example.com — matches
#                     scripts/build-image.sh's local tag convention)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Resolve the umbrella repo.
#
# The layout has been SIBLING-canonical since 2026-06-11 (ADR-0001, amended):
# dmf-cms and dmfdeploy sit side by side under a common parent. The old comment
# here ("scripts/ -> dmf-cms/ -> dmfdeploy/") described the RETIRED nested
# layout, and the `$REPO_ROOT/..` it produced resolves to the parent-of-all-repos
# in the current one -- a directory with no bin/, so the exec below died with a
# file-not-found on every release from a sibling checkout (dmfdeploy#338).
#
# Order: an explicit override, then sibling, then the nested fallback. Each
# candidate must actually carry the helper we are about to exec, so a wrong
# guess fails here with a clear message rather than at exec time.
resolve_umbrella_dir() {
  local candidate
  for candidate in "${DMFDEPLOY_UMBRELLA:-}" "$REPO_ROOT/../dmfdeploy" "$REPO_ROOT/.."; do
    [[ -n "$candidate" ]] || continue
    if [[ -f "$candidate/bin/publish-image-to-ghcr.sh" ]]; then
      (cd "$candidate" && pwd)
      return 0
    fi
  done
  return 1
}

if ! UMBRELLA_DIR="$(resolve_umbrella_dir)"; then
  cat >&2 <<'NOUMBRELLA'
ERROR: could not locate the dmfdeploy umbrella repo.

Looked for bin/publish-image-to-ghcr.sh under, in order:
  $DMFDEPLOY_UMBRELLA (if set), ../dmfdeploy (sibling layout), .. (nested layout)

Clone the umbrella beside this repo, or set DMFDEPLOY_UMBRELLA to its path.
NOUMBRELLA
  exit 1
fi

GHCR_NAMESPACE="${GHCR_NAMESPACE:-dmfdeploy}"
SOURCE_REGISTRY="${SOURCE_REGISTRY:-registry.dmf.example.com}"

# VERSION-vs-IMAGE_TAG match check ---------------------------------------

if [[ ! -f "$REPO_ROOT/VERSION" ]]; then
  echo "ERROR: $REPO_ROOT/VERSION not found." >&2
  exit 1
fi
REPO_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"
IMAGE_TAG="${IMAGE_TAG:-$REPO_VERSION}"

if [[ "$IMAGE_TAG" != "$REPO_VERSION" ]]; then
  cat >&2 <<MISMATCH
ERROR: IMAGE_TAG="$IMAGE_TAG" does not match VERSION file ($REPO_VERSION).

Per public registry plan §5.3 and ADR-0005 (VERSION is the source of
truth), the dmf-cms GHCR tag must equal the VERSION file. If you intend
to publish a non-canonical tag (e.g. a -dev or hotfix variant), bump
VERSION first, rebuild, and re-publish — do not skew the registry tag
from the source of truth.
MISMATCH
  exit 1
fi

# Delegate to umbrella ---------------------------------------------------

IMAGE_TAG_SUFFIX="${IMAGE_TAG_SUFFIX:-}"
if [[ -n "$IMAGE_TAG_SUFFIX" && ! "$IMAGE_TAG_SUFFIX" =~ ^-[a-z0-9]+$ ]]; then
  echo "ERROR: IMAGE_TAG_SUFFIX must be -<lowercase letters and digits>, for example -arm64." >&2
  exit 1
fi
if [[ -z "$IMAGE_TAG_SUFFIX" ]]; then
  cat >&2 <<NOSUFFIX
ERROR: refusing to push the version tag ${IMAGE_TAG} without IMAGE_TAG_SUFFIX.

Version tags are immutable, and the release must be a two-platform index.
Publishing one platform at ${IMAGE_TAG} would block that index for good. The
release workflow pushes ${IMAGE_TAG}-arm64 and ${IMAGE_TAG}-amd64, then joins
them into the index at ${IMAGE_TAG}. It is the only supported way to publish a
release image. If the workflow is disabled, wait until it is enabled.
NOSUFFIX
  exit 1
fi

exec "${UMBRELLA_DIR}/bin/publish-image-to-ghcr.sh" \
  "${SOURCE_REGISTRY}/dmf-cms:${IMAGE_TAG}${IMAGE_TAG_SUFFIX}" \
  "ghcr.io/${GHCR_NAMESPACE}/dmf-cms:${IMAGE_TAG}${IMAGE_TAG_SUFFIX}"
