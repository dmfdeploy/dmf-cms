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

import dmf_cms.main as main
from dmf_cms.authentik import AuthentikAPIError
from dmf_cms.main import create_app
from dmf_cms.security import (
    UserIdentity,
    clear_user,
    effective_user,
    session_user,
    store_user,
)
from dmf_cms.settings import AuthentikSettings, MediaTenancySettings, NetboxSettings, Settings


ADMIN = ("dmf-console-admin",)
OPERATOR = ("dmf-console-operator",)
ENGINEER = ("dmf-console-engineer",)
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
    real = _admin_identity()
    session: dict = {}
    store_user(session, real)
    session["view_as"] = "viewer"
    eff = effective_user(session)
    assert eff is not None
    assert eff.role == "viewer"
    # groups are NOT altered — same groups, lower role (ADR-0028-safe)
    assert eff.groups == ADMIN
    # view-as downgrades role ONLY — subject/email/display_name survive
    # unchanged. This is the property self-scoped endpoints (e.g. POST
    # /api/admin/invitations, dmfdeploy/dmfdeploy#423) rely on: a downgraded
    # admin still self-scopes to their OWN identity, never a blank or
    # substituted one.
    assert eff.subject == real.subject
    assert eff.email == real.email
    assert eff.display_name == real.display_name
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

def _client(groups=ADMIN, netbox=False, dev_username=None) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        **({"dev_username": dev_username} if dev_username is not None else {}),
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


def test_view_as_set_and_cleared_audit_lines_sanitize_actor(caplog):
    # umbrella dmf-cms#108 fix-round 2: "view-as set"/"view-as cleared"
    # mirror the clear-for-deployment C5 record (per their own comment)
    # and format actor=%s from real.subject (an OIDC claim — dev-login's
    # username stands in for it here) unescaped, same injection shape
    # fix-round 1 fixed in _audit_awx_write.
    import logging

    client = _client(groups=ADMIN, dev_username="admin\nFORGED view-as set: actor=root")
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        set_resp = client.post("/api/me/view-as", json={"role": "viewer"})
        clear_resp = client.delete("/api/me/view-as")
    assert set_resp.status_code == 200
    assert clear_resp.status_code == 200

    set_lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("view-as set:")]
    cleared_lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("view-as cleared:")]
    assert len(set_lines) == 1 and len(cleared_lines) == 1
    for line in (set_lines[0], cleared_lines[0]):
        assert "\n" not in line
        assert "\r" not in line
        assert "FORGED" in line


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


def test_invitations_open_to_any_authenticated_role_unconfigured_authentik():
    # dmfdeploy/dmfdeploy#423: the endpoint is self-scoped (no request body,
    # no target-user param), so the gate only requires an authenticated
    # session (viewer floor), not admin. With Authentik unconfigured (the
    # default here) a caller who PASSES the gate hits the next branch and
    # gets 503 "authentik API not configured" — NOT 403. Pin that a
    # non-admin gets exactly 503, so a future regression that re-tightens
    # the gate to admin (which would surface as 403 here) is caught, and a
    # broken handler (which would surface as 500 or 200) is caught too.
    for groups in (ENGINEER, VIEWER):
        client = _client(groups=groups)
        resp = client.post("/api/admin/invitations")
        assert resp.status_code == 503, (groups, resp.text)
        assert resp.status_code != 403, (groups, resp.text)
    # Admin behaviour is unchanged: still reaches the handler (503 here too,
    # same unconfigured Authentik — not blocked earlier by the gate).
    admin_client = _client(groups=ADMIN)
    assert admin_client.post("/api/admin/invitations").status_code == 503


def test_invitations_requires_authentication():
    # No dev-login call — no session established — still 401, gate change
    # notwithstanding.
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=VIEWER,
        media_tenancy=MediaTenancySettings(mode="single"),
    )
    client = TestClient(create_app(settings=settings))
    assert client.post("/api/admin/invitations").status_code == 401


