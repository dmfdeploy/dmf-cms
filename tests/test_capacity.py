"""L3 console capacity preflight — computation core (umbrella #202 WP1).

Pure-logic tests: quantity grammar (tolerant k8s-side vs strict catalog-side),
the EE reserve reader (whole-pod conservative sum vs floor fallback), node
supply accounting (the R2-3 conservative-overcount formula — app sum + init
sum + overhead, never a max — plus the R2-2 liveness sentinels and
fail-closed exception/malformed-row handling, and single-node enforcement),
and the evaluate/report/text shape (facility = node name, R2-8).

Prometheus and AWX are mocked via monkeypatch — no network.
"""

import logging

import pytest

from dmf_cms import awx as awx_module
from dmf_cms import capacity
from dmf_cms import prometheus as prometheus_module
from dmf_cms import settings as settings_module

MI = 1024**2
GI = 1024**3


def _exact_query_dispatcher(expr_to_rows):
    """expr_to_rows: dict mapping the EXACT PromQL expr string to its mocked
    rows. Any expr not present raises AssertionError.

    Deliberately exact-match, not substring (codex R3-1): a substring
    matcher let a wrong/missing label matcher (kube_pod_overhead_* wrongly
    filtered by node=) silently pass because the mock matched on
    "kube_pod_overhead_cpu_cores" being IN the expr regardless of what else
    was attached. Exact match means a wrong matcher can never silently pass
    again — an unrouted expr always fails loudly.
    """

    def fake_query(*, url, expr):
        if expr not in expr_to_rows:
            raise AssertionError(f"unexpected PromQL expr in test: {expr!r}")
        return expr_to_rows[expr]

    return fake_query


def _supply_exprs(node="n1"):
    """The exact PromQL expr strings capacity.py sends for a given node."""
    return {
        "alloc_cpu": 'kube_node_status_allocatable{resource="cpu",unit="core"}',
        "alloc_mem": 'kube_node_status_allocatable{resource="memory",unit="byte"}',
        "pod_info": f'kube_pod_info{{node="{node}"}}',
        "phase": 'kube_pod_status_phase{phase=~"Running|Pending"} == 1',
        "app_cpu": f'sum by (namespace,pod) (kube_pod_container_resource_requests{{node="{node}",resource="cpu"}})',
        "app_mem": f'sum by (namespace,pod) (kube_pod_container_resource_requests{{node="{node}",resource="memory"}})',
        "init_cpu": f'kube_pod_init_container_resource_requests{{node="{node}",resource="cpu"}}',
        "init_mem": f'kube_pod_init_container_resource_requests{{node="{node}",resource="memory"}}',
        # R3-1: no node matcher — this metric family carries no node label.
        "overhead_cpu": "kube_pod_overhead_cpu_cores",
        "overhead_mem": "kube_pod_overhead_memory_bytes",
    }


def _supply_routes(
    *,
    node="n1",
    alloc_cpu="3",
    alloc_mem=6 * GI,
    pod_info=(),
    phase=(),
    app_cpu=(),
    app_mem=(),
    init_cpu=(),
    init_mem=(),
    overhead_cpu=(),
    overhead_mem=(),
):
    """Build a full expr->rows route dict for read_node_supply, defaulting
    every optional family to empty so a test only spells out what it needs."""
    e = _supply_exprs(node)
    return {
        e["alloc_cpu"]: [_metric_row(alloc_cpu, node=node)],
        e["alloc_mem"]: [_metric_row(alloc_mem, node=node)],
        e["pod_info"]: list(pod_info),
        e["phase"]: list(phase),
        e["app_cpu"]: list(app_cpu),
        e["app_mem"]: list(app_mem),
        e["init_cpu"]: list(init_cpu),
        e["init_mem"]: list(init_mem),
        e["overhead_cpu"]: list(overhead_cpu),
        e["overhead_mem"]: list(overhead_mem),
    }


def _metric_row(value, **labels):
    return {"metric": labels, "value": [0, str(value)]}


# ---------------------------------------------------------------------------
# Quantity grammar
# ---------------------------------------------------------------------------


