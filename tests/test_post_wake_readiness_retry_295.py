"""Discriminating tests for #295: the post-wake AWX readiness race.

The live failure (AWX 24.6.1, 2026-07-28): a catalog deploy dispatched right
after the autoscale helper reported AWX awake hit a bare Django 500 on the
FIRST authenticated call — ``lookup_job_template_by_name`` — roughly 13
SECONDS after dispatch. That call was ALREADY wrapped in retry; the policy
(3 attempts, fixed 3s delay, ~6s of scheduled backoff) simply expired first.

So these tests are written to fail against the policy that was in place when
the bug was reproduced, and against the tempting-but-unsafe fix:

* §1 the retry window must outlast the old 3-attempt/6s budget on the REAL
  ``?name=`` path with the REAL console identity;
* §2 read-time resets, IncompleteRead, undecodable bodies, and empty 2xx
  responses must be classified transient — never silently absorbed into a
  ``{}`` that reads as an authoritative "template not found" or "job 0";
* §3 the launch POST is NOT idempotent: it must be sent exactly once, even
  when the response is lost after AWX already accepted the job;
* §4 every ``ensure_awx_awake`` → first-authenticated-call sequence is
  covered, including the generic workflow launch and the switch actuator.
"""

from __future__ import annotations

import asyncio
import functools
import http.client
import io
import json
import urllib.error
from unittest.mock import MagicMock, patch

import pytest

import dmf_cms.awx as awx
from dmf_cms.awx import (
    AWXAPIError,
    AWXTransportError,
    call_with_readiness_retry,
    find_active_job_for_template,
    launch_job,
    lookup_job_template_by_name,
)


# The policy this replaces, spelled out so the discriminators below are
# anchored to a number rather than a vibe: 3 attempts, fixed 3s delay, so
# two sleeps == 6s of scheduled backoff before it gave up.
OLD_ATTEMPTS = 3
OLD_TOTAL_BACKOFF_SECONDS = 6.0


