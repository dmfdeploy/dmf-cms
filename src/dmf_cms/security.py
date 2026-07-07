from __future__ import annotations

import base64
from dataclasses import dataclass, replace
import hashlib
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
import json
import secrets
import urllib.request

from .settings import OIDCSettings, Settings


ROLE_ORDER = ("viewer", "operator", "engineer", "admin")
ROLE_GROUPS = {
    "viewer": {"dmf-console-viewer"},
    "operator": {"dmf-console-operator"},
    "engineer": {"dmf-console-engineer"},
    "admin": {"dmf-console-admin"},
}

# Media Workloads surface group (ADR-0037 §5): membership grants the Media
# Workloads surface — read and the clear-for-deployment write — without
# granting the engineer capability role. Tenancy scope within the surface
# stays with MediaTenancySettings (dmfdeploy/dmfdeploy#174).
MEDIA_ENGINEERS_GROUP = "media-engineers"

# Roles a real admin may *view as* (dmfdeploy/dmfdeploy#185 WP-B). Strictly a
# downgrade: "admin" is excluded (it is the real ceiling, not a simulated
# level) and unknown roles are rejected, so view-as can only ever reduce
# capability, never grant it.
VIEW_AS_ROLES = frozenset({"viewer", "operator", "engineer"})


@dataclass(frozen=True)
class UserIdentity:
    subject: str
    display_name: str
    email: str
    groups: tuple[str, ...]
    role: str


def current_role(groups: tuple[str, ...]) -> str:
    normalized = set(groups)
    for role in reversed(ROLE_ORDER):
        if normalized & ROLE_GROUPS[role]:
            return role
    return "viewer"


def role_at_least(role: str, minimum: str) -> bool:
    """True when *role* meets or exceeds *minimum* in ROLE_ORDER.

    Unknown roles rank below viewer (fail closed). Roles are capability;
    tenancy scope is a separate axis (MediaTenancySettings).
    """
    try:
        have = ROLE_ORDER.index(role)
    except ValueError:
        return False
    return have >= ROLE_ORDER.index(minimum)


def user_from_claims(claims: dict[str, object]) -> UserIdentity:
    raw_groups = claims.get("groups", [])
    if isinstance(raw_groups, str):
        groups = tuple(group.strip() for group in raw_groups.split(",") if group.strip())
    elif isinstance(raw_groups, (list, tuple, set)):
        groups = tuple(str(group) for group in raw_groups if str(group))
    else:
        groups = ()
    subject = str(claims.get("sub", "") or claims.get("preferred_username", "") or "unknown")
    display_name = str(claims.get("name", "") or claims.get("preferred_username", "") or subject)
    email = str(claims.get("email", "") or "")
    return UserIdentity(
        subject=subject,
        display_name=display_name,
        email=email,
        groups=groups,
        role=current_role(groups),
    )


def dev_user(settings: Settings) -> UserIdentity:
    return UserIdentity(
        subject=settings.dev_username,
        display_name=settings.dev_display_name,
        email=settings.dev_email,
        groups=settings.dev_groups,
        role=current_role(settings.dev_groups),
    )


def is_authenticated(session: dict[str, object]) -> bool:
    return "user" in session


def session_user(session: dict[str, object]) -> UserIdentity | None:
    raw = session.get("user")
    if not isinstance(raw, dict):
        return None
    groups = raw.get("groups", [])
    if isinstance(groups, list):
        normalized_groups = tuple(str(group) for group in groups)
    else:
        normalized_groups = ()
    return UserIdentity(
        subject=str(raw.get("subject", "")),
        display_name=str(raw.get("display_name", "")),
        email=str(raw.get("email", "")),
        groups=normalized_groups,
        role=str(raw.get("role", "viewer")),
    )


def effective_user(session: dict[str, object]) -> UserIdentity | None:
    """The real user, optionally downgraded by an admin's active view-as.

    Backend authorization runs against THIS, not ``session_user``: a real
    admin who has set ``session["view_as"]`` to a lower role is treated as
    that role everywhere a gate looks. Fails closed — the downgrade applies
    only when the real role is admin AND the stored view-as is a valid
    strict-downgrade role; anything else (non-admin with a stale key, an
    unknown/admin view-as value) returns the real identity untouched.

    Groups are NOT altered — view-as simulates "same groups, lower role"
    without mutating identity (ADR-0028-safe), so a surface gated on group
    membership (e.g. media-engineers) still admits a downgraded admin exactly
    as it would a real viewer in that group.
    """
    user = session_user(session)
    if user is None:
        return None
    view_as = session.get("view_as")
    if user.role == "admin" and isinstance(view_as, str) and view_as in VIEW_AS_ROLES:
        return replace(user, role=view_as)
    return user


def store_user(session: dict[str, object], user: UserIdentity) -> None:
    session["user"] = {
        "subject": user.subject,
        "display_name": user.display_name,
        "email": user.email,
        "groups": list(user.groups),
        "role": user.role,
    }
    # Never inherit a stale downgrade across a fresh login / identity refresh:
    # every path that (re)establishes the real user drops any prior view-as.
    session.pop("view_as", None)


