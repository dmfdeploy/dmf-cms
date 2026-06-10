"""OIDC / Authentik front-channel vs back-channel split (ADR-0023).

Front-channel (browser): authorize redirect + enrollment URL must use the PUBLIC
host. Back-channel (pod): discovery, token, userinfo, and Authentik API calls use
the cluster-internal service-DNS host over plain HTTP. These tests pin that split
so a future refactor can't silently send a browser to an unresolvable svc URL or
make a server-side call over public TLS.
"""

from dmf_cms import authentik, security
from dmf_cms.settings import AuthentikSettings, OIDCSettings


PUBLIC = "https://auth.example.invalid/application/o/dmf-console"
INTERNAL_BASE = "http://authentik-server.authentik.svc.cluster.local"
INTERNAL = f"{INTERNAL_BASE}/application/o/dmf-console"

# Discovery as Authentik returns it when fetched over the INTERNAL host: every
# endpoint (including authorize + issuer) carries the internal origin.
INTERNAL_DISCOVERY = {
    "issuer": f"{INTERNAL_BASE}/",
    "authorization_endpoint": f"{INTERNAL_BASE}/application/o/authorize/",
    "token_endpoint": f"{INTERNAL_BASE}/application/o/token/",
    "userinfo_endpoint": f"{INTERNAL_BASE}/application/o/userinfo/",
}


class _FakeResp:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self) -> bytes:
        return self._body


def _oidc() -> OIDCSettings:
    return OIDCSettings(
        enabled=True,
        issuer_url=PUBLIC,
        backchannel_issuer_url=INTERNAL,
        client_id="dmf-console",
        client_secret="super-secret",
    )


def test_discovery_base_url_prefers_backchannel():
    assert _oidc().discovery_base_url == INTERNAL
    # No split configured → falls back to the public issuer (unchanged behaviour).
    assert OIDCSettings(issuer_url=PUBLIC).discovery_base_url == PUBLIC


def test_discovery_document_fetches_over_backchannel(monkeypatch):
    seen = {}

    def fake_urlopen(url, timeout=5):
        seen["url"] = url
        return _FakeResp(b'{"issuer":"x"}')

    monkeypatch.setattr(security.urllib.request, "urlopen", fake_urlopen)
    security.discovery_document(_oidc())
    assert seen["url"].startswith(INTERNAL_BASE)
    assert seen["url"].endswith("/.well-known/openid-configuration")


def test_authorize_url_forced_to_public_origin_even_with_internal_discovery():
    url = security.build_authorize_url(
        INTERNAL_DISCOVERY,
        _oidc(),
        redirect_uri="https://console.example.invalid/auth/callback",
        state="s",
        nonce="n",
        code_challenge="cc",
    )
    # The browser must be redirected to the public host, never the svc-DNS one.
    assert url.startswith("https://auth.example.invalid/application/o/authorize/")
    assert "svc.cluster.local" not in url
    # redirect_uri stays the public callback (Authentik enforces exact-match).
    assert "redirect_uri=https%3A%2F%2Fconsole.example.invalid%2Fauth%2Fcallback" in url
    # PKCE preserved.
    assert "code_challenge=cc" in url
    assert "code_challenge_method=S256" in url


def test_token_exchange_hits_internal_endpoint(monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout=10):
        seen["url"] = request.full_url
        seen["body"] = request.data.decode()
        return _FakeResp(b'{"access_token":"t"}')

    monkeypatch.setattr(security.urllib.request, "urlopen", fake_urlopen)
    security.exchange_code_for_token(
        INTERNAL_DISCOVERY,
        _oidc(),
        code="auth-code",
        redirect_uri="https://console.example.invalid/auth/callback",
        code_verifier="verifier",
    )
    # Token exchange rides the internal endpoint...
    assert seen["url"] == INTERNAL_DISCOVERY["token_endpoint"]
    assert "svc.cluster.local" in seen["url"]
    # ...but the posted body carries the PUBLIC callback and the PKCE verifier.
    assert "redirect_uri=https%3A%2F%2Fconsole.example.invalid%2Fauth%2Fcallback" in seen["body"]
    assert "code_verifier=verifier" in seen["body"]


def test_userinfo_hits_internal_endpoint(monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout=10):
        seen["url"] = request.full_url
        return _FakeResp(b'{"sub":"u"}')

    monkeypatch.setattr(security.urllib.request, "urlopen", fake_urlopen)
    security.fetch_userinfo(INTERNAL_DISCOVERY, "access-token")
    assert seen["url"] == INTERNAL_DISCOVERY["userinfo_endpoint"]
    assert "svc.cluster.local" in seen["url"]


def test_enrollment_base_url_prefers_public():
    a = AuthentikSettings(api_url=INTERNAL_BASE, public_base_url="https://auth.example.invalid")
    assert a.enrollment_base_url == "https://auth.example.invalid"
    # No public base → falls back to api_url (local/dev where they are the same).
    assert AuthentikSettings(api_url="http://localhost:9000").enrollment_base_url == "http://localhost:9000"


def test_create_invitation_enrollment_url_uses_public_base(monkeypatch):
    def fake_request(api_url, api_token, method, path, body=None):
        if path.startswith("/api/v3/flows/instances/"):
            return {"results": [{"pk": "flow-uuid"}]}
        return {"pk": "invite-uuid", "expires": "2026-01-01T00:00:00Z"}

    monkeypatch.setattr(authentik, "_request", fake_request)
    result = authentik.create_invitation(
        api_url=INTERNAL_BASE,  # back-channel for the API call
        api_token="t",
        flow_slug="dmf-bootstrap-passkey-enrollment",
        username="u",
        email="u@example.invalid",
        display_name="U",
        public_base_url="https://auth.example.invalid",
    )
    # The link handed to a human must be browser-resolvable, not svc-DNS.
    assert result["enrollment_url"].startswith("https://auth.example.invalid/if/flow/")
    assert "svc.cluster.local" not in result["enrollment_url"]
