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
#   DMF_CMS_IMAGE_ARCH    Architecture every checked pod's node must report
#                         (default: arm64 — every DMF env today is Hetzner
#                         CAX21 or the aliyun sandbox lane, both arm64).
#                         The script reads each pod's node platform from
#                         the cluster and fails when a node's architecture
#                         differs from this value.
#
# What this script checks, in order:
#   1. The deployment spec's image *tag* matches local VERSION (necessary,
#      not sufficient — this is the tag the cluster was told to run, not
#      proof of what's actually running).
#   2. The rollout has completed.
#   3. For every pod the deployment's selector returns (except finished
#      pods, phase Succeeded or Failed), the dmf-cms container is currently
#      running and its *resolved* image digest
#      (.status.containerStatuses[].imageID — what was actually pulled,
#      not the requested tag) matches the published GHCR digest for that
#      tag. If the tag is an index, the pod's digest must equal the index
#      digest (the sha256 of the raw bytes `skopeo inspect --raw` returns)
#      or the digest of the one index manifest for the pod's node
#      (.status.nodeInfo operatingSystem and architecture). If the tag is
#      a single-platform manifest, the pod's digest must equal that
#      manifest's digest and the image config's os and architecture must
#      equal the node's. Every pod's node architecture must also equal
#      DMF_CMS_IMAGE_ARCH. A tag match only says the right string was
#      requested; this check does not.
#   4. /healthz returns 200.
#
# Assumption: the container runtime selects the index manifest for the
# node's own platform (the default). A runtime configured to pull another
# platform is out of scope.

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
IMAGE_ARCH="${DMF_CMS_IMAGE_ARCH:-arm64}"

# --- Placeholder guard -------------------------------------------------------
# The defaults above are PLACEHOLDERS, not a usable environment. Left unset, the
# script used to run to completion against dmf.example.com and report "✗ DRIFT",
# which is indistinguishable from a genuinely failed deploy — a real session was
# spent chasing a rollout that had in fact succeeded.
#
# The trap is sharpened by the hosts not following the obvious pattern: a live
# env's registry and console carry NO `dmf.` prefix even though its cluster
# domain does, so the natural guess is wrong in a way that also reports DRIFT.
#
# Fail closed instead: refuse to produce a verdict we cannot stand behind.
_placeholders=()
case "$REGISTRY"     in *dmf.example.com*) _placeholders+=("DMF_CMS_REGISTRY=$REGISTRY") ;; esac
case "$CONTROL_NODE" in *dmf.example.com*) _placeholders+=("DMF_CMS_CONTROL_NODE=$CONTROL_NODE") ;; esac
case "$HEALTHZ_URL"  in *dmf.example.com*) _placeholders+=("DMF_CMS_HEALTHZ_URL=$HEALTHZ_URL") ;; esac