def test_invitations_configured_mints_only_for_the_caller(monkeypatch):
    # Configured path: a non-admin (engineer) gets 200 + enrollment_url, and
    # the invitation is minted for the CALLER's own identity regardless of
    # what a request body claims — this is the safety property the whole
    # gate-lowering rests on, so it must be pinned, not assumed.
    calls: list[dict] = []

    def fake_create_invitation(**kwargs):
        calls.append(kwargs)
        return {
            "enrollment_url": "https://auth.example.invalid/if/flow/enroll/abc/",
            "expires": "2026-01-01T00:00:00Z",
        }

    monkeypatch.setattr(main, "create_invitation", fake_create_invitation)

    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=ENGINEER,
        media_tenancy=MediaTenancySettings(mode="single"),
        authentik=AuthentikSettings(api_url="http://authentik.test", api_token="tok"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)  # dev login -> session

    resp = client.post("/api/admin/invitations")
    assert resp.status_code == 200, resp.text
    assert resp.json()["enrollment_url"] == "https://auth.example.invalid/if/flow/enroll/abc/"
    assert len(calls) == 1
    caller_kwargs = calls[0]
    assert caller_kwargs["username"] == "operator"  # settings.dev_username default
    assert caller_kwargs["email"] == "operator@example.invalid"
    assert caller_kwargs["display_name"] == "DMF Operator"

    # A request body cannot redirect who the invitation is minted for — the
    # handler takes no body at all, so this must be byte-for-byte identical
    # to the no-body call above.
    resp2 = client.post(
        "/api/admin/invitations",
        json={"username": "someone-else", "email": "someone-else@example.invalid"},
    )
    assert resp2.status_code == 200
    assert len(calls) == 2
    assert calls[1] == caller_kwargs

    # Nor can a query string — a different injection vector than a JSON
    # body, and a future regression that reads request.query_params instead
    # of the body would sail through the body-only assertion above.
    resp3 = client.post(
        "/api/admin/invitations?username=someone-else&email=someone-else@example.invalid",
    )
    assert resp3.status_code == 200
    assert len(calls) == 3
    assert calls[2] == caller_kwargs

    # Nor can a client-supplied identity header — the caller's identity
    # comes from the server-side session (effective_user), never from
    # request headers, so spoofing one must change nothing.
    resp4 = client.post(
        "/api/admin/invitations",
        headers={
            "X-Forwarded-User": "someone-else",
            "X-Remote-User": "someone-else",
        },
    )
    assert resp4.status_code == 200
    assert len(calls) == 4
    assert calls[3] == caller_kwargs


def test_invitations_downgraded_admin_mints_for_the_admins_own_identity(monkeypatch):
    # Positive counterpart to the GATE-G24-R2 403 assertion removed from
    # test_view_as_enforced_on_direct_admin_endpoints: a real admin who has
    # downgraded via view-as still REACHES this endpoint (it never needed
    # the admin capability) and still mints for their OWN identity, not
    # "viewer" and not blank — effective_user's role-only downgrade
    # (test_effective_user_applies_valid_admin_downgrade) is what this
    # rests on.
    calls: list[dict] = []

    def fake_create_invitation(**kwargs):
        calls.append(kwargs)
        return {
            "enrollment_url": "https://auth.example.invalid/if/flow/enroll/xyz/",
            "expires": "2026-01-01T00:00:00Z",
        }

    monkeypatch.setattr(main, "create_invitation", fake_create_invitation)

    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=ADMIN,
        media_tenancy=MediaTenancySettings(mode="single"),
        authentik=AuthentikSettings(api_url="http://authentik.test", api_token="tok"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)  # dev login -> session, real admin

    set_resp = client.post("/api/me/view-as", json={"role": "viewer"})
    assert set_resp.status_code == 200
    assert client.get("/api/me").json()["role"] == "viewer"  # effective role is now viewer

    resp = client.post("/api/admin/invitations")
    assert resp.status_code == 200, resp.text
    assert len(calls) == 1
    # dev-login identity fields come from settings.dev_username/dev_email/
    # dev_display_name regardless of dev_groups — the ADMIN's own identity.
    assert calls[0]["username"] == "operator"
    assert calls[0]["email"] == "operator@example.invalid"
    assert calls[0]["display_name"] == "DMF Operator"


