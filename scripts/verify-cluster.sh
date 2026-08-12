#!/usr/bin/env bash
# Verify the deployed image matches the local VERSION file.
# Run after deploying to confirm the rollout reached the cluster.
#
# The cluster identity is operator-supplied — env slugs (hetzner test envs)
# rotate as we cut new test clusters. The script defaults to placeholder
# values that match `dmf.example.com` per the public-prose convention; the
# operator points it at the live cluster via env vars.
#
# Usage:
#   # full form
#   DMF_CMS_REGISTRY=registry.<your-cluster-domain> \
#   DMF_CMS_CONTROL_NODE=k3s-admin@<your-control-node> \
#   DMF_CMS_HEALTHZ_URL=https://console.<your-cluster-domain>/healthz \
#     scripts/verify-cluster.sh
#
#   # sandbox-lane envs that pin a non-default SSH identity (e.g. root@ with
#   # a per-env key instead of the default agent identity)
#   DMF_CMS_CONTROL_NODE=root@<sandbox-control-node> \
#   DMF_CMS_SSH_KEY=~/.dmfdeploy/aliyun-keys/<env-key>.pem \
#     scripts/verify-cluster.sh
#
# Env knobs (override defaults as needed):
#   DMF_CMS_REGISTRY      Image registry host portion of the expected image
#                         (default: registry.dmf.example.com — placeholder;
#                         this is the cluster-internal Zot mirror, not GHCR)
#   DMF_CMS_IMAGE_NAME    Image repo name (default: dmf-cms)
#   DMF_CMS_CONTROL_NODE  SSH target for the control node
#                         (default: k3s-admin@control.dmf.example.com — placeholder)
#   DMF_CMS_SSH_KEY       Path to an SSH private key. When set, threaded into
#                         every ssh call as `-i "$DMF_CMS_SSH_KEY"
#                         -o IdentitiesOnly=yes` so a pinned per-env identity
#                         is used instead of whatever the agent offers first.
#                         Needed for sandbox-lane envs that authenticate with
#                         a key not loaded in the default agent (e.g. a
#                         non-default ansible_user + a pinned key file from
#                         that env's inventory group_vars). Unset (default):
#                         plain `ssh`, unchanged — the Hetzner lab env's
#                         default-agent-identity path keeps working as-is.
#   DMF_CMS_NAMESPACE     k8s namespace (default: dmf-cms)
#   DMF_CMS_DEPLOYMENT    deployment name (default: dmf-cms)
#   DMF_CMS_HEALTHZ_URL   healthz URL (default: console.dmf.example.com — placeholder)
#   DMF_CMS_GHCR_IMAGE    Canonical published image ref, no tag
#                         (default: ghcr.io/dmfdeploy/dmf-cms). Used only for
#                         the digest check below — deliberately independent of
#                         DMF_CMS_REGISTRY, which points at the cluster-local
#                         Zot mirror, not the GHCR source of truth.
#
# What this script checks, in order:
#   1. The deployment spec's image *tag* matches local VERSION (necessary,
#      not sufficient — this is the tag the cluster was told to run, not
#      proof of what's actually running).
#   2. The rollout has completed.
#   3. The running pod's *resolved* image digest
#      (.status.containerStatuses[0].imageID — what was actually pulled,
#      not the requested tag) matches the arm64 platform child digest of
#      the published GHCR index for that tag. This is the real proof: a
#      tag match only says the right string was requested.
#   4. /healthz returns 200.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

REGISTRY="${DMF_CMS_REGISTRY:-registry.dmf.example.com}"
IMAGE_NAME="${DMF_CMS_IMAGE_NAME:-dmf-cms}"
CONTROL_NODE="${DMF_CMS_CONTROL_NODE:-k3s-admin@control.dmf.example.com}"
NAMESPACE="${DMF_CMS_NAMESPACE:-dmf-cms}"
DEPLOYMENT="${DMF_CMS_DEPLOYMENT:-dmf-cms}"
HEALTHZ_URL="${DMF_CMS_HEALTHZ_URL:-https://console.dmf.example.com/healthz}"
GHCR_IMAGE="${DMF_CMS_GHCR_IMAGE:-ghcr.io/dmfdeploy/dmf-cms}"

# When DMF_CMS_SSH_KEY is set, pin that identity on every ssh call instead of
# trusting whatever the agent offers first. Empty array + `set -u` is a
# bash-3.2 trap (macOS ships 3.2, GPLv2-only): the bare form
# "${SSH_KEY_OPTS[@]}" raises "unbound variable" there on an
# explicitly-empty array, even though bash 4+ treats it as zero words.
# Every expansion below instead uses "${SSH_KEY_OPTS[@]+"${SSH_KEY_OPTS[@]}"}"
# — the 3.2-safe way to say "these words, or nothing if the array is
# empty" — do not simplify it to the bare form.
SSH_KEY_OPTS=()
if [[ -n "${DMF_CMS_SSH_KEY:-}" ]]; then
    SSH_KEY_OPTS=(-i "$DMF_CMS_SSH_KEY" -o IdentitiesOnly=yes)
fi

VERSION="$(tr -d '[:space:]' < VERSION)"
EXPECTED="${REGISTRY}/${IMAGE_NAME}:${VERSION}"

echo "Local VERSION:    $VERSION"
echo "Expected image:   $EXPECTED"
echo "Control node:     $CONTROL_NODE"
if [[ -n "${DMF_CMS_SSH_KEY:-}" ]]; then
    echo "SSH identity:     $DMF_CMS_SSH_KEY (IdentitiesOnly)"
