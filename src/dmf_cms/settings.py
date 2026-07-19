from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import logging
import os

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_strict_bool_fail_safe_on(name: str, default: bool = True) -> bool:
    """Shared strict tri-state parser for kill-switch-style booleans (codex R3-3).

    Deliberately narrower than the generic ``_env_bool`` above — that
    helper treats ANY unrecognized token as False, so a typo'd 'tru' would
    silently flip the feature OFF by accident. This one fails SAFE-ON:
    ``'false'``/``'0'``/``'no'`` (case-insensitive) are the only ways to
    turn it off; ``'true'``/``'1'``/``'yes'`` or an unset/blank value keep
    it on; any OTHER token also keeps it on (never silently disables a
    capacity/rollback-relevant gate on a typo) but logs a loud warning
    naming the bad value so the typo is visible, not silent. Shared by L3's
    ``enabled`` (the kill switch, WP1 R3-3) and ``auto_rollback`` (WP2) —
    both are "a typo here must never silently turn safety off" booleans.
    """
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    normalized = value.strip().lower()
    if normalized in {"false", "0", "no"}:
        return False
    if normalized in {"true", "1", "yes"}:
        return True
    logger.warning(
        "%s=%r is not a recognized true/false token — defaulting to enabled "
        "(this is a fail-safe-ON switch: a typo must never silently turn it off)",
        name, value,
    )
    return True


def _env_l3_enabled(name: str, default: bool = True) -> bool:
    """Strict tri-state parser for the L3 kill switch (codex #202 WP1 R3-3).

    Thin wrapper over ``_env_strict_bool_fail_safe_on`` — kept as its own
    named function since it's referenced directly by name in tests and by
    the L3Settings docstring.
    """
    return _env_strict_bool_fail_safe_on(name, default)


def _env_positive_int(name: str, default: int) -> int:
    """Parse a positive-int env var; unset/blank uses ``default`` silently.

    An unparseable value OR a value <= 0 falls back to ``default`` WITH a
    logged warning — a zero/negative L3 EE floor would silently defeat the
    §3.2(b) conservative-reserve contract (umbrella #202 WP1 R2-9), so a
    misconfiguration here must be visible, not just quietly ignored.
    """
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value.strip())
    except ValueError:
        logger.warning("%s=%r is not a valid integer; using default %d", name, value, default)
        return default
    if parsed <= 0:
        logger.warning("%s=%d must be > 0; using default %d", name, parsed, default)
        return default
    return parsed


def _env_tuple(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return tuple(part.strip() for part in value.split(",") if part.strip())


def _env_choice(name: str, default: str, allowed: tuple[str, ...]) -> str:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    normalized = value.strip().lower()
    if normalized not in allowed:
        allowed_values = ", ".join(allowed)
        raise ValueError(f"{name} must be one of: {allowed_values}")
    return normalized


def _normalize_base_path(value: str | None) -> str:
    if not value:
        return "/"
    cleaned = "/" + value.strip().strip("/")
    return "/" if cleaned == "//" else cleaned


@dataclass(frozen=True)
class OIDCSettings:
    enabled: bool = False
    issuer_url: str = ""
    # Optional internal back-channel base for discovery/token/userinfo (ADR-0023).
    # When set, server-side OIDC calls use this cluster-internal URL; the browser
    # authorize redirect still derives from the public ``issuer_url`` (front-channel).
    # ``issuer_url`` remains the canonical identity issuer.
    backchannel_issuer_url: str = ""
    client_id: str = ""
    client_secret: str = ""
    scopes: tuple[str, ...] = ("openid", "profile", "email", "groups")
    callback_path: str = "/auth/callback"
    logout_redirect_path: str = "/"
    logout_redirect_url: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.issuer_url and self.client_id and self.client_secret)

    @property
    def discovery_base_url(self) -> str:
        """Base URL for server-side OIDC calls (back-channel if set, else public)."""
        return self.backchannel_issuer_url or self.issuer_url


@dataclass(frozen=True)
class AuthentikSettings:
    api_url: str = ""
    api_token: str = ""
    # Public, browser-resolvable base for user-facing enrollment URLs. ``api_url``
    # is the (cluster-internal) back-channel for API calls; enrollment links handed
    # to humans must use this public host (ADR-0023 user-facing carve-out).
    public_base_url: str = ""
    enrollment_flow_slug: str = "dmf-bootstrap-passkey-enrollment"
    invitation_ttl_hours: int = 24

    @property
    def configured(self) -> bool:
        return bool(self.api_url and self.api_token)

    @property
    def enrollment_base_url(self) -> str:
        """Public base for enrollment URLs (falls back to api_url for local/dev)."""
        return self.public_base_url or self.api_url


