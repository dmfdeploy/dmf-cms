"""GET/POST /api/media-workloads/{instance}/topology + /switch-source
(umbrella #201 WP5, spec §7 — console switch surface).

The domain command/status machine/actuator all live in switch_source.py
(WP4, own coverage in test_switch_source.py) — this file covers the THIN
console seam main.py adds on top: the topology-read seam the switch UI
needs (not itself spec-enumerated — see api_media_workloads_topology's own
docstring), the write's access gate, the C5 pattern (_require_reason + the
new _require_source_instance + _audit_awx_write), and translating
SwitchSourceError/SwitchStatus onto HTTP.

Mocking convention: ``load_catalog_entries``/``load_topology_instance`` are
monkeypatched directly on the ``switch_source`` module (not ``catalog``) —
switch_source.py imports them by name (``from .catalog import ...``), a
name-bound copy that does NOT re-resolve through the catalog module, and
(codex-relevant gotcha) ``CATALOG_DIR`` is baked into
``resolve_topology_for_receiver``/``dispatch_switch_source`` as a DEFAULT
ARGUMENT VALUE at import time — monkeypatching the constant after import
would silently not take effect, so the loader FUNCTIONS are patched
instead, same as test_topology_seam.py's own convention for NetBox's
list_sites. AWX calls are monkeypatched on the ``awx`` module directly, same
as test_switch_source.py's own actuator tests.

Lifespan gotcha (dmf-cms-frontend/backend test conventions): ``app.state.
switch_commands`` is only populated once the app's ``lifespan`` context has
actually run, which a bare ``TestClient(app)`` does NOT trigger — only
``with TestClient(app) as client:`` does (see test_rollback_command.py's own
split between plain ``_client()`` for early-return-only paths and
``with TestClient(...) as client:`` for anything that reaches a real
dispatch). Every test here that reaches ``dispatch_switch_source`` (i.e.
passes the reason/source_instance/awx-configured gates) uses the ``with``
form; pure gate-rejection tests (403/400/503) use the plain client.
"""

import logging
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from dmf_cms import awx
from dmf_cms import main as main_module
from dmf_cms import media_workloads, mxl
from dmf_cms import switch_source
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import AWXSettings, L3Settings, MediaTenancySettings, NetboxSettings, Settings

ENGINEER = ("dmf-console-engineer",)
VIEWER = ("dmf-console-viewer",)
MEDIA_ENGINEERS = ("media-engineers",)

J1_TOPOLOGY_PARAMS = {
    "schema_version": 1,
    "target_facility": "dmf-example-site",
    "sources": [
        {"id": "source-a", "flow_id": "5fbec3b1-1b0f-417d-9059-8b94a47197ed", "pattern": "smpte"},
        {"id": "source-b", "flow_id": "b0ae9cba-a989-4568-ac96-8bd19272c966", "pattern": "ball"},
    ],
    "viewer": {"id": "viewer-a", "source_selection": "source-a"},
}

VIEWER_ENTRY = CatalogEntry(
    key="mxl-videotest-view", display_name="Viewer", summary="x",
    topology_ref="topology-params.j1.yaml",
)
NO_TOPOLOGY_ENTRY = CatalogEntry(key="mxl-videotest-view", display_name="Viewer", summary="x")


def _patch_catalog(monkeypatch, *, entries, topology_ok=True, topology_error="broken"):
    def fake_load_topology_instance(catalog_dir, topology_ref):
        if topology_ok:
            return dict(J1_TOPOLOGY_PARAMS), None
        return None, topology_error

    monkeypatch.setattr(switch_source, "load_catalog_entries", lambda catalog_dir: entries)
    monkeypatch.setattr(switch_source, "load_topology_instance", fake_load_topology_instance)


