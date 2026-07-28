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
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Optional, Protocol

from starlette.concurrency import run_in_threadpool

from . import awx as _awx
from .catalog import CATALOG_DIR, load_catalog_entries, load_topology_instance

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


# umbrella #201 WP4 (claude1/#201 addendum, condition 1): the AWX job
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
    ) -> None:
        self._awx_api_url = awx_api_url
        self._awx_api_token = awx_api_token
        self._awx_ssl_verify = awx_ssl_verify
        self._job_template_name = job_template_name
        self._timeout_seconds = timeout_seconds
        self._poll_interval_seconds = poll_interval_seconds

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
            template = await run_in_threadpool(
                _awx.lookup_job_template_by_name,
                api_url=self._awx_api_url,
                api_token=self._awx_api_token,
                name=self._job_template_name,
                ssl_verify=self._awx_ssl_verify,
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
                _awx.call_with_transient_retry,
                functools.partial(
                    _awx.launch_job,
                    api_url=self._awx_api_url,
                    api_token=self._awx_api_token,
                    job_template_id=template["id"],
                    ssl_verify=self._awx_ssl_verify,
                    extra_vars=extra_vars,
                ),
            )
        except Exception as exc:  # noqa: BLE001 - actuator-level failure, not a crash
            logger.warning("switch-source actuator: launch failed for command %s: %s", command.command_id, exc)
            self._fail(command, "switch-launch-failed")
            return

        deadline = datetime.now(timezone.utc) + timedelta(seconds=self._timeout_seconds)
        consecutive_failures = 0
        while True:
            if datetime.now(timezone.utc) > deadline:
                self._fail(command, "switch-watch-timeout")
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
                    self._fail(command, "switch-watch-lost")
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
                    command.updated_at = datetime.now(timezone.utc)
                else:
                    # §6.2's own failure posture: a job failure (for any
                    # reason — the viewer restart step failing being the
                    # spec's own worked example) leaves active-source
                    # cleared on the CLUSTER side (WP4b's own playbook
                    # responsibility) and is reported here as
                    # failed_rollback_required for operator retry/rollback
                    # — "no new rollback logic in WP4" (claude1/#201
                    # addendum condition 4): this actuator's only job is to
                    # report the state accurately, never to auto-remediate.
                    self._fail(command, f"switch-job-{status}")
                return

            await asyncio.sleep(self._poll_interval_seconds)

    @staticmethod
    def _fail(command: SwitchSourceCommand, error: str) -> None:
        command.status = SwitchStatus.FAILED_ROLLBACK_REQUIRED
        command.error = error
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
    entry = next((e for e in entries if e.key == receiver_instance), None)
    if entry is None:
        raise SwitchSourceError("receiver-not-found", f"no catalog entry named '{receiver_instance}'")
    if not entry.topology_ref:
        raise SwitchSourceError(
            "receiver-not-topology",
            f"catalog entry '{receiver_instance}' carries no topology_ref — not a topology-shaped instance",
        )
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

    previous_source = (topology_params.get("viewer") or {}).get("source_selection")
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
