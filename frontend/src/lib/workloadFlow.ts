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
// THE FLOW IS FIVE STEPS. Operate is not one of them — it sits in the
// Control vertical (operator ruling 2026-08-02 on the EBU Facility
// Orchestration Model), and lives at its own monitoring route. The
// vocabulary strip above the steps teaches the full grouping — five
// orchestration stages plus Operate under its Control label. Do not "fix"
// the five-step list by adding Operate back — a flow step is a thing the
// operator WORKS THROUGH, and Operate is a thing they WATCH.
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

/**
 * The steps whose content is a RECORD OF CHOICES rather than a description
 * of something running: which template, which facility. They are readable
 * whenever the workload exists at all, which is why they alone survive an
 * undetermined position as `record` instead of locking.
 *
 * This mirrors the same split lib/workloadLifecycle.ts already draws in its
 * own content predicate ("Design and Plan always do... the three
 * post-Provision stages describe a running thing"). It is restated here
 * rather than imported because that predicate is private to the affordance
 * layer, and the two answer different questions — one decides whether a
 * stage has anything to say, this one decides whether the flow may show it
 * without claiming a position it cannot read.
 *
 * The `undetermined &&` guard on this branch is DEFENSIVE, not load-bearing,
 * and no test pins it — deliberately, because none can. The `complete`
 * branch is evaluated first and always claims both these steps at any
 * readable position: classifyWorkloadLifecycle's active stage is only ever
 * provision, configure, finalise or operate, never design or plan, so the
 * active index is >= 2 in every readable case and both record steps sit
 * behind it. Removing the guard is a provably equivalent mutation today.
 * It stays because it is what makes the branch correct on its own terms if
 * the ladder is ever reordered or a lifecycle value that maps here is added.
 */
const RECORD_STEPS: FlowStepId[] = ['design', 'plan']

export type FlowStepState =
  /** Behind the workload's position: settled, and still reviewable. */
  | 'complete'
  /**
   * Readable record, with no claim about position. Reached only when the
   * backend could not place the workload: Design and Plan describe CHOICES
   * (which template, which facility) rather than runtime, so they stay
   * readable even then. Locking them would hide truth the console holds —
   * S1 made that call deliberately and this state is what preserves it.
   * Distinct from `complete`, which would assert the workload got past
   * them, and that is exactly what an undetermined position cannot say.
   */
  | 'record'
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
 *   1. bears an action (stageActions non-empty)      → `open`
 *   2. is the active stage                           → `current`
 *   3. sits behind the active stage                  → `complete`
 *   4. is a record step and the position is unknown  → `record`
 *   5. otherwise                                     → `locked`
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
    else if (undetermined && RECORD_STEPS.includes(id)) steps[id] = 'record'
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
  /** A facility has been resolved for the draft — exactly one site read
   *  back from the facility summary. Zero or more than one is NOT this;
   *  see PlanAssignment's own honest non-answer copy for both. */
  hasFacility: boolean
  /**
   * WP-3 spec D — the placement CONFIRMATION gate: the operator has
   * explicitly acknowledged the resolved placement ("This workload will
   * run on <facility>."). Only meaningful when `hasFacility` is true —
   * there is nothing to confirm with zero or several facilities, and a
   * confirmation the operator never actually saw would defeat the whole
   * point of asking. This is a CONFIRMATION, not a CHOICE: there is no
   * workload-to-facility relationship anywhere in the backend (nothing in
   * media_workloads.py ties a workload to a site, and the launcher takes
   * no site), so a picker here would write to nothing — the operator is
   * acknowledging a fact the console already resolved on its own, not
   * making a selection.
   */
  facilityConfirmed: boolean
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
 *   Plan      — locked until Design completes; complete once the facility
 *               is both resolved AND acknowledged (WP-3 spec D — resolved
 *               alone is not enough, see DraftProgress.facilityConfirmed)
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
  // WP-3 spec D: gated on the CONFIRMATION, not just the resolved fact —
  // Provision does not open on data alone, only once the operator has
  // acknowledged it. The zero/multiple-facility branches are untouched by
  // this: hasFacility is already false there, so facilityConfirmed (which
  // PlanAssignment never even offers a control for in that case) is moot.
  const planDone = designDone && draft.hasFacility && draft.facilityConfirmed

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

// ─────────────────────────────────────────────────────────────────────────
// Forward exit out of Configure (dmfdeploy#412)
// ─────────────────────────────────────────────────────────────────────────