def _mock_awx_terminal(monkeypatch, *, status="successful"):
    monkeypatch.setattr(awx, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(awx, "launch_job", lambda **k: 42)
    monkeypatch.setattr(awx, "get_job", lambda **k: {"status": status})
    monkeypatch.setattr(awx, "get_job_stdout", lambda **k: "")


# umbrella #321: netbox/media_tenancy default UNCONFIGURED (matching every
# existing test's assumption) — _resolve_mxl_target short-circuits to
# {"status": "unreachable"} before ever calling resolve_sidecar_target, so
# active_source/provenance/observed_at all come back None/unavailable for
# every test that doesn't explicitly opt in via _patch_sidecar_observed.
SIDECAR_NETBOX = NetboxSettings(api_url="http://netbox.test", api_token="tok")
SIDECAR_TENANCY = MediaTenancySettings(mode="single")


def _patch_sidecar_observed(monkeypatch, *, flow_id):
    """The sidecar is reachable and reports this flow_id (umbrella #321)."""
    monkeypatch.setattr(
        media_workloads, "resolve_sidecar_target",
        lambda *a, **k: {"status": "ok", "base_url": "http://sidecar.test:9000"},
    )
    monkeypatch.setattr(mxl, "fetch_status_one", lambda base_url, **k: {"flow": {"id": flow_id}})


def _patch_sidecar_unreachable(monkeypatch):
    monkeypatch.setattr(media_workloads, "resolve_sidecar_target", lambda *a, **k: {"status": "unreachable"})


SOURCE_A_FLOW_ID = "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
SOURCE_B_FLOW_ID = "b0ae9cba-a989-4568-ac96-8bd19272c966"


def _patch_fresh_observed_source_a(monkeypatch):
    """umbrella #320/#321 fix-round: the POST endpoint's own write-seam
    gate now re-resolves observed truth before EVERY dispatch — every
    existing test that expects a real dispatch needs this (a fresh,
    matching sidecar observation), same as the fixture's own declared
    source-a, or it now 409s at the gate before ever reaching dispatch."""
    _patch_sidecar_observed(monkeypatch, flow_id=SOURCE_A_FLOW_ID)


class _SeqUtcNow:
    """Sequential-clock test double for main._utc_now — the nth call
    returns times[n] (the last value repeats once exhausted). Lets a test
    script a (stamp-time, check-time) pair to prove the write-seam's
    staleness branch is real and reachable, without perturbing any other
    datetime.now() call site (main._utc_now is a dedicated, narrow seam —
    see its own docstring)."""

    def __init__(self, times):
        self._times = list(times)
        self._i = 0

    def __call__(self):
        t = self._times[min(self._i, len(self._times) - 1)]
        self._i += 1
        return t


def _settings(
    groups=ENGINEER, *, awx_configured=True, l3=None, netbox=None, media_tenancy=None,
) -> Settings:
    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t") if awx_configured else AWXSettings(),
        l3=l3 if l3 is not None else L3Settings(),
        netbox=netbox if netbox is not None else NetboxSettings(),
        media_tenancy=media_tenancy if media_tenancy is not None else MediaTenancySettings(),
    )


def _client(
    groups=ENGINEER, *, awx_configured=True, netbox=None, media_tenancy=None,
) -> TestClient:
    """For gate-rejection tests that never reach a real dispatch (403/400/503) —
    does NOT trigger lifespan, so app.state.switch_commands is never touched."""
    client = TestClient(create_app(settings=_settings(
        groups, awx_configured=awx_configured, netbox=netbox, media_tenancy=media_tenancy,
    )))
    client.get("/auth/login", follow_redirects=False)
    return client


def _dispatch_client(groups=ENGINEER, *, l3=None, netbox=None, media_tenancy=None) -> TestClient:
    """For tests that reach dispatch_switch_source — caller must use this as
    ``with _dispatch_client() as client:`` so lifespan actually runs."""
    return TestClient(create_app(settings=_settings(groups, l3=l3, netbox=netbox, media_tenancy=media_tenancy)))


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


def _post(client, instance="mxl-videotest-view", body=None):
    return client.post(f"/api/media-workloads/{instance}/switch-source", json=body or {})


# ── authz gate ────────────────────────────────────────────────────────


def test_viewer_without_media_engineers_is_403(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])

    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog before the authz gate")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client(VIEWER)
    resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    assert resp.status_code == 403


def test_real_media_engineers_group_grants_access_without_role(monkeypatch, caplog):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _mock_awx_terminal(monkeypatch)
    _patch_fresh_observed_source_a(monkeypatch)
    with _dispatch_client(MEDIA_ENGINEERS, netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY) as client:
        client.get("/auth/login", follow_redirects=False)
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    assert resp.status_code == 200
    body = resp.json()
    # C5 records the member's true capability role (viewer), matching
    # clear-for-deployment's own media-engineers precedent.
    assert body["role"] == "viewer"


