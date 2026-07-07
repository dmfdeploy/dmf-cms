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


# --------------------------------------------------------------------------
# RP-initiated logout (dmfdeploy/dmfdeploy#185 WP-E, handoff §5b)
# --------------------------------------------------------------------------

_DISCOVERY_WITH_END_SESSION = {
    "authorization_endpoint": "https://auth.example.invalid/application/o/authorize/",
    "token_endpoint": "https://auth.example.invalid/application/o/token/",
    "userinfo_endpoint": "https://auth.example.invalid/application/o/userinfo/",
    "end_session_endpoint": "https://auth.example.invalid/application/o/dmf-console/end-session/",
}


def _oidc_client(monkeypatch, discovery, *, logout_redirect_url=""):
    """An OIDC-configured console with a logged-in session. The token response
    includes an id_token, but the app deliberately does NOT persist it (WP-E
    P2) — logout relies on client_id + post_logout_redirect_uri instead."""
    def fake_exchange(discovery_, settings_, code, redirect_uri, code_verifier=None):
        return {"access_token": "token", "id_token": "the-id-token"}

    def fake_userinfo(discovery_, access_token):
        return {"sub": "ops", "name": "Ops", "email": "ops@example.invalid", "groups": ["dmf-console-operator"]}

    monkeypatch.setattr("dmf_cms.main.discovery_document", lambda _s: discovery)
    monkeypatch.setattr("dmf_cms.main.exchange_code_for_token", fake_exchange)
    monkeypatch.setattr("dmf_cms.main.fetch_userinfo", fake_userinfo)

    settings = Settings(
        runtime_mode="cluster",
        dev_login_enabled=False,
        oidc=OIDCSettings(
            enabled=True,
            issuer_url="https://auth.example.invalid",
            client_id="dmf-console",
            client_secret="super-secret",
            logout_redirect_url=logout_redirect_url,
        ),
    )
    client = TestClient(create_app(settings=settings), base_url="https://console.example.invalid")
    login = client.get("/auth/login", follow_redirects=False)
    state = login.headers["location"].split("state=")[1].split("&")[0]
    client.get(f"/auth/callback?code=c&state={state}", follow_redirects=False)
    return client


def test_logout_routes_through_end_session(monkeypatch):
    client = _oidc_client(
        monkeypatch, _DISCOVERY_WITH_END_SESSION,
        logout_redirect_url="https://console.example.invalid/",
    )
    resp = client.get("/auth/logout", follow_redirects=False)
    assert resp.status_code == 200
    # The landing kills the SSO session via the IdP end-session endpoint, keyed
    # by client_id + post_logout_redirect_uri. No id_token_hint: we never stash
    # the id_token in the client-side session cookie (codex WP-E P2).
    assert "https://auth.example.invalid/application/o/dmf-console/end-session/" in resp.text
    assert "id_token_hint" not in resp.text
    assert "client_id=dmf-console" in resp.text
    assert "post_logout_redirect_uri=https%3A%2F%2Fconsole.example.invalid%2F" in resp.text
    # session is cleared regardless
    assert client.get("/api/me").status_code == 401


def test_logout_falls_back_to_plain_landing_without_end_session(monkeypatch):
    discovery = {k: v for k, v in _DISCOVERY_WITH_END_SESSION.items() if k != "end_session_endpoint"}
    client = _oidc_client(
        monkeypatch, discovery,
        logout_redirect_url="https://console.example.invalid/bye",
    )
    resp = client.get("/auth/logout", follow_redirects=False)
    assert resp.status_code == 200
    assert "end-session" not in resp.text
    assert "https://console.example.invalid/bye" in resp.text