/**
 * What the guided flow's LAST CONSTRUCTIVE STEP (Configure) offers as its
 * own forward exit, now that Finalise & Review is no longer the array-
 * position "next" step out of it (WorkloadSetup.tsx's FORWARD_STEPS —
 * Finalise stays reachable from the rail and from Previous; it is a
 * lifecycle action, not the next constructive step). This is an EXIT from
 * the setup surface to the existing Operate route — never a sixth flow
 * step, never labelled "Next": FLOW_STEPS above is untouched by this, and
 * so is the ban on Operate ever joining it.
 *
 *   'none'         — no success affordance. Every branch that reaches this
 *                     is one where claiming otherwise would sometimes be a
 *                     lie: the read this would rest on isn't trustworthy
 *                     yet (loading/failed/stale), a job is in flight
 *                     (whichever one — see the busy check below), the
 *                     workload hasn't reached Configure's own position yet,
 *                     its position is unknown, or it is running but not yet
 *                     fully configured. Continuing whatever the active
 *                     stage already shows IS the affordance in every one of
 *                     these; inventing a second one that is sometimes false
 *                     is worse than none (issue #412 acceptance criterion:
 *                     this half matters as much as the affordance itself).
 *   'view-status'  — the position is configure — active intent exists per
 *                     the backend's ADR-0046 derivation — but nothing has
 *                     been OBSERVED running yet. Worth a look; not yet
 *                     claiming the workload operates. Says nothing about HOW
 *                     it reached configure: active intent can mean a deploy
 *                     that hasn't converged yet, one that failed, or —
 *                     dmfdeploy#411 — a clear-for-deployment with no
 *                     converger ever picking it up. classifyForwardExit has
 *                     no job-outcome input — workloadLifecycle.ts's
 *                     WorkloadLifecycleInput carries membersDataTrustworthy,
 *                     the three job flags, `lifecycle`, and
 *                     anyMemberObservedRunning; no deploy result among them
 *                     — so it must not guess at one.
 *
 *                     FIX ROUND (dmfdeploy#412 gate, round 2): an earlier
 *                     version of this line and its matching UI copy said
 *                     "the deploy succeeded" — a claim this function cannot
 *                     support and, per the backend's own docstring on
 *                     `configure` ("active intent exists
 *                     but observed/flow incomplete"), is sometimes false.
 *   'live'         — a TRUSTED read reports the workload operating. This
 *                     asserts ONLY the operating position — never a preview
 *                     claim, in either direction.
 *
 * FIX ROUND (dmfdeploy#412 adversarial gate): an earlier version of this
 * function split the operating case into 'live-view'/'live-status', keyed on
 * whether any instance's `live_view` was true, and the UI worded the
 * false branch as "a preview is not [available]". That was a defect of
 * exactly the class this issue exists to prevent: `live_view` is not a
 * preview fact. It is `sidecar_base_url(...) is not None`
 * (media_workloads.py) — whether an instance's NetBox-stamped sidecar
 * coordinates compose into a URL that passes the SSRF allowlist (DNS-label
 * shape, namespace/port allowlist, service-identity match). That check
 * never probes the sidecar and never inspects a function role; it is
 * RESOLVABILITY, not reachability, and not preview availability. The actual
 * per-instance preview fact — MxlInstanceStatus.preview (types.ts),
 * `available`/`reason`-gated, resolved by an actual status fetch — lives on
 * a different type entirely, and resolving it is what the Operate route
 * already does per instance (LivePreviewBox.tsx's useLivePreview). Every
 * instance reporting live_view:false does not establish preview absence
 * either — a read that never resolved anything is not evidence of absence.
 * The fix is not to go fetch that status here (scope creep, and the fact
 * belongs at the destination, not this exit); it is to stop claiming
 * anything about previews at all. `instances` is no longer a parameter of
 * this function for exactly that reason — there is nothing left here that
 * legitimately reads it.
 *
 * "Trusted" reuses the SAME notion store/headerSlot.ts's TRUST side table
 * is built from (WorkloadLifecycleInput.membersDataTrustworthy), rather
 * than minting a second, weaker one — checked FIRST (Art. 9, unhappy path
 * first): every branch below it is moot on an untrustworthy read.
 *
 * The busy check comes next, and deliberately covers ALL THREE job flags,
 * not only a provision write: the operator's task while any job runs is to
 * watch it close (workloadLifecycle.ts's stageActions applies the identical
 * suppression, for the identical reason), and Configure can legitimately be
 * the SELECTED step while a DIFFERENT stage's job is in flight — Provision's
 * clear-for-deployment keeps running after the position has moved past it
 * (see stageActions' own note on that member-state-keyed action).
 */
export type ForwardExit = 'none' | 'view-status' | 'live'