# ── C5 request-shape gates — before any dispatch ────────────────────────


def test_reason_required_400_before_dispatch(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])

    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog before reason is validated")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client()
    resp = _post(client, body={"source_instance": "source-b"})
    assert resp.status_code == 400
    assert resp.json()["error"] == "reason-required"


def test_source_instance_required_400_before_dispatch(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog before source_instance is validated")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client()
    for bad_body in [{"reason": "go"}, {"reason": "go", "source_instance": ""}, {"reason": "go", "source_instance": "  "}]:
        resp = _post(client, body=bad_body)
        assert resp.status_code == 400, bad_body
        assert resp.json()["error"] == "source-instance-required"


def test_awx_not_configured_503_before_dispatch(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog when AWX isn't configured")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client(awx_configured=False)
    resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    assert resp.status_code == 503
    assert resp.json()["error"] == "AWX API not configured"


# ── request-shape validation past the gates, before a command is created


def test_receiver_not_found_is_404(monkeypatch):
    _patch_catalog(monkeypatch, entries=[])
    with _dispatch_client() as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, instance="does-not-exist", body={"source_instance": "source-a", "reason": "go"})
    assert resp.status_code == 404
    assert resp.json()["error"] == "receiver-not-found"
    assert resp.json()["request_id"]


def test_receiver_without_topology_ref_is_404(monkeypatch):
    _patch_catalog(monkeypatch, entries=[NO_TOPOLOGY_ENTRY])
    with _dispatch_client() as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, body={"source_instance": "source-a", "reason": "go"})
    assert resp.status_code == 404
    assert resp.json()["error"] == "receiver-not-topology"


def test_invalid_topology_params_is_422(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY], topology_ok=False, topology_error="schema_version must equal 1")
    with _dispatch_client() as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, body={"source_instance": "source-a", "reason": "go"})
    assert resp.status_code == 422
    assert resp.json()["error"] == "topology-invalid"
    assert "schema_version" in resp.json()["detail"]


def test_unknown_source_instance_is_422(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _patch_fresh_observed_source_a(monkeypatch)
    with _dispatch_client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, body={"source_instance": "does-not-exist", "reason": "go"})
    assert resp.status_code == 422
    assert resp.json()["error"] == "source-not-found"


# ── write-seam observed-truth gate (umbrella #320/#321 fix-round) ───────
#
# The GET .../topology read enforces "never trust the catalog's own
# source_selection as live truth" — these tests prove the POST write seam
# enforces the SAME invariant, closing the TOCTOU gap where a client could
# arm a switch while fresh and still fire it once the observation had
# gone stale/unreachable/mismatched. Each 409 test proves dispatch was
# NEVER reached via a boom-patched dispatch_switch_source, mirroring this
# file's own existing convention for pre-dispatch gates.


def test_switch_source_post_refuses_when_observed_truth_is_unknown(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _patch_sidecar_unreachable(monkeypatch)

    def boom_dispatch(*a, **k):
        raise AssertionError("must not dispatch when observed truth is unknown")

    monkeypatch.setattr(main_module, "dispatch_switch_source", boom_dispatch)
    client = _client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY)
    resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    assert resp.status_code == 409
    assert resp.json() == {"error": "source-state-unknown", "request_id": resp.json()["request_id"]}


def test_switch_source_post_refuses_when_observed_truth_is_stale(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _patch_fresh_observed_source_a(monkeypatch)
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    # First call stamps observed_at (inside _resolve_observed_active_source);
    # second call is the gate's OWN freshness check, 16s later — past
    # OBSERVED_SOURCE_STALE_SECONDS (15).
    monkeypatch.setattr(main_module, "_utc_now", _SeqUtcNow([t0, t0 + timedelta(seconds=16)]))

    def boom_dispatch(*a, **k):
        raise AssertionError("must not dispatch when the observation has gone stale")

    monkeypatch.setattr(main_module, "dispatch_switch_source", boom_dispatch)
    client = _client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY)
    resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    assert resp.status_code == 409
    assert resp.json()["error"] == "source-state-stale"


