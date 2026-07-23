"""L3 monitoring drain verification — decision core (umbrella #202 WP4).

Today every rollback that reaches AWX terminal ``successful`` with the
``rollback_incomplete surfaces=monitoring`` marker (netbox + helm surfaces
already clean, only monitoring drain unverifiable from the launcher's EE —
see main.py's L3 outcome marker docstring) is stuck at
``ROLLBACK_INCOMPLETE`` forever, blocking the facility. WP4 adds the
console-side, read-only verification that can upgrade such a rollback to
``RUN_COMPLETE`` — the console has NO k8s client and cannot read the
launcher's snapshot ConfigMap, so the expected drain set is derived as a
projection-consistency check (NOT a snapshot diff): which of this catalog
entry's NetBox-registered services should no longer be monitored, per the
CURRENT live NetBox state.

Two layers, mirroring capacity.py's own split:
* Pure functions (``is_eligible_for_drain_verification``,
  ``find_deploy_ops_for_run``, host matching) — no I/O, offline-testable.
* ONE fail-closed boundary per seam call (``resolve_drain_targets``,
  ``check_drained``) — mirrors ``capacity.read_node_supply()``'s posture
  (capacity.py:376-392): ANY exception means "not verified this cycle",
  never an upgrade. The module makes no HTTP calls beyond the PromSD +
  Prometheus seams and the existing NetBox read seam
  (``catalog.get_lifecycle_status``'s own pattern).

Console-originated detail tokens (below) are a SEPARATE registry from
main.py's ``_KV_DETAIL_TOKENS`` — that set is reserved for launcher-emitted
(dmf-runbooks) values and guarded by the cross-repo drift test
``tests/test_l3_token_registry.py``; it must not be touched by WP4. These
tokens are constructed directly by console code, never parsed from
untrusted AWX job stdout/events, so they never pass through
``main._sanitize_kv`` (verified: that function has exactly one call site,
gating only the launcher marker's kv text) — no sanitizer allowlist change
is needed to make them survive to the operator surface.
"""

from __future__ import annotations

import logging
import re
import urllib.parse
from dataclasses import dataclass
from typing import Optional

from .catalog import CatalogEntry
from .operations import Operation
# codex round-4: the single shared "is this string a usable target
# identity" parser lives in promsd.py (no reverse dependency — promsd.py
# never imports drain.py, so this is safe at module level) and is reused
# here rather than kept as a second copy; see promsd._strip_to_host's own
# docstring for why it moved.
from .promsd import _strip_to_host

logger = logging.getLogger(__name__)

# Console-side L3 drain-verification detail vocabulary (WP4) — NOT part of
# main._KV_DETAIL_TOKENS.
DRAIN_VERIFIED_DETAIL = "monitoring-drain-verified"
DRAIN_PENDING_DETAIL = "monitoring-drain-pending"
# codex round-1 F1: an operation this drain verification resolves as a
# SIDE EFFECT of the primary rollback op's own upgrade (main.py
# _mark_drain_verified) — the facility-coherence fix.
ROLLBACK_VERIFIED_DETAIL = "rollback-verified"
SUPERSEDED_BY_VERIFIED_ROLLBACK_DETAIL = "superseded-by-verified-rollback"

MONITORING_PROBE_TAG = "monitoring:probe"

# RFC1123 DNS label (mirrors media_workloads._DNS_LABEL) — codex round-1 F4:
# an authored override (or a derived name/namespace) that isn't a valid DNS
# label can never match what PromSD/the cluster actually compose as a host,
# so it must fail closed rather than silently produce an uncheckable target.
_DNS_LABEL_RE = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")


def _is_dns_label(value: object) -> bool:
    return isinstance(value, str) and bool(_DNS_LABEL_RE.fullmatch(value))


@dataclass(frozen=True)
class DrainTarget:
    """One service expected to have drained its monitoring surface."""

    cluster_service: str
    cluster_namespace: str

    @property
    def host(self) -> str:
        return f"{self.cluster_service}.{self.cluster_namespace}.svc.cluster.local"


# ---------------------------------------------------------------------------
# D1 — eligibility (pure)
# ---------------------------------------------------------------------------


