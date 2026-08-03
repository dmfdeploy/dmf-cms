"""POST /api/media-workloads/{slug}/purge — delete permanently (umbrella
#347, WO-A2b-2, operator ruling 2026-08-02).

Gate ladder, in order: role -> request_id mint -> reason -> typed
confirmation -> AWX-configured -> purgeability/preflight (fresh NetBox +
observed-state overlay, fail-closed) -> ops-store dedupe/conflict ->
facility-busy -> dispatch. Every refusal branch is audited and echoes
request_id (a deliberate strengthening over the lighter existing writes,
which only start auditing once ``reason`` is valid).

Two layers, same split as test_rollback_command.py (the closest existing
precedent — a shared-JT, non-catalog-key-keyed async write):
* Most gate-ladder tests monkeypatch ``media_workloads.resolve_purge_target``
  directly — this file's job is to prove the ROUTE's own branching, not
  re-prove NetBox/Prometheus plumbing (that's test_media_workloads_purge.py).
* The happy-path tests run the REAL ``resolve_purge_target`` against a
  mocked NetBox/Prometheus (netbox_module._request / prometheus_module.query)
  — proving the preflight and the dispatch extra_vars contract wire together
  end-to-end, exact-value asserted, including the empty-expected-ids case
  (tag-only residue, zero members — a VALID purge target).
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

import dmf_cms.main as main
from dmf_cms import media_workloads
from dmf_cms import netbox as netbox_module
from dmf_cms import prometheus as prometheus_module
from dmf_cms.main import create_app
from dmf_cms.operations import OperationState
from dmf_cms.settings import (
    AWXAutoscaleSettings,
    AWXSettings,
    MediaTenancySettings,
    NetboxSettings,
    PrometheusSettings,
    Settings,
)

OPERATOR = ("dmf-console-operator",)
VIEWER = ("dmf-console-viewer",)

SLUG = "studio-a"


def _settings(groups=OPERATOR, *, autoscale=False) -> Settings:
    return Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t"),
        awx_autoscale=(
            AWXAutoscaleSettings(enabled=True, helper_url="http://helper.test", bearer_token="b")
            if autoscale
            else AWXAutoscaleSettings(enabled=False)
        ),
        netbox=NetboxSettings(api_url="http://netbox.test", api_token="tok"),
        media_tenancy=MediaTenancySettings(mode="single"),
        prometheus=PrometheusSettings(url="http://prom.test"),
    )


def _client(groups=OPERATOR, **kwargs) -> TestClient:
    client = TestClient(create_app(settings=_settings(groups, **kwargs)))
    client.get("/auth/login", follow_redirects=False)
    return client


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    result = None
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    return result


def _post(client, body):
    return client.post(f"/api/media-workloads/{SLUG}/purge", json=body)


@pytest.fixture
def awx_spy(monkeypatch):
    """Spy on launch_job for the async finalise-purge dispatch — mirrors
    test_rollback_command.py's own awx_spy fixture exactly."""
    calls = []

    monkeypatch.setattr(main, "ensure_awx_awake", lambda **k: None)
    monkeypatch.setattr(main, "lookup_job_template_by_name", lambda **k: {"id": 7})

    def fake_launch(**kwargs):
        calls.append(kwargs)
        return 4242

    monkeypatch.setattr(main, "launch_job", fake_launch)
    monkeypatch.setattr(
        main, "get_job",
        lambda **k: {
            "status": "successful", "started": "t0", "finished": "t1",
            "event_processing_finished": True,
        },
    )
    monkeypatch.setattr(main, "get_job_events_for_task", lambda **k: [])
    monkeypatch.setattr(
        media_workloads, "purge_residue_present",
        lambda *a, **k: False,  # confirmed absent by default
    )
    return calls


# ---------------------------------------------------------------------------
# Gate ladder — role / reason / confirmation
# ---------------------------------------------------------------------------