if (( ${#_placeholders[@]} > 0 )); then
  {
    echo "REFUSING TO VERIFY: still using placeholder values, which cannot describe a real env."
    echo
    for _p in "${_placeholders[@]}"; do echo "  $_p"; done
    echo
    echo "Set them for the env you are verifying. Note the hosts do NOT take a 'dmf.'"
    echo "prefix even though the cluster domain does — guessing one produces a false DRIFT:"
    echo
    echo "  DMF_CMS_REGISTRY='registry.<env-domain>' \\"
    echo "  DMF_CMS_CONTROL_NODE='root@<control-node-ip>' \\"
    echo "  DMF_CMS_SSH_KEY=\"\$HOME/.dmfdeploy/<env-key>.pem\" \\"
    echo "  DMF_CMS_HEALTHZ_URL='https://console.<env-domain>/healthz' \\"
    echo "    scripts/verify-cluster.sh"
    echo
    echo "The current env id is in the umbrella's generated STATUS.local.md"
    echo "(run bin/generate-status.sh)."
  } >&2
  exit 2
fi
# -----------------------------------------------------------------------------

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
echo "GHCR image:       ${GHCR_IMAGE}:${VERSION} ($IMAGE_ARCH)"
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
    echo "  Check that the release workflow published this version, then run playbook 630 → playbook 650."
    echo "  See dmf-cms/docs/DEVELOPMENT-AND-BUILD-RULES.md §4."
    exit 1
fi

echo "✓ image matches (tag)"

# Pod readiness
ssh "${SSH_KEY_OPTS[@]+"${SSH_KEY_OPTS[@]}"}" -o ConnectTimeout=10 "$CONTROL_NODE" \
    "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n $NAMESPACE rollout status deploy/$DEPLOYMENT --timeout=30s"

# Digest check — the tag match above only proves the right string was
# requested. This compares each pod's *resolved* imageID with the digest
# published to GHCR for this tag, and the node's platform with the
# published manifest. A tag match is not acceptance on its own.
echo ""
echo "Digest check..."

# Fetch the whole deployment as -o json (unambiguous, real JSON — no
# jsonpath/go-template dialect question for a nested object at all) and
# extract spec.selector locally with python3, rather than trying to
# iterate the matchLabels map inside a remote jsonpath expression itself.
# An earlier version of this fetch used `-o jsonpath='{.spec.selector}'`,
# which also does emit real JSON for an object result (kubectl's jsonpath
# printer json.Marshals non-scalar results; it's `-o go-template=` that
# stringifies maps as Go's `map[k:v]` — a different templating engine,
# easy to conflate but not what jsonpath does) — but -o json sidesteps
# that question entirely instead of resting correctness on which
# dialect's behavior is being assumed.
DEPLOY_JSON="$(
    ssh "${SSH_KEY_OPTS[@]+"${SSH_KEY_OPTS[@]}"}" -o ConnectTimeout=10 "$CONTROL_NODE" \
        "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n $NAMESPACE get deploy $DEPLOYMENT -o json"
)"

# Extracting spec.selector locally (rather than in the remote jsonpath/
# kubectl call) also lets us fail loud on matchExpressions, which a
# matchLabels-only selector string would otherwise silently ignore.
POD_SELECTOR="$(
    python3 -c '
import json, sys

deploy = json.loads(sys.argv[1])
selector = deploy.get("spec", {}).get("selector") or {}
if selector.get("matchExpressions"):
    sys.stderr.write(
        "deployment selector uses matchExpressions, which this script "
        "does not translate into a label selector\n"
    )
    sys.exit(1)
labels = selector.get("matchLabels") or {}
if not labels:
    sys.stderr.write("deployment spec.selector.matchLabels is empty\n")
    sys.exit(1)
print(",".join(f"{k}={v}" for k, v in sorted(labels.items())))
' "$DEPLOY_JSON"
)" || {
    echo "✗ could not build a pod selector from deployment $DEPLOYMENT's spec.selector" >&2
    exit 1
}

# The dmf-cms container's name in charts/dmf-cms/templates/deployment.yaml.
CONTAINER_NAME="dmf-cms"

PODS_JSON="$(
    ssh "${SSH_KEY_OPTS[@]+"${SSH_KEY_OPTS[@]}"}" -o ConnectTimeout=10 "$CONTROL_NODE" \
        "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n $NAMESPACE get pods -l '$POD_SELECTOR' -o json"
)"
NODES_JSON="$(
    ssh "${SSH_KEY_OPTS[@]+"${SSH_KEY_OPTS[@]}"}" -o ConnectTimeout=10 "$CONTROL_NODE" \
        "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml get nodes -o json"
)"

if ! command -v skopeo >/dev/null 2>&1; then
    echo "✗ skopeo not found — required for the digest check (brew install skopeo)" >&2
    exit 1
fi

# Keep the raw bytes in a file: the index digest is the sha256 of exactly
# what the registry served, and `$(...)` would strip trailing newlines.
GHCR_MANIFEST_FILE="$(mktemp)"
trap 'rm -f "$GHCR_MANIFEST_FILE"' EXIT

skopeo inspect --raw "docker://${GHCR_IMAGE}:${VERSION}" > "$GHCR_MANIFEST_FILE" || {
    echo "✗ could not read the published manifest for ${GHCR_IMAGE}:${VERSION} (network / registry issue?)" >&2
    exit 1
}

# One step checks every pod. The published manifest is either an index (a
# "manifests" array) or a single-platform manifest. For each pod that has
# not finished (phase other than Succeeded or Failed):
#   - the dmf-cms container must be currently running, and its imageID
#     digest is the one compared;
#   - its node's architecture must equal DMF_CMS_IMAGE_ARCH;
#   - index: the index must list exactly one manifest for the node's os and
#     architecture, and the pod's digest must equal the index digest (the
#     sha256 of the raw bytes) or that manifest's digest;
#   - single manifest: the pod's digest must equal the manifest's digest,
#     and the image config's os and architecture (`skopeo inspect` of
#     that digest) must equal the node's.
# Any parse error or failed pod exits 1.
python3 -c '
import hashlib, json, subprocess, sys

