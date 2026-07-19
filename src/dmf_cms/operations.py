"""Operation tracking for async AWX launches.

This module provides an in-memory operation store for tracking async
AWX launch operations (workflow launch, catalog deploy, catalog teardown).

SINGLE REPLICA ASSUMPTION: This store is in-memory only and not replicated
across multiple dmf-cms replicas. If horizontal scaling is needed, this
must be replaced with a persistent store (PostgreSQL, Redis, etc.).
"""

import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class OperationState(str, Enum):
    """State machine for async operations.

    umbrella #202 WP2: the pre-WP2 machine terminated at LAUNCHED — the
    console never observed AWX job completion. Four states were added to
    track a run to its job-terminal outcome:

    * RUNNING — the job is executing in AWX post-launch (the watcher's
      first successful poll after LAUNCHED).
    * RUN_COMPLETE — the job finished successfully.
    * RUN_FAILED — the job failed WITHOUT ever starting (nothing mutated,
      or — for teardown/rollback — failed after starting; those actions
      are themselves idempotent cleanup, so a retry is the recovery path,
      not an auto-rollback trigger).
    * FAILED_ROLLBACK_REQUIRED — a DEPLOY job started then failed: surfaces
      may be dirty. The plan §4.5 auto-rollback trigger state.
    * ROLLBACK_INCOMPLETE — codex R2-1: a ROLLBACK op's own fail-closed
      terminal. RUN_COMPLETE for a rollback requires BOTH a successful AWX
      job status AND an exact ``rollback_complete`` outcome marker — every
      other combination (job failed, marker missing, marker says
      ``rollback_incomplete``, marker is some other token, the stdout fetch
      itself failed) lands here instead of RUN_FAILED, so a dirty facility
      is never silently treated as clean. See main.py
      ``_watch_job_operation`` and ``_facility_busy_check``'s dirty-state
      handling.
    * RUN_STATUS_UNKNOWN — codex R3-2: the watcher gave up (TTL timeout, 3
      consecutive ``get_job`` failures, or an unexpected crash) AFTER
      observing the job had started, for a NON-rollback watched action.
      Distinct from FAILED_ROLLBACK_REQUIRED: that state means a CONFIRMED
      AWX job failure was actually observed (and the auto-rollback trigger
      contract runs); this one means the watcher simply lost track of a
      run that may still be executing — we genuinely don't know its
      outcome. Treated as DIRTY (like FAILED_ROLLBACK_REQUIRED) by
      ``_facility_busy_check`` — an operator must resolve it (or its
      matching rollback, once identity is known) before the facility is
      considered clean again — but NEVER auto-triggers a rollback itself
      (the job might still be running; dispatching a rollback against a
      run that later turns out to have succeeded would be actively
      harmful). See ``main._watch_lost_terminal_state``.

    FAILED_ROLLBACK_REQUIRED, ROLLBACK_INCOMPLETE, and RUN_STATUS_UNKNOWN
    are all "terminal" for dedupe/GC purposes (a retry can create a fresh
    op for the same target once one lands) but are additionally treated as
    DIRTY by ``_facility_busy_check`` — a dirty op still blocks new
    dispatches to OTHER targets (and, since codex R3-1, even the SAME
    target) even though it's no longer "in flight" from the ops store's
    own point of view.

    Which states are TERMINAL now depends on the action — see
    ``terminal_states()``. LAUNCHED itself changed meaning for
    deploy/teardown/rollback: it used to be terminal ("AWX accepted the
    launch, we're done watching"); now it means "handed to AWX, watcher
    attached" and is non-terminal until the watcher resolves the run. A
    plain "launch" (generic AWX workflow launch, #202's job-tracking
    substrate doesn't cover it — no watcher is ever attached) keeps the
    pre-WP2 meaning: LAUNCHED stays terminal there.
    """
    WAKING = "waking"
    LAUNCHING = "launching"
    LAUNCHED = "launched"
    RUNNING = "running"
    RUN_COMPLETE = "run_complete"
    RUN_FAILED = "run_failed"
    FAILED_ROLLBACK_REQUIRED = "failed_rollback_required"
    ROLLBACK_INCOMPLETE = "rollback_incomplete"
    RUN_STATUS_UNKNOWN = "run_status_unknown"
    ERROR = "error"


