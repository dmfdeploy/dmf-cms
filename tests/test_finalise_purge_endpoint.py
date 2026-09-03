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

import ast
import re
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


def _settings(groups=OPERATOR, *, autoscale=False, media_tenancy=None) -> Settings:
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
        media_tenancy=media_tenancy if media_tenancy is not None else MediaTenancySettings(mode="single"),
        prometheus=PrometheusSettings(url="http://prom.test"),
    )


def _client(groups=OPERATOR, **kwargs) -> TestClient:
    client = TestClient(create_app(settings=_settings(groups, **kwargs)))
    client.get("/auth/login", follow_redirects=False)
    return client


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("awx write:")]


_QUOTED = r"'(?:[^'\\]|\\.)*'"

_AUDIT_LINE_RE = re.compile(
    r"^awx write: (?:fmt=\d+ )?action=(?P<action>\S*) "
    rf"actor=(?P<actor>{_QUOTED}|\S*) role=(?P<role>\S*) "
    r"real_role=(?P<real_role>\S*) request_id=(?P<request_id>\S*) "
    rf"target=(?P<target>{_QUOTED}|\S*) "
    r"reason=(?P<reason>.*?) outcome=(?P<outcome>\S*) "
    rf"workload=(?P<workload>{_QUOTED}|\S*) capacity=(?P<capacity>{_QUOTED}|.*)$"
)

_QUOTED_FIELDS = ("actor", "target", "workload", "capacity")


def _parse_audit_line(line: str) -> dict[str, str]:
    """Parse one ``_audit_awx_write`` log line into its named C5 fields.

    FIX-A2b.9 (GATE-A2b.5R P2): never substring-search the raw line — its
    ``request_id`` is a random hex32 (``uuid4().hex``, no dashes) that can
    coincidentally contain any short digit sequence, making a bare
    ``"22" in line`` check flaky. Parse fields and assert on the parsed
    values instead.

    dmfdeploy/dmf-cms#140 (the writer fix, 2026-09-03): actor/target/
    workload/capacity are quoted (%r) at emission and every real line
    now carries a leading `fmt=2 ` marker; the `fmt=\\d+ ` token is
    skipped rather than captured — this test parser only needs the
    FIELDS, not the marker itself. This LOCAL parser stays deliberately
    more permissive than the real one: it un-quotes the four fields when
    they happen to be quoted, which is convenience for reading back
    whatever this file's own fixtures produced, not a claim about what
    the real reader accepts. `audit_events.parse_awx_write_line` is
    strict, not permissive — it requires a well-formed `fmt=2` marker
    and drops any line without one outright (operator decision,
    2026-09-03; see that module's STATUS NOTE), which this helper makes
    no attempt to model. The point of un-quoting here is only to keep
    this file's own assertions checking the same SEMANTIC value
    regardless of the field's wire representation.
    """
    match = _AUDIT_LINE_RE.match(line)
    assert match is not None, f"unparseable audit line: {line!r}"
    fields = match.groupdict()
    for name in _QUOTED_FIELDS:
        value = fields[name]
        if value.startswith("'") and value.endswith("'"):
            fields[name] = ast.literal_eval(value)
    return fields


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
            "count": 1,
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
        return {"count": 0, "results": []}  # no member Services left

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
        return {"count": 1, "results": [_service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)]}

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
            "count": 1,
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
            "count": 1,
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
            "count": 1,
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
            "count": 1,
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
        return {"count": 1, "results": [svc]}

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch with a non-int expected-service-id")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "source-inconsistent"


# ---------------------------------------------------------------------------
# FIX-A2b.5 (GATE-A2b.3R) pinned regressions — a micro round on FIX-A2b.4's
# OWN new code: completeness verification still failed open on a
# malformed/wrong-type count, layer-1 accepted a syntactically invalid
# Prometheus instance identity, and a NaN sample slipped through float().
# ---------------------------------------------------------------------------


def _members_page(*, count, results):
    def fake(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 99, "name": f"workload:{SLUG}"}]}
        page: dict = {"results": results}
        if count is not _MISSING:
            page["count"] = count
        return page

    return fake


_MISSING = object()