class _FakeClock:
    """Deterministic monotonic clock; sleeping advances it."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds

    @property
    def total_slept(self) -> float:
        return sum(self.slept)


def _resp(body: bytes, status: int = 200):
    """A urlopen context manager whose read() returns body."""
    resp = MagicMock()
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = False
    resp.status = status
    resp.read.return_value = body
    return resp


def _resp_raising(exc: BaseException, status: int = 200):
    """A 200 response whose read() raises — the reset-during-body-read case."""
    resp = MagicMock()
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = False
    resp.status = status
    resp.read.side_effect = exc
    return resp


def _http_error(code: int, body: bytes = b""):
    return urllib.error.HTTPError("http://awx.test", code, "boom", {}, io.BytesIO(body))


_TEMPLATE_COLLECTION = json.dumps(
    {"count": 1, "results": [{"id": 7, "name": "dmf-configure"}]}
).encode()


# ===========================================================================
# §1 — the retry window must outlast the old 3-attempt / 6-second policy
# ===========================================================================


def test_readiness_retry_outlasts_the_old_attempt_budget():
    """More than 3 attempts AND more than 6s of backoff before giving up.

    The core discriminator. Reverting to the old attempt-count policy fails
    here: it would stop at 3 calls having slept only 6s, while AWX's real
    readiness lag was ~13s.
    """
    clock = _FakeClock()
    # Fail for a simulated 30s of wall clock, then succeed.
    calls = {"n": 0}

    def fn(*, timeout):
        calls["n"] += 1
        if clock.now < 1030.0:
            raise AWXAPIError(500, "")  # bare Django 500, empty body — the #295 signature
        return {"id": 7}

    result = call_with_readiness_retry(
        fn, sleep=clock.sleep, monotonic=clock.monotonic
    )

    assert result == {"id": 7}
    assert calls["n"] > OLD_ATTEMPTS, (
        f"must outlast the old {OLD_ATTEMPTS}-attempt budget; made {calls['n']} calls"
    )
    assert clock.total_slept > OLD_TOTAL_BACKOFF_SECONDS, (
        f"must outlast the old {OLD_TOTAL_BACKOFF_SECONDS}s backoff budget; "
        f"slept {clock.total_slept}s"
    )


def test_readiness_retry_survives_the_observed_13_second_lag():
    """The concrete reproduced lag: failures for 13s, then success."""
    clock = _FakeClock()

    def fn(*, timeout):
        if clock.now < 1013.0:
            raise AWXAPIError(500, "")
        return {"id": 7}

    assert call_with_readiness_retry(fn, sleep=clock.sleep, monotonic=clock.monotonic) == {"id": 7}


def test_readiness_retry_is_bounded_by_the_deadline():
    """Permanent 5xx: gives up at the deadline and re-raises, never loops forever."""
    clock = _FakeClock()
    calls = {"n": 0}

    def fn(*, timeout):
        calls["n"] += 1
        raise AWXAPIError(503, "still warming")

    with pytest.raises(AWXAPIError):
        call_with_readiness_retry(
            fn, deadline_seconds=30.0, sleep=clock.sleep, monotonic=clock.monotonic
        )
    assert clock.total_slept <= 30.0, "must not sleep past its own deadline"
    assert calls["n"] > 1, "should have retried at least once inside the window"


def test_readiness_retry_backoff_is_capped():
    """Backoff grows but never exceeds max_delay — no runaway sleep."""
    clock = _FakeClock()

    def fn(*, timeout):
        raise AWXAPIError(500, "")

    with pytest.raises(AWXAPIError):
        call_with_readiness_retry(
            fn, deadline_seconds=120.0, initial_delay=1.0, max_delay=10.0,
            sleep=clock.sleep, monotonic=clock.monotonic,
        )
    assert max(clock.slept) <= 10.0, f"backoff capped at max_delay; saw {max(clock.slept)}"
    assert len(clock.slept) > OLD_ATTEMPTS, "should keep retrying across the window"


def test_readiness_retry_derives_per_call_timeout_from_remaining_budget():
    """A single hung socket must not be able to consume the whole window."""
    clock = _FakeClock()
    seen: list[float] = []

    def fn(*, timeout):
        seen.append(timeout)
        raise AWXAPIError(500, "")

    with pytest.raises(AWXAPIError):
        call_with_readiness_retry(
            fn, deadline_seconds=20.0, min_call_timeout=5.0,
            sleep=clock.sleep, monotonic=clock.monotonic,
        )
    assert seen, "fn must be called with a timeout kwarg"
    assert max(seen) <= awx.DEFAULT_REQUEST_TIMEOUT
    assert seen[-1] >= 5.0, "per-call timeout is floored at min_call_timeout"
    assert seen[-1] < seen[0], "later calls get a smaller slice of the remaining budget"


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409])
def test_readiness_retry_does_not_retry_authoritative_4xx(status):
    """AWX answered. RBAC refusals and not-found are not readiness lag."""
    clock = _FakeClock()
    fn = MagicMock(side_effect=AWXAPIError(status, "no"))

    with pytest.raises(AWXAPIError):
        call_with_readiness_retry(fn, sleep=clock.sleep, monotonic=clock.monotonic)
    assert fn.call_count == 1, f"{status} must not be retried"
    assert clock.slept == [], "no backoff for an authoritative answer"


def test_readiness_retry_recovers_from_urlerror():
    clock = _FakeClock()
    fn = MagicMock(side_effect=[urllib.error.URLError("refused"), {"id": 7}])
    assert call_with_readiness_retry(fn, sleep=clock.sleep, monotonic=clock.monotonic) == {"id": 7}
    assert fn.call_count == 2


# ===========================================================================
# §2 — response/transport classification on the REAL ?name= lookup path
# ===========================================================================


def _lookup(**overrides):
    kwargs = dict(api_url="http://awx.test", api_token="t", name="dmf-configure")
    kwargs.update(overrides)
    return lookup_job_template_by_name(**kwargs)


@pytest.mark.parametrize("exc", [
    pytest.param(ConnectionResetError("reset during body read"), id="connection-reset"),
    pytest.param(http.client.IncompleteRead(b"partial"), id="incomplete-read"),
    pytest.param(OSError("socket closed"), id="oserror"),
])
def test_read_time_transport_failure_is_transient(exc):
    """A drop DURING resp.read() must be classified, not escape raw.

    urllib has already returned a 200-status response object at that point,
    so this raises neither HTTPError nor URLError — before this fix a bare
    ConnectionResetError escaped the client after a single call.
    """
    with patch("urllib.request.urlopen", return_value=_resp_raising(exc)):
        with pytest.raises(AWXTransportError) as caught:
            _lookup()
    assert caught.value.phase == "read"
    assert awx.is_transient_awx_failure(caught.value), "read-time drops must be retryable"


def test_invalid_json_body_is_transient():
    with patch("urllib.request.urlopen", return_value=_resp(b"<html>502 Bad Gateway</html>")):
        with pytest.raises(AWXTransportError) as caught:
            _lookup()
    assert caught.value.phase == "decode"
    assert awx.is_transient_awx_failure(caught.value)


def test_empty_200_lookup_is_not_authoritative_not_found():
    """An empty 2xx must NOT become `{}` -> None -> "template not found".

    This is the quiet one: the retry wrapper saw a successful return and
    stopped after a single request, and the operation errored out claiming
    the job template did not exist.
    """
    with patch("urllib.request.urlopen", return_value=_resp(b"")) as urlopen_mock:
        with pytest.raises(AWXTransportError) as caught:
            _lookup()
    assert caught.value.phase == "empty"
    assert urlopen_mock.call_count == 1
    assert awx.is_transient_awx_failure(caught.value)


def test_non_object_json_body_is_transient():
    with patch("urllib.request.urlopen", return_value=_resp(b"[1, 2, 3]")):
        with pytest.raises(AWXTransportError) as caught:
            _lookup()
    assert caught.value.phase == "schema"


def test_lookup_without_results_list_is_not_an_empty_collection():
    """`{"detail": "..."}` is malformed, not "no such template"."""
    with patch("urllib.request.urlopen", return_value=_resp(b'{"detail": "Not found."}')):
        with pytest.raises(AWXTransportError):
            _lookup()


def test_lookup_returns_none_only_on_a_real_empty_collection():
    """The authoritative empty answer still maps to None."""
    with patch("urllib.request.urlopen", return_value=_resp(b'{"count": 0, "results": []}')):
        assert _lookup() is None


def test_lookup_returns_the_template_on_a_valid_collection():
    with patch("urllib.request.urlopen", return_value=_resp(_TEMPLATE_COLLECTION)):
        assert _lookup() == {"id": 7, "name": "dmf-configure"}


def test_http_500_with_empty_body_is_transient():
    """The exact #295 signature: a bare Django 500 carrying no body."""
    with patch("urllib.request.urlopen", side_effect=_http_error(500, b"")):
        with pytest.raises(AWXAPIError) as caught:
            _lookup()
    assert caught.value.status == 500
    assert awx.is_transient_awx_failure(caught.value)