pods_json, nodes_json, manifest_file, container, want_arch, image_ref, image_repo = sys.argv[1:8]


def err(msg):
    print("✗ " + msg, file=sys.stderr)


try:
    pods = json.loads(pods_json)["items"]
    nodes = {
        n["metadata"]["name"]: n["status"]["nodeInfo"]
        for n in json.loads(nodes_json)["items"]
    }
    raw = open(manifest_file, "rb").read()
    manifest = json.loads(raw)
    index_digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    children = manifest.get("manifests")
except (ValueError, KeyError, TypeError, OSError) as e:
    err("could not parse the pods, nodes or published manifest: %r" % e)
    sys.exit(1)

kind = "index" if children is not None else "single"
print("GHCR %s digest: %s" % (kind, index_digest))


def single_platform():
    p = subprocess.run(["skopeo", "inspect", "docker://%s@%s" % (image_repo, index_digest)],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise ValueError("skopeo inspect failed for %s@%s" % (image_repo, index_digest))
    info = json.loads(p.stdout)
    return info["Os"], info["Architecture"]


failed = False
checked = 0
for pod in pods:
    name = pod["metadata"]["name"]
    if pod.get("status", {}).get("phase") in ("Succeeded", "Failed"):
        continue
    checked += 1
    try:
        node = pod["spec"]["nodeName"]
        info = nodes[node]
        node_os, node_arch = info["operatingSystem"], info["architecture"]
        print("Pod:               %s on %s (%s/%s)" % (name, node, node_os, node_arch))
        status = [c for c in pod["status"]["containerStatuses"] if c["name"] == container]
        if not status:
            raise ValueError("no status for container " + container)
        if not isinstance(status[0].get("state", {}).get("running"), dict):
            err("pod %s: container %s is not running (state: %s)"
                % (name, container, ",".join(k for k, v in status[0].get("state", {}).items() if v is not None) or "unknown"))
            failed = True
            continue
        image_id = status[0]["imageID"]
        digest = image_id.rsplit("@", 1)[-1]
        print("Pod imageID:       " + image_id)
        if node_arch != want_arch:
            err("node %s runs %s but DMF_CMS_IMAGE_ARCH is %s" % (node, node_arch, want_arch))
            failed = True
            continue
        if kind == "index":
            kids = [
                m["digest"] for m in children
                if m.get("platform", {}).get("os") == node_os
                and m.get("platform", {}).get("architecture") == node_arch
            ]
            if len(kids) != 1:
                err("the published index %s lists %d %s/%s manifests, expected 1"
                    % (image_ref, len(kids), node_os, node_arch))
                failed = True
                continue
            print("GHCR %s/%s digest: %s" % (node_os, node_arch, kids[0]))
            accepted = (index_digest, kids[0])
        else:
            published = single_platform()
            if published != (node_os, node_arch):
                err("the published manifest %s is %s/%s, not %s/%s"
                    % ((image_ref,) + published + (node_os, node_arch)))
                failed = True
                continue
            accepted = (index_digest,)
    except (ValueError, KeyError, TypeError) as e:
        err("pod %s: could not read its status or platform: %r" % (name, e))
        failed = True
        continue
    if digest in accepted:
        print("✓ digest matches (pod %s)" % name)
    else:
        err("DIGEST MISMATCH: pod %s is not running the image published to GHCR." % name)
        print("  Pod imageID:      " + image_id, file=sys.stderr)
        print("  Expected (GHCR):  %s = %s" % (image_ref, " or ".join(accepted)), file=sys.stderr)
        print("  A tag match is not proof — re-run the release flow and re-verify.", file=sys.stderr)
        print("  See dmf-cms/docs/DEVELOPMENT-AND-BUILD-RULES.md §4 and §7.", file=sys.stderr)
        failed = True

if checked == 0:
    err("no pod matches the deployment selector")
    sys.exit(1)
sys.exit(1 if failed else 0)
' "$PODS_JSON" "$NODES_JSON" "$GHCR_MANIFEST_FILE" "$CONTAINER_NAME" "$IMAGE_ARCH" "${GHCR_IMAGE}:${VERSION}" "$GHCR_IMAGE"

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