@dataclass(frozen=True)
class AWXSettings:
    api_url: str = ""
    api_token: str = ""
    ssl_verify: bool = False

    @property
    def configured(self) -> bool:
        return bool(self.api_url and self.api_token)


@dataclass(frozen=True)
class AWXAutoscaleSettings:
    """On-demand scale-to-zero helper integration (WS1/WS5).

    When enabled, dmf-cms calls POST {helper_url}/ensure-awake before any
    AWX API read. The helper wakes AWX (idempotent, single-flight) and
    blocks until ready. grace_period lives in the helper, not here.
    
    max_startup_wait MUST be >= helper AWX_AUTOSCALE_MAX_STARTUP_WAIT (1200s)
    plus margin. Pi cold wake measured at ~15 min.
    """
    enabled: bool = False
    helper_url: str = ""
    max_startup_wait: int = 1260
    bearer_token: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.helper_url and self.bearer_token)


@dataclass(frozen=True)
class NetboxSettings:
    api_url: str = ""
    api_token: str = ""
    ssl_verify: bool = False
    # Scoped catalog-writer token (ADR-0032, `dmf-catalog-svc` class) for the
    # ONE console write: the media-workloads clear-for-deployment tag flip.
    # Reads stay on api_token; the write endpoint is dark (503) when unset.
    writer_token: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.api_url and self.api_token)

    @property
    def write_configured(self) -> bool:
        return bool(self.api_url and self.writer_token)


@dataclass(frozen=True)
class PrometheusSettings:
    url: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.url)


@dataclass(frozen=True)
class MediaTenancySettings:
    """Tenancy posture for the Media Workloads surface (ADR-0037).

    Fail-closed by design: with ``mode`` unset the endpoints stay dark
    (``configured: false``). ``single`` is the *explicitly declared*
    single-tenant posture (all instances visible to permitted roles).
    ``scoped`` enforces the raw OIDC-group -> NetBox-tenant map server-side;
    a scoped user whose groups map to nothing sees nothing (and writes 404).
    Groups are tenancy, roles are capability — the map keys are raw group
    names, never console roles.
    """

    mode: str = ""  # "" | "single" | "scoped"
    group_tenant_map: tuple[tuple[str, tuple[str, ...]], ...] = ()

    @property
    def configured(self) -> bool:
        return self.mode in ("single", "scoped")

    def tenants_for(self, groups: tuple[str, ...]) -> tuple[str, ...] | None:
        """Return permitted NetBox tenant slugs, or ``None`` for unscoped.

        ``None`` means "no tenant filter" (single mode). An empty tuple means
        "no visibility" (scoped mode, no mapped groups) — callers must treat
        it as an empty result set, never fall through to unscoped.
        """
        if self.mode == "single":
            return None
        mapping = dict(self.group_tenant_map)
        out: list[str] = []
        for group in groups:
            for slug in mapping.get(group, ()):  # fail closed on unmapped
                if slug not in out:
                    out.append(slug)
        return tuple(out)


