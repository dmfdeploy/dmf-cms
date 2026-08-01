"""Recent-changes endpoint fail-soft contract (dmfdeploy/dmfdeploy#285).

/api/changes/jobs used to return a raw 500 on any AWX failure, which the
Workspace widget collapsed into "temporarily unavailable. Retrying
automatically." — indistinguishable from a console bug on an env where AWX
is deliberately scaled to zero. The endpoint now mirrors
/api/workspace/health: every outcome is a 200 carrying an explicit reason
token (Constitution Arts. 1+8).

The scale-to-zero signature is a REFUSED CONNECTION (the Service resolves
but has no endpoints). We can see that the API is not accepting
connections; we cannot see why. So the token is "awx-not-running", never
"asleep".
"""

import urllib.error

import pytest
from fastapi.testclient import TestClient

from dmf_cms import main as main_module
from dmf_cms.awx import AWXAPIError, AWXTransportError, is_connection_refused
from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import AWXAutoscaleSettings, AWXSettings, Settings


def _client(*, awx=True, autoscale=True, groups=("dmf-console-viewer",)) -> TestClient:
    settings = Settings(
        runtime_mode="local",
        dev_login_enabled=True,
        dev_groups=groups,
        awx=AWXSettings(api_url="http://awx.test", api_token="t") if awx else AWXSettings(),
        awx_autoscale=AWXAutoscaleSettings(
            enabled=autoscale,
            helper_url="http://helper.test" if autoscale else "",
            bearer_token="b" if autoscale else "",
        ),
    )
    client = TestClient(create_app(settings=settings))
    client.get("/auth/login", follow_redirects=False)
    return client


def _raise(exc):
    def _boom(**kwargs):
        raise exc

    return _boom


def _refused() -> urllib.error.URLError:
    """The exact shape urllib produces against a 0-endpoint Service.

    Verified on the live env: the console pod gets
    URLError(ConnectionRefusedError(111, 'Connection refused')).
    """
    return urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))


# ---------------------------------------------------------------- classifier


def test_is_connection_refused_matches_the_scale_to_zero_signature():
    assert is_connection_refused(_refused()) is True


@pytest.mark.parametrize(
    "exc",
    [
        urllib.error.URLError(TimeoutError("timed out")),
        urllib.error.URLError(OSError(101, "Network is unreachable")),
        AWXTransportError("read reset", phase="read"),
        AWXAPIError(500, "boom"),
        AWXAPIError(401, "nope"),
        RuntimeError("unexpected"),
    ],
)
def test_is_connection_refused_rejects_every_other_failure(exc):
    # A refused connection is a specific, narrow claim — anything vaguer
    # must fall through to the honest "unreachable" state.
    assert is_connection_refused(exc) is False


def test_http_error_is_not_a_refused_connection():
    # HTTPError subclasses URLError, and its .reason can be anything; AWX
    # answering with a status is never "not running".
    exc = urllib.error.HTTPError("http://awx.test", 503, "unavailable", {}, None)
    assert is_connection_refused(exc) is False


# ------------------------------------------------------------------ endpoint


def test_anonymous_is_401():
    settings = Settings(runtime_mode="local", dev_login_enabled=True)
    client = TestClient(create_app(settings=settings))
    assert client.get("/api/changes/jobs").status_code == 401


def test_unconfigured_is_an_explicit_token_not_silent_emptiness():
    resp = _client(awx=False).get("/api/changes/jobs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["jobs"] == []
    # The old payload was a bare {"jobs": []}, which the widget rendered as
    # "No recent changes recorded" — a claim that AWX answered.
    assert body["reason"] == "awx-unconfigured"


def test_refused_connection_with_autoscale_is_not_running(monkeypatch):
    monkeypatch.setattr(main_module, "list_recent_jobs", _raise(_refused()))
    resp = _client().get("/api/changes/jobs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["jobs"] == []
    assert body["reason"] == "awx-not-running"


def test_refused_connection_without_autoscale_is_only_unreachable(monkeypatch):
    # Without the scale-to-zero helper in play, a refused connection carries
    # no "this is expected" context — claiming not-running would be a guess.
    monkeypatch.setattr(main_module, "list_recent_jobs", _raise(_refused()))
    body = _client(autoscale=False).get("/api/changes/jobs").json()
    assert body["reason"] == "awx-unreachable"


@pytest.mark.parametrize(
    "exc",
    [
        urllib.error.URLError(TimeoutError("timed out")),
        AWXTransportError("empty response body", phase="empty"),
        AWXAPIError(500, "boom"),
        AWXAPIError(401, "nope"),
        RuntimeError("unexpected"),
    ],
)
def test_every_other_failure_is_unreachable_never_a_500(monkeypatch, exc):
    monkeypatch.setattr(main_module, "list_recent_jobs", _raise(exc))
    resp = _client().get("/api/changes/jobs")
    assert resp.status_code == 200
    assert resp.json() == {"jobs": [], "reason": "awx-unreachable"}


def test_no_raw_500_path_survives(monkeypatch):
    # The whole point of the change: the widget must never see a non-2xx and
    # collapse it into a generic "temporarily unavailable".
    for exc in (_refused(), AWXAPIError(500, ""), RuntimeError("x")):
        monkeypatch.setattr(main_module, "list_recent_jobs", _raise(exc))
        assert _client().get("/api/changes/jobs").status_code == 200


def test_success_carries_an_empty_reason(monkeypatch):
    # The catalog-launcher allow-list is derived from catalog data, so the
    # job name must belong to a catalog entry to survive the filter.
    monkeypatch.setattr(
        main_module,
        "load_catalog_entries",
        lambda *a, **k: [
            CatalogEntry(
                key="mxl-videotestsrc",
                display_name="MXL Test-Pattern Source",
                summary="",
                ebu={"media_function_type": "source"},
                configure={"awx_job_template": "media-launch-mxl-videotestsrc"},
            )
        ],
    )
    monkeypatch.setattr(
        main_module,
        "list_recent_jobs",
        lambda **kwargs: [
            {
                "id": 1,
                "name": "media-launch-mxl-videotestsrc",
                "status": "successful",
                "started": "2026-08-01T10:00:00Z",
                "finished": "2026-08-01T10:01:00Z",
                "elapsed": 60.0,
                "failed": False,
            }
        ],
    )
    body = _client().get("/api/changes/jobs").json()
    assert body["reason"] == ""
    assert [j["id"] for j in body["jobs"]] == [1]


def test_reachable_awx_with_no_matching_runs_is_a_genuine_empty(monkeypatch):
    # reason "" is what lets the widget honestly say "No recent changes
    # recorded" — AWX answered and there was nothing to show.
    monkeypatch.setattr(main_module, "list_recent_jobs", lambda **kwargs: [])
    body = _client().get("/api/changes/jobs").json()
    assert body == {"jobs": [], "reason": ""}
