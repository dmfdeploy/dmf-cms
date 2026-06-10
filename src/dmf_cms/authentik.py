"""Authentik API client — passkey invitation creation."""

from __future__ import annotations

import json
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone


class AuthentikAPIError(Exception):
    """Raised when the Authentik API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"Authentik API {status}: {body}")


def _request(
    api_url: str,
    api_token: str,
    method: str,
    path: str,
    body: dict | None = None,
) -> dict:
    """Make an authenticated JSON request to the Authentik v3 API."""
    url = api_url.rstrip("/") + path
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode() if exc.fp else str(exc)
        raise AuthentikAPIError(exc.code, error_body) from exc


def _resolve_flow_uuid(api_url: str, api_token: str, slug: str) -> str:
    """Look up the flow UUID by slug via the Authentik API."""
    result = _request(api_url, api_token, "GET", f"/api/v3/flows/instances/?slug={slug}")
    results = result.get("results", [])
    if not results:
        raise AuthentikAPIError(404, f"Flow with slug '{slug}' not found")
    return str(results[0]["pk"])


def create_invitation(
    *,
    api_url: str,
    api_token: str,
    flow_slug: str,
    username: str,
    email: str,
    display_name: str,
    ttl_hours: int = 24,
    public_base_url: str | None = None,
) -> dict:
    """Create a single-use passkey invitation via the Authentik API.

    ``api_url`` is the (cluster-internal) back-channel used for the API call.
    ``public_base_url`` is the browser-resolvable host used to build the
    user-facing enrollment URL; it falls back to ``api_url`` for local/dev where
    they are the same. A human must be able to open the returned enrollment_url,
    so it must never be a cluster-internal service-DNS address.

    Returns a dict with:
        enrollment_url: str  — full URL the user visits to enroll
        expires: str         — ISO-8601 expiry timestamp
        invite_uuid: str     — the invitation UUID
    """
    flow_uuid = _resolve_flow_uuid(api_url, api_token, flow_slug)
    expires = (datetime.now(timezone.utc) + timedelta(hours=ttl_hours)).isoformat()

    payload = {
        "name": f"console-{username}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}",
        "flow": flow_uuid,
        "single_use": True,
        "expiring": True,
        "expires": expires,
        "fixed_data": {
            "username": username,
            "email": email,
            "name": display_name,
        },
    }

    invitation = _request(
        api_url, api_token, "POST", "/api/v3/stages/invitation/invitations/", payload
    )
    invite_uuid = str(invitation["pk"])

    # Build the enrollment URL from the flow slug and invitation UUID, using the
    # public (browser-resolvable) base — NOT the internal api_url back-channel.
    # Pattern: {public_base}/if/flow/{flow_slug}/?itoken={invite_uuid}
    enrollment_base = (public_base_url or api_url).rstrip("/")
    enrollment_url = f"{enrollment_base}/if/flow/{flow_slug}/?itoken={invite_uuid}"

    return {
        "enrollment_url": enrollment_url,
        "expires": invitation.get("expires", expires),
        "invite_uuid": invite_uuid,
    }


def list_users(*, api_url: str, api_token: str) -> list[dict]:
    """Fetch all active users from Authentik.

    Returns raw Authentik user objects from /api/v3/core/users/.
    Fields used downstream: username, name, email, is_active, last_login, groups_obj
    """
    result = _request(api_url, api_token, "GET", "/api/v3/core/users/?page_size=100")
    return result.get("results", [])


def list_groups(*, api_url: str, api_token: str) -> list[dict]:
    """List all Authentik groups."""
    result = _request(api_url, api_token, "GET", "/api/v3/core/groups/?page_size=100")
    return result.get("results", [])


def ensure_group(*, api_url: str, api_token: str, name: str) -> bool:
    """Ensure a group with the given name exists in Authentik.

    Returns True if the group was created, False if it already existed.
    """
    existing = list_groups(api_url=api_url, api_token=api_token)
    if any(g.get("name") == name for g in existing):
        return False

    _request(
        api_url,
        api_token,
        "POST",
        "/api/v3/core/groups/",
        body={"name": name, "is_superuser": False},
    )
    return True


def add_user_to_group(
    *,
    api_url: str,
    api_token: str,
    username: str,
    group_name: str,
) -> bool:
    """Add a user to a group by username.

    Returns True if the user was added, False if already a member or not found.
    """
    # Find the group
    groups = list_groups(api_url=api_url, api_token=api_token)
    group = next((g for g in groups if g.get("name") == group_name), None)
    if group is None:
        return False

    # Find the user
    users = list_users(api_url=api_url, api_token=api_token)
    user = next((u for u in users if u.get("username") == username), None)
    if user is None:
        return False

    group_pk = str(group["pk"])
    user_pk = str(user["pk"])

    # Check if already a member
    existing_members = _request(
        api_url,
        api_token,
        "GET",
        f"/api/v3/core/groups/{group_pk}/?page_size=100",
    )
    member_pks = {str(m["pk"]) for m in existing_members.get("users", [])}
    if user_pk in member_pks:
        return False

    # Add user to group. Authentik's group detail endpoint does not accept POST
    # /add_users (returns 405) — PATCH the full member list instead.
    new_members = sorted({int(pk) for pk in member_pks} | {int(user_pk)})
    _request(
        api_url,
        api_token,
        "PATCH",
        f"/api/v3/core/groups/{group_pk}/",
        body={"users": new_members},
    )
    return True
