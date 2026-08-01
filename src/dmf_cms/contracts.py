from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
import yaml


@dataclass(frozen=True)
class AppLink:
    name: str
    url: str


@dataclass(frozen=True)
class AppContractEntry:
    key: str
    display_name: str
    lane: str
    summary: str
    deep_links: list[AppLink] = field(default_factory=list)
    # Where this service runs, for the Facility Detail page's container-image
    # read. Both stay None when the entry declares no `cluster:` block — a
    # service the console cannot look for is reported as unchecked, never as
    # absent (see the YAML's own comment for where the values come from).
    cluster_namespace: str | None = None
    cluster_image_contains: str | None = None


@dataclass(frozen=True)
class AppContract:
    product_name: str
    facility_name: str
    catalog_source: str
    apps: list[AppContractEntry]

    @property
    def public_app_count(self) -> int:
        return sum(1 for app in self.apps if app.lane == "public")

    @property
    def private_app_count(self) -> int:
        return sum(1 for app in self.apps if app.lane == "private")


def _load_mapping(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"contract at {path} must contain a mapping")
    return data


def _parse_cluster(key: str, data: Any) -> tuple[str | None, str | None]:
    """Parse an app entry's optional ``cluster:`` block into
    ``(namespace, image_contains)``.

    Absent block -> ``(None, None)``, the honest "nothing declared". A block
    that IS present must carry a namespace: declaring where a service runs and
    then omitting the one field that says where is a config defect, and
    accepting it would produce a row claiming a check that never ran.
    """
    if data is None:
        return None, None
    if not isinstance(data, dict):
        raise ValueError(f"cluster for {key} must be a mapping")
    namespace = str(data.get("namespace", "")).strip()
    if not namespace:
        raise ValueError(f"cluster for {key} requires a namespace")
    image_contains = str(data.get("image_contains", "")).strip()
    return namespace, image_contains or None


def _parse_links(data: Any) -> list[AppLink]:
    if data is None:
        return []
    if not isinstance(data, dict):
        raise ValueError("deep_links must be a mapping of name to URL")
    return [AppLink(name=str(name), url=str(url)) for name, url in data.items()]


def load_app_contract(path: Path) -> AppContract:
    if not path.exists():
        raise FileNotFoundError(f"app contract not found: {path}")

    data = _load_mapping(path)
    apps = data.get("apps", [])
    if not isinstance(apps, list) or not apps:
        raise ValueError("app contract must define a non-empty apps list")

    entries: list[AppContractEntry] = []
    seen_keys: set[str] = set()
    for raw in apps:
        if not isinstance(raw, dict):
            raise ValueError("each app entry must be a mapping")
        key = str(raw.get("key", "")).strip()
        display_name = str(raw.get("display_name", "")).strip()
        lane = str(raw.get("lane", "")).strip().lower()
        summary = str(raw.get("summary", "")).strip()
        if not key or not display_name or not lane or not summary:
            raise ValueError("app entries require key, display_name, lane, and summary")
        if lane not in {"public", "private"}:
            raise ValueError(f"unsupported lane for {key}: {lane}")
        if key in seen_keys:
            raise ValueError(f"duplicate app key: {key}")
        seen_keys.add(key)
        cluster_namespace, cluster_image_contains = _parse_cluster(key, raw.get("cluster"))
        entries.append(
            AppContractEntry(
                key=key,
                display_name=display_name,
                lane=lane,
                summary=summary,
                deep_links=_parse_links(raw.get("deep_links")),
                cluster_namespace=cluster_namespace,
                cluster_image_contains=cluster_image_contains,
            )
        )

    return AppContract(
        product_name=str(data.get("product_name", "DMF Console")).strip(),
        facility_name=str(data.get("facility_name", "Facility")).strip(),
        catalog_source=str(data.get("catalog_source", path.as_posix())).strip(),
        apps=entries,
    )