export function classifyForwardExit(input: WorkloadLifecycleInput): ForwardExit {
  if (!input.membersDataTrustworthy) return 'none'
  if (input.launching || input.switching || input.tearingDown) return 'none'

  if (input.lifecycle === 'configure') {
    return input.anyMemberObservedRunning ? 'none' : 'view-status'
  }
  if (input.lifecycle === 'operate') return 'live'
  // 'provision': nothing has run yet — deployment progress (ProvisionStage's
  // own surface) is the whole story. 'unknown': the backend declined to
  // place the workload; whatever failure surface + recovery action the
  // active stage already renders stays exactly as is, not duplicated here.
  return 'none'
}

// ─────────────────────────────────────────────────────────────────────────
// Cold entry at the workload's home (dmfdeploy#414)
// ─────────────────────────────────────────────────────────────────────────

/**
 * What the bare workload URL — the workload's home (dmfdeploy#414 Addendum
 * 2) — may honestly render. The route NEVER redirects: an unconditional
 * redirect would guess a destination on a read the console cannot yet stand
 * behind, and would make the same bookmark mean two different things
 * depending on timing. This classifier is what decides which of the three
 * honest renderings applies instead.
 *
 *   'live'       — a TRUSTED read reports the workload operating. Renders
 *                   the live view — the same content the retired Operate
 *                   route rendered.
 *   'setup'      — a TRUSTED read reports a real workload that has not
 *                   reached Operate, with nothing observed running for it
 *                   yet — the "isn't running yet, continue setup" cold-entry
 *                   state, with its one CTA into the guided flow.
 *   'unresolved' — every other case: the read itself cannot be stood behind
 *                   (loading, errored, stale, degraded, or the backend could
 *                   not place the workload at all — 'unknown'), OR the read
 *                   is trustworthy but genuinely ambiguous (backend position
 *                   is still `configure` yet something is already observed
 *                   running — not "operating" per the backend's own
 *                   derivation, and not "nothing running" either, so a
 *                   'setup' CTA would misstate the second half of that
 *                   sentence). Renders an honest unresolved state with NO
 *                   affordance asserting setup is the right next action —
 *                   inventing one here would be exactly the sometimes-false
 *                   success affordance dmfdeploy#412 exists to rule out.
 *
 * "Trusted" reused classifyForwardExit's and store/headerSlot.ts's TRUST
 * side table's notion of trust (WorkloadLifecycleInput.membersDataTrustworthy)
 * until umbrella #432's fix round — checked FIRST (Art. 9, unhappy path
 * first), same discipline as classifyForwardExit. It now gates on the
 * DISTINCT `membersDataRetained` instead; see that field's own docstring in
 * workloadLifecycle.ts for exactly why this classifier alone made that
 * switch while classifyForwardExit, stageActions, LifecycleStrip and
 * store/headerSlot.ts's TRUST table all keep reading the stricter
 * `membersDataTrustworthy`.
 *
 * Deliberately a SEPARATE classifier from classifyForwardExit rather than a
 * reuse of its `ForwardExit` union: that function answers a narrower
 * question scoped to Configure's own exit (and never returns anything for
 * `lifecycle === 'provision'`, which Home must still classify — a fresh
 * record with nothing provisioned yet is exactly the first 'setup' case).
 * Both read the same `WorkloadLifecycleInput`, so they cannot disagree about
 * what the workload actually is, only about which question each answers.
 */
export type HomeState = 'live' | 'setup' | 'unresolved'

/**
 * umbrella #432 fix round (item 3): gated on `membersDataRetained`, NOT
 * `membersDataTrustworthy`. The two differ only in whether an in-flight
 * background poll of an otherwise-unchanged, error-free payload counts —
 * `membersDataTrustworthy` says no (it fail-closes a mutation gate and a
 * count claim); `membersDataRetained` says yes (a poll returning identical
 * data is not a semantic change — UX Constitution §3 hard gate #5 — so
 * Home's classification of what is already being shown must not flap on
 * that cadence). A genuine change — an actual error, a degraded payload, an
 * unconfigured environment, or the backend's own position moving — still
 * flips this classifier exactly as before, because all of those flip
 * `membersDataRetained` too.
 */
export function classifyHomeState(input: WorkloadLifecycleInput): HomeState {
  if (!input.membersDataRetained) return 'unresolved'
  if (input.lifecycle === 'operate') return 'live'
  if (input.lifecycle === 'unknown') return 'unresolved'
  // 'provision' or 'configure': a retained record short of Operate.
  if (input.anyMemberObservedRunning) return 'unresolved'
  return 'setup'
}