@dataclass(frozen=True)
class L3Settings:
    """L3 console capacity preflight (umbrella dmfdeploy/dmfdeploy#202 WP1).

    The early operator-facing gate: budgets a run's incremental demand +
    an AWX EE job pod reserve against node allocatable, over
    ``prometheus.query()`` (no k8s client in the console).

    ``enabled`` is THE one documented kill switch (codex R2-1) — an
    explicit, operator-chosen "this tier does not run here". Setting it
    False is fail-OPEN by design: every deploy proceeds exactly as it did
    pre-#202. It is NOT the same knob as an unconfigured ``prometheus`` —
    with ``enabled=True`` but Prometheus unconfigured, the handler refuses
    (fail-CLOSED, 409 ``budget-unavailable``), because the console tier has
    exactly one seam to supply data and "enabled but can't read supply"
    must never silently pass as a no-op. Loaded via ``_env_l3_enabled``
    (codex R3-3): a KILL SWITCH must fail safe-ON — an unrecognized env
    token (a typo like ``'tru'``) logs a loud warning and stays enabled,
    never silently disables the gate the way the generic ``_env_bool``
    would.

    ``ee_floor_cpu_millicores``/``ee_floor_memory_mib`` are the §3.2(b)
    conservative floor applied when the AWX EE Container Group's declared
    worker+init+overhead sum is absent, zero, or unparseable — never
    reserve nothing for the run's own executor pod. Loaded via
    ``_env_positive_int``: an unparseable or non-positive env value falls
    back to the default with a logged warning, never silently to 0.

    umbrella #202 WP2 additions — the run-tracking substrate:

    * ``job_poll_interval_seconds`` — how often the job watcher
      (main.py ``_watch_job_operation``) polls AWX for a dispatched
      run's status. Positive-validated like the EE floors.
    * ``rollback_jt_name`` — the AWX job template WP2-B's rollback
      command launches on a ``failed_rollback_required`` operation.
    * ``auto_rollback`` — whether WP2-B auto-triggers that rollback
      command on ``failed_rollback_required``, or only surfaces the state
      for a human to act on. Strict tri-state, fail-safe-ON like
      ``enabled`` — a typo here must never silently turn auto-rollback off
      the way the generic ``_env_bool`` would.
    """

    enabled: bool = True
    ee_floor_cpu_millicores: int = 250
    ee_floor_memory_mib: int = 512
    job_poll_interval_seconds: int = 10
    rollback_jt_name: str = "media-rollback-run"
    auto_rollback: bool = True


@dataclass(frozen=True)
class ForgejoSettings:
    api_url: str = ""
    api_token: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.api_url and self.api_token)


@dataclass(frozen=True)
class MXLEndpoint:
    role: str        # producer | receiver
    provider: str    # cloud slug for the UI logo (e.g. aliyun) — NO IPs in the UI
    url: str         # status-sidecar base URL (node tailnet IP) — backend-only, never shown


@dataclass(frozen=True)
class MXLSettings:
    """MXL status-sidecar config for the Media Workloads live-view surface.

    Two independent surfaces share this block:

    * ``endpoints`` — the *static* split-node (tailnet-only) demo aggregate for
      the legacy ``/api/mxl/*`` page. Configured via DMF_CONSOLE_MXL_ENDPOINTS as
      comma-separated ``role|provider|url`` entries. URLs hold internal (tailnet)
      addresses and live ONLY in runtime config — never committed (this repo is
      gitleaks-enforced) and never surfaced in the UI. Docstring-deprecated;
      retired with that demo.
    * ``sidecar_namespaces`` / ``sidecar_ports`` — the SSRF allowlists for the
      *per-instance* NetBox-derived MXL endpoints (WP-D / G26). A NetBox writer
      stamps ``cluster_service``/``cluster_namespace``/``cluster_port`` custom
      fields; the console only ever composes an in-cluster URL when the namespace
      and port are in these allowlists AND ``cluster_service`` equals the
      instance's own service name — so arbitrary coords can't turn the console
      into an in-cluster proxy (codex WP-D P1).
    """

    endpoints: tuple[MXLEndpoint, ...] = ()
    # Tight defaults matching the shipped mxl catalog (dmf-runbooks roles/mxl,
    # dmf-media mxl-fabrics-demo chart): namespace ``mxl``, sidecar port 9000.
    sidecar_namespaces: frozenset[str] = frozenset({"mxl"})
    sidecar_ports: frozenset[int] = frozenset({9000})

    @property
    def configured(self) -> bool:
        return bool(self.endpoints)


def _parse_mxl_endpoints(raw: str | None) -> tuple[MXLEndpoint, ...]:
    if not raw or not raw.strip():
        return ()
    out: list[MXLEndpoint] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        parts = [p.strip() for p in entry.split("|")]
        if len(parts) != 3:
            raise ValueError("DMF_CONSOLE_MXL_ENDPOINTS entries must be 'role|provider|url'")
        out.append(MXLEndpoint(role=parts[0], provider=parts[1], url=parts[2].rstrip("/")))
    return tuple(out)


def _parse_str_set(raw: str | None, default: frozenset[str]) -> frozenset[str]:
    """Comma/space-separated string allowlist; blank/absent -> default."""
    if raw is None:
        return default
    items = {p.strip() for p in raw.replace(",", " ").split() if p.strip()}
    return frozenset(items) if items else default


