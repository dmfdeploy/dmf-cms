"""Catalog YAML loader + NetBox-tag-join."""

from __future__ import annotations

import logging
import os
import ssl
import urllib.parse
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import yaml

logger = logging.getLogger(__name__)

CATALOG_DIR = "/etc/dmf-cms/catalog/"

# ADR-0046 decision 6 — fail-closed classification enums.
# Exactly one of vertical or media_function_type must be set per entry.
VALID_VERTICALS = frozenset({"orchestration", "control", "monitoring", "security"})
VALID_MEDIA_FUNCTION_TYPES = frozenset({
    "source", "view", "processor", "mixer",
    "output", "render", "gfx", "multiviewer",
})


@dataclass(frozen=True)
class CatalogEntry:
    """A single function-catalog entry loaded from YAML."""

    key: str
    display_name: str
    summary: str
    ebu: Optional[dict[str, Any]] = None
    provision: Optional[dict[str, Any]] = None
    configure: Optional[dict[str, Any]] = None
    finalise: Optional[dict[str, Any]] = None
    dependencies: Optional[list[str]] = None
    # Optional UI link-out for functions that expose an operator console of their
    # own (e.g. nmos-crosspoint). Shape: {host: <fqdn>}. Surfaced as an "Open"
    # link on the card once the entry is lifecycle:active.
    ingress: Optional[dict[str, Any]] = None
    # umbrella #201 WP3a: optional filename (same catalog dir) of a
    # topology_params instance this entry deploys (dmf-media
    # catalog/topology-params.schema.yaml, WP1). Absent = None = zero
    # behavior change — the deploy launch seam only resolves/injects
    # topology_params when this is set. The WP2 dmf-media entry-file edits
    # that actually populate this field for real entries are out of scope
    # here; this WO supports the mechanism.
    topology_ref: Optional[str] = None


def _validate_ebu(key: str, ebu: Any) -> bool:
    """Validate the ebu block per ADR-0046 decision 6 (fail-closed).

    Exactly one of ``vertical`` or ``media_function_type`` must be set,
    each within its enum.  Returns True if valid, False (with error log)
    if the entry must be rejected.
    """
    if not isinstance(ebu, dict):
        logger.error(
            "catalog: entry '%s' REJECTED — ebu block is missing or not a mapping",
            key,
        )
        return False

    has_vertical = "vertical" in ebu
    has_mft = "media_function_type" in ebu

    if has_vertical and has_mft:
        logger.error(
            "catalog: entry '%s' REJECTED — ebu has both vertical and "
            "media_function_type (exactly one required, ADR-0046 §6)",
            key,
        )
        return False

    if not has_vertical and not has_mft:
        logger.error(
            "catalog: entry '%s' REJECTED — ebu has neither vertical nor "
            "media_function_type (exactly one required, ADR-0046 §6)",
            key,
        )
        return False

    if has_vertical:
        val = ebu["vertical"]
        if not isinstance(val, str) or val not in VALID_VERTICALS:
            logger.error(
                "catalog: entry '%s' REJECTED — ebu.vertical %r is not a "
                "valid string in %s",
                key, val, sorted(VALID_VERTICALS),
            )
            return False

    if has_mft:
        val = ebu["media_function_type"]
        if not isinstance(val, str) or val not in VALID_MEDIA_FUNCTION_TYPES:
            logger.error(
                "catalog: entry '%s' REJECTED — ebu.media_function_type %r "
                "is not a valid string in %s",
                key, val, sorted(VALID_MEDIA_FUNCTION_TYPES),
            )
            return False

    return True


def _is_topology_contract_file(raw: dict[str, Any]) -> bool:
    """True for topology_params schema/instance documents (umbrella #201 WP1).

    These live in the same catalog/*.yaml glob as function entries but are
    a different kind of document entirely — no ``key`` field, never a
    function to load. Distinguished so ``_load_one_yaml`` can skip them
    quietly (debug level) instead of the generic 'lacks key' warning, which
    would otherwise fire on every catalog load for these expected,
    legitimate files.
    """
    if "topology_params" in raw:  # an instance file, e.g. topology-params.j1.yaml
        return True
    if "schema_version" in raw and "fields" in raw:  # the schema file itself
        return True
    return False


