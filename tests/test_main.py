from fastapi.testclient import TestClient
import pytest

from dmf_cms.main import create_app
from dmf_cms.settings import OIDCSettings, Settings


def test_health_endpoint_reports_release_zero_mode():
    app = create_app()
    client = TestClient(app)

    response = client.get("/healthz")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["product"] == "DMF Console"


def test_login_and_overview_shell_render():
    app = create_app()
    client = TestClient(app)

    login = client.get("/auth/login", follow_redirects=False)
    assert login.status_code in {302, 307}

    overview = client.get("/")
    assert overview.status_code == 200
    assert "DMF Console" in overview.text
    assert "App Catalog" in overview.text


def test_login_redirect_uses_forwarded_https_scheme(monkeypatch):
    settings = Settings(
        runtime_mode="cluster",
        dev_login_enabled=False,
        oidc=OIDCSettings(
            enabled=True,
            issuer_url="https://auth.example.invalid",
            client_id="dmf-cms",
            client_secret="super-secret",
        ),
    )
    app = create_app(settings=settings)
    client = TestClient(app, base_url="https://console.example.invalid")
    monkeypatch.setattr(
        "dmf_cms.main.discovery_document",
        lambda _settings: {"authorization_endpoint": "https://auth.example.invalid/application/o/authorize/"},
    )

    response = client.get(
        "/auth/login",
        follow_redirects=False,
        headers={"x-forwarded-proto": "https", "x-forwarded-host": "console.example.invalid"},
    )

    assert response.status_code in {302, 307}
    assert response.headers["location"].startswith("https://auth.example.invalid/application/o/authorize/")
    assert "redirect_uri=https%3A%2F%2Fconsole.example.invalid%2Fauth%2Fcallback" in response.headers["location"]
    assert "code_challenge=" in response.headers["location"]
    assert "code_challenge_method=S256" in response.headers["location"]


def test_oidc_callback_uses_pkce_verifier(monkeypatch):
    captured = {}

    def fake_exchange_code_for_token(discovery, settings, code, redirect_uri, code_verifier=None):
        captured["redirect_uri"] = redirect_uri
        captured["code_verifier"] = code_verifier
        return {"access_token": "token"}

    def fake_fetch_userinfo(discovery, access_token):
        captured["access_token"] = access_token
        return {
            "sub": "test-operator",
            "name": "Test Operator",
            "email": "test-operator@example.invalid",
            "groups": ["dmf-console-viewer"],
        }

    monkeypatch.setattr("dmf_cms.main.discovery_document", lambda _settings: {"authorization_endpoint": "https://auth.example.invalid/application/o/authorize/", "token_endpoint": "https://auth.example.invalid/application/o/token/", "userinfo_endpoint": "https://auth.example.invalid/application/o/userinfo/"})
    monkeypatch.setattr("dmf_cms.main.exchange_code_for_token", fake_exchange_code_for_token)
    monkeypatch.setattr("dmf_cms.main.fetch_userinfo", fake_fetch_userinfo)

    settings = Settings(
        runtime_mode="cluster",
        dev_login_enabled=False,
        oidc=OIDCSettings(
            enabled=True,
            issuer_url="https://auth.example.invalid",
            client_id="dmf-cms",
            client_secret="super-secret",
        ),
    )
    app = create_app(settings=settings)
    client = TestClient(app, base_url="https://console.example.invalid")

    login = client.get(
        "/auth/login",
        follow_redirects=False,
        headers={"x-forwarded-proto": "https", "x-forwarded-host": "console.example.invalid"},
    )
    assert login.status_code in {302, 307}
    state = client.cookies.get("session")
    assert state is not None

    callback = client.get(
        "/auth/callback?code=test-code&state=" + login.headers["location"].split("state=")[1].split("&")[0],
        follow_redirects=False,
        headers={"x-forwarded-proto": "https", "x-forwarded-host": "console.example.invalid"},
    )

    assert callback.status_code in {302, 307}
    assert captured["redirect_uri"] == "https://console.example.invalid/auth/callback"
    assert captured["code_verifier"]
    assert captured["access_token"] == "token"


def test_cluster_mode_requires_oidc_and_disables_dev_login():
    settings = Settings(runtime_mode="cluster", dev_login_enabled=True)

    with pytest.raises(RuntimeError, match="DMF_CONSOLE_DEV_LOGIN_ENABLED"):
        create_app(settings=settings)


def test_cluster_mode_accepts_explicit_oidc_configuration():
    settings = Settings(
        runtime_mode="cluster",
        dev_login_enabled=False,
        oidc=OIDCSettings(
            enabled=True,
            issuer_url="https://auth.example.invalid",
            client_id="dmf-cms",
            client_secret="super-secret",
        ),
    )

    app = create_app(settings=settings)
    client = TestClient(app)

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json()["auth_mode"] == "oidc"
