from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from dmf_cms import main
from dmf_cms.main import create_app
from dmf_cms.settings import OIDCSettings, Settings, SetupRequestSettings
from dmf_cms.setup_requests import (
    ACTION,
    DATA_KEYS,
    NAMESPACE,
    RECEIPT_TTL_SECONDS,
    ReceiptAlreadyExists,
    ReceiptStoreError,
    SetupRequestBindings,
    make_receipt,
    validate_receipt,
)

OPERATOR_GROUPS = ["dmf-console-operator"]
CLUSTER_UID = "4c6a1bca-4f03-4ec8-8f27-b92ddcb343e2"


class MemoryWriter:
    def __init__(self):
        self.receipts: list[dict] = []
        self.error: Exception | None = None

    def create_and_verify(self, receipt):
        if self.error:
            raise self.error
        self.receipts.append(copy.deepcopy(receipt))


def _client(monkeypatch, *, groups=None, subject="ops", bindings=None):
    claims = {
        "sub": subject,
        "name": "Operator",
        "email": "ops@example.invalid",
        "groups": groups or OPERATOR_GROUPS,
    }
    monkeypatch.setattr(main, "discovery_document", lambda _settings: {
        "authorization_endpoint": "https://auth.example.invalid/authorize",
        "token_endpoint": "https://auth.example.invalid/token",
        "userinfo_endpoint": "https://auth.example.invalid/userinfo",
    })
    monkeypatch.setattr(
        main,
        "exchange_code_for_token",
        lambda *_args, **_kwargs: {"access_token": "test-access"},
    )
    monkeypatch.setattr(main, "fetch_userinfo", lambda *_args: claims)
    settings = Settings(
        runtime_mode="cluster",
        dev_login_enabled=False,
        oidc=OIDCSettings(
            enabled=True,
            issuer_url="https://auth.example.invalid",
            client_id="dmf-cms",
            client_secret="oidc-secret",
        ),
        setup_requests=bindings or SetupRequestSettings(
            env_id="sandbox-abcd",
            cluster_uid="4c6a1bca-4f03-4ec8-8f27-b92ddcb343e2",
        ),
    )
    app = create_app(settings=settings)
    writer = MemoryWriter()
    app.state.setup_request_writer = writer
    client = TestClient(app, base_url="https://console.example.invalid")
    login = client.get("/auth/login", follow_redirects=False)
    state = login.headers["location"].split("state=", 1)[1].split("&", 1)[0]
    callback = client.get(f"/auth/callback?code=c&state={state}", follow_redirects=False)
    assert callback.status_code in {302, 307}
    return client, writer, app


def test_make_receipt_has_exact_immutable_v1_schema_and_bounded_lifetime():
    receipt = make_receipt(
        env_id="sandbox-abcd",
        cluster_uid=CLUSTER_UID,
        actor="oidc-subject-1",
        role="operator",
        reason="Initial inventory setup",
        now=100,
        request_id="a" * 32,
    )
    assert receipt["kind"] == "ConfigMap"
    assert receipt["immutable"] is True
    assert receipt["metadata"] == {
        "name": f"request-{'a' * 32}",
        "namespace": NAMESPACE,
    }
    data = receipt["data"]
    assert set(data) == DATA_KEYS
    assert data == {
        "schema_version": "1",
        "request_id": "a" * 32,
        "action": ACTION,
        "env_id": "sandbox-abcd",
        "cluster_uid": CLUSTER_UID,
        "actor": "oidc-subject-1",
        "role": "operator",
        "reason": "Initial inventory setup",
        "issued_at": "100",
        "expires_at": str(100 + RECEIPT_TTL_SECONDS),
    }


def test_receipt_validation_fails_closed_for_binding_schema_immutability_and_time():
    bindings = SetupRequestBindings("sandbox-abcd", CLUSTER_UID)
    original = make_receipt(
        env_id=bindings.env_id,
        cluster_uid=bindings.cluster_uid,
        actor="operator-1",
        role="operator",
        reason="setup",
        now=100,
        request_id="b" * 32,
    )
    assert validate_receipt(original, bindings, now=101)
    cases = []
    mutated = copy.deepcopy(original)
    mutated["apiVersion"] = "example.invalid/v1"  # type: ignore[assignment]
    cases.append(mutated)
    mutated = copy.deepcopy(original)
    mutated["immutable"] = False
    cases.append(mutated)
    mutated = copy.deepcopy(original)
    mutated["metadata"]["name"] = "request-wrong"  # type: ignore[index]
    cases.append(mutated)
    mutated = copy.deepcopy(original)
    mutated["data"]["extra"] = "no"  # type: ignore[index]
    cases.append(mutated)
    mutated = copy.deepcopy(original)
    mutated["data"]["cluster_uid"] = "other-cluster"  # type: ignore[index]
    cases.append(mutated)
    mutated = copy.deepcopy(original)
    mutated["data"]["issued_at"] = "102"  # type: ignore[index]
    cases.append(mutated)
    mutated = copy.deepcopy(original)
    mutated["data"]["expires_at"] = str(100 + RECEIPT_TTL_SECONDS + 1)  # type: ignore[index]
    cases.append(mutated)
    mutated = copy.deepcopy(original)
    mutated["data"]["reason"] = "bad\nreason"  # type: ignore[index]
    cases.append(mutated)
    assert all(not validate_receipt(case, bindings, now=101) for case in cases)
    assert not validate_receipt(original, SetupRequestBindings("other-env", CLUSTER_UID), now=101)
    assert not validate_receipt(
        original,
        SetupRequestBindings("sandbox-abcd", "not-a-kubernetes-uid"),
        now=101,
    )
    assert not validate_receipt(original, bindings, now=100 + RECEIPT_TTL_SECONDS)


