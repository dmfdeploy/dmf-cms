"""AWX API client — job template launch and status polling."""

from __future__ import annotations

import json
import ssl
import time
import urllib.parse
import urllib.request
import urllib.error
from dataclasses import dataclass
from datetime import datetime, timezone


class AWXAPIError(Exception):
    """Raised when the AWX API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"AWX API {status}: {body}")


class AWXAutoscaleError(Exception):
    """Raised when the AWX autoscale helper returns a non-200 response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"AWX autoscale helper {status}: {body}")


@dataclass(frozen=True)
class AWXJobInfo:
    job_id: int
    status: str  # new, pending, waiting, running, successful, failed, canceled, error
    name: str = ""
    url: str = ""
    elapsed: float = 0.0
    failed: bool = False

    @property
    def is_done(self) -> bool:
        return self.status in {"successful", "failed", "canceled", "error"}

    @property
    def is_running(self) -> bool:
        return self.status in {"new", "pending", "waiting", "running"}


def _request(
    api_url: str,
    api_token: str,
    method: str,
    path: str,
    body: dict | None = None,
    ssl_context: ssl.SSLContext | None = None,
) -> dict:
    """Make an authenticated JSON request to the AWX API."""
    url = api_url.rstrip("/") + path
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl_context) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode() if exc.fp else str(exc)
        raise AWXAPIError(exc.code, error_body) from exc


# codex R3-6: fixed, not configurable — see _request_text's docstring.
_TEXT_READ_CHUNK_BYTES = 8 * 1024
_TEXT_TAIL_BYTES = 64 * 1024


def _request_text(
    api_url: str,
    api_token: str,
    method: str,
    path: str,
    ssl_context: ssl.SSLContext | None = None,
) -> str:
    """Make an authenticated request to the AWX API, returning raw text.

    Distinct from ``_request``: some AWX endpoints (job stdout) return
    plain text, not JSON — ``_request``'s ``json.loads`` would raise on
    that body. Used by ``get_job_stdout`` (umbrella #202 WP2).

    codex R3-6: streams the response body in fixed ``_TEXT_READ_CHUNK_BYTES``
    reads into a rolling buffer that retains only the last
    ``_TEXT_TAIL_BYTES`` — the full body is NEVER materialized in memory,
    regardless of how large the underlying AWX job's stdout actually is (a
    prior draft fetched via a single unbounded ``resp.read()`` then sliced
    the resulting string after the fact — a memory/latency risk for a
    genuinely huge job log, and the actual full body still transited
    memory once). A trailing partial multi-byte UTF-8 sequence at either
    the chunk or tail-window boundary is tolerated via ``errors="replace"``
    on the final decode — the outcome marker contract only needs the tail
    to be readable, not byte-exact.

    codex R4-5: the HTTPError path is bounded too — a fixed-size PREFIX
    read (``_TEXT_READ_CHUNK_BYTES``, the same constant as the success
    path's chunk size, reused rather than adding a near-duplicate) via
    ``exc.read(size)``, not the success path's rolling tail-window. An
    error body's useful content (an AWX-rendered JSON error/HTML message)
    is normally short and front-loaded, unlike a job's stdout log where
    the useful content is the LAST line — a prefix is the right shape
    here, a tail wouldn't be. Still never an unbounded ``exc.read()``
    regardless of how large the error body actually is.
    """
    url = api_url.rstrip("/") + path
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Accept": "text/plain",
    }
    req = urllib.request.Request(url, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl_context) as resp:
            tail = b""
            while True:
                chunk = resp.read(_TEXT_READ_CHUNK_BYTES)
                if not chunk:
                    break
                tail += chunk
                if len(tail) > _TEXT_TAIL_BYTES:
                    tail = tail[-_TEXT_TAIL_BYTES:]
            return tail.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        error_body = exc.read(_TEXT_READ_CHUNK_BYTES).decode(errors="replace") if exc.fp else str(exc)
        raise AWXAPIError(exc.code, error_body) from exc


def call_with_transient_retry(fn, *, attempts=3, delay=3.0, sleep=None):
    """Call fn(), retrying transient AWX failures (HTTP 5xx or URLError).

    Covers the post-wake window where AWX is Ready but its API briefly
    returns 5xx or resets connections (#134).
    """
    if sleep is None:
        sleep = time.sleep
    for attempt in range(attempts):
        try:
            return fn()
        except (AWXAPIError, urllib.error.URLError) as exc:
            transient = isinstance(exc, urllib.error.URLError) or (
                isinstance(exc, AWXAPIError) and exc.status >= 500
            )
            if not transient or attempt == attempts - 1:
                raise
            sleep(delay)