def clear_user(session: dict[str, object]) -> None:
    session.pop("user", None)
    session.pop("view_as", None)
    session.pop("oidc_state", None)
    session.pop("oidc_nonce", None)
    session.pop("oidc_code_verifier", None)


def new_state() -> str:
    return secrets.token_urlsafe(24)


def new_pkce_verifier() -> str:
    return secrets.token_urlsafe(48)


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")


def discovery_document(settings: OIDCSettings) -> dict[str, object]:
    if not settings.issuer_url:
        raise ValueError("OIDC issuer URL is not configured")
    # Fetch over the back-channel base (cluster-internal plain HTTP when configured,
    # else the public issuer). Endpoints in the returned document are made
    # browser-safe per-use: build_authorize_url() rewrites the authorize endpoint
    # to the public issuer origin; token/userinfo stay on the back-channel host.
    base = settings.discovery_base_url
    url = urljoin(base.rstrip("/") + "/", ".well-known/openid-configuration")
    with urllib.request.urlopen(url, timeout=5) as response:
        payload = response.read().decode("utf-8")
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise ValueError("OIDC discovery document must be a JSON object")
    return data


def build_authorize_url(
    discovery: dict[str, object],
    settings: OIDCSettings,
    redirect_uri: str,
    state: str,
    nonce: str,
    code_challenge: str | None = None,
) -> str:
    # Front-channel: the authorize endpoint must be browser-resolvable. Take the
    # path/query from discovery but force the scheme+host of the public issuer, so
    # an internal back-channel discovery fetch still yields a public redirect.
    # No-op when issuer_url and the discovery host already match (no split).
    discovered = urlsplit(str(discovery["authorization_endpoint"]))
    public = urlsplit(settings.issuer_url)
    # Keep only scheme+host+path; the OIDC query is appended below as ?{query},
    # so any discovery query/fragment must be dropped (else a double "?").
    authorize_endpoint = urlunsplit((public.scheme, public.netloc, discovered.path, "", ""))
    query_params = {
        "client_id": settings.client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(settings.scopes),
        "state": state,
        "nonce": nonce,
    }
    if code_challenge:
        query_params["code_challenge"] = code_challenge
        query_params["code_challenge_method"] = "S256"
    query = urlencode(query_params)
    return f"{authorize_endpoint}?{query}"


def build_end_session_url(
    discovery: dict[str, object],
    settings: OIDCSettings,
    post_logout_redirect_uri: str = "",
    id_token_hint: str | None = None,
) -> str | None:
    """Build the RP-initiated logout (end-session) URL, or ``None`` if the IdP
    advertises no ``end_session_endpoint``.

    Front-channel, exactly like :func:`build_authorize_url`: take the endpoint
    path from discovery but force the scheme+host of the public ``issuer_url``
    (a back-channel discovery fetch must still yield a browser-resolvable URL).
    ``id_token_hint`` (when we captured the id_token at callback) lets the IdP
    log out silently; without it Authentik prompts to confirm. ``client_id`` is
    sent alongside ``post_logout_redirect_uri`` per the OIDC RP-logout spec so
    the IdP can validate the redirect against the registered app.
    """
    endpoint = discovery.get("end_session_endpoint")
    if not endpoint:
        return None
    discovered = urlsplit(str(endpoint))
    public = urlsplit(settings.issuer_url)
    end_session_endpoint = urlunsplit((public.scheme, public.netloc, discovered.path, "", ""))
    params: dict[str, str] = {}
    if id_token_hint:
        params["id_token_hint"] = id_token_hint
    if post_logout_redirect_uri:
        params["post_logout_redirect_uri"] = post_logout_redirect_uri
        params["client_id"] = settings.client_id
    if not params:
        return end_session_endpoint
    return f"{end_session_endpoint}?{urlencode(params)}"


def exchange_code_for_token(
    discovery: dict[str, object],
    settings: OIDCSettings,
    code: str,
    redirect_uri: str,
    code_verifier: str | None = None,
) -> dict[str, object]:
    token_endpoint = str(discovery["token_endpoint"])
    body_params = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }
    if code_verifier:
        body_params["code_verifier"] = code_verifier
    body = urlencode(body_params).encode("utf-8")
    basic_token = base64.b64encode(f"{settings.client_id}:{settings.client_secret}".encode("utf-8")).decode("utf-8")
    request = urllib.request.Request(
        token_endpoint,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "Authorization": f"Basic {basic_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = response.read().decode("utf-8")
    except HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OIDC token exchange failed: {exc.code} {error_body}") from exc
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise ValueError("OIDC token response must be a JSON object")
    return data


def fetch_userinfo(discovery: dict[str, object], access_token: str) -> dict[str, object]:
    userinfo_endpoint = discovery.get("userinfo_endpoint")
    if not userinfo_endpoint:
        raise ValueError("OIDC discovery document does not include a userinfo endpoint")
    request = urllib.request.Request(
        str(userinfo_endpoint),
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = response.read().decode("utf-8")
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise ValueError("OIDC userinfo response must be a JSON object")
    return data
