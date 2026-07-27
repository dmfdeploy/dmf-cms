"""umbrella #201 WP3a — console launch seam carries topology_params to AWX.

Spec §10 WP3a gate: a catalog-defined topology_params object must reach the
AWX launch as extra_vars (asserted non-empty), for entries with a
topology_ref. Entries without one stay byte-identical to today (mirrors the
#239 workload_slug seam's own bit-compatibility contract, see
test_workload_seam.py).

Mocking convention (same as test_workload_seam.py's awx_spy pattern):
launch_job is spied via monkeypatch; NetBox's list_sites is monkeypatched
directly on the netbox module (main.py calls it as netbox.list_sites, per
`from . import netbox`). load_topology_instance is exercised for real
against a tmp_path catalog dir (monkeypatching CATALOG_DIR), not mocked —
this file is the integration layer over test_topology_params.py's unit
coverage of the loader itself.
"""

import logging
import textwrap
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
from dmf_cms import netbox
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import AWXAutoscaleSettings, AWXSettings, L3Settings, NetboxSettings, Settings


OPERATOR = ("dmf-console-operator",)

J1_INSTANCE = """\
topology_params:
  schema_version: 1
  target_facility: dmf-example-site
  sources:
    - id: source-a
      flow_id: "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
      pattern: smpte
    - id: source-b
      flow_id: "b0ae9cba-a989-4568-ac96-8bd19272c966"
      pattern: ball
  viewer:
    id: viewer-a
    source_selection: source-a
"""

# The exact object load_topology_instance should return for J1_INSTANCE
# above, with ONLY target_facility resolved to the mocked NetBox site slug
# — used for whole-object equality assertions (codex P1): a seam that
# drops/rewrites any field (a source's flow_id, its pattern, the viewer's
# id) must fail these tests, not just a truthiness/field-sample check.
EXPECTED_RESOLVED_J1_TOPOLOGY_PARAMS = {
    "schema_version": 1,
    "target_facility": "dmf-real-env-site",
    "sources": [
        {"id": "source-a", "flow_id": "5fbec3b1-1b0f-417d-9059-8b94a47197ed", "pattern": "smpte"},
        {"id": "source-b", "flow_id": "b0ae9cba-a989-4568-ac96-8bd19272c966", "pattern": "ball"},
    ],
    "viewer": {"id": "viewer-a", "source_selection": "source-a"},
}


def _write_topology_ref(tmp_path: Path, filename: str, body: str) -> None:
    (tmp_path / filename).write_text(textwrap.dedent(body))


def _entry_with_topology_ref(topology_ref: str | None) -> CatalogEntry:
    return CatalogEntry(
        key="mxl-videotestsrc",
        display_name="MXL Test Source",
        summary="x",
        configure={"awx_job_template": "dmf-configure"},
        finalise={"awx_job_template": "dmf-finalise"},
        topology_ref=topology_ref,
    )


def _client(groups, *, netbox_configured: bool = True) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(enabled=False),
        l3=L3Settings(enabled=False),
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="t")
        if netbox_configured else NetboxSettings(),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


@pytest.fixture
def awx_spy(monkeypatch):
    """Same spy pattern as test_workload_seam.py's awx_spy."""
    calls = []
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: None)

    def fake_launch(**kwargs):
        calls.append(kwargs)
        return 4242

    monkeypatch.setattr(main, "launch_job", fake_launch)
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {"status": "successful", "started": "2026-01-01T00:00:00Z", "finished": "2026-01-01T00:05:00Z"},
    )
    return calls


def _entries(monkeypatch, entry: CatalogEntry):
    monkeypatch.setattr(main, "load_catalog_entries", lambda: [entry])


def _one_site(slug="dmf-real-env-site"):
    return [{"name": "Real Env Site", "slug": slug}]


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


# ── (a) topology reaches AWX extra_vars, facility resolved from NetBox ──


def test_sync_deploy_with_topology_ref_injects_resolved_topology_params(
    monkeypatch, tmp_path, awx_spy,
):
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))
    monkeypatch.setattr(netbox, "list_sites", lambda **k: _one_site("dmf-real-env-site"))

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 200, resp.text

    extra_vars = awx_spy[-1]["extra_vars"]
    assert extra_vars is not None
    tp = extra_vars.get("topology_params")
    assert tp  # non-empty, per the WP3a gate
    # Whole-object equality (codex P1) — a seam that drops/rewrites any
    # field must fail this test, not just a truthiness/field-sample check.
    assert tp == EXPECTED_RESOLVED_J1_TOPOLOGY_PARAMS


