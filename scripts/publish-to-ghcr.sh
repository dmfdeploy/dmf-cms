#!/usr/bin/env bash
# publish-to-ghcr.sh — push the locally-built dmf-cms image to GHCR.
#
# Thin wrapper around the umbrella's bin/publish-image-to-ghcr.sh. The
# umbrella script handles secrets (token via stdin, isolated DOCKER_CONFIG
# with cleanup trap, never argv).
#
# Per the public container registry publishing plan §5.3: the IMAGE_TAG
# must match the repo's VERSION file. This wrapper asserts that
# precondition before invoking the umbrella push.
#
# Usage:
#
#   # From macOS Keychain:
#   security find-generic-password -s "ghcr.io" -a "<github-username>" -w \
#     | GHCR_USER="<github-username>" \
#       ~/repos/dmfdeploy/dmf-cms/scripts/publish-to-ghcr.sh
#
#   # Interactive:
#   ~/repos/dmfdeploy/dmf-cms/scripts/publish-to-ghcr.sh
#
# Env knobs:
#   GHCR_USER         GitHub username (default: prompt)
#   GHCR_NAMESPACE    GHCR namespace (default: dmfdeploy)
#   IMAGE_TAG         Tag (default: read from ./VERSION)
#   SOURCE_REGISTRY   Local registry prefix
#                     (default: registry.dmf.example.com — matches
#                     scripts/build-image.sh's local tag convention)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# scripts/ → dmf-cms/ → dmfdeploy/
UMBRELLA_DIR="$(cd "$REPO_ROOT/.." && pwd)"

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

exec "${UMBRELLA_DIR}/bin/publish-image-to-ghcr.sh" \
  "${SOURCE_REGISTRY}/dmf-cms:${IMAGE_TAG}" \
  "ghcr.io/${GHCR_NAMESPACE}/dmf-cms:${IMAGE_TAG}"
