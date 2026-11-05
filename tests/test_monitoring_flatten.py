"""Monitoring page endpoints flatten raw Prometheus rows (#451).

The page reads ``name``, ``summary``, ``job`` and ``instance`` at the top
level, while Prometheus nests them under ``labels`` and ``annotations``.
"""

from fastapi.testclient import TestClient

from dmf_cms import prometheus as prometheus_module
from dmf_cms.main import create_app
from dmf_cms.settings import PrometheusSettings, Settings

ALERTS_ENVELOPE = {
    "status": "success",
    "data": {
        "alerts": [
            {
                "labels": {"alertname": "NodeDown", "severity": "critical", "instance": "node-1"},
                "annotations": {"summary": "node gone", "description": "no scrape for 5m"},
                "state": "firing",
                "activeAt": "2026-07-05T12:00:00.123456789Z",
                "value": "1e+00",
            }
        ]
    },
}

TARGETS_ENVELOPE = {
    "status": "success",
    "data": {
        "activeTargets": [
            {
                "discoveredLabels": {"__address__": "192.0.2.10:9100"},
                "labels": {"instance": "192.0.2.10:9100", "job": "node-exporter"},
                "scrapePool": "node-exporter",
                "health": "up",
                "lastError": "",
                "lastScrape": "2026-07-05T12:00:05.5Z",
            }
        ],
        "droppedTargets": [],
    },
}


def _client(monkeypatch) -> TestClient:
    def fake_request(url, path, params=None):
        return ALERTS_ENVELOPE if path == "/api/v1/alerts" else TARGETS_ENVELOPE

    monkeypatch.setattr(prometheus_module, "_request", fake_request)
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=("dmf-console-viewer",),
        prometheus=PrometheusSettings(url="http://prom.test"),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def test_alerts_endpoint_flattens_labels_and_annotations(monkeypatch):
    body = _client(monkeypatch).get("/api/monitoring/alerts").json()
    assert body["alerts"] == [
        {
            "name": "NodeDown",
            "state": "firing",
            "severity": "critical",
            "summary": "node gone",
            "description": "no scrape for 5m",
            "activeAt": "2026-07-05T12:00:00.123456789Z",
        }
    ]


def test_targets_endpoint_flattens_labels(monkeypatch):
    body = _client(monkeypatch).get("/api/monitoring/targets").json()
    assert body["targets"] == [
        {
            "job": "node-exporter",
            "instance": "192.0.2.10:9100",
            "health": "up",
            "lastScrape": "2026-07-05T12:00:05.5Z",
            "lastError": "",
        }
    ]


def test_list_alerts_stays_raw_for_workspace_health(monkeypatch):
    monkeypatch.setattr(prometheus_module, "_request", lambda url, path, params=None: ALERTS_ENVELOPE)
    raw = prometheus_module.list_alerts(url="http://prom.test")
    assert raw[0]["labels"]["alertname"] == "NodeDown"