def test_async_deploy_with_topology_ref_injects_resolved_topology_params(
    monkeypatch, tmp_path, awx_spy,
):
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))
    monkeypatch.setattr(netbox, "list_sites", lambda **k: _one_site("dmf-real-env-site"))
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)

    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=OPERATOR,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=AWXAutoscaleSettings(enabled=True, helper_url="http://helper.test", bearer_token="b"),
        l3=L3Settings(enabled=False),
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="t"),
    )
    with TestClient(create_app(settings=settings)) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
        assert resp.status_code == 202, resp.text
        for _ in range(50):
            op = client.app.state.operations.get(resp.json()["operation_id"])
            if op and op.job_id is not None:
                break
            import time
            time.sleep(0.1)

    extra_vars = awx_spy[-1]["extra_vars"]
    tp = extra_vars.get("topology_params")
    assert tp
    # Whole-object equality (codex P1), same as the sync-flow assertion above.
    assert tp == EXPECTED_RESOLVED_J1_TOPOLOGY_PARAMS


# ── (b) no-ref entry: byte-identical to today ────────────────────────────


def test_deploy_without_topology_ref_omits_topology_params(monkeypatch, awx_spy):
    _entries(monkeypatch, _entry_with_topology_ref(None))
    # No NetBox call should even be attempted for a no-ref entry — assert
    # by never monkeypatching list_sites (a real network call would raise).

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 200, resp.text

    extra_vars = awx_spy[-1].get("extra_vars")
    # Today's exact shape: only the skipped L3 envelope (these fixtures
    # never configure Prometheus), no topology_params key at all.
    assert extra_vars is not None
    assert "topology_params" not in extra_vars
    assert extra_vars.get("l3_preflight_verdict") == "skipped"


# ── (c) malformed instance -> refused, no AWX call ───────────────────────


def test_deploy_with_malformed_topology_instance_refused_no_awx_call(
    monkeypatch, tmp_path, awx_spy, caplog,
):
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", "not_topology_params: {}\n")
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))

    client = _client(OPERATOR)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["error"] == "topology-invalid"
    assert resp.json()["request_id"]
    assert awx_spy == []
    assert any("outcome=topology-invalid" in m for m in _audit_lines(caplog))


def test_deploy_with_missing_topology_ref_file_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("does-not-exist.yaml"))

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert awx_spy == []


# ── (c-continued) codex P1/P2 probe cases refused at the consumer parser ─
# (the loader's own exhaustive coverage lives in test_topology_params.py;
# these confirm the SAME refusals surface through the live deploy endpoint,
# with no AWX call, matching WO6 fix-round instruction #3's requirement)


def test_deploy_invalid_flow_id_uuid_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    bad_instance = """\
    topology_params:
      schema_version: 1
      target_facility: dmf-example-site
      sources:
        - id: source-a
          flow_id: "not-a-real-uuid"
          pattern: smpte
      viewer:
        id: viewer-a
        source_selection: source-a
    """
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", bad_instance)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert "not a well-formed UUID" in resp.json()["detail"]
    assert awx_spy == []


def test_deploy_duplicate_flow_ids_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    bad_instance = """\
    topology_params:
      schema_version: 1
      target_facility: dmf-example-site
      sources:
        - id: source-a
          flow_id: "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
          pattern: smpte
        - id: source-b
          flow_id: "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
          pattern: ball
      viewer:
        id: viewer-a
        source_selection: source-a
    """
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", bad_instance)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert "flow_id values are not unique" in resp.json()["detail"]
    assert awx_spy == []


def test_deploy_duplicate_flow_ids_different_case_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    # codex P1 re-gate: same probe as the catalog-layer test, through the
    # live deploy endpoint — a case-different spelling of the identical
    # UUID must refuse, not launch with a silently-collapsed source.
    lower = "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
    upper = lower.upper()
    assert lower != upper  # guards against ever regressing to a vacuous probe
    bad_instance = f"""\
    topology_params:
      schema_version: 1
      target_facility: dmf-example-site
      sources:
        - id: source-a
          flow_id: "{lower}"
          pattern: smpte
        - id: source-b
          flow_id: "{upper}"
          pattern: ball
      viewer:
        id: viewer-a
        source_selection: source-a
    """
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", bad_instance)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert "flow_id values are not unique" in resp.json()["detail"]
    assert awx_spy == []


def test_deploy_duplicate_patterns_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    bad_instance = """\
    topology_params:
      schema_version: 1
      target_facility: dmf-example-site
      sources:
        - id: source-a
          flow_id: "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
          pattern: smpte
        - id: source-b
          flow_id: "b0ae9cba-a989-4568-ac96-8bd19272c966"
          pattern: smpte
      viewer:
        id: viewer-a
        source_selection: source-a
    """
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", bad_instance)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert "pattern values are not distinct" in resp.json()["detail"]
    assert awx_spy == []


def test_deploy_topology_ref_parent_traversal_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("../escape.yaml"))

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert "plain filename" in resp.json()["detail"]
    assert awx_spy == []


def test_deploy_topology_ref_absolute_path_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    absolute = str(tmp_path / "topology-params.j1.yaml")
    _entries(monkeypatch, _entry_with_topology_ref(absolute))

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert "plain filename" in resp.json()["detail"]
    assert awx_spy == []


