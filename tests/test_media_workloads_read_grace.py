"""dmfdeploy#319: a brief NetBox read failure is not an outage.

Both inventory reads (flat and grouped) serve the last good inventory,
marked stale, for READ_GRACE_SECONDS after the last success, then degrade.
Time comes from an injected clock; nothing sleeps.
"""

from __future__ import annotations

import pytest

from dmf_cms import media_workloads as mw
from dmf_cms import netbox as netbox_module

SERVICE = {
    "id": 1,
    "name": "mxl-vm",
    "tags": [{"name": "dmf-catalog"}, {"name": "app:mxl-videotestsrc"}, {"name": "workload:demo"}],
    "device": {"name": "node-1"},
    "ports": [9000],
    "protocol": {"value": "tcp"},
    "custom_fields": {},
}

T0 = 1_800_000_000.0
ARGS = ("http://netbox.test", "tok", False, None)


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def __call__(self) -> float:
        return self.now


class Source:
    """Stands in for the NetBox read: flip ``fail`` to simulate a starved read."""

    def __init__(self, monkeypatch) -> None:
        self.fail = False
        monkeypatch.setattr(mw, "_fetch_services", self)

    def __call__(self, *args, **kwargs):
        if self.fail:
            raise netbox_module.NetboxAPIError(504, "starved")
        return [dict(SERVICE)]


def _names(payload, kind):
    if kind == "flat":
        return [i["instance"] for i in payload["instances"]]
    return [i["instance"] for w in payload["workloads"] for i in w["instances"]]


def _read(kind, clock, mono=None):
    fn = mw.list_instances if kind == "flat" else mw.list_workloads_grouped
    return fn(*ARGS, catalog_dir="/nonexistent-catalog", clock=clock, monotonic=mono or clock)


@pytest.fixture(params=["flat", "grouped"])
def kind(request):
    return request.param


def test_failure_inside_window_serves_last_good_stale(monkeypatch, kind):
    clock, src = Clock(), Source(monkeypatch)
    first = _read(kind, clock)
    assert first["stale"] is False and first["degraded"] is False
    src.fail = True
    clock.now = T0 + mw.READ_GRACE_SECONDS - 1
    got = _read(kind, clock)
    assert got["stale"] is True
    assert got["degraded"] is False
    assert _names(got, kind) == _names(first, kind) == ["mxl-vm"]
    assert got["last_success"] == first["last_success"] == "2027-01-15T08:00:00Z"
    assert got["failure_since"] == "2027-01-15T08:01:59Z"


def test_failure_after_window_is_degraded_with_timestamps(monkeypatch, kind):
    clock, src = Clock(), Source(monkeypatch)
    first = _read(kind, clock)
    src.fail = True
    clock.now = T0 + 30
    _read(kind, clock)  # failure begins here, still inside the window
    clock.now = T0 + mw.READ_GRACE_SECONDS + 1
    got = _read(kind, clock)
    assert got["degraded"] is True and got["stale"] is False
    assert got["reason"] == "netbox-unreachable"
    assert _names(got, kind) == []
    assert got["last_success"] == first["last_success"]
    assert got["failure_since"] == "2027-01-15T08:00:30Z"


def test_success_after_failure_is_fresh(monkeypatch, kind):
    clock, src = Clock(), Source(monkeypatch)
    _read(kind, clock)
    src.fail = True
    clock.now = T0 + 10
    assert _read(kind, clock)["stale"] is True
    src.fail = False
    clock.now = T0 + 20
    got = _read(kind, clock)
    assert got["stale"] is False and got["degraded"] is False
    assert got["failure_since"] is None
    assert got["last_success"] == "2027-01-15T08:00:20Z"
    # A new failure restarts the window from the new success.
    src.fail = True
    clock.now = T0 + 20 + mw.READ_GRACE_SECONDS - 1
    assert _read(kind, clock)["stale"] is True


def test_never_succeeded_is_degraded_last_success_null(monkeypatch, kind):
    clock, src = Clock(), Source(monkeypatch)
    src.fail = True
    got = _read(kind, clock)
    assert got["degraded"] is True and got["stale"] is False
    assert got["last_success"] is None
    assert got["failure_since"] == "2027-01-15T08:00:00Z"


