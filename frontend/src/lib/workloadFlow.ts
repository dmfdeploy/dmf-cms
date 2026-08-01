// The guided sequential flow — the gating layer over the EBU lifecycle
// (umbrella #285, operator direction 2026-08-01: "right direction, wrong
// presentation").
//
// S1 rendered all six stages as cards stacked on one page. The operator
// rejected that presentation, not the model underneath: "Progression is
// gated ('only then') — a stage opens when its predecessor completes."
// This module is that gate, and NOTHING else. It adds no second opinion
// about where a workload is; it reads lib/workloadLifecycle.ts — which in
// turn consumes the backend's ADR-0046 position verbatim — and answers one
// further question the flow presentation needs: which steps may the
// operator open right now.
//
// THE FLOW IS FIVE STEPS; THE LIFECYCLE IS SIX STAGES. Operate left this
// page entirely (operator direction) and lives at its own monitoring route.
// That is a presentation split, not a model change: the canonical mapping
// doc's six-stage lifecycle is still taught in full by the vocabulary strip
// the flow page renders above the steps, Operate included and linking out.
// Do not "fix" the five-step list by adding Operate back — a flow step is a
// thing the operator WORKS THROUGH, and Operate is a thing they WATCH.
//
// WHY A SEPARATE MODULE. workloadLifecycle.ts answers "where is this
// workload, and what may be done at each stage". That is still the whole
// truth about affordance, and this module never contradicts it: `open` is
// DERIVED from stageActions(), so the S1 invariant AVAILABLE IFF
// ACTION-BEARING survives the restructure by construction rather than by a
// second hand-maintained table. What is genuinely new here is ORDERING —
// "only then" — which is a claim about the operator's path, not about the
// workload's state, and does not belong in the position classifier.

import {
  stageActions,
  classifyWorkloadLifecycle,
  type StageId,
  type WorkloadLifecycle,
  type WorkloadLifecycleInput,
} from './workloadLifecycle'

/**
 * The five orchestration stages the guided flow walks, in order. Names are
 * the mapping doc's verbatim stage names (rendered by the UI); Operate is
 * deliberately absent — see the file docstring.
 */
export type FlowStepId = 'design' | 'plan' | 'provision' | 'configure' | 'finalise'

export const FLOW_STEPS: FlowStepId[] = [
  'design',
  'plan',
  'provision',
  'configure',
  'finalise',
]

/** Position of a step in the flow, or null for a stage that is not a step. */
function flowIndex(id: StageId): number | null {
  const i = FLOW_STEPS.indexOf(id as FlowStepId)
  return i === -1 ? null : i
}

export type FlowStepState =
  /** Behind the workload's position: settled, and still reviewable. */
  | 'complete'
  /** The workload is here now. At most one step per render. */
  | 'current'
  /**
   * Not the position, but reachable anyway because it bears a real action.
   * This is S1's `available`, renamed for the flow's vocabulary — same
   * derivation, same invariant.
   */
  | 'open'
  /**
   * The "only then" state: the predecessor has not completed, so this step
   * is not yet the operator's to work. Renders its reason, never a
   * disabled control (umbrella #285: no dead controls anywhere).
   */
  | 'locked'

export interface FlowState {
  /**
   * The step the operator is working now, or null. Null is a real answer in
   * two distinct situations, and the UI must tell them apart:
   *   - the backend could not place the workload (`lifecycle: 'unknown'`),
   *     so no step may claim to be current; and
   *   - the workload is at OPERATE, which is not a flow step at all — every
   *     orchestration step behind it is complete and Finalise is open.
   * `offFlow` below distinguishes them; `current` alone cannot.
   */
  current: FlowStepId | null
  /**
   * True when the workload's position is a real lifecycle stage that this
   * flow does not render — today that means exactly Operate. The page uses
   * it to say "this workload is operating" and point at the monitoring
   * route, instead of implying the flow lost track of it.
   */
  offFlow: boolean
  /** True when the backend could not place the workload at all. */
  undetermined: boolean
  steps: Record<FlowStepId, FlowStepState>
}

