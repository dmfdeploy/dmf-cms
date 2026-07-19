"""L3 console capacity preflight — deploy-handler gate (umbrella #202 WP1).

Integration coverage for the gate wired into ``api_catalog_deploy``
(``main.py``): refusal shapes (missing-budget, no-fit, budget-unavailable),
the override path (always proceeds, still audited with the budget numbers),
strict override coercion (R2-5 — only JSON ``true``/``false``/absent are
accepted, anything else is a 400), the fit path (envelope threads into the
AWX launch extra_vars), the fail-open/fail-closed split (R2-1 —
``l3.enabled=False`` is the ONE kill switch and skips; ``prometheus``
unconfigured while enabled is a misconfiguration and REFUSES), gate
placement after the dedupe/reattach/idempotency checks in each flow so a
reattach never re-runs or re-audits a preflight (R2-7), and that a preflight
refusal after an async operation was created un-wedges it so an immediate
retry is not blocked. Teardown carries no gate at all.

``capacity.read_node_supply``/``capacity.read_ee_reserve`` are mocked
(module-level, via monkeypatch) — ``capacity.read_entry_demand`` and
``capacity.evaluate_preflight`` run for real against fixture catalog
entries, same "mock the IO, run the logic" split as test_capacity.py.
"""

import logging
import time

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
from dmf_cms import capacity
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.operations import OperationState
from dmf_cms.settings import AWXAutoscaleSettings, AWXSettings, L3Settings, PrometheusSettings, Settings

OPERATOR = ("dmf-console-operator",)
MI = 1024**2
GI = 1024**3


def _fit_supply() -> capacity.NodeSupply:
    # allocatable 3000m/6GiB, already-requested 500m/1GiB -> headroom
    # 2500m/5GiB — generous enough that a 225m/320Mi demand + a 250m/512Mi
    # EE reserve fits comfortably.
    return capacity.NodeSupply(
        node_name="n1",
        alloc_cpu_m=3000,
        alloc_mem_b=6 * GI,
        requested_cpu_m=500,
        requested_mem_b=1 * GI,
        pod_count=5,
    )


def _settings(*, l3_enabled=True, prometheus_configured=True, autoscale=False) -> Settings:
    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=OPERATOR,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=(
            AWXAutoscaleSettings(enabled=True, helper_url="http://helper.test", bearer_token="b")
            if autoscale
            else AWXAutoscaleSettings(enabled=False)
        ),
        prometheus=PrometheusSettings(url="http://prom.test") if prometheus_configured else PrometheusSettings(),
        l3=L3Settings(enabled=l3_enabled),
    )


def _client(**kwargs) -> TestClient:
    client = TestClient(create_app(settings=_settings(**kwargs)))
    client.get("/auth/login", follow_redirects=False)
    return client


FIT_ENTRY = CatalogEntry(
    key="mxl-videotestsrc",
    display_name="MXL video test source",
    summary="MXL video test source",
    provision={"resources": {"requests": {"cpu": "225m", "memory": "320Mi"}}},
    configure={"awx_job_template": "dmf-configure"},
    finalise={"awx_job_template": "dmf-finalise"},
)

OVERBUDGET_ENTRY = CatalogEntry(
    key="mxl-videotestsrc",
    display_name="MXL video test source",
    summary="MXL video test source",
    provision={"resources": {"requests": {"cpu": "9999m", "memory": "1Mi"}}},
    configure={"awx_job_template": "dmf-configure"},
    finalise={"awx_job_template": "dmf-finalise"},
)

NOBUDGET_ENTRY = CatalogEntry(
    key="mxl-videotestsrc",
    display_name="MXL video test source",
    summary="MXL video test source",
    provision={"namespace": "mxl"},  # no resources block at all
    configure={"awx_job_template": "dmf-configure"},
    finalise={"awx_job_template": "dmf-finalise"},
)


@pytest.fixture
def awx_spy(monkeypatch):
    """Spy on launch_job, recording the full kwargs of each call."""
    calls = []

    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: None)

    def fake_launch(**kwargs):
        calls.append(kwargs)
        return 4242

    monkeypatch.setattr(main, "launch_job", fake_launch)
    return calls


def _entries(entry):
    return lambda: [entry]


def _mock_budget_io(monkeypatch, *, supply, ee_reserve=(250, 512 * MI, "floor")):
    monkeypatch.setattr(capacity, "read_node_supply", lambda **k: supply)
    monkeypatch.setattr(capacity, "read_ee_reserve", lambda **k: ee_reserve)


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


