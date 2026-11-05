#!/usr/bin/env bash
# publish-to-ghcr.sh — push one platform's dmf-cms staging image to GHCR.
#
# Only the release workflow (.github/workflows/release.yml) runs this script.
# It refuses to run anywhere else, so a workstation cannot push an image that
# skipped the exact-SHA gate, the label check and the attestation. To test an
# image locally, run scripts/build-image.sh --no-push.
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
# Before any push it also requires a clean tree at the commit v<VERSION> names
# (or, until the workflow creates that tag, RELEASE_SHA) and an image whose
# revision label is that commit.
#
# Per the public container registry publishing plan §5.3: the IMAGE_TAG
# must match the repo's VERSION file. This wrapper asserts that
# precondition before invoking the umbrella push.
#
# Usage (inside the release workflow's publish step):
#
#   printf '%s\n' "$publisher_token" | scripts/publish-to-ghcr.sh
#
# The workflow pipes its job token on standard input and sets GHCR_USER and
# IMAGE_TAG_SUFFIX.
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

# Release-workflow guard -------------------------------------------------
#
# GitHub Actions sets GITHUB_ACTIONS and GITHUB_WORKFLOW on every runner. Keep
# RELEASE_WORKFLOW_NAME equal to the `name:` in .github/workflows/release.yml;
# a test checks that they match.
RELEASE_WORKFLOW_NAME="release"
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${GITHUB_WORKFLOW:-}" != "$RELEASE_WORKFLOW_NAME" ]]; then
  cat >&2 <<NOTWORKFLOW
ERROR: this script publishes only from the "${RELEASE_WORKFLOW_NAME}" workflow in GitHub Actions.

A push from anywhere else skips the exact-SHA gate, the label check and the
attestation. To publish a release, run the "${RELEASE_WORKFLOW_NAME}" workflow
(.github/workflows/release.yml). To test an image on your machine, run
scripts/build-image.sh --no-push, which pushes nothing.
NOTWORKFLOW
  exit 1
fi

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

# Revision check ----------------------------------------------------------
#
# A release PR is rebase-merged, so the commit the release tag names is not the
# commit the release branch built. An image built before the merge carries the
# old commit in its revision label while the registry tag names the new one.
# Compare full SHAs, push nothing on a mismatch, and fail closed when the label
# is missing or the image cannot be read.
#
# The expected commit is the one v<VERSION> names. The release workflow creates
# that tag only after both pushes, so there the commit it has already verified
# (RELEASE_SHA) stands in. With neither, nothing says which commit to trust.
# The release gate repeats the label comparison (release-gate.py check-labels)
# on both images before any push. This copy stays in the wrapper because the
# gate lives in another checkout that this script cannot assume.
LOCAL_IMAGE="${SOURCE_REGISTRY}/dmf-cms:${IMAGE_TAG}${IMAGE_TAG_SUFFIX}"
HEAD_COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}')"
RELEASE_SHA="${RELEASE_SHA:-}"
EXPECTED_COMMIT=""
EXPECTED_FROM=""
# show-ref exits 1 when the ref does not exist and 128 on an error such as a
# tag that points at a missing object. Only the first means the tag is absent.
TAG_STATE=0
git -C "$REPO_ROOT" show-ref --verify --quiet "refs/tags/v${IMAGE_TAG}" 2>/dev/null || TAG_STATE=$?
TAG_UNREADABLE=""
if [[ "$TAG_STATE" -eq 0 ]]; then
  EXPECTED_COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "v${IMAGE_TAG}^{commit}" || true)"
  EXPECTED_FROM="the commit v${IMAGE_TAG} names"
  [[ -n "$EXPECTED_COMMIT" ]] || TAG_UNREADABLE="tag v${IMAGE_TAG} exists but does not resolve to a commit."
elif [[ "$TAG_STATE" -ne 1 ]]; then
  TAG_UNREADABLE="git could not read tag v${IMAGE_TAG} (exit ${TAG_STATE})."
elif [[ -n "$RELEASE_SHA" ]]; then
  EXPECTED_COMMIT="$RELEASE_SHA"
  EXPECTED_FROM="the release workflow's verified commit"
fi
IMAGE_COMMIT="$(docker image inspect "$LOCAL_IMAGE" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"

revision_refusal() {
  cat >&2 <<REVISION
ERROR: $1

  image ${LOCAL_IMAGE}
    revision label: ${IMAGE_COMMIT:-<missing>}
  expected commit: ${EXPECTED_COMMIT:-<unknown>}
  checked-out commit: ${HEAD_COMMIT}

Nothing was pushed. To rebuild, check out the expected commit, then run:

  scripts/build-image.sh --no-push --platform linux/${IMAGE_TAG_SUFFIX#-} --tag-suffix ${IMAGE_TAG_SUFFIX}
REVISION
  exit 1
}

if [[ -n "$TAG_UNREADABLE" ]]; then
  revision_refusal "$TAG_UNREADABLE"
fi
if [[ -z "$EXPECTED_COMMIT" ]]; then
  revision_refusal "no commit to check against: tag v${IMAGE_TAG} is absent and RELEASE_SHA is not set."
fi
if [[ "$HEAD_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  revision_refusal "the working tree is not at ${EXPECTED_FROM}."
fi
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  revision_refusal "the working tree has uncommitted changes."
fi
if [[ -z "$IMAGE_COMMIT" ]]; then
  revision_refusal "the image has no org.opencontainers.image.revision label, or docker could not read it."
fi
if [[ "$IMAGE_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  revision_refusal "the image revision label differs from ${EXPECTED_FROM}."
fi

exec "${UMBRELLA_DIR}/bin/publish-image-to-ghcr.sh" \
  "${SOURCE_REGISTRY}/dmf-cms:${IMAGE_TAG}${IMAGE_TAG_SUFFIX}" \
  "ghcr.io/${GHCR_NAMESPACE}/dmf-cms:${IMAGE_TAG}${IMAGE_TAG_SUFFIX}"
