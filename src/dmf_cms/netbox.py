"""NetBox API client — infrastructure device and site inventory."""

from __future__ import annotations

import json
import ssl
import urllib.request
import urllib.error


class NetboxAPIError(Exception):
    """Raised when the NetBox API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"NetBox API {status}: {body}")


def _request(
    api_url: str,
    api_token: str,
    path: str,
    ssl_context: ssl.SSLContext | None = None,
    method: str = "GET",
    payload: dict | None = None,
) -> dict:
    """Make an authenticated JSON request to the NetBox API.

    Defaults to GET (all pre-existing callers). Write methods (PATCH) are
    used ONLY by the media-workloads clear-for-deployment action, which
    authenticates with the scoped writer token (ADR-0032), never the
    read token.
    """
    url = api_url.rstrip("/") + path
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, headers=headers, method=method, data=data)

    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl_context) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode() if exc.fp else str(exc)
        raise NetboxAPIError(exc.code, error_body) from exc


def _ssl_context(verify: bool) -> ssl.SSLContext | None:
    """Return an SSL context that skips verification when verify=False."""
    if not verify:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None


def ping(
    *,
    api_url: str,
    api_token: str,
    ssl_verify: bool = True,
) -> dict:
    """Check NetBox API health. Returns status object."""
    ctx = _ssl_context(ssl_verify)
    return _request(api_url, api_token, "/api/status/", ssl_context=ctx)


def list_sites(
    *,
    api_url: str,
    api_token: str,
    ssl_verify: bool = True,
) -> list[dict]:
    """List all datacenter sites."""
    ctx = _ssl_context(ssl_verify)
    result = _request(
        api_url,
        api_token,
        "/api/dcim/sites/?brief=1&limit=100",
        ssl_context=ctx,
    )
    return result.get("results", [])


def list_devices(
    *,
    api_url: str,
    api_token: str,
    ssl_verify: bool = True,
) -> list[dict]:
    """List all physical infrastructure devices (servers, switches, etc.)."""
    ctx = _ssl_context(ssl_verify)
    result = _request(
        api_url,
        api_token,
        "/api/dcim/devices/?limit=100",
        ssl_context=ctx,
    )
    return result.get("results", [])
