"""Build `docker save` output for tests: an OCI layout holding one image.

The daemon writes the manifest it stores with the media types it stores, so a
test can describe an OCI or a Docker v2 image by choosing the types here.
"""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
from typing import Any

OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip"
DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json"
DOCKER_LAYER = "application/vnd.docker.image.rootfs.diff.tar.gzip"


def digest_of(body: bytes) -> str:
    return "sha256:" + hashlib.sha256(body).hexdigest()


def dumps(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True).encode("utf-8")


def image_manifest(
    manifest_type: str = OCI_MANIFEST, config_type: str = OCI_CONFIG, layer_type: str = OCI_LAYER
) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "mediaType": manifest_type,
        "config": {"mediaType": config_type, "digest": "sha256:" + "5" * 64, "size": 984},
        "layers": [{"mediaType": layer_type, "digest": "sha256:" + "6" * 64, "size": 10}],
    }


def layout_tar(
    manifest: dict[str, Any] | None = None,
    descriptor_type: str = OCI_MANIFEST,
    *,
    extra_blobs: dict[str, bytes] | None = None,
    top_level_extra: int = 0,
) -> bytes:
    """One image as `docker save` writes it. `descriptor_type` is the type the
    daemon records for the manifest in index.json."""
    manifest_body = dumps(manifest if manifest is not None else image_manifest())
    blobs = {digest_of(manifest_body): manifest_body, **(extra_blobs or {})}
    descriptor = {"mediaType": descriptor_type, "digest": digest_of(manifest_body), "size": len(manifest_body)}
    index = {"schemaVersion": 2, "mediaType": OCI_INDEX, "manifests": [descriptor] * (1 + top_level_extra)}
    return build_tar({"index.json": dumps(index), "oci-layout": b'{"imageLayoutVersion":"1.0.0"}', **{
        "blobs/sha256/" + digest.split(":", 1)[1]: body for digest, body in blobs.items()
    }})


def build_tar(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, body in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(body)
            archive.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


def docker_typed_tar() -> bytes:
    """An image whose platform and labels are fine but whose types are Docker v2."""
    return layout_tar(image_manifest(DOCKER_MANIFEST, DOCKER_CONFIG, DOCKER_LAYER), DOCKER_MANIFEST)