def test_viewer_is_403_and_no_preflight_call(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("must not preflight before the role gate")

    monkeypatch.setattr(media_workloads, "resolve_purge_target", boom)
    client = _client(VIEWER)
    resp = _post(client, {"reason": "x", "confirm": SLUG})
    assert resp.status_code == 403
    assert "request_id" not in resp.json()


def test_viewer_in_media_engineers_group_is_still_403(monkeypatch):
    # umbrella #347: purge is gated on _require_min_role("operator") ALONE,
    # NOT _require_media_workloads_access's media-engineers-group OR-gate —
    # a plain viewer who is ALSO in the media-engineers group reaches
    # clear/switch-source's lighter gate but must still be refused here.
    def boom(*a, **k):
        raise AssertionError("must not preflight before the role gate")

    monkeypatch.setattr(media_workloads, "resolve_purge_target", boom)
    client = _client(("dmf-console-viewer", "media-engineers"))
    resp = _post(client, {"reason": "x", "confirm": SLUG})
    assert resp.status_code == 403


def test_reason_required_400_is_audited_and_echoes_request_id(caplog):
    import logging
    client = _client(OPERATOR)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        for body in ({}, {"reason": ""}, {"reason": "   "}):
            resp = _post(client, body)
            assert resp.status_code == 400, body
            assert resp.json()["error"] == "reason-required"
            assert resp.json()["request_id"]  # umbrella #347: minted before reason
    lines = _audit_lines(caplog)
    assert len(lines) == 3
    assert all("action=finalise-purge" in ln and "outcome=reason-required" in ln for ln in lines)


def test_confirm_missing_is_400_confirmation_required(monkeypatch, caplog):
    import logging

    def boom(*a, **k):
        raise AssertionError("must not preflight before confirmation is validated")

    monkeypatch.setattr(media_workloads, "resolve_purge_target", boom)
    client = _client(OPERATOR)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = _post(client, {"reason": "go"})
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"] == "confirmation-required"
    assert body["request_id"]
    assert SLUG not in str(body)  # never echo the expected phrase
    assert any("outcome=confirmation-required" in ln for ln in _audit_lines(caplog))


def test_confirm_mismatch_is_422_confirmation_mismatch(monkeypatch, caplog):
    import logging

    def boom(*a, **k):
        raise AssertionError("must not preflight on a confirmation mismatch")

    monkeypatch.setattr(media_workloads, "resolve_purge_target", boom)
    client = _client(OPERATOR)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = _post(client, {"reason": "go", "confirm": "not-the-slug"})
    assert resp.status_code == 422
    body = resp.json()
    assert body["error"] == "confirmation-mismatch"
    assert body["request_id"]
    assert SLUG not in str(body)  # never echo the expected phrase back
    assert any("outcome=confirmation-mismatch" in ln for ln in _audit_lines(caplog))


def test_awx_not_configured_is_503():
    client = TestClient(create_app(settings=Settings(
        runtime_mode="local", dev_login_enabled=True, dev_groups=OPERATOR,
        awx=AWXSettings(), netbox=NetboxSettings(api_url="http://netbox.test", api_token="t"),
        media_tenancy=MediaTenancySettings(mode="single"),
    )))
    client.get("/auth/login", follow_redirects=False)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 503


# ---------------------------------------------------------------------------
# Purgeability + fresh preflight (mocked at media_workloads.resolve_purge_target)
# ---------------------------------------------------------------------------


def test_not_purgeable_unassigned_or_invalid_multiple_is_422(monkeypatch):
    monkeypatch.setattr(media_workloads, "resolve_purge_target", lambda *a, **k: {"error": "not-purgeable"})
    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 422
    assert resp.json()["error"] == "not-purgeable"


def test_workload_not_found_is_404(monkeypatch):
    monkeypatch.setattr(media_workloads, "resolve_purge_target", lambda *a, **k: {"error": "workload-not-found"})
    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 404
    assert resp.json()["error"] == "workload-not-found"


@pytest.mark.parametrize("preflight_error", ["netbox-unreachable", "netbox-error", "observability-unavailable"])
def test_preflight_read_failures_all_refuse_409_observability_unavailable(monkeypatch, preflight_error):
    # umbrella #347: "a purge NEVER proceeds unverified" — a NetBox read
    # failure is treated the same as Prometheus being unreachable: the
    # console could not verify member state either way.
    monkeypatch.setattr(media_workloads, "resolve_purge_target", lambda *a, **k: {"error": preflight_error})
    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"] == "purge-preflight-refused"
    assert body["kind"] == "observability-unavailable"


def test_members_not_bootstrapped_is_409_with_member_ids(monkeypatch):
    monkeypatch.setattr(
        media_workloads, "resolve_purge_target",
        lambda *a, **k: {
            "members": [
                {"id": 1, "name": "a", "requested_state": "bootstrapped", "observed_state": "unknown"},
                {"id": 2, "name": "b", "requested_state": "active", "observed_state": "unknown"},
            ],
            "tag_present": True,
        },
    )
    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"] == "purge-preflight-refused"
    assert body["kind"] == "members-not-bootstrapped"
    assert body["members"] == [2]


def test_members_running_is_409_with_member_ids(monkeypatch):
    monkeypatch.setattr(
        media_workloads, "resolve_purge_target",
        lambda *a, **k: {
            "members": [
                {"id": 1, "name": "a", "requested_state": "bootstrapped", "observed_state": "running"},
                {"id": 2, "name": "b", "requested_state": "bootstrapped", "observed_state": "unknown"},
            ],
            "tag_present": True,
        },
    )
    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    body = resp.json()
    assert body["kind"] == "members-running"
    assert body["members"] == [1]


def test_members_not_bootstrapped_checked_before_members_running(monkeypatch):
    # Discriminates the gate ORDER: a member both not-bootstrapped AND
    # (irrelevantly) another member running must report the FIRST violation
    # the ladder hits (f's own ordering: not-bootstrapped, then running).
    monkeypatch.setattr(
        media_workloads, "resolve_purge_target",
        lambda *a, **k: {
            "members": [
                {"id": 1, "name": "a", "requested_state": "active", "observed_state": "unknown"},
                {"id": 2, "name": "b", "requested_state": "bootstrapped", "observed_state": "running"},
            ],
            "tag_present": True,
        },
    )
    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.json()["kind"] == "members-not-bootstrapped"


# ---------------------------------------------------------------------------
# Ops-store dedupe / conflict / facility-busy
# ---------------------------------------------------------------------------


def test_conflicting_active_operation_is_409(monkeypatch, awx_spy):
    monkeypatch.setattr(
        media_workloads, "resolve_purge_target",
        lambda *a, **k: {"members": [], "tag_present": True},
    )
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        # Pre-seed a conflicting in-flight teardown for the SAME slug.
        client.app.state.operations.create("teardown", SLUG)

        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 409
        body = resp.json()
        assert body["error"] == "conflicting lifecycle operation in progress"
        assert body["conflicting_operation"]["action"] == "teardown"
    assert awx_spy == []  # never launched


def test_reattaches_a_same_action_in_flight_operation_without_relaunching(monkeypatch, awx_spy):
    monkeypatch.setattr(
        media_workloads, "resolve_purge_target",
        lambda *a, **k: {"members": [], "tag_present": True},
    )
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        existing = client.app.state.operations.create("finalise-purge", SLUG)

        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 200
        assert resp.json()["operation_id"] == existing.operation_id
    assert awx_spy == []


# ---------------------------------------------------------------------------
# Happy path — REAL resolve_purge_target against mocked NetBox/Prometheus,
# exact extra_vars contract (names + values + the empty-list case)
# ---------------------------------------------------------------------------


def _service(name: str, tags: list[str], svc_id: int, custom_fields: dict | None = None) -> dict:
    return {
        "id": svc_id,
        "name": name,
        "tags": [{"name": t} for t in tags],
        "device": {"name": "node-1"},
        "ports": [9000],
        "protocol": {"value": "tcp"},
        "custom_fields": custom_fields or {},
    }


def test_happy_path_launches_with_exact_extra_vars_contract(monkeypatch, awx_spy):
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 99, "name": f"workload:{SLUG}"}]}
        return {
            "results": [
                _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, {"reason": "confirmed clean", "confirm": SLUG})
        assert resp.status_code == 202, resp.text
        dispatch_request_id = resp.json()["request_id"]
        _wait_for(lambda: awx_spy or None)

    assert len(awx_spy) == 1
    extra_vars = awx_spy[-1]["extra_vars"]
    assert set(extra_vars.keys()) == {
        "workload_slug", "purge_expected_service_ids", "purge_actor", "purge_role",
        "purge_reason", "l3_request_id",
    }
    assert extra_vars["workload_slug"] == SLUG
    assert extra_vars["purge_expected_service_ids"] == [11]
    assert extra_vars["purge_actor"] == "operator"
    assert extra_vars["purge_role"] == "operator"
    assert extra_vars["purge_reason"] == "confirmed clean"
    assert extra_vars["l3_request_id"] == dispatch_request_id
    assert len(extra_vars["l3_request_id"]) == 32


def test_happy_path_empty_members_tag_only_residue_is_a_valid_purge_target(monkeypatch, awx_spy):
    # umbrella #347 frozen decision: "Zero members with residue still
    # present is a VALID purge target (empty expected-ids list)".
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 99, "name": f"workload:{SLUG}"}]}
        return {"results": []}  # no member Services left

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, {"reason": "tag-only cleanup", "confirm": SLUG})
        assert resp.status_code == 202, resp.text
        _wait_for(lambda: awx_spy or None)

    assert len(awx_spy) == 1
    assert awx_spy[-1]["extra_vars"]["purge_expected_service_ids"] == []


