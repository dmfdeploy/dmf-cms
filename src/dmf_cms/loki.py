"""Loki API client — bounded log queries and runtime-config reads.

Transport only, mirroring ``prometheus.py``'s shape deliberately (same
``_request``/error-class pattern) so the two read seams stay recognizable as
siblings. All domain logic — selector construction, field parsing, retention
derivation, class gating — lives in ``audit_events.py``, not here.

The browser never talks to Loki (dmfdeploy/dmfdeploy#496 plan §4.2): this
client is only ever called server-side, and every caller is responsible for
its own bound on range/limit/timeout — this module accepts what it is given
and does not itself add a default that could quietly become an unbounded
read.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request


class LokiAPIError(Exception):
    """Raised when the Loki API returns a non-2xx response, or is unreachable."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"Loki API {status}: {body}")


def _get(url: str, path: str, params: dict | None = None, *, timeout: float) -> bytes:
    base = url.rstrip("/")
    query_str = urllib.parse.urlencode(params or {})
    full_url = f"{base}{path}" + (f"?{query_str}" if query_str else "")
    req = urllib.request.Request(full_url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise LokiAPIError(exc.code, error_body) from exc
    except urllib.error.URLError as exc:
        # DNS failure, connection refused, timeout — no HTTP status at all.
        # status=0 signals "never got a response" to callers that want to
        # tell that apart from a genuine non-2xx.
        raise LokiAPIError(0, str(exc.reason)) from exc


def query_range(
    *,
    url: str,
    selector: str,
    start_ns: int,
    end_ns: int,
    limit: int,
    timeout: float = 10,
) -> list[dict]:
    """Execute a bounded ``query_range`` and return the raw stream results.

    ``selector`` is server-built (never caller-supplied LogQL); ``start_ns``/
    ``end_ns``/``limit`` are the caller's bound — this function enforces
    nothing about their size, only that they are explicit.
    """
    raw = _get(
        url,
        "/loki/api/v1/query_range",
        {
            "query": selector,
            "start": str(start_ns),
            "end": str(end_ns),
            "limit": str(limit),
            "direction": "backward",
        },
        timeout=timeout,
    )
    data = json.loads(raw) if raw else {}
    return data.get("data", {}).get("result", [])


def raw_runtime_config(*, url: str, timeout: float = 10) -> str:
    """Fetch Loki's runtime config (YAML text) for retention derivation.

    Not every Loki deployment exposes ``/config`` — a non-2xx or transport
    failure here is a normal, expected outcome (the plan's condition 2b),
    handled by the caller as "retention unavailable", not raised further.
    """
    raw = _get(url, "/config", timeout=timeout)
    return raw.decode("utf-8", errors="replace")