def _wait_for_launch(app, op_id):
    for _ in range(50):  # 5s max
        op = app.state.operations.get(op_id)
        if op and op.state == OperationState.LAUNCHED:
            return op
        time.sleep(0.1)
    return app.state.operations.get(op_id)


# ---------------------------------------------------------------------------
# (a) over-budget entry -> 409 no-fit
# ---------------------------------------------------------------------------


def test_overbudget_entry_is_409_no_fit(monkeypatch, awx_spy, caplog):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))
    _mock_budget_io(monkeypatch, supply=_fit_supply())
    client = _client()
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "capacity-preflight-refused"
    assert body["kind"] == "no-fit"
    assert "report" in body and "ee_reserve" in body["report"]
    assert body["report"]["ee_reserve"]["source"] == "floor"
    assert awx_spy == []  # refused before any AWX call
    assert any("outcome=capacity-denied" in m for m in _audit_lines(caplog))


# ---------------------------------------------------------------------------
# (b) entry without provision.resources -> 409 missing-budget
# ---------------------------------------------------------------------------


def test_entry_without_budget_declaration_is_409_missing_budget(monkeypatch, awx_spy, caplog):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(NOBUDGET_ENTRY))
    _mock_budget_io(monkeypatch, supply=_fit_supply())
    client = _client()
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "capacity-preflight-refused"
    assert body["kind"] == "missing-budget"
    assert awx_spy == []
    assert any("outcome=capacity-denied" in m for m in _audit_lines(caplog))


# ---------------------------------------------------------------------------
# (c) fitting entry -> 202 (async), envelope in extra_vars
# ---------------------------------------------------------------------------


def test_fitting_entry_async_launches_with_envelope(monkeypatch, awx_spy):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(FIT_ENTRY))
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    _mock_budget_io(monkeypatch, supply=_fit_supply())
    with TestClient(create_app(settings=_settings(autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
        assert resp.status_code == 202, resp.text
        op = _wait_for_launch(client.app, resp.json()["operation_id"])
        assert op is not None and op.state == OperationState.LAUNCHED

    extra_vars = awx_spy[-1]["extra_vars"]
    assert extra_vars["l3_preflight_verdict"] == "fit"
    assert extra_vars["l3_request_id"]
    assert "l3_override" not in extra_vars


# ---------------------------------------------------------------------------
# (d) l3_override=true + over-budget -> launches, all four l3_* keys, audit
# ---------------------------------------------------------------------------


def test_override_over_budget_entry_launches_and_is_audited(monkeypatch, awx_spy, caplog):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))
    _mock_budget_io(monkeypatch, supply=_fit_supply())
    client = _client()
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post(
            "/api/catalog/mxl-videotestsrc/deploy",
            json={"reason": "known over-budget, accepted risk", "l3_override": True},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "launched"
    extra_vars = awx_spy[-1]["extra_vars"]
    assert extra_vars["l3_override"] is True
    assert extra_vars["l3_override_reason"] == "known over-budget, accepted risk"
    assert extra_vars["l3_preflight_verdict"] == "override"
    assert extra_vars["l3_request_id"]
    assert any("outcome=capacity-override" in m for m in _audit_lines(caplog))
    # The budget numbers ride along in the audit line (plan §3.3), not just the outcome token.
    assert any("verdict=no-fit" in m for m in _audit_lines(caplog))


# ---------------------------------------------------------------------------
# (d2) R2-5: strict l3_override coercion — only JSON true/false/absent
# ---------------------------------------------------------------------------


def test_override_string_false_is_400_invalid(monkeypatch, awx_spy, caplog):
    # A truthy-looking non-bool ("false" the STRING, not the JSON literal)
    # must never silently slip an over-budget launch past capacity refusal.
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))
    _mock_budget_io(monkeypatch, supply=_fit_supply())
    client = _client()
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post(
            "/api/catalog/mxl-videotestsrc/deploy",
            json={"reason": "x", "l3_override": "false"},
        )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"] == "invalid-l3-override"
    assert resp.json()["request_id"]
    assert awx_spy == []
    assert any("outcome=invalid-override" in m for m in _audit_lines(caplog))


@pytest.mark.parametrize("bad", [1, [], "yes", 0, {}])
def test_override_other_malformed_values_are_400_invalid(monkeypatch, awx_spy, bad):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))
    _mock_budget_io(monkeypatch, supply=_fit_supply())
    client = _client()
    resp = client.post(
        "/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x", "l3_override": bad},
    )
    assert resp.status_code == 400, bad
    assert resp.json()["error"] == "invalid-l3-override"
    assert awx_spy == []


