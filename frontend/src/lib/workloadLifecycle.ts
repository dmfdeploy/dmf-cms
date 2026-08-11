// The EBU media-workload lifecycle rail — the state machine behind the
// workload detail page (umbrella #285 S1).
//
// Stage names are VERBATIM from docs/architecture/DMF EBU Mapping
// (2026-04-25) §"6-stage Media Workload lifecycle":
//   Design → Plan → Provision → Configure → Operate → Finalise & Review
// All six names stay present: the rail is the pedagogy — it is how an
// outsider learns the model — so a missing name teaches a wrong model.
// Operate sits in the Control vertical (operator ruling 2026-08-02 on the
// EBU Facility Orchestration Model), not the orchestration flow; it stays
// in STAGES because the lifecycle axis crosses the verticals and the
// backend's ADR-0046 derivation can place a workload there. The
// presentation split — five flow steps, the strip's five-plus-Control
// grouping — is downstream (workloadFlow.ts, LifecycleStrip.tsx).
//
// Pure over the console's existing truth, in the same idiom as
// lib/workspaceHealth.ts and lib/changesState.ts: no new backend, no
// network, no clock. Every stage is always VISIBLE (Art. 3 — the rail
// teaches the facility's language); what varies is each stage's state, and
// a stage that cannot apply yet says so rather than offering a dead control
// (Art. 9 — design the unhappy path first).
//
// WHERE THE ACTIVE STAGE COMES FROM. The backend ALREADY derives a workload
// lifecycle (media_workloads.py _derive_workload_lifecycle, ADR-0046 §3),
// and the Media Workloads badge renders it. This module therefore CONSUMES
// that value rather than re-deriving position from flattened booleans: two
// independent derivations of "where is this workload" would eventually
// disagree, and the console would contradict itself on a single page — the
// rail saying Operate while the badge next to it says configure. Same
// reason lib/workspaceHealth.ts exists: one classifier, many consumers
// (Art. 1 — never present uncertainty as certainty).
//
// What the backend deliberately does NOT model is in-flight job state; it
// reads inventory intent plus observed runtime, and it NEVER infers Finalise
// from absence. Running jobs are this module's own overlay, and Finalise
// becomes active only from an OBSERVED teardown — never from emptiness.

export type StageId =
  | 'design'
  | 'plan'
  | 'provision'
  | 'configure'
  | 'operate'
  | 'finalise'

export interface Stage {
  id: StageId
  /** Verbatim EBU stage name — never abbreviate or re-word in the UI. */
  label: string
}

// Rail order is the lifecycle's time axis; it is not sortable or
// configurable.
export const STAGES: Stage[] = [
  { id: 'design', label: 'Design' },
  { id: 'plan', label: 'Plan' },
  { id: 'provision', label: 'Provision' },
  { id: 'configure', label: 'Configure' },
  { id: 'operate', label: 'Operate' },
  { id: 'finalise', label: 'Finalise & Review' },
]

export type StageState =
  /** The workload is here now. At most one stage per render. */
  | 'active'
  /** Reachable now — carries a real action the operator may take. */
  | 'available'
  /** Real read-only content, no action (Design/Plan, and past stages). */
  | 'informational'
  /** Cannot apply in this workload state. Designed content, never a
   *  disabled control (umbrella #285: no disabled buttons anywhere). */
  | 'not-applicable'

/**
 * Actions the rail may offer at a stage. These are the console's existing
 * write seams, named — the rail invents no new verb.
 */
export type StageActionId =
  /** Launch the workload via its catalog template (Provision, while the
   *  workload has not been cleared to run yet). */
  | 'deploy'
  /**
   * Flip an instance's desired state bootstrapped -> active in NetBox, so
   * the automation lane may deploy it. Offered at PROVISION whenever any
   * member is still bootstrapped — keyed to member state, NOT to position,
   * because clearing the first of several siblings moves the position to
   * configure while the rest still need clearing.
   */
  | 'clear-for-deployment'
  /** Re-point a flow at a different source (Configure, once running). */
  | 'switch-source'
  /** Tear the workload down (Finalise & Review, once running). */
  | 'tear-down'
  /**
   * Delete permanently — SoT removal of a fully finalised workload's
   * residual catalog records (umbrella #347, operator ruling 2026-08-02).
   * Offered at Finalise & Review, but keyed to MEMBER STATE, not position,
   * same discipline as `clear-for-deployment`: every member bootstrapped
   * (nothing cleared to run), zero observed running, and the backing read
   * itself trustworthy. Mutually exclusive with `tear-down` — while
   * anything is running, tear-down is the only Finalise action.
   */
  | 'delete-permanently'