/**
 * Resolve every step's flow state from the S1 classification.
 *
 * The ladder, in order of precedence per step:
 *   1. bears an action (stageActions non-empty) → `open`
 *   2. is the active stage                      → `current`
 *   3. sits behind the active stage             → `complete`
 *   4. otherwise                                → `locked`
 *
 * Rule 1 outranks the rest for a reason that is not cosmetic. At position
 * `configure` with a sibling still bootstrapped, Provision sits BEHIND the
 * position (so rule 3 would call it merely complete) yet still bears
 * clear-for-deployment — the exact case that stranded workloads in S1
 * (GATE-S1-RV3 P1). Ordering `open` first means a step that can be acted on
 * is never presented as finished business, and — the machine-checkable
 * half — no action-bearing step is ever `locked`. Both directions are
 * pinned by tests, because this is the property the whole "only then"
 * presentation rests on: locking a step must never be able to swallow a
 * reachable control.
 *
 * Note that rule 1 cannot fire on a step whose predecessor has not run:
 * stageActions() already returns nothing for Configure and Finalise until
 * the workload is running, and nothing at all while a job is in flight or
 * the position is unknown. The lock is therefore a presentation of an
 * absence the affordance layer already decided, never a second gate that
 * could disagree with it.
 */
export function classifyWorkloadFlow(input: WorkloadLifecycleInput): FlowState {
  const { active } = classifyWorkloadLifecycle(input)

  const activeIndex = active === null ? null : flowIndex(active)
  // Position is a real stage this flow does not render (Operate).
  const offFlow = active !== null && activeIndex === null
  const undetermined = active === null

  // How far the workload has got, for rule 3. A workload at Operate has
  // completed every orchestration step, so it counts as past the end.
  const reached = offFlow ? FLOW_STEPS.length : activeIndex

  const steps = {} as Record<FlowStepId, FlowStepState>
  FLOW_STEPS.forEach((id, index) => {
    if (stageActions(id, input).length > 0) steps[id] = 'open'
    else if (activeIndex !== null && index === activeIndex) steps[id] = 'current'
    else if (reached !== null && index < reached) steps[id] = 'complete'
    else steps[id] = 'locked'
  })

  return {
    current: activeIndex === null ? null : FLOW_STEPS[activeIndex],
    offFlow,
    undetermined,
    steps,
  }
}

/**
 * Whether the operator may open a step's content. Complete steps stay
 * reviewable (operator direction: "completed stages remain reviewable"),
 * the current step is the work, and an open step carries an action. Only a
 * locked step is closed — and a locked step never carries an action, so
 * closing it can never hide a control (see classifyWorkloadFlow's ladder).
 */
export function isStepOpenable(state: FlowStepState): boolean {
  return state !== 'locked'
}

// ─────────────────────────────────────────────────────────────────────────
// Draft flow — a workload that does not exist yet
// ─────────────────────────────────────────────────────────────────────────

/**
 * WHY A DRAFT EXISTS AT ALL, AND WHAT IT COSTS.
 *
 * "Create media workload" was pulled forward from future scope by the
 * operator: the user names a studio and works the flow. But a workload's
 * identity is not a record the console can create — it is the
 * `workload:<slug>` NetBox tag that the AWX launcher stamps when the deploy
 * runs, carried there by the existing deploy seam's `workload` field
 * (POST /api/catalog/{key}/deploy → extra_vars.workload_slug). The console
 * holds no NetBox create seam and this arc adds none.
 *
 * So the draft — studio name, chosen template, facility — lives in the
 * browser until Provision fires, and then the workload materialises with
 * the identity the deploy carried. The consequence is a real limit, and it
 * is DESIGNED rather than hidden: a refresh before Provision loses the
 * draft. The create surface states that where the operator can read it, in
 * the same breath as the name field. A silently-lost draft would be the
 * dishonest version of exactly this trade.
 */
export interface DraftProgress {
  /** A studio name has been entered and reduces to a valid slug. */
  hasName: boolean
  /** A template has been chosen from the catalog. */
  hasTemplate: boolean
  /** A facility has been resolved for the draft. */
  hasFacility: boolean
}

/**
 * The draft's own gate. Deliberately NOT routed through
 * classifyWorkloadFlow: that function's contract is "derive from the
 * backend's ADR-0046 position", and a draft has no position — there is no
 * workload for the backend to place. Feeding it a synthetic position would
 * put a fabricated lifecycle value into the one code path whose whole job
 * is to consume the real one verbatim.
 *
 * A draft's steps are gated on the operator's own progress instead, which
 * is the only truth that exists yet:
 *   Design    — current until a template is chosen, then complete
 *   Plan      — locked until Design completes
 *   Provision — locked until Plan completes; the deploy fires from here and
 *               ends the draft
 *   Configure } locked throughout: nothing runs yet, so there is genuinely
 *   Finalise  } nothing to configure or tear down
 *
 * The name gates everything: without a valid slug the deploy has no
 * identity to carry, so Design cannot complete.
 */