def _parse_int_set(raw: str | None, default: frozenset[int]) -> frozenset[int]:
    """Comma/space-separated int allowlist; blank/absent -> default.

    Fail-closed for a *security* allowlist (codex WP-D P3): non-integer tokens
    are dropped, and an explicit-but-all-invalid value yields an EMPTY set
    (every live view goes dark — a loud, visible failure the operator fixes)
    rather than silently re-enabling the default. Only a genuinely blank/absent
    value falls back to the default.
    """
    if raw is None or not raw.strip():
        return default
    items: set[int] = set()
    for tok in raw.replace(",", " ").split():
        try:
            items.add(int(tok))
        except ValueError:
            continue
    return frozenset(items)


@dataclass(frozen=True)
class Settings:
    display_name: str = "DMF Console"
    base_path: str = "/"
    runtime_mode: str = "local"
    secret_key: str = "change-me-in-production"
    app_contract_path: Path = Path("config/app-contracts.yaml")
    dev_login_enabled: bool = True
    dev_username: str = "operator"
    dev_display_name: str = "DMF Operator"
    dev_email: str = "operator@example.invalid"
    dev_groups: tuple[str, ...] = ("dmf-console-viewer",)
    oidc: OIDCSettings = field(default_factory=OIDCSettings)
    authentik: AuthentikSettings = field(default_factory=AuthentikSettings)
    awx: AWXSettings = field(default_factory=AWXSettings)
    awx_autoscale: AWXAutoscaleSettings = field(default_factory=AWXAutoscaleSettings)
    netbox: NetboxSettings = field(default_factory=NetboxSettings)
    prometheus: PrometheusSettings = field(default_factory=PrometheusSettings)
    l3: L3Settings = field(default_factory=L3Settings)
    forgejo: ForgejoSettings = field(default_factory=ForgejoSettings)
    mxl: MXLSettings = field(default_factory=MXLSettings)
    media_tenancy: MediaTenancySettings = field(default_factory=MediaTenancySettings)


def _parse_group_tenant_map(raw: str | None) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """Parse DMF_CONSOLE_MEDIA_GROUP_TENANT_MAP.

    Format: ``group=tenant1|tenant2;group2=tenant3`` (semicolon-separated
    entries, pipe-separated tenant slugs). Malformed entries are dropped with
    a fail-closed effect (unmapped group -> no visibility in scoped mode).
    """
    if not raw:
        return ()
    out: list[tuple[str, tuple[str, ...]]] = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk or "=" not in chunk:
            continue
        group, _, tenants = chunk.partition("=")
        group = group.strip()
        slugs = tuple(s.strip() for s in tenants.split("|") if s.strip())
        if group and slugs:
            out.append((group, slugs))
    return tuple(out)


