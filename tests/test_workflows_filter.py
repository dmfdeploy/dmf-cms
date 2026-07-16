"""/api/workflows exposes catalog launchers only by default (Art. 3).

The AWX inventory contains internal/spike job templates (e.g.
``eso-openbao-health-check``) alongside the catalog launchers. Rendering the
raw list on the Workspace admin panel and the Activity → Jobs lane leaks
implementation jargon at default level. The endpoint now filters to the
catalog-launcher allow-list — DERIVED from catalog data (each entry's
``configure``/``finalise`` ``awx_job_template``), not a hardcoded regex — and
lets an ADMIN opt into the full inventory with ?all=true. A non-admin passing
?all=true is still filtered (fail-closed).
"""

from fastapi.testclient import TestClient
import pytest

import dmf_cms.main as main
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import AWXSettings, Settings


VIEWER = ("dmf-console-viewer",)
OPERATOR = ("dmf-console-operator",)
ADMIN = ("dmf-console-admin",)

# The full AWX inventory the service account can see: two catalog launchers
# (configure + finalise for one function) plus an internal/spike template.
_AWX_TEMPLATES = [
    {"id": 1, "name": "media-launch-mxl-videotestsrc", "description": "launch", "type": "job_template"},
    {"id": 2, "name": "media-finalise-mxl-videotestsrc", "description": "finalise", "type": "job_template"},
    {"id": 9, "name": "eso-openbao-health-check", "description": "spike", "type": "job_template"},
]

# The catalog declares only the two launchers (across configure + finalise).
_CATALOG = [
    CatalogEntry(
        key="mxl-videotestsrc",
        display_name="MXL Test-Pattern Source",
        summary="",
        ebu={"media_function_type": "source"},
        configure={"awx_job_template": "media-launch-mxl-videotestsrc"},
        finalise={"awx_job_template": "media-finalise-mxl-videotestsrc"},
    ),
]

# Recent AWX job history: runs of a catalog launcher AND of an internal
# template. AWX names jobs after their template (schema-coupling assumption).
_AWX_JOBS = [
    {"id": 101, "name": "media-launch-mxl-videotestsrc", "status": "successful", "started": "t", "finished": "t", "elapsed": 1.0, "failed": False},
    {"id": 102, "name": "eso-openbao-health-check", "status": "failed", "started": "t", "finished": "t", "elapsed": 2.0, "failed": True},
]


def _client(groups) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


@pytest.fixture(autouse=True)
def _stub_awx_and_catalog(monkeypatch):
    monkeypatch.setattr(main, "list_job_templates", lambda **k: list(_AWX_TEMPLATES))
    monkeypatch.setattr(main, "list_recent_jobs", lambda **k: list(_AWX_JOBS))
    monkeypatch.setattr(main, "load_catalog_entries", lambda *a, **k: list(_CATALOG))


def _names(resp):
    return [t["name"] for t in resp.json()["templates"]]


def test_default_list_is_catalog_launchers_only():
    resp = _client(OPERATOR).get("/api/workflows")
    assert resp.status_code == 200
    body = resp.json()
    assert body["filtered"] is True
    names = [t["name"] for t in body["templates"]]
    assert set(names) == {"media-launch-mxl-videotestsrc", "media-finalise-mxl-videotestsrc"}
    assert "eso-openbao-health-check" not in names


def test_viewer_also_gets_filtered_list():
    # The endpoint is login-only; a viewer reading it still must not see
    # internal templates.
    assert "eso-openbao-health-check" not in _names(_client(VIEWER).get("/api/workflows"))


def test_admin_can_opt_into_full_inventory():
    resp = _client(ADMIN).get("/api/workflows?all=true")
    assert resp.status_code == 200
    body = resp.json()
    assert body["filtered"] is False
    assert "eso-openbao-health-check" in [t["name"] for t in body["templates"]]


def test_non_admin_all_param_is_still_filtered():
    # Fail-closed: only an admin's ?all=true is honored.
    resp = _client(OPERATOR).get("/api/workflows?all=true")
    body = resp.json()
    assert body["filtered"] is True
    assert "eso-openbao-health-check" not in [t["name"] for t in body["templates"]]


def test_empty_catalog_yields_empty_default_list(monkeypatch):
    # Fail-closed: no catalog loaded → no launchers exposed (never the raw
    # inventory) at default. (Overrides the autouse catalog stub.)
    monkeypatch.setattr(main, "load_catalog_entries", lambda *a, **k: [])
    resp = _client(OPERATOR).get("/api/workflows")
    assert resp.json()["templates"] == []
    assert resp.json()["filtered"] is True


def test_view_as_downgrade_loses_the_all_escape_hatch(monkeypatch):
    # Codex P2-2 (B+E composition): an admin who has set view-as to a lower
    # role has an effective role below admin, so ?all=true is NOT honored —
    # the internal template stays hidden (fail-closed on the effective role).
    client = _client(ADMIN)
    assert client.post("/api/me/view-as", json={"role": "engineer"}).status_code == 200
    resp = client.get("/api/workflows?all=true")
    body = resp.json()
    assert body["filtered"] is True
    assert "eso-openbao-health-check" not in [t["name"] for t in body["templates"]]


# ── Job-history paths (codex P1-1 / P1-2) ──────────────────────────────────


def _job_names(resp):
    return [j["name"] for j in resp.json()["jobs"]]


def test_changes_jobs_history_filtered_unconditionally():
    # All-roles default surface (Activity History + Workspace Recent changes):
    # a historical internal-template run must never render at default.
    for groups in (VIEWER, OPERATOR):
        names = _job_names(_client(groups).get("/api/changes/jobs"))
        assert "media-launch-mxl-videotestsrc" in names
        assert "eso-openbao-health-check" not in names


def test_changes_jobs_has_no_all_escape_hatch_even_for_admin():
    # This endpoint is a default surface by definition — ?all is not honored.
    names = _job_names(_client(ADMIN).get("/api/changes/jobs?all=true"))
    assert "eso-openbao-health-check" not in names


def test_admin_jobs_filtered_by_default():
    resp = _client(ADMIN).get("/api/admin/jobs")
    body = resp.json()
    assert body["filtered"] is True
    assert "eso-openbao-health-check" not in [j["name"] for j in body["jobs"]]


def test_admin_jobs_all_shows_internal_history():
    resp = _client(ADMIN).get("/api/admin/jobs?all=true")
    body = resp.json()
    assert body["filtered"] is False
    assert "eso-openbao-health-check" in [j["name"] for j in body["jobs"]]
