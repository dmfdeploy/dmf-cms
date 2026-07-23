"""L3 monitoring drain verification — decision core (umbrella #202 WP4).

Pure-function + fail-closed-boundary unit tests for drain.py, independent
of the async watcher wiring (see test_drain_verification.py for the
main.py integration surface: A1-A4, A6-A9, F1/F10 end-to-end).
"""

from dmf_cms import drain
from dmf_cms import netbox as netbox_module
from dmf_cms import prometheus as prometheus_module
from dmf_cms import promsd as promsd_module
from dmf_cms.catalog import CatalogEntry
from dmf_cms.operations import Operation, OperationState


def _op(action, target, *, run_id=None) -> Operation:
    return Operation(operation_id=f"op-{action}-{target}-{run_id}-{id(object())}", action=action, target=target, state=OperationState.RUN_COMPLETE, run_id=run_id)


ENTRY_SINGLE_SERVICE = CatalogEntry(
    key="mxl-videotestsrc",
    display_name="MXL Test-Pattern Source",
    summary="",
    provision={
        "namespace": "mxl",
        "netbox_service": {"name": "mxl-videotestsrc", "protocol": "tcp", "ports": [1234]},
    },
)

ENTRY_NO_SERVICE = CatalogEntry(key="bare", display_name="Bare", summary="", provision={"namespace": "mxl"})
ENTRY_NO_PROVISION = CatalogEntry(key="bare2", display_name="Bare2", summary="")

# A live Prometheus always scrapes at least itself — every check_drained
# test that wants a genuinely "drained" (no-match) outcome must include
# this (or some other non-matching entry) so the F3c liveness-sentinel
# check doesn't itself fail the cycle.
SELF_SCRAPE = {"labels": {"instance": "prometheus-server:9090", "job": "prometheus"}}


def _mock_promsd_ready(monkeypatch, ready=True):
    monkeypatch.setattr(promsd_module, "ready", lambda **k: ready)


def _mock_prometheus_envelope(monkeypatch, active_targets):
    monkeypatch.setattr(
        prometheus_module, "_request",
        lambda *a, **k: {"status": "success", "data": {"activeTargets": active_targets}},
    )


# ---------------------------------------------------------------------------
# D1 — is_eligible_for_drain_verification (A1/A3/A4 pure core)
# ---------------------------------------------------------------------------


def test_eligible_requires_successful_status():
    assert not drain.is_eligible_for_drain_verification(
        status="failed", outcome_token="rollback_incomplete", outcome_kv="surfaces=monitoring",
    )


def test_eligible_requires_rollback_incomplete_token():
    assert not drain.is_eligible_for_drain_verification(
        status="successful", outcome_token="rollback_complete", outcome_kv="surfaces=monitoring",
    )


def test_eligible_requires_surfaces_exactly_monitoring():
    assert drain.is_eligible_for_drain_verification(
        status="successful", outcome_token="rollback_incomplete", outcome_kv="surfaces=monitoring",
    )


def test_not_eligible_when_surfaces_is_a_superset():
    # A3: netbox/helm dirty too -> never eligible, no matter the order.
    assert not drain.is_eligible_for_drain_verification(
        status="successful", outcome_token="rollback_incomplete", outcome_kv="surfaces=netbox,monitoring",
    )
    assert not drain.is_eligible_for_drain_verification(
        status="successful", outcome_token="rollback_incomplete", outcome_kv="surfaces=monitoring,helm",
    )


def test_not_eligible_when_surfaces_is_a_strict_subset_missing_monitoring():
    assert not drain.is_eligible_for_drain_verification(
        status="successful", outcome_token="rollback_incomplete", outcome_kv="surfaces=netbox",
    )


def test_not_eligible_with_no_kv_at_all():
    assert not drain.is_eligible_for_drain_verification(
        status="successful", outcome_token="rollback_incomplete", outcome_kv=None,
    )


def test_not_eligible_with_other_kv_keys_but_no_surfaces():
    assert not drain.is_eligible_for_drain_verification(
        status="successful", outcome_token="rollback_incomplete", outcome_kv="request_id=" + "a" * 32,
    )


def test_failed_job_with_monitoring_surfaces_marker_is_never_eligible():
    # A4: dual-signal preserved — job status wins first, regardless of marker.
    assert not drain.is_eligible_for_drain_verification(
        status="failed", outcome_token="rollback_incomplete", outcome_kv="surfaces=monitoring",
    )