def _load_one_yaml(path: Path) -> Optional[CatalogEntry]:
    """Parse a single catalog YAML file into a CatalogEntry.

    Returns None when the file is unparseable, lacks a ``key`` field, or
    violates the ADR-0046 ebu classification rule (fail-closed).
    """
    try:
        raw = yaml.safe_load(path.read_text())
    except Exception as exc:
        logger.warning("catalog: failed to parse %s: %s", path, exc)
        return None

    if not isinstance(raw, dict):
        logger.warning("catalog: %s did not yield a mapping", path)
        return None

    key = raw.get("key")
    if not key:
        if _is_topology_contract_file(raw):
            logger.debug(
                "catalog: %s is a topology_params contract/instance file, not a "
                "function entry — skipping", path,
            )
        else:
            logger.warning("catalog: %s lacks 'key' — skipping", path)
        return None

    ebu = raw.get("ebu")
    if not _validate_ebu(str(key), ebu):
        return None

    topology_ref = raw.get("topology_ref")
    return CatalogEntry(
        key=str(key),
        display_name=str(raw.get("display_name", key)),
        summary=str(raw.get("summary", "")),
        ebu=ebu,
        provision=raw.get("provision"),
        configure=raw.get("configure"),
        finalise=raw.get("finalise"),
        dependencies=raw.get("dependencies"),
        ingress=raw.get("ingress"),
        topology_ref=str(topology_ref) if topology_ref else None,
    )


def load_catalog_entries(catalog_dir: str = CATALOG_DIR) -> list[CatalogEntry]:
    """Load all valid *.yaml files from *catalog_dir* into CatalogEntry objects.

    Files that fail to parse or lack ``key`` are skipped with a warning.
    """
    directory = Path(catalog_dir)
    if not directory.is_dir():
        logger.warning("catalog: directory %s does not exist — returning empty", catalog_dir)
        return []

    entries: list[CatalogEntry] = []
    for ypath in sorted(directory.glob("*.yaml")):
        entry = _load_one_yaml(ypath)
        if entry is not None:
            entries.append(entry)

    # Also accept *.yml
    for ypath in sorted(directory.glob("*.yml")):
        entry = _load_one_yaml(ypath)
        if entry is not None:
            entries.append(entry)

    return entries


