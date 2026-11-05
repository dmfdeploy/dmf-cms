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


def _request(
    url: str, path: str, params: dict | None = None, *, parse_json: bool = True
) -> dict:
    """Make a GET request to the Prometheus API (no auth required).

    ``parse_json=False`` is for the health endpoints, which answer in plain
    text; the body is read and discarded.
    """
    base = url.rstrip("/")
    query_str = urllib.parse.urlencode(params or {})
    full_url = f"{base}{path}" + (f"?{query_str}" if query_str else "")
    req = urllib.request.Request(full_url, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw and parse_json else {}
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode(errors="replace") if exc.fp else str(exc)
        raise PrometheusAPIError(exc.code, error_body) from exc


def ping(*, url: str) -> None:
    """Check the Prometheus health endpoint.

    Returns on a 2xx. Raises ``PrometheusAPIError`` on a non-2xx response and
    lets transport errors (``URLError``, timeouts) propagate, so the caller
    can tell "healthy" from "failed" and log why. The endpoint answers in
    plain text, not JSON.
    """
    _request(url, "/-/healthy", parse_json=False)


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


def flatten_alert(alert: dict) -> dict:
    """Flatten one raw alert into the fields the Monitoring page reads.

    Prometheus nests the name and severity under ``labels`` and the text
    under ``annotations``. ``list_alerts`` stays raw because the workspace
    health endpoint needs the full label set.
    """
    labels = alert.get("labels") or {}
    annotations = alert.get("annotations") or {}
    return {
        "name": labels.get("alertname", "unknown"),
        "state": alert.get("state", ""),
        "severity": labels.get("severity", ""),
        "summary": annotations.get("summary", ""),
        "description": annotations.get("description", ""),
        "activeAt": alert.get("activeAt", ""),
    }


def flatten_target(target: dict) -> dict:
    """Flatten one raw scrape target into the fields the Monitoring page reads."""
    labels = target.get("labels") or {}
    return {
        "job": labels.get("job", ""),
        "instance": labels.get("instance", ""),
        "health": target.get("health", "unknown"),
        "lastScrape": target.get("lastScrape", ""),
        "lastError": target.get("lastError", ""),
    }