def test_F2_duplicate_surfaces_key_is_never_eligible():
    # codex round-1 F2: _sanitize_kv preserves duplicate valid keys
    # verbatim — a marker with BOTH surfaces=monitoring AND
    # surfaces=netbox must never resolve to whichever one this function
    # scans first; ambiguous -> ineligible, same as a missing key.
    assert not drain.is_eligible_for_drain_verification(
        status="successful", outcome_token="rollback_incomplete",
        outcome_kv="surfaces=monitoring surfaces=netbox",
    )
    assert not drain.is_eligible_for_drain_verification(
        status="successful", outcome_token="rollback_incomplete",
        outcome_kv="surfaces=monitoring surfaces=monitoring",
    )


# ---------------------------------------------------------------------------
# find_deploy_ops_for_run / find_deploy_target_for_run (D2 + F6 hardening)
# ---------------------------------------------------------------------------


def test_find_deploy_target_matches_deploy_op_by_run_id():
    ops = [_op("deploy", "mxl-videotestsrc", run_id="r1"), _op("rollback", "r1", run_id="r1")]
    assert drain.find_deploy_target_for_run(ops, "r1") == "mxl-videotestsrc"


def test_find_deploy_target_returns_none_when_no_match():
    ops = [_op("deploy", "mxl-videotestsrc", run_id="other")]
    assert drain.find_deploy_target_for_run(ops, "r1") is None


def test_find_deploy_target_ignores_non_deploy_actions():
    ops = [_op("teardown", "mxl-videotestsrc", run_id="r1"), _op("rollback", "r1", run_id="r1")]
    assert drain.find_deploy_target_for_run(ops, "r1") is None


def test_F6_multiple_deploy_ops_agreeing_on_target_are_not_ambiguous():
    # A reattach/manual-track can legitimately mint a second deploy
    # Operation for the same run_id — as long as they all agree on the
    # SAME catalog target, that's not an integrity problem.
    ops = [
        _op("deploy", "mxl-videotestsrc", run_id="r1"),
        _op("deploy", "mxl-videotestsrc", run_id="r1"),
    ]
    found = drain.find_deploy_ops_for_run(ops, "r1")
    assert found is not None and len(found) == 2
    assert drain.find_deploy_target_for_run(ops, "r1") == "mxl-videotestsrc"


def test_F6_multiple_deploy_ops_disagreeing_on_target_is_ambiguous():
    # codex round-1 F6 repro: two deploy records map the SAME run_id to
    # DIFFERENT catalog targets — OperationStore doesn't enforce run_id
    # uniqueness, so this must fail closed, never order-selected.
    ops = [
        _op("deploy", "wrong", run_id="r1"),
        _op("deploy", "actual", run_id="r1"),
    ]
    assert drain.find_deploy_ops_for_run(ops, "r1") is None
    assert drain.find_deploy_target_for_run(ops, "r1") is None


# ---------------------------------------------------------------------------
# _strip_to_host / exact-host matching (A10)
# ---------------------------------------------------------------------------


def test_strip_to_host_strips_scheme_path_and_port():
    assert drain._strip_to_host("http://foo.ns.svc.cluster.local:9000/status") == "foo.ns.svc.cluster.local"


def test_strip_to_host_bare_host_port_no_scheme_no_path():
    assert drain._strip_to_host("foo.ns.svc.cluster.local:9000") == "foo.ns.svc.cluster.local"


def test_strip_to_host_none_and_empty_and_non_string():
    assert drain._strip_to_host(None) is None
    assert drain._strip_to_host("") is None
    assert drain._strip_to_host(123) is None


def test_strip_to_host_foo_never_equals_foo_bar():
    # A10: exact host match — "foo" must never match "foo-bar" targets.
    assert drain._strip_to_host("foo.ns.svc.cluster.local:9000") != drain._strip_to_host("foo-bar.ns.svc.cluster.local:9000")
    hosts = {"foo.ns.svc.cluster.local"}
    assert drain._strip_to_host("foo-bar.ns.svc.cluster.local:9000") not in hosts
    assert drain._strip_to_host("prefix-foo.ns.svc.cluster.local:9000") not in hosts


def test_R4_strip_to_host_unparseable_but_truthy_strings_yield_none():
    # codex round-4: these are all non-empty strings (truthy) but parse to
    # an EMPTY/None host — the exact gap a truthiness-only validator missed.
    assert drain._strip_to_host(":") is None
    assert drain._strip_to_host("://") is None
    assert drain._strip_to_host("/path-only") is None
    assert drain._strip_to_host("://:9000") is None


def test_R4_strip_to_host_normal_host_port_path_still_validates():
    # Sanity: the fix must not reject a genuinely usable target.
    assert drain._strip_to_host("host.ns.svc.cluster.local:9000/probe/path") == "host.ns.svc.cluster.local"


# ---------------------------------------------------------------------------
# resolve_drain_targets (D2 + F4/F5 fail-closed boundary)
# ---------------------------------------------------------------------------


