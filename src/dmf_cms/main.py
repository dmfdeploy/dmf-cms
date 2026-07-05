from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
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
from .awx import AWXAPIError, AWXAutoscaleError, AWXJobInfo, list_job_templates, launch_job, get_job_status, wait_for_job, lookup_job_template_by_name, list_recent_jobs, find_active_job_for_template, ensure_awx_awake
from .catalog import CatalogEntry, load_catalog_entries, get_lifecycle_status
from .contracts import AppContract, load_app_contract
from .operations import OperationStore, OperationState
from . import netbox, prometheus, forgejo, mxl, media_workloads
from starlette.concurrency import run_in_threadpool
import asyncio
from .security import (
    MEDIA_ENGINEERS_GROUP,
    ROLE_GROUPS,
    ROLE_ORDER,
    UserIdentity,
    build_authorize_url,
    clear_user,
    discovery_document,
    dev_user,
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
    """
    user = session_user(request.session)
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
    """
    user = session_user(request.session)
    if user is None:
        return None, JSONResponse({"error": "unauthorized"}, status_code=401)
    if not role_at_least(user.role, "engineer") and MEDIA_ENGINEERS_GROUP not in user.groups:
        return None, JSONResponse({"error": "forbidden"}, status_code=403)
    return user, None


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


async def _run_deploy_operation(app: FastAPI, operation_id: str, key: str, jt_name: str) -> None:
    """Background task to wake AWX and deploy a catalog entry."""
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
            name=jt_name,
            ssl_verify=settings.awx.ssl_verify,
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
    except Exception as exc:
        logger.exception("Unexpected error in deploy operation %s", operation_id)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="Unexpected error while deploying",
        )