@pytest.mark.parametrize("bad_count", [_MISSING, True, 1.0, -1])
def test_p1r_malformed_count_refuses_source_read_incomplete(monkeypatch, bad_count):
    # codex's exact GATE-A2b.3R probes: count entirely absent, count=True
    # (a bool — Python's `1 != True` is False, so a naive numeric compare
    # would have silently accepted it), count=1.0 (a float, same silent-
    # accept risk), and a negative count. Every one must refuse — never
    # accepted as "the completeness check happens to pass".
    svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(netbox_module, "_request", _members_page(count=bad_count, results=[svc]))
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch on a malformed/wrong-type count")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409, bad_count
    assert resp.json()["kind"] == "source-read-incomplete", bad_count


def test_p1r_cross_page_count_mismatch_refuses_source_read_incomplete(monkeypatch):
    # Page 1 claims count=2 (with 1 result + a `next`); page 2 claims
    # count=1 (with 1 more result, next=None) — TOTAL collected is 2,
    # which happens to equal page 1's OWN claim, so a naive "capture count
    # from page 1 only, check once at the end" implementation would see
    # 2 == 2 and wrongly call this complete — even though the pages
    # disagree with EACH OTHER about the total. The count must be
    # cross-checked on every page, not just compared once against the
    # final tally.
    survivor = _service("studio-a-2", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=12)

    def fake(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": []}
        if "offset=500" in path:
            return {"count": 1, "next": None, "results": [survivor]}
        return {
            "count": 2, "next": "http://netbox.test/api/ipam/services/?tag=dmf-catalog&limit=500&offset=500",
            "results": [_service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)],
        }

    monkeypatch.setattr(netbox_module, "_request", fake)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch on a cross-page count mismatch")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "source-read-incomplete"


def test_p1r_malformed_instance_identity_refuses_observability_unavailable(monkeypatch):
    # codex's original GATE-A2b.3R probe used a bare hyphenated string
    # ("totally-not-a-valid-probe-target") as its "malformed" exemplar —
    # GATE-A2b.3R2 found that exact shape is actually a LEGITIMATE
    # dmf-promsd target (a bare single-label hostname, same shape as that
    # repo's own "device-one"-style records with no cluster_service), so
    # FIX-A2b.6 reclassifies it as ignorable, not malformed (see
    # test_p1r_ignorable_non_cluster_service_targets_never_refuse below).
    # A genuinely malformed instance — one that doesn't even look like a
    # valid host[:port][/path] target at all (a bare space is invalid in
    # any of those) — must still refuse.
    svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(netbox_module, "_request", _members_page(count=1, results=[svc]))
    monkeypatch.setattr(
        prometheus_module, "query",
        lambda **k: [{"metric": {"instance": "not a valid target at all"}, "value": [0, "1"]}],
    )

    def boom(**k):
        raise AssertionError("must never launch against a syntactically invalid instance identity")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "observability-unavailable"


def test_p1r_nan_sample_refuses_observability_unavailable(monkeypatch):
    # codex's exact GATE-A2b.3R probe: float("nan") parses cleanly via
    # float(), and min(1.0, nan) == 1.0 in Python (NaN comparisons are
    # always False, so min() picks the non-NaN operand) — silently
    # classifying as "running" regardless of the real sample. A non-finite
    # value is a malformed row, never a lifecycle classification.
    svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(netbox_module, "_request", _members_page(count=1, results=[svc]))
    monkeypatch.setattr(
        prometheus_module, "query",
        lambda **k: [
            {"metric": {"instance": "mxl-videotestsrc.mxl.svc.cluster.local:9000/status"}, "value": [0, "nan"]},
        ],
    )

    def boom(**k):
        raise AssertionError("must never launch on a NaN overlay sample")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "observability-unavailable"


# ---------------------------------------------------------------------------
# FIX-A2b.6 (GATE-A2b.3R2) pinned regressions — a second micro round on
# FIX-A2b.5's OWN strict-parser/count code: legitimate non-cluster-service
# dmf-promsd targets were wrongly refused (a real deadlock risk), port 0
# slipped through, a trailing newline could smuggle garbage past `$`, and
# int subclasses bypassed the count/id type checks.
# ---------------------------------------------------------------------------