/**
 * The backend's derived workload lifecycle, verbatim from
 * /api/media-workloads/grouped (ADR-0046 §3) — the SAME value the workload
 * badge shows, which is the whole point of taking it from there.
 *
 * 'unknown' is a real resting state, not an error: the backend returns it
 * rather than guessing, and this module must not guess on top of it.
 */
export type WorkloadLifecycle = 'provision' | 'configure' | 'operate' | 'unknown'

/** What the console observes about the workload, flattened. */
export interface WorkloadLifecycleInput {
  /** Backend-derived position. Never re-derived here. */
  lifecycle: WorkloadLifecycle
  /**
   * A PROVISION-stage write is in flight: a catalog deploy, or a
   * clear-for-deployment. Both are Provision's writes, and the rail
   * suppresses on stage busy-ness rather than per-mutation, so they share
   * one flag.
   */
  launching?: boolean
  /** A source re-point (switch) job is running. */
  switching?: boolean
  /** A teardown job is running. */
  tearingDown?: boolean
  /**
   * At least one member is still bootstrapped — i.e. recorded but not yet
   * cleared to run. A MEMBER-STATE fact, deliberately separate from
   * `lifecycle`, which is a POSITION fact.
   *
   * They are not the same question and conflating them stranded workloads:
   * clearing one of two siblings flips the backend's derivation to
   * `configure` (any_active wins), and reading the clear affordance off
   * position alone then withdrew it from the sibling still waiting —
   * permanently (GATE-S1-RV3 P1). Position says where the workload IS;
   * this says what it still NEEDS.
   */
  hasBootstrappedMembers?: boolean
  /**
   * Every current member is bootstrapped (none cleared to run) — the
   * mirror image of `hasBootstrappedMembers`'s "at least one": purging
   * requires ALL of them to be, not just one, since it removes the whole
   * workload's residue. False (not just absent) when the workload has no
   * members at all — nothing to derive "every" over honestly.
   */
  allMembersBootstrapped?: boolean
  /** At least one member's observed state is `running` right now. */
  anyMemberObservedRunning?: boolean
  /**
   * The member-state read this input was built from is fresh, error-free,
   * AND complete (umbrella #378a widens umbrella #343's original
   * `!isError && !isFetching`): the grouped endpoint can return HTTP 200
   * with `degraded: true`, which server-side means `len(invalid_instances)
   * > 0` — members were EXCLUDED from this payload. An excluded
   * invalid-multiple member can share this workload's tag, so a query that
   * succeeded and is not fetching can still be reporting an incomplete
   * `workloads` array. Callers must additionally require
   * `data.configured === true && data.degraded !== true` before setting
   * this true. Fail-closed like every other field here: absent/false
   * withholds `delete-permanently` regardless of what the other fields
   * claim.
   */
  membersDataTrustworthy?: boolean
  /**
   * The EFFECTIVE role (view-as-resolved — the auth store's `role` field,
   * never `real_role`) meets the purge endpoint's own authorization floor,
   * `_require_min_role(request, "operator")` (umbrella #378b). The grouped
   * read's own eligibility is WIDER than the write it is guarding —
   * engineer/admin OR anyone in the `media-engineers` group — so a viewer
   * inside that group can read this workload without being allowed to purge
   * it. This is affordance control only; the server remains the actual
   * authorization boundary. Fail-closed: absent/false withholds
   * `delete-permanently`.
   */
  purgeAuthorized?: boolean
  /**
   * This workload's slug identifies a real, purgeable entity — false for
   * the backend's synthetic `unassigned` bucket (umbrella #378c). That
   * bucket is emitted as a real `workloads[]` entry (display name
   * "Unassigned") so `/media-workloads/unassigned` resolves and renders the
   * full wizard, but the purge endpoint refuses that slug as
   * not-purgeable — offering the control there would contradict
   * UnassignedDisposalNote, whose whole point is that no such control
   * exists. Fail-closed: absent/false withholds `delete-permanently`.
   */
  isPurgeableEntity?: boolean
}

export interface LifecycleState {
  /**
   * The stage the workload is at, or null when the backend could not place
   * it. Null renders as an honest "stage undetermined" rail rather than a
   * guessed position (Art. 1): a lifecycle rail that invents a position is
   * worse than one that admits it cannot read the workload.
   */
  active: StageId | null
  states: Record<StageId, StageState>
}

/** A job owns the workload right now. */
function busy(input: WorkloadLifecycleInput): boolean {
  return Boolean(input.launching || input.switching || input.tearingDown)
}

/** There is an active intent to run — something real to act on. */
function running(input: WorkloadLifecycleInput): boolean {
  return input.lifecycle === 'configure' || input.lifecycle === 'operate'
}