def is_eligible_for_drain_verification(
    *, status: str, outcome_token: Optional[str], outcome_kv: Optional[str]
) -> bool:
    """D1: a rollback enters drain verification ONLY when the AWX job
    terminalized ``successful`` AND the outcome marker is exactly
    ``rollback_incomplete`` AND its ``surfaces`` kv is exactly
    ``{monitoring}`` (netbox/helm dirty stays ROLLBACK_INCOMPLETE untouched
    — the console cannot clean those surfaces). No upgrade on failed jobs,
    missing/other markers, or any other surfaces combination — this is a
    strict EXTENSION of WP2's dual-signal rule, never a relaxation.
    """
    if status != "successful" or outcome_token != "rollback_incomplete":
        return False
    return _parse_surfaces(outcome_kv) == frozenset({"monitoring"})


def _parse_surfaces(kv: Optional[str]) -> Optional[frozenset[str]]:
    """Parse the marker's ``surfaces=`` kv. Returns ``None`` if the key is
    absent OR appears more than once (codex round-1 F2: the sanitizer
    preserves duplicate valid keys verbatim — ``surfaces=monitoring
    surfaces=netbox`` would otherwise resolve to whichever occurrence this
    function happened to scan first). A duplicate key is an ambiguous
    marker and must never be guessed at — fail closed to ineligible, the
    same as a missing key.
    """
    if not kv:
        return None
    result = None
    for token in kv.split():
        key, sep, value = token.partition("=")
        if sep and key == "surfaces":
            if result is not None:
                return None
            result = frozenset(p for p in value.split(",") if p)
    return result


def find_deploy_ops_for_run(operations: list[Operation], run_id: str) -> Optional[list[Operation]]:
    """Recover ALL deploy ops correlated to a rollback's run_id.

    ``OperationStore`` does not enforce run_id uniqueness (codex round-1
    F6) — a reattach, a concurrent dispatch, or a manually-tracked job can
    each mint a deploy Operation carrying the same run_id. Returns ``None``
    (unrecoverable, fail-closed) when there are ZERO matches (as before),
    or when the matches do not all agree on the SAME catalog target —
    projection identity must be unambiguous, never order-selected. When
    they DO agree, returns every matching op (main.py's F1 facility-
    coherence fix needs all of them, not just one, to resolve every
    correlated dirty state).
    """
    matches = [op for op in operations if op.action == "deploy" and op.run_id == run_id]
    if not matches:
        return None
    if len({op.target for op in matches}) > 1:
        return None
    return matches


def find_deploy_target_for_run(operations: list[Operation], run_id: str) -> Optional[str]:
    """Convenience wrapper over ``find_deploy_ops_for_run`` for callers
    that only need the (unambiguous) catalog key, not the op list."""
    ops = find_deploy_ops_for_run(operations, run_id)
    return ops[0].target if ops else None


# ---------------------------------------------------------------------------
# D2 — expected target set = projection-consistency (fail-closed boundary)
# ---------------------------------------------------------------------------


def resolve_drain_targets(
    entry: CatalogEntry,
    *,
    netbox_url: str,
    netbox_token: str,
    ssl_verify: bool = True,
) -> Optional[list[DrainTarget]]:
    """Return the services expected to have drained monitoring for this
    catalog entry, or ``None`` if identity is unrecoverable (no
    provision.netbox_service, or ANY NetBox read failure — fail-closed,
    mirroring ``capacity.read_node_supply``'s posture: no data is never
    treated as fit/drained). An empty list means every configured service
    was legitimately retained — drained trivially (D2).
    """
    try:
        return _resolve_drain_targets(
            entry, netbox_url=netbox_url, netbox_token=netbox_token, ssl_verify=ssl_verify
        )
    except Exception:
        logger.warning(
            "drain: NetBox read failed while resolving drain targets for catalog key %s",
            entry.key, exc_info=True,
        )
        return None