def test_unexpected_error_also_gets_grace(monkeypatch, kind):
    clock = Clock()
    src = Source(monkeypatch)
    _read(kind, clock)

    def boom(*a, **k):
        raise ValueError("unexpected")

    monkeypatch.setattr(mw, "_fetch_services", boom)
    clock.now = T0 + 5
    assert _read(kind, clock)["stale"] is True
    clock.now = T0 + mw.READ_GRACE_SECONDS + 5
    got = _read(kind, clock)
    assert got["degraded"] is True and got["reason"] == "netbox-error"
    del src


def test_scopes_never_share_a_last_good(monkeypatch):
    clock, src = Clock(), Source(monkeypatch)
    mw.list_instances("http://netbox.test", "tok", False, ("tenant-a",), catalog_dir="/x", clock=clock, monotonic=clock)
    src.fail = True
    got = mw.list_instances("http://netbox.test", "tok", False, ("tenant-b",), catalog_dir="/x", clock=clock, monotonic=clock)
    assert got["degraded"] is True and got["last_success"] is None


def test_stale_copy_is_not_shared_state(monkeypatch):
    clock, src = Clock(), Source(monkeypatch)
    _read("flat", clock)
    src.fail = True
    clock.now = T0 + 1
    a = _read("flat", clock)
    a["instances"].clear()
    assert len(_read("flat", clock)["instances"]) == 1


# ── Overlapping reads: cache writes follow when a read started ─────────────


def _svc(name):
    return {**SERVICE, "name": name}


class Interleave:
    """Fetch stub whose first call runs ``inner`` before it returns.

    This drives a deterministic overlap: the outer read starts first, the
    inner read starts and finishes while the outer one is still in flight,
    then the outer read completes last. Nothing sleeps or uses threads.
    """

    def __init__(self, monkeypatch, outer, inner) -> None:
        self.outer, self.inner, self.calls = outer, inner, 0
        monkeypatch.setattr(mw, "_fetch_services", self)

    def __call__(self, *args, **kwargs):
        self.calls += 1
        if self.calls == 1:
            self.inner()
            return self._result(self.outer)
        return self._result(self.inner_result)

    inner_result = None

    @staticmethod
    def _result(spec):
        if spec == "fail":
            raise netbox_module.NetboxAPIError(504, "starved")
        return [_svc(spec)]


def _overlap(monkeypatch, kind, clock, outer, inner):
    """Run read A (outer) so that read B (inner) starts and ends inside it."""
    stub = Interleave(monkeypatch, outer, lambda: None)
    stub.inner_result = inner
    box = {}

    def run_inner():
        clock.now += 5
        box["inner"] = _read(kind, clock)
        clock.now += 5

    stub.inner = run_inner
    box["outer"] = _read(kind, clock)
    return box


def test_older_success_finishing_last_does_not_replace_newer_snapshot(monkeypatch, kind):
    clock = Clock()
    box = _overlap(monkeypatch, kind, clock, outer="old", inner="new")
    assert _names(box["inner"], kind) == ["new"]
    # The older read finished last but answers with the newer snapshot.
    assert _names(box["outer"], kind) == ["new"]
    assert box["outer"]["stale"] is False
    assert box["outer"]["last_success"] == "2027-01-15T08:00:05Z"
    # Both reads succeeded. A later failure must serve the newer snapshot,
    # and the window runs from when that read started, not from when the
    # older read finished.
    monkeypatch.setattr(
        mw, "_fetch_services",
        lambda *a, **k: (_ for _ in ()).throw(netbox_module.NetboxAPIError(504, "x")),
    )
    clock.now = T0 + 5 + mw.READ_GRACE_SECONDS - 1
    got = _read(kind, clock)
    assert got["stale"] is True
    assert _names(got, kind) == ["new"]
    assert got["last_success"] == "2027-01-15T08:00:05Z"
    clock.now = T0 + 5 + mw.READ_GRACE_SECONDS + 1
    assert _read(kind, clock)["degraded"] is True


