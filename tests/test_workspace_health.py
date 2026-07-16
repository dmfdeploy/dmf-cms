"""Workspace "are we OK?" core endpoint (#174 WP2).

The contract is fail-soft: not-configured, unreachable, and
no-Watchdog are explicit 200 states, never raw 500s (Constitution
Arts. 1+8). Watchdog (the #166 deadman) flips watchdog_firing and is
excluded from the problem list.
"""

from fastapi.testclient import TestClient

from dmf_cms import prometheus as prometheus_module
from dmf_cms.main import create_app
from dmf_cms.settings import PrometheusSettings, Settings


def _client(prometheus_configured=True, groups=("dmf-console-viewer",)) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        prometheus=PrometheusSettings(url="http://prom.test") if prometheus_configured else PrometheusSettings(),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def _alert(name, severity, state="firing", extra_labels=None, **annotations):
    labels = {"alertname": name, "severity": severity, "instance": "node-1"}
    labels.update(extra_labels or {})
    return {
        "labels": labels,
        "annotations": annotations,
        "state": state,
        "activeAt": "2026-07-05T12:00:00Z",
    }


def test_anonymous_is_401():
    settings = Settings(runtime_mode="local", dev_login_enabled=True)
    client = TestClient(create_app(settings=settings))
    assert client.get("/api/workspace/health").status_code == 401


def test_unconfigured_is_explicit_dark_state():
    resp = _client(prometheus_configured=False).get("/api/workspace/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is False
    assert body["reason"] == "prometheus-not-configured"


def test_unreachable_is_degraded_content_never_500(monkeypatch):
    def boom(*, url):
        raise prometheus_module.PrometheusAPIError(500, "connection refused")

    monkeypatch.setattr(prometheus_module, "list_alerts", boom)
    resp = _client().get("/api/workspace/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is True
    assert body["reachable"] is False
    assert body["reason"] == "prometheus-unreachable"
    # No raw exception text leaks into the payload (Art. 8).
    assert "connection refused" not in resp.text


def test_watchdog_verifies_pipeline_and_is_not_a_problem(monkeypatch):
    monkeypatch.setattr(
        prometheus_module,
        "list_alerts",
        lambda *, url: [_alert("Watchdog", "none")],
    )
    body = _client().get("/api/workspace/health").json()
    assert body["watchdog_firing"] is True
    assert body["alerts"] == []


def test_alerts_flattened_and_sorted_by_severity(monkeypatch):
    monkeypatch.setattr(
        prometheus_module,
        "list_alerts",
        lambda *, url: [
            _alert("HostMemoryPressure", "warning", summary="memory tight"),
            _alert("Watchdog", "none"),
            _alert(
                "NodeDown",
                "critical",
                summary="node gone",
                runbook_url="https://runbooks.test#nodedown",
            ),
            _alert("HostFanMaxed", "info"),
        ],
    )
    body = _client().get("/api/workspace/health").json()
    assert body["reachable"] is True and body["watchdog_firing"] is True
    names = [a["name"] for a in body["alerts"]]
    # Info is floored out of "Current problems" (see the severity-floor test);
    # only critical + warning remain, critical-first.
    assert names == ["NodeDown", "HostMemoryPressure"]
    node_down = body["alerts"][0]
    assert node_down["severity"] == "critical"
    assert node_down["summary"] == "node gone"
    assert node_down["runbook_url"] == "https://runbooks.test#nodedown"
    assert node_down["instance"] == "node-1"


def test_below_warning_severities_are_floored_out_of_problems(monkeypatch):
    # Constitution Art. 4 / Alarm Philosophy: the below-warning advisory tiers
    # (info / advisory / notice) are not classified operator "problems" (not
    # necessary/unique/actionable). The "are we OK?" core drops them; they
    # live on the expert Monitoring lane (/api/monitoring/alerts), not here.
    monkeypatch.setattr(
        prometheus_module,
        "list_alerts",
        lambda *, url: [
            _alert("Watchdog", "none"),
            _alert("ContainerCPUThrottling", "info"),
            _alert("ContainerCPUThrottling", "info", extra_labels={"pod": "b"}),
            _alert("DiskFillingSlowly", "advisory"),
            _alert("CertExpiringSoon", "notice"),
        ],
    )
    body = _client().get("/api/workspace/health").json()
    assert body["alerts"] == []
    assert body["watchdog_firing"] is True


def test_unknown_severity_stays_fail_safe(monkeypatch):
    # A firing alert with a missing/unknown severity label must NOT be hidden
    # by the floor — never silence a real condition on a bad label.
    monkeypatch.setattr(
        prometheus_module,
        "list_alerts",
        lambda *, url: [
            _alert("Watchdog", "none"),
            _alert("MysteryCondition", ""),
        ],
    )
    body = _client().get("/api/workspace/health").json()
    names = [a["name"] for a in body["alerts"]]
    assert names == ["MysteryCondition"]


def test_pending_alerts_are_not_current_problems(monkeypatch):
    # GATE-22 P2: the core contracts on ALERTS{alertstate="firing"} — an
    # alert still inside its for: window must not count.
    monkeypatch.setattr(
        prometheus_module,
        "list_alerts",
        lambda *, url: [
            _alert("Watchdog", "none"),
            _alert("HostMemoryPressure", "warning", state="pending"),
            _alert("NodeDown", "critical", state="pending"),
        ],
    )
    body = _client().get("/api/workspace/health").json()
    assert body["alerts"] == []
    assert body["watchdog_firing"] is True


def test_pending_watchdog_does_not_verify_pipeline(monkeypatch):
    monkeypatch.setattr(
        prometheus_module,
        "list_alerts",
        lambda *, url: [_alert("Watchdog", "none", state="pending")],
    )
    body = _client().get("/api/workspace/health").json()
    assert body["watchdog_firing"] is False
    assert body["reason"] == "watchdog-missing"


def test_same_alertname_distinct_labels_get_distinct_ids(monkeypatch):
    # GATE-22 P2: identity is the full label set — one rule firing for two
    # pods with the same (blank) instance must yield two distinct rows.
    monkeypatch.setattr(
        prometheus_module,
        "list_alerts",
        lambda *, url: [
            _alert("Watchdog", "none"),
            _alert(
                "PodCrashLooping",
                "warning",
                extra_labels={"instance": "", "namespace": "mxl", "pod": "a"},
            ),
            _alert(
                "PodCrashLooping",
                "warning",
                extra_labels={"instance": "", "namespace": "nmos", "pod": "b"},
            ),
        ],
    )
    body = _client().get("/api/workspace/health").json()
    assert len(body["alerts"]) == 2
    ids = {a["id"] for a in body["alerts"]}
    assert len(ids) == 2
    contexts = sorted(a["context"] for a in body["alerts"])
    assert contexts == ["namespace=mxl pod=a", "namespace=nmos pod=b"]


def test_viewer_role_can_read_workspace_health(monkeypatch):
    monkeypatch.setattr(prometheus_module, "list_alerts", lambda *, url: [])
    resp = _client(groups=("dmf-console-viewer",)).get("/api/workspace/health")
    assert resp.status_code == 200
    body = resp.json()
    # Zero alerts and no Watchdog: reachable, but nothing verifies the
    # pipeline — the frontend must not render this as verified green, and
    # the contract names the state (GATE-22 P3).
    assert body["watchdog_firing"] is False
    assert body["reason"] == "watchdog-missing"