def test_catalog_parsers_accept_canonical_forms():
    assert capacity.parse_catalog_cpu("225m") == 225
    assert capacity.parse_catalog_memory("320Mi") == 320 * MI


def test_catalog_cpu_refuses_bare_integer_with_forgotten_m_hint():
    with pytest.raises(capacity.QuantityError, match="did you mean '225m'"):
        capacity.parse_catalog_cpu("225")


def test_catalog_parsers_refuse_zero():
    with pytest.raises(capacity.QuantityError):
        capacity.parse_catalog_cpu("0m")
    with pytest.raises(capacity.QuantityError):
        capacity.parse_catalog_memory("0Mi")


def test_catalog_parsers_refuse_decimals_and_other_units():
    with pytest.raises(capacity.QuantityError):
        capacity.parse_catalog_cpu("225.5m")
    with pytest.raises(capacity.QuantityError):
        capacity.parse_catalog_memory("320M")  # decimal unit, not binary


def test_tolerant_cpu_parser_accepts_bare_and_decimal_cores():
    assert capacity.parse_cpu_millicores("0.5") == 500
    assert capacity.parse_cpu_millicores("2") == 2000
    assert capacity.parse_cpu_millicores("250m") == 250


def test_tolerant_memory_parser_accepts_bare_bytes():
    assert capacity.parse_memory_bytes("134217728") == 134217728
    assert capacity.parse_memory_bytes("512Mi") == 512 * MI


def test_tolerant_parsers_refuse_garbage():
    with pytest.raises(capacity.QuantityError):
        capacity.parse_cpu_millicores("lots")
    with pytest.raises(capacity.QuantityError):
        capacity.parse_memory_bytes("lots")


# ---------------------------------------------------------------------------
# Demand — read_entry_demand
# ---------------------------------------------------------------------------


def test_read_entry_demand_missing_block_is_missing_budget():
    demand, reason = capacity.read_entry_demand({"namespace": "mxl"})
    assert demand is None
    assert reason == "missing-budget"


def test_read_entry_demand_none_provision_is_missing_budget():
    demand, reason = capacity.read_entry_demand(None)
    assert demand is None
    assert reason == "missing-budget"


def test_read_entry_demand_invalid_is_invalid_budget():
    demand, reason = capacity.read_entry_demand(
        {"resources": {"requests": {"cpu": "225", "memory": "320Mi"}}}
    )
    assert demand is None
    assert reason.startswith("invalid-budget:")


def test_read_entry_demand_declared_parses():
    demand, reason = capacity.read_entry_demand(
        {"resources": {"requests": {"cpu": "225m", "memory": "320Mi"}}}
    )
    assert reason is None
    assert demand == (225, 320 * MI)


def test_read_entry_demand_malformed_resources_layer_is_invalid_budget_not_500():
    # codex R2-6: every layer is type-checked before being indexed/.get()'d —
    # a structurally malformed provision block (resources as a list, not a
    # mapping) must be a clean invalid-budget refusal, never an unhandled
    # AttributeError that would surface as a 500 at the handler.
    demand, reason = capacity.read_entry_demand({"resources": [1]})
    assert demand is None
    assert reason.startswith("invalid-budget:")

    demand, reason = capacity.read_entry_demand(
        {"resources": {"requests": [1]}}
    )
    assert demand is None
    assert reason.startswith("invalid-budget:")


# ---------------------------------------------------------------------------
# EE reserve
# ---------------------------------------------------------------------------


def _ee_kwargs(**overrides):
    kwargs = dict(api_url="http://awx.test", api_token="tok", ssl_verify=False, floor_cpu_m=250, floor_mem_b=512 * MI)
    kwargs.update(overrides)
    return kwargs


def test_ee_reserve_declared(monkeypatch):
    pod_spec = (
        "spec:\n"
        "  containers:\n"
        "    - name: worker\n"
        "      resources:\n"
        "        requests:\n"
        "          cpu: \"250m\"\n"
        "          memory: \"512Mi\"\n"
    )
    monkeypatch.setattr(awx_module, "get_instance_group_pod_spec", lambda **kw: pod_spec)
    cpu_m, mem_b, source = capacity.read_ee_reserve(**_ee_kwargs())
    assert (cpu_m, mem_b, source) == (250, 512 * MI, "cg-declared")