def test_dispatched_operation_reaches_run_complete_with_purge_verified_at(monkeypatch, awx_spy):
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": []}
        return {"results": [_service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)]}

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])
    monkeypatch.setattr(media_workloads, "purge_residue_present", lambda *a, **k: False)

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 202, resp.text
        operation_id = resp.json()["operation_id"]

        def _resolved():
            op = client.app.state.operations.get(operation_id)
            return op if op is not None and op.state == OperationState.RUN_COMPLETE else None

        op = _wait_for(_resolved)

    assert op is not None
    assert op.action == "finalise-purge"
    assert op.purge_verified_at is not None


# ---------------------------------------------------------------------------
# FIX-A2b.4 (GATE-A2b.3) pinned regressions — five probe-proven findings.
# ---------------------------------------------------------------------------


def test_p1_1_invisible_running_member_refuses_members_unverifiable(monkeypatch):
    # codex's exact GATE-A2b.3 P1 fixture: a bootstrapped member that still
    # CLAIMS a monitoring identity (custom_fields.cluster_service set), but
    # Prometheus's own overlay reports a running sample under a DIFFERENT,
    # well-formed identity — the join never matches, so the member's own
    # observed_state used to silently fall to "unknown" (treated as "not
    # running") instead of being flagged unverifiable. Must refuse, never
    # launch.
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 99, "name": f"workload:{SLUG}"}]}
        return {
            "results": [
                _service(
                    "studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"],
                    svc_id=11, custom_fields={"cluster_service": "mxl-videotestsrc"},
                ),
            ]
        }

    def fake_prometheus(**kwargs):
        # Well-formed row (parses cleanly) — but for an UNRELATED identity,
        # never "mxl-videotestsrc". Not malformed, just genuinely unjoinable
        # for this member.
        return [
            {
                "metric": {"instance": "unrelated-svc.mxl.svc.cluster.local:9000/status", "job": "netbox-probe"},
                "value": [0, "1"],
            },
        ]

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", fake_prometheus)

    def boom(**k):
        raise AssertionError("must never launch on an unverifiable member")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"] == "purge-preflight-refused"
    assert body["kind"] == "members-unverifiable"
    assert body["members"] == [11]


