"""AWX API client — job template launch and status polling."""

from __future__ import annotations

import http.client
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


class AWXTransportError(AWXAPIError):
    """A request never produced a usable AWX response body (#295).

    Normalized at the ``_request`` boundary so retry policy has exactly ONE
    thing to classify instead of three shapes leaking out of urllib:

    * ``read`` — the connection dropped DURING ``resp.read()``. urllib has
      already handed back a 200-status response object at that point, so
      neither ``HTTPError`` nor ``URLError`` is raised: a bare
      ``ConnectionResetError``/``IncompleteRead`` escaped the client
      untouched and no caller classified it as retryable.
    * ``empty`` — a 2xx with a zero-length body. Every endpoint ``_request``
      serves has a JSON success contract, so an empty body is a failed
      response, NOT the empty dict it used to decode to. That silent ``{}``
      is what turned a lost lookup response into an authoritative
      "job template not found" and a lost launch response into job id 0.
    * ``decode`` — a 2xx whose body is not JSON (a proxy error page, a
      truncated write).
    * ``schema`` — valid JSON that is not a JSON object.

    Subclasses ``AWXAPIError`` with a synthetic 502 deliberately: every
    caller that already sanitizes ``AWXAPIError`` into a structured console
    response or an operation ERROR state then covers these too, instead of
    a raw reset escaping to a generic HTTP 500 (or, worse, being silently
    absorbed as an empty result). 502 also reads correctly to
    ``is_transient_awx_failure``: bad gateway, no authoritative answer.
    """

    def __init__(self, message: str, *, phase: str) -> None:
        self.phase = phase
        super().__init__(502, f"AWX transport error ({phase}): {message}")


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


DEFAULT_REQUEST_TIMEOUT = 30.0


