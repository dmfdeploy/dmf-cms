from __future__ import annotations

import copy
import json
import logging
import re
import shutil
import subprocess
import urllib.error
from pathlib import Path

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
    KubernetesReceiptWriter,
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


ENDPOINT = "/api/setup-requests/born-inventory-secretid-issue"
SAME_ORIGIN = {"origin": "https://console.example.invalid"}


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


def _client(
    monkeypatch,
    *,
    groups=None,
    subject="ops",
    bindings=None,
    runtime_mode="cluster",
    claims_extra=None,
    omit_sub=False,
):
    claims = {
        "sub": subject,
        "name": "Operator",
        "email": "ops@example.invalid",
        "groups": groups or OPERATOR_GROUPS,
        **(claims_extra or {}),
    }
    if omit_sub:
        del claims["sub"]
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
        runtime_mode=runtime_mode,
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



def test_setup_request_id_is_32_lowercase_hex_and_names_the_receipt(monkeypatch):
    client, writer, _ = _client(monkeypatch)
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 201, response.text
    request_id = response.json()["request_id"]
    assert re.fullmatch(r"[0-9a-f]{32}", request_id)
    receipt = writer.receipts[0]
    assert receipt["metadata"] == {"name": f"request-{request_id}", "namespace": NAMESPACE}
    assert receipt["data"]["request_id"] == request_id  # type: ignore[index]
    assert set(receipt["data"]) == DATA_KEYS  # type: ignore[arg-type]
    other = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert other.json()["request_id"] != request_id


def test_setup_request_receipt_expires_fifteen_minutes_after_issue(monkeypatch):
    client, writer, _ = _client(monkeypatch)
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 201, response.text
    data = writer.receipts[0]["data"]
    assert isinstance(data, dict)
    assert re.fullmatch(r"[0-9]+", data["issued_at"])
    assert re.fullmatch(r"[0-9]+", data["expires_at"])
    assert int(data["expires_at"]) - int(data["issued_at"]) == 15 * 60
    assert response.json()["expires_at"] == int(data["expires_at"])


@pytest.mark.parametrize(
    "extra",
    [
        {"env_id": "other-env"},
        {"cluster_uid": "4c6a1bca-4f03-4ec8-8f27-b92ddcb343e2"},
        {"role": "admin"},
        {"request_id": "a" * 32},
        {"action": "something-else"},
        {"namespace": "kube-system"},
    ],
)
def test_setup_request_never_accepts_server_owned_fields(monkeypatch, extra):
    client, writer, _ = _client(monkeypatch)
    response = client.post(ENDPOINT, json={"reason": "setup", **extra}, headers=SAME_ORIGIN)
    assert response.status_code == 400
    assert writer.receipts == []
    response = client.post(ENDPOINT, json=extra, headers=SAME_ORIGIN)
    assert response.status_code == 400
    assert writer.receipts == []


def test_setup_request_rejects_missing_origin_and_non_json(monkeypatch):
    client, writer, _ = _client(monkeypatch)
    assert client.post(ENDPOINT, json={"reason": "setup"}).status_code == 403
    response = client.post(
        ENDPOINT,
        content="reason=setup",
        headers={**SAME_ORIGIN, "content-type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 415
    assert writer.receipts == []


def test_setup_request_rejects_viewer_and_admin_viewing_as_viewer(monkeypatch):
    client, writer, _ = _client(monkeypatch, groups=["dmf-console-viewer"])
    assert client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN).status_code == 403
    client, writer, _ = _client(monkeypatch, groups=["dmf-console-admin"], subject="real-admin")
    assert client.post("/api/me/view-as", json={"role": "viewer"}).status_code == 200
    assert client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN).status_code == 403
    assert writer.receipts == []


def test_setup_request_rejects_the_break_glass_account_by_name(monkeypatch):
    client, writer, _ = _client(monkeypatch, groups=["dmf-console-admin"], subject="akadmin")
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 403
    assert writer.receipts == []