async def _run_teardown_operation(app: FastAPI, operation_id: str, key: str, jt_name: str) -> None:
    """Background task to wake AWX and teardown a catalog entry."""
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
            name=jt_name,
            ssl_verify=settings.awx.ssl_verify,
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
    except Exception as exc:
        logger.exception("Unexpected error in teardown operation %s", operation_id)
        ops_store.update(
            operation_id,
            state=OperationState.ERROR,
            error="Unexpected error while tearing down",
        )


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
        user = session_user(request.session)
        if user is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)

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
        try:
            templates = list_job_templates(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                ssl_verify=settings.awx.ssl_verify,
            )
            return JSONResponse({
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
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.awx.configured:
            return JSONResponse({"error": "AWX API not configured"}, status_code=503)

        # Async operation flow (when autoscale enabled)
        if settings.awx_autoscale.enabled:
            if not settings.awx_autoscale.configured:
                return JSONResponse({"error": "AWX autoscale enabled but misconfigured"}, status_code=503)

            ops_store = request.app.state.operations

            # Atomic dedupe: find existing or create new under one lock
            op, created = ops_store.get_or_create(action="launch", target=workflow_name)

            if not created:
                # Existing operation found - return it without spawning new task
                # v1 behavior: browser refresh loses live spinner but re-clicking
                # safely reattaches via get_or_create (no double launch)
                return JSONResponse(op.to_dict(), status_code=200)

            # Spawn background task with tracking
            task = asyncio.create_task(_run_launch_operation(
                request.app, op.operation_id, workflow_name
            ))
            request.app.state.operation_tasks.add(task)
            task.add_done_callback(request.app.state.operation_tasks.discard)

            return JSONResponse(op.to_dict(), status_code=202)

        # Sync flow (autoscale disabled)
        try:
            template = lookup_job_template_by_name(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=workflow_name,
                ssl_verify=settings.awx.ssl_verify,
            )
            if template is None:
                return JSONResponse({"error": f"workflow '{workflow_name}' not found in AWX"}, status_code=404)
            job_id = launch_job(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
            )
            return JSONResponse({"job_id": job_id, "status": "launched"})
        except AWXAPIError as exc:
            return JSONResponse({"error": f"AWX API error: {exc.body}"}, status_code=exc.status)

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
        user = session_user(request.session)
        if user is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse({
            "subject": user.subject,
            "display_name": user.display_name,
            "email": user.email,
            "role": user.role,
            "groups": user.groups,
            "awx_configured": settings.awx.configured,
            "authentik_configured": settings.authentik.configured,
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
        user = session_user(request.session)
        if user is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if user.role != "admin":
            return JSONResponse({"error": "forbidden"}, status_code=403)

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
        user = session_user(request.session)
        if user is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if user.role != "admin":
            return JSONResponse({"error": "forbidden"}, status_code=403)
        if not settings.authentik.configured:
            return JSONResponse({"error": "Authentik not configured"}, status_code=503)

        raw_users = list_users(
            api_url=settings.authentik.api_url,
            api_token=settings.authentik.api_token,
        )

        def _dmf_role(groups: list[dict]) -> str:
            group_names = {g.get("name", "") for g in groups}
            for role in reversed(ROLE_ORDER):
                if group_names & ROLE_GROUPS[role]:
                    return role
            return "viewer"

        users_out = []
        for u in raw_users:
            if not u.get("is_active", True):
                continue
            groups = u.get("groups_obj", [])
            users_out.append({
                "username": u.get("username", ""),
                "display_name": u.get("name", ""),
                "email": u.get("email", ""),
                "role": _dmf_role(groups),
                "last_login": u.get("last_login"),
                "is_active": u.get("is_active", True),
            })

        return JSONResponse({"users": users_out})

    @app.get("/api/admin/jobs")
    async def api_admin_jobs(request: Request):
        user = session_user(request.session)
        if user is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if user.role != "admin":
            return JSONResponse({"error": "forbidden"}, status_code=403)
        if not settings.awx.configured:
            return JSONResponse({"jobs": []})

        raw_jobs = list_recent_jobs(
            api_url=settings.awx.api_url,
            api_token=settings.awx.api_token,
            ssl_verify=settings.awx.ssl_verify,
        )

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

        return JSONResponse({"jobs": jobs_out})

    # ------------------------------------------------------------------
    # Admin groups endpoint
    # ------------------------------------------------------------------
    @app.get("/api/admin/groups")
    async def api_admin_groups(request: Request):
        user = session_user(request.session)
        if user is None:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if user.role != "admin":
            return JSONResponse({"error": "forbidden"}, status_code=403)
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
        """Launch the AWX job template for this catalog entry."""
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.awx.configured:
            return JSONResponse({"error": "AWX API not configured"}, status_code=503)
        index = _catalog_index()
        entry = index.get(key)
        if entry is None:
            return JSONResponse({"error": f"catalog entry '{key}' not found"}, status_code=404)
        jt_name = (entry.configure or {}).get("awx_job_template")
        if not jt_name:
            return JSONResponse({"error": f"entry '{key}' has no configure.awx_job_template"}, status_code=500)

        # Async operation flow (when autoscale enabled)
        if settings.awx_autoscale.enabled:
            if not settings.awx_autoscale.configured:
                return JSONResponse({"error": "AWX autoscale enabled but misconfigured"}, status_code=503)

            ops_store = request.app.state.operations

            # Atomic dedupe: find existing or create new under one lock
            op, created = ops_store.get_or_create(action="deploy", target=key)

            if not created:
                # Existing operation found - return it without spawning new task
                # v1 behavior: browser refresh loses live spinner but re-clicking
                # safely reattaches via get_or_create (no double launch)
                return JSONResponse(op.to_dict(), status_code=200)

            # Spawn background task with tracking
            task = asyncio.create_task(_run_deploy_operation(
                request.app, op.operation_id, key, jt_name
            ))
            request.app.state.operation_tasks.add(task)
            task.add_done_callback(request.app.state.operation_tasks.discard)

            return JSONResponse(op.to_dict(), status_code=202)

        # Sync flow (autoscale disabled)
        try:
            template = lookup_job_template_by_name(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=jt_name,
                ssl_verify=settings.awx.ssl_verify,
            )
            if template is None:
                return JSONResponse({"error": f"AWX job template '{jt_name}' not found"}, status_code=404)
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
                return JSONResponse({"job_id": active, "status": "already-active"})
            job_id = launch_job(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
            )
            return JSONResponse({"job_id": job_id, "status": "launched"})
        except AWXAPIError as exc:
            return JSONResponse({"error": f"AWX API error: {exc.body}"}, status_code=exc.status)

    @app.post("/api/catalog/{key}/teardown")
    async def api_catalog_teardown(request: Request, key: str):
        """Launch the finalise (teardown) AWX job template for this catalog entry."""
        if not _require_user(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not settings.awx.configured:
            return JSONResponse({"error": "AWX API not configured"}, status_code=503)
        index = _catalog_index()
        entry = index.get(key)
        if entry is None:
            return JSONResponse({"error": f"catalog entry '{key}' not found"}, status_code=404)
        jt_name = (entry.finalise or {}).get("awx_job_template")
        if not jt_name:
            return JSONResponse({"error": f"entry '{key}' has no finalise.awx_job_template"}, status_code=500)

        # Async operation flow (when autoscale enabled)
        if settings.awx_autoscale.enabled:
            if not settings.awx_autoscale.configured:
                return JSONResponse({"error": "AWX autoscale enabled but misconfigured"}, status_code=503)

            ops_store = request.app.state.operations

            # Atomic dedupe: find existing or create new under one lock
            op, created = ops_store.get_or_create(action="teardown", target=key)

            if not created:
                # Existing operation found - return it without spawning new task
                # v1 behavior: browser refresh loses live spinner but re-clicking
                # safely reattaches via get_or_create (no double launch)
                return JSONResponse(op.to_dict(), status_code=200)

            # Spawn background task with tracking
            task = asyncio.create_task(_run_teardown_operation(
                request.app, op.operation_id, key, jt_name
            ))
            request.app.state.operation_tasks.add(task)
            task.add_done_callback(request.app.state.operation_tasks.discard)

            return JSONResponse(op.to_dict(), status_code=202)

        # Sync flow (autoscale disabled)
        try:
            template = lookup_job_template_by_name(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                name=jt_name,
                ssl_verify=settings.awx.ssl_verify,
            )
            if template is None:
                return JSONResponse({"error": f"AWX job template '{jt_name}' not found"}, status_code=404)
            # Idempotency guard (symmetric with deploy): return an in-flight
            # teardown job for this template instead of launching a duplicate.
            active = find_active_job_for_template(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
            )
            if active is not None:
                return JSONResponse({"job_id": active, "status": "already-active"})
            job_id = launch_job(
                api_url=settings.awx.api_url,
                api_token=settings.awx.api_token,
                job_template_id=template["id"],
                ssl_verify=settings.awx.ssl_verify,
            )
            return JSONResponse({"job_id": job_id, "status": "launched"})
        except AWXAPIError as exc:
            return JSONResponse({"error": f"AWX API error: {exc.body}"}, status_code=exc.status)

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
        try:
            body = await request.json()
        except Exception:
            body = None
        reason = (body or {}).get("reason", "")
        if not isinstance(reason, str) or not reason.strip():
            return JSONResponse(
                {"error": "reason-required", "detail": "a non-empty 'reason' field is mandatory (C5)"},
                status_code=400,
            )
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
            reason.strip(),
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
                "reason": reason.strip(),
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
