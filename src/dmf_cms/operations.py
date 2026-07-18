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
    """State machine for async operations."""
    WAKING = "waking"
    LAUNCHING = "launching"
    LAUNCHED = "launched"
    ERROR = "error"


@dataclass
class Operation:
    """Represents an async AWX launch operation."""
    operation_id: str
    action: str  # "launch" | "deploy" | "teardown"
    target: str  # workflow name or catalog key
    state: OperationState
    job_id: int | None = None
    error: str | None = None
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

    def create(
        self,
        action: str,
        target: str,
        initial_state: OperationState = OperationState.WAKING,
    ) -> Operation:
        """Create a new operation.

        Args:
            action: Operation type (launch|deploy|teardown)
            target: Workflow name or catalog key
            initial_state: Initial state (default: WAKING)

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

        Terminal states are LAUNCHED and ERROR.
        Non-terminal states are WAKING and LAUNCHING.

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
                    and op.state in (OperationState.WAKING, OperationState.LAUNCHING)
                ):
                    return op
            return None

    def get_or_create(
        self,
        action: str,
        target: str,
        initial_state: OperationState = OperationState.WAKING,
    ) -> tuple[Operation, bool]:
        """Atomically find an active operation or create a new one.

        This is the atomic dedupe primitive: under a single lock, check if
        a non-terminal operation exists for (action, target). If yes, return
        it. If no, create a new one and return it.

        Args:
            action: Operation type (launch|deploy|teardown)
            target: Workflow name or catalog key
            initial_state: Initial state for new operation (default: WAKING)

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
                    and op.state in (OperationState.WAKING, OperationState.LAUNCHING)
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
    ) -> tuple[Operation | None, bool, Operation | None]:
        """Atomically find/create an operation, exclusive of conflicting actions.

        Same reattach behavior as get_or_create for (action, target), but
        additionally refuses to create a new operation while an active
        (non-terminal) operation exists for the same target under a
        conflicting action (e.g. deploy vs. teardown of the same catalog
        entry, #24).

        Args:
            action: Operation type (deploy|teardown)
            target: Catalog key
            initial_state: Initial state for new operation (default: WAKING)
            conflicts: Actions that block creation for the same target

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
                    and op.state in (OperationState.WAKING, OperationState.LAUNCHING)
                ):
                    return (op, False, None)
            for op in self._operations.values():
                if (
                    op.action in conflicts
                    and op.target == target
                    and op.state in (OperationState.WAKING, OperationState.LAUNCHING)
                ):
                    return (None, False, op)
            operation_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc)
            op = Operation(
                operation_id=operation_id,
                action=action,
                target=target,
                state=initial_state,
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
    ) -> Operation | None:
        """Update an operation's state and/or fields.

        Args:
            operation_id: UUID of the operation
            state: New state (optional)
            job_id: AWX job ID (optional, set when launched)
            error: Error message (optional, set when state=ERROR)

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
            op.updated_at = datetime.now(timezone.utc)

            return op

    def _gc(self):
        """Garbage collect expired operations (internal, called with lock held)."""
        now = datetime.now(timezone.utc)
        to_delete = []
        for op_id, op in self._operations.items():
            if op.state in (OperationState.LAUNCHED, OperationState.ERROR):
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
