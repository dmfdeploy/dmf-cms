"""Prometheus API client — metrics, alerts, and target health."""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
import urllib.error


class PrometheusAPIError(Exception):
    """Raised when the Prometheus API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"Prometheus API {status}: {body}")


def _request(url: str, path: str, params: dict | None = None) -> dict:
    """Make a GET request to the Prometheus API (no auth required)."""
    base = url.rstrip("/")
    query_str = urllib.parse.urlencode(params or {})
    full_url = f"{base}{path}" + (f"?{query_str}" if query_str else "")
    req = urllib.request.Request(full_url, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode() if exc.fp else str(exc)
        raise PrometheusAPIError(exc.code, error_body) from exc


def ping(*, url: str) -> bool:
    """Check Prometheus health endpoint."""
    try:
        _request(url, "/-/healthy")
        return True
    except (PrometheusAPIError, Exception):
        return False


def query(*, url: str, expr: str) -> list[dict]:
    """Execute an instant query. Returns result array."""
    result = _request(url, "/api/v1/query", {"query": expr})
    data = result.get("data", {})
    return data.get("result", [])


def list_alerts(*, url: str) -> list[dict]:
    """List all active Prometheus alerts."""
    result = _request(url, "/api/v1/alerts")
    data = result.get("data", {})
    return data.get("alerts", [])


def list_targets(*, url: str) -> list[dict]:
    """List all Prometheus scrape targets and their health."""
    result = _request(url, "/api/v1/targets")
    data = result.get("data", {})
    return data.get("activeTargets", [])