def test_deploy_topology_ref_subdir_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    subdir = tmp_path / "subdir"
    subdir.mkdir()
    (subdir / "topology-params.j1.yaml").write_text(J1_INSTANCE)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("subdir/topology-params.j1.yaml"))

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert "plain filename" in resp.json()["detail"]
    assert awx_spy == []


# ── (d) NetBox 0-site / 2-site -> refused, no AWX call ───────────────────


def test_deploy_zero_netbox_sites_refused_no_awx_call(monkeypatch, tmp_path, awx_spy, caplog):
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))
    monkeypatch.setattr(netbox, "list_sites", lambda **k: [])

    client = _client(OPERATOR)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "topology-facility-ambiguous"
    assert resp.json()["site_count"] == 0
    assert awx_spy == []
    assert any("outcome=topology-facility-ambiguous" in m for m in _audit_lines(caplog))


def test_deploy_two_netbox_sites_refused_no_awx_call(monkeypatch, tmp_path, awx_spy, caplog):
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))
    monkeypatch.setattr(
        netbox, "list_sites",
        lambda **k: [{"name": "Site A", "slug": "site-a"}, {"name": "Site B", "slug": "site-b"}],
    )

    client = _client(OPERATOR)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "topology-facility-ambiguous"
    assert resp.json()["site_count"] == 2
    assert awx_spy == []
    assert any("outcome=topology-facility-ambiguous" in m for m in _audit_lines(caplog))


def test_deploy_netbox_not_configured_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))

    client = _client(OPERATOR, netbox_configured=False)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 503, resp.text
    assert resp.json()["error"] == "topology-facility-unavailable"
    assert awx_spy == []


# ── (e) selection referencing a missing source id -> refused ────────────


def test_deploy_viewer_selection_unknown_source_refused_no_awx_call(
    monkeypatch, tmp_path, awx_spy, caplog,
):
    bad_instance = """\
    topology_params:
      schema_version: 1
      target_facility: dmf-example-site
      sources:
        - id: source-a
          flow_id: "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
          pattern: smpte
      viewer:
        id: viewer-a
        source_selection: source-does-not-exist
    """
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", bad_instance)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))

    client = _client(OPERATOR)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["error"] == "topology-invalid"
    assert "does not reference a known sources[].id" in resp.json()["detail"]
    assert awx_spy == []
    assert any("outcome=topology-invalid" in m for m in _audit_lines(caplog))


# ── NetBox API error surfaces distinctly (not silently swallowed) ───────


def test_deploy_netbox_api_error_refused_no_awx_call(monkeypatch, tmp_path, awx_spy):
    _write_topology_ref(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    monkeypatch.setattr(main, "CATALOG_DIR", str(tmp_path))
    _entries(monkeypatch, _entry_with_topology_ref("topology-params.j1.yaml"))

    def raise_netbox_error(**k):
        raise netbox.NetboxAPIError(500, "boom")

    monkeypatch.setattr(netbox, "list_sites", raise_netbox_error)

    client = _client(OPERATOR)
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 502, resp.text
    assert resp.json()["error"] == "topology-facility-error"
    assert awx_spy == []


def test_catalog_listing_with_service_list_entry_returns_200(monkeypatch):
    """The /api/catalog serializer crashed (AttributeError -> 500 -> frontend
    JSON SyntaxError) when provision.netbox_service became the #201 N+1 LIST
    (live incident 2026-07-27). It must serialize the primary (first) name,
    and single-dict entries must be unchanged."""
    list_entry = CatalogEntry(
        key="mxl-videotest-view",
        display_name="MXL Test-Pattern Viewer",
        summary="x",
        provision={"netbox_service": [
            {"name": "mxl-videotest-view"},
            {"name": "mxl-videotest-view-source-a"},
            {"name": "mxl-videotest-view-source-b"},
        ]},
        configure={"awx_job_template": "dmf-configure"},
        finalise={"awx_job_template": "dmf-finalise"},
    )
    dict_entry = CatalogEntry(
        key="nmos-cpp",
        display_name="NMOS",
        summary="x",
        provision={"netbox_service": {"name": "nmos-cpp-registry"}},
        configure={"awx_job_template": "c"},
        finalise={"awx_job_template": "f"},
    )
    monkeypatch.setattr(main, "load_catalog_entries", lambda: [list_entry, dict_entry])
    monkeypatch.setattr(main, "get_lifecycle_status", lambda *a, **k: "unknown")
    client = _client(["dmf-console-admin"])
    resp = client.get("/api/catalog")
    assert resp.status_code == 200, resp.text
    by_key = {e["key"]: e for e in resp.json()["entries"]}
    assert by_key["mxl-videotest-view"]["provision_netbox_service"] == "mxl-videotest-view"
    assert by_key["nmos-cpp"]["provision_netbox_service"] == "nmos-cpp-registry"