def test_p1_1_malformed_overlay_row_refuses_observability_unavailable(monkeypatch):
    # Layer 1 (overlay integrity): a member with NO monitoring identity at
    # all would otherwise sail through — but if even ONE row in the SAME
    # overlay fetch is malformed (unparseable value here), the whole read
    # is untrustworthy. A damaged overlay is never partially trusted.
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 99, "name": f"workload:{SLUG}"}]}
        return {
            "results": [
                _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11),
            ]
        }

    def fake_prometheus(**kwargs):
        return [
            {"metric": {"instance": "mxl-videotestsrc.mxl.svc.cluster.local:9000/status"}, "value": [0, "not-a-number"]},
        ]

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", fake_prometheus)

    def boom(**k):
        raise AssertionError("must never launch against a malformed overlay")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    body = resp.json()
    assert body["kind"] == "observability-unavailable"


def test_p1_1_member_with_no_monitoring_identity_is_acceptable_unknown(monkeypatch, awx_spy):
    # Layer 3 — the NORMAL purge candidate: a fully-finalised member has no
    # cluster_service left at all, and the overlay itself is clean (nothing
    # malformed). "unknown" here is legitimately purgeable, not refused.
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 99, "name": f"workload:{SLUG}"}]}
        return {
            "results": [
                _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11),
            ]
        }

    def fake_prometheus(**kwargs):
        return [{"metric": {"instance": "some-other-thing.mxl.svc.cluster.local:9000/status"}, "value": [0, "1"]}]

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", fake_prometheus)

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 202, resp.text
        _wait_for(lambda: awx_spy or None)
    assert len(awx_spy) == 1