def test_http_403_is_not_transient():
    with patch("urllib.request.urlopen", side_effect=_http_error(403, b"forbidden")):
        with pytest.raises(AWXAPIError) as caught:
            _lookup()
    assert not awx.is_transient_awx_failure(caught.value)


def test_readiness_retry_recovers_a_reset_lookup_on_the_real_name_path():
    """End-to-end on the real path: resets/500s for longer than the old
    window, then a valid collection — the console resolves the template.

    Uses the REAL ``?name=`` URL and the REAL console identity, which is
    what the helper-side probe (different token, different path) cannot
    stand in for.
    """
    clock = _FakeClock()
    responses = [
        _resp_raising(ConnectionResetError("reset")),
        _resp(b""),                       # empty 2xx
        _resp(b"not json"),               # undecodable
        _resp_raising(http.client.IncompleteRead(b"x")),
        _resp(_TEMPLATE_COLLECTION),      # finally good — call #5
    ]
    with patch("urllib.request.urlopen", side_effect=responses) as urlopen_mock:
        template = call_with_readiness_retry(
            functools.partial(
                lookup_job_template_by_name,
                api_url="http://awx.test", api_token="t", name="dmf-configure",
            ),
            sleep=clock.sleep, monotonic=clock.monotonic,
        )
    assert template == {"id": 7, "name": "dmf-configure"}
    assert urlopen_mock.call_count == 5 > OLD_ATTEMPTS, (
        "recovery required more calls than the old attempt budget allowed"
    )


