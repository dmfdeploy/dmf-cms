#!/usr/bin/env bash
# Shared next-steps hint paths for build-image.sh and release.sh (dmfdeploy#338).
#
# ONE implementation, sourced by both scripts AND by the test that pins it.
# The first attempt at this fix kept the logic inline in each script and pinned
# it with a Python test that re-implemented the same snippet — so the test
# passed while the real assignments were broken. A copy of the logic proves
# nothing about the logic.
#
# Contract: define CMS_HINT and ENV_HINT and NEVER fail. A RESOLVED path is
# shell-quoted so it stays runnable when the checkout contains spaces; the
# dmf-env fallback is deliberately an honest placeholder, not a runnable path. These feed a cosmetic hint printed after the real work; under
# `set -u` an unset variable here aborted an already-successful build and, in
# release.sh, a release that had already synced, committed, tagged and built.
#
# Layout: dmf-cms is $REPO_ROOT. dmf-env is its SIBLING — true in the canonical
# layout (ADR-0001, amended 2026-06-11) and in the tolerated nested one, since
# the components sit together either way. Only the canonical layout also makes
# them siblings of the umbrella, which is why no component path is derived from
# it. Requires REPO_ROOT to be set by the caller.

dmf_hint_paths() {
  local root="${1:?dmf_hint_paths: REPO_ROOT required}"
  CMS_HINT="$(printf '%q' "$root")"
  local env_dir="$root/../dmf-env"
  if [[ -f "$env_dir/bin/run-playbook.sh" ]]; then
    ENV_HINT="$(printf '%q' "$(cd "$env_dir" && pwd)")"
  else
    ENV_HINT='<path-to-dmf-env>'
  fi
}
