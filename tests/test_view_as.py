"""View-as role switching (dmfdeploy/dmfdeploy#185 WP-B).

Admin-only, session-scoped, strictly-downgrade role simulation enforced
server-side. Two layers of coverage:

* unit tests on ``effective_user`` / ``store_user`` / ``clear_user`` — the
  fail-closed core (a non-admin with a stale key, an admin with an invalid
  value, overlay hygiene across re-auth and clear);
* integration tests via TestClient — the endpoints (authz against the REAL
  user), ``/api/me`` shape, and downgrade enforcement on a gated surface.
"""

from fastapi.testclient import TestClient

from dmf_cms.main import create_app
from dmf_cms.security import (
    UserIdentity,
    clear_user,
    effective_user,
    session_user,
    store_user,
)
from dmf_cms.settings import MediaTenancySettings, NetboxSettings, Settings


ADMIN = ("dmf-console-admin",)
OPERATOR = ("dmf-console-operator",)
VIEWER = ("dmf-console-viewer",)
ADMIN_PLUS_MEDIA = ("dmf-console-admin", "media-engineers")


def _admin_identity(groups=ADMIN) -> UserIdentity:
    return UserIdentity(
        subject="ops",
        display_name="Ops",
        email="ops@example.invalid",
        groups=groups,
        role="admin",
    )


# --------------------------------------------------------------------------
# Unit: effective_user fail-closed core
# --------------------------------------------------------------------------

def test_effective_user_applies_valid_admin_downgrade():
    session: dict = {}
    store_user(session, _admin_identity())
    session["view_as"] = "viewer"
    eff = effective_user(session)
    assert eff is not None
    assert eff.role == "viewer"
    # groups are NOT altered — same groups, lower role (ADR-0028-safe)
    assert eff.groups == ADMIN
    # the real identity is untouched
    assert session_user(session).role == "admin"


def test_effective_user_ignores_view_as_from_non_admin():
    # A non-admin can never acquire a view_as via the endpoint, but a stale or
    # forged key must still be ignored: fail closed to the real role.
    session: dict = {}
    store_user(
        session,
        UserIdentity("v", "V", "v@example.invalid", VIEWER, "viewer"),
    )
    session["view_as"] = "operator"  # would be an UPGRADE — must never apply
    assert effective_user(session).role == "viewer"


def test_effective_user_rejects_invalid_view_as_values():
    for bad in ("admin", "root", "", "VIEWER", 3):
        session: dict = {}
        store_user(session, _admin_identity())
        session["view_as"] = bad
        assert effective_user(session).role == "admin", bad


def test_store_user_clears_stale_view_as():
    # Re-auth / identity refresh must never inherit a prior downgrade.
    session = {"view_as": "viewer"}
    store_user(session, _admin_identity())
    assert "view_as" not in session
    assert effective_user(session).role == "admin"


def test_clear_user_clears_view_as():
    session: dict = {}
    store_user(session, _admin_identity())
    session["view_as"] = "operator"
    clear_user(session)
    assert "view_as" not in session
    assert effective_user(session) is None


def test_effective_user_none_when_unauthenticated():
    assert effective_user({}) is None
    assert effective_user({"view_as": "viewer"}) is None


# --------------------------------------------------------------------------
# Integration: endpoints + enforcement
# --------------------------------------------------------------------------

def _client(groups=ADMIN, netbox=False) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        media_tenancy=MediaTenancySettings(mode="single"),
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="tok")
        if netbox
        else NetboxSettings(),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)  # dev login -> session
    return client


def test_set_view_as_requires_real_admin():
    client = _client(groups=OPERATOR)
    resp = client.post("/api/me/view-as", json={"role": "viewer"})
    assert resp.status_code == 403


def test_set_view_as_rejects_invalid_role():
    client = _client(groups=ADMIN)
    for bad in [{"role": "admin"}, {"role": "root"}, {"role": ""}, {}, {"role": 3}]:
        resp = client.post("/api/me/view-as", json=bad)
        assert resp.status_code == 400, bad