def test_ee_reserve_cg_missing_is_floor(monkeypatch):
    monkeypatch.setattr(awx_module, "get_instance_group_pod_spec", lambda **kw: None)
    cpu_m, mem_b, source = capacity.read_ee_reserve(**_ee_kwargs())
    assert (cpu_m, mem_b, source) == (250, 512 * MI, "floor")


def test_ee_reserve_worker_without_requests_is_floor(monkeypatch):
    pod_spec = "spec:\n  containers:\n    - name: worker\n      image: foo\n"
    monkeypatch.setattr(awx_module, "get_instance_group_pod_spec", lambda **kw: pod_spec)
    cpu_m, mem_b, source = capacity.read_ee_reserve(**_ee_kwargs())
    assert (cpu_m, mem_b, source) == (250, 512 * MI, "floor")


def test_ee_reserve_sums_across_all_containers_not_worker_only(monkeypatch):
    # codex R2-4: a worker-only read undercounts — the whole pod's
    # scheduler-effective demand sums EVERY container's declared requests.
    # sidecar 10m/16Mi + worker 400m/768Mi = 410m/784Mi, not just 400m/768Mi.
    # JSON is also valid YAML — PyYAML handles both (§3.2 note).
    pod_spec = (
        '{"spec": {"containers": ['
        '{"name": "sidecar", "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}}}, '
        '{"name": "worker", "resources": {"requests": {"cpu": "400m", "memory": "768Mi"}}}'
        "]}}"
    )
    monkeypatch.setattr(awx_module, "get_instance_group_pod_spec", lambda **kw: pod_spec)
    cpu_m, mem_b, source = capacity.read_ee_reserve(**_ee_kwargs())
    assert (cpu_m, mem_b, source) == (410, 784 * MI, "cg-declared")


def test_ee_reserve_missing_requests_on_one_container_sums_the_rest(monkeypatch):
    # "Missing requests on SOME container -> sum what's declared" (R2-4): a
    # sidecar with no resources block at all contributes 0, not an error —
    # the worker's real declared value still flows through correctly.
    pod_spec = (
        "spec:\n"
        "  containers:\n"
        "    - name: sidecar\n"
        "      image: alpine\n"
        "    - name: worker\n"
        "      resources:\n"
        "        requests:\n"
        "          cpu: \"300m\"\n"
        "          memory: \"600Mi\"\n"
    )
    monkeypatch.setattr(awx_module, "get_instance_group_pod_spec", lambda **kw: pod_spec)
    cpu_m, mem_b, source = capacity.read_ee_reserve(**_ee_kwargs(floor_cpu_m=250, floor_mem_b=512 * MI))
    assert (cpu_m, mem_b, source) == (300, 600 * MI, "cg-declared")


def test_ee_reserve_init_and_overhead_are_summed_in(monkeypatch):
    # Conservative whole-pod sum (R2-4) also covers initContainers + overhead.
    pod_spec = (
        "spec:\n"
        "  containers:\n"
        "    - name: worker\n"
        "      resources:\n"
        "        requests: {cpu: \"100m\", memory: \"100Mi\"}\n"
        "  initContainers:\n"
        "    - name: init-a\n"
        "      resources:\n"
        "        requests: {cpu: \"50m\", memory: \"50Mi\"}\n"
        "  overhead:\n"
        "    cpu: \"10m\"\n"
        "    memory: \"10Mi\"\n"
    )
    monkeypatch.setattr(awx_module, "get_instance_group_pod_spec", lambda **kw: pod_spec)
    cpu_m, mem_b, source = capacity.read_ee_reserve(**_ee_kwargs(floor_cpu_m=1, floor_mem_b=1))
    assert (cpu_m, mem_b, source) == (160, 160 * MI, "cg-declared")