def test_resolve_drain_targets_none_when_entry_has_no_netbox_service(monkeypatch):
    assert drain.resolve_drain_targets(ENTRY_NO_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None
    assert drain.resolve_drain_targets(ENTRY_NO_PROVISION, netbox_url="http://nb.test", netbox_token="t") is None


def test_resolve_drain_targets_absent_record_derives_identity_from_catalog(monkeypatch):
    # ABSENT (run-created record already deleted by rollback's netbox
    # surface cleanup) -> H_run drain-expected, identity from the catalog
    # entry itself (the only source left — D2).
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    targets = drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t")
    assert targets == [drain.DrainTarget(cluster_service="mxl-videotestsrc", cluster_namespace="mxl")]
    assert targets[0].host == "mxl-videotestsrc.mxl.svc.cluster.local"


def test_resolve_drain_targets_present_without_probe_tag_uses_H_run_not_custom_fields(monkeypatch):
    # F4: present, NOT monitored -> H_run (catalog/override identity)
    # drain-expected, regardless of what the record's own custom_fields
    # happen to say — custom_fields are consulted ONLY for the retained-
    # exact-match decision below, never to redirect the expected identity.
    record = {
        "tags": [{"name": "dmf-catalog"}, {"name": "lifecycle:bootstrapped"}],
        "custom_fields": {"cluster_service": "some-other-live-value", "cluster_namespace": "mxl"},
    }
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 1, "results": [record]})
    targets = drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t")
    assert targets == [drain.DrainTarget(cluster_service="mxl-videotestsrc", cluster_namespace="mxl")]


def test_resolve_drain_targets_present_with_probe_tag_exact_match_is_excluded_retained(monkeypatch):
    # A5: restored pre-existing monitored record whose OWN identity is
    # EXACTLY H_run -> legitimately retained, EXCLUDED from the drain set.
    record = {
        "tags": [{"name": "dmf-catalog"}, {"name": "monitoring:probe"}],
        "custom_fields": {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl"},
    }
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 1, "results": [record]})
    targets = drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t")
    assert targets == []


def test_F4_present_with_probe_tag_but_different_identity_still_drain_expected(monkeypatch):
    # codex round-1 F4 repro: a restored pre-existing record legitimately
    # monitors a DIFFERENT host than this run's own projection — that
    # doesn't excuse H_run itself from draining. A naive "any monitoring:
    # probe tag means retained" check would wrongly exclude it.
    record = {
        "tags": [{"name": "dmf-catalog"}, {"name": "monitoring:probe"}],
        "custom_fields": {"cluster_service": "some-unrelated-service", "cluster_namespace": "mxl"},
    }
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 1, "results": [record]})
    targets = drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t")
    assert targets == [drain.DrainTarget(cluster_service="mxl-videotestsrc", cluster_namespace="mxl")]


def test_resolve_drain_targets_netbox_error_is_fail_closed_none(monkeypatch):
    def boom(*a, **k):
        raise netbox_module.NetboxAPIError(500, "boom")

    monkeypatch.setattr(netbox_module, "_request", boom)
    assert drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None


def test_resolve_drain_targets_present_with_string_tags_shape_and_matching_identity_is_retained(monkeypatch):
    # NetBox tags can arrive as bare strings, not {"name": ...} dicts
    # (tolerated the same way catalog.get_lifecycle_status handles it).
    record = {"tags": ["monitoring:probe"], "custom_fields": {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl"}}
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 1, "results": [record]})
    targets = drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t")
    assert targets == []


def test_F5_two_records_for_the_same_name_is_fail_closed_none(monkeypatch):
    # codex round-1 F5 repro: NetBox service names aren't guaranteed
    # unique by this code — an ambiguous name match must never trust
    # records[0] (a still-cached target on the second record would go
    # unchecked forever otherwise).
    retained = {"tags": [{"name": "monitoring:probe"}], "custom_fields": {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl"}}
    other = {"tags": [], "custom_fields": {}}
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 2, "results": [retained, other]})
    assert drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None


# --- F2 (round-2): NetBox list envelope validation --------------------------


def test_R2_F2_empty_body_envelope_is_fail_closed_none(monkeypatch):
    # codex round-2 F2 repro: an HTTP-200 EMPTY body ({}) must never read
    # as "zero results" (genuine absence) — it's unreadable, not absent.
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {})
    assert drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None


def test_R2_F2_missing_results_key_is_fail_closed_none(monkeypatch):
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0})
    assert drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None


def test_R2_F2_missing_count_key_is_fail_closed_none(monkeypatch):
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"results": []})
    assert drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None