def test_invitations_sanitizes_authentik_error_for_the_client(monkeypatch, caplog):
    # Finding 1 (WO-423 fix round 1): before this change only an admin could
    # reach this branch; now any authenticated role can, so a raw Authentik
    # response body reaching the client is a disclosure this PR introduced,
    # not a pre-existing issue. Match the AWX error paths elsewhere in this
    # module (main.py's "Log raw error server-side only, sanitize for
    # client" pattern): the real status code is not disclosure and stays,
    # the body text is.
    SECRET_DETAIL = "internal flow instance detail: secret-xyz"

    def fake_create_invitation(**kwargs):
        raise AuthentikAPIError(502, SECRET_DETAIL)

    monkeypatch.setattr(main, "create_invitation", fake_create_invitation)

    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=ENGINEER,
        media_tenancy=MediaTenancySettings(mode="single"),
        authentik=AuthentikSettings(api_url="http://authentik.test", api_token="tok"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)  # dev login -> session

    with caplog.at_level("ERROR"):
        resp = client.post("/api/admin/invitations")

    assert resp.status_code == 502  # status code preserved — not disclosure
    assert SECRET_DETAIL not in resp.text
    # ...but logged server-side, not silently dropped.
    assert any(SECRET_DETAIL in record.getMessage() for record in caplog.records)


def test_invitations_authentik_error_audit_line_sanitizes_actor_and_body(monkeypatch, caplog):
    # umbrella dmf-cms#108 fix-round 4: this log line (main.py, the ERROR
    # path right below the one the test above exercises) was PR #107's own
    # fix (15109be) moving exc.body OUT of the JSON-encoded HTTP response
    # (where control characters were already escaped) and INTO this %s
    # log line — closing a disclosure vector and opening an injection one
    # in the same edit. Both fields are externally influenced: actor
    # (user.subject, an OIDC claim — dev-login username stands in here)
    # and exc.body, which is upstream-supplied by Authentik (or anything
    # able to shape its error responses) — the most directly
    # third-party-controlled value in this whole sweep.
    import logging

    hostile_body = "flow instance detail\nFORGED actor=admin"

    def fake_create_invitation(**kwargs):
        raise AuthentikAPIError(502, hostile_body)

    monkeypatch.setattr(main, "create_invitation", fake_create_invitation)

    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=ENGINEER,
        dev_username="ops\nFORGED actor=root",
        media_tenancy=MediaTenancySettings(mode="single"),
        authentik=AuthentikSettings(api_url="http://authentik.test", api_token="tok"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)

    with caplog.at_level(logging.ERROR, logger="dmf_cms.main"):
        resp = client.post("/api/admin/invitations")

    assert resp.status_code == 502
    lines = [
        r.getMessage() for r in caplog.records
        if r.getMessage().startswith("Authentik API error minting passkey invitation")
    ]
    assert len(lines) == 1
    line = lines[0]
    assert "\n" not in line
    assert "\r" not in line
    assert "FORGED" in line


def test_view_as_group_surface_still_reachable_when_downgraded():
    # Risk 3 (documented): groups stay real, so an admin who is ALSO in
    # media-engineers still reaches the Media Workloads surface as view-as
    # viewer — correct by design (a real viewer in that group would too).
    client = _client(groups=ADMIN_PLUS_MEDIA, netbox=True)
    client.post("/api/me/view-as", json={"role": "viewer"})
    # 200 (surface reachable via the group grant), not 403
    assert client.get("/api/media-workloads").status_code == 200