def test_override_boolean_false_proceeds_unoverridden(monkeypatch, awx_spy):
    # JSON false is a legitimate "not overriding" — the normal (non-override)
    # flow runs, refusing on an over-budget entry exactly as if the key were
    # absent entirely.
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))
    _mock_budget_io(monkeypatch, supply=_fit_supply())
    client = _client()
    resp = client.post(
        "/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x", "l3_override": False},
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["kind"] == "no-fit"
    assert awx_spy == []


# ---------------------------------------------------------------------------
# (e) R2-1 fail-open/fail-closed split:
#     l3.enabled=False -> the ONE kill switch, skips + audited
#     l3.enabled=True but prometheus unconfigured -> misconfiguration,
#     REFUSES (409 budget-unavailable) — this is NOT a skip
# ---------------------------------------------------------------------------


def test_l3_disabled_skips_gate_audits_and_proceeds(monkeypatch, awx_spy, caplog):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))

    def boom(**k):
        raise AssertionError("capacity IO must not be called when l3.enabled is False")

    monkeypatch.setattr(capacity, "read_node_supply", boom)
    monkeypatch.setattr(capacity, "read_ee_reserve", boom)
    client = _client(l3_enabled=False)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "launched"
    extra_vars = awx_spy[-1].get("extra_vars")
    assert extra_vars is not None
    assert extra_vars["l3_preflight_verdict"] == "skipped"
    assert extra_vars["l3_request_id"]
    assert set(extra_vars.keys()) == {"l3_request_id", "l3_preflight_verdict"}
    # A disabled tier is still visible in the C5 trail (R2-1), not silently invisible.
    assert any("outcome=capacity-skipped" in m for m in _audit_lines(caplog))


def test_l3_enabled_but_prometheus_unconfigured_is_409_fail_closed(monkeypatch, awx_spy, caplog):
    # codex R2-1: NOT a skip — the console tier has exactly one seam to
    # supply data (prometheus.query()); "enabled but can't read supply"
    # must never silently pass as a no-op.
    monkeypatch.setattr(main, "load_catalog_entries", _entries(FIT_ENTRY))

    def boom(**k):
        raise AssertionError("capacity IO must not be called before the prometheus.configured check")

    monkeypatch.setattr(capacity, "read_node_supply", boom)
    monkeypatch.setattr(capacity, "read_ee_reserve", boom)
    client = _client(prometheus_configured=False)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "capacity-preflight-refused"
    assert body["kind"] == "budget-unavailable"
    assert awx_spy == []
    assert any("outcome=capacity-denied" in m for m in _audit_lines(caplog))


# ---------------------------------------------------------------------------
# (f) budget-unavailable supply -> 409 (fail-closed proof)
# ---------------------------------------------------------------------------


def test_budget_unavailable_supply_is_409_fail_closed(monkeypatch, awx_spy, caplog):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(FIT_ENTRY))
    monkeypatch.setattr(capacity, "read_node_supply", lambda **k: "budget-unavailable")
    monkeypatch.setattr(capacity, "read_ee_reserve", lambda **k: (250, 512 * MI, "floor"))
    client = _client()
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "capacity-preflight-refused"
    assert body["kind"] == "budget-unavailable"
    assert awx_spy == []
    assert any("outcome=capacity-denied" in m for m in _audit_lines(caplog))


# ---------------------------------------------------------------------------
# (g) teardown carries no capacity gate at all
# ---------------------------------------------------------------------------


def test_teardown_never_invokes_capacity_gate(monkeypatch, awx_spy):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))

    def boom(*a, **k):
        raise AssertionError("teardown must never invoke the capacity gate")

    monkeypatch.setattr(capacity, "read_entry_demand", boom)
    monkeypatch.setattr(capacity, "read_node_supply", boom)
    monkeypatch.setattr(capacity, "read_ee_reserve", boom)
    monkeypatch.setattr(capacity, "evaluate_preflight", boom)
    client = _client()
    resp = client.post("/api/catalog/mxl-videotestsrc/teardown", json={"reason": "x"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "launched"
    assert len(awx_spy) == 1


# ---------------------------------------------------------------------------
# (h) R2-7: gate placement — reattach/idempotency paths never run (or
#     re-audit) a preflight; a refusal after an op is created un-wedges it
# ---------------------------------------------------------------------------


def test_sync_reattach_to_active_job_never_runs_preflight(monkeypatch, caplog):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})
    # An active job already exists for this JT -> idempotency reattach.
    monkeypatch.setattr(main, "find_active_job_for_template", lambda **k: 999)

    def boom(*a, **k):
        raise AssertionError("preflight must not run on a reattach to an already-active job")

    monkeypatch.setattr(capacity, "read_entry_demand", boom)
    monkeypatch.setattr(capacity, "read_node_supply", boom)
    monkeypatch.setattr(capacity, "read_ee_reserve", boom)
    client = _client()
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "already-active"
    assert resp.json()["job_id"] == 999
    assert not any("outcome=capacity" in m for m in _audit_lines(caplog))