def test_R2_F2_paginated_response_with_more_matches_is_fail_closed_none(monkeypatch):
    # codex round-2 F2 repro verbatim: count says 2 matching records exist,
    # but this page's results only carries 1 (a "next" page holds the
    # other) — count is authoritative and disagrees with len(results), so
    # this can never be trusted as "exactly one record".
    retained = {"tags": [{"name": "monitoring:probe"}], "custom_fields": {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl"}}
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 2, "next": "page2", "results": [retained]})
    assert drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None


def test_R2_F2_results_not_a_list_is_fail_closed_none(monkeypatch):
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": "nope"})
    assert drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None


def test_R2_F2_non_dict_envelope_is_fail_closed_none(monkeypatch):
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: [])
    assert drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None


def test_R2_F2_count_non_int_is_fail_closed_none(monkeypatch):
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": "0", "results": []})
    assert drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t") is None


def test_R2_F2_limit_2_requested_in_query(monkeypatch):
    captured = {}

    def fake_request(url, token, path, **k):
        captured["path"] = path
        return {"count": 0, "results": []}

    monkeypatch.setattr(netbox_module, "_request", fake_request)
    drain.resolve_drain_targets(ENTRY_SINGLE_SERVICE, netbox_url="http://nb.test", netbox_token="t")
    assert "limit=2" in captured["path"]