def test_p1r2_ignorable_non_cluster_service_targets_never_refuse(monkeypatch, awx_spy):
    # codex's exact GATE-A2b.3R2 finding 1: dmf-promsd legitimately emits
    # "dmf.example.com:9100" (a service/VM with a metrics port, no
    # cluster_service) and bare "dmf.example.com" (an SNMP-only device) —
    # see ../dmf-promsd/src/dmf_promsd/sd.py's own tests/test_sd.py
    # fixtures, read read-only. Before this fix, EITHER row appearing
    # anywhere in the SAME probe_success series refused the whole purge
    # preflight (observability-unavailable) — a real facility with even
    # one monitored physical device would deadlock every purge attempt
    # permanently. Neither row corresponds to this purge's own member (no
    # cluster_service claimed), so both must be silently ignored, never
    # block the launch.
    svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(netbox_module, "_request", _members_page(count=1, results=[svc]))
    monkeypatch.setattr(
        prometheus_module, "query",
        lambda **k: [
            {"metric": {"instance": "dmf.example.com:9100"}, "value": [0, "1"]},
            {"metric": {"instance": "dmf.example.com"}, "value": [0, "1"]},
        ],
    )

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 202, resp.text
        _wait_for(lambda: awx_spy or None)

    assert len(awx_spy) == 1


def test_p1r2_joinable_target_with_port_zero_refuses_observability_unavailable(monkeypatch):
    # codex's exact GATE-A2b.3R2 finding 2: "svc.ns.svc.cluster.local:0"
    # parsed as a joinable cluster-service identity ("svc") with the
    # digits-only port pattern accepting "0" — an invalid port (1-65535)
    # masquerading as a legitimate identity. Looks like it's attempting to
    # BE a cluster-service target, just with broken data — malformed, not
    # ignorable.
    svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(netbox_module, "_request", _members_page(count=1, results=[svc]))
    monkeypatch.setattr(
        prometheus_module, "query",
        lambda **k: [{"metric": {"instance": "svc.ns.svc.cluster.local:0"}, "value": [0, "1"]}],
    )

    def boom(**k):
        raise AssertionError("must never launch against a port-0 joinable-shaped target")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "observability-unavailable"


def test_p1r2_trailing_newline_cannot_smuggle_garbage_past_the_anchor(monkeypatch):
    # codex's exact GATE-A2b.3R2 finding 3: a bare `.match()` against a
    # `...$`-terminated pattern is satisfiable just before an embedded
    # newline, so "<valid-target>\nGARBAGE" would still "match" — anything
    # after the newline rides along unexamined. \A/\Z + fullmatch must
    # reject this outright (malformed, never joinable).
    svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(netbox_module, "_request", _members_page(count=1, results=[svc]))
    monkeypatch.setattr(
        prometheus_module, "query",
        lambda **k: [
            {
                "metric": {"instance": "mxl-videotestsrc.mxl.svc.cluster.local:9000\nnot-actually-this-target"},
                "value": [0, "1"],
            },
        ],
    )

    def boom(**k):
        raise AssertionError("must never launch when a trailing newline smuggles extra content past the anchor")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "observability-unavailable"


class _IntSubclass(int):
    """codex's exact GATE-A2b.3R2 finding 4 fixture: a custom int subclass
    — isinstance(x, int) is True for this, but type(x) is int is False."""


def test_p1r2_int_subclass_count_refuses_source_read_incomplete(monkeypatch):
    svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(netbox_module, "_request", _members_page(count=_IntSubclass(1), results=[svc]))
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch on an int-subclass count")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "source-read-incomplete"


def test_p1r2_int_subclass_service_id_refuses_source_inconsistent(monkeypatch):
    svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=_IntSubclass(11))
    monkeypatch.setattr(netbox_module, "_request", _members_page(count=1, results=[svc]))
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch on an int-subclass service id")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "source-inconsistent"


# ---------------------------------------------------------------------------
# FIX-A2b.7 (operator review 2026-08-03) — tenancy escape pinned regressions.
# NetBox Tag objects carry no tenant field, so the global tag_exists() check
# can never itself prove a SCOPED caller owns a workload: a scoped operator
# targeting another tenant's slug got members=[] (correctly scoped) plus
# tag_present=True (the tag exists, just not in their tenant) and reached
# the legitimate-looking "tag-only residue" path — dispatching a purge
# against out-of-scope residue.
# ---------------------------------------------------------------------------

_TENANT_A = MediaTenancySettings(mode="scoped", group_tenant_map=(("dmf-console-operator", ("tenant-a",)),))


