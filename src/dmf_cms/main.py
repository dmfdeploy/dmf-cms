"""dmf-cms backend (FastAPI) — the DMF Console.

## L3 outcome marker contract (umbrella #202 WP2 §4.6, transport revised WP3 R2b)

A launcher play that wants to hand the console a structured run outcome
runs a SINGLE, dedicated task literally named ``dmf-l3-outcome``
(``ansible.builtin.debug``) whose message is:

    DMF_L3_OUTCOME: <token> [<space-separated key=value detail>]

R2b (codex round-1 P1-2 disposition): the marker is fetched via AWX JOB
EVENTS, anchored by that task NAME — ``GET
/api/v2/jobs/{id}/job_events/?task=dmf-l3-outcome`` — never by scraping
job stdout. This replaces the WP3-D stdout-tail amendment entirely: a
stdout-based contract (even "last matching line in the tail") is still
bound to TEXT position, which is fundamentally unreliable once a real
ansible job is involved (ansible's own PLAY RECAP epilogue, and any other
task's own debug/log output, all land in the same undifferentiated
stream). Anchoring to a specific, dedicated task's NAME is STRUCTURAL, not
textual — an identically-formatted marker STRING emitted by some other,
differently-named task must NOT be picked up (see
``_fetch_l3_outcome_from_events``'s own docstring and the test suite's
wrong-task-name anchor case). The marker is still provenance (§3.1), never
authority — the console uses it for classification/surfacing only, the
job's own AWX status remains authoritative for pass/fail.

``<token>`` is one of: ``facility-busy``, ``lock-unavailable``,
``preflight-error``, ``no-snapshot``, ``stale-snapshot``,
``rollback_incomplete``, ``no-fit``, ``missing-budget``,
``post-mutation-failed`` — or any other token matching ``[a-z0-9_-]+``;
unknown tokens are stored verbatim on the operation's ``l3_outcome`` field,
forward-compatible with launcher changes that ship ahead of the console's
token list (never refuse to record an outcome just because the console
doesn't recognize it yet). ``rollback_complete`` is a KNOWN token in this
list's history but is structurally UNREACHABLE from the WP3 launcher tier
(umbrella #202 R2a-7 — monitoring drain is unverifiable from that EE, so
every WP3 rollback reports ``rollback_incomplete``); WP4's console-side
verification is the only tier that can ever emit it. The optional detail
after the token is a space-separated ``key=value`` list; see
``_sanitize_kv`` — only ``surfaces`` (comma-joined subset of
``netbox``/``helm``/``monitoring``), ``request_id``/``run_id`` (both: bare
32-char lowercase hex), and ``detail`` (R3b, widened R5b — a CLOSED ENUM,
``_KV_DETAIL_TOKENS`` — of the launcher's own refusal-reason strings)
survive into the operation's ``error`` field, each with its OWN strict
per-key value rule — there is still NO generic FREE-TEXT key (codex R3-7
killed a prior draft's free-text ``detail`` key: no dots, colons, or
slashes may ever ride into a public API response this way; R3b's
``detail`` is enum-constrained, a different thing entirely — see
``_KV_DETAIL_TOKENS``, not a relaxation of the R3-7 posture).

R5b (umbrella #202 WP3 R5b, codex round-4 P2-2): the ``snapshot`` kv key
(and its own closed enum, formerly ``_KV_SNAPSHOT_TOKENS = {"skipped"}``)
is REMOVED entirely, not merely emptied. It existed for exactly one
signal — the direct-path lock-unavailable-override's advertised
``snapshot=skipped`` marker — which R4a (codex round-3 P1-9) confirmed had
NEVER actually shipped as a real emission anywhere in dmf-runbooks (only
mentioned in that repo's own comments) before removing the lockless
override path itself entirely; there is now no code path in dmf-runbooks
that could ever emit a ``snapshot=`` kv, and there never genuinely was.
Keeping a permanently-unmatchable enum/key around invites exactly the
kind of "the docs describe a feature that doesn't exist" drift this whole
contract exists to prevent — deleted outright rather than left as dead,
misleading machinery.

``facility-busy``, ``lock-unavailable``, ``preflight-error``, ``no-fit``,
``missing-budget``, ``no-snapshot``, and ``stale-snapshot`` are
PRE-MUTATION tokens (``_PRE_MUTATION_TOKENS``, codex R2-3, extended R2b
for the two launcher-side R2a additions): the launcher refused before
mutating anything, so a started-then-failed deploy carrying one of these
never triggers FAILED_ROLLBACK_REQUIRED/auto-rollback — see
``_watch_job_operation``. ``post-mutation-failed`` (launcher R2a's
launch_rescue.yml) is DELIBERATELY NOT a pre-mutation token — it fires
only from a rescue path AFTER the run's own provision stage began
mutating something, so a deploy carrying it correctly DOES auto-trigger
rollback, unlike the pre-mutation refusals above it.

A rollback op's own pass/fail is marker-authoritative, never a bare AWX
job-status read (codex R2-1, "never false-green"): RUN_COMPLETE requires
BOTH a successful job status AND an exact ``rollback_complete`` marker —
which, per the structural-unreachability note above, means a WP3 rollback
can never itself produce RUN_COMPLETE this way (expected; WP4 is the tier
that eventually will). Every other combination — job failed, marker
missing, marker says ``rollback_incomplete``, marker is some other token,
or the job-events fetch itself failed — lands on
``OperationState.ROLLBACK_INCOMPLETE``, a DIRTY terminal state that keeps
blocking new dispatches elsewhere on the facility
(``_facility_busy_check``) until an operator/retry resolves it.
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import re
import time
import urllib.error
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from .authentik import (
    AuthentikAPIError,
    add_user_to_group,
    create_invitation,
    ensure_group,
    list_groups,
    list_users,
)
from .awx import AWXAPIError, AWXAutoscaleError, AWXJobInfo, list_job_templates, launch_job, get_job, get_job_status, get_job_events_for_task, wait_for_job, lookup_job_template_by_name, list_recent_jobs, find_active_job_for_template, ensure_awx_awake, call_with_transient_retry
from .catalog import CatalogEntry, load_catalog_entries, get_lifecycle_status
from .contracts import AppContract, load_app_contract
from .operations import Operation, OperationStore, OperationState, terminal_states, DIRTY_STATES
from . import netbox, prometheus, forgejo, mxl, media_workloads, capacity
from starlette.concurrency import run_in_threadpool
import asyncio
from .security import (
    MEDIA_ENGINEERS_GROUP,
    ROLE_GROUPS,
    ROLE_ORDER,
    UserIdentity,
    VIEW_AS_ROLES,
    build_authorize_url,
    build_end_session_url,
    clear_user,
    discovery_document,
    dev_user,
    effective_user,
    exchange_code_for_token,
    fetch_userinfo,
    new_pkce_verifier,
    new_state,
    pkce_challenge,
    role_at_least,
    session_user,
    store_user,
    user_from_claims,
)
from .settings import Settings, load_settings

logger = logging.getLogger(__name__)


# Below-warning alert severities floored out of the Workspace "Current
# problems" core (Constitution Art. 4 / Alarm Philosophy sub-warning tiers).
# Blank/unknown severities are deliberately NOT listed here — they stay
# visible (fail-safe). Info/advisory/notice surface only on the expert
# Monitoring lane (/api/monitoring/alerts, unfiltered).
_BELOW_WARNING_SEVERITIES = frozenset({"info", "advisory", "notice"})

# Platform-seeded sealed emergency admin(s). Membership here flags a user as a
# break-glass identity in the admin Users surface — a sanctioned exception, not
# a routine role (ADR-0028 C4: no routine operation may require break-glass).
# akadmin is the Authentik-seeded superuser we keep sealed for emergencies.
BREAK_GLASS_USERNAMES = {"akadmin"}

# Platform-seeded break-glass group (dmf-infra k3s-lab-bootstrap authentik
# role: authentik_breakglass_username defaults to a member of this group, e.g.
# "break-glass"). Membership here is an independent, group-based signal from
# BREAK_GLASS_USERNAMES — the seeded rescue admin need not be named "akadmin".
BREAK_GLASS_GROUP = "break-glass"

# Authentik user "type" values classed as human identities (ADR-0028 C4/D8:
# human/machine split is a first-class distinction). The machine side
# (service_account, internal_service_account) is derived by exclusion so that
# an unknown/novel type fails safe to machine — see _user_type below.
_HUMAN_USER_TYPES = {"internal", "external"}

# Workload-tag slug (#239 trio: dmf-cms + dmf-runbooks + dmf-infra). k8s-label-ish,
# max 40 chars — fixed across all three PRs, do not rename or relax.
WORKLOAD_SLUG_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")

PACKAGE_ROOT = Path(__file__).resolve().parent


def _base_path_url(path: str, settings: Settings) -> str:
    """Prefix a local path with ``settings.base_path``; leave absolute URLs untouched."""
    if path.startswith(("http://", "https://", "//")):
        return path
    bp = settings.base_path.rstrip("/")
    if not bp or bp == "/":
        return path
    return bp + path


class BasePathMiddleware:
    def __init__(self, app: Any, base_path: str) -> None:
        self.app = app
        self.base_path = base_path.rstrip("/")

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not self.base_path:
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path == self.base_path:
            rewritten = "/"
        elif path.startswith(self.base_path + "/"):
            rewritten = path[len(self.base_path) :]
        else:
            await self.app(scope, receive, send)
            return

        rewritten_scope = dict(scope)
        rewritten_scope["root_path"] = self.base_path
        rewritten_scope["path"] = rewritten
        await self.app(rewritten_scope, receive, send)


def _require_user(request: Request) -> bool:
    return session_user(request.session) is not None


def _require_min_role(request: Request, minimum: str) -> tuple[UserIdentity | None, JSONResponse | None]:
    """Backend role gate (roles are capability; tenancy is a separate axis).

    Returns ``(user, None)`` when authorized, else ``(None, error_response)``.
    Nav visibility is cosmetic — every gated endpoint must call this.

    Gates on the *effective* role so an admin's active view-as downgrade is
    enforced server-side (dmfdeploy/dmfdeploy#185 WP-B), not merely reflected
    in the nav.
    """
    user = effective_user(request.session)
    if user is None:
        return None, JSONResponse({"error": "unauthorized"}, status_code=401)
    if not role_at_least(user.role, minimum):
        return None, JSONResponse({"error": "forbidden"}, status_code=403)
    return user, None


def _require_media_workloads_access(request: Request) -> tuple[UserIdentity | None, JSONResponse | None]:
    """Media Workloads surface gate (ADR-0037 §5, dmfdeploy/dmfdeploy#174).

    Granted by the engineer capability role (the #173 v1 gate, kept as the
    single-operator fallback) OR membership of the media-engineers group.
    The group scopes the surface — both read and the clear write — while
    tenant visibility within it stays with MediaTenancySettings.

    Gates on the *effective* role (view-as downgrade enforced). Groups are the
    real groups even under view-as: a real viewer in media-engineers reaches
    the surface, and so does an admin viewing-as-viewer who is also in that
    group — correct by design (dmfdeploy/dmfdeploy#185 WP-B, Risk 3).
    """
    user = effective_user(request.session)
    if user is None:
        return None, JSONResponse({"error": "unauthorized"}, status_code=401)
    if not role_at_least(user.role, "engineer") and MEDIA_ENGINEERS_GROUP not in user.groups:
        return None, JSONResponse({"error": "forbidden"}, status_code=403)
    return user, None


async def _require_reason(request: Request) -> tuple[str | None, JSONResponse | None]:
    """Extract + validate the mandatory C5 ``reason`` from a write request body.

    Returns ``(reason, None)`` (reason stripped, guaranteed non-empty) when
    present, else ``(None, error_response)`` — a 400 that must short-circuit the
    handler *before* any actuator call (no AWX launch on a missing reason).
    Mirrors the clear-for-deployment precondition (ADR-0028 C5).

    A non-object JSON body (a bare list/string/number) is treated the same as
    a missing body — ``.get`` only makes sense on a dict, and any other JSON
    top-level shape has no ``reason`` field to find — so it falls straight
    into the existing "reason-required" 400, not an unhandled AttributeError.
    Every caller of this shared helper (deploy, teardown, launch, and via
    ``_extract_workload``) gets this for free.
    """
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict):
        body = None
    reason = (body or {}).get("reason", "")
    if not isinstance(reason, str) or not reason.strip():
        return None, JSONResponse(
            {"error": "reason-required", "detail": "a non-empty 'reason' field is mandatory (C5)"},
            status_code=400,
        )
    return reason.strip(), None


async def _extract_workload(request: Request, request_id: str) -> tuple[str | None, JSONResponse | None]:
    """Extract + validate the optional #239 ``workload`` slug from a request body.

    Returns ``(None, None)`` when the operator supplied no workload — an
    absent key, JSON ``null``, or ``""`` are all "legitimately omitted" (the
    common case — deploy stays bit-compatible with pre-#239 behavior). Any
    OTHER non-string value (a number, boolean, array, or object — including
    falsy ones like ``0``, ``false``, ``[]``) is a malformed request, not an
    omission: it returns ``(None, error)``, a 400 that must short-circuit the
    handler before any AWX call. Same for a string that doesn't fullmatch the
    slug rule. A non-object JSON body (list/string/number) is treated as no
    body at all, same as ``_require_reason``.

    ``fullmatch`` (not ``match``) is deliberate: with ``match``, Python's
    trailing ``$`` anchor matches immediately before a final newline, so
    "studio-a\\n" would pass validation, reach AWX extra_vars verbatim, and
    inject a newline into the audit log line (log-splitting surface).
    ``fullmatch`` requires the entire string to be consumed, so any trailing
    newline (or CRLF) correctly fails.

    Body is re-read via ``request.json()``, which Starlette caches, so this
    is safe to call after ``_require_reason`` already parsed the same body.
    """
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict):
        body = None
    workload = body.get("workload") if body is not None else None
    if workload is None or workload == "":
        return None, None
    if not isinstance(workload, str) or not WORKLOAD_SLUG_RE.fullmatch(workload):
        return None, JSONResponse(
            {"error": "invalid workload slug", "request_id": request_id},
            status_code=400,
        )
    return workload, None


async def _extract_l3_override(request: Request, request_id: str) -> tuple[bool, JSONResponse | None]:
    """Extract + strictly validate the optional L3 override flag (#202 WP1 R2-5, plan §3.3).

    Mirrors ``_require_reason``/``_extract_workload``'s body-read pattern —
    Starlette caches the raw request body, so re-parsing here (after those
    helpers already ran) is safe and cheap, not a second stream read.

    Coercion is deliberately narrow: an absent key or JSON ``false`` both
    mean "not overriding" (legitimate omission-equivalents, same as
    ``_extract_workload``'s null/""/absent trio) — returns ``(False,
    None)``. JSON ``true`` means override — returns ``(True, None)``. ANY
    other value (the string ``"false"``, ``1``, ``[]``, ``"yes"``, ...) is a
    malformed request, not a silent coercion: a client mistakenly sending a
    truthy-looking non-bool must never accidentally slip an over-budget
    launch past capacity refusal. Returns ``(False, response)`` — a 400
    ``invalid-l3-override`` — for that case.
    """
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict) or "l3_override" not in body:
        return False, None
    value = body["l3_override"]
    if value is True:
        return True, None
    if value is False:
        return False, None
    return False, JSONResponse(
        {"error": "invalid-l3-override", "request_id": request_id}, status_code=400,
    )


def _capacity_audit_summary(
    result: "capacity.PreflightResult | None" = None, *, refusal_kind: str | None = None
) -> str:
    """Compact budget-numbers string for the C5 audit line's ``capacity`` field."""
    if result is not None:
        return (
            f"verdict={result.verdict} "
            f"cpu={result.total_cpu_m}m/{result.headroom_cpu_m}m "
            f"mem={result.total_mem_b}B/{result.headroom_mem_b}B"
        )
    if refusal_kind:
        return f"kind={refusal_kind}"
    return ""


async def _l3_preflight(
    request: Request,
    user: UserIdentity,
    *,
    settings: Settings,
    entry: CatalogEntry,
    key: str,
    request_id: str,
    reason: str,
) -> tuple[dict | None, JSONResponse | None]:
    """L3 console capacity preflight gate (umbrella #202 WP1, plan §3.1-§3.4).

    The early operator-facing gate — the launcher tier (WP3) recomputes
    in-cluster and stays authoritative; this tier's unique job is refusing
    BEFORE any AWX side effect, including before the AWX EE job pod itself
    would be scheduled (the console reserves it, §3.2 table).

    Fail-open vs fail-closed posture (codex R2-1, load-bearing — do not
    conflate the two conditions below):

    * ``settings.l3.enabled is False`` is THE one documented kill switch —
      an explicit, operator-chosen "this tier does not run here". Skips
      with an audited ``capacity-skipped`` outcome (so a disabled tier is
      still visible in the C5 trail, not silently invisible) and an
      envelope carrying ``l3_preflight_verdict: 'skipped'``.
    * ``l3.enabled`` is True but ``settings.prometheus.configured`` is
      False is a MISCONFIGURATION, not an opt-out — the console tier's
      supply numbers have exactly one seam (``prometheus.query()``, §3.2),
      so "enabled but no way to read supply" can never silently pass. This
      refuses with a 409 ``kind='budget-unavailable'``, exactly like a live
      Prometheus read returning no data — same failure mode, same handling.

    Returns ``(envelope, None)`` to proceed. ``envelope`` carries
    ``l3_request_id``/``l3_preflight_verdict`` always, plus
    ``l3_override``/``l3_override_reason`` when the operator overrode a
    refusal — these four keys are the WP3 launcher contract, never rename.
    Returns ``(None, response)`` — a 409 ``capacity-preflight-refused`` (or a
    400 ``invalid-l3-override`` for a malformed override flag) — to refuse.
    Never returns a refusal when overriding (that's the point of an
    override): any budget error while overriding is folded into the audit
    summary and the run proceeds anyway.
    """
    if not settings.l3.enabled:
        _audit_awx_write(
            request, user, action="deploy", target=key, request_id=request_id, reason=reason,
            outcome="capacity-skipped",
        )
        return {"l3_request_id": request_id, "l3_preflight_verdict": "skipped"}, None

    if not settings.prometheus.configured:
        _audit_awx_write(
            request, user, action="deploy", target=key, request_id=request_id, reason=reason,
            outcome="capacity-denied", capacity=_capacity_audit_summary(refusal_kind="budget-unavailable"),
        )
        return None, JSONResponse(
            {"error": "capacity-preflight-refused", "kind": "budget-unavailable", "request_id": request_id},
            status_code=409,
        )

    override, override_err = await _extract_l3_override(request, request_id)
    if override_err is not None:
        _audit_awx_write(
            request, user, action="deploy", target=key, request_id=request_id, reason=reason,
            outcome="invalid-override",
        )
        return None, override_err

    demand, demand_reason = capacity.read_entry_demand(entry.provision)

    if override:
        result = None
        refusal_kind = demand_reason
        if demand is not None:
            # R3-6: these are blocking urllib/HTTP reads — never call them
            # directly on the event loop from this async handler.
            ee_reserve = await run_in_threadpool(
                capacity.read_ee_reserve,
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                ssl_verify=settings.awx.ssl_verify,
                floor_cpu_m=settings.l3.ee_floor_cpu_millicores,
                floor_mem_b=settings.l3.ee_floor_memory_mib * 1024 * 1024,
            )
            supply = await run_in_threadpool(capacity.read_node_supply, prom_url=settings.prometheus.url)
            if isinstance(supply, capacity.NodeSupply):
                cpu_m, mem_b = demand
                result = capacity.evaluate_preflight(
                    demand_items=[(key, cpu_m, mem_b)],
                    ee_reserve=ee_reserve,
                    supply=supply,
                )
                refusal_kind = None
            else:
                refusal_kind = supply
        _audit_awx_write(
            request, user, action="deploy", target=key, request_id=request_id, reason=reason,
            outcome="capacity-override",
            capacity=_capacity_audit_summary(result, refusal_kind=refusal_kind),
        )
        return {
            "l3_request_id": request_id,
            "l3_preflight_verdict": "override",
            "l3_override": True,
            "l3_override_reason": reason,
        }, None

    if demand is None:
        kind = "invalid-budget" if demand_reason.startswith("invalid-budget") else demand_reason
        _audit_awx_write(
            request, user, action="deploy", target=key, request_id=request_id, reason=reason,
            outcome="capacity-denied", capacity=_capacity_audit_summary(refusal_kind=demand_reason),
        )
        return None, JSONResponse(
            {
                "error": "capacity-preflight-refused",
                "kind": kind,
                "detail": demand_reason,
                "request_id": request_id,
            },
            status_code=409,
        )
    cpu_m, mem_b = demand

    # R3-6: blocking urllib/HTTP reads — offload to the threadpool so the
    # event loop isn't blocked for the duration of the AWX/Prometheus calls.
    ee_reserve = await run_in_threadpool(
        capacity.read_ee_reserve,
        api_url=settings.awx.api_url,
        api_token=settings.awx.api_token,
        ssl_verify=settings.awx.ssl_verify,
        floor_cpu_m=settings.l3.ee_floor_cpu_millicores,
        floor_mem_b=settings.l3.ee_floor_memory_mib * 1024 * 1024,
    )

    supply = await run_in_threadpool(capacity.read_node_supply, prom_url=settings.prometheus.url)
    if not isinstance(supply, capacity.NodeSupply):
        # Fail-closed: no supply data is never treated as fit.
        _audit_awx_write(
            request, user, action="deploy", target=key, request_id=request_id, reason=reason,
            outcome="capacity-denied", capacity=_capacity_audit_summary(refusal_kind=supply),
        )
        return None, JSONResponse(
            {"error": "capacity-preflight-refused", "kind": supply, "request_id": request_id},
            status_code=409,
        )

    result = capacity.evaluate_preflight(
        demand_items=[(key, cpu_m, mem_b)], ee_reserve=ee_reserve, supply=supply,
    )

    if result.verdict == "no-fit":
        _audit_awx_write(
            request, user, action="deploy", target=key, request_id=request_id, reason=reason,
            outcome="capacity-denied", capacity=_capacity_audit_summary(result),
        )
        return None, JSONResponse(
            {
                "error": "capacity-preflight-refused",
                "kind": "no-fit",
                "report": result.report,
                "text": result.text,
                "request_id": request_id,
            },
            status_code=409,
        )

    return {"l3_request_id": request_id, "l3_preflight_verdict": "fit"}, None


def _build_launch_extra_vars(workload: str | None, envelope: dict | None) -> dict | None:
    """Merge the #239 workload_slug and the #202 L3 envelope into one extra_vars dict.

    Mirrors the pre-existing ``{"workload_slug": workload} if workload else
    None`` contract: an empty result stays ``None`` (bit-compatible with
    pre-#239 launches when L3 itself is disabled), not an empty dict.

    The envelope merges in ALWAYS, including a ``skipped`` verdict —
    ``l3.enabled=False`` is the ONLY condition that produces ``skipped``
    (R2-1/R3-5: an unconfigured Prometheus with L3 enabled is a
    fail-closed REFUSAL, never a skip). Every catalog JT already has
    ``ask_variables_on_launch`` (#239), so an unreferenced var is a no-op
    for playbooks that don't read it. Omitting the envelope on skip would
    mean the launcher can't tell "console run, preflight skipped" from
    "direct run, no console at all", breaking the §3.2 divergence-report's
    request_id correlation.
    """
    extra_vars: dict[str, Any] = {}
    if workload:
        extra_vars["workload_slug"] = workload
    if envelope:
        extra_vars.update(envelope)
    return extra_vars or None


# uuid4().hex format — a run_id IS the originating deploy op's own
# request_id (umbrella #202 WP2, plan §4.1's request_id correlation).
_RUN_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _facility_busy_check(
    ops_store: OperationStore, *, current_target: str, current_action: str = "deploy",
    current_operation_id: str | None = None,
) -> Operation | None:
    """Advisory single-facility lock (umbrella #202 WP2, plan §4.5 P2-2).

    Console-local ONLY — no network IO, no AWX/Prometheus/k8s call. Scans
    the in-memory ops store for any BLOCKING deploy/teardown/rollback op —
    codex R3-1 REMOVED the old blanket same-target skip: plan §4.5 is
    "one run at a time, full stop" — a DIRTY op (see below) now blocks a
    new dispatch to its OWN target too, not just other targets (e.g. a
    FAILED_ROLLBACK_REQUIRED deploy of catalog key K blocks a NEW
    deploy/teardown of K until the dirty run is resolved). Wired into
    deploy, teardown, AND rollback dispatch (codex R2-6/R3-5 — teardown's
    prior cross-target exemption is also gone, see below).

    The ONLY unconditional skip is the caller's own just-created op
    (``current_operation_id``) — see "Ordering per flow" below for when
    that's even needed at all.

    A blocking op is one that is either genuinely non-terminal
    (``state not in terminal_states(op.action)`` — a run actually in
    flight), OR terminal but DIRTY (``operations.DIRTY_STATES``:
    FAILED_ROLLBACK_REQUIRED / ROLLBACK_INCOMPLETE / RUN_STATUS_UNKNOWN — a
    run that STOPPED but may have left surfaces inconsistent, or whose
    outcome the console lost track of). Dirty blocks expire only with the
    ops store's TTL GC (codex R2-6e) — this is console-advisory only; the
    WP3 launcher lock + snapshot staleness checks are the authoritative,
    non-expiring guard.

    Two narrow exceptions, both scoped to ``current_action == "rollback"``
    (codex R2-6d, refined by R3-1, corrected by R4-1, NARROWED by R5):

    * a blocking op is exempted ONLY when it's the specific DIRTY-
      RECOVERABLE DEPLOY that ``current_target`` (a run_id) is rolling
      back — ALL FOUR must hold: ``op.action == "deploy"``, its OWN
      ``run_id`` (the HYDRATED run identity, codex R3-3 — NOT
      ``request_id``, which is only this console's own dispatch bookkeeping
      id and can diverge from run_id on a reattach) equals
      ``current_target``, AND ``op.state`` is FAILED_ROLLBACK_REQUIRED or
      RUN_STATUS_UNKNOWN (the two states a rollback is actually meant to
      recover from). codex R5: a prior draft exempted on run_id-match
      alone, regardless of action/state — over-broad in three ways a
      single "rollback of run R" dispatch could hit: (1) a RUNNING (still
      LIVE, not yet dirty) deploy with run_id R would have been wrongly
      exempted, letting a rollback proceed concurrently with a deploy
      that hasn't even finished yet — one run at a time means a rollback
      of a live run must wait for it to reach a terminal (dirty) state,
      not race it; (2) a ROLLBACK_INCOMPLETE op (action=="rollback") whose
      OWN run_id happens to COINCIDENTALLY equal some unrelated
      current_target R (run_id is just that rollback's own dispatch
      correlator, an arbitrary hex32 — see ``_run_rollback_operation``)
      would have wrongly exempted itself from blocking a genuinely
      unrelated new rollback of R; (3) same collision for a
      RUN_STATUS_UNKNOWN teardown. Only a DEPLOY op's run_id is ever a
      real snapshot-identity claim a rollback command legitimately
      targets; a rollback/teardown op's run_id is just its own
      housekeeping correlator and must never be treated as "the run it
      recovers". Harmless for deploy/teardown dispatch, where
      ``current_target`` is a catalog key and can never equal a run_id's
      uuid4-hex shape.
    * a blocking op that is ROLLBACK_INCOMPLETE AND shares the SAME target
      (i.e. a PRIOR rollback attempt for this exact run_id) is exempted —
      a retry of an incomplete rollback for the same run must not be
      blocked by its own previous incomplete attempt. This is narrower
      than the old blanket same-target skip: it applies ONLY to
      ROLLBACK_INCOMPLETE + only when retrying that SAME rollback, not to
      any other same-target dirty state.

    Ordering per flow (codex R3-1 — prefer checking BEFORE creating an op,
    which needs no self-skip and no un-wedge-on-refusal dance):

    * Rollback (async + sync): the dedupe here is a plain (non-exclusive)
      ``get_or_create`` — the caller peeks via ``ops_store.find_active``
      first; if that WOULD reattach, the facility check is skipped
      entirely (a reattach is never facility-gated) and ``get_or_create``
      runs directly. If it would NOT reattach, the facility check runs
      FIRST, with ``current_operation_id=None`` — nothing has been created
      yet, so there's nothing to self-skip and nothing to un-wedge on a
      refusal.
    * Deploy/teardown (async): dedupe is ``get_or_create_exclusive``, which
      atomically resolves reattach-vs-conflict-vs-create in one locked
      pass — there's no race-free way to peek "would this create fresh"
      without either duplicating that logic or introducing a genuine
      TOCTOU gap in the conflict check itself. These flows keep the
      pre-existing order (create first, then facility-check with
      ``current_operation_id=op.operation_id`` to self-skip, un-wedging to
      ERROR on a refusal) — the safer choice given get_or_create_exclusive
      is the one place here that guards a genuine invariant (deploy XOR
      teardown), not just advisory dedupe.
    * Deploy/teardown (sync): no ops-store dedupe happens before dispatch
      at all (the sync flow's own idempotency guard is AWX-side, via
      ``find_active_job_for_template``) — an Operation is only created
      AFTER a successful launch (codex R2-5). So the facility check
      already runs before any op exists here; ``current_operation_id`` is
      always None.

    "Advisory" (plan §4.5): the launcher tier (WP3) recomputes and enforces
    the real facility run-lock in-cluster; this is only the early,
    best-effort, console-local heads-up — it can race (TOCTOU) and is
    never the authoritative lock.
    """
    for op in ops_store.list_all():
        if op.operation_id == current_operation_id:
            continue
        if op.action not in ("deploy", "teardown", "rollback"):
            continue
        if (
            current_action == "rollback"
            and op.action == "deploy"
            and op.run_id == current_target
            and op.state in (OperationState.FAILED_ROLLBACK_REQUIRED, OperationState.RUN_STATUS_UNKNOWN)
        ):
            continue
        if (
            current_action == "rollback"
            and op.target == current_target
            and op.state == OperationState.ROLLBACK_INCOMPLETE
        ):
            continue
        is_dirty = op.state in DIRTY_STATES
        if op.state in terminal_states(op.action) and not is_dirty:
            continue
        return op
    return None


def _audit_awx_write(
    request: Request,
    user: UserIdentity,
    *,
    action: str,
    target: str,
    request_id: str,
    reason: str,
    outcome: str,
    workload: str | None = None,
    capacity: str | None = None,
) -> None:
    """Emit the C5 quartet audit line for a DMF-initiated AWX write.

    deploy / teardown / launch are consequential automated actions, so they
    carry the same durable record as clear-for-deployment: actor + effective
    role + request-id + reason + outcome. ``real_role`` is included only when a
    view-as downgrade is active, so an admin acting-as-viewer stays attributable
    (B+E composition). The structured log line is the audit record until the
    console-local Activity lane subsumes it (#174).

    Scope (codex WP-E P2-4): the C5 quartet is recorded HERE (the dmf-cms log +
    the console-local Activity record), NOT injected into AWX job ``extra_vars``.
    This matches clear-for-deployment: the console is the authoritative audit
    surface (ADR-0028); threading C5 into AWX itself is deferred.

    ``workload`` (#239) records what was requested, not just target=key — an
    optional trailing field, blank when omitted, so existing callers (launch,
    teardown) need no changes.

    ``capacity`` (#202 WP1) is a compact budget-numbers summary for
    ``capacity-override``/``capacity-denied`` outcomes (plan §3.3: "the C5
    quartet ... + the budget numbers") — same optional-trailing-field pattern
    as ``workload``, blank when omitted.
    """
    real = session_user(request.session)
    real_role = real.role if (real is not None and request.session.get("view_as")) else ""
    logger.info(
        "awx write: action=%s actor=%s role=%s real_role=%s request_id=%s target=%s reason=%r outcome=%s workload=%s capacity=%s",
        action,
        user.subject,
        user.role,
        real_role,
        request_id,
        target,
        reason,
        outcome,
        workload or "",
        capacity or "",
    )


def _bootstrap_console_groups(settings: Settings) -> None:
    """Seed dmf-console-* groups and assign bootstrap user to admin (startup only)."""
    if not settings.authentik.configured:
        logger.info("Authentik API not configured — skipping console group bootstrap")
        return

    logger.info("Authentik API configured — bootstrapping DMF Console groups")
    seed_groups = [next(iter(ROLE_GROUPS[role])) for role in ROLE_ORDER]
    seed_groups.append(MEDIA_ENGINEERS_GROUP)
    for name in seed_groups:
        try:
            created = ensure_group(
                api_url=settings.authentik.api_url,
                api_token=settings.authentik.api_token,
                name=name,
            )
            if created:
                logger.info("Created Authentik group: %s", name)
            else:
                logger.info("Group already exists: %s", name)
        except (AuthentikAPIError, OSError) as exc:
            # OSError covers urllib URLError (DNS/TLS/connection). Group seeding is
            # best-effort at startup; a transient Authentik back-channel failure
            # must not crashloop the console.
            logger.warning("Failed to ensure group %s: %s", name, exc)

    # Assign the bootstrap user (from dev login settings) to dmf-console-admin
    bootstrap_user = settings.dev_username
    if bootstrap_user:
        try:
            added = add_user_to_group(
                api_url=settings.authentik.api_url,
                api_token=settings.authentik.api_token,
                username=bootstrap_user,
                group_name="dmf-console-admin",
            )
            if added:
                logger.info("Added bootstrap user '%s' to dmf-console-admin", bootstrap_user)
            else:
                logger.info("Bootstrap user '%s' already in dmf-console-admin or not found", bootstrap_user)
        except (AuthentikAPIError, OSError) as exc:
            logger.warning("Failed to assign bootstrap user to dmf-console-admin: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _bootstrap_console_groups(app.state.settings)
    app.state.operations = OperationStore(ttl_seconds=3600)
    app.state.operation_tasks: set[asyncio.Task] = set()
    yield


async def _run_launch_operation(app: FastAPI, operation_id: str, workflow_name: str) -> None:
    """Background task to wake AWX and launch a workflow job."""
    settings = app.state.settings
    ops_store = app.state.operations

    try:
        # Wake AWX (threadpooled to avoid blocking event loop)
        await run_in_threadpool(
            ensure_awx_awake,
            helper_url=settings.awx_autoscale.helper_url,
            bearer_token=settings.awx_autoscale.bearer_token,
            max_startup_wait=settings.awx_autoscale.max_startup_wait,
        )

        # Update state to launching
        ops_store.update(operation_id, state=OperationState.LAUNCHING)

        # Lookup job template
        template = await run_in_threadpool(
            lookup_job_template_by_name,
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            name=workflow_name,
            ssl_verify=settings.awx.ssl_verify,
        )
        if template is None:
            ops_store.update(
                operation_id,
                state=OperationState.ERROR,
                error=f"AWX job template not found: {workflow_name}",
            )
            return

        # Check for existing active job (idempotency)
        active_job_id = await run_in_threadpool(
            find_active_job_for_template,
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            job_template_id=template["id"],
            ssl_verify=settings.awx.ssl_verify,
        )
        if active_job_id is not None:
            ops_store.update(
                operation_id,
                state=OperationState.LAUNCHED,
                job_id=active_job_id,
            )
            return

        # Launch job
        job_id = await run_in_threadpool(
            launch_job,
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            job_template_id=template["id"],
            ssl_verify=settings.awx.ssl_verify,
        )

        ops_store.update(
            operation_id,
            state=OperationState.LAUNCHED,
            job_id=job_id,
        )
    except AWXAutoscaleError as exc:
        # Log raw error server-side only, sanitize for client
        logger.error("AWX autoscale error in launch operation %s: %s", operation_id, exc.body)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="AWX wake failed",
        )
    except AWXAPIError as exc:
        # Log raw error server-side only, sanitize for client
        logger.error("AWX API error in launch operation %s: %s", operation_id, exc.body)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="AWX API error while launching",
        )
    except Exception as exc:
        logger.exception("Unexpected error in launch operation %s", operation_id)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="Unexpected error while launching",
        )


# AWX job statuses that are terminal — mirrors AWXJobInfo.is_done's set.
_TERMINAL_JOB_STATUSES = {"successful", "failed", "canceled", "error"}

# See the module docstring's "L3 outcome marker contract" (umbrella #202
# WP2 §4.6, transport revised WP3 R2b) for the full shape this parses.
_L3_OUTCOME_RE = re.compile(r"^DMF_L3_OUTCOME: (?P<token>[a-z0-9_-]+)(?: (?P<kv>.*))?$")

# R2b: the dedicated ansible.builtin.debug task name every DMF_L3_OUTCOME
# emission routes through (roles/l3_run_guard/tasks/_emit_outcome.yml in
# dmf-runbooks) — the job-events fetch is anchored to THIS exact name, not
# just the marker string's own shape, so an identically-formatted string
# emitted by some other, differently-named task is structurally invisible
# to this contract (the provenance binding codex demanded).
_L3_OUTCOME_TASK_NAME = "dmf-l3-outcome"

# codex R2-3: tokens meaning the launcher refused BEFORE mutating anything —
# a started-then-failed DEPLOY carrying one of these is not dirty, it just
# never got past its own preflight. See _watch_job_operation. R2b: extended
# with the launcher's two new pre-lock/pre-mutation refusal tokens
# (preflight-error, lock-unavailable) — post-mutation-failed is
# DELIBERATELY excluded, see the module docstring.
_PRE_MUTATION_TOKENS = frozenset({
    "facility-busy", "lock-unavailable", "preflight-error",
    "no-fit", "missing-budget", "no-snapshot", "stale-snapshot",
})

# codex R2-9/R3-7 §6 public-safety: the outcome marker's optional kv
# detail is untrusted text straight from a job's own stdout — only these
# specific keys, each with its OWN strict per-key value rule (never a
# shared generic charset — R3-7 killed the prior draft's broad
# [A-Za-z0-9_.,:/-] pattern, which let dot/colon-shaped values through and
# could leak an IP-shaped string). Everything else is silently dropped,
# never partially-included. R3-7's original "detail" key was a FREE-TEXT
# field (any charset-matching string) — that one is still gone entirely.
# R3b (umbrella #202 WP3, codex round-2, the cross-repo gap R3a's own
# report flagged) brought 'detail' back, but as a CLOSED ENUM, not free
# text — the launcher's own refusal paths need SOME way to surface their
# specific reason, and a frozen enum carries zero free-text risk (no
# dots/colons/slashes can ever ride in this way — the R3-7 posture holds,
# this is not a relaxation of it).
#
# R5b (umbrella #202 WP3 R5b, codex round-4 P2-2): _KV_DETAIL_TOKENS
# re-enumerated from the ACTUAL staged dmf-runbooks tree (every literal
# `detail=<x>` kv value grepped from roles/l3_run_guard/tasks/*.yml after
# R5a), not carried forward from memory — R4 already found the enum had
# silently drifted behind the runbooks' own emissions once (missing
# snapshot-race/helm-values-fetch-failed/reserved-var-run-id); this is
# the same drift class, now closed with tests/test_l3_token_registry.py's
# own cross-repo-aware registry test rather than trusted to stay in sync
# by hand a second time. The 'snapshot' kv key (and its own
# _KV_SNAPSHOT_TOKENS enum) is REMOVED entirely — see the module
# docstring's own R5b paragraph for why.
_KV_ALLOWED_KEYS = frozenset({"surfaces", "request_id", "run_id", "detail"})
_HEX32_RE = re.compile(r"^[0-9a-f]{32}$")
_KV_SURFACES_ALLOWED = frozenset({"netbox", "helm", "monitoring"})
_KV_DETAIL_TOKENS = frozenset({
    "authority-constant-mismatch", "helm-values-fetch-failed", "lock-lost",
    "lock-race", "lock-verify-failed", "reserved-var", "reserved-var-run-id",
    "snapshot-collision", "snapshot-race", "snapshot-verify-failed",
})
_KV_MAX_LEN = 500


def _kv_value_ok(key: str, value: str) -> bool:
    """Per-key strict value validation (codex R3-7, enum key added R3b,
    re-enumerated R5b) — no shared charset; the enum key accepts ONLY its
    frozen member set, never an arbitrary string."""
    if key in ("request_id", "run_id"):
        return bool(_HEX32_RE.fullmatch(value))
    if key == "surfaces":
        parts = value.split(",")
        return bool(parts) and all(p in _KV_SURFACES_ALLOWED for p in parts)
    if key == "detail":
        return value in _KV_DETAIL_TOKENS
    return False


def _sanitize_kv(kv: str | None) -> str | None:
    """Allow-list the outcome marker's kv detail with PER-KEY strict value
    rules (codex R2-9, tightened by R3-7, enum key added R3b,
    re-enumerated R5b).

    ``kv`` is space-separated ``key=value`` tokens straight from a job's
    stdout — untrusted free text. Only tokens whose key is in
    ``_KV_ALLOWED_KEYS`` AND whose value passes that key's OWN validator
    (``_kv_value_ok`` — request_id/run_id must fullmatch a bare 32-char
    lowercase hex uuid; surfaces must be a comma-joined subset of
    ``_KV_SURFACES_ALLOWED``; detail must be an exact member of its own
    frozen enum, ``_KV_DETAIL_TOKENS``) survive; a malformed token (no
    ``=``, disallowed key, or a value that fails its key's rule) is
    dropped, not partially kept or escaped. The reassembled result is
    capped at ``_KV_MAX_LEN`` chars. Returns
    ``None`` if nothing survives (an absent kv, or a kv that was entirely
    noise).
    """
    if not kv:
        return None
    kept = []
    for token in kv.split():
        key, sep, value = token.partition("=")
        if not sep or key not in _KV_ALLOWED_KEYS or not _kv_value_ok(key, value):
            continue
        kept.append(f"{key}={value}")
    if not kept:
        return None
    return " ".join(kept)[:_KV_MAX_LEN]


async def _fetch_l3_outcome_from_events(app: FastAPI, job_id: int) -> tuple[str | None, str | None]:
    """Fetch a job's ``dmf-l3-outcome`` task events and parse the marker.

    R2b (codex round-1 P1-2): replaces the WP3-D stdout-tail approach
    entirely — the marker is fetched via AWX job events, filtered to the
    dedicated ``_L3_OUTCOME_TASK_NAME`` task, never by scanning stdout.
    This binds the contract to STRUCTURE (a specific task's own events),
    not TEXT POSITION — an identically-formatted ``DMF_L3_OUTCOME: ...``
    string emitted by some OTHER, differently-named task's own debug
    output is invisible here: both because ``get_job_events_for_task``
    already asks AWX to filter server-side by task name, AND (defense in
    depth) because this function separately re-checks each event's own
    ``task`` field against ``_L3_OUTCOME_TASK_NAME`` before ever looking at
    its ``msg`` — which a stdout-tail scan could never guarantee at all.

    Tolerates ``get_job_events_for_task`` failure (network error, events
    not yet available, the job template never running the named task at
    all, ...): returns ``(None, None)`` rather than raising — a missing
    outcome must never crash the watcher; ``l3_outcome`` just stays unset
    and the AWX job status remains the fallback source of truth. Each
    event's own shape is validated defensively (dict checks at every
    level) since it's untrusted data straight from the AWX API — a
    malformed/missing ``event_data``/``res``/``msg`` chain on any one
    event also falls through to ``(None, None)`` for that event, never a
    crash.

    Multiple events for the task (should not normally happen — the
    emitter task runs exactly once per play — but the wire contract
    doesn't forbid a caller from including it more than once): the LAST
    event (AWX's own ``order_by=counter`` ordering) wins, same "last one
    wins" semantics as the old stdout-based contract had for multiple
    marker lines.

    The returned kv (if any) has already been through ``_sanitize_kv`` —
    every caller gets the sanitized form for free, there is no raw-kv path.
    """
    settings = app.state.settings
    try:
        events = await run_in_threadpool(
            get_job_events_for_task,
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            job_id=job_id,
            task_name=_L3_OUTCOME_TASK_NAME,
            ssl_verify=settings.awx.ssl_verify,
        )
    except Exception:
        return None, None

    if not events:
        return None, None

    for event in reversed(events):
        if not isinstance(event, dict):
            continue
        # Defense in depth: even though get_job_events_for_task already
        # asked AWX to filter server-side by task name, re-check each
        # event's own ``task`` field here too — an identically-formatted
        # DMF_L3_OUTCOME string on a DIFFERENTLY-named task's event must
        # never match, regardless of how it ended up in this list (the
        # provenance binding is "this exact task", not "any event whose
        # msg happens to look right").
        if event.get("task") != _L3_OUTCOME_TASK_NAME:
            continue
        event_data = event.get("event_data")
        if not isinstance(event_data, dict):
            continue
        res = event_data.get("res")
        if not isinstance(res, dict):
            continue
        msg = res.get("msg")
        if not isinstance(msg, str):
            continue
        match = _L3_OUTCOME_RE.match(msg.strip())
        if match:
            token, kv = match.group("token"), match.group("kv")
            return token, _sanitize_kv(kv)

    return None, None


# umbrella #202 WP3 R3b (codex round-2 P2-1): a bounded, settings-free cap
# on the EXTRA polls _await_event_ingestion_finished waits for AWX's own
# event_processing_finished flag. AWX's job-events ingestion can lag the
# job's own terminal STATUS transition by a few seconds — job.status flips
# to "successful"/"failed" before every job_event row has necessarily
# landed. Never poll forever: a job whose ingestion never finishes (a
# genuinely stuck/crashed AWX event processor) must not hang this
# operation's terminal transition indefinitely.
_L3_EVENT_INGESTION_MAX_EXTRA_POLLS = 6


async def _await_event_ingestion_finished(app: FastAPI, job: dict, job_id: int, poll_interval: float) -> None:
    """Poll ``get_job`` up to ``_L3_EVENT_INGESTION_MAX_EXTRA_POLLS`` extra
    times, waiting for AWX's own ``event_processing_finished`` flag on the
    job detail (umbrella #202 WP3 R3b, codex round-2 P2-1) before the
    caller fetches the outcome marker.

    Fetching the marker (``_fetch_l3_outcome_from_events``) immediately on
    terminal STATUS risks a false "no marker" classification purely
    because the marker's own event hasn't been ingested yet — which, for a
    PRE-MUTATION refusal (a token in ``_PRE_MUTATION_TOKENS``), would
    wrongly fall through to FAILED_ROLLBACK_REQUIRED and dispatch a
    pointless (no-snapshot) auto-rollback — codex's exact scenario.

    Bounded, never infinite: after the cap, the caller proceeds with its
    OWN single ``_fetch_l3_outcome_from_events`` call and classifies
    whatever it finds — exactly as if ingestion HAD finished (the marker
    may simply not exist yet, which is treated identically to "no marker",
    the existing, already-safe fallback). This function itself never
    fetches the marker — it only waits, then returns.

    umbrella #202 WP3 R4b (codex round-3 P2-3): a transient ``get_job``
    exception mid-wait no longer ends the wait early. The R3b draft
    ``return``ed immediately on ANY exception, treating it as equivalent to
    "ingestion finished" — but that can recreate the EXACT lagging-event
    misclassification this whole function exists to prevent: a single
    transient hiccup on, say, poll 2 of 6 would abandon the wait right
    there, the caller's own single marker fetch would then run against a
    still-lagging AWX event pipeline, and a genuine pre-mutation refusal
    would misclassify as FAILED_ROLLBACK_REQUIRED exactly as if this
    function had never run at all. Fixed by mirroring the OUTER watcher
    loop's own consecutive-failure idiom (see its own docstring/loop body,
    3-consecutive-failures-gives-up, reset to 0 on any success): a
    transient exception here now just costs one of the bounded
    ``_L3_EVENT_INGESTION_MAX_EXTRA_POLLS`` iterations and the loop
    continues — only 3 CONSECUTIVE exceptions (a real "AWX API looks down"
    signal, not a single blip) ends the wait early. The outer bound
    (``_L3_EVENT_INGESTION_MAX_EXTRA_POLLS`` total iterations) is untouched
    either way — this can never poll longer than before, only more
    resiliently within the same budget.
    """
    if not isinstance(job, dict) or job.get("event_processing_finished", False):
        return
    settings = app.state.settings
    consecutive_failures = 0
    for _ in range(_L3_EVENT_INGESTION_MAX_EXTRA_POLLS):
        await asyncio.sleep(poll_interval)
        try:
            job = await run_in_threadpool(
                get_job,
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_id=job_id,
                ssl_verify=settings.awx.ssl_verify,
            )
        except Exception:
            consecutive_failures += 1
            logger.warning(
                "event ingestion wait: get_job failed for job %s, attempt %d/3",
                job_id, consecutive_failures,
            )
            if consecutive_failures >= 3:
                return
            continue
        consecutive_failures = 0
        if isinstance(job, dict) and job.get("event_processing_finished", False):
            return


def _append_kv(base: str, kv: str | None) -> str:
    return f"{base} {kv}" if kv else base


def _extract_run_id_from_job(job: dict, *, action: str) -> str | None:
    """Hydrate a run's identity from a raw AWX job detail (codex R3-3,
    made ACTION-AWARE by R4-2).

    Used ONLY when REATTACHING to an AWX job this console instance didn't
    itself just launch (an already-active job found via
    ``find_active_job_for_template``/AWX query, or the rollback JT's own
    already-active check) — a fresh dispatch already knows its own
    identity (its own request_id) without needing this.

    codex R4-2: the wire contract differs by ACTION —
    ``extra_vars.l3_request_id`` is a per-LAUNCH dispatch correlator (a
    fresh one every time something is dispatched, including every
    individual rollback attempt — see ``_run_rollback_operation``), while
    ``extra_vars.l3_run_id`` is ONLY threaded into rollback launches and is
    the actual snapshot-correlated target the rollback is acting on:

    * ``action in ("deploy", "teardown")``: identity is
      ``extra_vars.l3_request_id`` — for these actions that field IS this
      run's stable identity (what a rollback command would target via
      run_id, and what the launcher's snapshot ConfigMap is keyed by).
    * ``action == "rollback"``: identity is ``extra_vars.l3_run_id`` — a
      rollback job's OWN ``l3_request_id`` is just that particular launch
      attempt's correlator, never the run being rolled back. Using
      l3_request_id here would silently attribute a reattached rollback
      job to the WRONG run (see the identity-verification gate in the
      rollback already-active path, ``api_run_rollback``'s sync branch —
      this function alone doesn't verify a match against any expected
      value, it just extracts the right field for the caller to check).

    AWX returns ``extra_vars`` as a JSON-ENCODED STRING field on the job
    resource (not a nested object) — defensive throughout: any shape
    mismatch, parse failure, absent/non-string value, or a value that
    doesn't fullmatch the run_id shape (``_RUN_ID_RE`` — codex R4-4, the
    SAME pattern the manual rollback endpoint validates against) yields
    None, never raises. A run whose identity can't be recovered this way
    is genuinely unknown to the console — see ``Operation.run_id`` and
    ``_maybe_auto_trigger_rollback``'s "identity-unknown" handling; it is
    NEVER guessed or defaulted to something else.
    """
    raw = job.get("extra_vars")
    if not isinstance(raw, str):
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    key = "l3_run_id" if action == "rollback" else "l3_request_id"
    value = parsed.get(key)
    if not isinstance(value, str) or not _RUN_ID_RE.fullmatch(value):
        return None
    return value


def _track_sync_reattach(
    app: FastAPI, ops_store: OperationStore, request_id: str, initiator: str, *,
    action: str, target: str, job_id: int,
) -> str:
    """Bridge a sync-flow AWX-side already-active job into the ops store
    (codex R3-4). DEPLOY/TEARDOWN only — rollback's shared job template
    needs an identity check first; see ``_track_sync_rollback_reattach``.

    The sync dispatch flow has no ops-store dedupe before checking AWX
    directly for an in-flight job (``find_active_job_for_template``) — a
    prior draft returned "already-active" with ZERO tracking when one was
    found, meaning the facility check / auto-rollback / outcome surfacing
    never saw that run at all. This bridges it: get_or_create (NOT
    exclusive — this is retroactive observability of a run already
    in-flight on AWX, not a new dispatch decision, so there's nothing to
    conflict-check), hydrate run_id from the job's own extra_vars exactly
    like an async reattach (this console didn't launch it, so its identity
    — if any — lives on the AWX job, not in anything we already know), and
    spawn the watcher. Returns the operation_id for the caller to echo in
    its response.

    codex R4-3: idempotent under a concurrent duplicate call — get_or_create
    reattaches a SECOND already-active POST for the same (action, target)
    to the SAME op the first call created; only the first (``created``
    True) gets job_id/run_id set and a watcher spawned. A live op is never
    retargeted or double-watched by a later call, even if the currently-
    active AWX job_id somehow differs from what's already recorded on it —
    that discrepancy resolves at the existing watcher's own terminality,
    not by this function reaching into a running op's fields.
    """
    settings = app.state.settings
    op, created = ops_store.get_or_create(
        action=action, target=target, request_id=request_id, initiator=initiator,
    )
    if not created:
        return op.operation_id
    run_id = None
    try:
        job_detail = get_job(
            api_url=settings.awx.api_url, api_token=settings.awx.api_token,
            job_id=job_id, ssl_verify=settings.awx.ssl_verify,
        )
        run_id = _extract_run_id_from_job(job_detail, action=action)
    except Exception:
        pass  # identity stays unknown (None) — never guess
    ops_store.update(op.operation_id, state=OperationState.LAUNCHED, job_id=job_id, run_id=run_id)
    _spawn_job_watcher(app, op.operation_id, job_id, action, target)
    return op.operation_id


def _track_sync_rollback_reattach(
    app: FastAPI, ops_store: OperationStore, request_id: str, initiator: str, *,
    run_id: str, job_id: int,
) -> tuple[str | None, bool]:
    """Bridge a sync rollback dispatch's AWX-side already-active job into
    the ops store — WITH an identity check first (codex R4-2b).

    Unlike deploy/teardown (each with their own dedicated per-entry job
    template), the rollback job template (``settings.l3.rollback_jt_name``)
    is SHARED across every run being rolled back — "some rollback job is
    active" doesn't mean it's rolling back THIS run_id. Fetches the active
    job's own detail and requires its hydrated identity
    (``_extract_run_id_from_job(..., action="rollback")`` —
    extra_vars.l3_run_id, NOT l3_request_id, per that function's
    action-aware wire contract) to equal ``run_id`` BEFORE ever creating or
    reattaching an Operation. Anything short of a CONFIRMED match — a
    different run_id, an unparseable/absent identity, or the job-detail
    fetch itself failing — refuses: returns ``(None, True)`` and creates
    nothing. The caller must turn that into a 409, never fall through to
    blind attribution: silently reattaching to another run's job would let
    THAT run's own outcome marker resolve THIS run's Operation — a
    false-complete for a rollback that never actually ran against this
    run's snapshot.

    Returns ``(operation_id, False)`` on a confirmed match — same
    get_or_create + R4-3 idempotent tracking as ``_track_sync_reattach``
    otherwise (only a newly-created op gets job_id/run_id set + a watcher).
    """
    settings = app.state.settings
    try:
        job_detail = get_job(
            api_url=settings.awx.api_url, api_token=settings.awx.api_token,
            job_id=job_id, ssl_verify=settings.awx.ssl_verify,
        )
    except Exception:
        return None, True  # can't verify identity at all -> refuse, never guess

    active_run_id = _extract_run_id_from_job(job_detail, action="rollback")
    if active_run_id != run_id:
        return None, True

    op, created = ops_store.get_or_create(
        action="rollback", target=run_id, request_id=request_id, initiator=initiator,
    )
    if created:
        ops_store.update(op.operation_id, state=OperationState.LAUNCHED, job_id=job_id, run_id=active_run_id)
        _spawn_job_watcher(app, op.operation_id, job_id, "rollback", run_id)
    return op.operation_id, False


def _spawn_job_watcher(app: FastAPI, operation_id: str, job_id: int, action: str, key: str) -> None:
    """Spawn the L3 job-terminal watcher (umbrella #202 WP2) as a background
    task, registered in app.state.operation_tasks like every other
    operation task so app shutdown can await it.
    """
    task = asyncio.create_task(_watch_job_operation(app, operation_id, job_id, action, key))
    app.state.operation_tasks.add(task)
    task.add_done_callback(app.state.operation_tasks.discard)


def _watch_lost_terminal_state(action: str, seen_started: bool) -> OperationState:
    """Conservative give-up terminal state (codex R2-4, remapped by R3-2).

    When the watcher gives up WITHOUT a clean terminal job read (TTL
    timeout, 3 consecutive ``get_job`` failures, or an unexpected crash —
    see ``_watch_job_operation``'s outer try/except), it must still leave
    the op in SOME terminal state, never stranded mid-flight.

    codex R3-2: FAILED_ROLLBACK_REQUIRED is reserved EXCLUSIVELY for a
    CONFIRMED terminal AWX job failure observed inside the main poll loop
    (the branch that also calls ``_maybe_auto_trigger_rollback`` — the
    auto-trigger contract must only fire when we actually KNOW the job
    failed after starting). A give-up path never confirmed anything — the
    job may still be running happily on AWX's side, unobserved. So:

    * ``seen_started`` (remembered across every poll, not just the final
      one — the give-up path usually has no fresh job dict to read
      ``started`` from) AND ``action == "rollback"`` -> ROLLBACK_INCOMPLETE
      (rollback's own fail-closed dirty terminal — consistent with its
      marker-driven "never assume clean" posture from R2-1).
    * ``seen_started`` and any OTHER action (deploy/teardown) ->
      RUN_STATUS_UNKNOWN — dirty (blocks the facility, see
      ``_facility_busy_check``) but explicitly NOT a confirmed failure:
      never auto-triggers a rollback. A deploy stuck here surfaces to the
      operator, who can dispatch a rollback manually once its run_id is
      known (or once the run is confirmed one way or the other).
    * never started -> RUN_FAILED (nothing observed to have mutated
      anything; safe to just report, not dirty).
    """
    if seen_started:
        return OperationState.ROLLBACK_INCOMPLETE if action == "rollback" else OperationState.RUN_STATUS_UNKNOWN
    return OperationState.RUN_FAILED


async def _watch_job_operation(app: FastAPI, operation_id: str, job_id: int, action: str, key: str) -> None:
    """Poll an AWX job to its terminal state and resolve the operation (umbrella #202 WP2).

    The pre-WP2 ops store terminated at LAUNCHED — the console never
    observed AWX job completion. WP2's advisory facility lock and
    failed_rollback_required auto-trigger (WP2-B) both need the run
    tracked to its job-terminal state; this loop is that tracking.

    Spawned for action in {"deploy", "teardown", "rollback"} from BOTH the
    async (autoscale-enabled) and — since codex R2-5 — the sync
    (autoscale-disabled) flow; see the call sites in
    _run_deploy_operation/_run_teardown_operation/_run_rollback_operation
    and the sync branches of api_catalog_deploy/api_catalog_teardown/
    api_run_rollback.

    Polls ``get_job`` every ``settings.l3.job_poll_interval_seconds``.  On
    the first poll that finds the job still non-terminal, promotes the op
    to RUNNING (idempotent — re-set on every non-terminal poll, harmless).
    Every poll response is validated (dict with a string ``status``,
    codex R2-4c) and, if it ever carries a truthy ``started``, that's
    remembered for the lifetime of this watch (``seen_started`` — see
    ``_watch_lost_terminal_state``), not just read fresh at the terminal
    poll.

    On a terminal job status (§4.6 outcome surfacing — R3b: first
    ``_await_event_ingestion_finished`` waits, bounded, for AWX's own
    event-ingestion lag to clear, then ``_fetch_l3_outcome_from_events``
    is called, and its token/detail stored on ``l3_outcome``/appended to
    ``error``, for any FAILED terminal on a watched deploy/teardown op, and
    for ANY terminal on a rollback op — BEFORE classifying the deploy case,
    codex R2-3, since a pre-mutation refusal token changes the outcome):

    * ``action != "rollback"``:
        * ``successful`` -> RUN_COMPLETE (no outcome fetch — success never
          needs a marker to explain itself).
        * failed/error/canceled, job never started (no ``started``
          timestamp) -> RUN_FAILED (nothing mutated, safe to just report).
        * failed/error/canceled, job DID start, ``action == "deploy"``,
          outcome token in ``_PRE_MUTATION_TOKENS`` -> RUN_FAILED, no
          auto-trigger (codex R2-3: the launcher refused BEFORE mutating
          anything — "started" here just means the AWX job process ran,
          not that the play got past its own preflight).
        * failed/error/canceled, job DID start, ``action == "deploy"``,
          any other/no outcome token -> FAILED_ROLLBACK_REQUIRED (surfaces
          may be dirty, plan §4.5's auto-rollback trigger state) — then
          ``_maybe_auto_trigger_rollback``.
        * failed/error/canceled, job DID start, ``action == "teardown"``
          -> RUN_FAILED, not FAILED_ROLLBACK_REQUIRED — teardown is itself
          an idempotent cleanup action; an operator retry is the recovery
          path, not an auto-rollback of a cleanup.
    * ``action == "rollback"``: the marker, not the bare AWX job status, is
      authoritative (partial-failure posture §4.5 — never false-green a
      rollback the job merely didn't error on, codex R2-1):
        * ``successful`` status AND an exact ``rollback_complete`` marker
          -> RUN_COMPLETE. This is the ONLY combination that completes.
        * every other combination (job failed regardless of marker, no
          marker found, the stdout fetch itself failed, or the marker is
          any token other than ``rollback_complete``) -> ROLLBACK_INCOMPLETE,
          a DIRTY terminal state (``operations.DIRTY_STATES`` —
          ``_facility_busy_check`` keeps treating it as blocking).

    Gives up via ``_watch_lost_terminal_state`` (never leaves the op
    stranded mid-flight, codex R2-4):
    * TTL timeout (op.created_at + the store's configured ttl_seconds
      elapses) -> error="job-watch-timeout".
    * 3 consecutive ``get_job`` failures (transient AWX hiccups tolerated
      up to 2) -> error="job-watch-lost".
    * ANY other unexpected exception in the loop body (a malformed
      ``get_job`` response, per R2-4c's validation, included) ->
      error="job-watch-crashed" (the STABLE token only — codex R3-7 §6:
      the exception's own repr goes to the server-side logger via
      ``logger.exception``, never into this public field) — the entire
      loop runs inside a fail-closed outer try/except for exactly this
      case.
    """
    settings = app.state.settings
    ops_store = app.state.operations

    op = ops_store.get(operation_id)
    if op is None:
        return
    deadline = op.created_at + timedelta(seconds=ops_store.ttl_seconds)

    poll_interval = settings.l3.job_poll_interval_seconds
    consecutive_failures = 0
    seen_running = False
    seen_started = False

    try:
        while True:
            if datetime.now(timezone.utc) > deadline:
                ops_store.update(
                    operation_id,
                    state=_watch_lost_terminal_state(action, seen_started),
                    error="job-watch-timeout",
                )
                return

            try:
                job = await run_in_threadpool(
                    get_job,
                    api_url=settings.awx.api_url,
                    api_token=settings.awx.api_token,
                    job_id=job_id,
                    ssl_verify=settings.awx.ssl_verify,
                )
                consecutive_failures = 0
            except Exception:
                consecutive_failures += 1
                logger.warning(
                    "job watch: get_job failed for operation %s (job %s, target %s), attempt %d/3",
                    operation_id, job_id, key, consecutive_failures,
                )
                if consecutive_failures >= 3:
                    ops_store.update(
                        operation_id,
                        state=_watch_lost_terminal_state(action, seen_started),
                        error="job-watch-lost",
                    )
                    return
                await asyncio.sleep(poll_interval)
                continue

            # Capture started-evidence BEFORE the shape validation below —
            # even a response that's malformed in its `status` can still
            # carry a legitimate `started` timestamp, and seen_started must
            # reflect every dict-shaped response that had one.
            if isinstance(job, dict) and job.get("started"):
                seen_started = True

            # codex R2-4c: a malformed response (wrong shape entirely, or a
            # non-string status) must never propagate into the status
            # comparisons below — raise so the outer fail-closed handler
            # terminalizes instead of the watcher silently misbehaving.
            if not isinstance(job, dict) or not isinstance(job.get("status"), str):
                raise ValueError(f"malformed get_job response: {job!r}")

            status = job["status"]
            if status in _TERMINAL_JOB_STATUSES:
                started = job.get("started")

                # §4.6: fetch + parse the outcome marker whenever it could
                # matter — any failure on a watched op, or ANY terminal on a
                # rollback op (rollback's real pass/fail is the marker, not
                # just the job's own status). Fetched BEFORE classifying a
                # started-then-failed deploy (codex R2-3): a pre-mutation
                # refusal token changes that classification.
                outcome_token = outcome_kv = None
                if action == "rollback" or status != "successful":
                    await _await_event_ingestion_finished(app, job, job_id, poll_interval)
                    outcome_token, outcome_kv = await _fetch_l3_outcome_from_events(app, job_id)

                if action == "rollback":
                    # codex R2-1: RUN_COMPLETE requires BOTH a successful
                    # job status AND the exact rollback_complete marker —
                    # every other combination fails closed to
                    # ROLLBACK_INCOMPLETE, never false-green.
                    if status == "successful" and outcome_token == "rollback_complete":
                        ops_store.update(operation_id, state=OperationState.RUN_COMPLETE, l3_outcome=outcome_token)
                    elif outcome_token is None:
                        # No marker at all (successful-but-silent job, a
                        # failed job with no marker, or the stdout fetch
                        # itself failed) — unverified, never assume clean.
                        ops_store.update(
                            operation_id, state=OperationState.ROLLBACK_INCOMPLETE,
                            error="rollback-outcome-unverified", l3_outcome=outcome_token,
                        )
                    else:
                        ops_store.update(
                            operation_id, state=OperationState.ROLLBACK_INCOMPLETE,
                            error=_append_kv(f"rollback-incomplete:{outcome_token}", outcome_kv),
                            l3_outcome=outcome_token,
                        )
                    return

                if status == "successful":
                    ops_store.update(operation_id, state=OperationState.RUN_COMPLETE)
                elif not started:
                    ops_store.update(
                        operation_id, state=OperationState.RUN_FAILED,
                        error=_append_kv(f"job-{status}", outcome_kv), l3_outcome=outcome_token,
                    )
                elif action == "deploy":
                    if outcome_token in _PRE_MUTATION_TOKENS:
                        # codex R2-3: the launcher refused up front — the
                        # job process "started" but nothing was mutated,
                        # so this is a plain failure, not a dirty run.
                        ops_store.update(
                            operation_id, state=OperationState.RUN_FAILED,
                            error=_append_kv(f"job-{status}", outcome_kv), l3_outcome=outcome_token,
                        )
                    else:
                        ops_store.update(
                            operation_id, state=OperationState.FAILED_ROLLBACK_REQUIRED,
                            error=_append_kv(f"job-{status}", outcome_kv), l3_outcome=outcome_token,
                        )
                        await _maybe_auto_trigger_rollback(app, operation_id, key)
                else:
                    ops_store.update(
                        operation_id, state=OperationState.RUN_FAILED,
                        error=_append_kv(f"job-{status}", outcome_kv), l3_outcome=outcome_token,
                    )
                return

            if not seen_running:
                ops_store.update(operation_id, state=OperationState.RUNNING)
                seen_running = True

            await asyncio.sleep(poll_interval)
    except Exception:
        # codex R2-4b: fail-closed outer boundary — an AttributeError on a
        # malformed get_job response (or any other unexpected crash) must
        # never strand a LAUNCHED/RUNNING op mid-flight.
        #
        # codex R3-7 §6 public-safety: the exception's own repr (which may
        # embed a job dict, a URL, or other server-internal detail) goes to
        # the server-side logger ONLY, via logger.exception's traceback —
        # never into op.error, which is a PUBLIC field surfaced through
        # /api/operations/{id} to any authenticated user.
        logger.exception(
            "job watch: unexpected crash for operation %s (job %s, target %s)", operation_id, job_id, key,
        )
        ops_store.update(
            operation_id,
            state=_watch_lost_terminal_state(action, seen_started),
            error="job-watch-crashed",
        )


async def _maybe_auto_trigger_rollback(app: FastAPI, operation_id: str, key: str) -> None:
    """Auto-dispatch the rollback command on a deploy's failed_rollback_required
    transition (umbrella #202 WP2, plan §4.5(a)), gated by settings.l3.auto_rollback.

    codex R3-3: the rollback's run_id is the failed deploy op's ``run_id``
    field, NOT its ``request_id`` — for a FRESH dispatch they're the same
    value (run_id is set to request_id explicitly at launch), but for a
    REATTACH to an AWX job this console didn't itself launch, request_id is
    only THIS console instance's bookkeeping id, while run_id is hydrated
    from the job's own extra_vars (or None if unknown — see Operation.run_id's
    docstring). Auto-triggering against the wrong id would dispatch a
    rollback correlated to nothing real. Dedupe is via ``get_or_create``,
    not the exclusive variant: a concurrent MANUAL rollback of the same
    run_id (same action, same target) reattaches to whichever dispatch won
    the race, it never conflicts — there is nothing for it to conflict
    with at this target (a run_id, not a catalog key).

    Runs from inside the watcher (a background task, no ``Request``
    object) — the C5 audit line is hand-assembled here in the same
    "awx write:" shape ``_audit_awx_write`` emits, with actor
    "system:auto-rollback" and a ``linked_request_id`` trailing field
    tying it back to the failed deploy's own request_id for correlation.

    codex R2-3: the outcome is recorded on the deploy op's ``auto_rollback``
    field, kept SEPARATE from ``l3_outcome`` — ``l3_outcome`` always keeps
    the RAW launcher marker token (set moments earlier by the watcher's
    terminal-handling block) and is never overwritten here.

    * ``deploy_op.run_id is None`` (codex R3-3): identity unknown — never
      guess; no dispatch, ``auto_rollback="identity-unknown"``. The op
      stays FAILED_ROLLBACK_REQUIRED/RUN_STATUS_UNKNOWN for an operator to
      resolve manually (they can supply the real run_id once known — the
      rollback command itself doesn't require an Operation to exist).
    * ``settings.l3.auto_rollback`` False: no dispatch — the op stays
      FAILED_ROLLBACK_REQUIRED for an operator to act on;
      ``auto_rollback="disabled"``.
    * A concurrent rollback already owns this run_id (``created`` False,
      codex R2-8 — a prior manual POST, or a prior auto-trigger from a
      race on the same op): no new dispatch; ``auto_rollback=
      "already-in-progress"``. The audit line's ``request_id`` reflects the
      EXISTING rollback op's own identity, not the freshly-minted id this
      call generated and then discarded — that fresh id was never actually
      used for anything.
    * Otherwise: dispatch: ``auto_rollback="triggered"``.
    """
    settings = app.state.settings
    ops_store = app.state.operations

    deploy_op = ops_store.get(operation_id)
    if deploy_op is None:
        return

    if deploy_op.run_id is None:
        ops_store.update(operation_id, auto_rollback="identity-unknown")
        return

    if not settings.l3.auto_rollback:
        ops_store.update(operation_id, auto_rollback="disabled")
        return

    run_id = deploy_op.run_id
    fresh_request_id = uuid.uuid4().hex
    reason = f"auto: deploy {key} failed after start (failed_rollback_required)"

    rollback_op, created = ops_store.get_or_create(
        action="rollback", target=run_id,
        request_id=fresh_request_id, initiator="system:auto-rollback",
    )

    if not created:
        # codex R2-8: reattached to an already-in-progress rollback (manual
        # or a racing auto-trigger) — the fresh_request_id we minted above
        # was never persisted anywhere, so the audit line must cite the
        # EXISTING op's own request_id, not that discarded one.
        ops_store.update(operation_id, auto_rollback="already-in-progress")
        logger.info(
            "awx write: action=rollback actor=system:auto-rollback role=system real_role= "
            "request_id=%s target=%s reason=%r outcome=already-in-progress workload= capacity= linked_request_id=%s",
            rollback_op.request_id, run_id, reason, deploy_op.request_id,
        )
        return

    ops_store.update(operation_id, auto_rollback="triggered")

    logger.info(
        "awx write: action=rollback actor=system:auto-rollback role=system real_role= "
        "request_id=%s target=%s reason=%r outcome=auto-triggered workload= capacity= linked_request_id=%s",
        fresh_request_id, run_id, reason, deploy_op.request_id,
    )

    _spawn_rollback_task(app, rollback_op.operation_id, run_id, reason)


def _spawn_rollback_task(app: FastAPI, operation_id: str, run_id: str, reason: str) -> None:
    """Spawn _run_rollback_operation as a tracked background task."""
    task = asyncio.create_task(_run_rollback_operation(app, operation_id, run_id, reason))
    app.state.operation_tasks.add(task)
    task.add_done_callback(app.state.operation_tasks.discard)


async def _run_deploy_operation(
    app: FastAPI, operation_id: str, key: str, jt_name: str, workload: str | None = None,
    opposite_jt_name: str | None = None, l3_envelope: dict | None = None,
) -> None:
    """Background task to wake AWX and deploy a catalog entry.

    workload (#239) is the validated slug, if the operator supplied one; it
    rides through to AWX as extra_vars={"workload_slug": workload}.

    opposite_jt_name (#24) is the finalise (teardown) job template for this
    same catalog entry, if any — used for the cross-JT running-job guard
    below.

    l3_envelope (#202 WP1) is the capacity preflight's result, computed
    synchronously by the caller (api_catalog_deploy) BEFORE this background
    task is even spawned — the gate must refuse before dispatch, not after.
    Merged into extra_vars alongside workload_slug via
    _build_launch_extra_vars.
    """
    settings = app.state.settings
    ops_store = app.state.operations

    try:
        # Wake AWX (threadpooled to avoid blocking event loop)
        await run_in_threadpool(
            ensure_awx_awake,
            helper_url=settings.awx_autoscale.helper_url,
            bearer_token=settings.awx_autoscale.bearer_token,
            max_startup_wait=settings.awx_autoscale.max_startup_wait,
        )

        # Update state to launching
        ops_store.update(operation_id, state=OperationState.LAUNCHING)

        # Lookup job template
        template = await run_in_threadpool(
            call_with_transient_retry,
            functools.partial(
                lookup_job_template_by_name,
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=jt_name,
                ssl_verify=settings.awx.ssl_verify,
            ),
        )
        if template is None:
            ops_store.update(
                operation_id,
                state=OperationState.ERROR,
                error=f"AWX job template '{jt_name}' not found",
            )
            return

        # Check for existing active job (idempotency)
        active_job_id = await run_in_threadpool(
            find_active_job_for_template,
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            job_template_id=template["id"],
            ssl_verify=settings.awx.ssl_verify,
        )
        if active_job_id is not None:
            # codex R3-3: this is a REATTACH to an AWX job this console
            # didn't itself just launch — hydrate run_id from the job's own
            # extra_vars rather than assuming it's this op's request_id
            # (which is only this NEW dispatch attempt's bookkeeping id).
            run_id = None
            try:
                active_job_detail = await run_in_threadpool(
                    get_job,
                    api_url=settings.awx.api_url,
                    api_token=settings.awx.api_token,
                    job_id=active_job_id,
                    ssl_verify=settings.awx.ssl_verify,
                )
                run_id = _extract_run_id_from_job(active_job_detail, action="deploy")
            except Exception:
                pass  # identity stays unknown (None) — never guess
            ops_store.update(
                operation_id,
                state=OperationState.LAUNCHED,
                job_id=active_job_id,
                run_id=run_id,
            )
            _spawn_job_watcher(app, operation_id, active_job_id, "deploy", key)
            return

        # Cross-JT guard (#24): a teardown job for this same catalog entry may
        # be running under the finalise job template. Checked here, after the
        # own-JT idempotency reattach (unchanged) and before launch. Plain
        # lookup, not the transient-retry wrapper — this isn't the first
        # post-wake AWX call. Residual check-to-launch TOCTOU window; the
        # AWX-layer concurrency cap (umbrella #254) is the backstop, not
        # closed here.
        if opposite_jt_name:
            opposite_template = await run_in_threadpool(
                lookup_job_template_by_name,
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=opposite_jt_name,
                ssl_verify=settings.awx.ssl_verify,
            )
            if opposite_template is not None:
                opposite_active = await run_in_threadpool(
                    find_active_job_for_template,
                    api_url=settings.awx.api_url,
                    api_token=settings.awx.api_token,
                    job_template_id=opposite_template["id"],
                    ssl_verify=settings.awx.ssl_verify,
                )
                if opposite_active is not None:
                    ops_store.update(
                        operation_id,
                        state=OperationState.ERROR,
                        error="Conflicting lifecycle operation in progress",
                    )
                    return
            else:
                logger.debug(
                    "Opposite job template '%s' not found in AWX; skipping cross-JT guard for deploy operation %s",
                    opposite_jt_name, operation_id,
                )

        # Launch job
        job_id = await run_in_threadpool(
            launch_job,
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            job_template_id=template["id"],
            ssl_verify=settings.awx.ssl_verify,
            extra_vars=_build_launch_extra_vars(workload, l3_envelope),
        )

        # codex R3-3: a FRESH dispatch's run identity IS its own
        # request_id, set explicitly here — not round-tripped through
        # extra_vars (that's only needed for reattach, above).
        op = ops_store.get(operation_id)
        ops_store.update(
            operation_id,
            state=OperationState.LAUNCHED,
            job_id=job_id,
            run_id=(op.request_id if op is not None else None),
        )
        _spawn_job_watcher(app, operation_id, job_id, "deploy", key)
    except AWXAutoscaleError as exc:
        # Log raw error server-side only, sanitize for client
        logger.error("AWX autoscale error in deploy operation %s: %s", operation_id, exc.body)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="AWX wake failed",
        )
    except AWXAPIError as exc:
        # Log raw error server-side only, sanitize for client
        logger.error("AWX API error in deploy operation %s: %s", operation_id, exc.body)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="AWX API error while deploying",
        )
    except urllib.error.URLError as exc:
        logger.error("AWX unreachable in deploy operation %s: %s", operation_id, exc.reason)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="AWX unreachable while deploying",
        )
    except Exception as exc:
        logger.exception("Unexpected error in deploy operation %s", operation_id)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="Unexpected error while deploying",
        )