def test_F4_restored_custom_field_divergence_end_to_end(monkeypatch):
    # codex round-1 F4's own headline repro, reproduced verbatim: a
    # pre-existing unmonitored record's snapshot restores
    # cluster_service=legacy-svc, while this run's own deployed identity
    # (via catalog override) is run-svc. WP4 must still check run-svc, not
    # legacy-svc — a stale run-svc target in both seams must NOT read as
    # drained.
    entry = CatalogEntry(
        key="run-entry", display_name="Run entry", summary="",
        provision={
            "namespace": "ns",
            "netbox_service": {"name": "run-entry", "protocol": "tcp", "ports": [80], "cluster_service": "run-svc"},
        },
    )
    record = {
        "tags": [{"name": "dmf-catalog"}, {"name": "monitoring:probe"}],
        "custom_fields": {"cluster_service": "legacy-svc", "cluster_namespace": "ns"},
    }
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 1, "results": [record]})
    targets = drain.resolve_drain_targets(entry, netbox_url="http://nb.test", netbox_token="t")
    assert targets == [drain.DrainTarget(cluster_service="run-svc", cluster_namespace="ns")]

    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(
        promsd_module, "list_probe_targets",
        lambda **k: [{"targets": ["run-svc.ns.svc.cluster.local:80"], "labels": {}}],
    )
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained(targets, promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


# ---------------------------------------------------------------------------
# F4 DNS-label validation
# ---------------------------------------------------------------------------


def test_F4_whitespace_override_is_fail_closed_none(monkeypatch):
    entry = CatalogEntry(
        key="nmos-cpp", display_name="NMOS Registry", summary="",
        provision={
            "namespace": "nmos",
            "netbox_service": {"name": "nmos-cpp", "protocol": "tcp", "ports": [80], "cluster_service": "not a dns label"},
        },
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    assert drain.resolve_drain_targets(entry, netbox_url="http://nb.test", netbox_token="t") is None


def test_F4_invalid_chars_override_is_fail_closed_none(monkeypatch):
    entry = CatalogEntry(
        key="nmos-cpp", display_name="NMOS Registry", summary="",
        provision={
            "namespace": "nmos",
            "netbox_service": {"name": "nmos-cpp", "protocol": "tcp", "ports": [80], "cluster_service": "UPPER_CASE"},
        },
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    assert drain.resolve_drain_targets(entry, netbox_url="http://nb.test", netbox_token="t") is None


def test_F4_invalid_namespace_derived_from_provision_is_fail_closed_none(monkeypatch):
    entry = CatalogEntry(
        key="bad-ns", display_name="Bad namespace", summary="",
        provision={"namespace": "not valid", "netbox_service": {"name": "bad-ns", "protocol": "tcp", "ports": [80]}},
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    assert drain.resolve_drain_targets(entry, netbox_url="http://nb.test", netbox_token="t") is None


# ---------------------------------------------------------------------------
# A11 — optional catalog-declared cluster identity override (WP4 R1b: the
# dmf-media catalog schema gains optional netbox_service.cluster_service/
# cluster_namespace keys — a sibling dmf-media PR gives nmos-cpp.yaml
# cluster_service: nmos-cpp-registry, closing the false-green window the
# name-derived default has for that one diverging entry).
# ---------------------------------------------------------------------------

ENTRY_WITH_CLUSTER_SERVICE_OVERRIDE = CatalogEntry(
    key="nmos-cpp",
    display_name="NMOS Registry",
    summary="",
    provision={
        "namespace": "nmos",
        "netbox_service": {
            "name": "nmos-cpp", "protocol": "tcp", "ports": [80],
            "cluster_service": "nmos-cpp-registry",
        },
    },
)

ENTRY_WITH_MALFORMED_OVERRIDE = CatalogEntry(
    key="nmos-cpp",
    display_name="NMOS Registry",
    summary="",
    provision={
        "namespace": "nmos",
        "netbox_service": {"name": "nmos-cpp", "protocol": "tcp", "ports": [80], "cluster_service": ""},
    },
)


def test_A11a_absent_record_with_override_uses_declared_cluster_service(monkeypatch):
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    targets = drain.resolve_drain_targets(ENTRY_WITH_CLUSTER_SERVICE_OVERRIDE, netbox_url="http://nb.test", netbox_token="t")
    assert targets == [drain.DrainTarget(cluster_service="nmos-cpp-registry", cluster_namespace="nmos")]
    assert targets[0].host == "nmos-cpp-registry.nmos.svc.cluster.local"


def test_A11b_override_closes_the_false_green_window(monkeypatch):
    # The exact false-green the R1a report flagged: a live PromSD target
    # for the DECLARED identity (nmos-cpp-registry) must block drained —
    # the override is honored, not silently defaulted to the catalog name.
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    targets = drain.resolve_drain_targets(ENTRY_WITH_CLUSTER_SERVICE_OVERRIDE, netbox_url="http://nb.test", netbox_token="t")

    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(
        promsd_module, "list_probe_targets",
        lambda **k: [{"targets": ["nmos-cpp-registry.nmos.svc.cluster.local:80"], "labels": {}}],
    )
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained(targets, promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False

    # The name-derived host (nmos-cpp, no longer the identity once an
    # override is declared) must NOT block — it's not what PromSD would
    # actually compose for this entry anymore.
    monkeypatch.setattr(
        promsd_module, "list_probe_targets",
        lambda **k: [{"targets": ["nmos-cpp.nmos.svc.cluster.local:80"], "labels": {}}],
    )
    assert drain.check_drained(targets, promsd_url="http://promsd.test", prometheus_url="http://prom.test") is True


def test_A11c_malformed_override_is_fail_closed_none(monkeypatch):
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    assert drain.resolve_drain_targets(ENTRY_WITH_MALFORMED_OVERRIDE, netbox_url="http://nb.test", netbox_token="t") is None


def test_A11c_non_str_override_is_fail_closed_none(monkeypatch):
    entry = CatalogEntry(
        key="nmos-cpp", display_name="NMOS Registry", summary="",
        provision={
            "namespace": "nmos",
            "netbox_service": {"name": "nmos-cpp", "protocol": "tcp", "ports": [80], "cluster_service": 123},
        },
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    assert drain.resolve_drain_targets(entry, netbox_url="http://nb.test", netbox_token="t") is None


def test_A11_present_without_probe_always_uses_H_run_override(monkeypatch):
    # F4: present, not monitored -> H_run (the override) drain-expected,
    # regardless of custom_fields — custom_fields is never consulted here.
    record = {"tags": [{"name": "dmf-catalog"}], "custom_fields": {}}
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 1, "results": [record]})
    targets = drain.resolve_drain_targets(ENTRY_WITH_CLUSTER_SERVICE_OVERRIDE, netbox_url="http://nb.test", netbox_token="t")
    assert targets == [drain.DrainTarget(cluster_service="nmos-cpp-registry", cluster_namespace="nmos")]


# ---------------------------------------------------------------------------
# check_drained (D3/D4 fail-closed boundary — A6/A7/A10/F3)
# ---------------------------------------------------------------------------

TARGET = drain.DrainTarget(cluster_service="mxl-videotestsrc", cluster_namespace="mxl")


def test_check_drained_empty_drain_set_is_trivially_drained():
    assert drain.check_drained([], promsd_url="", prometheus_url="") is True


def test_check_drained_unconfigured_promsd_is_never_verified():
    # A6: unconfigured (empty url) -> pending, never an upgrade.
    assert drain.check_drained([TARGET], promsd_url="", prometheus_url="http://prom.test") is False


def test_check_drained_unconfigured_prometheus_is_never_verified():
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="") is False


def test_check_drained_true_when_neither_surface_has_the_target(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [{"targets": ["other.mxl.svc.cluster.local:9000"], "labels": {}}])
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE, {"labels": {"instance": "other.mxl.svc.cluster.local:9000"}}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is True


def test_check_drained_false_when_only_promsd_still_has_it(monkeypatch):
    # A7: only one surface drained -> not drained (both-must-agree).
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [{"targets": ["mxl-videotestsrc.mxl.svc.cluster.local:9000"], "labels": {}}])
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_check_drained_false_when_only_prometheus_still_has_it(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE, {"labels": {"instance": "mxl-videotestsrc.mxl.svc.cluster.local:9000"}}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_check_drained_matches_via_prometheus_discovered_param_target(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(
        monkeypatch,
        [SELF_SCRAPE, {"labels": {"instance": "blackbox:9115"}, "discoveredLabels": {"__param_target": "mxl-videotestsrc.mxl.svc.cluster.local:9000"}}],
    )
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_check_drained_promsd_error_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)

    def boom(**k):
        raise promsd_module.PromSDAPIError(500, "boom")

    monkeypatch.setattr(promsd_module, "list_probe_targets", boom)
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_check_drained_prometheus_error_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])

    def boom(*a, **k):
        raise prometheus_module.PrometheusAPIError(500, "boom")

    monkeypatch.setattr(prometheus_module, "_request", boom)
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_check_drained_exact_host_match_foo_bar_does_not_collide(monkeypatch):
    # A10 at the check_drained level: a target for a DIFFERENT, longer
    # service name must never be mistaken for a drain-set hit.
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(
        promsd_module, "list_probe_targets",
        lambda **k: [{"targets": ["mxl-videotestsrc-canary.mxl.svc.cluster.local:9000"], "labels": {}}],
    )
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is True


# --- F3a: PromSD readiness + malformed payload -----------------------------


def test_F3a_promsd_not_ready_is_fail_closed_false(monkeypatch):
    # The exact repro: a cold adapter serves 200 [] on /sd/probe while
    # /readyz is still 503 — must stay unverified, never read as drained.
    _mock_promsd_ready(monkeypatch, ready=False)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_F3a_promsd_malformed_non_list_payload_raises(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: {"not": "a-list"})
    try:
        promsd_module.list_probe_targets(url="http://promsd.test")
        assert False, "expected PromSDAPIError"
    except promsd_module.PromSDAPIError:
        pass


def test_F3a_promsd_malformed_payload_is_fail_closed_false_end_to_end(monkeypatch):
    # ready() only checks for a non-error response, not payload shape, so
    # a global _request stub returning a malformed dict still passes
    # readiness — it's list_probe_targets' own non-list check that must
    # catch this and fail the cycle closed.
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: {"not": "a-list"})
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