def test_find_active_job_malformed_response_does_not_read_as_no_active_job():
    """The reconciliation query must not report "nothing in flight" on a
    lost body — that is what would authorize a duplicate launch."""
    with patch("urllib.request.urlopen", return_value=_resp(b"")):
        with pytest.raises(AWXTransportError):
            find_active_job_for_template(
                api_url="http://awx.test", api_token="t", job_template_id=7,
            )


# ===========================================================================
# §3 — the launch POST is not idempotent: exactly once
# ===========================================================================


def _launch(**overrides):
    kwargs = dict(api_url="http://awx.test", api_token="t", job_template_id=7)
    kwargs.update(overrides)
    return launch_job(**kwargs)


def test_launch_post_is_sent_exactly_once_when_the_response_is_lost():
    """AWX accepted the job, then the response read was reset.

    The dangerous case: the job EXISTS. Re-POSTing creates a second one with
    real duplicate infrastructure side effects. launch_job must raise after
    a single POST and leave reconciliation to the caller.
    """
    posted = {"n": 0}

    def urlopen(req, *a, **kw):
        posted["n"] += 1
        return _resp_raising(ConnectionResetError("reset after AWX accepted the job"))

    with patch("urllib.request.urlopen", side_effect=urlopen):
        with pytest.raises(AWXTransportError):
            _launch()

    assert posted["n"] == 1, (
        f"launch POST must be sent exactly once; sent {posted['n']} — a second POST "
        "would create a duplicate AWX job"
    )


def test_launch_post_is_sent_exactly_once_on_5xx():
    """A 5xx after an ambiguous accept is equally unsafe to repeat blindly."""
    posted = {"n": 0}

    def urlopen(req, *a, **kw):
        posted["n"] += 1
        raise _http_error(502, b"bad gateway")

    with patch("urllib.request.urlopen", side_effect=urlopen):
        with pytest.raises(AWXAPIError):
            _launch()
    assert posted["n"] == 1, f"launch POST must not be repeated; sent {posted['n']}"


def test_launch_empty_response_is_not_job_id_zero():
    """An empty launch response used to decode to `{}` and return job id 0."""
    with patch("urllib.request.urlopen", return_value=_resp(b"")):
        with pytest.raises(AWXTransportError) as caught:
            _launch()
    assert caught.value.phase == "empty"


@pytest.mark.parametrize("body", [
    pytest.param(b'{"id": 5}', id="no-job-key-falls-back-to-id"),
    pytest.param(b'{"job": 4242}', id="job-key"),
])
def test_launch_returns_the_job_id_on_a_valid_response(body):
    with patch("urllib.request.urlopen", return_value=_resp(body)):
        assert _launch() in (5, 4242)


@pytest.mark.parametrize("body", [
    pytest.param(b'{"detail": "accepted"}', id="no-job-id"),
    pytest.param(b'{"job": null}', id="null-job-id"),
    pytest.param(b'{"job": 0}', id="zero-job-id"),
    pytest.param(b'{"job": "not-a-number"}', id="non-numeric-job-id"),
    pytest.param(b'{"job": true}', id="bool-job-id"),
])
def test_launch_rejects_responses_without_a_usable_job_id(body):
    with patch("urllib.request.urlopen", return_value=_resp(body)):
        with pytest.raises(AWXTransportError):
            _launch()


