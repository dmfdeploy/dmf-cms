"""L3 console capacity preflight — computation core (umbrella #202 WP1).

Pure logic plus two read-only IO helpers. The console has NO Kubernetes
client (pyproject.toml deps are fastapi/itsdangerous/PyYAML/uvicorn); the
only seams to cluster/AWX state are ``prometheus.query()`` (already in
production use for the media-workloads panels) and the AWX REST API via
``awx.py``'s existing request helper. This module must stay that way — no
new HTTP calls of its own, no k8s client.

Quantity grammar comes in two strictnesses:

* The TOLERANT parsers (``parse_cpu_millicores``, ``parse_memory_bytes``)
  read values that originate from Kubernetes itself — kube-state-metrics
  series, the AWX Container Group's declared worker resources. KSM reports
  cpu as float cores and memory as float bytes, and a container's own
  ``resources.requests`` may legally use bare whole-core cpu — all of that
  is legitimate input here.
* The CATALOG parsers (``parse_catalog_cpu``, ``parse_catalog_memory``) read
  the dmf-media catalog's authored ``provision.resources.requests`` — our
  own contract, not something Kubernetes handed us. They mirror dmf-media's
  ``bin/check-catalog-demand.py`` grammar: cpu must be explicit whole
  millicores with an ``m`` suffix (a bare integer is refused as a likely
  forgotten ``m``, not accepted as whole cores), memory must be whole binary
  Ki/Mi/Gi. Fail-closed on both sides; a quantity that parses to zero is
  refused everywhere, since zero can never be a real workload demand.

Node supply accounting (§3.2, revised codex WP1 R2 round — "conservative
overcount", not the scheduler's own max formula): per-pod demand =
app-container sum + init-container sum + pod overhead (when present).
kube-state-metrics cannot distinguish a *sequential* init container (real
scheduler accounting: max of any single init request vs the app sum) from a
*restartable* (sidecar) init container (real scheduler accounting:
cumulative, alongside the app containers) — the metric
``kube_pod_init_container_resource_requests`` carries no such flag. Rather
than guess which formula applies to a given container, this module always
takes the sum of BOTH families. Summing instead of taking either specific
formula can only overcount relative to the true scheduler figure, and an
overcount biases toward refusal (fail-closed) — the safe direction for a
capacity gate. The launcher tier (WP3) reads live pod specs in-cluster and
can apply the scheduler-accurate per-container formula there; this tier
cannot, and does not pretend to.

Every Prometheus read this module makes is wrapped in a single fail-closed
boundary (see ``read_node_supply``): ANY exception — a
``PrometheusAPIError``, a bare transport exception (timeout, connection
reset, ...), or a malformed row (missing labels, unparseable value) —
collapses to the ``'budget-unavailable'`` refusal. No data, or data that
doesn't parse, is never silently treated as "no demand" / "fits" — that
would be a false FIT. Two liveness sentinels (``kube_pod_info`` — the
authoritative per-node bound-pod join — and ``kube_pod_status_phase``) must
both return non-empty results too: a live node always runs at least the
kube-system pods, so an empty result here means kube-state-metrics itself
is down or unscraped, not an genuinely-empty node.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import yaml

from . import awx
from . import prometheus


class QuantityError(Exception):
    """Raised when a resource quantity string cannot be parsed."""


class _MultiNodeSupply(Exception):
    """Internal signal: more than one node reports allocatable (not fail-closed)."""


_CPU_MILLI_RE = re.compile(r"^[0-9]+m$")
_CPU_CORE_RE = re.compile(r"^[0-9]+(\.[0-9]+)?$")
_MEM_BARE_RE = re.compile(r"^[0-9]+(\.[0-9]+)?$")
_CATALOG_MEM_RE = re.compile(r"^[0-9]+(Ki|Mi|Gi)$")

_MEM_UNITS = {
    "Ki": 1024,
    "Mi": 1024**2,
    "Gi": 1024**3,
    "K": 1000,
    "M": 1000**2,
    "G": 1000**3,
}


# ---------------------------------------------------------------------------
# Quantity parsing
# ---------------------------------------------------------------------------


def parse_cpu_millicores(value) -> int:
    """Tolerant k8s-side cpu parser: '250m', or bare/decimal cores ('2', '0.5')."""
    s = str(value).strip()
    if _CPU_MILLI_RE.match(s):
        n = int(s[:-1])
    elif _CPU_CORE_RE.match(s):
        n = int(float(s) * 1000)
    else:
        raise QuantityError(
            f"cpu quantity {value!r} is not a recognized form — expected "
            "whole millicores ('123m') or whole/decimal cores ('1', '0.5')"
        )
    if n <= 0:
        raise QuantityError(f"cpu quantity {value!r} must be > 0")
    return n


def parse_memory_bytes(value) -> int:
    """Tolerant k8s-side memory parser: unit-suffixed or bare (possibly float) bytes."""
    s = str(value).strip()
    n = None
    for suffix, mult in _MEM_UNITS.items():
        if s.endswith(suffix):
            num = s[: -len(suffix)]
            if re.match(r"^[0-9]+$", num):
                n = int(num) * mult
            break
    if n is None and _MEM_BARE_RE.match(s):
        n = int(float(s))
    if n is None:
        raise QuantityError(
            f"memory quantity {value!r} is not a recognized form — expected "
            "Ki/Mi/Gi/K/M/G-suffixed or bare (possibly decimal) bytes"
        )
    if n <= 0:
        raise QuantityError(f"memory quantity {value!r} must be > 0")
    return n


def parse_catalog_cpu(value) -> int:
    """Strict catalog-side cpu parser: only explicit whole millicores ('225m')."""
    s = str(value).strip()
    if not _CPU_MILLI_RE.match(s):
        hint = f" — did you mean '{s}m'?" if re.match(r"^[0-9]+$", s) else ""
        raise QuantityError(
            f"cpu quantity {value!r} is not accepted catalog grammar — the "
            "catalog must declare explicit whole millicores with the 'm' "
            f"suffix (e.g. '225m'); bare integers are refused{hint}"
        )
    n = int(s[:-1])
    if n <= 0:
        raise QuantityError(f"cpu quantity {value!r} must be > 0")
    return n


def parse_catalog_memory(value) -> int:
    """Strict catalog-side memory parser: only whole binary Ki/Mi/Gi ('320Mi')."""
    s = str(value).strip()
    if not _CATALOG_MEM_RE.match(s):
        raise QuantityError(
            f"memory quantity {value!r} is not accepted catalog grammar — "
            "only whole binary Ki/Mi/Gi ('320Mi') are allowed"
        )
    suffix = s[-2:]
    n = int(s[:-2]) * _MEM_UNITS[suffix]
    if n <= 0:
        raise QuantityError(f"memory quantity {value!r} must be > 0")
    return n


# ---------------------------------------------------------------------------
# Demand — §3.2(a) fail-closed catalog read
# ---------------------------------------------------------------------------


def read_entry_demand(entry_provision: dict | None) -> tuple[tuple[int, int] | None, str | None]:
    """Read a catalog entry's declared demand from provision.resources.requests.

    Returns ``((cpu_m, mem_b), None)`` on success. Returns ``(None, reason)``
    on refusal — ``'missing-budget'`` when the block is absent entirely,
    ``'invalid-budget: <detail>'`` when present but malformed, unparseable,
    or zero. Never assumes zero for an absent declaration (§3.2(a)), and
    never raises: every layer (provision, resources, requests) is
    type-checked before being indexed/``.get()``'d, so a catalog entry with
    a structurally malformed ``provision`` block (e.g. ``resources`` being a
    list, not a mapping) is a clean ``invalid-budget`` refusal, not an
    unhandled exception (codex R2-6).
    """
    if not isinstance(entry_provision, dict) or not entry_provision:
        return None, "missing-budget"

    resources = entry_provision.get("resources")
    if resources is None:
        return None, "missing-budget"
    if not isinstance(resources, dict):
        return None, f"invalid-budget: provision.resources must be a mapping, got {type(resources).__name__}"

    requests = resources.get("requests")
    if requests is None:
        return None, "missing-budget"
    if not isinstance(requests, dict):
        return None, (
            f"invalid-budget: provision.resources.requests must be a mapping, got {type(requests).__name__}"
        )

    if "cpu" not in requests or "memory" not in requests:
        return None, "missing-budget"

    try:
        cpu_m = parse_catalog_cpu(requests["cpu"])
        mem_b = parse_catalog_memory(requests["memory"])
    except QuantityError as exc:
        return None, f"invalid-budget: {exc}"
    return (cpu_m, mem_b), None


# ---------------------------------------------------------------------------
# EE reserve — §3.2(b), plan OQ1
# ---------------------------------------------------------------------------


def read_ee_reserve(
    *,
    api_url: str,
    api_token: str,
    ssl_verify: bool,
    floor_cpu_m: int,
    floor_mem_b: int,
) -> tuple[int, int, str]:
    """The AWX EE job pod's WHOLE-POD reserve, or the configured floor — per
    resource, whichever is larger.

    Sums declared ``resources.requests`` over EVERY container in the
    Container Group's ``pod_spec_override`` (not just one named "worker" —
    codex R2-4: a worker-only read undercounts any sidecar the pod spec
    grows) plus every initContainer plus pod ``overhead`` when present —
    the same conservative sum-not-max posture as ``read_node_supply``, for
    the same reason (KSM/the pod spec can't tell a sequential init from a
    restartable one).

    A container with no declared ``resources.requests`` contributes 0 (not
    an error — some containers legitimately have none); a malformed,
    unparseable quantity ANYWHERE in the spec is distrusted enough to fall
    the WHOLE reserve back to the floor (this function never raises to its
    caller).

    Returns ``(max(declared_cpu, floor_cpu_m), max(declared_mem, floor_mem_b),
    source)`` — ``source`` is ``'cg-declared'`` when the declared sum
    actually dominated (was used) for either resource, else ``'floor'``
    (nothing usable was declared anywhere, or the CG/override itself was
    missing).
    """
    try:
        pod_spec_raw = awx.get_instance_group_pod_spec(
            api_url=api_url, api_token=api_token, name="dmf-catalog-cg", ssl_verify=ssl_verify,
        )
        if not pod_spec_raw:
            return floor_cpu_m, floor_mem_b, "floor"

        pod_spec = yaml.safe_load(pod_spec_raw)
        spec = ((pod_spec or {}).get("spec")) or {}
        containers = spec.get("containers") or []
        init_containers = spec.get("initContainers") or []
        overhead = spec.get("overhead") or {}

        declared_cpu_m = 0
        declared_mem_b = 0
        for container in list(containers) + list(init_containers):
            requests = ((container.get("resources") or {}).get("requests")) or {}
            if "cpu" in requests:
                declared_cpu_m += parse_cpu_millicores(requests["cpu"])
            if "memory" in requests:
                declared_mem_b += parse_memory_bytes(requests["memory"])
        if "cpu" in overhead:
            declared_cpu_m += parse_cpu_millicores(overhead["cpu"])
        if "memory" in overhead:
            declared_mem_b += parse_memory_bytes(overhead["memory"])

        source = "cg-declared" if (declared_cpu_m >= floor_cpu_m or declared_mem_b >= floor_mem_b) else "floor"
        return max(declared_cpu_m, floor_cpu_m), max(declared_mem_b, floor_mem_b), source
    except Exception:
        return floor_cpu_m, floor_mem_b, "floor"


# ---------------------------------------------------------------------------
# Supply — §3.2 PromQL contract
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class NodeSupply:
    node_name: str
    alloc_cpu_m: int
    alloc_mem_b: int
    requested_cpu_m: int
    requested_mem_b: int
    pod_count: int


def _pod_key(metric: dict) -> tuple[str, str]:
    """Extract the (namespace, pod) key from a Prometheus result's metric labels.

    Raises KeyError if either label is absent — caught by the fail-closed
    boundary in ``read_node_supply`` (codex R2-2b: a malformed row must
    abort the whole read, never be silently dropped).
    """
    return metric["namespace"], metric["pod"]


def _row_value(row: dict) -> float:
    """Extract a Prometheus instant-query row's scalar value as a float.

    Raises on a missing/malformed ``value`` field, or one that is negative
    or non-finite (NaN/±Inf) — caught by the fail-closed boundary in
    ``read_node_supply``. Codex R4-1: a demand/allocatable metric can never
    legitimately be negative; taking one at face value would silently
    INCREASE headroom (e.g. an eligible pod reporting app cpu=-1 would
    SUBTRACT from already-requested) instead of refusing. Zero remains
    valid here — a container can legitimately declare a 0 request; the
    additional strictly-positive check for allocatable specifically lives
    at its call site, not here.
    """
    value = float(row["value"][1])
    if not math.isfinite(value):
        raise ValueError(f"non-finite metric value: {value!r}")
    if value < 0:
        raise ValueError(f"negative metric value: {value!r}")
    return value


def _sentinel_pod_keys(rows: list[dict]) -> set[tuple[str, str]]:
    """Extract (namespace,pod) keys from liveness-sentinel rows (R5-1).

    ``kube_pod_info`` and the ``== 1``-filtered ``kube_pod_status_phase``
    are boolean-presence signals — a RETURNED row is only meaningful if its
    value is finite AND strictly positive. Building the key set from
    labels alone (ignoring the value entirely, the pre-R5-1 bug) let a
    NaN/0/negative-valued row still count as "this pod is live" — codex's
    repro: pod_info value=NaN still satisfied liveness. With the phase
    query's own ``== 1`` filter, a returned phase row can never
    legitimately be anything but 1 — so a 0/negative/NaN value there is
    itself a malformed-row signal, not a real "not running" case (those
    never come back as rows at all).
    """
    keys = set()
    for row in rows:
        value = _row_value(row)
        if value <= 0:
            raise ValueError(f"liveness sentinel row has non-positive value: {value!r}")
        keys.add(_pod_key(row["metric"]))
    return keys


def _sum_by_pod(
    rows: list[dict], *, allowed_keys: set[tuple[str, str]] | None = None
) -> dict[tuple[str, str], float]:
    """Sum a metric's value across all rows sharing the same (namespace,pod).

    Used for both app-container and init-container families (R2-3: the
    conservative posture sums both, it never takes a max), and for the
    optional per-pod overhead families (each pod normally contributes at
    most one row there, but summing is harmless if KSM ever emitted more).
    Any malformed row (missing labels or value) raises, propagating to the
    fail-closed boundary.

    ``allowed_keys`` (R3-1), when given, drops any row whose (namespace,pod)
    isn't in that set BEFORE summing — used for metric families that carry
    no ``node`` label (pod overhead) so a query can't be node-scoped
    server-side; without this filter a same-named pod's overhead on a
    DIFFERENT node would leak into this node's budget.
    """
    out: dict[tuple[str, str], float] = {}
    for row in rows:
        key = _pod_key(row["metric"])
        if allowed_keys is not None and key not in allowed_keys:
            continue
        out[key] = out.get(key, 0.0) + _row_value(row)
    return out


def read_node_supply(*, prom_url: str) -> NodeSupply | str:
    """Read the target node's allocatable + already-requested budget.

    Returns a ``NodeSupply`` on success, or a refusal token string:
    ``'multi-node-unsupported'`` (more than one node reporting allocatable —
    the single-node lane, plan §0, is all this tier supports), or
    ``'budget-unavailable'`` for every other failure mode — empty/missing
    allocatable data, an empty liveness sentinel, a malformed row, or ANY
    exception (PrometheusAPIError, a bare transport error, ...). Fail-closed
    end to end: no data is never treated as fit (codex R2-2).
    """
    try:
        return _read_node_supply(prom_url)
    except _MultiNodeSupply:
        return "multi-node-unsupported"
    except Exception:
        return "budget-unavailable"


def _read_node_supply(prom_url: str) -> NodeSupply:
    alloc_cpu_rows = prometheus.query(
        url=prom_url, expr='kube_node_status_allocatable{resource="cpu",unit="core"}'
    )
    alloc_mem_rows = prometheus.query(
        url=prom_url, expr='kube_node_status_allocatable{resource="memory",unit="byte"}'
    )
    if not alloc_cpu_rows or not alloc_mem_rows:
        raise RuntimeError("empty kube_node_status_allocatable")

    cpu_by_node = {row["metric"]["node"]: row for row in alloc_cpu_rows}
    mem_by_node = {row["metric"]["node"]: row for row in alloc_mem_rows}

    # R3-4: the cpu and memory allocatable keysets must be IDENTICAL, not
    # merely overlapping. A mismatch (partial overlap, or one resource
    # reporting nodes the other doesn't) is itself a data-integrity signal
    # — never silently narrow to the intersection and treat a mismatched
    # scrape as a clean single-node read.
    if set(cpu_by_node) != set(mem_by_node):
        raise RuntimeError("cpu and memory allocatable keysets differ")

    node_names = set(cpu_by_node)
    if len(node_names) > 1:
        raise _MultiNodeSupply()

    node_name = next(iter(node_names))
    alloc_cpu_m = int(_row_value(cpu_by_node[node_name]) * 1000)
    alloc_mem_b = int(_row_value(mem_by_node[node_name]))
    # R4-1: allocatable is stricter than a general metric value — zero is
    # never legitimate here (a node with 0 allocatable cpu/mem can't run
    # anything, including itself), unlike a demand row where 0 is a valid
    # declared request.
    if alloc_cpu_m <= 0 or alloc_mem_b <= 0:
        raise RuntimeError("allocatable must be strictly positive")

    # Liveness sentinels (R2-2c): kube_pod_info is the authoritative per-node
    # bound-pod join (unlike the request-family metrics, which are simply
    # ABSENT for a pod with no requests declared — sparse, not a signal of
    # anything wrong). Both families empty means KSM itself is unscraped —
    # a live node always runs at least the kube-system pods.
    pod_info_rows = prometheus.query(url=prom_url, expr=f'kube_pod_info{{node="{node_name}"}}')
    phase_rows = prometheus.query(url=prom_url, expr='kube_pod_status_phase{phase=~"Running|Pending"} == 1')
    if not pod_info_rows or not phase_rows:
        raise RuntimeError("empty liveness sentinel (kube_pod_info or kube_pod_status_phase)")

    bound_to_node = _sentinel_pod_keys(pod_info_rows)
    running_or_pending = _sentinel_pod_keys(phase_rows)
    # Only pods genuinely bound to THIS node and in an active phase count.
    # A Pending pod not yet bound anywhere (no kube_pod_info row here) is
    # unschedulable-elsewhere and must not be charged to this node's budget.
    eligible = bound_to_node & running_or_pending
    if not eligible:
        # R3-2: a live single node ALWAYS has at least the kube-system pods
        # in this intersection. An empty result here — even with non-empty
        # pod_info and phase individually — means the two sentinels are
        # somehow talking about disjoint pods (a KSM scrape-consistency
        # problem), not a genuinely idle node. Never treat as "zero demand".
        raise RuntimeError("empty eligible set (pod_info ∩ phase)")

    app_cpu_rows = prometheus.query(
        url=prom_url,
        expr=f'sum by (namespace,pod) (kube_pod_container_resource_requests{{node="{node_name}",resource="cpu"}})',
    )
    app_mem_rows = prometheus.query(
        url=prom_url,
        expr=f'sum by (namespace,pod) (kube_pod_container_resource_requests{{node="{node_name}",resource="memory"}})',
    )
    init_cpu_rows = prometheus.query(
        url=prom_url,
        expr=f'kube_pod_init_container_resource_requests{{node="{node_name}",resource="cpu"}}',
    )
    init_mem_rows = prometheus.query(
        url=prom_url,
        expr=f'kube_pod_init_container_resource_requests{{node="{node_name}",resource="memory"}}',
    )
    # Pod overhead (R2-3b, KSM >= 2.10): rare, so an empty result here is
    # legitimate (most pods/clusters have none) — NOT a liveness signal like
    # pod_info/phase above. R3-1: this metric family carries namespace/pod/
    # uid labels but NO node label — a node-matched query would silently
    # return empty forever. Query it bare (cluster-wide) and filter to the
    # already-computed eligible set client-side, so a pod's overhead from a
    # DIFFERENT node never leaks into this node's budget.
    overhead_cpu_rows = prometheus.query(url=prom_url, expr="kube_pod_overhead_cpu_cores")
    overhead_mem_rows = prometheus.query(url=prom_url, expr="kube_pod_overhead_memory_bytes")

    app_cpu = _sum_by_pod(app_cpu_rows)
    app_mem = _sum_by_pod(app_mem_rows)
    init_cpu = _sum_by_pod(init_cpu_rows)
    init_mem = _sum_by_pod(init_mem_rows)
    overhead_cpu = _sum_by_pod(overhead_cpu_rows, allowed_keys=eligible)
    overhead_mem = _sum_by_pod(overhead_mem_rows, allowed_keys=eligible)

    requested_cpu_m = 0
    requested_mem_b = 0
    for key in eligible:
        # Conservative overcount (R2-3a): app sum + init sum + overhead,
        # never a max — request families are legitimately sparse for a
        # pod with no requests/no inits/no overhead, so missing entries
        # default to 0, not a refusal.
        pod_cpu = app_cpu.get(key, 0.0) + init_cpu.get(key, 0.0) + overhead_cpu.get(key, 0.0)
        pod_mem = app_mem.get(key, 0.0) + init_mem.get(key, 0.0) + overhead_mem.get(key, 0.0)
        requested_cpu_m += int(pod_cpu * 1000)
        requested_mem_b += int(pod_mem)

    return NodeSupply(
        node_name=node_name,
        alloc_cpu_m=alloc_cpu_m,
        alloc_mem_b=alloc_mem_b,
        requested_cpu_m=requested_cpu_m,
        requested_mem_b=requested_mem_b,
        pod_count=len(eligible),
    )


# ---------------------------------------------------------------------------
# Evaluate — §3.4 legible budget report
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PreflightResult:
    verdict: str  # 'fit' | 'no-fit'
    headroom_cpu_m: int
    headroom_mem_b: int
    run_demand_cpu_m: int
    run_demand_mem_b: int
    ee_reserve_cpu_m: int
    ee_reserve_mem_b: int
    total_cpu_m: int
    total_mem_b: int
    shortfall_cpu_m: int
    shortfall_mem_b: int
    report: dict = field(default_factory=dict)
    text: str = ""


def _fmt_cpu(millicores: int) -> str:
    return f"{millicores}m"


def _fmt_mem(byte_count: int) -> str:
    return f"{round(byte_count / (1024**2))}Mi"


def _group_demand_items(demand_items):
    grouped: dict[str, list[int]] = {}
    for label, cpu_m, mem_b in demand_items:
        bucket = grouped.setdefault(label, [0, 0, 0])
        bucket[0] += 1
        bucket[1] += cpu_m
        bucket[2] += mem_b
    return grouped


def _render_text(
    *,
    facility: str,
    supply: NodeSupply,
    demand_items,
    ee_reserve: tuple[int, int, str],
    run_demand_cpu_m: int,
    run_demand_mem_b: int,
    total_cpu_m: int,
    total_mem_b: int,
    headroom_cpu_m: int,
    headroom_mem_b: int,
    verdict: str,
    shortfall_cpu_m: int,
    shortfall_mem_b: int,
) -> str:
    ee_cpu_m, ee_mem_b, ee_source = ee_reserve
    lines: list[str] = []

    if verdict == "no-fit":
        lines.append(f"Launch refused — capacity budget exceeded on facility {facility}.")
        lines.append("")

    lines.append(f"Node budget ({supply.node_name}, single-node lane)")
    lines.append(f"  allocatable:        CPU {_fmt_cpu(supply.alloc_cpu_m)}   MEM {_fmt_mem(supply.alloc_mem_b)}")
    lines.append(
        f"  already requested:  CPU {_fmt_cpu(supply.requested_cpu_m)}   MEM {_fmt_mem(supply.requested_mem_b)}"
        f"   ({supply.pod_count} pods)"
    )
    lines.append(f"  headroom:           CPU {_fmt_cpu(headroom_cpu_m)}   MEM {_fmt_mem(headroom_mem_b)}")
    lines.append("")
    lines.append("This run would add")
    for label, (count, cpu_m, mem_b) in _group_demand_items(demand_items).items():
        display_label = f"{label} × {count}" if count > 1 else label
        lines.append(f"  {display_label}   CPU {_fmt_cpu(cpu_m)}   MEM {_fmt_mem(mem_b)}")
    lines.append(f"  AWX EE job pod (rsv, {ee_source})   CPU {_fmt_cpu(ee_cpu_m)}   MEM {_fmt_mem(ee_mem_b)}")
    lines.append(f"  run demand + reserve   CPU {_fmt_cpu(total_cpu_m)}   MEM {_fmt_mem(total_mem_b)}")
    lines.append("")

    if verdict == "fit":
        lines.append(
            f"Verdict: FIT — CPU headroom {_fmt_cpu(headroom_cpu_m - total_cpu_m)}, "
            f"MEM headroom {_fmt_mem(headroom_mem_b - total_mem_b)} remain after this run."
        )
    else:
        shortfalls = []
        if shortfall_cpu_m:
            shortfalls.append(
                f"CPU short by {_fmt_cpu(shortfall_cpu_m)} "
                f"(need {_fmt_cpu(total_cpu_m)}, have {_fmt_cpu(headroom_cpu_m)})"
            )
        if shortfall_mem_b:
            shortfalls.append(
                f"MEM short by {_fmt_mem(shortfall_mem_b)} "
                f"(need {_fmt_mem(total_mem_b)}, have {_fmt_mem(headroom_mem_b)})"
            )
        lines.append("Verdict: NO-FIT — " + "; ".join(shortfalls) + ".")
        lines.append("")
        lines.append(
            "To proceed anyway an engineer must re-launch with an override and a reason\n"
            "(audited). To fit without override: finalise a running workload first\n"
            "(e.g. the largest current instance), then retry."
        )

    return "\n".join(lines)


def evaluate_preflight(
    *,
    demand_items: list[tuple[str, int, int]],
    ee_reserve: tuple[int, int, str],
    supply: NodeSupply,
) -> PreflightResult:
    """Evaluate FIT/NO-FIT: node headroom vs (run demand + EE reserve).

    Both CPU and memory must fit; either breach is NO-FIT (§3.2 — CPU is
    the bound today but the check stays symmetric).

    ``facility`` in the report/text is always ``supply.node_name`` (codex
    R2-8): until ``topology_params`` lands, the node IS the standing
    facility's only honest identity — the catalog entry key belongs in the
    demand line items, not as a stand-in facility name.
    """
    ee_cpu_m, ee_mem_b, ee_source = ee_reserve
    facility = supply.node_name

    run_demand_cpu_m = sum(cpu for _, cpu, _ in demand_items)
    run_demand_mem_b = sum(mem for _, _, mem in demand_items)

    total_cpu_m = run_demand_cpu_m + ee_cpu_m
    total_mem_b = run_demand_mem_b + ee_mem_b

    headroom_cpu_m = supply.alloc_cpu_m - supply.requested_cpu_m
    headroom_mem_b = supply.alloc_mem_b - supply.requested_mem_b

    cpu_fits = total_cpu_m <= headroom_cpu_m
    mem_fits = total_mem_b <= headroom_mem_b
    verdict = "fit" if (cpu_fits and mem_fits) else "no-fit"

    shortfall_cpu_m = 0 if cpu_fits else total_cpu_m - headroom_cpu_m
    shortfall_mem_b = 0 if mem_fits else total_mem_b - headroom_mem_b

    report = {
        "facility": facility,
        "node_name": supply.node_name,
        "allocatable_cpu_m": supply.alloc_cpu_m,
        "allocatable_mem_b": supply.alloc_mem_b,
        "already_requested_cpu_m": supply.requested_cpu_m,
        "already_requested_mem_b": supply.requested_mem_b,
        "already_requested_pod_count": supply.pod_count,
        "headroom_cpu_m": headroom_cpu_m,
        "headroom_mem_b": headroom_mem_b,
        "demand_items": [{"label": label, "cpu_m": cpu, "mem_b": mem} for label, cpu, mem in demand_items],
        "ee_reserve": {"cpu_m": ee_cpu_m, "mem_b": ee_mem_b, "source": ee_source},
        "run_demand_cpu_m": run_demand_cpu_m,
        "run_demand_mem_b": run_demand_mem_b,
        "total_cpu_m": total_cpu_m,
        "total_mem_b": total_mem_b,
        "verdict": verdict,
        "shortfall_cpu_m": shortfall_cpu_m,
        "shortfall_mem_b": shortfall_mem_b,
    }

    text = _render_text(
        facility=facility,
        supply=supply,
        demand_items=demand_items,
        ee_reserve=ee_reserve,
        run_demand_cpu_m=run_demand_cpu_m,
        run_demand_mem_b=run_demand_mem_b,
        total_cpu_m=total_cpu_m,
        total_mem_b=total_mem_b,
        headroom_cpu_m=headroom_cpu_m,
        headroom_mem_b=headroom_mem_b,
        verdict=verdict,
        shortfall_cpu_m=shortfall_cpu_m,
        shortfall_mem_b=shortfall_mem_b,
    )

    return PreflightResult(
        verdict=verdict,
        headroom_cpu_m=headroom_cpu_m,
        headroom_mem_b=headroom_mem_b,
        run_demand_cpu_m=run_demand_cpu_m,
        run_demand_mem_b=run_demand_mem_b,
        ee_reserve_cpu_m=ee_cpu_m,
        ee_reserve_mem_b=ee_mem_b,
        total_cpu_m=total_cpu_m,
        total_mem_b=total_mem_b,
        shortfall_cpu_m=shortfall_cpu_m,
        shortfall_mem_b=shortfall_mem_b,
        report=report,
        text=text,
    )