async def _run_teardown_operation(
    app: FastAPI, operation_id: str, key: str, jt_name: str,
    opposite_jt_name: str | None = None,
) -> None:
    """Background task to wake AWX and teardown a catalog entry.

    opposite_jt_name (#24) is the configure (deploy) job template for this
    same catalog entry, if any — used for the cross-JT running-job guard
    below.
    """
    settings = app.state.settings
    ops_store = app.state.operations

    try:
        # Wake AWX (threadpooled to avoid blocking event loop)
        await run_in_threadpool(
            ensure_awx_awake,
            helper_url=settings.awx_autoscale.helper_url,
            bearer_token=settings.awx_autoscale.bearer_token,
            max_startup_wait=settings.awx_autoscale.max_startup_wait,
        )

        # Update state to launching
        ops_store.update(operation_id, state=OperationState.LAUNCHING)

        # Lookup job template
        template = await run_in_threadpool(
            call_with_transient_retry,
            functools.partial(
                lookup_job_template_by_name,
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=jt_name,
                ssl_verify=settings.awx.ssl_verify,
            ),
        )
        if template is None:
            ops_store.update(
                operation_id,
                state=OperationState.ERROR,
                error=f"AWX job template '{jt_name}' not found",
            )
            return

        # Check for existing active job (idempotency)
        active_job_id = await run_in_threadpool(
            find_active_job_for_template,
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            job_template_id=template["id"],
            ssl_verify=settings.awx.ssl_verify,
        )
        if active_job_id is not None:
            # codex R3-3: reattach — hydrate run_id from the job's own
            # extra_vars (see the matching comment in _run_deploy_operation).
            run_id = None
            try:
                active_job_detail = await run_in_threadpool(
                    get_job,
                    api_url=settings.awx.api_url,
                    api_token=settings.awx.api_token,
                    job_id=active_job_id,
                    ssl_verify=settings.awx.ssl_verify,
                )
                run_id = _extract_run_id_from_job(active_job_detail, action="teardown")
            except Exception:
                pass
            ops_store.update(
                operation_id,
                state=OperationState.LAUNCHED,
                job_id=active_job_id,
                run_id=run_id,
            )
            _spawn_job_watcher(app, operation_id, active_job_id, "teardown", key)
            return

        # Cross-JT guard (#24, symmetric with deploy): a deploy job for this
        # same catalog entry may be running under the configure job template.
        # Checked here, after the own-JT idempotency reattach (unchanged) and
        # before launch. Plain lookup, not the transient-retry wrapper — this
        # isn't the first post-wake AWX call. Residual check-to-launch TOCTOU
        # window; the AWX-layer concurrency cap (umbrella #254) is the
        # backstop, not closed here.
        if opposite_jt_name:
            opposite_template = await run_in_threadpool(
                lookup_job_template_by_name,
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=opposite_jt_name,
                ssl_verify=settings.awx.ssl_verify,
            )
            if opposite_template is not None:
                opposite_active = await run_in_threadpool(
                    find_active_job_for_template,
                    api_url=settings.awx.api_url,
                    api_token=settings.awx.api_token,
                    job_template_id=opposite_template["id"],
                    ssl_verify=settings.awx.ssl_verify,
                )
                if opposite_active is not None:
                    ops_store.update(
                        operation_id,
                        state=OperationState.ERROR,
                        error="Conflicting lifecycle operation in progress",
                    )
                    return
            else:
                logger.debug(
                    "Opposite job template '%s' not found in AWX; skipping cross-JT guard for teardown operation %s",
                    opposite_jt_name, operation_id,
                )

        # Launch job
        job_id = await run_in_threadpool(
            launch_job,
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            job_template_id=template["id"],
            ssl_verify=settings.awx.ssl_verify,
        )

        # codex R3-3: fresh dispatch — run_id is this op's own request_id.
        op = ops_store.get(operation_id)
        ops_store.update(
            operation_id,
            state=OperationState.LAUNCHED,
            job_id=job_id,
            run_id=(op.request_id if op is not None else None),
        )
        _spawn_job_watcher(app, operation_id, job_id, "teardown", key)
    except AWXAutoscaleError as exc:
        # Log raw error server-side only, sanitize for client
        logger.error("AWX autoscale error in teardown operation %s: %s", operation_id, exc.body)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="AWX wake failed",
        )
    except AWXAPIError as exc:
        # Log raw error server-side only, sanitize for client
        logger.error("AWX API error in teardown operation %s: %s", operation_id, exc.body)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="AWX API error while tearing down",
        )
    except urllib.error.URLError as exc:
        logger.error("AWX unreachable in teardown operation %s: %s", operation_id, exc.reason)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="AWX unreachable while tearing down",
        )
    except Exception as exc:
        logger.exception("Unexpected error in teardown operation %s", operation_id)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="Unexpected error while tearing down",
        )