def test_async_reattach_to_existing_operation_never_runs_preflight(monkeypatch, caplog):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)

    def boom(*a, **k):
        raise AssertionError("preflight must not run on a reattach to an existing operation")

    monkeypatch.setattr(capacity, "read_entry_demand", boom)
    monkeypatch.setattr(capacity, "read_node_supply", boom)
    monkeypatch.setattr(capacity, "read_ee_reserve", boom)

    with TestClient(create_app(settings=_settings(autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        # Pre-seed an in-flight (non-terminal) operation directly, so
        # get_or_create_exclusive deterministically reattaches instead of
        # racing a real background dispatch.
        seeded = client.app.state.operations.create(action="deploy", target="mxl-videotestsrc")
        with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
            resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["operation_id"] == seeded.operation_id
    assert resp.json()["state"] == "waking"
    assert not any("outcome=capacity" in m for m in _audit_lines(caplog))


def test_async_refused_preflight_unwedges_operation_for_immediate_retry(monkeypatch):
    # codex R2-7 CRITICAL: a preflight refusal AFTER get_or_create_exclusive
    # creates the op must mark it terminal (ERROR) before returning — else a
    # wedged WAKING/LAUNCHING op blocks every subsequent deploy attempt for
    # this catalog entry (via the exclusive-lock dedupe) until TTL GC.
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))
    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    _mock_budget_io(monkeypatch, supply=_fit_supply())

    with TestClient(create_app(settings=_settings(autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)

        resp1 = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
        assert resp1.status_code == 409, resp1.text
        assert resp1.json()["kind"] == "no-fit"

        # Immediate retry: a wedged op would surface as
        # "conflict-active-operation" (no 'kind' field) instead of a fresh
        # capacity-preflight-refused — proving the un-wedge worked.
        resp2 = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp2.status_code == 409, resp2.text
    body2 = resp2.json()
    assert body2.get("error") == "capacity-preflight-refused"
    assert body2.get("kind") == "no-fit"


# ---------------------------------------------------------------------------
# (i) R3-6/R4-2: capacity.read_ee_reserve and capacity.read_node_supply must
#     be dispatched through run_in_threadpool, not called directly on the
#     event loop — on both the normal fit path and the override path.
# ---------------------------------------------------------------------------


def _threadpool_spy(monkeypatch):
    """Patch main.run_in_threadpool (the name as imported there) with a
    wrapper that records every func it's asked to dispatch, then delegates
    to the real implementation so the gate's actual behavior is unchanged.
    """
    dispatched = []
    real_run_in_threadpool = main.run_in_threadpool

    async def spy(func, *args, **kwargs):
        dispatched.append(func)
        return await real_run_in_threadpool(func, *args, **kwargs)

    monkeypatch.setattr(main, "run_in_threadpool", spy)
    return dispatched


def test_threadpool_dispatch_on_fit_path(monkeypatch, awx_spy):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(FIT_ENTRY))
    _mock_budget_io(monkeypatch, supply=_fit_supply())
    dispatched = _threadpool_spy(monkeypatch)

    client = _client()
    resp = client.post("/api/catalog/mxl-videotestsrc/deploy", json={"reason": "x"})
    assert resp.status_code == 200, resp.text
    # Must FAIL if either read regresses to a direct (non-threadpooled) call.
    assert set(dispatched) == {capacity.read_ee_reserve, capacity.read_node_supply}


def test_threadpool_dispatch_on_override_path(monkeypatch, awx_spy):
    monkeypatch.setattr(main, "load_catalog_entries", _entries(OVERBUDGET_ENTRY))
    _mock_budget_io(monkeypatch, supply=_fit_supply())
    dispatched = _threadpool_spy(monkeypatch)

    client = _client()
    resp = client.post(
        "/api/catalog/mxl-videotestsrc/deploy",
        json={"reason": "x", "l3_override": True},
    )
    assert resp.status_code == 200, resp.text
    assert set(dispatched) == {capacity.read_ee_reserve, capacity.read_node_supply}