def _netbox_service_specs(entry: CatalogEntry) -> list[dict]:
    """Normalize provision.netbox_service to a list — today every shipped
    catalog entry authors it as a single dict; design for N services per
    entry (D2) even though J1 has 1.

    codex round-3 F3: a declared LIST must never partially normalize —
    filtering out non-dict members and resolving just the valid subset
    would silently drop a malformed service from the drain set entirely
    (a partial catalog declaration reading as trivially clean). If EVERY
    member isn't a dict (or the list is empty), the whole declaration is
    malformed: return ``[]`` uniformly, same as "no netbox_service at
    all" — ``_resolve_drain_targets``'s ``if not specs: return None``
    already fails the whole resolution closed on that, so no separate
    "why empty" signal is needed here.
    """
    if not entry.provision:
        return []
    raw = entry.provision.get("netbox_service")
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, list):
        if not raw or not all(isinstance(r, dict) for r in raw):
            return []
        return raw
    return []


def _tag_names(record: dict) -> set[str]:
    out = set()
    for tag in record.get("tags", []) or []:
        name = tag.get("name", "") if isinstance(tag, dict) else str(tag)
        if name:
            out.add(name)
    return out


def _spec_override(spec: dict, key: str, default: Optional[str]) -> tuple[Optional[str], bool]:
    """Read an OPTIONAL catalog-declared identity override on a
    netbox_service spec (umbrella #202 WP4 R1b: dmf-media's
    provision.netbox_service schema gains optional ``cluster_service``/
    ``cluster_namespace`` keys, landed as a sibling dmf-media PR — e.g.
    nmos-cpp.yaml declares ``cluster_service: nmos-cpp-registry`` to match
    its dmf-runbooks role-default identity, roles/nmos-cpp/defaults/
    main.yml). Absent key -> ``(default, False)``. Present but not a
    non-empty str -> ``(None, True)`` — an authored-but-broken override
    fails closed, same posture as every other malformed-catalog-data case
    here (never silently ignored or silently defaulted). Does NOT validate
    DNS-label shape itself — callers apply ``_is_dns_label`` to the
    resolved value uniformly, whichever source (override or default) it
    came from (codex round-1 F4).
    """
    if key not in spec:
        return default, False
    value = spec.get(key)
    if isinstance(value, str) and value:
        return value, False
    return None, True


def _validate_netbox_list_envelope(result: object) -> Optional[list[dict]]:
    """Validate a NetBox list-endpoint envelope (codex round-2 F2).

    ``{"count": <int>, "next": ..., "previous": ..., "results": [...]}`` is
    the DRF pagination shape every NetBox list endpoint uses. Blindly
    doing ``result.get("results", [])`` treats an HTTP-200 EMPTY body
    (``{}``) as "zero results" — genuine absence — when it's actually an
    unreadable/malformed response; and it never checks whether ``results``
    is the FULL match set or just one page of it. ``count`` is NetBox's own
    authoritative record count — this only returns ``results`` when
    ``count`` is a non-negative int, ``results`` is a list, and
    ``count == len(results)`` (this page truly holds every matching
    record; a paginated response with more matches beyond this page, e.g.
    ``{"count": 2, "next": "page2", "results": [one]}``, fails this
    equality and is rejected here rather than downstream). Anything else
    -> ``None``, unverifiable — never treated as absence.
    """
    if not isinstance(result, dict):
        return None
    count = result.get("count")
    results = result.get("results")
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        return None
    if not isinstance(results, list):
        return None
    if count != len(results):
        return None
    return results