def load_topology_instance(
    catalog_dir: str, topology_ref: str
) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    """Load + validate a topology_params instance referenced by ``topology_ref``.

    umbrella #201 WP3a — the launch seam's other half of WP1's frozen
    contract (dmf-media catalog/topology-params.schema.yaml). Fail-closed:
    a malformed instance must never let a deploy launch with a partial or
    wrong topology, so any validation failure returns ``(None, "reason")``
    rather than a best-effort partial object. On success returns
    ``(topology_params_dict, None)`` — the object as authored, with
    ``target_facility`` still the catalog's illustrative placeholder; the
    caller (the launch seam) is responsible for resolving it to the env's
    real NetBox site slug before injecting into AWX extra_vars.

    Enforces the full WP1 frozen contract (dmf-media
    catalog/topology-params.schema.yaml): schema_version == 1; sources is a
    non-empty list with unique ids, each entry has id/flow_id/pattern,
    flow_id is a well-formed UUID and unique across sources[], pattern is
    distinct across sources[]; viewer.source_selection references a real
    sources[].id; target_facility is present. ``topology_ref`` itself must
    be a plain basename within ``catalog_dir`` — no path separators, no
    parent traversal, no absolute paths — refused before any file I/O
    (defense-in-depth: also enforced by resolved-path containment below).
    """
    if (
        os.path.isabs(topology_ref)
        or os.sep in topology_ref
        or (os.altsep and os.altsep in topology_ref)
        or Path(topology_ref).name != topology_ref
        or ".." in Path(topology_ref).parts
    ):
        return None, (
            f"topology_ref {topology_ref!r} must be a plain filename within the "
            "catalog directory — no path separators, parent traversal, or "
            "absolute paths"
        )

    # Containment backstop: resolved-DESCENDANT check, not resolved-PARENT
    # equality. Kubernetes ConfigMap volumes serve every file as a symlink
    # through ..data/ into a timestamped directory — two levels below the
    # mount root — so requiring path.parent == catalog_root refused ALL
    # legitimately-mounted refs (live incident, 2026-07-27). Descendant
    # containment accepts that indirection while still refusing a
    # plain-basename ref whose on-disk target is a symlink escaping the
    # catalog dir (an escape the basename pre-checks above cannot see).
    catalog_root = Path(catalog_dir).resolve()
    path = (catalog_root / topology_ref).resolve()
    if path != catalog_root and catalog_root not in path.parents:
        return None, f"topology_ref {topology_ref!r} resolves outside the catalog directory"

    try:
        raw = yaml.safe_load(path.read_text())
    except FileNotFoundError:
        return None, f"topology_ref '{topology_ref}' not found in catalog"
    except Exception as exc:
        return None, f"topology_ref '{topology_ref}' failed to parse: {exc}"

    if not isinstance(raw, dict):
        return None, f"topology_ref '{topology_ref}' did not yield a mapping"

    tp = raw.get("topology_params")
    if not isinstance(tp, dict):
        return None, f"topology_ref '{topology_ref}' has no top-level topology_params object"

    if tp.get("schema_version") != 1:
        return None, (
            f"topology_ref '{topology_ref}': schema_version must equal 1, "
            f"got {tp.get('schema_version')!r}"
        )

    sources = tp.get("sources")
    if not isinstance(sources, list) or not sources:
        return None, f"topology_ref '{topology_ref}': sources must be a non-empty list"

    ids: list[str] = []
    parsed_flow_ids: list[uuid.UUID] = []
    patterns: list[str] = []
    for i, s in enumerate(sources):
        if not isinstance(s, dict):
            return None, f"topology_ref '{topology_ref}': sources[{i}] is not a mapping"
        sid = s.get("id")
        if not sid or not isinstance(sid, str):
            return None, f"topology_ref '{topology_ref}': sources[{i}].id missing/invalid"
        flow_id = s.get("flow_id")
        if not flow_id or not isinstance(flow_id, str):
            return None, f"topology_ref '{topology_ref}': sources[{i}].flow_id missing/invalid"
        try:
            parsed_flow_id = uuid.UUID(flow_id)
        except ValueError:
            return None, (
                f"topology_ref '{topology_ref}': sources[{i}].flow_id "
                f"{flow_id!r} is not a well-formed UUID"
            )
        pattern = s.get("pattern")
        if not pattern or not isinstance(pattern, str):
            return None, f"topology_ref '{topology_ref}': sources[{i}].pattern missing/invalid"
        ids.append(sid)
        # Uniqueness compares the PARSED uuid.UUID value, not the raw
        # string (codex P1 re-gate): "5FBEC3B1-..." and "5fbec3b1-..." are
        # the SAME flow identity in different case spellings — a
        # string-set comparison would let both through. The authored
        # string itself (flow_id, not parsed_flow_id) is what's stored
        # below and returned unchanged in the object.
        parsed_flow_ids.append(parsed_flow_id)
        patterns.append(pattern)

    if len(ids) != len(set(ids)):
        return None, f"topology_ref '{topology_ref}': sources[].id values are not unique"
    if len(parsed_flow_ids) != len(set(parsed_flow_ids)):
        return None, f"topology_ref '{topology_ref}': sources[].flow_id values are not unique"
    if len(patterns) != len(set(patterns)):
        return None, (
            f"topology_ref '{topology_ref}': sources[].pattern values are not "
            "distinct — the switch must be visually unambiguous (spec §4)"
        )

    viewer = tp.get("viewer")
    if not isinstance(viewer, dict):
        return None, f"topology_ref '{topology_ref}': viewer must be a mapping"
    if not viewer.get("id") or not isinstance(viewer.get("id"), str):
        return None, f"topology_ref '{topology_ref}': viewer.id missing/invalid"
    source_selection = viewer.get("source_selection")
    if not source_selection or not isinstance(source_selection, str):
        return None, f"topology_ref '{topology_ref}': viewer.source_selection missing/invalid"
    if source_selection not in ids:
        return None, (
            f"topology_ref '{topology_ref}': viewer.source_selection "
            f"{source_selection!r} does not reference a known sources[].id {ids}"
        )

    if not tp.get("target_facility") or not isinstance(tp.get("target_facility"), str):
        return None, f"topology_ref '{topology_ref}': target_facility missing/invalid"

    return tp, None