def test_ee_reserve_uses_floor_when_declared_sum_is_lower(monkeypatch):
    pod_spec = (
        "spec:\n"
        "  containers:\n"
        "    - name: worker\n"
        "      resources:\n"
        "        requests: {cpu: \"10m\", memory: \"16Mi\"}\n"
    )
    monkeypatch.setattr(awx_module, "get_instance_group_pod_spec", lambda **kw: pod_spec)
    cpu_m, mem_b, source = capacity.read_ee_reserve(**_ee_kwargs(floor_cpu_m=250, floor_mem_b=512 * MI))
    assert (cpu_m, mem_b, source) == (250, 512 * MI, "floor")


def test_ee_reserve_zero_request_is_floor(monkeypatch):
    pod_spec = (
        "spec:\n"
        "  containers:\n"
        "    - name: worker\n"
        "      resources:\n"
        "        requests:\n"
        "          cpu: \"0m\"\n"
        "          memory: \"512Mi\"\n"
    )
    monkeypatch.setattr(awx_module, "get_instance_group_pod_spec", lambda **kw: pod_spec)
    cpu_m, mem_b, source = capacity.read_ee_reserve(**_ee_kwargs())
    assert (cpu_m, mem_b, source) == (250, 512 * MI, "floor")


def test_ee_reserve_exception_is_floor(monkeypatch):
    def boom(**kw):
        raise RuntimeError("network exploded")

    monkeypatch.setattr(awx_module, "get_instance_group_pod_spec", boom)
    cpu_m, mem_b, source = capacity.read_ee_reserve(**_ee_kwargs())
    assert (cpu_m, mem_b, source) == (250, 512 * MI, "floor")


# ---------------------------------------------------------------------------
# Supply
# ---------------------------------------------------------------------------


def test_supply_happy_path_excludes_succeeded(monkeypatch):
    # kube_pod_info persists for Succeeded pods until GC — all three are
    # bound-to-node. The phase-filtered query is what actually excludes
    # podC (its real phase is Succeeded, never matches Running|Pending).
    routes = _supply_routes(
        pod_info=[
            _metric_row(1, namespace="ns1", pod="podA"),
            _metric_row(1, namespace="ns1", pod="podB"),
            _metric_row(1, namespace="ns1", pod="podC"),
        ],
        phase=[
            _metric_row(1, namespace="ns1", pod="podA"),
            _metric_row(1, namespace="ns1", pod="podB"),
        ],
        app_cpu=[
            _metric_row("0.1", namespace="ns1", pod="podA"),
            _metric_row("0.05", namespace="ns1", pod="podB"),
            _metric_row("0.2", namespace="ns1", pod="podC"),
        ],
        app_mem=[
            _metric_row(128 * MI, namespace="ns1", pod="podA"),
            _metric_row(64 * MI, namespace="ns1", pod="podB"),
            _metric_row(256 * MI, namespace="ns1", pod="podC"),
        ],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))

    supply = capacity.read_node_supply(prom_url="http://prom.test")
    assert isinstance(supply, capacity.NodeSupply)
    assert supply.node_name == "n1"
    assert supply.alloc_cpu_m == 3000
    assert supply.alloc_mem_b == 6 * GI
    assert supply.requested_cpu_m == 150  # podA 100 + podB 50, podC excluded
    assert supply.requested_mem_b == 192 * MI  # 128 + 64
    assert supply.pod_count == 2


def test_supply_init_sum_added_conservatively(monkeypatch):
    # codex R2-3a: demand_pod = app_sum + init_sum(+overhead) — a
    # CONSERVATIVE OVERCOUNT, never the scheduler's own max formula (KSM
    # can't distinguish restartable sidecars, cumulative, from sequential
    # inits, max-of-any-single). app=100m, inits=[200m,300m] -> 100+500=600m.
    # This must fail against BOTH a max-only implementation (300m) and a
    # bare app-sum implementation (100m).
    routes = _supply_routes(
        pod_info=[_metric_row(1, namespace="ns1", pod="podD")],
        phase=[_metric_row(1, namespace="ns1", pod="podD")],
        app_cpu=[_metric_row("0.1", namespace="ns1", pod="podD")],
        app_mem=[_metric_row(50 * MI, namespace="ns1", pod="podD")],
        init_cpu=[
            _metric_row("0.2", namespace="ns1", pod="podD", container="init-a"),
            _metric_row("0.3", namespace="ns1", pod="podD", container="init-b"),
        ],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))

    supply = capacity.read_node_supply(prom_url="http://prom.test")
    assert isinstance(supply, capacity.NodeSupply)
    assert supply.requested_cpu_m == 600