# Actions whose ops get a job-terminal watcher attached (#202 WP2). Every
# other action (today: "launch", the generic AWX workflow launch) has no
# watcher, so LAUNCHED stays its own terminal state — see terminal_states().
_WATCHED_ACTIONS = frozenset({"deploy", "teardown", "rollback"})

_LAUNCH_TERMINAL_STATES = frozenset({OperationState.LAUNCHED, OperationState.ERROR})
_WATCHED_TERMINAL_STATES = frozenset({
    OperationState.RUN_COMPLETE,
    OperationState.RUN_FAILED,
    OperationState.FAILED_ROLLBACK_REQUIRED,
    OperationState.ROLLBACK_INCOMPLETE,
    OperationState.RUN_STATUS_UNKNOWN,
    OperationState.ERROR,
})

# codex R2-6/R3-2: the subset of terminal states that are additionally
# DIRTY — the run reached a stop but may have left the facility's surfaces
# in an inconsistent state. _facility_busy_check (main.py) treats these as
# blocking even though they're terminal for dedupe/GC purposes.
DIRTY_STATES = frozenset({
    OperationState.FAILED_ROLLBACK_REQUIRED,
    OperationState.ROLLBACK_INCOMPLETE,
    OperationState.RUN_STATUS_UNKNOWN,
})


def terminal_states(action: str) -> frozenset[OperationState]:
    """Return the terminal-state set for a given operation action.

    codex #202 WP2: terminality is action-aware, not a single global set.
    ``deploy``/``teardown``/``rollback`` ops get a job-terminal watcher
    (main.py ``_watch_job_operation``) and terminate at RUN_COMPLETE /
    RUN_FAILED / FAILED_ROLLBACK_REQUIRED / ERROR — LAUNCHED is a
    mid-flight state for them ("handed to AWX, watcher attached"). Every
    other action (``launch``) has no watcher and keeps the pre-WP2 set —
    LAUNCHED IS terminal there, since nothing will ever move it further.
    """
    if action in _WATCHED_ACTIONS:
        return _WATCHED_TERMINAL_STATES
    return _LAUNCH_TERMINAL_STATES


