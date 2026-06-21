"""Catalog YAML loader + NetBox-tag-join."""

from __future__ import annotations

import logging
import ssl
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import yaml

logger = logging.getLogger(__name__)

CATALOG_DIR = "/etc/dmf-cms/catalog/"


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


def _load_one_yaml(path: Path) -> Optional[CatalogEntry]:
    """Parse a single catalog YAML file into a CatalogEntry.

    Returns None when the file is unparseable or lacks a ``key`` field.
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
        logger.warning("catalog: %s lacks 'key' — skipping", path)
        return None

    return CatalogEntry(
        key=str(key),
        display_name=str(raw.get("display_name", key)),
        summary=str(raw.get("summary", "")),
        ebu=raw.get("ebu"),
        provision=raw.get("provision"),
        configure=raw.get("configure"),
        finalise=raw.get("finalise"),
        dependencies=raw.get("dependencies"),
        ingress=raw.get("ingress"),
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


def get_lifecycle_status(
    entry: CatalogEntry,
    netbox_url: str,
    netbox_token: str,
    ssl_verify: bool = True,
) -> str:
    """Query NetBox for the ipam.Service matching this entry and return its lifecycle tag.

    Returns one of: ``"bootstrapped"``, ``"active"``, ``"unknown"``, ``"error"``.
    """
    # Lazy import to avoid circular deps when netbox.py imports catalog helpers
    from . import netbox as _netbox

    service_name = (entry.provision or {}).get("netbox_service", {}).get("name") if entry.provision else None
    if not service_name:
        logger.warning("catalog: entry %s has no provision.netbox_service.name — status unknown", entry.key)
        return "unknown"

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
            state = tag_name.split(":", 1)[1]
            return state

    return "unknown"