def test_supply_overhead_has_no_node_label_and_is_filtered_to_eligible(monkeypatch):
    # codex R3-1: kube_pod_overhead_* carries namespace/pod/uid but NO node
    # label — query bare (no matcher) and filter client-side to the eligible
    # set, so a same-named-metric row for an INELIGIBLE pod never leaks in.
    # app=100m + overhead 20m/10Mi (podE, eligible) -> 120m/60Mi; a second
    # overhead row for podF (no pod_info/phase entry — not eligible) must be
    # excluded entirely from the sum.
    routes = _supply_routes(
        pod_info=[_metric_row(1, namespace="ns1", pod="podE")],
        phase=[_metric_row(1, namespace="ns1", pod="podE")],
        app_cpu=[_metric_row("0.1", namespace="ns1", pod="podE")],
        app_mem=[_metric_row(50 * MI, namespace="ns1", pod="podE")],
        overhead_cpu=[
            _metric_row("0.02", namespace="ns1", pod="podE"),
            _metric_row("0.5", namespace="ns1", pod="podF"),  # not eligible
        ],
        overhead_mem=[
            _metric_row(10 * MI, namespace="ns1", pod="podE"),
            _metric_row(5 * GI, namespace="ns1", pod="podF"),
        ],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))

    supply = capacity.read_node_supply(prom_url="http://prom.test")
    assert isinstance(supply, capacity.NodeSupply)
    assert supply.requested_cpu_m == 120  # 100 + 20; podF's 500m excluded
    assert supply.requested_mem_b == 60 * MI  # 50Mi + 10Mi; podF's 5Gi excluded


def test_supply_demand_for_pod_absent_from_pod_info_is_excluded(monkeypatch):
    # A Pending pod not yet bound to THIS node (no kube_pod_info row here) is
    # unschedulable-elsewhere and must not be charged to this node's budget,
    # even though it has a phase row and (implausibly, but defensively
    # tested) request-family rows.
    routes = _supply_routes(
        pod_info=[_metric_row(1, namespace="ns1", pod="podBound")],  # podPending absent
        phase=[
            _metric_row(1, namespace="ns1", pod="podBound"),
            _metric_row(1, namespace="ns1", pod="podPending"),
        ],
        app_cpu=[
            _metric_row("0.1", namespace="ns1", pod="podBound"),
            _metric_row("5.0", namespace="ns1", pod="podPending"),
        ],
        app_mem=[
            _metric_row(50 * MI, namespace="ns1", pod="podBound"),
            _metric_row(5 * GI, namespace="ns1", pod="podPending"),
        ],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))

    supply = capacity.read_node_supply(prom_url="http://prom.test")
    assert isinstance(supply, capacity.NodeSupply)
    assert supply.requested_cpu_m == 100  # podBound only
    assert supply.requested_mem_b == 50 * MI
    assert supply.pod_count == 1