def _request(
    api_url: str,
    api_token: str,
    method: str,
    path: str,
    body: dict | None = None,
    ssl_context: ssl.SSLContext | None = None,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> dict:
    """Make an authenticated JSON request to the AWX API.

    Every endpoint routed through here has a JSON-object success contract
    (the plain-text job-stdout endpoint goes through ``_request_text``
    instead). So the body is not merely decoded opportunistically: a
    read-time drop, an empty body, undecodable bytes, or a non-object
    payload are all failures, normalized into ``AWXTransportError`` for the
    retry policy to classify (#295). The previous
    ``json.loads(raw) if raw else {}`` turned every one of those into a
    successful-looking ``{}``.

    ``timeout`` is per-call so a deadline-bounded caller
    (``call_with_readiness_retry``) can derive it from its remaining budget
    rather than letting one hung socket eat the whole window.
    """
    url = api_url.rstrip("/") + path
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as resp:
            # NB: urllib only raises HTTPError/URLError from urlopen itself.
            # Once we are inside the `with`, a dropped connection surfaces as
            # a bare OSError (ConnectionResetError) or http.client
            # IncompleteRead out of read() — neither is a URLError.
            try:
                raw = resp.read()
            except (OSError, http.client.HTTPException) as exc:
                raise AWXTransportError(f"{method} {path}: {exc}", phase="read") from exc
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode() if exc.fp else str(exc)
        raise AWXAPIError(exc.code, error_body) from exc

    if not raw:
        raise AWXTransportError(f"{method} {path}: empty response body", phase="empty")
    try:
        decoded = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise AWXTransportError(f"{method} {path}: {exc}", phase="decode") from exc
    if not isinstance(decoded, dict):
        raise AWXTransportError(
            f"{method} {path}: expected a JSON object, got {type(decoded).__name__}",
            phase="schema",
        )
    return decoded


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


# ---------------------------------------------------------------------------
# Post-wake readiness retry (#295)
# ---------------------------------------------------------------------------
#
# This REPLACES call_with_transient_retry (#134) rather than sitting beside
# it. That helper was the empirically-insufficient policy below, it had no
# remaining production call site once the launch POSTs stopped being blindly
# retried, and leaving a retry primitive exported that is unsafe on a
# non-idempotent call is precisely how the duplicate-job risk would come
# back.
#
# What actually failed, live against AWX 24.6.1: a catalog deploy dispatched
# right after the autoscale helper reported AWX awake hit a bare Django 500
# on the FIRST authenticated call — lookup_job_template_by_name — roughly 13
# SECONDS after dispatch. That call was already wrapped in retry. The old
# policy was 3 attempts at a fixed 3s delay: two sleeps, ~6s of scheduled
# backoff against immediate 5xx responses. It expired while AWX's ORM/RBAC
# stack was still warming, and it was bounded by attempt COUNT rather than by
# any deliberate readiness-lag budget.
#
# The helper-side gate (dmf-infra#61) is best-effort BY CONSTRUCTION: it
# probes with the awx-svc identity, not the console's dmf-cms-svc, and not
# the console's exact ?name= path. This deadline is the definitive
# race-closer, so it is sized to outlast the observed lag by a wide margin
# — and it is applied ONLY to idempotent reads (see call_with_readiness_retry).
POST_WAKE_READ_DEADLINE = 120.0
POST_WAKE_INITIAL_DELAY = 1.0
POST_WAKE_MAX_DELAY = 10.0
POST_WAKE_MIN_CALL_TIMEOUT = 5.0


def is_transient_awx_failure(exc: BaseException) -> bool:
    """Classify an AWX failure as safe to retry for an IDEMPOTENT call.

    Transient — the request did not produce an authoritative answer:
      * ``AWXTransportError`` (read-time reset, empty body, undecodable
        body, non-object payload — see that class);
      * ``AWXAPIError`` with a 5xx status, including a bare Django 500 with
        an empty body, which is the exact #295 signature;
      * ``urllib.error.URLError`` — connect/DNS/TLS/timeout before a
        response existed.

    NOT transient — AWX answered authoritatively and retrying only repeats
    the same answer: any 4xx, so auth failures, RBAC refusals, and
    not-found stay hard errors.
    """
    if isinstance(exc, AWXTransportError):
        return True
    if isinstance(exc, AWXAPIError):
        return exc.status >= 500
    # HTTPError is a URLError subclass — check it first. _request normalizes
    # it to AWXAPIError, so this only guards a caller that passes one through.
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500
    return isinstance(exc, urllib.error.URLError)


_RETRYABLE = (AWXAPIError, AWXTransportError, urllib.error.URLError)


def call_with_readiness_retry(
    fn,
    *,
    deadline_seconds: float | None = None,
    initial_delay: float | None = None,
    max_delay: float | None = None,
    min_call_timeout: float | None = None,
    sleep=None,
    monotonic=None,
):
    """Retry an IDEMPOTENT AWX read until a wall-clock deadline (#295).

    ONLY for safe reads. ``fn`` is re-sent whenever the previous attempt
    failed transiently, so a non-idempotent call (a launch POST) must never
    be passed here: a reset arriving AFTER AWX accepted the job would make
    this create a duplicate. See ``launch_job``'s own docstring.

    ``fn`` is called as ``fn(timeout=<per-call timeout>)``; bind everything
    else with ``functools.partial``. The per-call timeout is derived from
    the remaining budget (floored at ``min_call_timeout``) so a single hung
    socket cannot consume the whole window — the practical overshoot is
    bounded by one ``min_call_timeout``, since a final attempt started just
    inside the deadline is always allowed to finish.

    Backoff is exponential from ``initial_delay``, capped at ``max_delay``,
    and further capped by the time actually left. Bounded by elapsed time,
    not attempt count: that is the whole point — the attempt-count policy
    this replaces expired ~6s into a ~13s readiness lag.

    Raises the last exception once the deadline passes, or immediately for
    any non-transient failure (see ``is_transient_awx_failure``).

    The four bounds default to None and resolve against the module
    constants at CALL time, not at def time — so the constants are a real
    knob (patchable in a test, adjustable in one place operationally)
    rather than values frozen into this signature at import.
    """
    deadline_seconds = POST_WAKE_READ_DEADLINE if deadline_seconds is None else deadline_seconds
    initial_delay = POST_WAKE_INITIAL_DELAY if initial_delay is None else initial_delay
    max_delay = POST_WAKE_MAX_DELAY if max_delay is None else max_delay
    min_call_timeout = POST_WAKE_MIN_CALL_TIMEOUT if min_call_timeout is None else min_call_timeout
    sleep = time.sleep if sleep is None else sleep
    monotonic = time.monotonic if monotonic is None else monotonic

    deadline = monotonic() + deadline_seconds
    delay = initial_delay

    while True:
        remaining = deadline - monotonic()
        call_timeout = max(min_call_timeout, min(DEFAULT_REQUEST_TIMEOUT, remaining))
        try:
            return fn(timeout=call_timeout)
        except _RETRYABLE as exc:
            if not is_transient_awx_failure(exc):
                raise
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise
            sleep(min(delay, max_delay, remaining))
            delay = min(delay * 2, max_delay)


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


def _collection_results(result: dict, *, path: str) -> list:
    """Return the ``results`` list of an AWX paginated collection.

    A response that does not carry a ``results`` list is not an empty
    collection — it is a malformed response, and reporting it as "nothing
    found" is exactly how a lost body became an authoritative
    "job template not found" (#295). ``_request`` already rejects empty and
    non-object bodies; this rejects the object-shaped-but-wrong ones.
    """
    results = result.get("results")
    if not isinstance(results, list):
        raise AWXTransportError(
            f"{path}: response has no 'results' list (got {type(results).__name__})",
            phase="schema",
        )
    return results


def lookup_job_template_by_name(
    *,
    api_url: str,
    api_token: str,
    name: str,
    ssl_verify: bool = True,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> dict | None:
    """Find a job template by its name, or None if AWX says there is none.

    ``None`` means AWX answered authoritatively with an empty collection.
    A malformed/lost response raises instead (see ``_collection_results``)
    so a post-wake blip can never be reported as a missing template — this
    is the exact call that failed in #295, and it is the one the
    post-wake ``call_with_readiness_retry`` guards.
    """
    ctx = _ssl_context(ssl_verify)
    path = f"/api/v2/job_templates/?name={urllib.parse.quote(name)}"
    result = _request(api_url, api_token, "GET", path, ssl_context=ctx, timeout=timeout)
    results = _collection_results(result, path=path)
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

    NOT IDEMPOTENT — never wrap this in ``call_with_readiness_retry`` or any
    other blind retry (#295). AWX creates the job when it accepts the POST;
    if the response is then lost to a reset or a proxy 5xx, the job exists
    and a resend creates a SECOND one, with real duplicate infrastructure
    side effects. A caller that wants to survive an ambiguous launch must
    reconcile through ``find_active_job_for_template`` before resending —
    it must not simply repeat the POST.

    A missing/invalid job id in the response is raised, not returned as 0:
    a lost launch response is an ambiguous commit, not "job 0".
    """
    ctx = _ssl_context(ssl_verify)
    body = {"extra_vars": extra_vars} if extra_vars else {}
    path = f"/api/v2/job_templates/{job_template_id}/launch/"
    result = _request(api_url, api_token, "POST", path, body=body, ssl_context=ctx)
    # AWX returns the job id in the 'job' key for launch responses
    job_id = result.get("job", result.get("id"))
    if isinstance(job_id, bool) or not isinstance(job_id, (int, str)):
        raise AWXTransportError(
            f"{path}: launch response carries no job id (got {type(job_id).__name__})",
            phase="schema",
        )
    try:
        job_id = int(job_id)
    except ValueError as exc:
        raise AWXTransportError(f"{path}: non-numeric job id {job_id!r}", phase="schema") from exc
    if job_id <= 0:
        raise AWXTransportError(f"{path}: launch returned job id {job_id}", phase="schema")
    return job_id


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

    A malformed response raises rather than reading as "no active job":
    this is the reconciliation query that decides whether a launch is safe
    to send, so a lost body must never be mistaken for an authoritative
    "nothing in flight" (#295).
    """
    ctx = _ssl_context(ssl_verify)
    path = (
        f"/api/v2/jobs/?job_template={int(job_template_id)}"
        "&status__in=new,pending,waiting,running&order_by=-id&page_size=1"
    )
    result = _request(api_url, api_token, "GET", path, ssl_context=ctx)
    results = _collection_results(result, path=path)
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
    """Fetch a job's stdout as plain text.

    umbrella #202 WP3 R2b: NO LONGER used to parse the outcome marker —
    that moved to job events, anchored by task name
    (``get_job_events_for_task`` + ``_fetch_l3_outcome_from_events`` in
    main.py). Kept as a standalone, still-bounded utility for a possible
    future report-display use (showing a job's raw log in the console UI),
    not currently called by any outcome-classification path.

    Only the last ``_STDOUT_TAIL_BYTES`` (== ``_request_text``'s own
    ``_TEXT_TAIL_BYTES``) ever reach the caller — callers must never see
    (or forward into an API response) more of a job's raw log than that
    fixed bound. codex R3-6: the bound is enforced by ``_request_text``
    streaming the read itself, not by slicing an already-fully-fetched
    string here.
    """
    ctx = _ssl_context(ssl_verify)
    return _request_text(
        api_url, api_token, "GET",
        f"/api/v2/jobs/{job_id}/stdout/?format=txt",
        ssl_context=ctx,
    )


# Defensive hard cap on job_events pagination — a single named task should
# never emit more than a handful of events in practice (the L3 launcher's
# own dmf-l3-outcome task runs exactly once per play); this is a backstop
# against a misbehaving/looping 'next' chain, not a real limit the wire
# contract expects to hit.
_JOB_EVENTS_MAX_PAGES = 10


def get_job_events_for_task(
    *,
    api_url: str,
    api_token: str,
    job_id: int,
    task_name: str,
    ssl_verify: bool = True,
) -> list[dict]:
    """Fetch every job event for one specific task name (umbrella #202 WP3
    R2b — the outcome marker transport moved OFF stdout onto AWX job
    events, anchored to task name, per codex P1-2: stdout always ends
    with ansible's own PLAY RECAP epilogue after the launcher's last debug
    line, which made a stdout-tail contract unreliable; job events bound
    to a specific, dedicated task NAME are structural, not textual).

    GET /api/v2/jobs/{id}/job_events/?task=<task_name>&order_by=counter,
    paginated via AWX's own ``next`` field — passed straight back into the
    next request rather than reconstructed from a page number, since AWX's
    filter/ordering query string rides along with it. Hard-capped at
    ``_JOB_EVENTS_MAX_PAGES`` pages (defensive only — see the module-level
    comment above).
    """
    ctx = _ssl_context(ssl_verify)
    events: list[dict] = []
    path = (
        f"/api/v2/jobs/{job_id}/job_events/"
        f"?task={urllib.parse.quote(task_name)}&order_by=counter"
    )
    for _ in range(_JOB_EVENTS_MAX_PAGES):
        result = _request(api_url, api_token, "GET", path, ssl_context=ctx)
        events.extend(result.get("results", []))
        next_path = result.get("next")
        if not next_path:
            break
        # AWX may return 'next' as either a bare path or a full URL
        # depending on deployment config — normalize to path+query so
        # _request's own api_url-prefixing never double-prepends the host.
        if next_path.startswith("http://") or next_path.startswith("https://"):
            parsed = urllib.parse.urlparse(next_path)
            next_path = parsed.path + (("?" + parsed.query) if parsed.query else "")
        path = next_path
    return events


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
