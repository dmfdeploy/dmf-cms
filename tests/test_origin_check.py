"""Every API write must come from the console's own pages."""

import re

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from starlette.routing import Mount, Route, WebSocketRoute

from dmf_cms.main import create_app
from dmf_cms.settings import PLACEHOLDER_SECRET_KEYS, OIDCSettings, Settings

REFUSED = {"error": "same-origin request required"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


@pytest.fixture
def app():
    return create_app(settings=Settings(runtime_mode="local", dev_login_enabled=True))


def _walk(routes, prefix=""):
    """Yield (method, path) for every HTTP route, including mounted apps and routers."""
    for route in routes:
        if isinstance(route, Route):
            for method in route.methods or ():
                yield method, prefix + route.path
        elif hasattr(route, "original_router"):
            # Newer FastAPI keeps an included router as one lazy entry.
            context = getattr(route, "include_context", None)
            yield from _walk(route.original_router.routes, prefix + (getattr(context, "prefix", "") or ""))
        elif isinstance(route, Mount):
            sub = getattr(route.app, "routes", None)
            if sub is None:
                # A mount we cannot walk (static files). It must serve reads only.
                assert route.path == "/static", f"unwalkable mount {route.path!r}"
            else:
                yield from _walk(sub, prefix + route.path)
        else:
            # Fail on a route type this walk does not understand, so it cannot
            # silently skip a write route.
            assert isinstance(route, WebSocketRoute), f"unknown route type {type(route)!r}"


def _write_routes(app):
    return sorted((m, p) for m, p in _walk(app.routes) if m not in SAFE_METHODS)


def _concrete(path):
    return re.sub(r"\{[^}]+\}", "x", path)


def test_the_app_has_write_routes_to_check(app):
    assert len(_write_routes(app)) >= 12


def test_every_write_route_is_under_api(app):
    # The check covers /api/ only, so a write route elsewhere would skip it.
    assert [r for r in _write_routes(app) if not r[1].startswith("/api/")] == []


def test_every_write_route_refuses_missing_and_foreign_origin(app):
    client = TestClient(app)
    client.headers.pop("origin")
    for method, path in _write_routes(app):
        url = _concrete(path)
        missing = client.request(method, url)
        assert (missing.status_code, missing.json()) == (403, REFUSED), (method, path)
        foreign = client.request(method, url, headers={"origin": "https://evil.example.invalid"})
        assert (foreign.status_code, foreign.json()) == (403, REFUSED), (method, path)


def test_every_write_route_gets_past_the_check_with_a_matching_origin(app):
    client = TestClient(app)
    for method, path in _write_routes(app):
        response = client.request(method, _concrete(path), headers={"origin": "http://testserver"})
        assert response.headers.get("content-type", "").startswith("application/json"), (method, path)
        assert response.json() != REFUSED, (method, path)


def test_a_matching_referer_alone_is_refused(app):
    client = TestClient(app)
    client.headers.pop("origin")
    response = client.delete("/api/me/view-as", headers={"referer": "http://testserver/static/app/"})
    assert (response.status_code, response.json()) == (403, REFUSED)


def test_the_walk_finds_writes_in_mounted_apps_and_routers():
    sub = FastAPI()
    sub.add_api_route("/thing", lambda: None, methods=["POST"])
    router = APIRouter()
    router.add_api_route("/other", lambda: None, methods=["DELETE"])
    app = FastAPI()
    app.mount("/mounted", sub)
    app.include_router(router, prefix="/routed")
    assert _write_routes(app) == [("DELETE", "/routed/other"), ("POST", "/mounted/thing")]


def test_origin_is_checked_behind_the_proxy_and_base_path():
    # As deployed: TLS ends at the proxy, which forwards the public host and
    # scheme, and the console is served under a base path.
    app = create_app(settings=Settings(runtime_mode="local", dev_login_enabled=True, base_path="/console"))
    client = TestClient(app, base_url="http://dmf.example.com")
    forwarded = {"x-forwarded-proto": "https", "x-forwarded-host": "dmf.example.com"}
    url = "/console/api/me/view-as"
    for origin in ("https://dmf.example.com", "https://dmf.example.com:443"):
        response = client.delete(url, headers={**forwarded, "origin": origin})
        assert response.json() != REFUSED, origin
    for origin in ("https://evil.example.invalid", "http://dmf.example.com", "https://dmf.example.com:8443"):
        response = client.delete(url, headers={**forwarded, "origin": origin})
        assert (response.status_code, response.json()) == (403, REFUSED), origin


def test_null_origin_is_refused(app):
    client = TestClient(app)
    response = client.delete("/api/me/view-as", headers={"origin": "null"})
    assert (response.status_code, response.json()) == (403, REFUSED)


def test_safe_methods_need_no_origin(app):
    client = TestClient(app)
    client.headers.pop("origin")
    assert client.get("/healthz").status_code == 200


def _cluster_settings(secret_key):
    return Settings(
        runtime_mode="cluster",
        dev_login_enabled=False,
        secret_key=secret_key,
        oidc=OIDCSettings(
            enabled=True,
            issuer_url="https://auth.example.invalid",
            client_id="dmf-cms",
            client_secret="oidc-secret",
        ),
    )


@pytest.mark.parametrize("value", [*sorted(PLACEHOLDER_SECRET_KEYS), "", "  ", "Change-Me-In-Production"])
def test_cluster_mode_refuses_a_placeholder_session_secret(value):
    with pytest.raises(RuntimeError, match="DMF_CONSOLE_SECRET_KEY") as excinfo:
        create_app(settings=_cluster_settings(value))
    assert "openssl rand" in str(excinfo.value)
    if value.strip():
        assert value not in str(excinfo.value)


def test_cluster_mode_accepts_a_real_session_secret():
    create_app(settings=_cluster_settings("a-long-random-value"))


def test_local_mode_keeps_the_default_secret():
    create_app(settings=Settings(runtime_mode="local", dev_login_enabled=True))