def test_supply_disjoint_pod_info_and_phase_is_budget_unavailable(monkeypatch):
    # codex R3-2: pod_info and phase are both non-empty individually but
    # talk about DIFFERENT pods -> eligible = pod_info ∩ phase is empty. A
    # live single node always has kube-system pods in that intersection; an
    # empty result here is a KSM scrape-consistency problem, never "zero
    # demand, fits everything".
    routes = _supply_routes(
        pod_info=[_metric_row(1, namespace="ns1", pod="podA")],
        phase=[_metric_row(1, namespace="ns1", pod="podB")],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


def test_supply_no_data_is_budget_unavailable(monkeypatch):
    e = _supply_exprs()
    routes = {e["alloc_cpu"]: [], e["alloc_mem"]: []}
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


def test_supply_empty_pod_info_is_budget_unavailable_even_with_valid_allocatable(monkeypatch):
    # codex R2-2c: kills the false-FIT — valid allocatable data alone must
    # NOT be treated as "empty node, nothing running, plenty of headroom".
    # An empty kube_pod_info means KSM itself is unscraped, not a genuinely
    # idle node (a live node always runs at least kube-system pods).
    routes = _supply_routes(
        pod_info=[],
        phase=[_metric_row(1, namespace="kube-system", pod="coredns-x")],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


def test_supply_empty_phase_is_budget_unavailable(monkeypatch):
    routes = _supply_routes(
        pod_info=[_metric_row(1, namespace="kube-system", pod="coredns-x")],
        phase=[],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


def test_supply_prometheus_error_is_budget_unavailable(monkeypatch):
    def boom(*, url, expr):
        raise prometheus_module.PrometheusAPIError(500, "boom")

    monkeypatch.setattr(prometheus_module, "query", boom)
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


def test_supply_bare_exception_is_budget_unavailable(monkeypatch):
    # codex R2-2a: the fail-closed boundary catches ANY exception, not just
    # PrometheusAPIError — a bare transport-level TimeoutError must collapse
    # to the same refusal, never propagate as a raw 500.
    def boom(*, url, expr):
        raise TimeoutError("read timed out")

    monkeypatch.setattr(prometheus_module, "query", boom)
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


def test_supply_malformed_row_is_budget_unavailable(monkeypatch):
    # codex R2-2b: a row missing an expected label must abort the whole
    # read, never be silently dropped (silent partial data understates
    # existing demand and risks a false FIT).
    routes = _supply_routes(
        pod_info=[_metric_row(1, namespace="ns1", pod="podA")],
        phase=[{"metric": {"namespace": "ns1"}, "value": [0, "1"]}],  # missing 'pod' label
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


def test_supply_pod_info_nan_value_is_budget_unavailable_not_pod_count_1(monkeypatch):
    # codex R5-1 exact repro: pod_info value=NaN (phase value=1, valid)
    # previously still counted as bound-to-node — the sentinel key set was
    # built from metric LABELS only, the value was never checked at all.
    routes = _supply_routes(
        pod_info=[_metric_row("NaN", namespace="ns1", pod="podA")],
        phase=[_metric_row(1, namespace="ns1", pod="podA")],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


@pytest.mark.parametrize("bad_value", [0, -1])
def test_supply_pod_info_non_positive_value_is_budget_unavailable(monkeypatch, bad_value):
    routes = _supply_routes(
        pod_info=[_metric_row(bad_value, namespace="ns1", pod="podA")],
        phase=[_metric_row(1, namespace="ns1", pod="podA")],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable", bad_value


def test_supply_phase_zero_value_is_budget_unavailable(monkeypatch):
    # With the phase query's own `== 1` server-side filter, a RETURNED row
    # can never legitimately be anything but 1 — a 0 value here is itself a
    # malformed-row signal (post-filter, not a real "not running" case).
    routes = _supply_routes(
        pod_info=[_metric_row(1, namespace="ns1", pod="podA")],
        phase=[_metric_row(0, namespace="ns1", pod="podA")],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


def test_supply_phase_expr_carries_equals_one_filter():
    # codex R5-1c: the discriminating mock must enforce the == 1 form —
    # pins the exact expr string the exact-match dispatcher keys on.
    assert _supply_exprs()["phase"].endswith(" == 1")


def test_supply_two_nodes_is_multi_node_unsupported(monkeypatch):
    e = _supply_exprs()
    routes = {
        e["alloc_cpu"]: [_metric_row("3", node="n1"), _metric_row("4", node="n2")],
        e["alloc_mem"]: [_metric_row(6 * GI, node="n1"), _metric_row(8 * GI, node="n2")],
    }
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "multi-node-unsupported"


def test_supply_mismatched_allocatable_keysets_is_budget_unavailable(monkeypatch):
    # codex R3-4: cpu reports {n1,n2}, memory reports only {n1} -> the
    # keysets differ. Must NOT silently narrow to the intersection ({n1})
    # and return a clean NodeSupply for n1 — that would treat a
    # data-integrity problem as an ordinary single-node read.
    e = _supply_exprs()
    routes = {
        e["alloc_cpu"]: [_metric_row("3", node="n1"), _metric_row("4", node="n2")],
        e["alloc_mem"]: [_metric_row(6 * GI, node="n1")],
    }
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


def test_supply_negative_app_demand_no_longer_increases_headroom(monkeypatch):
    # codex R4-1 exact live repro: an eligible pod reporting app cpu=-1 core
    # / memory=-1048576 bytes previously SUBTRACTED from already-requested
    # (requested_cpu_m=-1000), silently INCREASING headroom instead of
    # refusing. A metric value can never legitimately be negative.
    routes = _supply_routes(
        pod_info=[_metric_row(1, namespace="ns1", pod="podA")],
        phase=[_metric_row(1, namespace="ns1", pod="podA")],
        app_cpu=[_metric_row("-1", namespace="ns1", pod="podA")],
        app_mem=[_metric_row(-1048576, namespace="ns1", pod="podA")],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


@pytest.mark.parametrize("family", ["app", "init", "overhead"])
def test_supply_negative_value_in_any_demand_family_is_budget_unavailable(monkeypatch, family):
    kwargs = dict(
        pod_info=[_metric_row(1, namespace="ns1", pod="podA")],
        phase=[_metric_row(1, namespace="ns1", pod="podA")],
        app_cpu=[_metric_row("0.1", namespace="ns1", pod="podA")],
    )
    if family == "app":
        kwargs["app_cpu"] = [_metric_row("-1", namespace="ns1", pod="podA")]
    elif family == "init":
        kwargs["init_cpu"] = [_metric_row("-1", namespace="ns1", pod="podA")]
    else:
        kwargs["overhead_cpu"] = [_metric_row("-1", namespace="ns1", pod="podA")]
    routes = _supply_routes(**kwargs)
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable", family


def test_supply_nan_value_is_budget_unavailable(monkeypatch):
    routes = _supply_routes(
        pod_info=[_metric_row(1, namespace="ns1", pod="podA")],
        phase=[_metric_row(1, namespace="ns1", pod="podA")],
        app_cpu=[_metric_row("NaN", namespace="ns1", pod="podA")],
    )
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable"


@pytest.mark.parametrize("zero_cpu,zero_mem", [(True, False), (False, True)])
def test_supply_zero_allocatable_is_budget_unavailable(monkeypatch, zero_cpu, zero_mem):
    # codex R4-1: allocatable must be strictly positive, not merely
    # non-negative — a node with 0 allocatable cpu/mem can't run anything.
    e = _supply_exprs()
    routes = {
        e["alloc_cpu"]: [_metric_row("0" if zero_cpu else "3", node="n1")],
        e["alloc_mem"]: [_metric_row(0 if zero_mem else 6 * GI, node="n1")],
    }
    monkeypatch.setattr(prometheus_module, "query", _exact_query_dispatcher(routes))
    assert capacity.read_node_supply(prom_url="http://prom.test") == "budget-unavailable", (zero_cpu, zero_mem)


# ---------------------------------------------------------------------------
# Evaluate
# ---------------------------------------------------------------------------


def _supply(alloc_cpu_m=3000, alloc_mem_b=6 * GI, requested_cpu_m=1000, requested_mem_b=2 * GI, pod_count=5):
    return capacity.NodeSupply(
        node_name="n1",
        alloc_cpu_m=alloc_cpu_m,
        alloc_mem_b=alloc_mem_b,
        requested_cpu_m=requested_cpu_m,
        requested_mem_b=requested_mem_b,
        pod_count=pod_count,
    )


def test_evaluate_fit():
    result = capacity.evaluate_preflight(
        demand_items=[("mxl-videotestsrc", 225, 320 * MI), ("mxl-videotest-view", 175, 256 * MI)],
        ee_reserve=(250, 512 * MI, "cg-declared"),
        supply=_supply(),
    )
    assert result.verdict == "fit"
    assert result.shortfall_cpu_m == 0
    assert result.shortfall_mem_b == 0
    assert result.report["ee_reserve"] == {"cpu_m": 250, "mem_b": 512 * MI, "source": "cg-declared"}
    # codex R2-8: facility is always the node display name, not the catalog
    # key — the catalog entry lives only in the demand line items.
    assert result.report["facility"] == "n1"


def test_evaluate_cpu_only_breach():
    result = capacity.evaluate_preflight(
        demand_items=[("mxl-videotestsrc", 2500, 100 * MI)],
        ee_reserve=(250, 100 * MI, "floor"),
        supply=_supply(alloc_cpu_m=3000, requested_cpu_m=1000, alloc_mem_b=100 * GI, requested_mem_b=1 * MI),
    )
    assert result.verdict == "no-fit"
    assert result.shortfall_cpu_m > 0
    assert result.shortfall_mem_b == 0
    assert "CPU short by" in result.text
    assert "MEM short by" not in result.text


def test_evaluate_memory_only_breach():
    result = capacity.evaluate_preflight(
        demand_items=[("mxl-videotestsrc", 10, 5 * GI)],
        ee_reserve=(10, 1 * MI, "floor"),
        supply=_supply(alloc_cpu_m=100_000, requested_cpu_m=1, alloc_mem_b=6 * GI, requested_mem_b=2 * GI),
    )
    assert result.verdict == "no-fit"
    assert result.shortfall_mem_b > 0
    assert result.shortfall_cpu_m == 0
    assert "MEM short by" in result.text
    assert "CPU short by" not in result.text


def test_evaluate_both_breach():
    result = capacity.evaluate_preflight(
        demand_items=[("mxl-videotestsrc", 2500, 5 * GI)],
        ee_reserve=(250, 512 * MI, "floor"),
        supply=_supply(alloc_cpu_m=3000, requested_cpu_m=1000, alloc_mem_b=6 * GI, requested_mem_b=2 * GI),
    )
    assert result.verdict == "no-fit"
    assert result.shortfall_cpu_m > 0
    assert result.shortfall_mem_b > 0
    assert "CPU short by" in result.text
    assert "MEM short by" in result.text


def test_evaluate_report_and_text_shape():
    result = capacity.evaluate_preflight(
        demand_items=[("mxl-videotestsrc", 2500, 5 * GI)],
        ee_reserve=(250, 512 * MI, "floor"),
        supply=_supply(alloc_cpu_m=3000, requested_cpu_m=1000, alloc_mem_b=6 * GI, requested_mem_b=2 * GI),
    )
    assert "short by" in result.text
    assert "override" in result.text
    assert "finalise" in result.text
    assert "AWX EE job pod" in result.text
    assert result.report["verdict"] == "no-fit"


# ---------------------------------------------------------------------------
# Settings — L3 kill switch strict tri-state parser (codex R3-3)
# ---------------------------------------------------------------------------


def test_l3_enabled_env_unset_defaults_true(monkeypatch):
    monkeypatch.delenv("DMF_CONSOLE_L3_ENABLED", raising=False)
    assert settings_module._env_l3_enabled("DMF_CONSOLE_L3_ENABLED") is True


def test_l3_enabled_env_false_tokens_disable(monkeypatch):
    for token in ["false", "FALSE", "0", "no", "NO"]:
        monkeypatch.setenv("DMF_CONSOLE_L3_ENABLED", token)
        assert settings_module._env_l3_enabled("DMF_CONSOLE_L3_ENABLED") is False, token


def test_l3_enabled_env_true_tokens_enable(monkeypatch):
    for token in ["true", "TRUE", "1", "yes", "YES"]:
        monkeypatch.setenv("DMF_CONSOLE_L3_ENABLED", token)
        assert settings_module._env_l3_enabled("DMF_CONSOLE_L3_ENABLED") is True, token


def test_l3_enabled_env_typo_fails_safe_on_with_warning(monkeypatch, caplog):
    # codex R3-3's exact repro: 'tru' (a typo for 'true') must NOT silently
    # disable the kill switch the way the generic _env_bool would (that
    # helper treats any unrecognized token as False).
    monkeypatch.setenv("DMF_CONSOLE_L3_ENABLED", "tru")
    with caplog.at_level(logging.WARNING, logger="dmf_cms.settings"):
        result = settings_module._env_l3_enabled("DMF_CONSOLE_L3_ENABLED")
    assert result is True
    assert any("tru" in r.getMessage() for r in caplog.records)
