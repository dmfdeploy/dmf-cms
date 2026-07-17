"""Admin Users roster: human/machine split + break-glass flag (PR-C, #243).

The /api/admin/users roster classifies every Authentik user as a human or a
machine identity from its ``type`` field, and flags the platform-seeded
break-glass admin. This surfaces the ADR-0028 C4/D8 human-vs-machine
distinction and marks break-glass as the sanctioned exception, not a routine
role. These tests pin the mapping (including the fail-safe default) and the
break-glass flag; the gate/authz coverage lives in test_view_as.py.
"""

import dmf_cms.main as main
from fastapi.testclient import TestClient

from dmf_cms.main import create_app
from dmf_cms.settings import AuthentikSettings, MediaTenancySettings, Settings


ADMIN = ("dmf-console-admin",)


def _raw_user(username: str, user_type: str, **extra) -> dict:
    u = {
        "username": username,
        "name": username.title(),
        "email": f"{username}@example.invalid",
        "is_active": True,
        "last_login": None,
        "groups_obj": [],
        "type": user_type,
    }
    u.update(extra)
    return u


def _client(raw_users, monkeypatch) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=ADMIN,
        media_tenancy=MediaTenancySettings(mode="single"),
        authentik=AuthentikSettings(api_url="http://authentik.test", api_token="tok"),
    )
    # list_users is imported into the main namespace — patch it there.
    monkeypatch.setattr(main, "list_users", lambda *, api_url, api_token: raw_users)
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)  # dev login -> session
    return client


def _roster(raw_users, monkeypatch) -> dict[str, dict]:
    resp = _client(raw_users, monkeypatch).get("/api/admin/users")
    assert resp.status_code == 200, resp.text
    return {u["username"]: u for u in resp.json()["users"]}


def test_type_maps_to_human_or_machine(monkeypatch):
    raw = [
        _raw_user("alice", "internal"),
        _raw_user("bob", "external"),
        _raw_user("awx-svc", "service_account"),
        _raw_user("promsd-svc", "internal_service_account"),
    ]
    by_name = _roster(raw, monkeypatch)
    assert by_name["alice"]["user_type"] == "human"
    assert by_name["bob"]["user_type"] == "human"
    assert by_name["awx-svc"]["user_type"] == "machine"
    assert by_name["promsd-svc"]["user_type"] == "machine"


def test_unknown_or_missing_type_defaults_to_machine(monkeypatch):
    # Fail-safe default: an unknown/novel Authentik type (or none at all) stays
    # on the machine side so a non-human principal never silently blends into
    # the People roster.
    raw = [
        _raw_user("mystery", "some_future_type"),
        {  # no "type" key at all
            "username": "typeless",
            "name": "Typeless",
            "email": "typeless@example.invalid",
            "is_active": True,
            "groups_obj": [],
        },
    ]
    by_name = _roster(raw, monkeypatch)
    assert by_name["mystery"]["user_type"] == "machine"
    assert by_name["typeless"]["user_type"] == "machine"


def test_break_glass_flag_set_for_seeded_admin_only(monkeypatch):
    raw = [
        _raw_user("akadmin", "internal"),  # platform-seeded sealed emergency admin
        _raw_user("alice", "internal"),
    ]
    by_name = _roster(raw, monkeypatch)
    assert by_name["akadmin"]["is_break_glass"] is True
    assert by_name["alice"]["is_break_glass"] is False


def test_break_glass_flag_also_set_by_group_membership(monkeypatch):
    # The dmf-infra-seeded rescue admin (authentik_breakglass_username) need
    # not be named "akadmin" — membership in the platform-seeded "break-glass"
    # group is an independent, equally-authoritative signal.
    raw = [
        _raw_user(
            "rescue-admin",
            "internal",
            groups_obj=[{"name": "break-glass"}, {"name": "dmf-console-admin"}],
        ),
        _raw_user(
            "alice",
            "internal",
            groups_obj=[{"name": "dmf-console-operator"}],
        ),
    ]
    by_name = _roster(raw, monkeypatch)
    assert by_name["rescue-admin"]["is_break_glass"] is True
    assert by_name["rescue-admin"]["user_type"] == "human"
    assert by_name["alice"]["is_break_glass"] is False


def test_inactive_users_still_skipped(monkeypatch):
    # The pre-existing inactive-skip behaviour is unchanged by the new fields.
    raw = [
        _raw_user("alice", "internal"),
        _raw_user("ghost", "internal", is_active=False),
    ]
    by_name = _roster(raw, monkeypatch)
    assert "alice" in by_name
    assert "ghost" not in by_name