# --- F3 (round-2): PromSD empty-body + nested-shape validation -------------


def test_R2_F3_empty_response_body_raises(monkeypatch):
    # codex round-2 F3 repro: /sd/probe -> HTTP 200 with raw body b"" — not
    # valid JSON, must never silently degrade to [] (real-drain evidence).
    class _FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b""

    monkeypatch.setattr(promsd_module.urllib.request, "urlopen", lambda *a, **k: _FakeResp())
    try:
        promsd_module._request("http://promsd.test", "/sd/probe")
        assert False, "expected PromSDAPIError"
    except promsd_module.PromSDAPIError:
        pass


def test_R2_F3_empty_body_end_to_end_stays_pending(monkeypatch):
    _mock_promsd_ready(monkeypatch)

    def empty_body(*a, **k):
        raise promsd_module.PromSDAPIError(200, "empty response body")

    monkeypatch.setattr(promsd_module, "list_probe_targets", empty_body)
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R2_F3_group_targets_not_a_list_raises(monkeypatch):
    # codex round-2 F3 repro verbatim: a bare string is iterable in
    # Python, so {"targets": "not-a-list"} would otherwise be scanned
    # character-by-character by the host-matching loop instead of raising.
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: [{"targets": "not-a-list", "labels": {}}])
    try:
        promsd_module.list_probe_targets(url="http://promsd.test")
        assert False, "expected PromSDAPIError"
    except promsd_module.PromSDAPIError:
        pass


def test_R2_F3_group_targets_not_a_list_end_to_end_stays_pending(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: [{"targets": "not-a-list", "labels": {}}])
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R2_F3_group_not_a_dict_raises(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: ["not-a-dict"])
    try:
        promsd_module.list_probe_targets(url="http://promsd.test")
        assert False, "expected PromSDAPIError"
    except promsd_module.PromSDAPIError:
        pass


def test_R2_F3_target_empty_string_raises(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: [{"targets": [""], "labels": {}}])
    try:
        promsd_module.list_probe_targets(url="http://promsd.test")
        assert False, "expected PromSDAPIError"
    except promsd_module.PromSDAPIError:
        pass


def test_promsd_ready_true_on_canonical_payload(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: {"status": "ready", "ready": True})
    assert promsd_module.ready(url="http://promsd.test") is True