/**
 * The actions a stage offers in this workload state. This is the rail's
 * single source of affordance — `available` is DERIVED from it below, so
 * "available" and "action-bearing" cannot drift apart.
 *
 * Two suppressions, both fail-closed:
 *
 * 1. While any job is in flight, nothing is offered anywhere. The write
 *    seam is already gated server-side on observed runtime truth, so a
 *    mutating control rendered mid-job would be exactly the dead control
 *    this rail exists to avoid. During a job the operator's task is to
 *    watch the loop close (Art. 2), and the stage running it is active.
 * 2. On 'unknown', nothing is offered anywhere. If the console cannot read
 *    where the workload is, it has no business offering to change it.
 */
export function stageActions(
  id: StageId,
  input: WorkloadLifecycleInput,
): StageActionId[] {
  if (busy(input) || input.lifecycle === 'unknown') return []
  switch (id) {
    case 'provision': {
      const actions: StageActionId[] = []
      // Deploying belongs to the position: it is the next step only while
      // nothing has been cleared to run yet.
      if (input.lifecycle === 'provision') actions.push('deploy')
      // Clearing belongs to the MEMBERS, not the position. A bootstrapped
      // member must always have a reachable clear path, so Provision keeps
      // offering it even once the workload's position has moved on — it
      // simply renders available-rather-than-active in that case.
      if (input.hasBootstrappedMembers) actions.push('clear-for-deployment')
      return actions
    }
    case 'configure':
      return running(input) ? ['switch-source'] : []
    case 'finalise':
      // While anything is running, tear-down is the only Finalise action —
      // delete-permanently and tear-down are mutually exclusive by
      // construction, never offered together.
      if (running(input)) return ['tear-down']
      // umbrella #378: completeness, authorization and entity identity join
      // the original member-state gates here — ONE derivation, so a stage
      // component reading `actions` can never disagree with the rail's own
      // openable/locked classification (both consume this same list).
      return input.allMembersBootstrapped &&
        !input.anyMemberObservedRunning &&
        input.membersDataTrustworthy &&
        input.purgeAuthorized &&
        input.isPurgeableEntity
        ? ['delete-permanently']
        : []
    // Design, Plan and Operate carry no action BY DESIGN. Design/Plan are
    // the record of choices already made; Operate is where the operator
    // reads running state and is pointed at Problems — it deliberately
    // owns no write seam of its own.
    default:
      return []
  }
}

/**
 * Whether a stage has real read-only content to show. Design and Plan
 * always do — the chosen template and the assigned facility are facts even
 * before anything runs. Provision has content as soon as the workload can
 * be placed at all. The three post-Provision stages describe a running
 * thing, so before there is one they have nothing honest to say.
 */
function stageHasContent(id: StageId, input: WorkloadLifecycleInput): boolean {
  if (id === 'design' || id === 'plan') return true
  if (id === 'provision') return input.lifecycle !== 'unknown'
  return running(input)
}

/**
 * Resolve the active stage and every stage's state.
 *
 * Active-stage precedence — an in-flight job always wins, because the loop
 * the operator is waiting on must be the stage they are looking at (Art. 2,
 * close every loop at the point of action):
 *   1. teardown running → Finalise & Review
 *   2. switch running   → Configure
 *   3. a Provision write running (deploy or clear) → Provision
 *   4. otherwise        → the backend's derived lifecycle, mapped 1:1
 *                         (provision / configure / operate), or null on
 *                         'unknown' — no guessing on top of a non-answer.
 *
 * Note what is deliberately NOT modelled: there is no "failed" stage. A
 * failed job is job OUTCOME, rendered inside the stage that ran it, not a
 * seventh position on a lifecycle that has six. Collapsing outcome into
 * position would make the rail lie about where the workload is.
 *
 * Every non-active stage's state is DERIVED, in this order:
 *   bears an action  → available
 *   has real content → informational
 *   neither          → not-applicable
 * so the rail's central invariant — AVAILABLE IFF ACTION-BEARING — holds by
 * construction rather than by anyone remembering to keep a table in step.
 * That is the machine-checkable form of "no dead controls": adding an
 * affordance to stageActions() lights the stage up, and removing the last
 * one demotes it, without a second edit here. (The active stage is exempt
 * from the IFF: `active` is a claim about POSITION, not affordance, and it
 * may or may not carry an action of its own.)
 */
export function classifyWorkloadLifecycle(
  input: WorkloadLifecycleInput,
): LifecycleState {
  const { lifecycle, launching, switching, tearingDown } = input

  let active: StageId | null
  if (tearingDown) active = 'finalise'
  else if (switching) active = 'configure'
  else if (launching) active = 'provision'
  else if (lifecycle === 'unknown') active = null
  else active = lifecycle

  const states = {} as Record<StageId, StageState>
  for (const stage of STAGES) {
    states[stage.id] =
      stageActions(stage.id, input).length > 0
        ? 'available'
        : stageHasContent(stage.id, input)
          ? 'informational'
          : 'not-applicable'
  }
  if (active) states[active] = 'active'

  return { active, states }
}
