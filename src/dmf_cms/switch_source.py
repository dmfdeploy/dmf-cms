"""SwitchSourceCommand — the actuator-agnostic domain command for
switching which topology source a viewer receives (umbrella #201 WP4,
spec §6: `DMF v0.2b Multi-Source Switch Spec 2026-07-15.md`).

WP4 is dmf-cms backend ONLY (the domain command, its status machine, and
the coarse `reconnect` actuator) — WP5 builds the HTTP endpoint
(``POST /api/media-workloads/{instance}/switch-source``), the
``_require_media_workloads_access``/``_require_reason`` gates, the C5
audit emission, and the ``InstanceLiveModal.tsx`` UI. This module's own
public surface (``dispatch_switch_source``) is the thin seam WP5 calls
into — see that function's own docstring for the exact shape a caller
needs.

STRUCTURAL §6.3 INVARIANT: SwitchSourceCommand/SwitchStatus/SwitchActuator
below are completely AWX-ignorant — nothing here imports ``awx``,
references a job template, or knows what "reconnect" even means
mechanically. The ONLY AWX-aware class in this module is
``ReconnectViaAwxActuator``, which satisfies the generic ``SwitchActuator``
Protocol. Swapping in a future ``nmos-is05`` actuator means writing a
SECOND class satisfying the same Protocol and changing one constructor
call at the call site — zero changes to the command/status code. See
``tests/test_switch_source.py``'s own contract test, which instantiates a
fake, non-AWX actuator against the SAME Protocol and asserts
``dispatch_switch_source``'s behavior is identical either way — this is
the "test asserting the contract surface, not a comment" the spec's
review gate (§6.3) demands.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import re
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Optional, Protocol

from starlette.concurrency import run_in_threadpool

from . import awx as _awx
from .catalog import CATALOG_DIR, load_catalog_entries, load_topology_instance, topology_state_for
from .l3_detail_tokens import KV_DETAIL_TOKENS
from .log_safety import sanitize_audit_field

logger = logging.getLogger(__name__)


class SwitchStatus(str, Enum):
    """spec §6.1's own status machine, verbatim: pending -> reconnecting
    -> active -> failed_rollback_required.

    §6.3 is explicit that this set is UNCHANGED when the actuator swaps
    from coarse `reconnect` to live `nmos-is05` later (the IS-05 path may
    make `reconnecting` near-instant, but the states hold) — any actuator
    change that would require adding/removing/renaming a value here is a
    spec violation, not a refactor.
    """

    PENDING = "pending"
    RECONNECTING = "reconnecting"
    ACTIVE = "active"
    FAILED_ROLLBACK_REQUIRED = "failed_rollback_required"


# Terminal for dedupe/GC purposes — mirrors operations.terminal_states'
# own role, scoped to switch's own single, un-varying 4-state machine (no
# per-action branching needed the way Operation's multi-action set has:
# every SwitchSourceCommand, regardless of actuator, follows this exact
# machine — that uniformity IS the §6.3 contract).
TERMINAL_STATES = frozenset({SwitchStatus.ACTIVE, SwitchStatus.FAILED_ROLLBACK_REQUIRED})


class SwitchSourceError(Exception):
    """Raised by ``dispatch_switch_source`` for a request-SHAPE problem —
    unknown receiver_instance, a receiver with no topology_ref (not a
    topology-carrying instance at all), a malformed/invalid topology_params
    (catalog-authoring defect), or a source_instance that names no real
    ``sources[].id`` — ALWAYS before a SwitchSourceCommand is ever created
    or persisted, so the caller (WP5's future endpoint) can turn this
    straight into a 404/422 with nothing to clean up. Distinct from a
    command that failed AFTER creation/dispatch — that is
    ``SwitchStatus.FAILED_ROLLBACK_REQUIRED``, a properly tracked terminal
    state, never an exception.
    """

    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}")


@dataclass
class SwitchSourceCommand:
    """umbrella #201 WP4 spec §6.1 — actuator-agnostic domain command +
    tracking record for one "switch the viewer to a different topology
    source" request.

    Persisted the SAME way ``operations.Operation`` is (thread-safe
    in-memory store, TTL GC, SINGLE REPLICA ASSUMPTION) but as its OWN,
    dedicated store/type below — NOT folded into ``OperationStore``. A
    switch is a domain-level RECONFIGURE of an already-running instance,
    never a catalog deploy/teardown/rollback, and its status machine (4
    states, spec-exact, actuator-agnostic) shares nothing with
    ``OperationState``'s multi-action, inherently-AWX-shaped vocabulary
    (WAKING/LAUNCHING/RUN_STATUS_UNKNOWN, ...). Reusing that store/enum
    would leak AWX-job-lifecycle concepts into a type the §6.3 invariant
    requires to stay actuator-agnostic — the exact leak this module's own
    module-docstring warns against.
    """

    command_id: str
    receiver_instance: str
    source_instance: str
    reason: str
    status: SwitchStatus = SwitchStatus.PENDING
    previous_source: Optional[str] = None
    error: Optional[str] = None
    # umbrella #320: the coarse `status`/free-text `error` fields above stay
    # UNCHANGED for compatibility — `outcome` is additive, one of the frozen
    # switch_* enums classify_switch_job_failure/ReconnectViaAwxActuator.execute
    # produce (see this module's own switch-outcome parser section below).
    # `outcome_message` is the matching operator copy (None only on success);
    # the raw `outcome` code is expert-level detail.
    outcome: Optional[str] = None
    outcome_message: Optional[str] = None
    request_id: Optional[str] = None
    initiator: Optional[str] = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Serialize to API response format (WP5's own future response
        envelope, spec §7 step 6: request_id/actor/role/reason/previous+
        requested source/outcome — actor/role are WP5's own auth-context
        concerns, not carried here)."""
        return {
            "command_id": self.command_id,
            "receiver_instance": self.receiver_instance,
            "source_instance": self.source_instance,
            "reason": self.reason,
            "status": self.status.value,
            "previous_source": self.previous_source,
            "error": self.error,
            "outcome": self.outcome,
            "outcome_message": self.outcome_message,
            "request_id": self.request_id,
            "initiator": self.initiator,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class SwitchCommandStore:
    """Thread-safe in-memory store for ``SwitchSourceCommand``, mirroring
    ``operations.OperationStore``'s own shape and SINGLE REPLICA
    ASSUMPTION (see that class's own docstring) — a dedicated store, not a
    parallel mechanism for what OperationStore already tracks: OperationStore
    tracks AWX-job-launch lifecycles (deploy/teardown/rollback), this
    tracks the actuator-agnostic switch domain command (which, for the
    v0.2b `reconnect` actuator, HAPPENS to be implemented via an AWX job —
    but that is this store's caller's business, never this store's own
    concern, structurally enforced by SwitchSourceCommand carrying no AWX
    fields at all).
    """

    def __init__(self, ttl_seconds: int = 3600) -> None:
        self._commands: dict[str, SwitchSourceCommand] = {}
        self._lock = threading.RLock()
        self._ttl_seconds = ttl_seconds

    @property
    def ttl_seconds(self) -> int:
        return self._ttl_seconds

    def _gc(self) -> None:
        now = datetime.now(timezone.utc)
        expired = [
            cid
            for cid, cmd in self._commands.items()
            if cmd.status in TERMINAL_STATES
            and (now - cmd.updated_at).total_seconds() > self._ttl_seconds
        ]
        for cid in expired:
            del self._commands[cid]

    def create(
        self,
        *,
        receiver_instance: str,
        source_instance: str,
        reason: str,
        request_id: Optional[str] = None,
        initiator: Optional[str] = None,
        previous_source: Optional[str] = None,
    ) -> SwitchSourceCommand:
        with self._lock:
            self._gc()
            command_id = str(uuid.uuid4())
            cmd = SwitchSourceCommand(
                command_id=command_id,
                receiver_instance=receiver_instance,
                source_instance=source_instance,
                reason=reason,
                request_id=request_id,
                initiator=initiator,
                previous_source=previous_source,
            )
            self._commands[command_id] = cmd
            return cmd

    def get(self, command_id: str) -> Optional[SwitchSourceCommand]:
        with self._lock:
            self._gc()
            return self._commands.get(command_id)

    def find_active(self, receiver_instance: str) -> Optional[SwitchSourceCommand]:
        """Idempotency/re-entry guard (mirrors awx.find_active_job_for_template's
        own "a double-click / two tabs / slow render... gets the SAME
        result back instead of spawning a duplicate" rationale, scoped per
        RECEIVER rather than per-JT — two different viewers switching at
        once are unrelated operations, not a collision). Returns the most
        recent NON-terminal command for this receiver, if any."""
        with self._lock:
            self._gc()
            candidates = [
                cmd
                for cmd in self._commands.values()
                if cmd.receiver_instance == receiver_instance and cmd.status not in TERMINAL_STATES
            ]
            if not candidates:
                return None
            return max(candidates, key=lambda c: c.created_at)


class SwitchActuator(Protocol):
    """umbrella #201 WP4 spec §6.3 — the STRUCTURAL contract every
    actuator (today's coarse `reconnect`, tomorrow's live `nmos-is05`)
    must satisfy so swapping the concrete implementation changes NOTHING
    at the SwitchSourceCommand/console layer. This is the spec's own
    review gate ("any change to the console contract... to make IS-05
    work is a spec violation") encoded as a type, not left to convention —
    ``tests/test_switch_source.py`` instantiates a second, fake,
    non-AWX-touching actuator satisfying this exact Protocol and asserts
    ``dispatch_switch_source``'s own calling code needs zero changes to
    use it.
    """

    async def execute(self, command: SwitchSourceCommand, topology_params: dict[str, Any]) -> None:
        """Run the switch to completion or failure, MUTATING ``command``
        in place (``status``/``error``/``previous_source``/``updated_at``)
        as it progresses — ``command`` is the SAME object reference the
        caller's ``SwitchCommandStore`` holds, so a concurrent
        ``store.get(command_id)`` observes each transition (e.g. PENDING
        -> RECONNECTING) without any extra plumbing back to the store.

        Must never raise for an EXPECTED actuator-level failure — §6.2's
        own ``failed_rollback_required`` posture is a STATUS VALUE this
        method sets and returns normally from, never an exception. Only a
        genuine programming error (a bug in this method itself) should
        propagate.
        """
        ...


# umbrella #201 WP4: the AWX job
# template name the coarse reconnect actuator launches. NOTE — flagged
# prominently, NOT fixed here (WP4b's own job): the console's grant-
# reconciler (umbrella #697) matches job template names against
# `^media-(launch|finalise|rollback)-` and will NOT match this name —
# WP4b must extend that regex (the #279 lesson: a job template AWX can
# launch but dmf-cms's own credential grant never covers fails as a
# mystery 404 in production, not at build time). Tracked on the #201
# ledger; see this module's own MODULE docstring + ReconnectViaAwxActuator's
# for the full WP4b scope this name anchors.
SWITCH_SOURCE_JOB_TEMPLATE_NAME = "media-switch-source"

# How long the actuator waits for the AWX job to reach a terminal status
# before giving up and reporting failed_rollback_required — the coarse
# reconnect sequence (§6.2's three phases: a coordinator ConfigMap patch,
# a viewer restart, another patch) is expected to complete in seconds, not
# minutes; this is deliberately much shorter than deploy/teardown/
# rollback's own multi-minute TTL (operations.OperationStore's default
# 3600s) — a switch that hasn't resolved in 2 minutes is already an
# operator-visible anomaly, not a normal wait.
_DEFAULT_ACTUATOR_TIMEOUT_SECONDS = 120.0
_DEFAULT_POLL_INTERVAL_SECONDS = 2.0

# AWX job statuses that mean "done, one way or another" — mirrors
# awx.AWXJobInfo.is_done's own set (kept as a plain constant here rather
# than importing that dataclass, since this actuator reads the raw
# get_job dict the same way main.py's own watcher does, not the narrowed
# AWXJobInfo — see awx.get_job's own docstring for why).
_TERMINAL_JOB_STATUSES = frozenset({"successful", "failed", "canceled", "error"})


# ---------------------------------------------------------------------------
# umbrella #320 / #730 — switch-outcome classifier (SwitchSourceCommand.outcome).
#
# The outcome is decided ONLY from a structured outcome event, never from
# free text. dmf-runbooks' switch play emits exactly one event per run from
# a single dedicated task, ``dmf-l3-switch-outcome``. This module splits the
# work in two so a non-AWX backend can reuse the classifier:
#
# * ``SwitchOutcomeEvent`` + ``classify_switch_job_failure`` are backend-
#   agnostic: they take a token and a stage and know nothing about AWX.
# * ``switch_outcome_from_awx_events`` is the ONLY place that knows AWX's
#   job-event shape. It reads the dedicated task's own events, so a task
#   name or a caller-supplied value elsewhere in the job output (stdout,
#   other tasks' messages) cannot reach the classifier.
#
# When no valid event exists (an older runbooks release, a job that died
# before the emit, an events fetch that failed) the classifier returns the
# generic outcome derived from the job's terminal status alone: the console
# says the job failed and does not guess why.
SWITCH_OUTCOME_SUCCESS = "switch_success"
SWITCH_OUTCOME_PREVIOUS_SOURCE_RESTORED = "switch_failed_previous_source_restored"
SWITCH_OUTCOME_NO_PREVIOUS_SOURCE = "switch_failed_no_previous_source"
SWITCH_OUTCOME_RECOVERY_UNVERIFIED = "switch_failed_recovery_unverified"
SWITCH_OUTCOME_WATCH_TIMEOUT = "switch_watch_timeout"
SWITCH_OUTCOME_WATCH_LOST = "switch_watch_lost"

# The task name the switch play's outcome event is emitted from
# (roles/l3_run_guard/tasks/_emit_switch_outcome.yml in dmf-runbooks).
_SWITCH_OUTCOME_TASK_NAME = "dmf-l3-switch-outcome"

# The event's ``msg`` is ``DMF_L3_SWITCH_OUTCOME: <token> [detail=<stage>] ...``.
# ``detail=`` is always the FIRST field when present, so only that position
# is read: later fields can carry caller-supplied text and are ignored.
_SWITCH_OUTCOME_MSG_RE = re.compile(
    r"^DMF_L3_SWITCH_OUTCOME: (?P<token>[a-z0-9_]+)(?: detail=(?P<detail>[a-z0-9-]+))?(?: .*)?$"
)

# Structured outcome token -> console outcome enum (``refused`` is handled
# separately: its enum is built from the allowlisted detail).
_SWITCH_TOKEN_TO_OUTCOME = {
    "rollback_verified_previous_source_restored": SWITCH_OUTCOME_PREVIOUS_SOURCE_RESTORED,
    "rollback_verified_no_previous_source": SWITCH_OUTCOME_NO_PREVIOUS_SOURCE,
    "rollback_verification_failed": SWITCH_OUTCOME_RECOVERY_UNVERIFIED,
}

_SWITCH_GENERIC_JOB_OUTCOME = {
    "failed": "switch_job_failed",
    "error": "switch_job_error",
    "canceled": "switch_job_canceled",
}

# Operator copy for every outcome the console can report, so no view has to
# show a machine token as its primary text. Each message says what happened,
# what it means for the viewer, and what to do next. Messages claim "nothing
# changed" only for stages the play guarantees are read-only; later stages say
# what may already have been changed.
_SWITCH_OUTCOME_OPERATOR_COPY = {
    SWITCH_OUTCOME_PREVIOUS_SOURCE_RESTORED: (
        "Switch did not complete; the previous source was restored. Safe to retry."
    ),
    SWITCH_OUTCOME_NO_PREVIOUS_SOURCE: (
        "Switch did not complete; there was no previous source to restore. Safe to retry."
    ),
    SWITCH_OUTCOME_RECOVERY_UNVERIFIED: (
        "Switch did not complete; automatic recovery did not verify. "
        "Output may be parked; follow the recovery path."
    ),
    # No outcome event can also mean the events had not landed yet, so this
    # does not say that no refusal or rollback happened.
    "switch_job_failed": (
        "Switch did not complete and the console found no reported reason. The job may "
        "have refused or rolled back, and the viewer may have no active source. "
        "Check the current source, then retry."
    ),
    # An AWX "error" job can fail after it started, so its result is unknown.
    "switch_job_error": (
        "The switch job ended with an error, so its result is unknown. It may have "
        "changed the source. Check the current source before you retry."
    ),
    "switch_job_canceled": (
        "The switch job was canceled before it finished. The viewer may have no active "
        "source, or one that was not verified. Check the current source, then retry."
    ),
    # The watch checks its own deadline before it reads the job's status, so
    # the job may have finished just before the console stopped waiting.
    SWITCH_OUTCOME_WATCH_TIMEOUT: (
        "The console stopped waiting for the switch job, so its result is unknown. "
        "The job may still be running or may have finished. "
        "Check the current source before you retry."
    ),
    SWITCH_OUTCOME_WATCH_LOST: (
        "The console lost contact with the switch job, so its result is unknown. "
        "Check the current source before you retry."
    ),
}

# ``refused detail=<stage>`` copy, keyed by the stage the play was in. The
# label is set BEFORE the stage's tasks run, and the outer rescue reports
# whichever label is current, so each message claims only what holds for every
# task that can run under that label (dmf-runbooks' switch-mxl-fabrics-demo.yml):
#
# * Up to baseline-capture the play only reads (plus the facility lock).
# * quiesce clears the coordinator's active-source and target-info.
# * repoint covers the Helm re-point, the readiness verify and the whole
#   verify-failed branch: a verified helm rollback and the restore of the
#   previous source. A failure inside that branch before its own outcome is
#   recorded lands here, so rollback and source state are both unknown.
# * select covers the one Kubernetes write that sets the new source. That write
#   can apply even when the client reports an error.
# * final-readback covers the readback, its assert and the lock release. The
#   play re-reads because the write's own success is not trusted, so a failure
#   here can mean the source was never set. A failure of the lock release after a
#   passing readback means it was set and confirmed. The copy asserts neither.
# * The lock is a facility lock, not source state, so "unchanged" copy speaks
#   of the source only.
_SWITCH_NOTHING_CHANGED_COPY = (
    "Switch was refused before it changed the source. The current source is unchanged. "
    "Check the request, then retry."
)
_SWITCH_READ_ONLY_STAGE_COPY = (
    "Switch was refused while it read the current state, before any change to the source. "
    "The current source is unchanged. Retry; if it repeats, check the viewer's status."
)
_SWITCH_REFUSED_STAGE_COPY = {
    "pre-lock": _SWITCH_NOTHING_CHANGED_COPY,
    "reserved-var": _SWITCH_NOTHING_CHANGED_COPY,
    "coordinator-read": _SWITCH_READ_ONLY_STAGE_COPY,
    "chart-resolve": _SWITCH_READ_ONLY_STAGE_COPY,
    "baseline-capture": _SWITCH_READ_ONLY_STAGE_COPY,
    "quiesce": (
        "Switch stopped while it cleared the current source. The active source may "
        "already be cleared, so the viewer may receive no source. "
        "Check the current source, then retry."
    ),
    "repoint": (
        "Switch stopped after it started to re-point the viewer. The viewer may be "
        "re-pointed, rolled back or restored, and the active source may be cleared or "
        "restored. The console cannot tell which. Check that the viewer recovered and "
        "check the current source before you retry."
    ),
    "select": (
        "Switch stopped while it set the new active source. The selection may or may "
        "not have taken effect. Check the current source before you retry."
    ),
    "final-readback": (
        "Switch stopped while it confirmed the new source. The selection may have "
        "taken effect. Check the current source before you retry."
    ),
}
# Any other allowlisted detail: the console cannot tell how far the play got.
_SWITCH_REFUSED_FALLBACK_COPY = (
    "Switch was refused. The console cannot tell whether anything changed. "
    "Check the current source before you retry."
)
# An outcome this console version has no copy for.
_SWITCH_UNKNOWN_OUTCOME_COPY = (
    "Switch did not complete, and the console has no description for the result. "
    "Check the current source before you retry."
)


# Failures that have no outcome, keyed by the actuator's own error code.
_SWITCH_ERROR_COPY = {
    "switch-launch-failed": (
        "The console could not confirm that the switch job started. "
        "Check the current source before you retry."
    ),
    "switch-watch-crashed": (
        "The console could not read the switch job's status, so the result is unknown. "
        "Check the current source before you retry."
    ),
}
_SWITCH_TEMPLATE_MISSING_COPY = (
    "The switch job template is not available, so the switch did not run. "
    "Ask an administrator to check the automation setup."
)


def switch_failure_message(error: str, outcome: Optional[str]) -> str:
    """Operator copy for a failed switch: the outcome's message, else the
    message for the actuator's error code, else the unknown-outcome copy."""
    if outcome:
        message = switch_outcome_message(outcome)
        if message:
            return message
    if error.startswith("switch-job-template-missing"):
        return _SWITCH_TEMPLATE_MISSING_COPY
    return _SWITCH_ERROR_COPY.get(error, _SWITCH_UNKNOWN_OUTCOME_COPY)


def switch_outcome_message(outcome: str) -> Optional[str]:
    """Operator copy for a switch outcome; ``None`` only for success."""
    if outcome == SWITCH_OUTCOME_SUCCESS:
        return None
    message = _SWITCH_OUTCOME_OPERATOR_COPY.get(outcome)
    if message:
        return message
    if outcome.startswith("switch_refused_"):
        return _SWITCH_REFUSED_STAGE_COPY.get(
            outcome.removeprefix("switch_refused_"), _SWITCH_REFUSED_FALLBACK_COPY
        )
    return _SWITCH_UNKNOWN_OUTCOME_COPY


@dataclass(frozen=True)
class SwitchOutcomeEvent:
    """A backend-neutral structured switch outcome: the token the switch
    play reported and, for ``refused``, the stage it reported."""

    token: str
    detail: Optional[str] = None


def switch_outcome_from_awx_events(events: list[Any]) -> Optional[SwitchOutcomeEvent]:
    """Map AWX job events to a ``SwitchOutcomeEvent``, or ``None``.

    Only events whose own ``task`` field is the dedicated outcome task are
    read, even though the fetch already filters by task name: the events are
    untrusted API data. The LAST valid event wins. Every level of the event
    is shape-checked, so a malformed event is skipped, never raised on.
    """
    for event in reversed(events):
        if not isinstance(event, dict) or event.get("task") != _SWITCH_OUTCOME_TASK_NAME:
            continue
        event_data = event.get("event_data")
        res = event_data.get("res") if isinstance(event_data, dict) else None
        msg = res.get("msg") if isinstance(res, dict) else None
        match = _SWITCH_OUTCOME_MSG_RE.match(msg.strip()) if isinstance(msg, str) else None
        if match:
            return SwitchOutcomeEvent(token=match.group("token"), detail=match.group("detail"))
    return None


def classify_switch_job_failure(
    job_status: str, outcome: Optional[SwitchOutcomeEvent]
) -> tuple[str, Optional[str]]:
    """Classify a TERMINAL, non-successful switch job into one of the
    ``switch_*`` outcome enums, with its operator message.

    ``outcome`` is the structured event, or ``None`` when there is none.
    A missing, unrecognised or detail-less event falls back to the generic
    outcome derived from ``job_status``. Pure, so tests need no AWX mocking.
    """
    result = _classify_switch_outcome(job_status, outcome)
    return result, switch_outcome_message(result)


def _classify_switch_outcome(job_status: str, outcome: Optional[SwitchOutcomeEvent]) -> str:
    if outcome is not None:
        enum = _SWITCH_TOKEN_TO_OUTCOME.get(outcome.token)
        if enum:
            return enum
        # Only allowlisted details become an enum member, so an event cannot
        # mint an unbounded switch_refused_<anything> value.
        if outcome.token == "refused" and outcome.detail in KV_DETAIL_TOKENS:
            return f"switch_refused_{outcome.detail}"
    return _SWITCH_GENERIC_JOB_OUTCOME.get(job_status, f"switch_job_{job_status}")


class ReconnectViaAwxActuator:
    """v0.2b's coarse `reconnect` actuator (spec §6.2), implemented as an
    AWX job launch.

    WHY AWX, NOT A DIRECT CLUSTER CALL: dmf-cms has categorically NO
    Kubernetes client anywhere in this codebase — drain.py, settings.py's
    L3Settings, awx.py, and capacity.py each independently document this
    ("the console has NO k8s client and cannot read the launcher's
    snapshot ConfigMap"; "no k8s client in the console"; "capacity.py has
    no k8s client and no direct HTTP calls"). Every existing
    console-triggered cluster mutation goes through AWX
    (operations.OperationStore + main.py's job watcher, for deploy/
    teardown/rollback) or is a pure NetBox intent-flip with NO cluster
    touch at all (media_workloads.clear_for_deployment: "NetBox is the
    ONLY thing the console writes ... never k3s from here"). §6.2's three
    phases (quiesce the coordinator ConfigMap, re-point + restart the
    viewer, select) need direct, sequenced, feedback-confirmed cluster
    mutation — the intent-flip shape doesn't fit at all — so this actuator
    follows the FIRST precedent: launch a named job template, poll it to a
    terminal AWX status, map that outcome onto SwitchStatus. All AWX-
    specific plumbing (job template id lookup, launch, polling, the
    extra_vars shape) lives HERE, never on SwitchSourceCommand/SwitchStatus
    — the §6.3 structural requirement this module's own contract test
    proves.

    umbrella #201 WP4b (a NAMED follow-on this work does NOT build): the
    ACTUAL quiesce -> re-point -> select sequencing (spec §6.2's three
    phases, against the mxl-coordinator ConfigMap + the viewer's own Helm
    release) happens INSIDE the AWX job's own playbook — a new
    dmf-runbooks playbook + a dmf-infra job-template registration (+ the
    grant-regex extension noted on SWITCH_SOURCE_JOB_TEMPLATE_NAME above),
    none of which this repo owns. This actuator is code-complete and fully
    tested against a MOCKED AWX launch/poll cycle (tests/test_switch_source.py);
    it is NOT operationally live end-to-end until WP4b's playbook+JT land
    — the identical "gate landed, live run blocked on a sibling WP" shape
    the spec's own §8/WP-L3 already establishes for the launch side ("no
    live multi-source J1 run happens before #202's preflight+rollback
    land"). Say so plainly in any status report; this is an intentional,
    tracked sequencing gap, not a hidden one.

    EXTRA_VARS PAYLOAD CONTRACT (WP4b's own input contract — keep this
    docstring and ``_build_extra_vars`` in lock-step; a test asserts they
    match):

      topology_params  — the receiver's OWN validated topology_params
                          object (dmf-media catalog/topology-params.schema.yaml,
                          loaded via catalog.load_topology_instance), with
                          ``viewer.source_selection`` REASSIGNED to this
                          command's own ``source_instance`` (the switch
                          TARGET, never whatever the catalog instance file
                          happened to author). This is the IDENTICAL object
                          shape WP3's own launcher already consumes
                          (l3_topology_viewer_projection) — WP4b's playbook
                          derives BOTH the new active-source value and the
                          viewer's own re-derived flow.id by reusing that
                          EXISTING Ansible filter verbatim, zero new
                          derivation logic, zero re-authored schema (spec
                          §3.3's own "survives the actuator upgrade
                          unchanged" requirement, honored one hop further).
                          ``target_facility`` rides through UNCHANGED from
                          whatever the loaded instance carries — this
                          actuator does not re-resolve it (WP4b's own job
                          template is assumed prebound to the single J1
                          facility, the same way the launch JTs already
                          are, spec §3.4).
      receiver_instance — this command's own receiver_instance verbatim
                          (the viewer's concrete NetBox/Helm identity,
                          e.g. "mxl-videotest-view") — topology_params.viewer.id
                          is a LOGICAL slug (e.g. "viewer-a"), not
                          necessarily this concrete name, so WP4b's
                          playbook needs this explicitly to know which
                          Helm release/coordinator ConfigMap to act on.
      source_instance   — this command's own source_instance verbatim,
                          redundant with topology_params.viewer.source_selection
                          above BY CONSTRUCTION — an explicit, named field
                          rather than relying on the playbook to dig it
                          back out of the nested object.
      reason            — the operator-supplied reason string, for the AWX
                          job's OWN task naming/traceability within AWX
                          itself — NOT a substitute for WP5's future C5
                          audit (spec §7 step 5: that audit goes to the
                          dmf-cms log + Activity lane, never into AWX
                          extra_vars — clear-for-deployment's own
                          precedent, ``_audit_awx_write``). This field
                          exists purely so an operator inspecting the AWX
                          job later sees WHY it ran.
    """

    def __init__(
        self,
        *,
        awx_api_url: str,
        awx_api_token: str,
        awx_ssl_verify: bool = True,
        job_template_name: str = SWITCH_SOURCE_JOB_TEMPLATE_NAME,
        timeout_seconds: float = _DEFAULT_ACTUATOR_TIMEOUT_SECONDS,
        poll_interval_seconds: float = _DEFAULT_POLL_INTERVAL_SECONDS,
        autoscale_helper_url: str = "",
        autoscale_bearer_token: str = "",
        autoscale_max_startup_wait: int = 1260,
    ) -> None:
        self._awx_api_url = awx_api_url
        self._awx_api_token = awx_api_token
        self._awx_ssl_verify = awx_ssl_verify
        self._job_template_name = job_template_name
        self._timeout_seconds = timeout_seconds
        self._poll_interval_seconds = poll_interval_seconds
        # #295: this actuator used to go straight to an authenticated lookup
        # with no wake at all. Under autoscale that is strictly worse than
        # the deploy path's race — with AWX asleep the switch simply failed.
        # It now performs the SAME sanctioned wake, then the same
        # deadline-bounded post-wake read. ensure_awx_awake is a documented
        # no-op when these are empty, so a non-autoscale deployment (and
        # every existing test that constructs the actuator without them)
        # behaves exactly as before.
        self._autoscale_helper_url = autoscale_helper_url
        self._autoscale_bearer_token = autoscale_bearer_token
        self._autoscale_max_startup_wait = autoscale_max_startup_wait

    @staticmethod
    def _build_extra_vars(command: SwitchSourceCommand, topology_params: dict[str, Any]) -> dict[str, Any]:
        """Pure — the EXACT extra_vars payload WP4b's playbook receives.
        See this class's own EXTRA_VARS PAYLOAD CONTRACT docstring; kept as
        its own static method (not inlined into ``execute``) so a test can
        assert its output directly, independent of any AWX mocking.
        """
        retargeted = dict(topology_params)
        viewer = dict(retargeted.get("viewer") or {})
        viewer["source_selection"] = command.source_instance
        retargeted["viewer"] = viewer
        return {
            "topology_params": retargeted,
            "receiver_instance": command.receiver_instance,
            "source_instance": command.source_instance,
            "reason": command.reason,
        }

    async def execute(self, command: SwitchSourceCommand, topology_params: dict[str, Any]) -> None:
        command.status = SwitchStatus.RECONNECTING
        command.updated_at = datetime.now(timezone.utc)

        try:
            # #295: wake precondition is encoded here, not assumed of the
            # caller — then the first authenticated call rides the same
            # deadline-bounded post-wake read policy the deploy path uses.
            await run_in_threadpool(
                _awx.ensure_awx_awake,
                helper_url=self._autoscale_helper_url,
                bearer_token=self._autoscale_bearer_token,
                max_startup_wait=self._autoscale_max_startup_wait,
            )
            template = await run_in_threadpool(
                _awx.call_with_readiness_retry,
                functools.partial(
                    _awx.lookup_job_template_by_name,
                    api_url=self._awx_api_url,
                    api_token=self._awx_api_token,
                    name=self._job_template_name,
                    ssl_verify=self._awx_ssl_verify,
                ),
            )
            if template is None:
                self._fail(
                    command,
                    f"switch-job-template-missing: no AWX job template named "
                    f"'{self._job_template_name}' (umbrella #201 WP4b has not "
                    f"landed yet — see ReconnectViaAwxActuator's own docstring)",
                )
                return

            extra_vars = self._build_extra_vars(command, topology_params)
            job_id = await run_in_threadpool(
                _awx.launch_job,
                api_url=self._awx_api_url,
                api_token=self._awx_api_token,
                job_template_id=template["id"],
                ssl_verify=self._awx_ssl_verify,
                extra_vars=extra_vars,
            )
        except Exception as exc:  # noqa: BLE001 - actuator-level failure, not a crash
            # exc may be AWXAPIError
            # (from launch_job), whose str() embeds AWX's own raw response
            # body — upstream response content. command.command_id is a
            # server-generated uuid4, not sanitized (same classification
            # as request_id/operation_id elsewhere).
            logger.warning(
                "switch-source actuator: launch failed for command %s: %s",
                command.command_id, sanitize_audit_field(str(exc)),
            )
            self._fail(command, "switch-launch-failed")
            return

        deadline = datetime.now(timezone.utc) + timedelta(seconds=self._timeout_seconds)
        consecutive_failures = 0
        while True:
            if datetime.now(timezone.utc) > deadline:
                self._fail(command, "switch-watch-timeout", outcome=SWITCH_OUTCOME_WATCH_TIMEOUT)
                return

            try:
                job = await run_in_threadpool(
                    _awx.get_job,
                    api_url=self._awx_api_url,
                    api_token=self._awx_api_token,
                    job_id=job_id,
                    ssl_verify=self._awx_ssl_verify,
                )
                consecutive_failures = 0
            except Exception:
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    self._fail(command, "switch-watch-lost", outcome=SWITCH_OUTCOME_WATCH_LOST)
                    return
                await asyncio.sleep(self._poll_interval_seconds)
                continue

            if not isinstance(job, dict) or not isinstance(job.get("status"), str):
                self._fail(command, "switch-watch-crashed")
                return

            status = job["status"]
            if status in _TERMINAL_JOB_STATUSES:
                if status == "successful":
                    command.status = SwitchStatus.ACTIVE
                    command.error = None
                    command.outcome = SWITCH_OUTCOME_SUCCESS
                    command.outcome_message = None
                    command.updated_at = datetime.now(timezone.utc)
                else:
                    # §6.2's own failure posture: a job failure (for any
                    # reason — the viewer restart step failing being the
                    # spec's own worked example) leaves active-source
                    # cleared on the CLUSTER side (WP4b's own playbook
                    # responsibility) and is reported here as
                    # failed_rollback_required for operator retry/rollback
                    # — "no new rollback logic in WP4" (umbrella #201): this actuator's only job is to
                    # report the state accurately, never to auto-remediate.
                    #
                    # umbrella #730: classify from the switch play's structured
                    # outcome event only, once AWX has ingested the job's events. No event degrades to the generic,
                    # job-status-derived outcome; raw output is never read.
                    await self._await_event_ingestion(job_id, job)
                    outcome_event = await self._fetch_switch_outcome_safe(job_id)
                    outcome, _ = classify_switch_job_failure(status, outcome_event)
                    self._fail(command, f"switch-job-{status}", outcome=outcome)
                return

            await asyncio.sleep(self._poll_interval_seconds)

    async def _await_event_ingestion(self, job_id: int, job: dict) -> None:
        """Wait, bounded, for AWX's ``event_processing_finished`` flag.

        AWX reports a job terminal before every job event has landed, so an
        immediate fetch can miss the outcome event and record a real refusal or
        rollback as a generic failure. This mirrors main.py's
        ``_await_event_ingestion_finished`` (same bound, same rule that only
        three consecutive ``get_job`` failures end the wait early). When the
        bound runs out the caller classifies from whatever events exist.
        """
        if job.get("event_processing_finished", False):
            return
        consecutive_failures = 0
        for _ in range(_awx.EVENT_INGESTION_MAX_EXTRA_POLLS):
            await asyncio.sleep(self._poll_interval_seconds)
            try:
                job = await run_in_threadpool(
                    _awx.get_job,
                    api_url=self._awx_api_url,
                    api_token=self._awx_api_token,
                    job_id=job_id,
                    ssl_verify=self._awx_ssl_verify,
                )
            except Exception:
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    return
                continue
            consecutive_failures = 0
            if isinstance(job, dict) and job.get("event_processing_finished", False):
                return

    async def _fetch_switch_outcome_safe(self, job_id: int) -> Optional[SwitchOutcomeEvent]:
        """Best-effort fetch of the switch play's outcome event. A fetch
        failure (network error, AWX unavailable, ...) must never crash the
        watcher or block the already-known job-status-derived failure
        classification; it just means there is no structured outcome."""
        try:
            events = await run_in_threadpool(
                _awx.get_job_events_for_task,
                api_url=self._awx_api_url,
                api_token=self._awx_api_token,
                job_id=job_id,
                task_name=_SWITCH_OUTCOME_TASK_NAME,
                ssl_verify=self._awx_ssl_verify,
            )
        except Exception:
            return None
        return switch_outcome_from_awx_events(events)

    @staticmethod
    def _fail(
        command: SwitchSourceCommand,
        error: str,
        *,
        outcome: Optional[str] = None,
    ) -> None:
        command.status = SwitchStatus.FAILED_ROLLBACK_REQUIRED
        command.error = error
        command.outcome = outcome
        command.outcome_message = switch_failure_message(error, outcome)
        command.updated_at = datetime.now(timezone.utc)


def resolve_topology_for_receiver(
    *, receiver_instance: str, catalog_dir: str = CATALOG_DIR
) -> dict[str, Any]:
    """Resolve ``receiver_instance``'s own catalog entry + validated
    topology_params — the actuator-agnostic precondition EVERY actuator
    needs (which sources exist, which one is the current selection),
    shared here rather than duplicated per-actuator. Raises
    ``SwitchSourceError`` (never returns a partial/best-effort result) for:

      * ``receiver-not-found`` — no catalog entry with this key.
      * ``receiver-not-topology`` — the entry exists but carries no
        ``topology_ref`` at all (not a topology-shaped instance — nothing
        to switch).
      * ``topology-invalid`` — the referenced topology_params instance
        itself fails ``catalog.load_topology_instance``'s own validation
        (a catalog-authoring defect, WP1's concern, not this command's).
    """
    entries = load_catalog_entries(catalog_dir)
    state = topology_state_for(entries, receiver_instance)
    if state == "not-found":
        raise SwitchSourceError("receiver-not-found", f"no catalog entry named '{receiver_instance}'")
    if state == "not-topology":
        raise SwitchSourceError(
            "receiver-not-topology",
            f"catalog entry '{receiver_instance}' carries no topology_ref — not a topology-shaped instance",
        )
    entry = next(e for e in entries if e.key == receiver_instance)
    topology_params, error = load_topology_instance(catalog_dir, entry.topology_ref)
    if error is not None or topology_params is None:
        raise SwitchSourceError("topology-invalid", error or "topology_params failed to load")
    return topology_params


async def dispatch_switch_source(
    *,
    receiver_instance: str,
    source_instance: str,
    reason: str,
    store: SwitchCommandStore,
    actuator: SwitchActuator,
    catalog_dir: str = CATALOG_DIR,
    request_id: Optional[str] = None,
    initiator: Optional[str] = None,
    observed_previous_source: Optional[str] = None,
) -> SwitchSourceCommand:
    """The thin seam WP5's future HTTP endpoint calls into (spec §7):
    resolve the receiver's own topology, validate the requested
    source_instance is a real switch target, create + persist a
    SwitchSourceCommand (status=PENDING), and AWAIT the actuator to
    completion before returning the (now terminal) command.

    Raises ``SwitchSourceError`` for a request-shape problem (see
    ``resolve_topology_for_receiver`` and the ``source-not-found`` check
    below) — BEFORE any command is created, so WP5 can turn it straight
    into a 404/422 with nothing to clean up. Once a command exists, this
    function does not raise for an actuator-level failure — that lands as
    ``SwitchStatus.FAILED_ROLLBACK_REQUIRED`` on the returned command,
    which WP5 reports as a normal (if unhappy) response, not an HTTP
    error.

    Synchronous-await shape (not fire-and-forget): §6.2's coarse sequence
    is expected to complete in seconds; WP5 is free to wrap this call in
    its own background task if a future actuator's own latency profile
    changes that — this function's own contract (create, dispatch, return
    the terminal command) does not change either way.

    IDEMPOTENCY/RE-ENTRY: if a NON-terminal command already exists for
    this SAME receiver_instance (two tabs, a double-click, or two
    concurrent async callers racing while the first is still mid-flight —
    the store's own PENDING/RECONNECTING window is real: ``await
    actuator.execute()`` yields control at every ``run_in_threadpool``/
    ``asyncio.sleep`` point), this returns THAT existing command instead
    of creating a second one and dispatching a second, concurrent actuator
    run against the same receiver — mirrors ``awx.find_active_job_for_template``'s
    own "a double-click... gets the SAME result back instead of spawning a
    duplicate" rationale, scoped per-receiver here (two different viewers
    switching at once are unrelated operations, not a collision — unlike
    the AWX-JT-level dedup deploy uses, which is scoped to the WHOLE job
    template).
    """
    existing = store.find_active(receiver_instance)
    if existing is not None:
        return existing

    topology_params = resolve_topology_for_receiver(
        receiver_instance=receiver_instance, catalog_dir=catalog_dir
    )
    source_ids = [s.get("id") for s in (topology_params.get("sources") or [])]
    if source_instance not in source_ids:
        raise SwitchSourceError(
            "source-not-found",
            f"'{source_instance}' does not reference a known sources[].id {source_ids}",
        )

    # umbrella #320/#321: previous_source must reflect what was
    # ACTUALLY running, never the catalog's own (possibly stale)
    # viewer.source_selection — the same "declared intent, not live truth"
    # bug the read path fixed. The HTTP endpoint (main.py) always resolves
    # observed truth itself and passes it here BEFORE ever reaching this
    # point; the catalog fallback below only serves a caller with no
    # observed truth available (none exists today — kept for the
    # SwitchActuator Protocol's own non-HTTP contract test, which has no
    # sidecar to observe at all).
    previous_source = (
        observed_previous_source
        if observed_previous_source is not None
        else (topology_params.get("viewer") or {}).get("source_selection")
    )
    command = store.create(
        receiver_instance=receiver_instance,
        source_instance=source_instance,
        reason=reason,
        request_id=request_id,
        initiator=initiator,
        previous_source=previous_source,
    )

    await actuator.execute(command, topology_params)
    return command