def _resolve_drain_targets(
    entry: CatalogEntry, *, netbox_url: str, netbox_token: str, ssl_verify: bool,
) -> Optional[list[DrainTarget]]:
    specs = _netbox_service_specs(entry)
    if not specs:
        return None

    # Lazy import — same reasoning as catalog.get_lifecycle_status (avoid
    # circular deps when netbox.py imports catalog helpers).
    from . import netbox as _netbox

    catalog_namespace = entry.provision.get("namespace") if entry.provision else None
    ctx = _netbox._ssl_context(ssl_verify)

    targets: list[DrainTarget] = []
    for spec in specs:
        service_name = spec.get("name")
        if not isinstance(service_name, str) or not service_name:
            return None  # malformed catalog data — fail closed, not partial

        spec_cluster_service, malformed_cs = _spec_override(spec, "cluster_service", service_name)
        spec_cluster_namespace, malformed_cns = _spec_override(spec, "cluster_namespace", catalog_namespace)
        if (
            malformed_cs or malformed_cns
            or not _is_dns_label(spec_cluster_service) or not _is_dns_label(spec_cluster_namespace)
        ):
            # F4: an authored override (or a derived name/namespace) that
            # fails RFC1123 DNS-label shape can never match a real emitted
            # target — fail closed rather than compose an unmatchable host.
            return None

        # H_run: the run/catalog projection identity — codex round-1 F4.
        # This is what the LAUNCHER would have composed as this service's
        # monitoring target had it stayed monitored, straight from the
        # catalog (+ optional override), and is what THIS run's drain must
        # actually clear — regardless of what any live NetBox record's own
        # custom_fields currently say. Live custom_fields never override
        # H_run; they are consulted ONLY below, to decide whether a
        # present+monitored record legitimately retains H_run.
        h_run = DrainTarget(cluster_service=spec_cluster_service, cluster_namespace=spec_cluster_namespace)

        # F2 (codex round-2): request limit=2 so a second matching record
        # can never hide beyond this page while still keeping the request
        # cheap/bounded.
        path = f"/api/ipam/services/?name={urllib.parse.quote(service_name)}&limit=2"
        result = _netbox._request(netbox_url, netbox_token, path, ssl_context=ctx)
        records = _validate_netbox_list_envelope(result)
        if records is None:
            # F2: a malformed/unvalidatable envelope (missing/wrong-typed
            # count or results, or count that disagrees with what this
            # page actually returned — e.g. a paginated {"count":2,
            # "next":"page2","results":[one]}) is UNVERIFIABLE, never
            # "absent". An HTTP-200 EMPTY body ({}) is exactly this case —
            # it must never read as "zero results" and derive H_run as
            # trivially drain-expected/absent.
            return None

        if len(records) > 1:
            # F5: NetBox service names are not guaranteed unique by this
            # code — an ambiguous name match must never silently trust
            # records[0]; fail closed rather than pick an order-dependent
            # winner (a stale second record's target could otherwise go
            # unchecked forever).
            return None

        if not records:
            # ABSENT — H_run is drain-expected (no live record to inspect
            # at all; this run's own record was deleted by rollback's
            # NetBox-surface cleanup, §4.2).
            targets.append(h_run)
            continue

        record = records[0]
        if MONITORING_PROBE_TAG in _tag_names(record):
            # Present WITH monitoring:probe. F4: retained ONLY when this
            # record's OWN live identity composes EXACTLY H_run — a
            # restored pre-existing record that legitimately monitors a
            # DIFFERENT host (e.g. a redeploy over a service whose
            # snapshot points elsewhere) does not excuse H_run itself from
            # draining; the run's own projection must still clear.
            cf = record.get("custom_fields") or {}
            record_service = cf.get("cluster_service")
            record_namespace = cf.get("cluster_namespace")
            if record_service == h_run.cluster_service and record_namespace == h_run.cluster_namespace:
                continue  # exact match — legitimately retained, exclude H_run
            targets.append(h_run)
            continue

        # Present WITHOUT monitoring:probe, OR present-with-probe-but-
        # different-identity (handled above) — H_run drain-expected.
        targets.append(h_run)

    return targets


# ---------------------------------------------------------------------------
# D3/D4 — drained = both surfaces agree absent (fail-closed boundary)
# ---------------------------------------------------------------------------


def check_drained(drain_targets: list[DrainTarget], *, promsd_url: str, prometheus_url: str) -> bool:
    """D3: drained iff, in the SAME poll cycle, neither PromSD's live
    ``/sd/probe`` output nor Prometheus's active targets contain a target
    matching any drain-set host. Fail-closed end to end: an empty
    drain_targets list is trivially drained (D2); an unconfigured seam or
    ANY exception (unreachable, malformed payload, not-ready adapter,
    empty-envelope liveness-sentinel failure, ...) means "not verified
    this cycle" — never an upgrade (mirrors
    ``capacity.read_node_supply``'s posture).
    """
    if not drain_targets:
        return True
    if not promsd_url or not prometheus_url:
        logger.info("drain: promsd or prometheus unconfigured — drain unverifiable this cycle")
        return False
    try:
        return _check_drained(drain_targets, promsd_url=promsd_url, prometheus_url=prometheus_url)
    except Exception:
        logger.warning("drain: seam error during drain check — not verified this cycle", exc_info=True)
        return False