def test_launch_job_is_never_wrapped_in_readiness_retry_in_production():
    """Source-level guard: no call site may hand launch_job to the retry.

    The tempting fix for #295 was to wrap the launch POST too. That closes
    nothing (the failure is the lookup BEFORE it) and opens a duplicate-job
    hole, so it is asserted against here rather than left to review.
    """
    import ast
    import pathlib

    src = pathlib.Path(awx.__file__).parent
    offenders = []
    for path in sorted(src.rglob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            # AST, not text: the two names co-occur in prose all over this
            # module's docstrings, and only a real call expression matters.
            names = {
                sub.attr if isinstance(sub, ast.Attribute) else sub.id
                for sub in ast.walk(node)
                if isinstance(sub, (ast.Name, ast.Attribute))
            }
            if "call_with_readiness_retry" in names and "launch_job" in names:
                offenders.append(f"{path.name}:{node.lineno}")
    assert not offenders, (
        f"launch_job must never be retried blindly (#295); found at {offenders}"
    )


# ===========================================================================
# §4 — every post-wake first authenticated call is covered
# ===========================================================================


def test_switch_actuator_wakes_awx_before_its_first_authenticated_call():
    """The switch actuator used to look up a job template with no wake at all."""
    from dmf_cms.switch_source import ReconnectViaAwxActuator, SwitchStatus
    from dmf_cms import switch_source

    order: list[str] = []

    def fake_wake(**kwargs):
        order.append("wake")
        assert kwargs["helper_url"] == "http://helper.test"
        assert kwargs["bearer_token"] == "b"

    def fake_lookup(**kwargs):
        order.append("lookup")
        return None  # short-circuits to failed; the ORDER is what is asserted

    with patch.object(switch_source._awx, "ensure_awx_awake", fake_wake), \
         patch.object(switch_source._awx, "lookup_job_template_by_name", fake_lookup):
        actuator = ReconnectViaAwxActuator(
            awx_api_url="http://awx.test",
            awx_api_token="t",
            autoscale_helper_url="http://helper.test",
            autoscale_bearer_token="b",
            poll_interval_seconds=0.01,
            timeout_seconds=1.0,
        )
        command = _switch_command()
        asyncio.run(actuator.execute(command, {"viewer": {}}))

    assert order == ["wake", "lookup"], f"wake must precede the first AWX read; got {order}"
    assert command.status is SwitchStatus.FAILED_ROLLBACK_REQUIRED


def test_switch_actuator_lookup_rides_the_readiness_retry():
    """Its lookup must survive a post-wake blip, like every other path."""
    from dmf_cms.switch_source import ReconnectViaAwxActuator
    from dmf_cms import switch_source

    calls = {"n": 0}

    def flaky_lookup(**kwargs):
        calls["n"] += 1
        if calls["n"] < 4:
            raise AWXAPIError(500, "")
        return {"id": 7}

    with patch.object(switch_source._awx, "ensure_awx_awake", lambda **k: None), \
         patch.object(switch_source._awx, "lookup_job_template_by_name", flaky_lookup), \
         patch.object(switch_source._awx, "launch_job", lambda **k: 4242), \
         patch.object(switch_source._awx, "get_job", lambda **k: {"status": "successful"}), \
         patch("dmf_cms.awx.time.sleep", lambda s: None):
        actuator = ReconnectViaAwxActuator(
            awx_api_url="http://awx.test", awx_api_token="t",
            poll_interval_seconds=0.01, timeout_seconds=5.0,
        )
        asyncio.run(actuator.execute(_switch_command(), {"viewer": {}}))

    assert calls["n"] == 4 > OLD_ATTEMPTS, (
        f"switch lookup must retry past the old attempt budget; made {calls['n']} calls"
    )


def _switch_command():
    from dmf_cms.switch_source import SwitchSourceCommand

    return SwitchSourceCommand(
        command_id="c" * 32,
        receiver_instance="receiver-1",
        source_instance="source-a",
        reason="test",
        request_id="r" * 32,
        initiator="alice",
    )


@pytest.mark.parametrize("runner", [
    "_run_launch_operation",
    "_run_deploy_operation",
    "_run_teardown_operation",
    "_run_rollback_operation",
])
def test_async_runners_use_the_post_wake_lookup_helper(runner):
    """Every ensure_awx_awake -> first-lookup runner goes through the helper.

    The generic workflow launch was the one left with a bare lookup: it woke
    AWX and then made an unprotected authenticated call, retaining the exact
    race #295 describes.

    Asserts ORDER, not absence: deploy/teardown legitimately make a SECOND,
    later lookup (the #24 opposite-JT cross-guard). That one is not a
    post-wake first call — by then the console has already had an
    authoritative answer out of AWX.
    """
    import inspect

    import dmf_cms.main as main

    source = inspect.getsource(getattr(main, runner))
    assert "ensure_awx_awake" in source, f"{runner} should wake AWX"

    first_helper = source.find("_post_wake_template_lookup")
    first_bare = source.find("lookup_job_template_by_name")
    assert first_helper != -1, (
        f"{runner} must resolve its job template through the post-wake helper"
    )
    assert first_bare == -1 or first_helper < first_bare, (
        f"{runner}'s FIRST authenticated call after the wake must be the "
        "deadline-bounded helper, not a bare lookup"
    )