def test_setup_request_rejects_development_login(monkeypatch):
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        setup_requests=SetupRequestSettings(env_id="sandbox-abcd", cluster_uid=CLUSTER_UID),
    )
    app = create_app(settings=settings)
    writer = MemoryWriter()
    app.state.setup_request_writer = writer
    client = TestClient(app, base_url="https://console.example.invalid")
    login = client.get("/auth/login", follow_redirects=False)
    assert login.status_code in {302, 307}
    me = client.get("/api/me")
    assert me.status_code == 200, me.text
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 403
    assert writer.receipts == []


def test_setup_request_rejects_local_runtime_mode_even_with_oidc_login(monkeypatch):
    client, writer, _ = _client(monkeypatch, runtime_mode="local")
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 403
    assert writer.receipts == []


def test_unconfigured_console_answers_unauthenticated_and_unauthorized_callers_alike(monkeypatch):
    unconfigured = SetupRequestSettings()
    client, writer, app = _client(monkeypatch, bindings=unconfigured, groups=["dmf-console-viewer"])
    anonymous = TestClient(create_app(settings=app.state.settings), base_url="https://console.example.invalid")
    configured_client, _, configured_app = _client(monkeypatch)
    configured_anonymous = TestClient(
        create_app(settings=configured_app.state.settings), base_url="https://console.example.invalid"
    )
    for caller in (anonymous, configured_anonymous):
        response = caller.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
        assert response.status_code == 401
        assert response.json() == {"error": "unauthorized"}
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 403
    assert response.json() == {"error": "forbidden"}
    breakglass, _, _ = _client(monkeypatch, bindings=unconfigured, subject="akadmin", groups=["dmf-console-admin"])
    response = breakglass.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 403
    assert writer.receipts == []


def test_setup_request_disabled_error_is_clear_and_never_guesses_a_binding(monkeypatch):
    for bindings in (
        SetupRequestSettings(),
        SetupRequestSettings(env_id="", cluster_uid=CLUSTER_UID),
        SetupRequestSettings(env_id="sandbox-abcd", cluster_uid=""),
    ):
        client, writer, _ = _client(monkeypatch, bindings=bindings)
        response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
        assert response.status_code == 503
        assert response.json() == {"error": "setup request action unavailable"}
        assert writer.receipts == []


def test_setup_request_storage_failure_returns_an_error_and_no_request_id(monkeypatch):
    client, writer, _ = _client(monkeypatch)
    writer.error = ReceiptStoreError("private backend detail")
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 503
    assert "request_id" not in response.json()
    assert not re.search(r"[0-9a-f]{32}", response.text)
    assert writer.receipts == []


def test_setup_request_audit_line_has_actor_role_request_id_and_reason(monkeypatch, caplog):
    client, writer, _ = _client(monkeypatch, groups=["dmf-console-admin"], subject="real-admin")
    assert client.post("/api/me/view-as", json={"role": "operator"}).status_code == 200
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        response = client.post(
            ENDPOINT, json={"reason": "Initial inventory setup"}, headers=SAME_ORIGIN
        )
    assert response.status_code == 201, response.text
    request_id = response.json()["request_id"]
    lines = _audit_lines(caplog)
    assert len(lines) == 1
    line = lines[0]
    assert f"action={ACTION} " in line
    assert "actor='real-admin'" in line
    assert " role=operator " in line
    assert " real_role=admin " in line
    assert f" request_id={request_id} " in line
    assert "reason='Initial inventory setup'" in line
    assert " outcome=issued" in line


def test_setup_request_audit_records_failed_outcomes_and_no_other_secret(monkeypatch, caplog):
    client, writer, _ = _client(monkeypatch)
    for error, outcome in (
        (ReceiptStoreError("private backend detail"), "store-failed"),
        (ReceiptAlreadyExists("private collision detail"), "request-id-collision"),
    ):
        caplog.clear()
        writer.error = error
        with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
            client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
        lines = _audit_lines(caplog)
        assert len(lines) == 1
        assert f" outcome={outcome}" in lines[0]
        assert "private" not in lines[0]
        assert CLUSTER_UID not in lines[0]


def test_setup_request_rejections_write_no_audit_line(monkeypatch, caplog):
    client, writer, _ = _client(monkeypatch)
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        client.post(ENDPOINT, json={"reason": ""}, headers=SAME_ORIGIN)
        client.post(ENDPOINT, json={"reason": "setup"})
    assert _audit_lines(caplog) == []