def _check_drained(drain_targets: list[DrainTarget], *, promsd_url: str, prometheus_url: str) -> bool:
    from . import promsd as _promsd

    # F3a: a cold/not-yet-refreshed PromSD adapter serves HTTP 200 `[]` on
    # /sd/probe while /readyz is still 503 (dmf-promsd main.py:74-86,
    # cache.py:115-119,134-147) — that emptiness must never be trusted as
    # real drain evidence. Checked in the SAME cycle, before /sd/probe.
    if not _promsd.ready(url=promsd_url):
        raise RuntimeError("promsd not ready this cycle — adapter cold or refresh failed")

    hosts = {t.host for t in drain_targets}

    for group in _promsd.list_probe_targets(url=promsd_url):
        for raw_target in group.get("targets", []) or []:
            if _strip_to_host(raw_target) in hosts:
                return False

    for active_target in _strict_prometheus_active_targets(prometheus_url):
        labels = active_target.get("labels") or {}
        discovered = active_target.get("discoveredLabels") or {}
        for candidate in (labels.get("instance"), discovered.get("__param_target")):
            if candidate and _strip_to_host(candidate) in hosts:
                return False

    return True


def _strict_prometheus_active_targets(prometheus_url: str) -> list[dict]:
    """Drain-local strict validation over Prometheus's targets envelope
    (codex round-1 F3b/F3c, round-3 F1) — deliberately NOT folded into the
    shared ``prometheus.list_targets`` seam, which also backs the lenient
    ``/api/monitoring/targets`` UI endpoint (main.py) and must keep
    treating a missing/empty envelope as "no targets to show", not an
    error. Drain verification needs the opposite posture: raises on a
    non-dict envelope, ``status != "success"``, a missing/non-list
    ``data.activeTargets`` — AND on a structurally-valid-but-EMPTY
    ``activeTargets`` list, which is itself implausible for a live
    Prometheus (it always scrapes at least itself) and therefore a
    liveness-sentinel failure, not drain evidence.

    codex round-3 F1: the liveness-sentinel non-empty check ALONE isn't
    enough — a list containing only unreadable rows (e.g. ``[{}]``)
    satisfies "non-empty" while contributing no candidate host to match
    against, so the drain check below would silently see nothing and
    read as drained. Every row is now validated too: must be a dict; its
    ``labels``/``discoveredLabels`` must each be a dict or absent; and it
    must yield at least one usable non-empty-string identity from
    ``labels.instance`` or ``discoveredLabels.__param_target`` — the SAME
    two fields the matching loop below actually reads. Any violation
    raises; a target Prometheus can't describe is not drain evidence.
    """
    from . import prometheus as _prometheus

    raw = _prometheus._request(prometheus_url, "/api/v1/targets")
    if not isinstance(raw, dict) or raw.get("status") != "success":
        raise RuntimeError(f"malformed/unsuccessful Prometheus targets envelope: {raw!r}")
    data = raw.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("activeTargets"), list):
        raise RuntimeError("Prometheus targets response missing data.activeTargets")
    active = data["activeTargets"]
    if not active:
        raise RuntimeError("Prometheus activeTargets is empty — liveness sentinel failed")

    for row in active:
        if not isinstance(row, dict):
            raise RuntimeError(f"malformed Prometheus activeTargets row (not a dict): {row!r}")
        labels = row.get("labels")
        discovered = row.get("discoveredLabels")
        if labels is not None and not isinstance(labels, dict):
            raise RuntimeError(f"malformed Prometheus activeTargets row.labels: {labels!r}")
        if discovered is not None and not isinstance(discovered, dict):
            raise RuntimeError(f"malformed Prometheus activeTargets row.discoveredLabels: {discovered!r}")
        instance = (labels or {}).get("instance")
        param_target = (discovered or {}).get("__param_target")
        # codex round-4 F1: "usable" means _strip_to_host actually parses
        # it into a non-empty host — the EXACT parser the matching loop
        # below applies — not merely "is this a non-empty string". ":" is
        # a non-empty string that _strip_to_host(":") reduces to None; a
        # truthiness-only check let a row like that count as usable while
        # contributing no real candidate host to match against.
        usable = _strip_to_host(instance) or _strip_to_host(param_target)
        if not usable:
            raise RuntimeError(f"Prometheus activeTargets row has no usable identity: {row!r}")

    return active