def test_switch_source_post_refuses_when_target_already_active(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _patch_fresh_observed_source_a(monkeypatch)  # observed active == source-a

    def boom_dispatch(*a, **k):
        raise AssertionError("must not dispatch a switch to the already-active source")

    monkeypatch.setattr(main_module, "dispatch_switch_source", boom_dispatch)
    client = _client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY)
    resp = _post(client, body={"source_instance": "source-a", "reason": "go"})  # requesting the observed-active one
    assert resp.status_code == 409
    assert resp.json()["error"] == "target-already-active"


def test_switch_source_post_records_previous_source_from_observed_not_catalog(monkeypatch):
    """Discriminating test: the catalog's own declared selection here is
    source-a (J1_TOPOLOGY_PARAMS' viewer.source_selection), but the
    sidecar observes source-b as ACTUALLY active — switching to source-a
    (the observed-INactive one, so the gate above doesn't refuse it as
    target-already-active) must record previous_source=source-b, the
    OBSERVED truth, never the catalog's stale belief."""
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _patch_sidecar_observed(monkeypatch, flow_id=SOURCE_B_FLOW_ID)
    _mock_awx_terminal(monkeypatch, status="successful")
    with _dispatch_client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, body={"source_instance": "source-a", "reason": "go"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "active"
    assert body["source_instance"] == "source-a"
    assert body["previous_source"] == "source-b"


# ── happy path + C5 audit content ────────────────────────────────────────


def test_happy_path_reaches_active_with_c5_audit(monkeypatch, caplog):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _mock_awx_terminal(monkeypatch, status="successful")
    _patch_fresh_observed_source_a(monkeypatch)
    with _dispatch_client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY) as client:
        client.get("/auth/login", follow_redirects=False)
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = _post(client, body={"source_instance": "source-b", "reason": "operator requested"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "active"
    assert body["error"] is None
    assert body["receiver_instance"] == "mxl-videotest-view"
    assert body["source_instance"] == "source-b"
    assert body["previous_source"] == "source-a"
    assert body["reason"] == "operator requested"
    assert body["actor"] == "operator"
    assert body["role"] == "engineer"
    assert body["request_id"]
    assert body["command_id"]

    lines = _audit_lines(caplog)
    assert len(lines) == 1
    line = lines[0]
    assert "action=switch-source" in line
    assert "actor=operator" in line
    assert "role=engineer" in line
    assert f"request_id={body['request_id']}" in line
    assert "target=mxl-videotest-view" in line
    assert "reason='operator requested'" in line
    assert "outcome=active" in line
    assert "workload=source-b" in line  # source_instance rides the workload slot


def test_failed_rollback_required_is_200_not_an_http_error(monkeypatch, caplog):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _mock_awx_terminal(monkeypatch, status="failed")
    _patch_fresh_observed_source_a(monkeypatch)
    with _dispatch_client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY) as client:
        client.get("/auth/login", follow_redirects=False)
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    # Not an HTTP error — dispatch_switch_source's own contract: an
    # actuator-level failure is a normal (if unhappy) response.
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed_rollback_required"
    assert body["error"] == "switch-job-failed"
    # umbrella #320: the new additive outcome fields ride the same response
    # envelope — stdout here is mocked to empty text (no rollback/refused
    # marker), so the generic job-status mapping applies.
    assert body["outcome"] == "switch_job_failed"
    assert body["outcome_message"] is None
    assert any("outcome=failed_rollback_required" in m for m in _audit_lines(caplog))


# ── DMF_CONSOLE_L3_SWITCH_SOURCE_TIMEOUT_SECONDS wiring (umbrella #306) ──


def test_switch_source_passes_configured_timeout_to_actuator(monkeypatch):
    """The endpoint must pass settings.l3.switch_source_timeout_seconds into
    ReconnectViaAwxActuator's own timeout_seconds — not rely on the
    actuator's flat 120s class default (test_switch_source.py's own
    load_settings() tests cover the settings-layer default/override;
    this covers main.py's actual constructor call)."""
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _mock_awx_terminal(monkeypatch, status="successful")
    _patch_fresh_observed_source_a(monkeypatch)

    captured: dict = {}
    real_actuator_cls = main_module.ReconnectViaAwxActuator

    def spy_actuator(**kwargs):
        captured.update(kwargs)
        return real_actuator_cls(**kwargs)

    monkeypatch.setattr(main_module, "ReconnectViaAwxActuator", spy_actuator)

    with _dispatch_client(
        l3=L3Settings(switch_source_timeout_seconds=45), netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY,
    ) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, body={"source_instance": "source-b", "reason": "go"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "active"
    assert captured["timeout_seconds"] == 45


# ── GET .../topology — the switch UI's source-discovery read seam ───────


def test_topology_read_requires_media_workloads_access(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("must not resolve the catalog before the authz gate")

    monkeypatch.setattr(switch_source, "load_catalog_entries", boom)
    client = _client(VIEWER)
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 403


def test_topology_read_happy_path(monkeypatch):
    """umbrella #321 discriminating test: the catalog's OWN declared
    selection here is source-a (J1_TOPOLOGY_PARAMS' viewer.source_selection),
    but the sidecar reports a flow.id matching source-b — active_source
    MUST reflect the OBSERVED source (source-b), never the catalog's
    static selection. This is the exact bug: on unpatched main.py,
    active_source came straight from viewer.source_selection ("source-a")
    and this assertion fails."""
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _patch_sidecar_observed(monkeypatch, flow_id="b0ae9cba-a989-4568-ac96-8bd19272c966")  # source-b's flow_id
    client = _client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY)
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 200
    body = resp.json()
    assert body["receiver_instance"] == "mxl-videotest-view"
    assert [s["id"] for s in body["sources"]] == ["source-a", "source-b"]
    assert body["active_source"] == "source-b"
    assert body["provenance"] == "observed-flow"
    assert body["observed_at"]


def test_topology_read_unavailable_sidecar_reports_no_active_source(monkeypatch):
    """Sidecar unreachable (or not configured) -> active_source/provenance
    MUST stay None — never fall back to the catalog's own selection."""
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _patch_sidecar_unreachable(monkeypatch)
    client = _client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY)
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 200
    body = resp.json()
    assert body["active_source"] is None
    assert body["provenance"] is None
    assert body["observed_at"] is None


def test_topology_read_not_configured_reports_no_active_source(monkeypatch):
    """No netbox/media_tenancy config at all (this repo's own existing
    test default) -> same fail-closed contract, no sidecar call ever
    attempted."""
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])

    def boom(*a, **k):
        raise AssertionError("must not attempt a sidecar lookup when netbox/media_tenancy aren't configured")

    monkeypatch.setattr(media_workloads, "resolve_sidecar_target", boom)
    client = _client()
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 200
    body = resp.json()
    assert body["active_source"] is None
    assert body["provenance"] is None
    assert body["observed_at"] is None


