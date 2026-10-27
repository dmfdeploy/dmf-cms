"""Immutable C5 receipts for the setup-only born-inventory issuer path."""

from __future__ import annotations

import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

NAMESPACE = "dmf-setup-requests"
ACTION = "born-inventory-secretid-issue"
SCHEMA_VERSION = "1"
RECEIPT_TTL_SECONDS = 15 * 60
REQUEST_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
DATA_KEYS = frozenset(
    {
        "schema_version",
        "request_id",
        "action",
        "env_id",
        "cluster_uid",
        "actor",
        "role",
        "reason",
        "issued_at",
        "expires_at",
    }
)


def is_cluster_uid(value: object) -> bool:
    """Return whether value is a canonical Kubernetes namespace UID."""
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
    except (AttributeError, ValueError):
        return False
    return str(parsed) == value


class ReceiptStoreError(RuntimeError):
    """The receipt store could not persist and verify a request."""


class ReceiptAlreadyExists(ReceiptStoreError):
    """The generated receipt name unexpectedly already exists."""


class ReceiptWriter(Protocol):
    def create_and_verify(self, receipt: dict[str, object]) -> None: ...


@dataclass(frozen=True)
class SetupRequestBindings:
    env_id: str = ""
    cluster_uid: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.env_id.strip()) and is_cluster_uid(self.cluster_uid.strip())


def _safe_c5_value(value: str, *, field: str, max_length: int) -> str:
    cleaned = value.strip()
    if not cleaned or len(cleaned) > max_length or _CONTROL_RE.search(cleaned):
        raise ValueError(f"invalid {field}")
    return cleaned


def make_receipt(
    *,
    env_id: str,
    cluster_uid: str,
    actor: str,
    role: str,
    reason: str,
    now: int | None = None,
    request_id: str | None = None,
) -> dict[str, object]:
    """Build the exact v1 immutable ConfigMap contract; reject unsafe inputs."""
    request_id = request_id or uuid.uuid4().hex
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("invalid request id")
    env_id = _safe_c5_value(env_id, field="environment id", max_length=128)
    cluster_uid = _safe_c5_value(cluster_uid, field="cluster uid", max_length=128)
    if not is_cluster_uid(cluster_uid):
        raise ValueError("invalid cluster uid")
    actor = _safe_c5_value(actor, field="actor", max_length=256)
    role = _safe_c5_value(role, field="role", max_length=32)
    if role not in {"operator", "engineer", "admin"}:
        raise ValueError("invalid effective role")
    reason = _safe_c5_value(reason, field="reason", max_length=240)
    issued_at = int(time.time()) if now is None else int(now)
    expires_at = issued_at + RECEIPT_TTL_SECONDS
    name = f"request-{request_id}"
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": name, "namespace": NAMESPACE},
        "immutable": True,
        "data": {
            "schema_version": SCHEMA_VERSION,
            "request_id": request_id,
            "action": ACTION,
            "env_id": env_id,
            "cluster_uid": cluster_uid,
            "actor": actor,
            "role": role,
            "reason": reason,
            "issued_at": str(issued_at),
            "expires_at": str(expires_at),
        },
    }


def validate_receipt(
    receipt: dict[str, object], bindings: SetupRequestBindings, *, now: int | None = None
) -> bool:
    """Validate a stored receipt shape and its server-derived bindings."""
    metadata = receipt.get("metadata")
    data = receipt.get("data")
    if not isinstance(metadata, dict) or not isinstance(data, dict):
        return False
    if (
        receipt.get("apiVersion") != "v1"
        or receipt.get("kind") != "ConfigMap"
        or receipt.get("immutable") is not True
        or not bindings.configured
    ):
        return False
    request_id = data.get("request_id")
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        return False
    if metadata.get("namespace") != NAMESPACE or metadata.get("name") != f"request-{request_id}":
        return False
    if set(data) != DATA_KEYS or any(not isinstance(value, str) for value in data.values()):
        return False
    if data.get("schema_version") != SCHEMA_VERSION or data.get("action") != ACTION:
        return False
    if data.get("env_id") != bindings.env_id or data.get("cluster_uid") != bindings.cluster_uid:
        return False
    for key, max_length in (("actor", 256), ("role", 32), ("reason", 240)):
        value = data.get(key)
        if not isinstance(value, str) or not value or len(value) > max_length or _CONTROL_RE.search(value):
            return False
    if data.get("role") not in {"operator", "engineer", "admin"}:
        return False
    if not re.fullmatch(r"[0-9]+", data["issued_at"]) or not re.fullmatch(
        r"[0-9]+", data["expires_at"]
    ):
        return False
    issued_at = int(data["issued_at"])
    expires_at = int(data["expires_at"])
    now = int(time.time()) if now is None else int(now)
    return (
        issued_at <= now
        and expires_at > now
        and expires_at > issued_at
        and expires_at - issued_at <= RECEIPT_TTL_SECONDS
    )


class KubernetesReceiptWriter:
    """Create and read back a receipt using the pod's narrowly scoped SA."""

    def __init__(
        self,
        *,
        api_server: str | None = None,
        token_path: str = "/var/run/secrets/kubernetes.io/serviceaccount/token",
        ca_path: str = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
        timeout: float = 4.0,
    ) -> None:
        host = os.getenv("KUBERNETES_SERVICE_HOST", "")
        port = os.getenv("KUBERNETES_SERVICE_PORT_HTTPS", "443")
        self.api_server = (api_server or (f"https://{host}:{port}" if host else "")).rstrip("/")
        self.token_path = token_path
        self.ca_path = ca_path
        self.timeout = timeout

    def _call(self, method: str, path: str, body: dict[str, object] | None = None) -> dict[str, object]:
        if not self.api_server:
            raise ReceiptStoreError("Kubernetes API endpoint is unavailable")
        try:
            token = Path(self.token_path).read_text(encoding="utf-8").strip()
            if not token:
                raise ReceiptStoreError("Kubernetes service account token is empty")
            context = ssl.create_default_context(cafile=self.ca_path)
            request = urllib.request.Request(
                self.api_server + path,
                data=(json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else None),
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    **({"Content-Type": "application/json"} if body is not None else {}),
                },
                method=method,
            )
            with urllib.request.urlopen(request, timeout=self.timeout, context=context) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                raise ReceiptAlreadyExists("receipt name already exists") from None
            raise ReceiptStoreError("Kubernetes receipt request failed") from None
        except (OSError, ValueError, json.JSONDecodeError, ssl.SSLError):
            raise ReceiptStoreError("Kubernetes receipt request failed") from None
        if not isinstance(result, dict):
            raise ReceiptStoreError("Kubernetes returned an invalid receipt")
        return result

    def create_and_verify(self, receipt: dict[str, object]) -> None:
        name = str(receipt["metadata"]["name"])  # type: ignore[index]
        collection_path = f"/api/v1/namespaces/{NAMESPACE}/configmaps"
        item_path = f"{collection_path}/{urllib.parse.quote(name, safe='')}"
        self._call("POST", collection_path, receipt)
        stored = self._call("GET", item_path)
        metadata = stored.get("metadata")
        if not isinstance(metadata, dict) or (
            stored.get("immutable") is not True
            or metadata.get("uid") is None
            or metadata.get("name") != name
            or metadata.get("namespace") != NAMESPACE
            or stored.get("data") != receipt.get("data")
        ):
            raise ReceiptStoreError("stored receipt did not match the requested record")