export function classifyDraftFlow(draft: DraftProgress): FlowState {
  const designDone = draft.hasName && draft.hasTemplate
  const planDone = designDone && draft.hasFacility

  const steps: Record<FlowStepId, FlowStepState> = {
    design: designDone ? 'complete' : 'current',
    plan: !designDone ? 'locked' : planDone ? 'complete' : 'current',
    provision: planDone ? 'current' : 'locked',
    // Nothing has been provisioned, so these describe a running thing that
    // does not exist. Locked is the honest state, not an empty panel.
    configure: 'locked',
    finalise: 'locked',
  }

  const current = designDone ? (planDone ? 'provision' : 'plan') : 'design'
  return { current, offFlow: false, undetermined: false, steps }
}

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle badge grammar (umbrella #285 addendum, operator 2026-08-01)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resting grammar: the past participle names the transition the workload
 * has COMPLETED to arrive where it is.
 *
 * The reading matters, because the obvious alternative is wrong. A workload
 * AT `provision` has not been provisioned — ADR-0046 puts it there when its
 * members are recorded and nothing has been cleared to run yet. Labelling
 * that "provisioned" would claim the deploy already happened, on the tile,
 * which is the most-looked-at pixel on the page (Art. 1). Naming the last
 * completed step instead is both true and readable as progress:
 *
 *   position provision → "planned"     (design + plan settled; deploy next)
 *   position configure → "provisioned" (the deploy ran; configuration next)
 *   position operate   → "configured"  (configuration settled; it runs)
 *
 * `unknown` stays "unknown" — the backend declined to place the workload
 * and this layer does not improve on that.
 */
const RESTING_GRAMMAR: Record<WorkloadLifecycle, string> = {
  provision: 'planned',
  configure: 'provisioned',
  operate: 'configured',
  unknown: 'unknown',
}

/**
 * In-flight grammar: the progressive names the stage whose job is running
 * right now. Keyed to the stage, so each pairs with its own resting form
 * exactly as the operator asked ("provisioned / provisioning").
 */
const IN_FLIGHT_GRAMMAR: Record<'provision' | 'configure' | 'finalise', string> = {
  provision: 'provisioning',
  configure: 'configuring',
  finalise: 'finalizing',
}

export interface LifecycleBadge {
  label: string
  /**
   * Which grammar produced the label. The UI keys styling and the
   * explanatory title off this rather than string-matching the label.
   */
  grammar: 'resting' | 'in-flight' | 'unknown'
}

/**
 * The workload's lifecycle badge, in resting or in-flight grammar.
 *
 * Derived PURELY from the ADR-0046 position plus the existing job overlay —
 * no new state is tracked and no new backend field is read. The in-flight
 * branch reuses classifyWorkloadLifecycle's own active-stage precedence
 * (teardown > switch > provision-write) rather than re-deciding which job
 * wins, so the badge and the flow can never name different jobs.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. A caller with no job overlay — the
 * workload tiles on the index page, which see only the grouped inventory —
 * gets the resting form. It is tempting to promote `reconcile_pending`
 * there into "provisioning", since a converging workload does show it. But
 * reconcile_pending means only that requested and observed DISAGREE, and it
 * stays true for a workload whose pod has crashed and will never start.
 * Rendering that as "provisioning" would present a stalled failure as
 * progress — an Art. 1 violation on the tile, and the exact class of lie
 * this console keeps auditing itself for. Callers that observe a
 * disagreement should say so (the existing "reconciling" marker does), not
 * borrow the progressive form.
 */
export function lifecycleBadge(input: WorkloadLifecycleInput): LifecycleBadge {
  const { active } = classifyWorkloadLifecycle(input)
  const jobRunning = Boolean(input.launching || input.switching || input.tearingDown)

  if (jobRunning && active !== null && active in IN_FLIGHT_GRAMMAR) {
    return {
      label: IN_FLIGHT_GRAMMAR[active as 'provision' | 'configure' | 'finalise'],
      grammar: 'in-flight',
    }
  }
  const label = RESTING_GRAMMAR[input.lifecycle]
  return { label, grammar: input.lifecycle === 'unknown' ? 'unknown' : 'resting' }
}