async def _run_rollback_operation(app: FastAPI, operation_id: str, run_id: str, reason: str) -> None:
    """Background task to wake AWX and launch the rollback command for a run
    (umbrella #202 WP2, plan §4.5/§4.6).

    Simpler than _run_deploy_operation/_run_teardown_operation: rollback
    targets a run_id, not a catalog entry, so there's no per-entry cross-JT
    guard and no L3 capacity preflight (this is recovery, not new demand).
    ``settings.l3.rollback_jt_name`` must be a REGISTERED AWX job template
    (WP3 lands the actual play) — its absence is a loud ERROR, never a
    silent no-op skip.

    The ``l3_request_id`` threaded into extra_vars is the dispatching op's
    OWN ``request_id`` (codex R2-7 — a prior draft minted a fresh id here;
    that made the launcher-side extra_vars and the console's own audited/
    dispatched request_id diverge for no reason). Falls back to a fresh
    mint only if the op has somehow already been GC'd out from under this
    background task by the time this runs (defensive, shouldn't happen —
    the op is non-terminal for the op's own lifetime).
    """
    settings = app.state.settings
    ops_store = app.state.operations

    try:
        await run_in_threadpool(
            ensure_awx_awake,
            helper_url=settings.awx_autoscale.helper_url,
            bearer_token=settings.awx_autoscale.bearer_token,
            max_startup_wait=settings.awx_autoscale.max_startup_wait,
        )

        ops_store.update(operation_id, state=OperationState.LAUNCHING)

        template = await run_in_threadpool(
            call_with_transient_retry,
            functools.partial(
                lookup_job_template_by_name,
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=settings.l3.rollback_jt_name,
                ssl_verify=settings.awx.ssl_verify,
            ),
        )
        if template is None:
            ops_store.update(
                operation_id,
                state=OperationState.ERROR,
                error="rollback-jt-not-registered",
            )
            return

        op = ops_store.get(operation_id)
        l3_request_id = op.request_id if (op is not None and op.request_id) else uuid.uuid4().hex

        job_id = await run_in_threadpool(
            launch_job,
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            job_template_id=template["id"],
            ssl_verify=settings.awx.ssl_verify,
            extra_vars={
                "l3_run_id": run_id,
                "l3_rollback_reason": reason,
                "l3_request_id": l3_request_id,
            },
        )

        # codex R3-3: rollback ops never reattach (no active-job idempotency
        # check exists for this action) — always a fresh dispatch, so
        # this OP's OWN run_id field (distinct from the `run_id` param
        # above, which is the DEPLOY's identity this rollback targets) is
        # simply its own request_id.
        ops_store.update(operation_id, state=OperationState.LAUNCHED, job_id=job_id, run_id=l3_request_id)
        _spawn_job_watcher(app, operation_id, job_id, "rollback", run_id)
    except AWXAutoscaleError as exc:
        logger.error("AWX autoscale error in rollback operation %s: %s", operation_id, exc.body)
        ops_store.update(operation_id, state=OperationState.ERROR, error="AWX wake failed")
    except AWXAPIError as exc:
        logger.error("AWX API error in rollback operation %s: %s", operation_id, exc.body)
        ops_store.update(operation_id, state=OperationState.ERROR, error="AWX API error while rolling back")
    except urllib.error.URLError as exc:
        logger.error("AWX unreachable in rollback operation %s: %s", operation_id, exc.reason)
        ops_store.update(operation_id, state=OperationState.ERROR, error="AWX unreachable while rolling back")
    except Exception:
        logger.exception("Unexpected error in rollback operation %s", operation_id)
        ops_store.update(operation_id, state=OperationState.ERROR, error="Unexpected error while rolling back")