def _scoped_netbox(*, device_services: list, tag_exists: bool, unscoped_services: list | None = None):
    """A scoped-tenant NetBox double: the operator's own tenant (tenant-a)
    resolves to one device; that device's own catalog services are
    `device_services` (may be empty or carry an unrelated workload tag —
    either way, never the attacked slug); the global tag lookup reports
    `tag_exists` regardless of tenant (the vulnerability's own root cause).

    `unscoped_services` (FIX-A2b.8, GATE-A2b.5 P1) is what an UNSCOPED
    (no device/vm filter) services read returns — the completeness-of-
    authority check's own internal re-fetch. Defaults to `device_services`
    (i.e. "fully visible": the scoped and true membership coincide), which
    keeps every pre-FIX-A2b.8 caller of this fixture correct unchanged."""
    if unscoped_services is None:
        unscoped_services = device_services

    def fake(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 55, "name": f"workload:{SLUG}"}]} if tag_exists else {"results": []}
        if path.startswith("/api/dcim/devices/"):
            assert "tenant=tenant-a" in path
            return {"results": [{"id": 7}]}
        if path.startswith("/api/virtualization/virtual-machines/"):
            assert "tenant=tenant-a" in path
            return {"results": []}
        if "device_id=7" in path:
            return {"count": len(device_services), "results": device_services}
        # The unscoped completeness-of-authority re-fetch: no tenant/device
        # filter of any kind on the path at all.
        assert "device_id=" not in path
        return {"count": len(unscoped_services), "results": unscoped_services}

    return fake


def test_p1_7_scoped_operator_cross_tenant_tag_refuses_workload_not_found_no_disclosure(monkeypatch):
    # THE attack: SLUG belongs to another tenant. The operator's own
    # tenant-a has infrastructure (a device) but none of its services
    # carry workload:{SLUG} — members=[] once scoped. The global tag
    # lookup still reports the tag exists (it does, just for tenant-b).
    # Must refuse workload-not-found — same as genuinely absent — never
    # dispatch, never a distinct error kind that discloses cross-tenant
    # existence.
    monkeypatch.setattr(netbox_module, "_request", _scoped_netbox(device_services=[], tag_exists=True))
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch a purge against out-of-scope cross-tenant residue")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR, media_tenancy=_TENANT_A)
    attack_resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert attack_resp.status_code == 404
    attack_body = attack_resp.json()
    assert attack_body["error"] == "workload-not-found"

    # Byte-identical (aside from the per-request request_id) to the
    # genuinely-absent case — the response must not distinguish "this
    # workload never existed" from "it exists, just not in your scope".
    monkeypatch.setattr(netbox_module, "_request", _scoped_netbox(device_services=[], tag_exists=False))
    genuinely_absent_client = _client(OPERATOR, media_tenancy=_TENANT_A)
    absent_resp = _post(genuinely_absent_client, {"reason": "go", "confirm": SLUG})
    assert absent_resp.status_code == attack_resp.status_code
    absent_body = absent_resp.json()
    attack_body.pop("request_id", None)
    absent_body.pop("request_id", None)
    assert attack_body == absent_body


def test_p1_7_scoped_operator_cross_tenant_tag_audit_outcome_matches_absent_case(monkeypatch, caplog):
    import logging

    monkeypatch.setattr(netbox_module, "_request", _scoped_netbox(device_services=[], tag_exists=True))
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])
    monkeypatch.setattr(main, "launch_job", lambda **k: (_ for _ in ()).throw(AssertionError("must never launch")))

    client = _client(OPERATOR, media_tenancy=_TENANT_A)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 404
    lines = _audit_lines(caplog)
    assert any("outcome=workload-not-found" in ln for ln in lines)
    # No distinct outcome token anywhere (e.g. nothing naming a conflict/
    # cross-tenant/tag-exists condition) — same audited outcome as a
    # genuinely absent workload.
    assert not any("cross-tenant" in ln or "tag-exists" in ln or "not-purgeable" in ln for ln in lines)