def _netbox_service_names(entry: CatalogEntry) -> list[str]:
    """Normalize ``provision.netbox_service`` to a list of service names.

    Mirrors drain.py's own ``_netbox_service_specs`` normalization (today
    every shipped entry authors a single dict; a LIST is a real shape for
    umbrella #201 WP5's topology-carrying entries, which provision one
    NetBox service per source). Same "no partial declaration" rule: a
    declared list with any non-dict member, or any member missing a
    string ``name``, is malformed as a WHOLE — returns ``[]`` uniformly
    (same as "no netbox_service at all"), never a silently-filtered
    partial subset.
    """
    if not entry.provision:
        return []
    raw = entry.provision.get("netbox_service")
    specs: list[Any]
    if isinstance(raw, dict):
        specs = [raw]
    elif isinstance(raw, list):
        if not raw or not all(isinstance(r, dict) for r in raw):
            return []
        specs = raw
    else:
        return []
    names = [spec.get("name") for spec in specs]
    if not all(isinstance(n, str) and n for n in names):
        return []
    return names


def _service_lifecycle_tag(
    service_name: str, netbox_url: str, netbox_token: str, ssl_verify: bool
) -> str:
    """Query NetBox for ONE ipam.Service by name and return its lifecycle tag.

    Returns one of: ``"bootstrapped"``, ``"active"``, ``"unknown"``, ``"error"``.
    The original (pre-WP5) single-service body of ``get_lifecycle_status``,
    factored out so an N-service entry can query each and aggregate.
    """
    # Lazy import to avoid circular deps when netbox.py imports catalog helpers
    from . import netbox as _netbox

    ctx = _netbox._ssl_context(ssl_verify)
    path = f"/api/ipam/services/?name={urllib.parse.quote(service_name)}"

    try:
        result = _netbox._request(netbox_url, netbox_token, path, ssl_context=ctx)
    except _netbox.NetboxAPIError as exc:
        logger.warning("catalog: NetBox query for %s failed: %s", service_name, exc)
        return "error"
    except Exception as exc:
        logger.warning("catalog: unexpected error querying NetBox for %s: %s", service_name, exc)
        return "error"

    services = result.get("results", [])
    if not services:
        return "unknown"

    # Inspect the first matching service's tags
    svc = services[0]
    tags = svc.get("tags", [])
    for tag_obj in tags:
        tag_name = tag_obj.get("name", "") if isinstance(tag_obj, dict) else str(tag_obj)
        if tag_name.startswith("lifecycle:"):
            return tag_name.split(":", 1)[1]

    return "unknown"


def get_lifecycle_status(
    entry: CatalogEntry,
    netbox_url: str,
    netbox_token: str,
    ssl_verify: bool = True,
) -> str:
    """Query NetBox for this entry's ipam.Service(s) and return an
    aggregate lifecycle tag.

    Returns one of: ``"bootstrapped"``, ``"active"``, ``"unknown"``,
    ``"error"``. A single ``provision.netbox_service`` stays the common
    shape; umbrella #201 WP5 adds support for a LIST (mirrors drain.py's
    own N-service normalization for topology-carrying entries that
    provision one NetBox service per source).

    Aggregation is fail-closed / no-partial-success: if ANY service query
    errors, the whole entry reports ``"error"`` (never hide a real failure
    behind others that happened to succeed). If every service agrees on
    the SAME lifecycle value, that value is returned. Any other
    disagreement (e.g. some sources active, some still bootstrapped — a
    genuinely partial deployment) reports ``"unknown"`` rather than
    picking a side — overclaiming ``"active"`` when only some sources are
    up would be exactly the kind of dishonest partial-success signal this
    codebase otherwise refuses (see drain.py's ``_netbox_service_specs``
    docstring). For a single-service entry this is byte-identical to the
    pre-WP5 behavior (one status in, that status out).
    """
    service_names = _netbox_service_names(entry)
    if not service_names:
        logger.warning("catalog: entry %s has no provision.netbox_service.name — status unknown", entry.key)
        return "unknown"

    statuses = [
        _service_lifecycle_tag(name, netbox_url, netbox_token, ssl_verify)
        for name in service_names
    ]
    if "error" in statuses:
        return "error"
    distinct = set(statuses)
    if len(distinct) == 1:
        return distinct.pop()
    return "unknown"