class _FakeResponse:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self):
        return json.dumps(self._body).encode("utf-8")


def _writer(tmp_path, monkeypatch, handler):
    token = tmp_path / "token"
    token.write_text("sa-token\n", encoding="utf-8")
    calls = []

    def fake_urlopen(request, timeout=None, context=None):
        calls.append(
            (request.get_method(), request.full_url, request.data, dict(request.header_items()))
        )
        return handler(request, calls)

    monkeypatch.setattr("dmf_cms.setup_requests.urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr("dmf_cms.setup_requests.ssl.create_default_context", lambda cafile=None: None)
    return KubernetesReceiptWriter(api_server="https://kube.example.invalid", token_path=str(token)), calls


def _sample_receipt():
    return make_receipt(
        env_id="sandbox-abcd",
        cluster_uid=CLUSTER_UID,
        actor="ops",
        role="operator",
        reason="setup",
        now=100,
        request_id="d" * 32,
    )


def test_kubernetes_writer_only_creates_and_gets_the_named_receipt(tmp_path, monkeypatch):
    receipt = _sample_receipt()

    def handler(request, calls):
        if request.get_method() == "POST":
            return _FakeResponse(receipt)
        return _FakeResponse({**receipt, "metadata": {**receipt["metadata"], "uid": "uid-1"}})

    writer, calls = _writer(tmp_path, monkeypatch, handler)
    writer.create_and_verify(receipt)
    base = f"https://kube.example.invalid/api/v1/namespaces/{NAMESPACE}/configmaps"
    assert [(method, url) for method, url, _body, _headers in calls] == [
        ("POST", base),
        ("GET", f"{base}/request-{'d' * 32}"),
    ]
    posted = json.loads(calls[0][2])
    assert posted["immutable"] is True
    assert set(posted["data"]) == DATA_KEYS
    assert calls[0][3]["Authorization"] == "Bearer sa-token"


def test_kubernetes_writer_rejects_a_stored_receipt_that_differs(tmp_path, monkeypatch):
    receipt = _sample_receipt()
    for change in (
        {"immutable": False},
        {"data": {**receipt["data"], "reason": "changed"}},
        {"metadata": {"name": f"request-{'d' * 32}", "namespace": NAMESPACE}},
    ):
        stored = {**receipt, "metadata": {**receipt["metadata"], "uid": "uid-1"}, **change}
        writer, _ = _writer(
            tmp_path,
            monkeypatch,
            lambda request, calls, stored=stored: _FakeResponse(
                receipt if request.get_method() == "POST" else stored
            ),
        )
        with pytest.raises(ReceiptStoreError):
            writer.create_and_verify(receipt)


@pytest.mark.parametrize(
    "code,expected",
    [(409, ReceiptAlreadyExists), (403, ReceiptStoreError), (500, ReceiptStoreError)],
)
def test_kubernetes_writer_maps_api_errors_without_leaking_detail(
    tmp_path, monkeypatch, code, expected
):
    def handler(request, calls):
        raise urllib.error.HTTPError(request.full_url, code, "private detail", {}, None)

    writer, calls = _writer(tmp_path, monkeypatch, handler)
    with pytest.raises(expected) as excinfo:
        writer.create_and_verify(_sample_receipt())
    assert "private detail" not in str(excinfo.value)
    assert len(calls) == 1


def test_kubernetes_writer_fails_without_an_api_server_or_token(tmp_path, monkeypatch):
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
    with pytest.raises(ReceiptStoreError):
        KubernetesReceiptWriter().create_and_verify(_sample_receipt())
    missing = KubernetesReceiptWriter(
        api_server="https://kube.example.invalid", token_path=str(tmp_path / "absent")
    )
    with pytest.raises(ReceiptStoreError):
        missing.create_and_verify(_sample_receipt())


CHART = Path(__file__).resolve().parent.parent / "charts" / "dmf-cms"
_HELM = shutil.which("helm")
_BASE_SET = [
    "--set", "image.repository=dmf-cms",
    "--set", "image.tag=0.1.0",
    "--set", "env.secretKeySecret.existingSecretName=dmf-cms-runtime",
    "--set", "oidc.clientSecret.existingSecretName=dmf-cms-runtime",
    "--set", "oidc.issuerUrl=https://auth.example.invalid",
    "--set", "oidc.clientId=dmf-cms",
]
_BINDINGS = [
    "--set", "setupRequests.envId=sandbox-abcd",
    "--set", f"setupRequests.clusterUid={CLUSTER_UID}",
]


def _render(*extra):
    return subprocess.run(
        [_HELM, "template", "dmf-cms", str(CHART), "--namespace", "dmf-console", *_BASE_SET, *extra],
        capture_output=True,
        text=True,
        check=False,
    )


def _documents(rendered: str) -> list[dict]:
    import yaml

    return [doc for doc in yaml.safe_load_all(rendered) if doc]


@pytest.mark.skipif(_HELM is None, reason="helm is not installed")
def test_chart_creates_no_receipt_rbac_until_both_bindings_are_set():
    for extra in ([], ["--set", "setupRequests.envId=sandbox-abcd"], [
        "--set", f"setupRequests.clusterUid={CLUSTER_UID}"
    ]):
        result = _render(*extra)
        assert result.returncode == 0, result.stderr
        docs = _documents(result.stdout)
        kinds = {doc["kind"] for doc in docs}
        assert kinds.isdisjoint({"ServiceAccount", "Role", "RoleBinding"})
        deployment = next(doc for doc in docs if doc["kind"] == "Deployment")
        assert "serviceAccountName" not in deployment["spec"]["template"]["spec"]


@pytest.mark.skipif(_HELM is None, reason="helm is not installed")
def test_chart_grants_the_dedicated_account_create_and_get_on_configmaps_only():
    result = _render(*_BINDINGS)
    assert result.returncode == 0, result.stderr
    docs = _documents(result.stdout)
    account = next(doc for doc in docs if doc["kind"] == "ServiceAccount")
    role = next(doc for doc in docs if doc["kind"] == "Role")
    binding = next(doc for doc in docs if doc["kind"] == "RoleBinding")
    deployment = next(doc for doc in docs if doc["kind"] == "Deployment")
    assert account["metadata"]["name"] == "dmf-cms-setup-requests"
    assert account["metadata"]["namespace"] == "dmf-console"
    assert role["metadata"]["namespace"] == NAMESPACE
    assert role["rules"] == [
        {"apiGroups": [""], "resources": ["configmaps"], "verbs": ["create", "get"]}
    ]
    assert binding["metadata"]["namespace"] == NAMESPACE
    assert binding["roleRef"] == {
        "apiGroup": "rbac.authorization.k8s.io",
        "kind": "Role",
        "name": role["metadata"]["name"],
    }
    assert binding["subjects"] == [
        {"kind": "ServiceAccount", "name": "dmf-cms-setup-requests", "namespace": "dmf-console"}
    ]
    assert deployment["spec"]["template"]["spec"]["serviceAccountName"] == "dmf-cms-setup-requests"
    assert not [doc for doc in docs if doc["kind"] in {"ClusterRole", "ClusterRoleBinding"}]


@pytest.mark.skipif(_HELM is None, reason="helm is not installed")
def test_chart_refuses_a_second_service_account_beside_the_receipt_account():
    result = _render(*_BINDINGS, "--set", "serviceAccountName=other")
    assert result.returncode != 0
    assert "serviceAccountName must stay blank" in result.stderr
    assert _render("--set", "serviceAccountName=other").returncode == 0


def test_setup_request_rejects_break_glass_login_name_behind_an_opaque_subject(monkeypatch):
    client, writer, _ = _client(
        monkeypatch,
        groups=["dmf-console-admin"],
        subject="opaque-oidc-subject",
        claims_extra={"preferred_username": "akadmin"},
    )
    assert client.get("/api/me").status_code == 200
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 403
    assert writer.receipts == []


def test_setup_request_accepts_an_ordinary_login_name_behind_an_opaque_subject(monkeypatch):
    client, writer, _ = _client(
        monkeypatch,
        subject="opaque-oidc-subject",
        claims_extra={"preferred_username": "alice"},
    )
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 201, response.text
    assert writer.receipts[0]["data"]["actor"] == "opaque-oidc-subject"  # type: ignore[index]


@pytest.mark.parametrize("extra", [{}, {"preferred_username": "alice"}])
def test_setup_request_rejects_a_login_whose_userinfo_has_no_subject(monkeypatch, caplog, extra):
    client, writer, _ = _client(
        monkeypatch, groups=["dmf-console-admin"], omit_sub=True, claims_extra=extra
    )
    assert client.get("/api/me").status_code == 200
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 403
    assert writer.receipts == []
    assert _audit_lines(caplog) == []


def test_claims_parser_records_whether_sub_was_present_without_changing_the_fallback():
    from dmf_cms.security import user_from_claims

    present = user_from_claims({"sub": "s-1", "preferred_username": "alice"})
    assert (present.subject, present.username, present.subject_from_claim) == ("s-1", "alice", True)
    named = user_from_claims({"preferred_username": "alice"})
    assert (named.subject, named.username, named.subject_from_claim) == ("alice", "alice", False)
    bare = user_from_claims({})
    assert (bare.subject, bare.username, bare.subject_from_claim) == ("unknown", "", False)
    blank = user_from_claims({"sub": "  ", "preferred_username": "alice"})
    assert blank.subject_from_claim is False


@pytest.mark.parametrize(
    "reason",
    ["\nsetup\n", "setup\n", "\nsetup", "\tsetup", "setup\r\n", "set\x00up", "\x7fsetup"],
)
def test_setup_request_rejects_a_reason_with_control_characters_anywhere(monkeypatch, reason):
    client, writer, _ = _client(monkeypatch)
    response = client.post(ENDPOINT, json={"reason": reason}, headers=SAME_ORIGIN)
    assert response.status_code == 400
    assert "request_id" not in response.json()
    assert writer.receipts == []


@pytest.mark.parametrize("subject", ["\nops", "ops\n", "ops\t", " ops", "ops "])
def test_setup_request_never_rewrites_the_actor(monkeypatch, subject):
    client, writer, _ = _client(monkeypatch, subject=subject)
    response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 400
    assert "request_id" not in response.json()
    assert writer.receipts == []


def test_receipt_builder_rejects_boundary_controls_instead_of_trimming():
    base = {
        "env_id": "sandbox-abcd",
        "cluster_uid": CLUSTER_UID,
        "actor": "operator-1",
        "role": "operator",
        "reason": "setup",
        "now": 100,
        "request_id": "e" * 32,
    }
    for changed in (
        {"actor": "operator-1\n"},
        {"actor": "\toperator-1"},
        {"actor": " operator-1"},
        {"reason": "\nsetup\n"},
        {"reason": "setup\n"},
        {"env_id": "sandbox-abcd\n"},
    ):
        with pytest.raises(ValueError):
            make_receipt(**(base | changed))


@pytest.mark.parametrize("sub", [12345, ["x"], {"id": "x"}, True])
def test_setup_request_rejects_a_login_whose_sub_is_not_a_string(monkeypatch, caplog, sub):
    client, writer, _ = _client(monkeypatch, groups=["dmf-console-admin"], subject=sub)
    assert client.get("/api/me").status_code == 200
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        response = client.post(ENDPOINT, json={"reason": "setup"}, headers=SAME_ORIGIN)
    assert response.status_code == 403
    assert writer.receipts == []
    assert _audit_lines(caplog) == []


def test_claims_parser_counts_only_a_nonblank_string_sub_as_claimed():
    from dmf_cms.security import user_from_claims

    for sub in (12345, 1.5, True, ["x"], {"id": "x"}):
        assert user_from_claims({"sub": sub}).subject_from_claim is False
    assert user_from_claims({"sub": "s-1"}).subject_from_claim is True


def test_setup_request_records_a_padded_reason_trimmed_in_receipt_and_audit(monkeypatch, caplog):
    client, writer, _ = _client(monkeypatch)
    with caplog.at_level(logging.INFO, logger="dmf_cms.audit"):
        response = client.post(ENDPOINT, json={"reason": "  setup  "}, headers=SAME_ORIGIN)
    assert response.status_code == 201, response.text
    assert writer.receipts[0]["data"]["reason"] == "setup"  # type: ignore[index]
    lines = _audit_lines(caplog)
    assert len(lines) == 1
    assert "reason='setup'" in lines[0]
    assert "reason='  setup  '" not in lines[0]