def test_receipt_builder_rejects_bad_actor_role_reason_and_binding():
    base = {
        "env_id": "sandbox-abcd",
        "cluster_uid": CLUSTER_UID,
        "actor": "operator-1",
        "role": "operator",
        "reason": "setup",
        "now": 100,
        "request_id": "c" * 32,
    }
    for changed in (
        {"actor": ""},
        {"actor": "bad\nactor"},
        {"role": "viewer"},
        {"reason": "\n"},
        {"reason": "x" * 241},
        {"env_id": " "},
        {"cluster_uid": ""},
        {"cluster_uid": "cluster-uid"},
        {"request_id": "../../secret"},
    ):
        with pytest.raises(ValueError):
            make_receipt(**(base | changed))


def test_setup_request_records_server_derived_c5_and_returns_only_opaque_id(monkeypatch):
    client, writer, _ = _client(monkeypatch)
    response = client.post(
        "/api/setup-requests/born-inventory-secretid-issue",
        json={"reason": "Initial inventory setup"},
        headers={"origin": "https://console.example.invalid"},
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    assert set(payload) == {"request_id", "action", "expires_at"}
    assert payload["action"] == ACTION
    assert len(payload["request_id"]) == 32
    assert len(writer.receipts) == 1
    receipt = writer.receipts[0]
    assert receipt["immutable"] is True
    assert receipt["data"]["actor"] == "ops"  # type: ignore[index]
    assert receipt["data"]["role"] == "operator"  # type: ignore[index]
    assert receipt["data"]["env_id"] == "sandbox-abcd"  # type: ignore[index]
    assert receipt["data"]["cluster_uid"] == "4c6a1bca-4f03-4ec8-8f27-b92ddcb343e2"  # type: ignore[index]
    assert receipt["data"]["reason"] == "Initial inventory setup"  # type: ignore[index]


def test_setup_request_uses_effective_view_as_role_but_real_oidc_actor(monkeypatch):
    client, writer, _ = _client(monkeypatch, groups=["dmf-console-admin"], subject="real-admin")
    downgrade = client.post("/api/me/view-as", json={"role": "operator"})
    assert downgrade.status_code == 200, downgrade.text
    response = client.post(
        "/api/setup-requests/born-inventory-secretid-issue",
        json={"reason": "bootstrap test"},
        headers={"origin": "https://console.example.invalid"},
    )
    assert response.status_code == 201, response.text
    assert writer.receipts[0]["data"]["actor"] == "real-admin"  # type: ignore[index]
    assert writer.receipts[0]["data"]["role"] == "operator"  # type: ignore[index]


def test_setup_request_rejects_unauthenticated_and_cross_origin(monkeypatch):
    client, writer, app = _client(monkeypatch)
    unauthenticated = TestClient(create_app(settings=app.state.settings), base_url="https://console.example.invalid")
    response = unauthenticated.post(
        "/api/setup-requests/born-inventory-secretid-issue",
        json={"reason": "setup"},
        headers={"origin": "https://console.example.invalid"},
    )
    assert response.status_code == 401
    response = client.post(
        "/api/setup-requests/born-inventory-secretid-issue",
        json={"reason": "setup"},
        headers={"origin": "https://attacker.example.invalid"},
    )
    assert response.status_code == 403
    assert writer.receipts == []


def test_setup_request_rejects_breakglass_extra_fields_and_bad_reasons(monkeypatch):
    client, writer, _ = _client(monkeypatch, groups=["dmf-console-operator", "break-glass"])
    response = client.post(
        "/api/setup-requests/born-inventory-secretid-issue",
        json={"reason": "setup"},
        headers={"origin": "https://console.example.invalid"},
    )
    assert response.status_code == 403
    client, writer, _ = _client(monkeypatch)
    for body in (
        {"reason": "setup", "actor": "forged"},
        {"reason": ""},
        {"reason": "bad\nreason"},
        {"reason": "x" * 241},
    ):
        response = client.post(
            "/api/setup-requests/born-inventory-secretid-issue",
            json=body,
            headers={"origin": "https://console.example.invalid"},
        )
        assert response.status_code == 400
    assert writer.receipts == []


def test_setup_request_is_disabled_without_both_server_bindings(monkeypatch):
    for bindings in (
        SetupRequestSettings(env_id="sandbox-abcd", cluster_uid=""),
        SetupRequestSettings(env_id="sandbox-abcd", cluster_uid="not-a-kubernetes-uid"),
    ):
        client, writer, _ = _client(monkeypatch, bindings=bindings)
        response = client.post(
            "/api/setup-requests/born-inventory-secretid-issue",
            json={"reason": "setup"},
            headers={"origin": "https://console.example.invalid"},
        )
        assert response.status_code == 503
        assert writer.receipts == []


def test_setup_request_never_acknowledges_storage_failure_or_claim_collision(monkeypatch):
    client, writer, _ = _client(monkeypatch)
    writer.error = ReceiptStoreError("private backend detail")
    response = client.post(
        "/api/setup-requests/born-inventory-secretid-issue",
        json={"reason": "setup"},
        headers={"origin": "https://console.example.invalid"},
    )
    assert response.status_code == 503
    assert "private backend detail" not in response.text
    writer.error = ReceiptAlreadyExists("private collision detail")
    response = client.post(
        "/api/setup-requests/born-inventory-secretid-issue",
        json={"reason": "setup"},
        headers={"origin": "https://console.example.invalid"},
    )
    assert response.status_code == 409
    assert "private collision detail" not in response.text