def _ssl_context(verify: bool) -> ssl.SSLContext | None:
    if not verify:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None


def list_job_templates(
    *,
    api_url: str,
    api_token: str,
    ssl_verify: bool = True,
) -> list[dict]:
    """Return all job templates visible to the service account."""
    ctx = _ssl_context(ssl_verify)
    result = _request(api_url, api_token, "GET", "/api/v2/job_templates/", ssl_context=ctx)
    return result.get("results", [])


def lookup_job_template_by_name(
    *,
    api_url: str,
    api_token: str,
    name: str,
    ssl_verify: bool = True,
) -> dict | None:
    """Find a job template by its name."""
    ctx = _ssl_context(ssl_verify)
    result = _request(
        api_url, api_token, "GET",
        f"/api/v2/job_templates/?name={urllib.parse.quote(name)}",
        ssl_context=ctx,
    )
    results = result.get("results", [])
    return results[0] if results else None


def launch_job(
    *,
    api_url: str,
    api_token: str,
    job_template_id: int,
    ssl_verify: bool = True,
    extra_vars: dict | None = None,
) -> int:
    """Launch a job from a job template. Returns the job id.

    extra_vars is a generic passthrough dict, not a workload-only channel —
    #239 threads workload_slug through it today, but the future v0.2b
    topology_params object (WP3a) rides the same param, so this stays a
    plain dict rather than growing dedicated keyword args per feature.

    AWX silently ignores launch-time extra_vars unless the job template has
    ask_variables_on_launch=true; the dmf-infra side of the #239 trio flips
    that flag on the catalog job templates. Until then, passing extra_vars
    here is a no-op on AWX's end, not an error.
    """
    ctx = _ssl_context(ssl_verify)
    body = {"extra_vars": extra_vars} if extra_vars else {}
    result = _request(
        api_url, api_token, "POST",
        f"/api/v2/job_templates/{job_template_id}/launch/",
        body=body,
        ssl_context=ctx,
    )
    # AWX returns the job id in the 'job' key for launch responses
    return int(result.get("job", result.get("id", 0)))


def find_active_job_for_template(
    *,
    api_url: str,
    api_token: str,
    job_template_id: int,
    ssl_verify: bool = True,
) -> int | None:
    """Return the id of an in-flight job for this job template, or None.

    "In-flight" = AWX status in new/pending/waiting/running. Used to make a
    launch idempotent: a double-click (or two tabs / refresh / slow render)
    that arrives while a prior job is still active gets the SAME job id back
    instead of spawning a duplicate.
    """
    ctx = _ssl_context(ssl_verify)
    result = _request(
        api_url, api_token, "GET",
        f"/api/v2/jobs/?job_template={int(job_template_id)}"
        "&status__in=new,pending,waiting,running&order_by=-id&page_size=1",
        ssl_context=ctx,
    )
    results = result.get("results", [])
    return int(results[0]["id"]) if results else None


def get_job_status(
    *,
    api_url: str,
    api_token: str,
    job_id: int,
    ssl_verify: bool = True,
) -> AWXJobInfo:
    """Fetch the current status of a job."""
    ctx = _ssl_context(ssl_verify)
    result = _request(
        api_url, api_token, "GET",
        f"/api/v2/jobs/{job_id}/",
        ssl_context=ctx,
    )
    return AWXJobInfo(
        job_id=int(result.get("id", 0)),
        status=str(result.get("status", "unknown")),
        name=str(result.get("name", "")),
        url=str(result.get("url", "")),
        elapsed=float(result.get("elapsed", 0)),
        failed=result.get("failed", False),
    )


def get_job(
    *,
    api_url: str,
    api_token: str,
    job_id: int,
    ssl_verify: bool = True,
) -> dict:
    """Fetch the full raw job detail (umbrella #202 WP2 job watcher).

    Distinct from ``get_job_status``: this returns the raw AWX response
    dict (at least ``status``, ``started``, ``finished``) rather than the
    narrowed ``AWXJobInfo`` — the watcher needs ``started`` (to distinguish
    "job failed before ever starting" from "job started then failed",
    plan §4.5) which ``AWXJobInfo`` doesn't carry.
    """
    ctx = _ssl_context(ssl_verify)
    return _request(
        api_url, api_token, "GET",
        f"/api/v2/jobs/{job_id}/",
        ssl_context=ctx,
    )


# Kept as a public-ish alias of _request_text's own bound (codex R2-9/R3-6)
# so callers/tests that think in terms of "a job's stdout" don't need to
# know _request_text is the layer that actually enforces it.
_STDOUT_TAIL_BYTES = _TEXT_TAIL_BYTES