def test_older_success_cannot_clear_a_newer_failure(monkeypatch, kind):
    clock = Clock()
    ok = Source(monkeypatch)
    _read(kind, clock)  # last good "mxl-vm"
    box = _overlap(monkeypatch, kind, clock, outer="old", inner="fail")
    assert box["inner"]["stale"] is True
    assert box["inner"]["failure_since"] == "2027-01-15T08:00:05Z"
    # The older read succeeded after the newer failure; it must not erase it,
    # and its own response reports the failure state, not its own payload.
    assert box["outer"]["stale"] is True
    assert box["outer"]["failure_since"] == "2027-01-15T08:00:05Z"
    # Nor may it replace the retained snapshot: the newest observation is the
    # failure, so the inventory served stale is the one read before both.
    assert _names(box["inner"], kind) == ["mxl-vm"]
    assert _names(box["outer"], kind) == ["mxl-vm"]
    assert box["outer"]["last_success"] == "2027-01-15T08:00:00Z"
    monkeypatch.setattr(
        mw, "_fetch_services",
        lambda *a, **k: (_ for _ in ()).throw(netbox_module.NetboxAPIError(504, "x")),
    )
    clock.now += 1
    got = _read(kind, clock)
    assert got["stale"] is True
    assert got["failure_since"] == "2027-01-15T08:00:05Z"
    assert _names(got, kind) == ["mxl-vm"]
    assert got["last_success"] == "2027-01-15T08:00:00Z"
    # The window still runs from the retained snapshot's start.
    clock.now = T0 + mw.READ_GRACE_SECONDS + 1
    assert _read(kind, clock)["degraded"] is True
    del ok


def test_older_success_after_newer_failure_keeps_write_gate_and_next_success_recovers(
    monkeypatch, kind
):
    clock = Clock()
    Source(monkeypatch)
    _read(kind, clock)
    _overlap(monkeypatch, kind, clock, outer="old", inner="fail")
    args = ("http://netbox.test", None)
    assert mw.inventory_write_block(*args, monotonic=clock) == "inventory-stale"
    # Past the window the same state is degraded, never "fresh from A".
    clock.now = T0 + mw.READ_GRACE_SECONDS + 1
    assert mw.inventory_write_block(*args, monotonic=clock) == "inventory-degraded"
    # A read that starts after the failure clears it and replaces the snapshot.
    monkeypatch.setattr(mw, "_fetch_services", lambda *a, **k: [_svc("newest")])
    got = _read(kind, clock)
    assert got["stale"] is False and got["degraded"] is False
    assert got["failure_since"] is None
    assert _names(got, kind) == ["newest"]
    assert mw.inventory_write_block(*args, monotonic=clock) is None


def test_older_success_after_newer_failure_with_no_snapshot_stays_degraded(monkeypatch, kind):
    clock = Clock()
    box = _overlap(monkeypatch, kind, clock, outer="old", inner="fail")
    assert box["inner"]["degraded"] is True
    # A has no snapshot to fall back on and is older than the failure, so it
    # reports the failure rather than seeding the cache with its payload.
    assert box["outer"]["degraded"] is True
    assert box["outer"]["last_success"] is None
    assert _names(box["outer"], kind) == []
    (state,) = mw._read_states.values()
    assert state.last_good is None


def test_older_failure_cannot_degrade_a_newer_success(monkeypatch, kind):
    clock = Clock()
    Source(monkeypatch)
    _read(kind, clock)
    box = _overlap(monkeypatch, kind, clock, outer="fail", inner="new")
    assert box["inner"]["stale"] is False
    # The failing read started before the newer success proved NetBox
    # answers: it serves that success fresh and records no failure.
    assert box["outer"]["stale"] is False and box["outer"]["degraded"] is False
    assert box["outer"]["failure_since"] is None
    assert _names(box["outer"], kind) == ["new"]