else
    echo "SSH identity:     (default agent)"
fi
echo "GHCR image:       ${GHCR_IMAGE}:${VERSION}"
echo "Healthz URL:      $HEALTHZ_URL"
echo ""

REMOTE_IMAGE="$(
    ssh "${SSH_KEY_OPTS[@]+"${SSH_KEY_OPTS[@]}"}" -o ConnectTimeout=10 "$CONTROL_NODE" \
        "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n $NAMESPACE get deploy $DEPLOYMENT -o jsonpath='{.spec.template.spec.containers[0].image}'"
)"

echo "Cluster image:    $REMOTE_IMAGE"

if [[ "$REMOTE_IMAGE" != "$EXPECTED" ]]; then
    echo ""
    echo "✗ DRIFT: cluster is not running the local VERSION."
    echo "  Re-run the release flow: publish-to-ghcr.sh → playbook 630 → playbook 650."
    echo "  See dmf-cms/docs/DEVELOPMENT-AND-BUILD-RULES.md §4."
    exit 1
fi

echo "✓ image matches (tag)"

# Pod readiness
ssh "${SSH_KEY_OPTS[@]+"${SSH_KEY_OPTS[@]}"}" "$CONTROL_NODE" \
    "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n $NAMESPACE rollout status deploy/$DEPLOYMENT --timeout=30s"

# Digest check — the tag match above only proves the right string was
# requested. This proves the right bits are what's actually running: the
# pod's *resolved* imageID against the arm64 child digest of the exact
# index published to GHCR. A tag match is not acceptance on its own.
echo ""
echo "Digest check..."

POD_SELECTOR_RAW="$(
    ssh "${SSH_KEY_OPTS[@]+"${SSH_KEY_OPTS[@]}"}" -o ConnectTimeout=10 "$CONTROL_NODE" \
        "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n $NAMESPACE get deploy $DEPLOYMENT -o jsonpath='{range \$k,\$v := .spec.selector.matchLabels}{\$k}={\$v},{end}'"
)"
POD_SELECTOR="${POD_SELECTOR_RAW%,}"

if [[ -z "$POD_SELECTOR" ]]; then
    echo "✗ could not read pod selector from deployment $DEPLOYMENT" >&2
    exit 1
fi

POD_IMAGE_ID="$(
    ssh "${SSH_KEY_OPTS[@]+"${SSH_KEY_OPTS[@]}"}" -o ConnectTimeout=10 "$CONTROL_NODE" \
        "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n $NAMESPACE get pods -l '$POD_SELECTOR' -o jsonpath='{.items[0].status.containerStatuses[0].imageID}'"
)"

if [[ -z "$POD_IMAGE_ID" ]]; then
    echo "✗ could not read imageID from a running pod (selector: $POD_SELECTOR)" >&2
    exit 1
fi

# imageID is typically "<registry>/<repo>@sha256:<digest>"; keep only the
# digest. If there's no '@' this is a no-op and the raw value is compared
# as-is, which still fails loud below instead of silently passing.
POD_DIGEST="${POD_IMAGE_ID##*@}"

echo "Pod imageID:       $POD_IMAGE_ID"

if ! command -v skopeo >/dev/null 2>&1; then
    echo "✗ skopeo not found — required for the digest check (brew install skopeo)" >&2
    exit 1
fi

GHCR_MANIFEST_JSON="$(skopeo inspect --raw "docker://${GHCR_IMAGE}:${VERSION}")" || {
    echo "✗ could not read the published manifest for ${GHCR_IMAGE}:${VERSION} (network / registry issue?)" >&2
    exit 1
}

ARM64_DIGEST="$(
    python3 -c '
import json, sys

data = json.loads(sys.argv[1])
matches = [
    m["digest"] for m in data.get("manifests", [])
    if m.get("platform", {}).get("architecture") == "arm64"
]
if not matches:
    sys.exit(1)
print(matches[0])
' "$GHCR_MANIFEST_JSON"
)" || {
    echo "✗ no arm64 manifest found in the published index ${GHCR_IMAGE}:${VERSION}" >&2
    echo "  (expected a multi-arch OCI/Docker manifest list with an arm64 platform entry)" >&2
    exit 1
}

echo "GHCR arm64 digest: $ARM64_DIGEST"

if [[ "$POD_DIGEST" != "$ARM64_DIGEST" ]]; then
    echo ""
    echo "✗ DIGEST MISMATCH: the running pod is not the arm64 image published to GHCR."
    echo "  Pod imageID:      $POD_IMAGE_ID"
    echo "  Expected (GHCR):  ${GHCR_IMAGE}:${VERSION} (arm64) = $ARM64_DIGEST"
    echo "  A tag match is not proof — re-run the release flow and re-verify."
    echo "  See dmf-cms/docs/DEVELOPMENT-AND-BUILD-RULES.md §4 and §7."
    exit 1
fi

echo "✓ digest matches (running pod is the arm64 image published to GHCR)"

# Healthz
echo ""
echo "Healthz check..."
HTTP_STATUS="$(curl -sk -o /tmp/healthz.json -w '%{http_code}' "$HEALTHZ_URL")"
if [[ "$HTTP_STATUS" != "200" ]]; then
    echo "✗ healthz returned $HTTP_STATUS"
    cat /tmp/healthz.json
    exit 1
fi
echo "✓ healthz 200"
cat /tmp/healthz.json
echo ""

echo ""
echo "✓ verification passed: $EXPECTED is live"