def get_job_stdout(
    *,
    api_url: str,
    api_token: str,
    job_id: int,
    ssl_verify: bool = True,
) -> str:
    """Fetch a job's stdout as plain text (umbrella #202 WP2-B parses
    rollback/outcome markers from this).

    Only the last ``_STDOUT_TAIL_BYTES`` (== ``_request_text``'s own
    ``_TEXT_TAIL_BYTES``) ever reach the caller — the outcome marker is
    always the LAST matching line, so the tail is sufficient, and callers
    must never see (or forward into an API response) more of a job's raw
    log than that fixed bound. codex R3-6: the bound is enforced by
    ``_request_text`` streaming the read itself, not by slicing an
    already-fully-fetched string here.
    """
    ctx = _ssl_context(ssl_verify)
    return _request_text(
        api_url, api_token, "GET",
        f"/api/v2/jobs/{job_id}/stdout/?format=txt",
        ssl_context=ctx,
    )


def wait_for_job(
    *,
    api_url: str,
    api_token: str,
    job_id: int,
    poll_seconds: int = 5,
    max_polls: int = 120,  # 10 minutes at 5s intervals
    ssl_verify: bool = True,
) -> AWXJobInfo:
    """Poll a job until it completes or times out."""
    ctx = _ssl_context(ssl_verify)
    for _ in range(max_polls):
        info = get_job_status(
            api_url=api_url, api_token=api_token,
            job_id=job_id, ssl_verify=ssl_verify,
        )
        if info.is_done:
            return info
        time.sleep(poll_seconds)

    # Timed out — return last known status
    return AWXJobInfo(
        job_id=job_id,
        status="timed_out",
        name=f"job/{job_id}",
    )


def ensure_awx_awake(
    *,
    helper_url: str,
    bearer_token: str,
    max_startup_wait: int = 1260,
) -> None:
    """Call the AWX autoscale helper to wake AWX before API reads.

    POSTs to {helper_url}/ensure-awake with bearer auth. The helper blocks
    until AWX is ready (idempotent, single-flight). Returns on 200. Raises
    AWXAutoscaleError on 503/timeout or network error.

    No-op if helper_url or bearer_token is empty (allows graceful disable
    without changing the enabled flag).
    
    max_startup_wait MUST be >= helper AWX_AUTOSCALE_MAX_STARTUP_WAIT (1200s)
    plus margin. Pi cold wake measured at ~15 min.
    """
    if not helper_url or not bearer_token:
        return

    url = helper_url.rstrip("/") + "/ensure-awake"
    headers = {
        "Authorization": f"Bearer {bearer_token}",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, data=b"", headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=max_startup_wait) as resp:
            if resp.status != 200:
                error_body = resp.read().decode() if resp.fp else str(resp.status)
                raise AWXAutoscaleError(resp.status, error_body)
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode() if exc.fp else str(exc)
        raise AWXAutoscaleError(exc.code, error_body) from exc
    except urllib.error.URLError as exc:
        raise AWXAutoscaleError(0, f"network error: {exc.reason}") from exc


def get_instance_group_pod_spec(
    *,
    api_url: str,
    api_token: str,
    name: str,
    ssl_verify: bool = True,
) -> str | None:
    """Look up an AWX Container Group's pod_spec_override by name.

    Returns the raw pod_spec_override string, or None if no group with that
    name exists or it carries no override. Kept here (rather than in
    capacity.py) so the L3 capacity preflight's ee_reserve reader stays
    http-free — capacity.py has no k8s client and no direct HTTP calls,
    only prometheus.query() and this wrapper (umbrella #202 WP1).
    """
    ctx = _ssl_context(ssl_verify)
    result = _request(
        api_url, api_token, "GET",
        f"/api/v2/instance_groups/?name={urllib.parse.quote(name)}",
        ssl_context=ctx,
    )
    results = result.get("results", [])
    if not results:
        return None
    return results[0].get("pod_spec_override") or None


def list_recent_jobs(
    *, api_url: str, api_token: str, page_size: int = 20, ssl_verify: bool = True
) -> list[dict]:
    """Fetch the most recent workflow/job runs from AWX.

    Returns raw AWX job objects from /api/v2/jobs/ ordered by most recent.
    Fields used downstream: id, name, status, started, finished, elapsed, failed
    """
    ctx = _ssl_context(ssl_verify)
    result = _request(
        api_url, api_token, "GET",
        f"/api/v2/jobs/?order_by=-started&page_size={page_size}",
        ssl_context=ctx,
    )
    return result.get("results", [])
