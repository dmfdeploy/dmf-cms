from fastapi.testclient import TestClient

from dmf_cms.main import create_app
from dmf_cms.settings import Settings


def test_console_base_path_supports_prefixed_routes():
    app = create_app(settings=Settings(base_path="/console"))
    client = TestClient(app)

    health = client.get("/console/healthz")
    assert health.status_code == 200

    login = client.get("/console/auth/login", follow_redirects=False)
    assert login.status_code in {302, 307}
    assert login.headers["location"].endswith("/console/")

    overview = client.get("/console/", follow_redirects=True)
    assert overview.status_code == 200
    assert "DMF Console" in overview.text