@dataclass
class Operation:
    """Represents an async AWX launch operation."""
    operation_id: str
    action: str  # "launch" | "deploy" | "teardown" | "rollback"
    target: str  # workflow name or catalog key
    state: OperationState
    job_id: int | None = None
    error: str | None = None
    # umbrella #202 WP2: request_id is the C5 request_id minted at dispatch
    # (set once, at creation — a reattach never overwrites it, since it
    # identifies the ORIGINAL request that started this run). initiator is
    # the dispatching user's subject. l3_outcome is a parsed launcher-side
    # outcome token; WP2-A leaves it unset, WP2-B's marker-parsing fills it.
    request_id: str | None = None
    initiator: str | None = None
    l3_outcome: str | None = None
    # codex R2-3: auto-trigger status, kept SEPARATE from l3_outcome (which
    # always keeps the raw launcher token, never overwritten). One of
    # "triggered" | "disabled" | "already-in-progress" | "identity-unknown"
    # | None (not yet evaluated, or this op never reached
    # FAILED_ROLLBACK_REQUIRED/RUN_STATUS_UNKNOWN).
    auto_rollback: str | None = None
    # codex R3-3: this op's RUN identity — what a rollback command's own
    # run_id must equal to target THIS run. For a FRESH dispatch this is
    # always the op's own request_id (set explicitly at launch time, not
    # round-tripped through AWX). For a REATTACH to an AWX job this console
    # didn't itself just launch (an already-active job found via AWX
    # query), it's hydrated from that job's own extra_vars.l3_request_id —
    # None if that job carries no such var or it can't be parsed, meaning
    # this run's identity is genuinely unknown to the console (see
    # main._maybe_auto_trigger_rollback's "identity-unknown" handling).
    run_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Serialize to API response format."""
        return {
            "operation_id": self.operation_id,
            "action": self.action,
            "target": self.target,
            "state": self.state.value,
            "job_id": self.job_id,
            "error": self.error,
            "request_id": self.request_id,
            "initiator": self.initiator,
            "l3_outcome": self.l3_outcome,
            "auto_rollback": self.auto_rollback,
            "run_id": self.run_id,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class OperationStore:
    """Thread-safe in-memory operation store with TTL garbage collection.

    SINGLE REPLICA ASSUMPTION: Operations are stored in memory only.
    If dmf-cms is horizontally scaled, operations will not be visible
    across replicas. This is acceptable for v0.1 (single replica).
    """

    def __init__(self, ttl_seconds: int = 3600):
        """Initialize store with TTL for completed operations.

        Args:
            ttl_seconds: Time to keep completed/failed operations before GC
        """
        self._operations: dict[str, Operation] = {}
        self._lock = threading.RLock()
        self._ttl_seconds = ttl_seconds

    @property
    def ttl_seconds(self) -> int:
        """Public accessor (umbrella #202 WP2): the job watcher uses this
        as its overall watch-window budget (op.created_at + ttl_seconds),
        not just a post-terminal GC interval — see main.py
        ``_watch_job_operation``."""
        return self._ttl_seconds

    def create(
        self,
        action: str,
        target: str,
        initial_state: OperationState = OperationState.WAKING,
        request_id: str | None = None,
        initiator: str | None = None,
    ) -> Operation:
        """Create a new operation.

        Args:
            action: Operation type (launch|deploy|teardown|rollback)
            target: Workflow name or catalog key
            initial_state: Initial state (default: WAKING)
            request_id: C5 request_id minted at dispatch (#202 WP2)
            initiator: Dispatching user's subject (#202 WP2)

        Returns:
            Newly created Operation
        """
        with self._lock:
            self._gc()
            operation_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc)
            op = Operation(
                operation_id=operation_id,
                action=action,
                target=target,
                state=initial_state,
                request_id=request_id,
                initiator=initiator,
                created_at=now,
                updated_at=now,
            )
            self._operations[operation_id] = op
            return op

    def get(self, operation_id: str) -> Operation | None:
        """Retrieve an operation by ID.

        Args:
            operation_id: UUID of the operation

        Returns:
            Operation if found and not expired, None otherwise
        """
        with self._lock:
            self._gc()
            return self._operations.get(operation_id)

    def find_active(self, action: str, target: str) -> Operation | None:
        """Find an active (non-terminal) operation for the given action+target.

        Terminal states are action-aware — see ``terminal_states()``.

        Args:
            action: Operation type
            target: Workflow name or catalog key

        Returns:
            Active operation if exists, None otherwise
        """
        with self._lock:
            self._gc()
            for op in self._operations.values():
                if (
                    op.action == action
                    and op.target == target
                    and op.state not in terminal_states(op.action)
                ):
                    return op
            return None

    def get_or_create(
        self,
        action: str,
        target: str,
        initial_state: OperationState = OperationState.WAKING,
        request_id: str | None = None,
        initiator: str | None = None,
    ) -> tuple[Operation, bool]:
        """Atomically find an active operation or create a new one.

        This is the atomic dedupe primitive: under a single lock, check if
        a non-terminal operation exists for (action, target). If yes, return
        it (request_id/initiator are NOT overwritten — they belong to the
        original dispatch). If no, create a new one and return it.

        Args:
            action: Operation type (launch|deploy|teardown|rollback)
            target: Workflow name or catalog key
            initial_state: Initial state for new operation (default: WAKING)
            request_id: C5 request_id, set only if a new op is created
            initiator: Dispatching user's subject, set only if created

        Returns:
            Tuple of (operation, created) where created is True if a new
            operation was created, False if an existing one was returned.
        """
        with self._lock:
            self._gc()
            # Check for existing non-terminal operation
            for op in self._operations.values():
                if (
                    op.action == action
                    and op.target == target
                    and op.state not in terminal_states(op.action)
                ):
                    return (op, False)
            # Create new operation
            operation_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc)
            op = Operation(
                operation_id=operation_id,
                action=action,
                target=target,
                state=initial_state,
                request_id=request_id,
                initiator=initiator,
                created_at=now,
                updated_at=now,
            )
            self._operations[operation_id] = op
            return (op, True)

    def get_or_create_exclusive(
        self,
        action: str,
        target: str,
        initial_state: OperationState = OperationState.WAKING,
        conflicts: tuple[str, ...] = (),
        request_id: str | None = None,
        initiator: str | None = None,
    ) -> tuple[Operation | None, bool, Operation | None]:
        """Atomically find/create an operation, exclusive of conflicting actions.

        Same reattach behavior as get_or_create for (action, target), but
        additionally refuses to create a new operation while an active
        (non-terminal) operation exists for the same target under a
        conflicting action (e.g. deploy vs. teardown of the same catalog
        entry, #24). "Active" is action-aware per conflicting op — see
        ``terminal_states()``.

        Args:
            action: Operation type (deploy|teardown|rollback)
            target: Catalog key
            initial_state: Initial state for new operation (default: WAKING)
            conflicts: Actions that block creation for the same target
            request_id: C5 request_id, set only if a new op is created
            initiator: Dispatching user's subject, set only if created

        Returns:
            Tuple of (operation, created, conflict):
              - (op, False, None): reattached to an existing same-action op
              - (None, False, conflict_op): blocked by a conflicting active op
              - (new_op, True, None): created
        """
        with self._lock:
            self._gc()
            for op in self._operations.values():
                if (
                    op.action == action
                    and op.target == target
                    and op.state not in terminal_states(op.action)
                ):
                    return (op, False, None)
            for op in self._operations.values():
                if (
                    op.action in conflicts
                    and op.target == target
                    and op.state not in terminal_states(op.action)
                ):
                    return (None, False, op)
            operation_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc)
            op = Operation(
                operation_id=operation_id,
                action=action,
                target=target,
                state=initial_state,
                request_id=request_id,
                initiator=initiator,
                created_at=now,
                updated_at=now,
            )
            self._operations[operation_id] = op
            return (op, True, None)

    def update(
        self,
        operation_id: str,
        state: OperationState | None = None,
        job_id: int | None = None,
        error: str | None = None,
        l3_outcome: str | None = None,
        auto_rollback: str | None = None,
        run_id: str | None = None,
    ) -> Operation | None:
        """Update an operation's state and/or fields.

        Args:
            operation_id: UUID of the operation
            state: New state (optional)
            job_id: AWX job ID (optional, set when launched)
            error: Error message (optional, set when state=ERROR/RUN_FAILED/
                FAILED_ROLLBACK_REQUIRED/ROLLBACK_INCOMPLETE/
                RUN_STATUS_UNKNOWN)
            l3_outcome: Parsed launcher-side outcome token (#202 WP2-B).
                Always the RAW token — never overwritten by auto-trigger
                bookkeeping (codex R2-3; see ``auto_rollback``).
            auto_rollback: Auto-trigger status, kept separate from
                l3_outcome (codex R2-3)
            run_id: This op's run identity (codex R3-3) — set once, at
                LAUNCHED time (fresh dispatch or reattach hydration); never
                explicitly cleared back to None via this call (a caller
                passing ``run_id=None`` is "nothing to set this round", the
                same convention as every other optional field here — an
                intentionally-unknown identity is represented by simply
                never calling update with a value, not by this method).

        Returns:
            Updated Operation if found, None otherwise
        """
        with self._lock:
            op = self._operations.get(operation_id)
            if op is None:
                return None

            if state is not None:
                op.state = state
            if job_id is not None:
                op.job_id = job_id
            if error is not None:
                op.error = error
            if l3_outcome is not None:
                op.l3_outcome = l3_outcome
            if auto_rollback is not None:
                op.auto_rollback = auto_rollback
            if run_id is not None:
                op.run_id = run_id
            op.updated_at = datetime.now(timezone.utc)

            return op

    def _gc(self):
        """Garbage collect expired operations (internal, called with lock held)."""
        now = datetime.now(timezone.utc)
        to_delete = []
        for op_id, op in self._operations.items():
            if op.state in terminal_states(op.action):
                age = (now - op.updated_at).total_seconds()
                if age > self._ttl_seconds:
                    to_delete.append(op_id)

        for op_id in to_delete:
            del self._operations[op_id]

    def list_all(self) -> list[Operation]:
        """List all operations (for debugging/monitoring)."""
        with self._lock:
            self._gc()
            return list(self._operations.values())