def test_p1_7_unscoped_caller_tag_only_residue_still_dispatches(monkeypatch, awx_spy):
    # Regression guard (decision 3/5b): the UNSCOPED (admin/global) caller
    # keeps the legitimate tag-only-residue purge target unchanged — this
    # is the SAME scenario test_happy_path_empty_members_tag_only_residue_
    # is_a_valid_purge_target already pins (mode="single" -> tenant_slugs
    # is None throughout this whole file); restated explicitly here as
    # this fix round's own dedicated regression.
    def fake_netbox(*args, **kwargs):
        path = args[2]
        if "/api/extras/tags/" in path:
            return {"results": [{"id": 99, "name": f"workload:{SLUG}"}]}
        return {"count": 0, "results": []}

    monkeypatch.setattr(netbox_module, "_request", fake_netbox)
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, {"reason": "tag-only cleanup", "confirm": SLUG})
        assert resp.status_code == 202, resp.text
        _wait_for(lambda: awx_spy or None)

    assert len(awx_spy) == 1
    assert awx_spy[-1]["extra_vars"]["purge_expected_service_ids"] == []


def test_p1_7_scoped_operator_with_own_members_present_is_unaffected(monkeypatch, awx_spy):
    # Regression guard (decision 5c): a scoped operator purging a workload
    # THEY legitimately own (their own tenant's services carry the tag)
    # must be entirely unaffected by this fix.
    svc = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(netbox_module, "_request", _scoped_netbox(device_services=[svc], tag_exists=True))
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True, media_tenancy=_TENANT_A))) as client:
        client.get("/auth/login", follow_redirects=False)
        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 202, resp.text
        _wait_for(lambda: awx_spy or None)

    assert len(awx_spy) == 1
    assert awx_spy[-1]["extra_vars"]["purge_expected_service_ids"] == [11]


# ---------------------------------------------------------------------------
# FIX-A2b.8 (GATE-A2b.5, authorization-axis gate) pinned regressions.
# P1 — completeness of authority: a scoped caller's non-empty, visible
# member list can still be a PARTIAL view of the workload's true (unscoped)
# membership; dispatching from a partial view launches a purge whose
# extra_vars cover only the visible subset while the global workload Tag
# deletion removes every tenant's grouping regardless.
# P2 — operations were not tenant-isolated: dedupe/reattach/conflict/
# facility-busy keyed only on action+global slug, disclosing full operation
# dicts (incl. another tenant's initiator) cross-tenant.
# ---------------------------------------------------------------------------


def test_p1_8_scoped_operator_straddle_refuses_workload_not_fully_visible(monkeypatch, caplog):
    import logging

    # THE probe from the gate verdict: tenant-a's own scoped read sees
    # Service 11; Service 22 (tenant-b's) is tagged with the SAME
    # workload:{SLUG} but sits entirely outside tenant-a's scope.
    svc_11 = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    svc_22 = _service("studio-a-2", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=22)
    monkeypatch.setattr(
        netbox_module, "_request",
        _scoped_netbox(device_services=[svc_11], tag_exists=True, unscoped_services=[svc_11, svc_22]),
    )
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])

    def boom(**k):
        raise AssertionError("must never launch a purge whose extra_vars cover only a partial workload")

    monkeypatch.setattr(main, "launch_job", boom)

    client = _client(OPERATOR, media_tenancy=_TENANT_A)
    with caplog.at_level(logging.INFO, logger="dmf_cms.main"):
        resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["error"] == "not-purgeable"
    assert body["kind"] == "workload-not-fully-visible"
    # No out-of-scope detail (counts, ids, tenant names) anywhere in the
    # body — the kind alone is the legible reason (decision #1).
    assert set(body.keys()) - {"request_id"} == {"error", "kind"}

    lines = _audit_lines(caplog)
    parsed = [_parse_audit_line(ln) for ln in lines]
    assert any(p["outcome"] == "workload-not-fully-visible" for p in parsed)
    # No out-of-scope detail anywhere in the parsed fields (GATE-A2b.5R P2:
    # never substring-search the raw line — request_id is random hex and
    # can coincidentally contain "22"). target is the slug alone; workload/
    # capacity are unused by this call site (logged as "" via `x or ""`).
    assert all(p["target"] == SLUG for p in parsed)
    assert all(p["workload"] == "" and p["capacity"] == "" for p in parsed)