def test_promsd_ready_true_when_status_key_absent(monkeypatch):
    # status is only checked "if present" — ready alone is authoritative.
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: {"ready": True})
    assert promsd_module.ready(url="http://promsd.test") is True


def test_promsd_ready_false_on_error(monkeypatch):
    def boom(*a, **k):
        raise promsd_module.PromSDAPIError(503, "not ready")

    monkeypatch.setattr(promsd_module, "_request", boom)
    assert promsd_module.ready(url="http://promsd.test") is False


def test_R3_F2_ready_false_contradictory_200_body(monkeypatch):
    # codex round-3 F2 repro verbatim: HTTP 200 with ready=false — a
    # version/proxy/server inconsistency must never read as ready.
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: {"status": "stale", "ready": False})
    assert promsd_module.ready(url="http://promsd.test") is False


def test_R3_F2_ready_false_status_disagrees_with_ready_true(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: {"status": "stale", "ready": True})
    assert promsd_module.ready(url="http://promsd.test") is False


def test_R3_F2_ready_false_non_dict_body(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: ["ready"])
    assert promsd_module.ready(url="http://promsd.test") is False


def test_R3_F2_ready_false_missing_ready_key(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: {"status": "ready"})
    assert promsd_module.ready(url="http://promsd.test") is False


def test_R3_F2_ready_false_ready_truthy_but_not_bool_true(monkeypatch):
    # "ready is True" is an exact-identity check, not truthiness — a
    # stray "true" string or 1 must not slip through.
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: {"ready": "true"})
    assert promsd_module.ready(url="http://promsd.test") is False


def test_R3_F2_readyz_repro_end_to_end_stays_pending(monkeypatch):
    # codex round-3 F2's full repro: /readyz -> 200 {"status":"stale",
    # "ready":false}, /sd/probe -> [], and a valid non-matching Prometheus
    # self target — must stay unverified, never drained.
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: {"status": "stale", "ready": False})
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


# --- F3b/F3c: Prometheus malformed envelope / liveness sentinel -----------