def test_view_as_reflected_in_api_me():
    client = _client(groups=ADMIN)
    me = client.get("/api/me").json()
    assert me["role"] == "admin" and me["real_role"] == "admin"
    assert me["view_as_active"] is False

    set_resp = client.post("/api/me/view-as", json={"role": "viewer"})
    assert set_resp.status_code == 200
    body = set_resp.json()
    assert body["role"] == "viewer" and body["real_role"] == "admin"
    assert body["view_as_active"] is True and "request_id" in body

    me = client.get("/api/me").json()
    assert me["role"] == "viewer"  # effective
    assert me["real_role"] == "admin"
    assert me["view_as_active"] is True
    assert set(me["groups"]) == set(ADMIN)  # groups stay real


def test_view_as_enforced_on_gated_surface():
    # A real admin (not in media-engineers) passes the media gate; downgraded
    # to viewer, the SAME session is 403 on both read and the clear write —
    # enforcement is server-side, not just nav.
    client = _client(groups=ADMIN, netbox=True)
    assert client.get("/api/media-workloads").status_code == 200

    client.post("/api/me/view-as", json={"role": "viewer"})
    assert client.get("/api/media-workloads").status_code == 403
    # clear write: the gate returns 403 before any tenancy/netbox check
    clear = client.post("/api/media-workloads/inst-1/clear", json={"reason": "x"})
    assert clear.status_code == 403


def test_reset_while_downgraded():
    client = _client(groups=ADMIN)
    client.post("/api/me/view-as", json={"role": "viewer"})
    assert client.get("/api/me").json()["view_as_active"] is True
    # DELETE authorizes against the REAL admin, so reset works even though the
    # effective role is viewer.
    resp = client.delete("/api/me/view-as")
    assert resp.status_code == 200
    assert resp.json()["role"] == "admin" and resp.json()["view_as_active"] is False
    assert client.get("/api/me").json()["role"] == "admin"


def test_relogin_clears_the_overlay():
    client = _client(groups=ADMIN)
    client.post("/api/me/view-as", json={"role": "viewer"})
    assert client.get("/api/me").json()["view_as_active"] is True
    client.get("/auth/login", follow_redirects=False)  # re-auth
    me = client.get("/api/me").json()
    assert me["role"] == "admin" and me["view_as_active"] is False


def test_logout_clears_the_overlay():
    client = _client(groups=ADMIN)
    client.post("/api/me/view-as", json={"role": "viewer"})
    client.get("/auth/logout", follow_redirects=False)
    assert client.get("/api/me").status_code == 401


def test_view_as_enforced_on_direct_admin_endpoints():
    # GATE-G24 P1: the /api/admin/* endpoints gate on the EFFECTIVE role, so a
    # real admin cannot escape a downgrade by calling admin APIs directly
    # (the nav hiding Admin must match what the API enforces).
    client = _client(groups=ADMIN)
    assert client.get("/api/admin/health").status_code == 200  # real admin
    client.post("/api/me/view-as", json={"role": "viewer"})
    for path in (
        "/api/admin/health",
        "/api/admin/users",
        "/api/admin/jobs",
        "/api/admin/groups",
    ):
        assert client.get(path).status_code == 403, path
    # the invitations POST is also on the admin surface (GATE-G24-R2)
    assert client.post("/api/admin/invitations").status_code == 403


def test_admin_invitations_requires_admin_role():
    # Pre-existing under-gate closed by WP-B: a non-admin (real operator) is
    # 403, not merely blocked later by an unconfigured-Authentik 503.
    client = _client(groups=OPERATOR)
    assert client.post("/api/admin/invitations").status_code == 403


def test_view_as_group_surface_still_reachable_when_downgraded():
    # Risk 3 (documented): groups stay real, so an admin who is ALSO in
    # media-engineers still reaches the Media Workloads surface as view-as
    # viewer — correct by design (a real viewer in that group would too).
    client = _client(groups=ADMIN_PLUS_MEDIA, netbox=True)
    client.post("/api/me/view-as", json={"role": "viewer"})
    # 200 (surface reachable via the group grant), not 403
    assert client.get("/api/media-workloads").status_code == 200
