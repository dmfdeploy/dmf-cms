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
# Env knobs (override defaults as needed):
#   DMF_CMS_REGISTRY      Image registry host portion of the expected image
#                         (default: registry.dmf.example.com — placeholder)
#   DMF_CMS_IMAGE_NAME    Image repo name (default: dmf-cms)
#   DMF_CMS_CONTROL_NODE  SSH target for the control node
#                         (default: k3s-admin@control.dmf.example.com — placeholder)
#   DMF_CMS_NAMESPACE     k8s namespace (default: dmf-cms)
#   DMF_CMS_DEPLOYMENT    deployment name (default: dmf-cms)
#   DMF_CMS_HEALTHZ_URL   healthz URL (default: console.dmf.example.com — placeholder)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

REGISTRY="${DMF_CMS_REGISTRY:-registry.dmf.example.com}"
IMAGE_NAME="${DMF_CMS_IMAGE_NAME:-dmf-cms}"
CONTROL_NODE="${DMF_CMS_CONTROL_NODE:-k3s-admin@control.dmf.example.com}"
NAMESPACE="${DMF_CMS_NAMESPACE:-dmf-cms}"
DEPLOYMENT="${DMF_CMS_DEPLOYMENT:-dmf-cms}"
HEALTHZ_URL="${DMF_CMS_HEALTHZ_URL:-https://console.dmf.example.com/healthz}"

VERSION="$(tr -d '[:space:]' < VERSION)"
EXPECTED="${REGISTRY}/${IMAGE_NAME}:${VERSION}"

echo "Local VERSION:    $VERSION"
echo "Expected image:   $EXPECTED"
echo "Control node:     $CONTROL_NODE"
echo "Healthz URL:      $HEALTHZ_URL"
echo ""

REMOTE_IMAGE="$(
    ssh -o ConnectTimeout=10 "$CONTROL_NODE" \
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

echo "✓ image matches"

# Pod readiness
ssh "$CONTROL_NODE" \
    "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n $NAMESPACE rollout status deploy/$DEPLOYMENT --timeout=30s"

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
