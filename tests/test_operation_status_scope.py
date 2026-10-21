"""GET /api/operations/{id} applies the scoped-disclosure guard.

A scoped caller must not read the detail of a finalise-purge operation it
cannot attribute to its own tenant scope. A hidden operation answers 404
with the same body as an unknown id, so the endpoint does not confirm that
the id exists.
"""

from __future__ import annotations

from contextlib import contextmanager

from fastapi.testclient import TestClient

from dmf_cms.main import create_app
from dmf_cms.operations import OperationState
from dmf_cms.settings import AWXSettings, MediaTenancySettings, Settings

OPERATOR = ("dmf-console-operator",)

_SCOPED_A = MediaTenancySettings(
    mode="scoped", group_tenant_map=(("dmf-console-operator", ("tenant-a",)),)
)
_UNSCOPED = MediaTenancySettings(mode="single")


@contextmanager
def _client(media_tenancy):
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=OPERATOR,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        media_tenancy=media_tenancy,
    )
    # Entering the client runs the lifespan, which creates app.state.operations.
    with TestClient(create_app(settings=settings)) as client:
        client.get("/auth/login", follow_redirects=False)
        yield client


def _purge_op(client, target, scope):
    op, created, conflict = client.app.state.operations.get_or_create_exclusive(
        action="finalise-purge",
        target=target,
        initial_state=OperationState.WAKING,
        initiator="someone",
        purge_tenant_scope=scope,
    )
    assert created and conflict is None
    return op


def test_scoped_caller_sees_own_tenant_purge_op():
    with _client(_SCOPED_A) as client:
        op = _purge_op(client, "studio-a", ("tenant-a",))
        resp = client.get(f"/api/operations/{op.operation_id}")
        assert resp.status_code == 200
        assert resp.json()["operation_id"] == op.operation_id


def test_scoped_caller_cannot_read_other_tenant_purge_op():
    with _client(_SCOPED_A) as client:
        op = _purge_op(client, "studio-b", ("tenant-b",))
        resp = client.get(f"/api/operations/{op.operation_id}")
        assert resp.status_code == 404
        assert op.operation_id not in resp.text
        assert "someone" not in resp.text


def test_scoped_caller_cannot_read_unattributed_purge_op():
    # Dispatched by an unscoped caller: no recorded scope.
    with _client(_SCOPED_A) as client:
        op = _purge_op(client, "studio-c", None)
        assert client.get(f"/api/operations/{op.operation_id}").status_code == 404


def test_hidden_op_body_matches_unknown_id_body():
    with _client(_SCOPED_A) as client:
        op = _purge_op(client, "studio-b", ("tenant-b",))
        hidden = client.get(f"/api/operations/{op.operation_id}")
        unknown = client.get("/api/operations/00000000-0000-0000-0000-000000000000")
        assert hidden.status_code == unknown.status_code == 404
        assert hidden.json() == unknown.json()


def test_unscoped_caller_sees_any_purge_op():
    with _client(_UNSCOPED) as client:
        scoped = _purge_op(client, "studio-b", ("tenant-b",))
        unattributed = _purge_op(client, "studio-c", None)
        for op in (scoped, unattributed):
            resp = client.get(f"/api/operations/{op.operation_id}")
            assert resp.status_code == 200
            assert resp.json()["operation_id"] == op.operation_id


def test_unknown_id_is_404():
    with _client(_SCOPED_A) as client:
        resp = client.get("/api/operations/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 404


def test_unauthenticated_is_401():
    client = TestClient(
        create_app(
            settings=Settings(
                runtime_mode="local",
                dev_login_enabled=True,
                dev_groups=OPERATOR,
                media_tenancy=_SCOPED_A,
            )
        )
    )
    assert client.get("/api/operations/anything").status_code == 401
