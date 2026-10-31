#!/usr/bin/env bash
# publish-index-to-ghcr.sh — join the per-platform images into one index.
#
# The release workflow pushes each platform's image under a staging tag
# (<VERSION>-arm64, <VERSION>-amd64) through publish-to-ghcr.sh. This script
# then creates ghcr.io/<namespace>/dmf-cms:<VERSION> as an index of exactly
# those two images, named by digest. It copies no layers: the images are
# already in the registry.
#
# The GHCR token arrives on standard input as one line, never in argv. Docker
# logs in with an isolated DOCKER_CONFIG that a trap removes.
#
# It refuses to run when the version tag already exists, so a published index
# is never overwritten.
#
# Usage:
#   printf '%s\n' "$token" | GHCR_USER=<user> \
#     scripts/publish-index-to-ghcr.sh --arm64 sha256:<hex> --amd64 sha256:<hex>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GHCR_NAMESPACE="${GHCR_NAMESPACE:-dmfdeploy}"
DIGEST_RE='^sha256:[0-9a-f]{64}$'

ARM64="" AMD64=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arm64) ARM64="${2:-}"; shift 2 ;;
    --amd64) AMD64="${2:-}"; shift 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
for digest in "$ARM64" "$AMD64"; do
  if [[ ! "$digest" =~ $DIGEST_RE ]]; then
    echo "ERROR: --arm64 and --amd64 each need a sha256:<64 hex> digest." >&2
    exit 2
  fi
done
if [[ "$ARM64" == "$AMD64" ]]; then
  echo "ERROR: the two platform digests are identical." >&2
  exit 2
fi
if [[ -z "${GHCR_USER:-}" ]]; then
  echo "ERROR: GHCR_USER is required." >&2
  exit 1
fi

VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"
REPO="ghcr.io/${GHCR_NAMESPACE}/dmf-cms"

IFS= read -r GHCR_TOKEN
if [[ -z "${GHCR_TOKEN:-}" ]]; then
  echo "ERROR: GHCR token not provided on standard input." >&2
  exit 1
fi

DOCKER_CONFIG="$(mktemp -d)"
export DOCKER_CONFIG
trap 'rm -rf "${DOCKER_CONFIG}"' EXIT INT TERM

printf '%s' "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin
unset GHCR_TOKEN

# Proceed only on a definite "not found". Any other failure, such as a network
# error, could hide an existing tag, and creating over it would overwrite it.
if probe="$(docker buildx imagetools inspect "${REPO}:${VERSION}" 2>&1)"; then
  echo "ERROR: ${REPO}:${VERSION} already exists; refusing to overwrite it." >&2
  exit 1
fi
if [[ "${probe}" != *"not found"* ]]; then
  echo "ERROR: could not tell whether ${REPO}:${VERSION} exists: ${probe}" >&2
  exit 1
fi

docker buildx imagetools create -t "${REPO}:${VERSION}" \
  "${REPO}@${ARM64}" "${REPO}@${AMD64}"
echo "published index ${REPO}:${VERSION}"
