from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import os


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


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

    @property
    def configured(self) -> bool:
        return bool(self.api_url and self.api_token)


@dataclass(frozen=True)
class PrometheusSettings:
    url: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.url)


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
    """MXL demo status-sidecar endpoints for the 'MXL Flows' evaluation page.

    Configured via DMF_CONSOLE_MXL_ENDPOINTS as comma-separated `role|provider|url`
    entries, e.g. ``producer|aliyun|http://host:9000,receiver|aliyun|http://host:9000``.
    URLs hold internal (tailnet) addresses and live ONLY in runtime config — never
    committed (this repo is gitleaks-enforced) and never surfaced in the UI.
    """

    endpoints: tuple[MXLEndpoint, ...] = ()

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
    forgejo: ForgejoSettings = field(default_factory=ForgejoSettings)
    mxl: MXLSettings = field(default_factory=MXLSettings)


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
        ),
        prometheus=PrometheusSettings(
            url=os.getenv("DMF_CONSOLE_PROMETHEUS_URL", ""),
        ),
        forgejo=ForgejoSettings(
            api_url=os.getenv("DMF_CONSOLE_FORGEJO_API_URL", ""),
            api_token=os.getenv("DMF_CONSOLE_FORGEJO_API_TOKEN", ""),
        ),
        mxl=MXLSettings(
            endpoints=_parse_mxl_endpoints(os.getenv("DMF_CONSOLE_MXL_ENDPOINTS")),
        ),
    )