def test_p1_8_slug_coincidentally_shared_across_tenants_refuses_workload_not_fully_visible(monkeypatch):
    # Decision #2: the SAME rule covers, by construction, two entirely
    # independent workloads that merely happen to share the slug name
    # "studio-a" in different tenants — from here that looks identical to
    # one workload straddling both, and both must refuse identically.
    tenant_a_own = _service(
        "tenant-a-owned", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11,
    )
    tenant_b_own = _service(
        "tenant-b-owned-unrelated", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=99,
    )
    monkeypatch.setattr(
        netbox_module, "_request",
        _scoped_netbox(
            device_services=[tenant_a_own], tag_exists=True,
            unscoped_services=[tenant_a_own, tenant_b_own],
        ),
    )
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])
    monkeypatch.setattr(main, "launch_job", lambda **k: (_ for _ in ()).throw(AssertionError("must never launch")))

    client = _client(OPERATOR, media_tenancy=_TENANT_A)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["error"] == "not-purgeable"
    assert body["kind"] == "workload-not-fully-visible"


def test_p1_8_unscoped_caller_unaffected_by_new_authorization_checks(monkeypatch, awx_spy):
    # Decision #3 + #7 "unscoped unchanged": an unscoped (admin/global,
    # tenant_slugs is None) caller is never subject to either FIX-A2b.8
    # check. P1's completeness re-fetch only runs when tenant_slugs is not
    # None (the whole existing single-mode suite already pins this for the
    # membership check); this test pins the P2 side — an unscoped caller
    # reattaching to an op some OTHER caller's scope created still sees it
    # in full, since ``purge_op_visible_to_scope`` is unconditional for an
    # unscoped caller.
    monkeypatch.setattr(
        media_workloads, "resolve_purge_target",
        lambda *a, **k: {"members": [], "tag_present": True},
    )
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True))) as client:
        client.get("/auth/login", follow_redirects=False)
        existing, _created, _conflict = client.app.state.operations.get_or_create_exclusive(
            action="finalise-purge", target=SLUG,
            conflicts=("deploy", "teardown", "rollback", "finalise-purge"),
            request_id="tenant-b-request", initiator="tenant-b-user",
            purge_tenant_scope=("tenant-b",),
        )

        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["operation_id"] == existing.operation_id
        assert body["initiator"] == "tenant-b-user"
    assert awx_spy == []


def test_p1_8_scoped_operator_cross_tenant_operation_minimal_disclosure(monkeypatch):
    # THE other probe from the gate verdict: a finalise-purge operation on
    # the SAME slug already in flight, initiated by tenant-b. A scoped
    # tenant-a caller for the same slug must NOT reattach with tenant-b's
    # initiator/operation_id/dict — same minimal 409 the genuinely-conflict
    # path uses.
    monkeypatch.setattr(
        media_workloads, "resolve_purge_target",
        lambda *a, **k: {"members": [], "tag_present": True},
    )

    def boom(**k):
        raise AssertionError("must never launch")

    monkeypatch.setattr(main, "launch_job", boom)

    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True, media_tenancy=_TENANT_A))) as client:
        client.get("/auth/login", follow_redirects=False)
        existing, _created, _conflict = client.app.state.operations.get_or_create_exclusive(
            action="finalise-purge", target=SLUG,
            conflicts=("deploy", "teardown", "rollback", "finalise-purge"),
            request_id="tenant-b-request", initiator="tenant-b-user",
            purge_tenant_scope=("tenant-b",),
        )

        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 409, resp.text
        body = resp.json()
        assert body["error"] == "conflicting lifecycle operation in progress"
        assert "operation_id" not in body
        assert "initiator" not in body
        assert "conflicting_operation" not in body
        assert set(body.keys()) - {"request_id"} == {"error"}
        assert existing.initiator == "tenant-b-user"  # sanity: really was tenant-b's op


def test_p1_8_scoped_operator_own_operation_reattach_still_returns_full_dict(monkeypatch, awx_spy):
    # Decision #4's own carve-out: a caller's OWN in-scope operation keeps
    # the existing reattach behavior unchanged (200 + full dict).
    monkeypatch.setattr(
        media_workloads, "resolve_purge_target",
        lambda *a, **k: {"members": [], "tag_present": True},
    )
    with TestClient(create_app(settings=_settings(OPERATOR, autoscale=True, media_tenancy=_TENANT_A))) as client:
        client.get("/auth/login", follow_redirects=False)
        existing, _created, _conflict = client.app.state.operations.get_or_create_exclusive(
            action="finalise-purge", target=SLUG,
            conflicts=("deploy", "teardown", "rollback", "finalise-purge"),
            request_id="tenant-a-request", initiator="tenant-a-user",
            purge_tenant_scope=("tenant-a",),
        )

        resp = _post(client, {"reason": "go", "confirm": SLUG})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["operation_id"] == existing.operation_id
        assert body["initiator"] == "tenant-a-user"
    assert awx_spy == []