def create_app(settings: Settings | None = None, contract: AppContract | None = None) -> FastAPI:
    settings = settings or load_settings()
    if settings.runtime_mode != "local":
        if settings.dev_login_enabled:
            raise RuntimeError("DMF_CONSOLE_DEV_LOGIN_ENABLED is only allowed in local runtime mode")
        if not settings.oidc.configured:
            raise RuntimeError("Authentik OIDC must be configured when DMF_CONSOLE_RUNTIME_MODE is not local")
    contract = contract or load_app_contract(settings.app_contract_path)

    app = FastAPI(
        title=settings.display_name,
        docs_url=None,
        redoc_url=None,
        root_path=settings.base_path if settings.base_path != "/" else "",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.contract = contract
    # Per-app 5s TTL cache of the scope-filtered service list, so the live-view
    # endpoints (polled per-tile) don't re-query NetBox on every tick (WP-D).
    scoped_service_cache = media_workloads.ScopedServiceCache()
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")
    if settings.base_path != "/":
        app.add_middleware(BasePathMiddleware, base_path=settings.base_path)
    app.add_middleware(SessionMiddleware, secret_key=settings.secret_key, same_site="lax", https_only=False)
    app.mount("/static", StaticFiles(directory=str(PACKAGE_ROOT / "static"), check_dir=False), name="static")

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "product": settings.display_name,
                "apps": len(contract.apps),
                "auth_mode": "oidc" if settings.oidc.configured else "dev-login",
            }
        )

    @app.get("/auth/login", response_class=HTMLResponse, name="login")
    async def login(request: Request):
        if settings.oidc.configured:
            discovery = discovery_document(settings.oidc)
            state = new_state()
            nonce = new_state()
            code_verifier = new_pkce_verifier()
            request.session["oidc_state"] = state
            request.session["oidc_nonce"] = nonce
            request.session["oidc_code_verifier"] = code_verifier
            redirect_uri = str(request.url_for("oidc_callback"))
            return RedirectResponse(
                url=build_authorize_url(
                    discovery,
                    settings.oidc,
                    redirect_uri,
                    state,
                    nonce,
                    pkce_challenge(code_verifier),
                ),
                status_code=302,
            )

        if settings.dev_login_enabled:
            store_user(request.session, dev_user(settings))
            return RedirectResponse(url=_base_path_url("/", settings), status_code=302)

        # OIDC not configured and dev login disabled — show error
        return HTMLResponse(
            content=(
                '<!doctype html><html lang="en"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>Login unavailable</title>'
                '<style>body{background:#0b121f;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}'
                '.card{background:#151e2d;border:1px solid #1f2937;border-radius:.5rem;padding:2rem;text-align:center;max-width:400px}'
                'h1{font-size:1.25rem;margin-bottom:.5rem}p{color:#9ca3af;font-size:.875rem;margin-bottom:1rem}'
                'a{color:#3b82f6;font-size:.875rem}</style></head><body>'
                '<div class="card"><h1>Login unavailable</h1>'
                '<p>Authentik OIDC is not configured for this environment. Configure OIDC or enable dev login for local development.</p>'
                '<a href="/auth/login">Retry</a></div></body></html>'
            ),
            status_code=503,
        )

    @app.get("/auth/logout", response_class=HTMLResponse, name="logout")
    async def logout(request: Request):
        request.session.clear()
        # Use an intermediate HTML page so the cleared-session cookie is set
        # on console.<domain> before the browser leaves this domain.
        # A direct 302 to an external URL may not persist the cookie update.
        # Fallback to "/" (current origin root) — never hardcode a domain
        # that may be stale (e.g. the dmf.example.com placeholder).
        landing = settings.oidc.logout_redirect_url or "/"
        # RP-initiated logout: route the browser through the IdP end-session
        # endpoint so the *SSO* session is terminated, not merely the console
        # session — otherwise Authentik's session survives and the next login is
        # silent (handoff §5b). We deliberately do NOT pass id_token_hint: that
        # would require persisting the id_token in the client-side signed session
        # cookie (browser-stored token material + cookie bloat, codex WP-E P2).
        # RP logout rides client_id + post_logout_redirect_uri instead — the IdP
        # shows a confirm interstitial but the SSO session is still terminated.
        # Falls back to the plain landing when OIDC is unconfigured or the IdP
        # advertises no end-session endpoint.
        if settings.oidc.configured:
            try:
                discovery = discovery_document(settings.oidc)
                end_session = build_end_session_url(
                    discovery,
                    settings.oidc,
                    post_logout_redirect_uri=landing,
                )
                if end_session:
                    landing = end_session
            except Exception as exc:  # discovery fetch / parse is best-effort
                logger.warning("logout: could not build end-session URL, using plain landing: %s", exc)
        return HTMLResponse(
            content=(
                f'<!doctype html><html><head><meta charset="utf-8">'
                f'<meta http-equiv="refresh" content="0;url={landing}">'
                f'<title>Logging out…</title>'
                f'<style>body{{background:#0b121f;color:#e2e8f0;font-family:sans-serif;'
                f'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}}'
                f'.msg{{text-align:center}}h1{{font-size:1.25rem;margin-bottom:.5rem}}'
                f'p{{color:#9ca3af;font-size:.875rem}}</style></head><body>'
                f'<div class="msg"><h1>Logging out…</h1>'
                f'<p>If you are not redirected, <a href="{landing}" style="color:#3b82f6">click here</a>.</p></div>'
                f'</body></html>'
            ),
            status_code=200,
        )

    @app.get("/auth/callback", response_class=HTMLResponse, name="oidc_callback")
    async def oidc_callback(request: Request, code: str | None = None, state: str | None = None):
        if not settings.oidc.configured:
            return RedirectResponse(url="/auth/login", status_code=302)
        if not code or not state or request.session.get("oidc_state") != state:
            return RedirectResponse(url="/auth/login", status_code=302)

        discovery = discovery_document(settings.oidc)
        code_verifier = str(request.session.get("oidc_code_verifier", ""))
        token = exchange_code_for_token(
            discovery,
            settings.oidc,
            code,
            str(request.url_for("oidc_callback")),
            code_verifier or None,
        )
        access_token = str(token.get("access_token", ""))
        if not access_token:
            return RedirectResponse(url="/", status_code=302)
        claims = fetch_userinfo(discovery, access_token)
        store_user(request.session, user_from_claims(claims))
        return RedirectResponse(url=_base_path_url("/", settings), status_code=302)

    @app.post("/api/admin/invitations")
    async def create_passkey_invitation(request: Request):
        # Admin-surface action: gate on the effective admin role (GATE-G24 —
        # closes both a pre-existing under-gate, where any authenticated user
        # could reach it, and the view-as escape). effective_user keeps the
        # caller's subject/email/display_name; view-as only lowers the role.
        user, err = _require_min_role(request, "admin")
        if err is not None:
            return err

        if not settings.authentik.configured:
            return JSONResponse({"error": "authentik API not configured"}, status_code=503)

        if not settings.authentik.enrollment_flow_slug:
            return JSONResponse({"error": "no enrollment flow configured"}, status_code=503)

        try:
            result = create_invitation(
                api_url=settings.authentik.api_url,
                api_token=settings.authentik.api_token,
                flow_slug=settings.authentik.enrollment_flow_slug,
                username=user.subject,
                email=user.email,
                display_name=user.display_name,
                ttl_hours=settings.authentik.invitation_ttl_hours,
                public_base_url=settings.authentik.enrollment_base_url,
            )
            return JSONResponse({
                "enrollment_url": result["enrollment_url"],
                "expires": result["expires"],
            })
        except AuthentikAPIError as exc:
            return JSONResponse({"error": f"authentik API error: {exc.body}"}, status_code=exc.status)

    # ------------------------------------------------------------------
    # Async operation tracking endpoints
    # ------------------------------------------------------------------
    @app.get("/api/operations/{operation_id}")
    async def api_operation_status(request: Request, operation_id: str):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        op = request.app.state.operations.get(operation_id)
        if op is None:
            return JSONResponse({"error": "operation not found"}, status_code=404)
        return JSONResponse(op.to_dict())

    # ------------------------------------------------------------------
    # AWX workflow endpoints
    # ------------------------------------------------------------------
    @app.get("/api/workflows")
    async def api_workflows_list(request: Request):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.awx.configured:
            return JSONResponse({"error": "AWX API not configured"}, status_code=503)
        # Default: the catalog-launcher allow-list only, so internal/spike AWX
        # templates never render on any default surface (Art. 3). An ADMIN may
        # opt into the full, unfiltered AWX inventory (the expert view) with
        # ?all=true — nothing is lost, it just isn't the default. A non-admin
        # passing ?all=true is still filtered (fail-closed).
        want_all = request.query_params.get("all", "").strip().lower() in ("1", "true", "yes")
        user = effective_user(request.session)
        show_all = want_all and user is not None and role_at_least(user.role, "admin")
        try:
            templates = list_job_templates(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                ssl_verify=settings.awx.ssl_verify,
            )
            if not show_all:
                allowed = _catalog_launcher_jt_names()
                templates = [t for t in templates if t.get("name") in allowed]
            return JSONResponse({
                "filtered": not show_all,
                "templates": [
                    {
                        "id": t["id"],
                        "name": t["name"],
                        "description": t.get("description", ""),
                        "type": t.get("type", "job_template"),
                    }
                    for t in templates
                ]
            })
        except AWXAPIError as exc:
            return JSONResponse({"error": f"AWX API error: {exc.body}"}, status_code=exc.status)

    @app.post("/api/workflows/{workflow_name}/launch")
    async def api_workflow_launch(request: Request, workflow_name: str):
        # Operator+ gate (was login-only — a viewer could launch by curl).
        user, err = _require_min_role(request, "operator")
        if err is not None:
            return err
        assert user is not None
        # C5: validate reason + allocate request_id BEFORE any early return
        # (incl. the config 503s) so EVERY post-auth path is audited and echoes
        # request_id, and a missing reason is a 400 even when AWX is dark.
        reason, rerr = await _require_reason(request)
        if rerr is not None:
            return rerr
        assert reason is not None
        request_id = uuid.uuid4().hex
        if not settings.awx.configured:
            _audit_awx_write(request, user, action="launch", target=workflow_name, request_id=request_id, reason=reason, outcome="awx-not-configured")
            return JSONResponse({"error": "AWX API not configured", "request_id": request_id}, status_code=503)
        # #24: a catalog lifecycle JT (configure/finalise) launched through
        # this generic endpoint must resolve to the SAME per-entry lock as
        # /api/catalog/{key}/deploy|teardown — see _catalog_jt_lifecycle_map.
        # Applies uniformly ahead of the async/sync split below, since
        # ambiguity is a static catalog-data property independent of
        # autoscale configuration.
        lifecycle_jt_map, ambiguous_lifecycle_jts = _catalog_jt_lifecycle_map()
        if workflow_name in ambiguous_lifecycle_jts:
            # Fail-closed (codex GATE-24R2 finding 1): refuse rather than
            # guess which catalog entry/action this JT name belongs to.
            # Never falls through to the plain launch path below — that
            # would reintroduce the #24 bypass for exactly the ambiguous JTs.
            _audit_awx_write(request, user, action="launch", target=workflow_name, request_id=request_id, reason=reason, outcome="ambiguous-lifecycle-jt")
            return JSONResponse(
                {"error": "ambiguous catalog lifecycle mapping for this job template", "request_id": request_id},
                status_code=500,
            )
        lifecycle = lifecycle_jt_map.get(workflow_name)

        # codex R2-2: a JT that maps to a catalog lifecycle action is
        # REFUSED here outright — the #202 WP2 run-tracking/facility-lock/
        # auto-rollback machinery only exists on the catalog endpoints
        # (/api/catalog/{key}/deploy|teardown, /api/runs/{run_id}/rollback).
        # A prior WP2-B draft instead dispatched a mapped JT through this
        # generic endpoint using the SAME per-entry lock (#24's fix) but
        # WITHOUT any of #202's tracking/lock/rollback wiring — a working
        # bypass around every WP2 guarantee for exactly the JTs those
        # guarantees exist to protect. Applies regardless of autoscale mode
        # (checked before the async/sync split). Non-lifecycle JTs
        # (Activity lane's generic launches, internal/spike templates) are
        # entirely untouched — this only refuses JTs the catalog itself
        # declares as a configure/finalise stage.
        if lifecycle is not None:
            catalog_key, mapped_action, _opposite_jt_name = lifecycle
            _audit_awx_write(request, user, action=mapped_action, target=catalog_key, request_id=request_id, reason=reason, outcome="lifecycle-jt-refused")
            return JSONResponse(
                {"error": "use-catalog-endpoint", "catalog_key": catalog_key, "request_id": request_id},
                status_code=409,
            )

        # Async operation flow (when autoscale enabled)
        if settings.awx_autoscale.enabled:
            if not settings.awx_autoscale.configured:
                _audit_awx_write(request, user, action="launch", target=workflow_name, request_id=request_id, reason=reason, outcome="autoscale-misconfigured")
                return JSONResponse({"error": "AWX autoscale enabled but misconfigured", "request_id": request_id}, status_code=503)

            ops_store = request.app.state.operations

            # Atomic dedupe: find existing or create new under one lock
            op, created = ops_store.get_or_create(
                action="launch", target=workflow_name,
                request_id=request_id, initiator=user.subject,
            )

            if not created:
                # Existing operation found - return it without spawning new task
                # v1 behavior: browser refresh loses live spinner but re-clicking
                # safely reattaches via get_or_create (no double launch)
                _audit_awx_write(request, user, action="launch", target=workflow_name, request_id=request_id, reason=reason, outcome="reattached")
                return JSONResponse({**op.to_dict(), "request_id": request_id}, status_code=200)

            # Spawn background task with tracking
            task = asyncio.create_task(_run_launch_operation(
                request.app, op.operation_id, workflow_name
            ))
            request.app.state.operation_tasks.add(task)
            task.add_done_callback(request.app.state.operation_tasks.discard)

            _audit_awx_write(request, user, action="launch", target=workflow_name, request_id=request_id, reason=reason, outcome="dispatched")
            return JSONResponse({**op.to_dict(), "request_id": request_id}, status_code=202)

        # Sync flow (autoscale disabled)
        try:
            template = lookup_job_template_by_name(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=workflow_name,
                ssl_verify=settings.awx.ssl_verify,
            )
            if template is None:
                _audit_awx_write(request, user, action="launch", target=workflow_name, request_id=request_id, reason=reason, outcome="not-found")
                return JSONResponse({"error": f"workflow '{workflow_name}' not found in AWX", "request_id": request_id}, status_code=404)

            # codex R2-2: lifecycle-mapped JTs are refused above, before the
            # async/sync split — by construction, `lifecycle` is always
            # None here. Non-catalog JTs only.
            job_id = launch_job(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
            )
            _audit_awx_write(request, user, action="launch", target=workflow_name, request_id=request_id, reason=reason, outcome="launched")
            return JSONResponse({"job_id": job_id, "status": "launched", "request_id": request_id})
        except AWXAPIError as exc:
            _audit_awx_write(request, user, action="launch", target=workflow_name, request_id=request_id, reason=reason, outcome=f"awx-error:{exc.status}")
            return JSONResponse({"error": f"AWX API error: {exc.body}", "request_id": request_id}, status_code=exc.status)

    @app.get("/api/workflows/jobs/{job_id}")
    async def api_workflow_job_status(request: Request, job_id: int):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.awx.configured:
            return JSONResponse({"error": "AWX API not configured"}, status_code=503)
        try:
            info = get_job_status(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_id=job_id,
                ssl_verify=settings.awx.ssl_verify,
            )
            return JSONResponse({
                "job_id": info.job_id,
                "status": info.status,
                "name": info.name,
                "url": info.url,
                "elapsed": info.elapsed,
                "failed": info.failed,
            })
        except AWXAPIError as exc:
            return JSONResponse({"error": f"AWX API error: {exc.body}"}, status_code=exc.status)

    # ------------------------------------------------------------------
    # User and contract API endpoints (for React frontend)
    # ------------------------------------------------------------------
    @app.get("/api/me")
    async def api_current_user(request: Request):
        real = session_user(request.session)
        if real is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        user = effective_user(request.session)
        assert user is not None  # non-None whenever real is non-None
        return JSONResponse({
            "subject": user.subject,
            "display_name": user.display_name,
            "email": user.email,
            # role is always the EFFECTIVE role (what gates enforce + nav shows);
            # real_role is the identity's true ceiling; view_as_active flags the
            # simulated downgrade so the UI can surface the reset affordance.
            "role": user.role,
            "real_role": real.role,
            "view_as_active": user.role != real.role,
            "groups": user.groups,
            "awx_configured": settings.awx.configured,
            "authentik_configured": settings.authentik.configured,
        })

    @app.post("/api/me/view-as")
    async def api_set_view_as(request: Request):
        """Admin-only, session-scoped, strictly-downgrade role simulation.

        Authorizes against the REAL user (never the effective one) so the
        gate can't be escaped or re-entered from inside a downgrade. Groups
        stay real; only the role is simulated (ADR-0028-safe).
        """
        real = session_user(request.session)
        if real is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if real.role != "admin":
            return JSONResponse({"error": "forbidden"}, status_code=403)
        try:
            body = await request.json()
        except Exception:
            body = None
        role = (body or {}).get("role")
        if not isinstance(role, str) or role not in VIEW_AS_ROLES:
            # Rejects admin (not a downgrade) and any unknown role — fail closed.
            return JSONResponse(
                {"error": "invalid-role", "detail": f"role must be one of {sorted(VIEW_AS_ROLES)}"},
                status_code=400,
            )
        request.session["view_as"] = role
        request_id = uuid.uuid4().hex
        # C5 audit line (actor / real role / request-id / simulated role),
        # mirroring the clear-for-deployment record.
        logger.info(
            "view-as set: actor=%s real_role=%s view_as=%s request_id=%s",
            real.subject,
            real.role,
            role,
            request_id,
        )
        return JSONResponse({
            "role": role,
            "real_role": real.role,
            "view_as_active": True,
            "request_id": request_id,
        })

    @app.delete("/api/me/view-as")
    async def api_clear_view_as(request: Request):
        """Reset an active view-as. Authorizes against the REAL user so reset
        works while downgraded (an effective-viewer admin can still reset)."""
        real = session_user(request.session)
        if real is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        request.session.pop("view_as", None)
        request_id = uuid.uuid4().hex
        logger.info(
            "view-as cleared: actor=%s real_role=%s request_id=%s",
            real.subject,
            real.role,
            request_id,
        )
        return JSONResponse({
            "role": real.role,
            "real_role": real.role,
            "view_as_active": False,
            "request_id": request_id,
        })

    @app.get("/api/contract")
    async def api_get_contract(request: Request):
        user = session_user(request.session)
        if user is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse({
            "product_name": contract.product_name,
            "facility_name": contract.facility_name,
            "catalog_source": contract.catalog_source,
            "apps": [
                {
                    "key": app.key,
                    "display_name": app.display_name,
                    "lane": app.lane,
                    "summary": app.summary,
                    "links": [{"name": link.name, "url": link.url} for link in app.deep_links],
                }
                for app in contract.apps
            ],
        })

    # ------------------------------------------------------------------
    # Admin dashboard endpoints (role: admin only)
    # ------------------------------------------------------------------
    @app.get("/api/admin/health")
    async def api_admin_health(request: Request):
        # Effective-role gate: an admin under an active view-as downgrade is
        # 403 here too, so the admin surface can't be reached from inside a
        # downgrade (WP-B: enforced server-side, not just in the nav).
        _, err = _require_min_role(request, "admin")
        if err is not None:
            return err

        def _ping_authentik() -> dict:
            if not settings.authentik.configured:
                return {"connected": False, "note": "Not configured"}
            try:
                t0 = time.monotonic()
                users = list_users(
                    api_url=settings.authentik.api_url,
                    api_token=settings.authentik.api_token,
                )
                ms = round((time.monotonic() - t0) * 1000)
                return {"connected": True, "latency_ms": ms, "user_count": len(users)}
            except AuthentikAPIError as exc:
                return {"connected": False, "error": str(exc)}

        def _ping_awx() -> dict:
            if not settings.awx.configured:
                return {"connected": False, "note": "Not configured"}
            try:
                t0 = time.monotonic()
                templates = list_job_templates(
                    api_url=settings.awx.api_url,
                    api_token=settings.awx.api_token,
                    ssl_verify=settings.awx.ssl_verify,
                )
                ms = round((time.monotonic() - t0) * 1000)
                return {"connected": True, "latency_ms": ms, "template_count": len(templates)}
            except AWXAPIError as exc:
                return {"connected": False, "error": str(exc)}

        def _ping_netbox() -> dict:
            if not settings.netbox.configured:
                return {"connected": False, "note": "Not configured"}
            try:
                t0 = time.monotonic()
                netbox.ping(
                    api_url=settings.netbox.api_url,
                    api_token=settings.netbox.api_token,
                    ssl_verify=settings.netbox.ssl_verify,
                )
                ms = round((time.monotonic() - t0) * 1000)
                return {"connected": True, "latency_ms": ms}
            except netbox.NetboxAPIError as exc:
                return {"connected": False, "error": str(exc)}
            except Exception as exc:
                return {"connected": False, "error": str(exc)}

        def _ping_prometheus() -> dict:
            if not settings.prometheus.configured:
                return {"connected": False, "note": "Not configured"}
            try:
                t0 = time.monotonic()
                prometheus.ping(url=settings.prometheus.url)
                ms = round((time.monotonic() - t0) * 1000)
                return {"connected": True, "latency_ms": ms}
            except prometheus.PrometheusAPIError as exc:
                return {"connected": False, "error": str(exc)}
            except Exception as exc:
                return {"connected": False, "error": str(exc)}

        return JSONResponse({
            "authentik": _ping_authentik(),
            "awx": _ping_awx(),
            "netbox": _ping_netbox(),
            "prometheus": _ping_prometheus(),
        })

    @app.get("/api/admin/users")
    async def api_admin_users(request: Request):
        # Effective-role gate: an admin under an active view-as downgrade is
        # 403 here too, so the admin surface can't be reached from inside a
        # downgrade (WP-B: enforced server-side, not just in the nav).
        _, err = _require_min_role(request, "admin")
        if err is not None:
            return err
        if not settings.authentik.configured:
            return JSONResponse({"error": "Authentik not configured"}, status_code=503)

        raw_users = list_users(
            api_url=settings.authentik.api_url,
            api_token=settings.authentik.api_token,
        )

        def _dmf_role(group_names: set[str]) -> str:
            for role in reversed(ROLE_ORDER):
                if group_names & ROLE_GROUPS[role]:
                    return role
            return "viewer"

        def _user_type(raw_type: str) -> str:
            # human = a person's login; machine = a service/automation principal.
            # Fail-safe default for unknown/missing type is "machine": a novel
            # Authentik type is far more likely a new automation kind than a new
            # human kind, and mislabeling a machine as human is the worse failure
            # (it invites casual trust of a non-human principal). So anything not
            # explicitly a known human type stays on the machine side.
            if raw_type in _HUMAN_USER_TYPES:
                return "human"
            return "machine"

        users_out = []
        for u in raw_users:
            if not u.get("is_active", True):
                continue
            group_names = {g.get("name", "") for g in u.get("groups_obj", [])}
            username = u.get("username", "")
            users_out.append({
                "username": username,
                "display_name": u.get("name", ""),
                "email": u.get("email", ""),
                "role": _dmf_role(group_names),
                "last_login": u.get("last_login"),
                "is_active": u.get("is_active", True),
                "user_type": _user_type(u.get("type", "")),
                # ADR-0028 C4: break-glass is a sanctioned exception, never a
                # routine role — flag it so the UI can mark it distinctly.
                # Two independent signals: a known username anchor (akadmin)
                # and membership in the platform-seeded break-glass group (the
                # dmf-infra-seeded rescue admin need not be named "akadmin").
                "is_break_glass": (
                    username in BREAK_GLASS_USERNAMES
                    or BREAK_GLASS_GROUP in group_names
                ),
            })

        return JSONResponse({"users": users_out})

    @app.get("/api/admin/jobs")
    async def api_admin_jobs(request: Request):
        # Effective-role gate: an admin under an active view-as downgrade is
        # 403 here too, so the admin surface can't be reached from inside a
        # downgrade (WP-B: enforced server-side, not just in the nav).
        _, err = _require_min_role(request, "admin")
        if err is not None:
            return err
        if not settings.awx.configured:
            return JSONResponse({"jobs": []})

        raw_jobs = list_recent_jobs(
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            ssl_verify=settings.awx.ssl_verify,
        )

        # Mirror the /api/workflows contract: filtered to catalog launchers by
        # default; an admin (this endpoint is already admin-gated on the
        # effective role, so a view-as downgrade is 403 above) may opt into the
        # full history with ?all=true. Response carries filtered:bool.
        want_all = request.query_params.get("all", "").strip().lower() in ("1", "true", "yes")
        if not want_all:
            allowed = _catalog_launcher_jt_names()
            raw_jobs = [j for j in raw_jobs if j.get("name", "") in allowed]

        jobs_out = [
            {
                "id": j.get("id"),
                "name": j.get("name", ""),
                "status": j.get("status", ""),
                "started": j.get("started"),
                "finished": j.get("finished"),
                "elapsed": j.get("elapsed", 0.0),
                "failed": j.get("failed", False),
            }
            for j in raw_jobs
        ]

        return JSONResponse({"filtered": not want_all, "jobs": jobs_out})

    # ------------------------------------------------------------------
    # Admin groups endpoint
    # ------------------------------------------------------------------
    @app.get("/api/admin/groups")
    async def api_admin_groups(request: Request):
        # Effective-role gate: an admin under an active view-as downgrade is
        # 403 here too, so the admin surface can't be reached from inside a
        # downgrade (WP-B: enforced server-side, not just in the nav).
        _, err = _require_min_role(request, "admin")
        if err is not None:
            return err
        if not settings.authentik.configured:
            return JSONResponse({"groups": []})

        try:
            groups_data = list_groups(
                api_url=settings.authentik.api_url,
                api_token=settings.authentik.api_token,
            )
            groups = []
            for g in groups_data:
                users = g.get("users_obj", [])
                groups.append({
                    "pk": g.get("pk"),
                    "name": g.get("name"),
                    "user_count": len(users),
                    "users": [
                        {"username": u.get("username"), "display_name": u.get("name")}
                        for u in users
                    ],
                })
            return JSONResponse({"groups": groups})
        except AuthentikAPIError as exc:
            return JSONResponse(
                {"error": f"Authentik API error: {exc.body}"},
                status_code=exc.status,
            )

    # ------------------------------------------------------------------
    # Monitoring endpoints
    # ------------------------------------------------------------------
    @app.get("/api/workspace/health")
    async def api_workspace_health(request: Request):
        """Workspace "are we OK?" core signal (#174 WP2).

        Reads the live alert set (the #166 suite) via the Prometheus alerts
        API — labels AND annotations, unlike the raw ``ALERTS`` series — and
        flattens it to the console contract. Fail-soft by design: every
        outcome is a 200 with an explicit state; the three non-OK states
        (not configured / unreachable / no Watchdog) are content, never raw
        errors (Constitution Arts. 1+8). The always-firing Watchdog alert is
        the pipeline-liveness proof that lets a zero-alert answer render as
        *verified* green instead of silence.
        """
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.prometheus.configured:
            return JSONResponse(
                {
                    "configured": False,
                    "reachable": False,
                    "reason": "prometheus-not-configured",
                    "watchdog_firing": False,
                    "alerts": [],
                }
            )
        try:
            raw_alerts = await run_in_threadpool(
                prometheus.list_alerts, url=settings.prometheus.url
            )
        except Exception as exc:
            logger.warning("workspace health: alert fetch failed: %s", exc)
            return JSONResponse(
                {
                    "configured": True,
                    "reachable": False,
                    "reason": "prometheus-unreachable",
                    "watchdog_firing": False,
                    "alerts": [],
                }
            )
        watchdog_firing = False
        severity_rank = {"critical": 0, "warning": 1, "info": 2}
        alerts = []
        for alert in raw_alerts:
            labels = alert.get("labels") or {}
            annotations = alert.get("annotations") or {}
            name = labels.get("alertname", "unknown")
            severity = labels.get("severity", "")
            state = alert.get("state", "")
            if name == "Watchdog" or severity == "none":
                # Deadman signal, not a problem: firing == pipeline alive.
                if state == "firing":
                    watchdog_firing = True
                continue
            if state != "firing":
                # The core contracts on firing alerts only (plan §3 WP2;
                # GATE-22 P2): an alert inside its for: pending window is
                # not yet a current problem.
                continue
            if severity in _BELOW_WARNING_SEVERITIES:
                # Severity floor (Constitution Art. 4 / Alarm Philosophy):
                # "Current problems" carries classified operator conditions
                # only. The below-warning advisory classes (info / advisory /
                # notice — the Alarm Philosophy stub's sub-warning tiers) are
                # not problems: not necessary/unique/actionable (EEMUA 191).
                # They belong on the expert Monitoring lane
                # (/api/monitoring/alerts, unfiltered), not the "are we OK?"
                # core. A firing alert with a blank/UNKNOWN severity is NOT
                # dropped (fail-safe: never hide a real condition on a bad or
                # missing label).
                continue
            # Identity is the full label set, not alertname+instance — one
            # rule can fire per namespace/pod with a shared or blank
            # instance (GATE-22 P2). The fingerprint keys UI rows; the
            # residual labels give the operator the distinguishing context.
            fingerprint = hashlib.sha256(
                "|".join(f"{k}={v}" for k, v in sorted(labels.items())).encode()
            ).hexdigest()[:16]
            context = " ".join(
                f"{k}={v}"
                for k, v in sorted(labels.items())
                if k not in ("alertname", "severity", "instance") and v
            )
            alerts.append(
                {
                    "id": fingerprint,
                    "name": name,
                    "state": state,
                    "severity": severity,
                    "instance": labels.get("instance", ""),
                    "context": context,
                    "summary": annotations.get("summary", ""),
                    "description": annotations.get("description", ""),
                    "runbook_url": annotations.get("runbook_url", ""),
                    "active_at": alert.get("activeAt", ""),
                }
            )
        # Deterministic order (severity, then name, then fingerprint):
        # unchanged data must produce an unchanged list (hard gate 5).
        alerts.sort(key=lambda a: (severity_rank.get(a["severity"], 1), a["name"], a["id"]))
        return JSONResponse(
            {
                "configured": True,
                "reachable": True,
                # watchdog-missing is an explicit reason token, not silence
                # (GATE-22 P3): rules may simply not be loaded.
                "reason": "" if watchdog_firing else "watchdog-missing",
                "watchdog_firing": watchdog_firing,
                "alerts": alerts,
            }
        )

    @app.get("/api/monitoring/alerts")
    async def api_monitoring_alerts(request: Request):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.prometheus.configured:
            return JSONResponse({"alerts": []})
        try:
            alerts = prometheus.list_alerts(url=settings.prometheus.url)
            return JSONResponse({"alerts": alerts})
        except Exception as exc:
            return JSONResponse({"error": f"Failed to fetch alerts: {exc}"}, status_code=500)

    @app.get("/api/monitoring/targets")
    async def api_monitoring_targets(request: Request):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.prometheus.configured:
            return JSONResponse({"targets": []})
        try:
            targets = prometheus.list_targets(url=settings.prometheus.url)
            return JSONResponse({"targets": targets})
        except Exception as exc:
            return JSONResponse({"error": f"Failed to fetch targets: {exc}"}, status_code=500)

    @app.get("/api/monitoring/metrics")
    async def api_monitoring_metrics(request: Request):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.prometheus.configured:
            return JSONResponse({
                "cpu_percent": 0,
                "memory_percent": 0,
                "pod_restarts_24h": 0,
                "pvc_usage_percent": 0,
            })
        try:
            cpu_result = prometheus.query(
                url=settings.prometheus.url,
                expr='100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
            )
            cpu = float(cpu_result[0]["value"][1]) if cpu_result else 0

            mem_result = prometheus.query(
                url=settings.prometheus.url,
                expr="100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)",
            )
            mem = float(mem_result[0]["value"][1]) if mem_result else 0

            restarts_result = prometheus.query(
                url=settings.prometheus.url,
                expr="sum(increase(kube_pod_container_status_restarts_total[24h]))",
            )
            restarts = int(float(restarts_result[0]["value"][1])) if restarts_result else 0

            pvc_result = prometheus.query(
                url=settings.prometheus.url,
                expr="sum(kubelet_volume_stats_used_bytes) / sum(kubelet_volume_stats_capacity_bytes) * 100",
            )
            pvc = float(pvc_result[0]["value"][1]) if pvc_result else 0

            return JSONResponse({
                "cpu_percent": round(cpu, 1),
                "memory_percent": round(mem, 1),
                "pod_restarts_24h": restarts,
                "pvc_usage_percent": round(pvc, 1),
            })
        except Exception as exc:
            return JSONResponse({"error": f"Failed to fetch metrics: {exc}"}, status_code=500)

    # ------------------------------------------------------------------
    # Facility (physical infrastructure) endpoints
    # ------------------------------------------------------------------
    @app.get("/api/facility/summary")
    async def api_facility_summary(request: Request):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.netbox.configured:
            return JSONResponse({"site_count": 0, "device_count": 0, "sites": []})
        try:
            sites = netbox.list_sites(
                api_url=settings.netbox.api_url,
                api_token=settings.netbox.api_token,
                ssl_verify=settings.netbox.ssl_verify,
            )
            devices = netbox.list_devices(
                api_url=settings.netbox.api_url,
                api_token=settings.netbox.api_token,
                ssl_verify=settings.netbox.ssl_verify,
            )

            device_count_by_site: dict[str, int] = {}
            for d in devices:
                site_name = d.get("site", {}).get("name", "unknown")
                device_count_by_site[site_name] = device_count_by_site.get(site_name, 0) + 1

            sites_list = [
                {
                    "name": s.get("name"),
                    "status": s.get("status", {}).get("value", s.get("status")) if isinstance(s.get("status"), dict) else s.get("status"),
                    "device_count": device_count_by_site.get(s.get("name"), 0),
                }
                for s in sites
            ]

            return JSONResponse({
                "site_count": len(sites),
                "device_count": len(devices),
                "sites": sites_list,
            })
        except Exception as exc:
            return JSONResponse({"error": f"Failed to fetch facility summary: {exc}"}, status_code=500)

    @app.get("/api/facility/devices")
    async def api_facility_devices(request: Request):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.netbox.configured:
            return JSONResponse({"devices": []})
        try:
            devices_data = netbox.list_devices(
                api_url=settings.netbox.api_url,
                api_token=settings.netbox.api_token,
                ssl_verify=settings.netbox.ssl_verify,
            )

            devices = [
                {
                    "id": d.get("id"),
                    "name": d.get("name"),
                    "type": d.get("device_type", {}).get("model", d.get("device_type")),
                    "site": d.get("site", {}).get("name", d.get("site")),
                    "status": d.get("status", {}).get("value", d.get("status")) if isinstance(d.get("status"), dict) else d.get("status"),
                    "ip": d.get("primary_ip", {}).get("address") if d.get("primary_ip") else None,
                    "role": d.get("role", {}).get("name", d.get("role")) if d.get("role") else None,
                }
                for d in devices_data
            ]

            return JSONResponse({"devices": devices})
        except Exception as exc:
            return JSONResponse({"error": f"Failed to fetch devices: {exc}"}, status_code=500)

    # ------------------------------------------------------------------
    # Changes (audit trail) endpoints
    # ------------------------------------------------------------------
    @app.get("/api/changes/jobs")
    async def api_changes_jobs(request: Request):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.awx.configured:
            return JSONResponse({"jobs": []})
        try:
            jobs_data = list_recent_jobs(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                ssl_verify=settings.awx.ssl_verify,
            )

            # This is an ALL-ROLES default surface (Activity → History and the
            # Workspace "Recent changes" widget), so the catalog-launcher
            # allow-list is applied UNCONDITIONALLY — there is no ?all here. A
            # historical run of an internal/spike template must not render at
            # default, humanised or raw (Art. 3).
            allowed = _catalog_launcher_jt_names()
            jobs = [
                {
                    "id": j.get("id"),
                    "name": j.get("name", ""),
                    "status": j.get("status", ""),
                    "started": j.get("started"),
                    "finished": j.get("finished"),
                    "elapsed": j.get("elapsed", 0.0),
                    "failed": j.get("failed", False),
                }
                for j in jobs_data
                if j.get("name", "") in allowed
            ]

            return JSONResponse({"jobs": jobs})
        except Exception as exc:
            return JSONResponse({"error": f"Failed to fetch jobs: {exc}"}, status_code=500)

    @app.get("/api/changes/commits")
    async def api_changes_commits(request: Request):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.forgejo.configured:
            return JSONResponse({"repos": []})
        try:
            repos = forgejo.list_repos(
                api_url=settings.forgejo.api_url,
                api_token=settings.forgejo.api_token,
            )

            repos_commits = []
            for repo in repos[:5]:
                full_name = repo.get("full_name", "")
                parts = full_name.split("/")
                owner = parts[0] if parts else ""
                repo_name = repo.get("name", "")

                try:
                    commits = forgejo.list_commits(
                        api_url=settings.forgejo.api_url,
                        api_token=settings.forgejo.api_token,
                        owner=owner,
                        repo=repo_name,
                        limit=10,
                    )

                    repos_commits.append({
                        "name": full_name,
                        "commits": [
                            {
                                "sha_short": c.get("sha", "")[:7],
                                "message": c.get("commit", {}).get("message", ""),
                                "author": c.get("commit", {}).get("author", {}).get("name", ""),
                                "date": c.get("commit", {}).get("author", {}).get("date", ""),
                                "url": c.get("html_url", ""),
                            }
                            for c in commits
                        ],
                    })
                except Exception:
                    pass

            return JSONResponse({"repos": repos_commits})
        except Exception as exc:
            return JSONResponse({"error": f"Failed to fetch commits: {exc}"}, status_code=500)

    @app.get("/api/changes/pulls")
    async def api_changes_pulls(request: Request):
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.forgejo.configured:
            return JSONResponse({"pulls": []})
        try:
            repos = forgejo.list_repos(
                api_url=settings.forgejo.api_url,
                api_token=settings.forgejo.api_token,
            )

            all_pulls = []
            for repo in repos[:5]:
                full_name = repo.get("full_name", "")
                parts = full_name.split("/")
                owner = parts[0] if parts else ""
                repo_name = repo.get("name", "")

                try:
                    pulls = forgejo.list_pulls(
                        api_url=settings.forgejo.api_url,
                        api_token=settings.forgejo.api_token,
                        owner=owner,
                        repo=repo_name,
                        state="all",
                    )

                    for pr in pulls:
                        all_pulls.append({
                            "repo": full_name,
                            "number": pr.get("number"),
                            "title": pr.get("title"),
                            "state": pr.get("state"),
                            "author": pr.get("user", {}).get("login", ""),
                            "created": pr.get("created_at", ""),
                            "url": pr.get("html_url", ""),
                        })
                except Exception:
                    pass

            return JSONResponse({"pulls": all_pulls})
        except Exception as exc:
            return JSONResponse({"error": f"Failed to fetch pulls: {exc}"}, status_code=500)

    # ------------------------------------------------------------------
    # Catalog endpoints — YAML catalog + NetBox tag join + AWX drive
    # ------------------------------------------------------------------
    def _catalog_index() -> dict[str, CatalogEntry]:
        """Return {key: CatalogEntry} for all loaded entries."""
        entries = load_catalog_entries()
        return {e.key: e for e in entries}

    def _catalog_launcher_jt_names() -> set[str]:
        """The AWX job-template names the catalog actually declares as
        launchers — its ``configure`` and ``finalise`` stages
        (``awx_job_template``). Derived from catalog DATA, not a hardcoded
        naming regex: the exposed workflow list is then exactly the facility's
        catalog launchers, so internal/spike templates (e.g.
        ``eso-openbao-health-check``) never render on a default surface
        (Constitution Art. 3). Empty when no catalog is loaded → the default
        list is empty (fail-closed: better to show nothing than raw internals;
        admins can still see the full inventory via ?all=true)."""
        names: set[str] = set()
        for entry in load_catalog_entries():
            for stage in (entry.configure, entry.finalise):
                jt = (stage or {}).get("awx_job_template")
                if jt:
                    names.add(str(jt))
        return names

    def _catalog_jt_lifecycle_map() -> tuple[dict[str, tuple[str, str, str | None]], frozenset[str]]:
        """Map a catalog lifecycle AWX job-template name to the entry it drives.

        jt_name -> (catalog_key, action, opposite_jt_name): a configure JT
        maps to ("deploy", opposite=finalise JT); a finalise JT maps to
        ("teardown", opposite=configure JT).

        Used so a catalog lifecycle JT launched via the generic
        /api/workflows/{name}/launch endpoint (the default surface the
        Activity JobsLane and the /api/workflows list use) resolves to the
        SAME per-entry lifecycle lock as /api/catalog/{key}/deploy|teardown —
        otherwise that path bypasses the #24 exclusion entirely (codex
        GATE-24 P1). Non-catalog JTs are simply absent from this map.

        Fail-closed (codex GATE-24R2 finding 1): a JT name is ambiguous when
        it maps to more than one (catalog_key, action) candidate — either two
        entries share it, or a single entry reuses it for both configure and
        finalise. Locking against just one candidate in that case would pick
        the WRONG lock namespace and make the C5 audit record misattribute
        the action. Ambiguous names are excluded from the returned map and
        reported separately, so the caller can refuse the launch instead of
        silently guessing.

        Returns (jt_map, ambiguous_jt_names).
        """
        candidates: dict[str, list[tuple[str, str, str | None]]] = {}
        for entry in load_catalog_entries():
            configure_jt = (entry.configure or {}).get("awx_job_template")
            finalise_jt = (entry.finalise or {}).get("awx_job_template")
            if configure_jt:
                candidates.setdefault(str(configure_jt), []).append(
                    (entry.key, "deploy", finalise_jt)
                )
            if finalise_jt:
                candidates.setdefault(str(finalise_jt), []).append(
                    (entry.key, "teardown", configure_jt)
                )

        jt_map: dict[str, tuple[str, str, str | None]] = {}
        ambiguous: set[str] = set()
        for jt_name, mappings in candidates.items():
            if len(mappings) > 1:
                ambiguous.add(jt_name)
            else:
                jt_map[jt_name] = mappings[0]
        return jt_map, frozenset(ambiguous)

    def _entry_to_dict(entry: CatalogEntry, lifecycle_status: str = "unknown") -> dict:
        """Convert a CatalogEntry + NetBox lifecycle status into a JSON-serialisable dict."""
        ebu = entry.ebu or {}
        provision = entry.provision or {}
        configure = entry.configure or {}
        finalise = entry.finalise or {}
        ingress = entry.ingress or {}
        ingress_host = ingress.get("host")
        # Suppress the link for the public example-domain placeholder so we never
        # render a dead "Open" link. A real env carries a real host (future:
        # stamped from the NetBox runtime endpoint, dmfdeploy/dmfdeploy#108) and
        # the link lights up then.
        ingress_url = (
            f"https://{ingress_host}"
            if ingress_host and not ingress_host.endswith(".example.com")
            else None
        )
        return {
            "key": entry.key,
            "display_name": entry.display_name,
            "summary": entry.summary,
            "ebu_layer": ebu.get("layer"),
            "ebu_vertical": ebu.get("vertical"),
            "ebu_media_function_type": ebu.get("media_function_type"),
            "ebu_lifecycle_owner": ebu.get("lifecycle_owner"),
            "lifecycle": lifecycle_status,
            "provision_image": provision.get("image", {}).get("repository") if provision.get("image") else None,
            "provision_netbox_service": provision.get("netbox_service", {}).get("name") if provision.get("netbox_service") else None,
            "configure_awx_job_template": configure.get("awx_job_template"),
            "finalise_awx_job_template": finalise.get("awx_job_template"),
            "dependencies": entry.dependencies or [],
            # Link-out to the function's own console when it declares a real host.
            "ingress_url": ingress_url,
        }

    @app.get("/api/catalog")
    async def api_catalog_list(request: Request):
        """Return catalog entries joined with NetBox lifecycle status."""
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        index = _catalog_index()
        out = []
        for entry in index.values():
            status = "unknown"
            if settings.netbox.configured and entry.provision:
                status = get_lifecycle_status(
                    entry,
                    settings.netbox.api_url,
                    settings.netbox.api_token,
                    ssl_verify=settings.netbox.ssl_verify,
                )
            out.append(_entry_to_dict(entry, status))
        return JSONResponse({"entries": out})

    @app.post("/api/catalog/{key}/deploy")
    async def api_catalog_deploy(request: Request, key: str):
        """Launch the AWX job template for this catalog entry (Provision/Configure).

        Operator+ gated with the C5 quartet (reason mandatory, request_id echoed
        + audited on every path): a viewer can no longer deploy by curl.
        """
        user, err = _require_min_role(request, "operator")
        if err is not None:
            return err
        assert user is not None
        # C5: reason + request_id before any early return (config 503s included).
        reason, rerr = await _require_reason(request)
        if rerr is not None:
            return rerr
        assert reason is not None
        request_id = uuid.uuid4().hex
        # #239: optional workload slug, validated before any AWX/config check —
        # same "validate all input up front" posture as the C5 reason gate.
        workload, werr = await _extract_workload(request, request_id)
        if werr is not None:
            _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="invalid-workload")
            return werr
        if not settings.awx.configured:
            _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="awx-not-configured")
            return JSONResponse({"error": "AWX API not configured", "request_id": request_id}, status_code=503)
        index = _catalog_index()
        entry = index.get(key)
        if entry is None:
            _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="entry-not-found")
            return JSONResponse({"error": f"catalog entry '{key}' not found", "request_id": request_id}, status_code=404)
        jt_name = (entry.configure or {}).get("awx_job_template")
        if not jt_name:
            _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="no-job-template")
            return JSONResponse({"error": f"entry '{key}' has no configure.awx_job_template", "request_id": request_id}, status_code=500)
        # #24: the opposite lifecycle stage's job template, for the cross-JT
        # running-job guard below (may be None if the entry has no finalise).
        opposite_jt_name = (entry.finalise or {}).get("awx_job_template")

        # #202 WP1 R2-7: the L3 capacity preflight gate runs AFTER the
        # dedupe/reattach checks in each flow below, not here — a reattach
        # to an already-in-flight operation or an already-active AWX job
        # must never re-run (or re-audit) a preflight; it was already run
        # (or the check is moot) for the original launch. See the gate call
        # inside each flow.

        # Async operation flow (when autoscale enabled)
        if settings.awx_autoscale.enabled:
            if not settings.awx_autoscale.configured:
                _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="autoscale-misconfigured")
                return JSONResponse({"error": "AWX autoscale enabled but misconfigured", "request_id": request_id}, status_code=503)

            ops_store = request.app.state.operations

            # Atomic dedupe + cross-action exclusion (#24): a teardown already
            # in flight for this catalog entry blocks a new deploy (and vice
            # versa) — deploy/teardown are different actions so get_or_create's
            # (action, target) dedupe alone would let both proceed.
            # #239 caveat: this keys on (action, target) only, not workload — a
            # second deploy for the same key with a DIFFERENT workload while one
            # is already in-flight reattaches to the first op (and its original
            # workload), not a new one. Acceptable for v1; revisit if workload
            # becomes a first-class dedupe axis.
            op, created, conflict = ops_store.get_or_create_exclusive(
                action="deploy", target=key, conflicts=("teardown",),
                request_id=request_id, initiator=user.subject,
            )

            if conflict is not None:
                _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="conflict-active-operation")
                return JSONResponse(
                    {
                        "error": "conflicting lifecycle operation in progress",
                        "conflicting_operation": conflict.to_dict(),
                        "request_id": request_id,
                    },
                    status_code=409,
                )

            if not created:
                # Existing operation found - return it without spawning new task
                # v1 behavior: browser refresh loses live spinner but re-clicking
                # safely reattaches via get_or_create (no double launch). No
                # preflight here (#202 R2-7): the original create already ran it.
                _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="reattached")
                return JSONResponse({**op.to_dict(), "request_id": request_id}, status_code=200)

            # #202 WP2 §4.5 P2-2: advisory facility check — after the
            # per-entry guards above (a reattach must never be facility-
            # gated), before the L3 preflight. Console-local only, no
            # network IO. A refusal here must also un-wedge the just-created
            # op, same reasoning as the preflight refusal below. codex R3-1:
            # get_or_create_exclusive above already atomically resolved
            # reattach-vs-conflict-vs-create — there's no race-free way to
            # peek that without duplicating its lock-held scan, so this flow
            # keeps create-then-check order (self-skip via
            # current_operation_id, since R3-1 removed the blanket
            # same-target skip that used to cover this for free).
            blocking = _facility_busy_check(
                ops_store, current_target=key, current_action="deploy", current_operation_id=op.operation_id,
            )
            if blocking is not None:
                ops_store.update(op.operation_id, state=OperationState.ERROR, error="facility-busy")
                _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="facility-busy")
                return JSONResponse(
                    {
                        "error": "facility-busy",
                        "advisory": True,
                        "blocking_operation": blocking.to_dict(),
                        "request_id": request_id,
                    },
                    status_code=409,
                )

            # #202 WP1 R2-7: preflight runs only for a freshly created op, right
            # before dispatch — the earliest point after which an AWX side
            # effect could follow. A refusal here must mark the just-created op
            # terminal (ERROR) before returning, or it wedges the (action,
            # target) exclusive lock and blocks every subsequent deploy attempt
            # for this catalog entry until TTL GC.
            l3_envelope, l3_err = await _l3_preflight(
                request, user, settings=settings, entry=entry, key=key,
                request_id=request_id, reason=reason,
            )
            if l3_err is not None:
                ops_store.update(op.operation_id, state=OperationState.ERROR, error="Capacity preflight refused")
                return l3_err

            # Spawn background task with tracking
            task = asyncio.create_task(_run_deploy_operation(
                request.app, op.operation_id, key, jt_name, workload, opposite_jt_name, l3_envelope
            ))
            request.app.state.operation_tasks.add(task)
            task.add_done_callback(request.app.state.operation_tasks.discard)

            _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="dispatched", workload=workload)
            return JSONResponse({**op.to_dict(), "request_id": request_id}, status_code=202)

        # Sync flow (autoscale disabled)
        try:
            template = lookup_job_template_by_name(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=jt_name,
                ssl_verify=settings.awx.ssl_verify,
            )
            if template is None:
                _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="template-not-found")
                return JSONResponse({"error": f"AWX job template '{jt_name}' not found", "request_id": request_id}, status_code=404)
            # app.state.operations is only populated by the lifespan
            # startup — getattr-guard it (test-only bare-TestClient path;
            # production always runs the lifespan). Retrieved here (rather
            # than just before the facility check, as previously) since
            # codex R3-4 needs it for the already-active branch too.
            ops_store_for_check = getattr(request.app.state, "operations", None)
            # Idempotency guard: if a deploy job for this template is already
            # in-flight, return it instead of launching a duplicate (defends
            # against double-click / two tabs / slow render — the real guard,
            # backend-side). See find_active_job_for_template.
            active = find_active_job_for_template(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
            )
            if active is not None:
                # codex R3-4: bridge this already-in-flight job into the ops
                # store too (never facility-gated — see _track_sync_reattach
                # — this is retroactive observability, not a new dispatch).
                op_id = (
                    _track_sync_reattach(
                        request.app, ops_store_for_check, request_id, user.subject,
                        action="deploy", target=key, job_id=active,
                    )
                    if ops_store_for_check is not None else None
                )
                _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="already-active")
                body = {"job_id": active, "status": "already-active", "request_id": request_id}
                if op_id is not None:
                    body["operation_id"] = op_id
                return JSONResponse(body)
            # Cross-JT guard (#24): the sync flow has no store to lock across
            # actions, so check whether the OPPOSITE stage's job template has
            # an in-flight job before launching this one. Residual
            # check-to-launch TOCTOU window; the AWX-layer concurrency cap
            # (umbrella #254) is the backstop, not closed here.
            if opposite_jt_name:
                opposite_template = lookup_job_template_by_name(
                    api_url=settings.awx.api_url,
                    api_token=settings.awx.api_token,
                    name=opposite_jt_name,
                    ssl_verify=settings.awx.ssl_verify,
                )
                if opposite_template is not None:
                    opposite_active = find_active_job_for_template(
                        api_url=settings.awx.api_url,
                        api_token=settings.awx.api_token,
                        job_template_id=opposite_template["id"],
                        ssl_verify=settings.awx.ssl_verify,
                    )
                    if opposite_active is not None:
                        _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="conflict-active-job")
                        return JSONResponse(
                            {"error": "conflicting lifecycle operation in progress", "request_id": request_id},
                            status_code=409,
                        )
            # #202 WP2 §4.5 P2-2: advisory facility check, symmetric with the
            # async branch above — console-local only, no network IO.
            # codex R2-5: the sync flow now ALSO creates its own Operation
            # at launch (below), so this has real teeth in the shipped
            # default (autoscale-disabled) mode on its own, not just for
            # mixed sync/async deployments. ops_store_for_check was already
            # retrieved above (needed there too, for the already-active
            # branch, codex R3-4) — current_operation_id stays None here
            # since no op exists yet at this point in the sync flow.
            blocking = (
                _facility_busy_check(ops_store_for_check, current_target=key, current_action="deploy")
                if ops_store_for_check else None
            )
            if blocking is not None:
                _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="facility-busy")
                return JSONResponse(
                    {
                        "error": "facility-busy",
                        "advisory": True,
                        "blocking_operation": blocking.to_dict(),
                        "request_id": request_id,
                    },
                    status_code=409,
                )
            # #202 WP1 R2-7: preflight runs here — after both idempotency
            # guards (already-active reattach, cross-JT conflict), immediately
            # before the actual AWX side effect. Neither guard above re-runs
            # or re-audits a preflight; only a genuinely new launch does.
            l3_envelope, l3_err = await _l3_preflight(
                request, user, settings=settings, entry=entry, key=key,
                request_id=request_id, reason=reason,
            )
            if l3_err is not None:
                return l3_err
            job_id = launch_job(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
                extra_vars=_build_launch_extra_vars(workload, l3_envelope),
            )
            # codex R2-5: the sync flow now ALSO tracks this launch as an
            # Operation and attaches the job watcher — so the advisory
            # facility check, auto-rollback trigger, and outcome surfacing
            # all have teeth in the shipped default (autoscale-disabled)
            # mode, not just when autoscale is on. getattr-guarded (see the
            # facility-check comment above): only skips when the app's
            # lifespan never ran, which is test-only. codex R3-4: the
            # response gains an ADDITIVE "operation_id" key when tracked
            # (never present when the guard skips, so existing callers that
            # don't expect it are unaffected).
            response_body = {"job_id": job_id, "status": "launched", "request_id": request_id}
            if ops_store_for_check is not None:
                sync_op = ops_store_for_check.create(
                    action="deploy", target=key, request_id=request_id, initiator=user.subject,
                )
                # codex R3-3: fresh dispatch — run_id is this op's own request_id.
                ops_store_for_check.update(
                    sync_op.operation_id, state=OperationState.LAUNCHED, job_id=job_id, run_id=request_id,
                )
                _spawn_job_watcher(request.app, sync_op.operation_id, job_id, "deploy", key)
                response_body["operation_id"] = sync_op.operation_id
            _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome="launched", workload=workload)
            return JSONResponse(response_body)
        except AWXAPIError as exc:
            _audit_awx_write(request, user, action="deploy", target=key, request_id=request_id, reason=reason, outcome=f"awx-error:{exc.status}")
            return JSONResponse({"error": f"AWX API error: {exc.body}", "request_id": request_id}, status_code=exc.status)

    @app.post("/api/catalog/{key}/teardown")
    async def api_catalog_teardown(request: Request, key: str):
        """Launch the finalise (teardown) AWX job template for this catalog entry.

        Operator+ gated with the C5 quartet (reason mandatory, request_id echoed
        + audited on every path): a viewer can no longer teardown by curl.
        """
        user, err = _require_min_role(request, "operator")
        if err is not None:
            return err
        assert user is not None
        # C5: reason + request_id before any early return (config 503s included).
        reason, rerr = await _require_reason(request)
        if rerr is not None:
            return rerr
        assert reason is not None
        request_id = uuid.uuid4().hex
        if not settings.awx.configured:
            _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="awx-not-configured")
            return JSONResponse({"error": "AWX API not configured", "request_id": request_id}, status_code=503)
        index = _catalog_index()
        entry = index.get(key)
        if entry is None:
            _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="entry-not-found")
            return JSONResponse({"error": f"catalog entry '{key}' not found", "request_id": request_id}, status_code=404)
        jt_name = (entry.finalise or {}).get("awx_job_template")
        if not jt_name:
            _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="no-job-template")
            return JSONResponse({"error": f"entry '{key}' has no finalise.awx_job_template", "request_id": request_id}, status_code=500)
        # #24: the opposite lifecycle stage's job template (configure), for
        # the cross-JT running-job guard below.
        opposite_jt_name = (entry.configure or {}).get("awx_job_template")

        # Async operation flow (when autoscale enabled)
        if settings.awx_autoscale.enabled:
            if not settings.awx_autoscale.configured:
                _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="autoscale-misconfigured")
                return JSONResponse({"error": "AWX autoscale enabled but misconfigured", "request_id": request_id}, status_code=503)

            ops_store = request.app.state.operations

            # Atomic dedupe + cross-action exclusion (#24): a deploy already
            # in flight for this catalog entry blocks a new teardown.
            op, created, conflict = ops_store.get_or_create_exclusive(
                action="teardown", target=key, conflicts=("deploy",),
                request_id=request_id, initiator=user.subject,
            )

            if conflict is not None:
                _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="conflict-active-operation")
                return JSONResponse(
                    {
                        "error": "conflicting lifecycle operation in progress",
                        "conflicting_operation": conflict.to_dict(),
                        "request_id": request_id,
                    },
                    status_code=409,
                )

            if not created:
                # Existing operation found - return it without spawning new task
                # v1 behavior: browser refresh loses live spinner but re-clicking
                # safely reattaches via get_or_create (no double launch)
                _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="reattached")
                return JSONResponse({**op.to_dict(), "request_id": request_id}, status_code=200)

            # codex R2-6: advisory facility check, now wired into teardown
            # too — a DIRTY run (FAILED_ROLLBACK_REQUIRED/ROLLBACK_INCOMPLETE/
            # RUN_STATUS_UNKNOWN) elsewhere on the facility must block a new
            # teardown just like it blocks a new deploy/rollback. codex
            # R3-5 removed the old teardown-vs-teardown cross-target
            # exemption — plan §4.5 is one run at a time, full stop.
            # current_operation_id self-skips the just-created op (create-
            # then-check order, same reasoning as the async deploy branch).
            blocking = _facility_busy_check(
                ops_store, current_target=key, current_action="teardown", current_operation_id=op.operation_id,
            )
            if blocking is not None:
                ops_store.update(op.operation_id, state=OperationState.ERROR, error="facility-busy")
                _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="facility-busy")
                return JSONResponse(
                    {
                        "error": "facility-busy",
                        "advisory": True,
                        "blocking_operation": blocking.to_dict(),
                        "request_id": request_id,
                    },
                    status_code=409,
                )

            # Spawn background task with tracking
            task = asyncio.create_task(_run_teardown_operation(
                request.app, op.operation_id, key, jt_name, opposite_jt_name
            ))
            request.app.state.operation_tasks.add(task)
            task.add_done_callback(request.app.state.operation_tasks.discard)

            _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="dispatched")
            return JSONResponse({**op.to_dict(), "request_id": request_id}, status_code=202)

        # Sync flow (autoscale disabled)
        try:
            template = lookup_job_template_by_name(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=jt_name,
                ssl_verify=settings.awx.ssl_verify,
            )
            if template is None:
                _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="template-not-found")
                return JSONResponse({"error": f"AWX job template '{jt_name}' not found", "request_id": request_id}, status_code=404)
            # app.state.operations — see the matching comment in the sync
            # deploy branch (retrieved here, before the already-active
            # check, since codex R3-4 needs it there too).
            ops_store_for_check = getattr(request.app.state, "operations", None)
            # Idempotency guard (symmetric with deploy): return an in-flight
            # teardown job for this template instead of launching a duplicate.
            active = find_active_job_for_template(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
            )
            if active is not None:
                # codex R3-4: bridge this already-in-flight job into the ops
                # store — see _track_sync_reattach.
                op_id = (
                    _track_sync_reattach(
                        request.app, ops_store_for_check, request_id, user.subject,
                        action="teardown", target=key, job_id=active,
                    )
                    if ops_store_for_check is not None else None
                )
                _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="already-active")
                body = {"job_id": active, "status": "already-active", "request_id": request_id}
                if op_id is not None:
                    body["operation_id"] = op_id
                return JSONResponse(body)
            # Cross-JT guard (#24, symmetric with deploy): the sync flow has
            # no store to lock across actions, so check whether the OPPOSITE
            # stage's job template has an in-flight job before launching this
            # one. Residual check-to-launch TOCTOU window; the AWX-layer
            # concurrency cap (umbrella #254) is the backstop, not closed here.
            if opposite_jt_name:
                opposite_template = lookup_job_template_by_name(
                    api_url=settings.awx.api_url,
                    api_token=settings.awx.api_token,
                    name=opposite_jt_name,
                    ssl_verify=settings.awx.ssl_verify,
                )
                if opposite_template is not None:
                    opposite_active = find_active_job_for_template(
                        api_url=settings.awx.api_url,
                        api_token=settings.awx.api_token,
                        job_template_id=opposite_template["id"],
                        ssl_verify=settings.awx.ssl_verify,
                    )
                    if opposite_active is not None:
                        _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="conflict-active-job")
                        return JSONResponse(
                            {"error": "conflicting lifecycle operation in progress", "request_id": request_id},
                            status_code=409,
                        )
            # codex R2-6: advisory facility check, symmetric with the async
            # branch above and with the deploy/rollback sync branches —
            # ops_store_for_check was already retrieved above (needed there
            # too, for the already-active branch, codex R3-4).
            blocking = (
                _facility_busy_check(ops_store_for_check, current_target=key, current_action="teardown")
                if ops_store_for_check else None
            )
            if blocking is not None:
                _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="facility-busy")
                return JSONResponse(
                    {
                        "error": "facility-busy",
                        "advisory": True,
                        "blocking_operation": blocking.to_dict(),
                        "request_id": request_id,
                    },
                    status_code=409,
                )
            job_id = launch_job(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
            )
            # codex R2-5: track this launch as an Operation + watcher too —
            # see the matching comment in the sync deploy branch. codex
            # R3-4: response gains an additive "operation_id" key.
            response_body = {"job_id": job_id, "status": "launched", "request_id": request_id}
            if ops_store_for_check is not None:
                sync_op = ops_store_for_check.create(
                    action="teardown", target=key, request_id=request_id, initiator=user.subject,
                )
                ops_store_for_check.update(
                    sync_op.operation_id, state=OperationState.LAUNCHED, job_id=job_id, run_id=request_id,
                )
                _spawn_job_watcher(request.app, sync_op.operation_id, job_id, "teardown", key)
                response_body["operation_id"] = sync_op.operation_id
            _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome="launched")
            return JSONResponse(response_body)
        except AWXAPIError as exc:
            _audit_awx_write(request, user, action="teardown", target=key, request_id=request_id, reason=reason, outcome=f"awx-error:{exc.status}")
            return JSONResponse({"error": f"AWX API error: {exc.body}", "request_id": request_id}, status_code=exc.status)

    @app.post("/api/runs/{run_id}/rollback")
    async def api_run_rollback(request: Request, run_id: str):
        """Launch the rollback command for a run whose deploy failed after
        starting (umbrella #202 WP2, plan §4.5/§4.6 — FAILED_ROLLBACK_REQUIRED).

        Operator+ gated with the C5 quartet, same posture as deploy/teardown.
        ``run_id`` is the failed deploy's own request_id (uuid4 hex).
        """
        user, err = _require_min_role(request, "operator")
        if err is not None:
            return err
        assert user is not None
        reason, rerr = await _require_reason(request)
        if rerr is not None:
            return rerr
        assert reason is not None
        request_id = uuid.uuid4().hex

        if not _RUN_ID_RE.fullmatch(run_id):
            _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="invalid-run-id")
            return JSONResponse({"error": "invalid-run-id", "request_id": request_id}, status_code=400)

        if not settings.awx.configured:
            _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="awx-not-configured")
            return JSONResponse({"error": "AWX API not configured", "request_id": request_id}, status_code=503)

        # Async operation flow (when autoscale enabled)
        if settings.awx_autoscale.enabled:
            if not settings.awx_autoscale.configured:
                _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="autoscale-misconfigured")
                return JSONResponse({"error": "AWX autoscale enabled but misconfigured", "request_id": request_id}, status_code=503)

            ops_store = request.app.state.operations

            # codex R3-1: rollback's dedupe is a plain (non-exclusive)
            # get_or_create, so — unlike deploy/teardown's
            # get_or_create_exclusive — we CAN peek whether this dispatch
            # would reattach without needing atomicity with the create.
            # Preferred ordering (avoids the self-skip/un-wedge dance
            # entirely): if it WOULD reattach, skip the facility check
            # (a reattach must never be facility-gated) and go straight to
            # get_or_create. If it would NOT, run the facility check FIRST
            # — nothing has been created yet, so current_operation_id stays
            # None and a refusal never needs to un-wedge anything.
            if ops_store.find_active("rollback", run_id) is None:
                blocking = _facility_busy_check(ops_store, current_target=run_id, current_action="rollback")
                if blocking is not None:
                    _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="facility-busy")
                    return JSONResponse(
                        {
                            "error": "facility-busy",
                            "advisory": True,
                            "blocking_operation": blocking.to_dict(),
                            "request_id": request_id,
                        },
                        status_code=409,
                    )

            # Dedupe only (not get_or_create_exclusive/conflicts): a run_id
            # is unique to one failed deploy, so there's no "opposite
            # action" to exclude the way deploy<->teardown exclude each
            # other on a shared catalog key. A second rollback POST for the
            # SAME run_id reattaches, it never conflicts.
            op, created = ops_store.get_or_create(
                action="rollback", target=run_id,
                request_id=request_id, initiator=user.subject,
            )

            if not created:
                _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="reattached")
                return JSONResponse({**op.to_dict(), "request_id": request_id}, status_code=200)

            _spawn_rollback_task(request.app, op.operation_id, run_id, reason)

            _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="dispatched")
            return JSONResponse({**op.to_dict(), "request_id": request_id}, status_code=202)

        # Sync flow (autoscale disabled) — mirrors the sync deploy/teardown
        # branches: dedupe is still only the AWX-side already-active check
        # (no ops-store dedupe/reattach here, unlike async), but codex R2-5
        # means this branch NOW ALSO creates a tracked Operation + watcher
        # at launch (getattr-guarded — see below), so the facility
        # check/auto-rollback/outcome-surfacing machinery has teeth here
        # in the shipped default (autoscale-disabled) mode too.
        try:
            template = lookup_job_template_by_name(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=settings.l3.rollback_jt_name,
                ssl_verify=settings.awx.ssl_verify,
            )
            if template is None:
                _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="jt-not-registered")
                return JSONResponse(
                    {
                        "error": f"rollback job template '{settings.l3.rollback_jt_name}' not found",
                        "request_id": request_id,
                    },
                    status_code=404,
                )
            # getattr-guard: see the matching comment in the sync deploy
            # branch. Retrieved here (before the already-active check)
            # since codex R3-4 needs it there too.
            ops_store_for_check = getattr(request.app.state, "operations", None)
            active = find_active_job_for_template(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
            )
            if active is not None:
                # codex R4-2b: the rollback JT is SHARED across ALL runs
                # (unlike deploy/teardown's per-entry JT) — "active" here
                # just means SOME rollback job is running, not necessarily
                # one for THIS run_id. Verify identity (the active job's
                # own extra_vars.l3_run_id) BEFORE ever creating or
                # reattaching an Operation — never attribute a DIFFERENT
                # run's rollback job to this run_id (that would let the
                # other run's outcome marker false-complete this one).
                op_id, identity_mismatch = (
                    _track_sync_rollback_reattach(
                        request.app, ops_store_for_check, request_id, user.subject,
                        run_id=run_id, job_id=active,
                    )
                    if ops_store_for_check is not None else (None, False)
                )
                if identity_mismatch:
                    _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="already-active-other-run")
                    return JSONResponse(
                        {"error": "already-active-other-run", "request_id": request_id}, status_code=409,
                    )
                _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="already-active")
                body = {"job_id": active, "status": "already-active", "request_id": request_id}
                if op_id is not None:
                    body["operation_id"] = op_id
                return JSONResponse(body)
            blocking = (
                _facility_busy_check(ops_store_for_check, current_target=run_id, current_action="rollback")
                if ops_store_for_check else None
            )
            if blocking is not None:
                _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="facility-busy")
                return JSONResponse(
                    {
                        "error": "facility-busy",
                        "advisory": True,
                        "blocking_operation": blocking.to_dict(),
                        "request_id": request_id,
                    },
                    status_code=409,
                )
            job_id = launch_job(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
                # R2-7: l3_request_id is this dispatch's OWN request_id
                # (already true here in the sync flow — see
                # _run_rollback_operation for the async-flow fix).
                extra_vars={"l3_run_id": run_id, "l3_rollback_reason": reason, "l3_request_id": request_id},
            )
            # codex R2-5: track this launch as an Operation + watcher too —
            # see the matching comment in the sync deploy branch. codex
            # R3-4: response gains an additive "operation_id" key.
            response_body = {"job_id": job_id, "status": "launched", "request_id": request_id}
            if ops_store_for_check is not None:
                sync_op = ops_store_for_check.create(
                    action="rollback", target=run_id, request_id=request_id, initiator=user.subject,
                )
                # codex R3-3: fresh dispatch — run_id (the OP's OWN identity)
                # is its own request_id, same value threaded as l3_request_id
                # above.
                ops_store_for_check.update(
                    sync_op.operation_id, state=OperationState.LAUNCHED, job_id=job_id, run_id=request_id,
                )
                _spawn_job_watcher(request.app, sync_op.operation_id, job_id, "rollback", run_id)
                response_body["operation_id"] = sync_op.operation_id
            _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome="launched")
            return JSONResponse(response_body)
        except AWXAPIError as exc:
            _audit_awx_write(request, user, action="rollback", target=run_id, request_id=request_id, reason=reason, outcome=f"awx-error:{exc.status}")
            return JSONResponse({"error": f"AWX API error: {exc.body}", "request_id": request_id}, status_code=exc.status)

    @app.get("/api/catalog/{key}/status/{job_id}")
    async def api_catalog_job_status(request: Request, key: str, job_id: int):
        """Return AWX job status for a catalog-entry job."""
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.awx.configured:
            return JSONResponse({"error": "AWX API not configured"}, status_code=503)
        index = _catalog_index()
        if key not in index:
            return JSONResponse({"error": f"catalog entry '{key}' not found"}, status_code=404)
        try:
            info = get_job_status(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_id=job_id,
                ssl_verify=settings.awx.ssl_verify,
            )
            return JSONResponse({
                "job_id": info.job_id,
                "status": info.status,
                "is_done": info.is_done,
                "is_running": info.is_running,
            })
        except AWXAPIError as exc:
            # Return status info even if AWX reports an error for the job
            return JSONResponse({
                "job_id": job_id,
                "status": "error",
                "is_done": True,
                "is_running": False,
                "awx_error": exc.body,
            })

    # ------------------------------------------------------------------
    # DEPRECATED: /api/catalog/entries — alias for /api/catalog (one release)
    # ------------------------------------------------------------------
    @app.get("/api/catalog/entries")
    async def api_catalog_entries_deprecated(request: Request):
        # DEPRECATED: use GET /api/catalog instead
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        # Delegate to the same logic as /api/catalog
        index = _catalog_index()
        out = []
        for entry in index.values():
            status = "unknown"
            if settings.netbox.configured and entry.provision:
                status = get_lifecycle_status(
                    entry,
                    settings.netbox.api_url,
                    settings.netbox.api_token,
                    ssl_verify=settings.netbox.ssl_verify,
                )
            out.append(_entry_to_dict(entry, status))
        response = JSONResponse({"entries": out})
        response.headers["X-DMF-Deprecated"] = "use /api/catalog"
        return response

    # ------------------------------------------------------------------
    # MXL Flows — libfabric/tcp cross-host demo evaluation endpoints
    # ------------------------------------------------------------------
    @app.get("/api/mxl/status")
    async def api_mxl_status(request: Request):
        # Same surface boundary as the Media Workloads page that hosts the
        # live-view panel (ADR-0037 §5; GATE-20 P3 fold, #174).
        _, err = _require_media_workloads_access(request)
        if err is not None:
            return err
        if not settings.mxl.configured:
            return JSONResponse(
                {"configured": False, "nodes": [], "flow": {}, "transport": {}, "reachable": False}
            )
        data = mxl.fetch_status(settings.mxl.endpoints)
        data["configured"] = True
        return JSONResponse(data)

    @app.get("/api/mxl/preview/{role}")
    async def api_mxl_preview(request: Request, role: str):
        _, err = _require_media_workloads_access(request)
        if err is not None:
            return err
        if not settings.mxl.configured:
            return JSONResponse({"error": "MXL endpoints not configured"}, status_code=503)
        jpeg = mxl.fetch_preview(settings.mxl.endpoints, role)
        if jpeg is None:
            return JSONResponse({"error": "preview unavailable"}, status_code=404)
        return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    # ------------------------------------------------------------------
    # Media Workloads (ADR-0037): NetBox instance inventory, desired vs
    # observed, hard server-side role + tenancy boundary.
    # ------------------------------------------------------------------
    @app.get("/api/media-workloads")
    async def api_media_workloads(request: Request):
        user, err = _require_media_workloads_access(request)
        if err is not None:
            return err
        # Fail-closed tenancy: dark until the env declares its posture
        # (single | scoped) — an implicit allow-all default is forbidden
        # (ADR-0037 hard boundary; GATE-7).
        if not settings.media_tenancy.configured:
            return JSONResponse(
                {
                    "configured": False,
                    "reason": "media-tenancy-not-configured",
                    "instances": [],
                    "functions": [],
                }
            )
        if not settings.netbox.configured:
            return JSONResponse(
                {
                    "configured": True,
                    "degraded": True,
                    "reason": "netbox-not-configured",
                    "instances": [],
                    "functions": [],
                }
            )
        assert user is not None
        tenant_slugs = settings.media_tenancy.tenants_for(user.groups)
        payload = await run_in_threadpool(
            media_workloads.list_instances,
            settings.netbox.api_url,
            settings.netbox.api_token,
            settings.netbox.ssl_verify,
            tenant_slugs,
            settings.prometheus.url if settings.prometheus.configured else "",
            # Same allowlists as the live-view endpoints so list `live_view`
            # and status/preview never disagree under non-default config
            # (codex WP-D P3).
            settings.mxl.sidecar_namespaces,
            settings.mxl.sidecar_ports,
        )
        payload["configured"] = True
        payload["scope"] = "all" if tenant_slugs is None else list(tenant_slugs)
        return JSONResponse(payload)

    @app.get("/api/media-workloads/grouped")
    async def api_media_workloads_grouped(request: Request):
        """Workload-first grouped inventory (ADR-0046 decisions 3 + 5).

        Additive endpoint: the flat /api/media-workloads stays untouched.
        Groups instances by workload:<slug> tag, derives per-workload
        lifecycle, and joins observed state by per-instance identity
        (not the collapsing app-label rollup).
        """
        user, err = _require_media_workloads_access(request)
        if err is not None:
            return err
        if not settings.media_tenancy.configured:
            return JSONResponse(
                {
                    "configured": False,
                    "reason": "media-tenancy-not-configured",
                    "workloads": [],
                    "invalid_instances": [],
                }
            )
        if not settings.netbox.configured:
            return JSONResponse(
                {
                    "configured": True,
                    "degraded": True,
                    "reason": "netbox-not-configured",
                    "workloads": [],
                    "invalid_instances": [],
                }
            )
        assert user is not None
        tenant_slugs = settings.media_tenancy.tenants_for(user.groups)
        payload = await run_in_threadpool(
            media_workloads.list_workloads_grouped,
            settings.netbox.api_url,
            settings.netbox.api_token,
            settings.netbox.ssl_verify,
            tenant_slugs,
            settings.prometheus.url if settings.prometheus.configured else "",
            settings.mxl.sidecar_namespaces,
            settings.mxl.sidecar_ports,
        )
        payload["configured"] = True
        payload["scope"] = "all" if tenant_slugs is None else list(tenant_slugs)
        return JSONResponse(payload)

    @app.post("/api/media-workloads/{instance}/clear")
    async def api_media_workloads_clear(request: Request, instance: str):
        """Clear for deployment — the ONE consequential media-workloads write.

        Flips the instance's NetBox lifecycle tag to active (desired state);
        the AWX lane converges it (ADR-0037 §4). Captures the ADR-0028 C5
        quartet; scope + role are enforced independently on this write path.
        NetBox is the only thing the console writes — never k3s.
        """
        user, err = _require_media_workloads_access(request)
        if err is not None:
            return err
        assert user is not None
        # Writes refuse loudly when the surface is dark (contrast: reads are
        # 200-configured:false so the page can explain itself).
        if not settings.media_tenancy.configured:
            return JSONResponse({"error": "media-tenancy-not-configured"}, status_code=503)
        if not settings.netbox.write_configured:
            return JSONResponse({"error": "netbox-writer-not-configured"}, status_code=503)
        # fix-round P3 (codex GATE-239CMS-R2): this endpoint used to parse the
        # body inline with its own (body or {}).get("reason", ...), which
        # crashed with an unhandled AttributeError on a non-object JSON body
        # (bare list/string/number) — the exact bug _require_reason's dict
        # guard already fixes for every OTHER C5 write. Routed through the
        # shared helper instead of re-adding the guard locally: one parser,
        # one place to keep this safe.
        reason, rerr = await _require_reason(request)
        if rerr is not None:
            return rerr
        assert reason is not None
        request_id = uuid.uuid4().hex
        tenant_slugs = settings.media_tenancy.tenants_for(user.groups)
        result = await run_in_threadpool(
            media_workloads.clear_for_deployment,
            settings.netbox.api_url,
            settings.netbox.writer_token,
            settings.netbox.ssl_verify,
            tenant_slugs,
            settings.netbox.api_token,
            instance,
        )
        # C5 quartet (actor / role / request-id / reason): the structured log
        # line is the durable audit record until the console-local activity
        # lane lands with #174; request_id correlates response <-> log.
        logger.info(
            "media-workloads clear: actor=%s role=%s request_id=%s instance=%s reason=%r outcome=%s",
            user.subject,
            user.role,
            request_id,
            instance,
            reason,
            result.get("error", "ok"),
        )
        if result.get("error") == "not-found":
            # Out-of-scope and nonexistent are indistinguishable: no leak.
            return JSONResponse({"error": "not-found", "request_id": request_id}, status_code=404)
        if result.get("error") == "already-active":
            return JSONResponse(
                {"error": "already-active", "request_id": request_id}, status_code=409
            )
        if result.get("error"):
            return JSONResponse(
                {"error": result["error"], "request_id": request_id}, status_code=502
            )
        # Close the loop at the point of action (hard gate 2): new state +
        # what converges it and how to watch.
        return JSONResponse(
            {
                "instance": result["instance"],
                "requested_state": result["requested_state"],
                "previous_state": result["previous_state"],
                "request_id": request_id,
                "actor": user.subject,
                "role": user.role,
                "reason": reason,
                "reconcile": {
                    "expectation": (
                        "Desired state recorded in the facility source of truth. The "
                        "platform's automation lane converges it (catalog launch); the "
                        "drift check will flag the gap until then."
                    ),
                    "watch": "/api/media-workloads",
                },
            }
        )

    # ------------------------------------------------------------------
    # Media Workloads live view (WP-D / G26): per-instance MXL status +
    # preview, sourced from NetBox-stamped sidecar coords. Same ADR-0037 §5
    # gate as the inventory; the SSRF allowlist + concrete-identity bind live
    # in media_workloads.sidecar_base_url. The public payload leaks NO coords/
    # URLs/IPs — only a boolean live-ness and shaped flow stats.
    # ------------------------------------------------------------------
    async def _resolve_mxl_target(request: Request, instance: str):
        """Shared gate + scoped resolve for the two live-view endpoints.

        Returns ``(outcome, None)`` on success or ``(None, error_response)``.
        ``outcome`` is the media_workloads.resolve_sidecar_target dict, or a
        synthetic ``{"status": "unreachable"}`` when the surface is dark (no
        scope to resolve — degrade, don't 500).
        """
        user, err = _require_media_workloads_access(request)
        if err is not None:
            return None, err
        assert user is not None
        if not settings.media_tenancy.configured or not settings.netbox.configured:
            return {"status": "unreachable"}, None
        tenant_slugs = settings.media_tenancy.tenants_for(user.groups)
        outcome = await run_in_threadpool(
            media_workloads.resolve_sidecar_target,
            settings.netbox.api_url,
            settings.netbox.api_token,
            settings.netbox.ssl_verify,
            tenant_slugs,
            instance,
            sidecar_namespaces=settings.mxl.sidecar_namespaces,
            sidecar_ports=settings.mxl.sidecar_ports,
            cache=scoped_service_cache,
        )
        return outcome, None

    @app.get("/api/media-workloads/{instance}/mxl/status")
    async def api_media_workloads_mxl_status(request: Request, instance: str):
        outcome, err = await _resolve_mxl_target(request, instance)
        if err is not None:
            return err
        status = outcome["status"]
        if status == "not-found":
            # Out-of-scope and nonexistent are indistinguishable: no leak.
            return JSONResponse(
                {"instance": instance, "available": False, "reason": "not-found"},
                status_code=404,
            )
        if status != "ok":
            # no-sidecar | unreachable -> degraded is 200 content, never a 500.
            reason = "no-sidecar" if status == "no-sidecar" else "unreachable"
            return JSONResponse(
                {"instance": instance, "available": False, "reason": reason}
            )
        data = await run_in_threadpool(mxl.fetch_status_one, outcome["base_url"])
        if data is None:
            return JSONResponse(
                {"instance": instance, "available": False, "reason": "unreachable"}
            )
        # shape_status returns a FIXED, bounded field set — never a raw
        # passthrough of sidecar strings (codex WP-D P2).
        return JSONResponse(mxl.shape_status(instance, data))

    @app.get("/api/media-workloads/{instance}/mxl/preview")
    async def api_media_workloads_mxl_preview(request: Request, instance: str):
        outcome, err = await _resolve_mxl_target(request, instance)
        if err is not None:
            return err
        # Image surface: out-of-scope, no sidecar, unreachable, or a rejected
        # (non-JPEG / over-cap) body all collapse to 404 so the <img> onError
        # placeholder handles it uniformly — no coords/reason ever leak here.
        if outcome["status"] != "ok":
            return JSONResponse({"error": "preview-unavailable"}, status_code=404)
        jpeg = await run_in_threadpool(mxl.fetch_preview_one, outcome["base_url"])
        if jpeg is None:
            return JSONResponse({"error": "preview-unavailable"}, status_code=404)
        return Response(
            content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"}
        )

    # ------------------------------------------------------------------
    # Catch-all: serve React SPA index.html (must be registered last)
    # ------------------------------------------------------------------
    @app.get("/{full_path:path}", response_class=HTMLResponse, include_in_schema=False)
    async def spa_fallback(full_path: str):
        """Serve index.html for all unmatched routes to enable React Router client-side navigation."""
        index_path = PACKAGE_ROOT / "static" / "app" / "index.html"
        if index_path.exists():
            return HTMLResponse(index_path.read_text())
        # Fallback if SPA not built yet (return a minimal HTML)
        return HTMLResponse("""<!DOCTYPE html>
<html>
<head><title>DMF Console</title></head>
<body><h1>DMF Console</h1><p>App Catalog</p><p>React app not built. Run: npm run build in frontend/</p></body>
</html>""")

    return app


app = create_app()