def load_settings() -> Settings:
    return Settings(
        display_name=os.getenv("DMF_CONSOLE_DISPLAY_NAME", "DMF Console"),
        base_path=_normalize_base_path(os.getenv("DMF_CONSOLE_BASE_PATH")),
        runtime_mode=_env_choice("DMF_CONSOLE_RUNTIME_MODE", "local", ("local", "cluster")),
        secret_key=os.getenv("DMF_CONSOLE_SECRET_KEY", "change-me-in-production"),
        app_contract_path=Path(os.getenv("DMF_CONSOLE_APP_CONTRACT_PATH", "config/app-contracts.yaml")),
        dev_login_enabled=_env_bool("DMF_CONSOLE_DEV_LOGIN_ENABLED", True),
        dev_username=os.getenv("DMF_CONSOLE_DEV_USERNAME", "operator"),
        dev_display_name=os.getenv("DMF_CONSOLE_DEV_DISPLAY_NAME", "DMF Operator"),
        dev_email=os.getenv("DMF_CONSOLE_DEV_EMAIL", "operator@example.invalid"),
        dev_groups=_env_tuple("DMF_CONSOLE_DEV_GROUPS", ("dmf-console-viewer",)),
        oidc=OIDCSettings(
            enabled=_env_bool("DMF_CONSOLE_OIDC_ENABLED", False),
            issuer_url=os.getenv("DMF_CONSOLE_OIDC_ISSUER_URL", ""),
            backchannel_issuer_url=os.getenv("DMF_CONSOLE_OIDC_BACKCHANNEL_ISSUER_URL", ""),
            client_id=os.getenv("DMF_CONSOLE_OIDC_CLIENT_ID", ""),
            client_secret=os.getenv("DMF_CONSOLE_OIDC_CLIENT_SECRET", ""),
            scopes=_env_tuple("DMF_CONSOLE_OIDC_SCOPES", ("openid", "profile", "email", "groups")),
            callback_path=os.getenv("DMF_CONSOLE_OIDC_CALLBACK_PATH", "/auth/callback"),
            logout_redirect_path=os.getenv("DMF_CONSOLE_OIDC_LOGOUT_REDIRECT_PATH", "/"),
            logout_redirect_url=os.getenv("DMF_CONSOLE_OIDC_LOGOUT_REDIRECT_URL", ""),
        ),
        authentik=AuthentikSettings(
            api_url=os.getenv("DMF_CONSOLE_AUTHENTIK_API_URL", ""),
            api_token=os.getenv("DMF_CONSOLE_AUTHENTIK_API_TOKEN", ""),
            public_base_url=os.getenv("DMF_CONSOLE_AUTHENTIK_PUBLIC_BASE_URL", ""),
            enrollment_flow_slug=os.getenv("DMF_CONSOLE_AUTHENTIK_ENROLLMENT_FLOW", "dmf-bootstrap-passkey-enrollment"),
            invitation_ttl_hours=int(os.getenv("DMF_CONSOLE_AUTHENTIK_INVITATION_TTL", "24")),
        ),
        awx=AWXSettings(
            api_url=os.getenv("DMF_CONSOLE_AWX_API_URL", ""),
            api_token=os.getenv("DMF_CONSOLE_AWX_API_TOKEN", ""),
            ssl_verify=_env_bool("DMF_CONSOLE_AWX_SSL_VERIFY", False),
        ),
        awx_autoscale=AWXAutoscaleSettings(
            enabled=_env_bool("DMF_CONSOLE_AWX_AUTOSCALE_ENABLED", False),
            helper_url=os.getenv("DMF_CONSOLE_AWX_AUTOSCALE_HELPER_URL", ""),
            max_startup_wait=int(os.getenv("DMF_CONSOLE_AWX_AUTOSCALE_MAX_STARTUP_WAIT", "1260")),
            bearer_token=os.getenv("DMF_CONSOLE_AWX_AUTOSCALE_BEARER_TOKEN", ""),
        ),
        netbox=NetboxSettings(
            api_url=os.getenv("DMF_CONSOLE_NETBOX_API_URL", ""),
            api_token=os.getenv("DMF_CONSOLE_NETBOX_API_TOKEN", ""),
            ssl_verify=_env_bool("DMF_CONSOLE_NETBOX_SSL_VERIFY", False),
            writer_token=os.getenv("DMF_CONSOLE_NETBOX_WRITER_TOKEN", ""),
        ),
        prometheus=PrometheusSettings(
            url=os.getenv("DMF_CONSOLE_PROMETHEUS_URL", ""),
        ),
        l3=L3Settings(
            enabled=_env_l3_enabled("DMF_CONSOLE_L3_ENABLED", True),
            ee_floor_cpu_millicores=_env_positive_int("DMF_CONSOLE_L3_EE_FLOOR_CPU_MILLICORES", 250),
            ee_floor_memory_mib=_env_positive_int("DMF_CONSOLE_L3_EE_FLOOR_MEMORY_MIB", 512),
            job_poll_interval_seconds=_env_positive_int("DMF_CONSOLE_L3_JOB_POLL_INTERVAL_SECONDS", 10),
            rollback_jt_name=os.getenv("DMF_CONSOLE_L3_ROLLBACK_JT_NAME", "media-rollback-run"),
            auto_rollback=_env_strict_bool_fail_safe_on("DMF_CONSOLE_L3_AUTO_ROLLBACK", True),
        ),
        forgejo=ForgejoSettings(
            api_url=os.getenv("DMF_CONSOLE_FORGEJO_API_URL", ""),
            api_token=os.getenv("DMF_CONSOLE_FORGEJO_API_TOKEN", ""),
        ),
        mxl=MXLSettings(
            endpoints=_parse_mxl_endpoints(os.getenv("DMF_CONSOLE_MXL_ENDPOINTS")),
            sidecar_namespaces=_parse_str_set(
                os.getenv("DMF_CONSOLE_MXL_SIDECAR_NAMESPACES"), frozenset({"mxl"})
            ),
            sidecar_ports=_parse_int_set(
                os.getenv("DMF_CONSOLE_MXL_SIDECAR_PORTS"), frozenset({9000})
            ),
        ),
        media_tenancy=MediaTenancySettings(
            mode=_env_choice("DMF_CONSOLE_MEDIA_TENANCY", "", ("", "single", "scoped")),
            group_tenant_map=_parse_group_tenant_map(
                os.getenv("DMF_CONSOLE_MEDIA_GROUP_TENANT_MAP")
            ),
        ),
    )
