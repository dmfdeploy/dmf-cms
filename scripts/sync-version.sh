#!/usr/bin/env bash
# Propagate VERSION → pyproject.toml, frontend/package.json, charts/dmf-cms/Chart.yaml, charts/dmf-cms/values.yaml
#
# Usage:
#   scripts/sync-version.sh              # propagate current VERSION
#   scripts/sync-version.sh 0.3.0        # set new version, then propagate
#   scripts/sync-version.sh --check      # exit non-zero if anything is out of sync
#
# The VERSION file is the single source of truth. All other version fields are derived.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION_FILE="$REPO_ROOT/VERSION"
PYPROJECT="$REPO_ROOT/pyproject.toml"
PACKAGE_JSON="$REPO_ROOT/frontend/package.json"
CHART_YAML="$REPO_ROOT/charts/dmf-cms/Chart.yaml"
VALUES_YAML="$REPO_ROOT/charts/dmf-cms/values.yaml"

# Validate semver MAJOR.MINOR.PATCH (no leading 'v', no pre-release for now)
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$'

usage() {
    cat <<EOF
Usage: $0 [VERSION|--check]

  (no args)   Propagate current VERSION file to all derived files
  X.Y.Z       Set VERSION to X.Y.Z, then propagate
  --check     Verify all files match VERSION (exit 1 if not)

Files kept in sync:
  - VERSION                       (source of truth)
  - pyproject.toml                (project.version)
  - frontend/package.json         (.version)
  - charts/dmf-cms/Chart.yaml     (version + appVersion)
  - charts/dmf-cms/values.yaml    (image.tag)
EOF
    exit 1
}

read_current_version() {
    if [[ ! -f "$VERSION_FILE" ]]; then
        echo "ERROR: $VERSION_FILE not found" >&2
        exit 2
    fi
    tr -d '[:space:]' < "$VERSION_FILE"
}

write_version_file() {
    local v="$1"
    echo "$v" > "$VERSION_FILE"
}

# Read derived versions for --check.
# Use POSIX [[:space:]] — BSD sed/grep on macOS does not support \s.
get_pyproject_version() {
    grep -E '^version[[:space:]]*=' "$PYPROJECT" | head -1 \
        | sed -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/'
}

get_package_json_version() {
    # Use python3 to avoid jq dependency
    python3 -c "import json; print(json.load(open('$PACKAGE_JSON'))['version'])"
}

get_chart_version() {
    grep -E '^version:' "$CHART_YAML" | head -1 | awk '{print $2}' | tr -d '"'
}

get_chart_appversion() {
    grep -E '^appVersion:' "$CHART_YAML" | head -1 | awk '{print $2}' | tr -d '"'
}

get_values_image_tag() {
    # awk block: between 'image:' line and the next top-level key, find the indented tag:
    awk '
        /^image:/ { in_image = 1; next }
        in_image && /^[^[:space:]]/ { in_image = 0 }
        in_image && /^[[:space:]]+tag:/ {
            match($0, /"[^"]+"/)
            print substr($0, RSTART+1, RLENGTH-2)
            exit
        }
    ' "$VALUES_YAML"
}

propagate() {
    local v="$1"
    echo "Propagating version $v"

    # pyproject.toml — version = "X.Y.Z"
    sed -i.bak -E 's/^(version[[:space:]]*=[[:space:]]*")[^"]+(")/\1'"$v"'\2/' "$PYPROJECT"
    rm "$PYPROJECT.bak"
    echo "  ✓ pyproject.toml"

    # frontend/package.json — "version": "X.Y.Z"
    python3 - <<EOF
import json
with open("$PACKAGE_JSON") as f:
    data = json.load(f)
data["version"] = "$v"
with open("$PACKAGE_JSON", "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
EOF
    echo "  ✓ frontend/package.json"

    # charts/dmf-cms/Chart.yaml — version: X.Y.Z and appVersion: "X.Y.Z"
    sed -i.bak -E 's/^version:[[:space:]]*.*$/version: '"$v"'/' "$CHART_YAML"
    sed -i.bak -E 's/^appVersion:[[:space:]]*.*$/appVersion: "'"$v"'"/' "$CHART_YAML"
    rm "$CHART_YAML.bak"
    echo "  ✓ charts/dmf-cms/Chart.yaml"

    # charts/dmf-cms/values.yaml — tag: "X.Y.Z" (under image: block, indented two spaces)
    sed -i.bak -E 's/^([[:space:]]+tag:[[:space:]]*)"[^"]+"/\1"'"$v"'"/' "$VALUES_YAML"
    rm "$VALUES_YAML.bak"
    echo "  ✓ charts/dmf-cms/values.yaml"

    echo "Done. All files now at version $v."
}

check() {
    local v py pkg chart_v chart_av values_tag
    v="$(read_current_version)"
    py="$(get_pyproject_version)"
    pkg="$(get_package_json_version)"
    chart_v="$(get_chart_version)"
    chart_av="$(get_chart_appversion)"
    values_tag="$(get_values_image_tag)"

    local ok=1
    printf "%-40s %s\n" "VERSION" "$v"
    for entry in \
        "pyproject.toml=$py" \
        "frontend/package.json=$pkg" \
        "Chart.yaml(version)=$chart_v" \
        "Chart.yaml(appVersion)=$chart_av" \
        "values.yaml(image.tag)=$values_tag"; do
        local label="${entry%%=*}"
        local got="${entry#*=}"
        if [[ "$got" == "$v" ]]; then
            printf "  %-40s %s ✓\n" "$label" "$got"
        else
            printf "  %-40s %s ✗ (expected $v)\n" "$label" "$got"
            ok=0
        fi
    done

    if [[ $ok -eq 0 ]]; then
        echo ""
        echo "FAIL: versions out of sync. Run: $0" >&2
        exit 1
    fi
    echo ""
    echo "OK: all versions match"
}

main() {
    if [[ $# -gt 1 ]]; then
        usage
    fi

    local arg="${1:-}"

    if [[ "$arg" == "--check" ]]; then
        check
        return
    fi

    if [[ "$arg" == "-h" || "$arg" == "--help" ]]; then
        usage
    fi

    if [[ -n "$arg" ]]; then
        if [[ ! "$arg" =~ $SEMVER_RE ]]; then
            echo "ERROR: '$arg' is not valid semver MAJOR.MINOR.PATCH" >&2
            exit 1
        fi
        write_version_file "$arg"
    fi

    local v
    v="$(read_current_version)"
    if [[ ! "$v" =~ $SEMVER_RE ]]; then
        echo "ERROR: VERSION file contains '$v' — not valid semver" >&2
        exit 1
    fi

    propagate "$v"
}

main "$@"