def _fail_overlap(monkeypatch, kind, clock, older_first):
    """Two failing reads with distinct reasons and no last-good snapshot.

    Read A starts first and fails with RuntimeError (netbox-error); read B
    starts later and fails with NetboxAPIError (netbox-unreachable). With
    ``older_first`` False, B finishes inside A, so A completes last.
    """
    box = {}
    calls = {"n": 0}

    def fetch(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            if not older_first:
                clock.now += 5
                box["B"] = _read(kind, clock)
                clock.now += 5
            raise RuntimeError("boom")
        raise netbox_module.NetboxAPIError(504, "starved")

    monkeypatch.setattr(mw, "_fetch_services", fetch)
    box["A"] = _read(kind, clock)
    if older_first:
        clock.now += 5
        box["B"] = _read(kind, clock)
    return box


def test_superseded_failure_carries_the_newest_failure_reason(monkeypatch, kind):
    clock = Clock()
    box = _fail_overlap(monkeypatch, kind, clock, older_first=False)
    assert box["B"]["reason"] == "netbox-unreachable"
    # A started first but completed last: it reports B's reason, not its own.
    assert box["A"]["degraded"] is True
    assert box["A"]["reason"] == "netbox-unreachable"
    # No success separates the two failures, so the episode began with A's start.
    assert box["A"]["failure_since"] == "2027-01-15T08:00:00Z"
    # The stored failure is B's, so a later read after both still agrees.
    (state,) = mw._read_states.values()
    assert state.failure_degraded["reason"] == "netbox-unreachable"


def test_newer_failure_after_older_failure_replaces_the_stored_reason(monkeypatch, kind):
    clock = Clock()
    box = _fail_overlap(monkeypatch, kind, clock, older_first=True)
    assert box["A"]["reason"] == "netbox-error"
    assert box["B"]["reason"] == "netbox-unreachable"
    (state,) = mw._read_states.values()
    assert state.failure_degraded["reason"] == "netbox-unreachable"
    assert box["B"]["failure_since"] == "2027-01-15T08:00:00Z"


# ── Grace is measured on a monotonic clock ──────────────────────────────────


def test_wall_clock_step_does_not_extend_the_grace_window(monkeypatch, kind):
    wall, mono, src = Clock(), Clock(), Source(monkeypatch)
    _read(kind, wall, mono)
    src.fail = True
    # Real elapsed time passes the window while the wall clock is stepped back.
    mono.now = T0 + mw.READ_GRACE_SECONDS + 1
    wall.now = T0 - 3600
    got = _read(kind, wall, mono)
    assert got["degraded"] is True and got["stale"] is False


def test_wall_clock_step_forward_does_not_cut_the_window_short(monkeypatch, kind):
    wall, mono, src = Clock(), Clock(), Source(monkeypatch)
    _read(kind, wall, mono)
    src.fail = True
    mono.now = T0 + 10
    wall.now = T0 + 3600
    assert _read(kind, wall, mono)["stale"] is True


# ── failure_since across an intervening success ────────────────────────────
#
# Drives the real _begin_read / _on_read_failure / _remember_success so the
# ticket order, not the call order, decides the failure episode.

_DEGRADED = {"degraded": True, "reason": "starved"}


class _Episode:
    """Reads 0..count-1 start five seconds apart; tests finish them in any order."""

    def __init__(self, kind, count):
        mw._reset_read_grace()
        self.clock = Clock()
        self.key = mw._read_key("instances" if kind == "flat" else "grouped", ARGS[0], None)
        self.reads = []
        for i in range(count):
            self.clock.now = T0 + 5 * i
            self.reads.append(mw._begin_read(self.clock, self.clock))
        self.clock.now = T0 + 5 * count

    def ok(self, i):
        ticket, started, mono = self.reads[i]
        payload = {"instances": [], "workloads": [], "name": f"r{i}"}
        return mw._remember_success(self.key, payload, ticket, started, mono, self.clock)

    def fail(self, i):
        ticket, started, _ = self.reads[i]
        return mw._on_read_failure(self.key, _DEGRADED, ticket, started, self.clock)

    def blocked(self):
        return mw.inventory_write_block(ARGS[0], None, monotonic=self.clock)


def _at(i):
    return mw._iso_utc(T0 + 5 * i)


def test_intervening_success_splits_failure_episode(kind):
    ep = _Episode(kind, 4)
    ep.ok(0)
    ep.fail(1)
    assert ep.fail(3)["failure_since"] == _at(1)
    got = ep.ok(2)
    # Read 2 started between the failures of reads 1 and 3, so the current
    # episode began with read 3. The snapshot stays read 0's.
    assert got["failure_since"] == _at(3)
    assert got["last_success"] == _at(0)
    assert got["name"] == "r0"
    assert got["stale"] is True
    assert mw._read_states[ep.key].success_ticket == ep.reads[0][0]
    assert ep.blocked() == "inventory-stale"


def test_success_completing_last_still_splits_later_failures(kind):
    ep = _Episode(kind, 4)  # read 0 fails, 1 succeeds, 2 and 3 fail
    ep.fail(0)
    ep.fail(3)
    assert ep.fail(2)["failure_since"] == _at(0)
    got = ep.ok(1)
    # Two failures (2 and 3) are newer than the suppressed success, so the
    # episode restarts at the newest one: the documented understatement.
    assert got["failure_since"] == _at(3)
    assert got["degraded"] is True
    assert ep.blocked() == "inventory-degraded"
    # An older failure completing after the split cannot reopen the episode.
    assert ep.fail(0)["failure_since"] == _at(3)


def test_suppressed_success_with_no_failure_after_it_leaves_no_episode(kind):
    ep = _Episode(kind, 3)
    ep.fail(0)
    assert ep.ok(2)["failure_since"] is None
    # Read 1 is older than the stored success and has no later failure.
    got = ep.ok(1)
    assert got["failure_since"] is None and got["stale"] is False
    assert got["name"] == "r2"
    assert _state(ep).failure_since is None
    # A failure older than a success already seen records nothing.
    assert ep.fail(0)["failure_since"] is None
    assert ep.blocked() is None


def _state(ep):
    return mw._read_states[ep.key]


def test_failure_then_unrelated_success_split_keeps_gate_blocked(kind):
    ep = _Episode(kind, 4)  # A=0 fails, B=1 succeeds late, C=2 fails, D=3 stays unread
    ep.fail(0)
    ep.fail(2)
    got = ep.ok(1)
    assert got["failure_since"] == _at(2)
    assert got["last_success"] is None
    assert ep.blocked() == "inventory-degraded"


@pytest.mark.parametrize("snap", [False, True])
@pytest.mark.parametrize("a_outcome", ["ok", "fail"])
def test_newer_success_clears_failure_while_older_read_is_pending(kind, snap, a_outcome):
    ep = _Episode(kind, 4 if snap else 3)
    base = 1 if snap else 0
    a, b, c = base, base + 1, base + 2
    if snap:
        ep.ok(0)
    ep.fail(b)
    got = ep.ok(c)  # A is still pending
    assert got["stale"] is False
    assert got["failure_since"] is None
    assert got["name"] == f"r{c}"
    assert ep.blocked() is None
    # A completing afterwards cannot bring the failure state back.
    after = ep.ok(a) if a_outcome == "ok" else ep.fail(a)
    assert after["stale"] is False
    assert after["failure_since"] is None
    assert after["name"] == f"r{c}"
    assert ep.blocked() is None
    assert _state(ep).last_success == T0 + 5 * c


def test_two_failures_newer_than_a_suppressed_success_understate_the_outage(kind):
    ep = _Episode(kind, 4)  # A=0, B=1, C=2, D=3
    ep.fail(0)
    ep.fail(2)
    ep.fail(3)
    assert _state(ep).failure_since == T0
    got = ep.ok(1)
    # The true episode began at A's start; the state keeps only the newest
    # failure after the split, never anything earlier than C.
    assert got["failure_since"] == _at(3)
    assert got["failure_since"] >= _at(2)
    assert ep.blocked() == "inventory-degraded"


def test_sustained_sequential_failures_keep_the_first_start_in_scalar_state(kind):
    ep = _Episode(kind, 0)
    for i in range(1_000):
        ep.clock.now = T0 + i
        ticket, started, _ = mw._begin_read(ep.clock, ep.clock)
        got = mw._on_read_failure(ep.key, _DEGRADED, ticket, started, ep.clock)
    assert got["failure_since"] == mw._iso_utc(T0)
    state = _state(ep)
    assert state.failure_started == T0 + 999
    # The snapshot and the newest diagnosis are single payloads; nothing else
    # may be a collection that grows with the number of failures.
    for name in set(mw._ReadState.__slots__) - {"last_good", "failure_degraded"}:
        assert not isinstance(getattr(state, name), (dict, list, set, tuple))


@pytest.mark.parametrize("raiser", ["clock", "monotonic"])
def test_clock_error_during_read_start_leaves_no_state(monkeypatch, kind, raiser):
    Source(monkeypatch)

    def boom():
        raise RuntimeError("clock failed")

    good = Clock()
    with pytest.raises(RuntimeError):
        _read(kind, boom if raiser == "clock" else good, boom if raiser == "monotonic" else good)
    assert mw._read_states == {}
    assert mw.inventory_write_block(ARGS[0], None, monotonic=good) is None
    got = _read(kind, good)
    assert got["stale"] is False and got["failure_since"] is None
    assert mw.inventory_write_block(ARGS[0], None, monotonic=good) is None