def test_topology_read_mismatched_observed_flow_reports_no_active_source(monkeypatch):
    """Sidecar reachable and reports a flow.id, but it names NO declared
    source (a stale/foreign flow) -> still None, never a guess."""
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY])
    _patch_sidecar_observed(monkeypatch, flow_id="00000000-0000-0000-0000-000000000000")
    client = _client(netbox=SIDECAR_NETBOX, media_tenancy=SIDECAR_TENANCY)
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 200
    body = resp.json()
    assert body["active_source"] is None
    assert body["provenance"] is None
    assert body["observed_at"] is None


def test_topology_read_receiver_not_found_is_404(monkeypatch):
    _patch_catalog(monkeypatch, entries=[])
    client = _client()
    resp = client.get("/api/media-workloads/does-not-exist/topology")
    assert resp.status_code == 404
    assert resp.json()["error"] == "receiver-not-found"


def test_topology_read_receiver_without_topology_ref_is_404(monkeypatch):
    _patch_catalog(monkeypatch, entries=[NO_TOPOLOGY_ENTRY])
    client = _client()
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 404
    assert resp.json()["error"] == "receiver-not-topology"


def test_topology_read_invalid_topology_params_is_422(monkeypatch):
    _patch_catalog(monkeypatch, entries=[VIEWER_ENTRY], topology_ok=False, topology_error="schema_version must equal 1")
    client = _client()
    resp = client.get("/api/media-workloads/mxl-videotest-view/topology")
    assert resp.status_code == 422
    assert resp.json()["error"] == "topology-invalid"