def _paginated_netbox(*, page1_results, page2_results, count, page2_next=None):
    """A 2-page NetBox ipam/services response — codex's exact GATE-A2b.3
    P1-2 fixture shape: count=1, non-null next, empty first page, the
    survivor sitting on the page a non-completeness-verified fetch would
    never follow to."""
    next_url = "http://netbox.test/api/ipam/services/?tag=dmf-catalog&limit=500&offset=500"

    def fake(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": []}
        if "offset=500" in path:
            return {"count": count, "next": page2_next, "previous": next_url, "results": page2_results}
        return {"count": count, "next": next_url, "previous": None, "results": page1_results}

    return fake


def test_p1_2_preflight_finds_survivor_across_a_paginated_read(monkeypatch, awx_spy):
    survivor = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(
        netbox_module, "_request",
        _paginated_netbox(page1_results=[], page2_results=[survivor], count=1),
    )
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 202, resp.text
        _wait_for(lambda: awx_spy or None)

    assert len(awx_spy) == 1
    assert awx_spy[-1]["extra_vars"]["purge_expected_service_ids"] == [11]


def test_p1_2_preflight_refuses_on_count_mismatch(monkeypatch):
    # count claims 2, but only 1 is ever returned across all pages (next
    # goes null after page 1) — an inconsistent read, never trusted.
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": []}
        return {
            "count": 2, "next": None,
            "results": [_service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)],
        }

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch on an incomplete read")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "source-read-incomplete"


def test_p1_2_preflight_refuses_when_the_page_cap_is_exceeded(monkeypatch):
    # `next` never goes null — a runaway pagination chain must fail fast,
    # not hang or silently stop at whatever it's fetched so far.
    def fake_netbox(*args, **kwargs):
        return {
            "count": 999,
            "next": "http://netbox.test/api/ipam/services/?tag=dmf-catalog&limit=500&offset=999999",
            "results": [],
        }

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch when the page cap is exceeded")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "source-read-incomplete"


def test_p1_2_post_job_residue_check_finds_survivor_across_pagination():
    # The post-job absence authority (purge_residue_present) must ALSO
    # follow pagination to exhaustion — the same fixture shape, this time
    # exercised directly (unit-level, not through the HTTP route).
    import dmf_cms.netbox as _netbox_mod

    survivor = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}"], svc_id=11)
    orig_request = _netbox_mod._request
    _netbox_mod._request = _paginated_netbox(page1_results=[], page2_results=[survivor], count=1)
    try:
        present = media_workloads.purge_residue_present(
            "http://netbox.test", "tok", False, SLUG,
        )
    finally:
        _netbox_mod._request = orig_request
    assert present is True


def test_p2_1_invalid_multiple_target_in_second_tag_position_refuses_422(monkeypatch):
    # codex's exact GATE-A2b.3 P2 fixture: a service tagged workload:other-
    # workload FIRST, then workload:studio-a SECOND. _workload_assignment
    # only ever reports the FIRST tag, so the old "skip on member_slug !=
    # slug, check invalid-multiple only after" ordering silently omitted
    # this service — the launcher would refuse the stale set, but dmf-cms
    # itself must never dispatch a doomed launch.
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 99, "name": f"workload:{SLUG}"}]}
        return {
            "results": [
                _service(
                    "studio-a-1",
                    ["dmf-catalog", "workload:other-workload", f"workload:{SLUG}", "lifecycle:bootstrapped"],
                    svc_id=11,
                ),
            ]
        }

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch against a stale/conflicting member set")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 422
    assert resp.json()["error"] == "not-purgeable"


def test_p2_2_string_id_from_netbox_refuses_source_inconsistent(monkeypatch):
    # codex's exact GATE-A2b.3 P2 fixture: a NetBox id surfacing as the
    # numeric STRING '11' instead of the int 11. The launcher's own frozen
    # contract (playbooks/finalise-purge.yml) asserts
    # purge_expected_service_ids are plain ints — dmf-cms must refuse
    # before creating an operation, never send ['11'] and let AWX's own
    # assert catch it after the fact.
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 99, "name": f"workload:{SLUG}"}]}
        svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
        svc["id"] = "11"  # NetBox drift: a string, not an int
        return {"results": [svc]}

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch with a non-int expected-service-id")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "source-inconsistent"