# ---------------------------------------------------------------------------
# FIX-A2b.9 (GATE-A2b.5R) pinned regressions — the completeness-of-authority
# rule replaced: membership for the comparison is "slug among workload:*
# tags, any position" (not _workload_assignment()'s first-tag-only return),
# computed identically for both sides, and the two id sets must be EXACTLY
# EQUAL — a strict superset (true_ids has more) is the ordinary straddle
# (422 workload-not-fully-visible); any OTHER inequality (scoped_ids has
# members true_ids lacks, or the sets are disjoint) is a fail-closed READ
# problem (409 source-read-incomplete), not an authorization question.
# ---------------------------------------------------------------------------


def test_p1_9_out_of_scope_member_second_workload_tag_is_not_missed(monkeypatch):
    # codex's exact probe: the out-of-scope service's slug is its SECOND
    # workload:* tag. The old _workload_assignment()-based true-membership
    # computation only ever reported the FIRST tag ("other"), silently
    # dropping this member from true_ids and letting scoped_ids == true_ids
    # (both {11}) pass as "fully visible" when it wasn't.
    svc_11 = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    svc_second_tag = _service(
        "tenant-b-multi-tagged",
        ["dmf-catalog", "workload:other", f"workload:{SLUG}", "lifecycle:bootstrapped"],
        svc_id=33,
    )
    monkeypatch.setattr(
        netbox_module, "_request",
        _scoped_netbox(device_services=[svc_11], tag_exists=True, unscoped_services=[svc_11, svc_second_tag]),
    )
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])
    monkeypatch.setattr(main, "launch_job", lambda **k: (_ for _ in ()).throw(AssertionError("must never launch")))

    client = _client(OPERATOR, media_tenancy=_TENANT_A)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 422, resp.text
    assert resp.json()["kind"] == "workload-not-fully-visible"


def test_p1_9_inverse_empty_unscoped_read_fails_closed_source_read_incomplete(monkeypatch):
    # An empty unscoped read against a non-empty scoped read is not the
    # ordinary straddle (true_ids is not a superset — it's empty, smaller
    # than scoped_ids) — the old subset test (`true_ids <= scoped_ids`)
    # wrongly passed this as "fully visible" and dispatched. The two reads
    # of the SAME workload contradicting each other is a read problem.
    svc_11 = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    monkeypatch.setattr(
        netbox_module, "_request",
        _scoped_netbox(device_services=[svc_11], tag_exists=True, unscoped_services=[]),
    )
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])
    monkeypatch.setattr(main, "launch_job", lambda **k: (_ for _ in ()).throw(AssertionError("must never launch")))

    client = _client(OPERATOR, media_tenancy=_TENANT_A)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["error"] == "purge-preflight-refused"
    assert body["kind"] == "source-read-incomplete"


def test_p1_9_disjoint_scoped_and_unscoped_membership_fails_closed(monkeypatch):
    # scoped_ids={11}, true_ids={77} — disjoint, neither a superset nor a
    # subset of the other. Not an authorization question (there's no
    # "more" the caller lacks visibility into) — the two reads simply
    # disagree about which services carry this slug at all.
    svc_11 = _service("studio-a-1", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=11)
    svc_77 = _service("studio-a-elsewhere", ["dmf-catalog", f"workload:{SLUG}", "lifecycle:bootstrapped"], svc_id=77)
    monkeypatch.setattr(
        netbox_module, "_request",
        _scoped_netbox(device_services=[svc_11], tag_exists=True, unscoped_services=[svc_77]),
    )
    monkeypatch.setattr(prometheus_module, "query", lambda **k: [])
    monkeypatch.setattr(main, "launch_job", lambda **k: (_ for _ in ()).throw(AssertionError("must never launch")))

    client = _client(OPERATOR, media_tenancy=_TENANT_A)
    resp = _post(client, {"reason": "go", "confirm": SLUG})
    assert resp.status_code == 409, resp.text
    assert resp.json()["kind"] == "source-read-incomplete"