def test_F3b_prometheus_non_dict_envelope_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    monkeypatch.setattr(prometheus_module, "_request", lambda *a, **k: [])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_F3b_prometheus_status_not_success_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    monkeypatch.setattr(prometheus_module, "_request", lambda *a, **k: {"status": "error", "data": {"activeTargets": [SELF_SCRAPE]}})
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_F3b_prometheus_missing_active_targets_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    monkeypatch.setattr(prometheus_module, "_request", lambda *a, **k: {"status": "success", "data": {}})
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_F3b_prometheus_data_not_a_dict_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    monkeypatch.setattr(prometheus_module, "_request", lambda *a, **k: {"status": "success", "data": "nope"})
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_F3c_prometheus_empty_active_targets_is_fail_closed_false(monkeypatch):
    # A live Prometheus always scrapes at least itself — a structurally
    # valid but EMPTY activeTargets list is itself implausible and must be
    # treated as a liveness-sentinel failure, not drain evidence.
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R3_F1_prometheus_row_with_no_labels_is_fail_closed_false(monkeypatch):
    # codex round-3 F1 repro verbatim: activeTargets=[{}] satisfies the
    # non-empty liveness sentinel while contributing no candidate host at
    # all — must never let the cycle read as drained.
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [{}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R3_F1_prometheus_row_not_a_dict_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, ["not-a-dict"])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R3_F1_prometheus_row_labels_not_a_dict_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [{"labels": "not-a-dict"}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R3_F1_prometheus_row_with_only_empty_instance_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [{"labels": {"instance": ""}}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R3_F1_prometheus_row_with_valid_param_target_is_accepted(monkeypatch):
    # Sanity: a row IS usable via discoveredLabels.__param_target alone
    # (no labels.instance) — this must not be rejected as malformed.
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [{"discoveredLabels": {"__param_target": "other.mxl.svc.cluster.local:9000"}}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is True


# --- F1 (round-4): validate with the matcher's own parser, not truthiness --


def test_R4_F1_prometheus_row_instance_colon_is_fail_closed_false(monkeypatch):
    # codex round-4 F1 repro verbatim: instance=":" is a non-empty
    # (truthy) string but _strip_to_host(":") is None — the row
    # contributes no real candidate host and must never read as drained.
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [{"labels": {"instance": ":"}}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R4_F1_prometheus_row_instance_scheme_only_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [{"labels": {"instance": "://"}}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R4_F1_prometheus_row_param_target_path_only_is_fail_closed_false(monkeypatch):
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [{"discoveredLabels": {"__param_target": "/path-only"}}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R4_F1_prometheus_row_normal_host_port_path_still_validates(monkeypatch):
    # Sanity: a genuinely usable, non-matching instance is still accepted
    # (drained stays True) — the stricter parser-based check must not
    # reject valid identities.
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "list_probe_targets", lambda **k: [])
    _mock_prometheus_envelope(monkeypatch, [{"labels": {"instance": "other.mxl.svc.cluster.local:9000/probe/path"}}])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is True


# --- F2 (round-4): same principle, applied to promsd targets ---------------


def test_R4_F2_promsd_target_colon_is_fail_closed_false(monkeypatch):
    # codex round-4 F2 repro verbatim: {"targets":[":"],"labels":{}} — a
    # non-empty (truthy) string that _strip_to_host(":") reduces to None.
    _mock_promsd_ready(monkeypatch)
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: [{"targets": [":"], "labels": {}}])
    _mock_prometheus_envelope(monkeypatch, [SELF_SCRAPE])
    assert drain.check_drained([TARGET], promsd_url="http://promsd.test", prometheus_url="http://prom.test") is False


def test_R4_F2_promsd_target_colon_raises_at_the_unit_level(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: [{"targets": [":"], "labels": {}}])
    try:
        promsd_module.list_probe_targets(url="http://promsd.test")
        assert False, "expected PromSDAPIError"
    except promsd_module.PromSDAPIError:
        pass


def test_R4_F2_promsd_target_scheme_only_raises(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: [{"targets": ["://"], "labels": {}}])
    try:
        promsd_module.list_probe_targets(url="http://promsd.test")
        assert False, "expected PromSDAPIError"
    except promsd_module.PromSDAPIError:
        pass


def test_R4_F2_promsd_target_path_only_raises(monkeypatch):
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: [{"targets": ["/path-only"], "labels": {}}])
    try:
        promsd_module.list_probe_targets(url="http://promsd.test")
        assert False, "expected PromSDAPIError"
    except promsd_module.PromSDAPIError:
        pass


def test_R4_F2_promsd_target_normal_host_port_path_still_validates(monkeypatch):
    # Sanity: a genuinely usable target string still passes validation.
    monkeypatch.setattr(promsd_module, "_request", lambda *a, **k: [{"targets": ["host.ns.svc.cluster.local:9000/probe/path"], "labels": {}}])
    result = promsd_module.list_probe_targets(url="http://promsd.test")
    assert result == [{"targets": ["host.ns.svc.cluster.local:9000/probe/path"], "labels": {}}]


# --- F3 (round-3): N-service normalization never partial -------------------


def test_R3_F3_mixed_valid_and_malformed_list_member_is_fail_closed_none(monkeypatch):
    # codex round-3 F3 repro verbatim: a declared 2-service list where the
    # second member is a bare string, not a dict. Filtering out just the
    # malformed member (leaving a 1-spec list that resolves trivially
    # retained/empty) would silently drop a real service from the drain
    # set — the whole declaration must fail closed instead.
    entry = CatalogEntry(
        key="two-service", display_name="Two service", summary="",
        provision={
            "namespace": "mxl",
            "netbox_service": [{"name": "mxl-videotestsrc"}, "malformed-second-service"],
        },
    )
    retained = {"tags": [{"name": "monitoring:probe"}], "custom_fields": {"cluster_service": "mxl-videotestsrc", "cluster_namespace": "mxl"}}
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 1, "results": [retained]})
    assert drain.resolve_drain_targets(entry, netbox_url="http://nb.test", netbox_token="t") is None


def test_R3_F3_empty_list_netbox_service_is_fail_closed_none(monkeypatch):
    entry = CatalogEntry(
        key="empty-list", display_name="Empty list", summary="",
        provision={"namespace": "mxl", "netbox_service": []},
    )
    assert drain.resolve_drain_targets(entry, netbox_url="http://nb.test", netbox_token="t") is None


def test_R3_F3_all_valid_list_members_still_resolves(monkeypatch):
    # Sanity: a properly-formed N-service list (every member a dict)
    # still resolves normally — this fix must not break the N>1 case.
    entry = CatalogEntry(
        key="two-service", display_name="Two service", summary="",
        provision={
            "namespace": "mxl",
            "netbox_service": [{"name": "svc-a"}, {"name": "svc-b"}],
        },
    )
    monkeypatch.setattr(netbox_module, "_request", lambda *a, **k: {"count": 0, "results": []})
    targets = drain.resolve_drain_targets(entry, netbox_url="http://nb.test", netbox_token="t")
    assert targets == [
        drain.DrainTarget(cluster_service="svc-a", cluster_namespace="mxl"),
        drain.DrainTarget(cluster_service="svc-b", cluster_namespace="mxl"),
    ]
