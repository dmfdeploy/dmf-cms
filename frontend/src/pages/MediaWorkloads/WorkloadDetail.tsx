import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useCatalog, useCurrentUser, useMediaWorkloadsGrouped } from '../../api/hooks'
import {
  stageActions,
  buildWorkloadLifecycleInput,
  type WorkloadLifecycleInput,
} from '../../lib/workloadLifecycle'
import { useTopbarMessageStore } from '../../store/topbarMessage'
import { classifyWorkloadForHeaderSlot, buildHeaderSlotRail, useRegisterHeaderSlot } from '../../store/headerSlot'
import {
  FLOW_STEPS,
  isStepOpenable,
  lifecycleBadge,
  type FlowStepId,
  type FlowStepState,
} from '../../lib/workloadFlow'
import type { MediaWorkload, SwitchSourceResult } from '../../api/types'
import FlowStep from './FlowStep'
import WorkloadMaterializing, { readLaunchState } from './WorkloadMaterializing'
import DesignStage from './stages/DesignStage'
import PlanStage from './stages/PlanStage'
import ProvisionStage from './stages/ProvisionStage'
import ConfigureStage from './stages/ConfigureStage'
import FinaliseStage from './stages/FinaliseStage'
import { settleQuery } from '../../lib/queryState'

/**
 * Workload detail — the WIZARD (umbrella #347 WO-D1, operator direction
 * 2026-08-02: "the workload detail page becomes a wizard — one lifecycle
 * step visible at a time, Next/Previous, the EBU-colored rail as the
 * prominent navigation spine").
 *
 * Arc B (umbrella #285) rebuilt S1's six-stacked-cards page into a folding
 * accordion: every step mounted, one pinned open, the rest behind a
 * per-step Review/Hide toggle. The operator's verdict this round was
 * narrower than that rebuild — not "wrong model", but "still too much page
 * at once" — so this arc replaces the PRESENTATION again, once more leaving
 * every piece of SUBSTANCE underneath it untouched: the state machine, the
 * honesty states, and the busy-suppression invariants all carry forward
 * exactly as lib/workloadFlow.ts and lib/workloadLifecycle.ts already
 * derive them. Nothing here re-derives a lifecycle position or adds a UI
 * classifier.
 *
 * WHAT CHANGED THIS ROUND:
 *
 * 1. EXACTLY ONE STEP IS MOUNTED. `selectedStep` is presentation state,
 *    entirely separate from the flow's derived state — it is never
 *    inferred from FlowStepState, only ever initialised/refreshed through
 *    the priority order below and moved by Previous/Next/a rail click.
 *    FlowStep.tsx no longer folds; it always renders whatever child it is
 *    given, because selection can never land on a locked step in the first
 *    place (the same invariant Arc B pinned, now enforced one level up).
 *
 * 2. THE RAIL IS THE SELECTOR. LifecycleStrip.tsx's five orchestration
 *    chips are the wizard's navigation, with the selected chip carrying its
 *    own inverted fill distinct from the workload's actual backend-derived
 *    position (its own same-line marker). Operate remains outside the
 *    flow, in the Control group, as a route link. Arc 4 WP-3 (umbrella
 *    #347) moved the rail itself out of this page's render tree into the
 *    header slot — this page still owns and derives every fact it needs
 *    (steps/current/offFlow/selection/locked reasons/job state), it just
 *    registers that into store/headerSlot.ts via useRegisterHeaderSlot
 *    instead of rendering <LifecycleStrip> inline. Colour is no longer
 *    EBU stage identity either — see LifecycleStrip.tsx's own docstring
 *    for the rail-treatment ruling.
 *
 * 3. A JOB OWNS ITS PANEL. Firing a mutation synchronously marks its owning
 *    step AND flips the corresponding busy flag (`startJob`, called from the
 *    stage's own click handler, not from a busy-effect one render later) so
 *    Previous/Next/every rail selector/the Operate link go inert with a
 *    stated reason for exactly as long as that job is in flight — never a
 *    window, not even one render, where navigation could strand the
 *    operator away from the job they started. The stage's own onBusyChange
 *    effect still drives the eventual clear back to false once the mutation
 *    settles; startJob only owns the synchronous true edge.
 */

/** Verbatim EBU stage names. Never abbreviate or re-word these. */
const STEP_LABEL: Record<FlowStepId, string> = {
  design: 'Design',
  plan: 'Plan',
  provision: 'Provision',
  configure: 'Configure',
  finalise: 'Finalise & Review',
}

/**
 * Why a step is not the operator's to work yet. Every locked step states
 * one of these — a lock with no stated reason is a disabled button wearing
 * prose (Art. 8).
 *
 * Design, Plan and Provision can only lock when the backend could not place
 * the workload at all, because nothing earlier gates them; their reason says
 * so rather than pretending to a predecessor that did not run.
 */
export const LOCKED_REASON: Record<FlowStepId, string> = {
  design: 'This step opens once the workload can be read again.',
  plan: 'This step opens once the workload can be read again.',
  provision: 'This step opens once the workload can be read again.',
  configure:
    'Nothing is running for this workload yet, so there is no source to select. This step opens once Provision has deployed it.',
  finalise:
    'Nothing is running for this workload yet, so there is nothing to tear down. This step opens once Provision has deployed it.',
}

/**
 * The wizard's default-selection priority order (spec A, "Initial
 * selection"): an openable hash target first, then the backend position,
 * then Finalise & Review for an operating workload, then Design. Re-applied
 * verbatim whenever the current selection stops being openable — there is
 * no separate "first mount" rule, only this order evaluated fresh.
 */
function defaultSelection(
  steps: Record<FlowStepId, FlowStepState>,
  current: FlowStepId | null,
  offFlow: boolean,
  requestedStep: string,
): FlowStepId {
  if (
    FLOW_STEPS.includes(requestedStep as FlowStepId) &&
    isStepOpenable(steps[requestedStep as FlowStepId])
  ) {
    return requestedStep as FlowStepId
  }
  if (current !== null) return current
  if (offFlow) return 'finalise'
  return 'design'
}

export default function WorkloadDetail() {
  const { slug } = useParams<{ slug: string }>()
  const { state: routerState } = useLocation()
  // Present only when the operator arrived straight from Create. It is the
  // ONLY thing that distinguishes "this workload does not exist" from "this
  // workload was launched seconds ago and has not been recorded yet".
  const launch = readLaunchState(routerState)
  const { data, isLoading, isError, isFetching, error } = useMediaWorkloadsGrouped()

  const workload = data?.workloads.find((w) => w.slug === slug)

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <p className="text-muted">Loading workload…</p>
      </div>
    )
  }

  if (error != null) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="panel border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          This workload could not be loaded right now. Retrying automatically.
        </div>
      </div>
    )
  }

  if (data && !data.configured) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="panel border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Media Workloads is not configured for this environment.
        </div>
      </div>
    )
  }

  // A workload that is ABSENT because it was just launched is not a
  // not-found (GATE-B P1). Create hands the launch through router state, and
  // until the launcher stamps the tag this page owes the operator the
  // materializing story — deploy accepted, job running, record pending — not
  // a flat denial that the thing they just created exists.
  if (!workload && launch) {
    return <WorkloadMaterializing slug={slug ?? ''} launch={launch} />
  }

  if (!workload) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold text-text">Workload not found</h1>
        <div className="panel mt-4 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          No workload named &quot;{slug}&quot; is in your scope right now.
        </div>
        <Link to="/media-workloads" className="mt-4 inline-block text-sm text-accent hover:underline">
          ← Back to Media Workloads
        </Link>
      </div>
    )
  }

  // GATE-D1.4 (operator review round 2, PR #70): keyed on the workload's own
  // identity, not just mounted once. React does NOT remount a component on
  // a route PARAM change alone — navigating from /media-workloads/A to
  // /media-workloads/B re-renders the same WorkloadWizard instance with a
  // new `workload` prop, and every piece of state it owns (selectedStep,
  // jobOwner, launching/switching/tearingDown, lastSwitchResult, the
  // hash-focus-consumed ref) would silently carry over from A to B — wrong
  // selection, and far worse, A's in-flight job lock bleeding onto B's
  // navigation. `key` forces React to tear the old instance down and mount
  // a fresh one whenever the workload identity changes, so ALL of that
  // state re-derives from scratch for the new workload, including the
  // initial-selection ladder (defaultSelection) — the same class of fix as
  // "a page reload re-derives purely from the backend" (WorkloadWizard's
  // own docstring), just triggered by a workload change instead of F5.
  // Returning to A while its job is still running therefore loses the
  // local busy overlay exactly the way a reload would — that is the
  // INTENDED equivalence, not a regression: the backend is what's actually
  // running the job, and the wizard's local overlay was never anything
  // more than an optimistic echo of it.
  return (
    <WorkloadWizard
      key={workload.slug}
      workload={workload}
      // umbrella #378a: !isError && !isFetching alone proved the READ
      // succeeded, not that it was COMPLETE — the grouped endpoint can
      // return HTTP 200 with degraded: true (members excluded from this
      // payload, per media_workloads.py's own definition), and an excluded
      // invalid-multiple member can share this workload's tag. FIX ROUND
      // (P3-5): this used to reduce to a boolean HERE via
      // isGroupedReadTrustworthy and thread the boolean down — now threads
      // the raw read down instead, so buildWorkloadLifecycleInput is the
      // only place that formula runs (see its own docstring for why the
      // boolean-shaped seam was the actual gap).
      groupedRead={{ isError, isFetching, configured: data?.configured, degraded: data?.degraded }}
    />
  )
}

/**
 * The wizard itself — every piece of state below is scoped to exactly ONE
 * workload for the lifetime of this component instance, because the parent
 * remounts it (via `key={workload.slug}`) whenever the operator switches
 * workloads. Nothing here needs a "workload changed under me" branch as a
 * result: `workload` is a plain, always-defined prop, not an optional value
 * threaded through a safe fallback.
 *
 * The job overlay (which write is in flight) is this component's own local
 * state, deliberately not persisted: a reload re-derives purely from the
 * backend, which is correct — a job this tab forgot is still visible as
 * whatever lifecycle it left the workload in. Keying on workload identity
 * (above) puts a workload switch through that exact same re-derivation, not
 * a special case of it.
 */
function WorkloadWizard({
  workload,
  groupedRead,
}: {
  workload: MediaWorkload
  // umbrella #347: freshness of the SAME grouped read `workload` itself came
  // from — computed by the parent (the only place that holds the query's
  // own isError/isFetching), threaded through rather than re-queried here.
  // FIX ROUND (P3-5): the raw read, not membersDataTrustworthy's old
  // pre-reduced boolean — buildWorkloadLifecycleInput below now runs
  // isGroupedReadTrustworthy itself, so this component doesn't call it.
  groupedRead: { isError: boolean; isFetching: boolean; configured?: boolean; degraded?: boolean }
}) {
  const { hash } = useLocation()
  // fix-round 5 (PR #81, codex sibling sweep): isError threaded down to
  // DesignStage — see its own doc comment on `catalogFailed` for why.
  //
  // fix-round 6 (PR #81, umbrella #385): retrofitted onto settleQuery.
  const { data: catalogData, loading: catalogLoading, failed: catalogError } = settleQuery(useCatalog())
  // umbrella #378b: the SAME effective-role read FinaliseStage already uses
  // for audit fields (user?.role — already view-as-resolved by /api/me, see
  // Topbar.tsx's identical use of the field), threaded into the affordance
  // gate rather than a second auth read. Kept as the whole query result, not
  // just `data` — see purgeAuthorized below for why.
  const userQuery = useCurrentUser()

  const [launching, setLaunching] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [tearingDown, setTearingDown] = useState(false)
  const [lastSwitchResult, setLastSwitchResult] = useState<SwitchSourceResult | null>(null)
  // The wizard's own presentation state — never derived from FlowStepState.
  const [selectedStep, setSelectedStep] = useState<FlowStepId | null>(null)
  // Which step's mutation is in flight — the LABEL only; the busy boolean
  // itself lives in launching/switching/tearingDown above, and `startJob`
  // below sets both synchronously in the same click handler that fires the
  // mutation, not via the child's own onBusyChange effect (which runs a
  // render later, and — worse — that render can itself be waiting on a
  // react-query notification that lands in a microtask, later still). A
  // mutation library's own isPending is not required to be observable in
  // the same synchronous tick as the call that started it, so this page
  // cannot depend on it for the zero-window guarantee; only a plain
  // setState in the SAME event handler can give that guarantee.
  const [jobOwner, setJobOwner] = useState<FlowStepId | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const hashFocusedRef = useRef(false)
  const emitTopbarMessage = useTopbarMessageStore((s) => s.emit)

  const jobInFlight = launching || switching || tearingDown

  // FIX ROUND (WP-3 spec B gate, P2-3; strengthened P3-5): built through the
  // ONE shared constructor Operate.tsx now also uses
  // (lib/workloadLifecycle.ts's buildWorkloadLifecycleInput) — member-state/
  // purgeable-entity facts can no longer drift between the two routes
  // reading the same workload. `groupedRead`/`userRead` stay THIS
  // component's own query results to gather (each route holds its own query
  // instances) — see `groupedRead`'s own prop docstring in WorkloadDetail()
  // below for why that half specifically is threaded down rather than
  // re-queried here — but buildWorkloadLifecycleInput runs the shared
  // formulas on them now, not this call site (P3-5: a boolean handed in
  // here could always have come from a different formula and still
  // typechecked; a raw read cannot substitute the arithmetic).
  const input: WorkloadLifecycleInput = buildWorkloadLifecycleInput(workload, {
    launching,
    switching,
    tearingDown,
    groupedRead,
    // umbrella #378b (fix round): fail-closed on IDENTITY FRESHNESS, not just
    // on the role value — mirrors groupedRead's own discipline (#343) for
    // the exact same reason. TanStack Query retains the PREVIOUS /api/me
    // payload while a refetch is in flight and after one fails, so
    // `userQuery.data` alone can't prove the role is current. This is
    // reachable, not theoretical: useSetViewAs() invalidates every query
    // (including ['user']) with no queryKey filter, so an admin switching
    // view-as to viewer re-fetches /api/me while the stale admin payload is
    // still what `data` holds — without this clause the control would stay
    // armed for the acting role mid-switch, and (useCurrentUser is declared
    // retry: false) indefinitely if that refetch then fails. Absent/loading/
    // fetching/errored all withhold, same as every other gate here.
    userRead: {
      isFetching: userQuery.isFetching,
      isError: userQuery.isError,
      role: userQuery.data?.role,
    },
  })
  const flow = classifyWorkloadForHeaderSlot(input)
  const { steps, current, offFlow, undetermined } = flow
  const badge = lifecycleBadge(input)

  // A fragment aimed at a step selects+focuses that step on arrival. The
  // Operate page's "request configuration change" link is the one caller.
  // It only changes the initial selection — a locked step is never selected
  // by it (defaultSelection's isStepOpenable guard), so a crafted fragment
  // can never reach a control the gate closed.
  const requestedStep = hash.replace(/^#/, '')

  const activeStep =
    selectedStep !== null && isStepOpenable(steps[selectedStep])
      ? selectedStep
      : defaultSelection(steps, current, offFlow, requestedStep)

  // React's sanctioned "derived state" pattern: persist the computed
  // fallback into state so a later query refresh that keeps the operator's
  // step openable does NOT re-run this priority order — spec A is explicit
  // that only ceasing to be openable re-triggers it.
  useEffect(() => {
    if (activeStep !== selectedStep) setSelectedStep(activeStep)
  }, [activeStep, selectedStep])

  // The job owner is cleared once the job settles (any of the three busy
  // flags falls) — the START is synchronous (via startJob below); the END
  // is not time-critical the same way, so an effect on jobInFlight is fine.
  // Also echoes the terminal moment to the topbar's supplemental message
  // surface (GATE-D1 P2.4) — a courtesy notice only; the real outcome stays
  // at the stage that ran the job (Constitution Art. 2), so this fires
  // regardless of whether the mutation actually succeeded.
  useEffect(() => {
    if (!jobInFlight && jobOwner) {
      emitTopbarMessage(`${STEP_LABEL[jobOwner]} job for ${workload.name} completed`)
      setJobOwner(null)
    }
  }, [jobInFlight, jobOwner, emitTopbarMessage, workload.name])

  useEffect(() => {
    if (
      !hashFocusedRef.current &&
      requestedStep &&
      FLOW_STEPS.includes(requestedStep as FlowStepId) &&
      activeStep === requestedStep
    ) {
      panelRef.current?.focus()
      hashFocusedRef.current = true
    }
  }, [activeStep, requestedStep])

  const activeIndex = FLOW_STEPS.indexOf(activeStep)
  const prevStep = activeIndex > 0 ? FLOW_STEPS[activeIndex - 1] : null
  const nextStep = activeIndex < FLOW_STEPS.length - 1 ? FLOW_STEPS[activeIndex + 1] : null
  const canPrevious = !jobInFlight && prevStep !== null && steps[prevStep] !== 'locked'
  const canNext = !jobInFlight && nextStep !== null && steps[nextStep] !== 'locked'

  const jobOwnerLabel = jobOwner ? STEP_LABEL[jobOwner] : null
  const jobReasonText = jobOwnerLabel
    ? `A ${jobOwnerLabel} job is in progress — wait for its outcome.`
    : ''
  const previousReason = jobInFlight
    ? jobReasonText
    : prevStep === null
      ? 'This is the first step.'
      : 'This step is locked.'
  const nextReason = jobInFlight
    ? jobReasonText
    : nextStep === null
      ? 'This is the last step.'
      : 'This step is locked.'

  const selectStep = (step: FlowStepId) => {
    if (jobInFlight || steps[step] === 'locked') return
    setSelectedStep(step)
  }

  // Arc 4 WP-3: the rail moved out of this page's own render tree into the
  // header slot (umbrella #347). This is the ONLY place that mints it —
  // buildHeaderSlotRail's own type makes that true, not just this comment
  // (store/headerSlot.ts). Registered with the wizard's own selection
  // (activeChip) so the rail's "selected" chip always agrees with what
  // FlowStep mounts below; `current`/`offFlow` come straight from `flow`,
  // the same classifyWorkloadFlow output this page renders everything else
  // from — no second derivation.
  useRegisterHeaderSlot({
    slug: workload.slug,
    rail: buildHeaderSlotRail(flow, {
      activeChip: activeStep,
      lockedReasons: LOCKED_REASON,
      jobOwnerLabel,
      jobInFlight,
      onSelect: selectStep,
    }),
  })

  // Called synchronously from a stage's own click handler, in the same event
  // that fires its mutation — see the file docstring's point 3. Sets the
  // busy flag itself (GATE-D1 P1.1), not just the owner label: a mutation
  // library's isPending is not guaranteed observable in this same
  // synchronous tick (react-query's own notification can land in a
  // microtask), so jobInFlight cannot wait on it to close the window. The
  // corresponding stage's onBusyChange effect keeps independently reporting
  // the SAME flag once the mutation settles — that is still what drives the
  // eventual clear back to false; this call only forces the true edge to
  // land with zero delay.
  const startJob = (step: FlowStepId) => {
    setJobOwner(step)
    setSelectedStep(step)
    if (step === 'provision') setLaunching(true)
    else if (step === 'configure') setSwitching(true)
    else if (step === 'finalise') setTearingDown(true)
    emitTopbarMessage(`${STEP_LABEL[step]} job for ${workload.name} started`)
  }

  const requestedIsLocked =
    FLOW_STEPS.includes(requestedStep as FlowStepId) && steps[requestedStep as FlowStepId] === 'locked'

  const stageBody: Record<FlowStepId, ReactNode> = {
    design: (
      <DesignStage
        workload={workload}
        catalogEntries={catalogData?.entries ?? []}
        catalogLoading={catalogLoading}
        catalogFailed={catalogError}
        state="informational"
      />
    ),
    plan: <PlanStage workload={workload} state="informational" />,
    provision: (
      <ProvisionStage
        workload={workload}
        state={steps.provision === 'open' ? 'available' : 'informational'}
        actions={stageActions('provision', input)}
        onBusyChange={setLaunching}
        onJobStart={() => startJob('provision')}
      />
    ),
    configure: (
      <ConfigureStage
        workload={workload}
        state={steps.configure === 'open' ? 'available' : 'informational'}
        actions={stageActions('configure', input)}
        onBusyChange={setSwitching}
        onSwitchResult={setLastSwitchResult}
        onJobStart={() => startJob('configure')}
      />
    ),
    finalise: (
      <FinaliseStage
        workload={workload}
        state={steps.finalise === 'open' ? 'available' : 'informational'}
        actions={stageActions('finalise', input)}
        onBusyChange={setTearingDown}
        lastSwitchResult={lastSwitchResult}
        onJobStart={() => startJob('finalise')}
        // umbrella #378 fix round 2: threaded from the SAME userQuery this
        // component already reads for purgeAuthorized, rather than
        // FinaliseStage subscribing to useCurrentUser() itself — see that
        // prop's own docstring for why a second subscriber is the bug.
        user={userQuery.data}
      />
    ),
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* The lifecycle badge — resting-grammar label + degraded flag — moved
          here from the retired hero: it is state anchored to the flow
          surface, not page chrome. The workload's display name lives in the
          topbar breadcrumb now (Shell). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span
          className="badge text-sm"
          title={
            badge.grammar === 'in-flight'
              ? 'A job is running for this workload right now'
              : badge.grammar === 'unknown'
                ? 'The facility source of truth could not place this workload'
                : 'The last lifecycle step this workload completed'
          }
        >
          {badge.label}
          {workload.health === 'degraded' ? ' · degraded' : ''}
        </span>
      </div>

      {/* The rail itself now lives in the header slot (Topbar), registered
          above via useRegisterHeaderSlot — see that call's own comment.
          This page renders nothing in its place; the header row is present
          or absent by route, not by anything here. */}

      {/* Two different reasons no step is current. The page must not blur
          them into one shrug: one is the console failing to read the
          workload, the other is the workload running normally somewhere
          this flow deliberately does not go. */}
      {undetermined && (
        <div className="panel mt-4 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          The facility source of truth could not place this workload in its lifecycle, so
          nothing is offered anywhere below and no step claims to be the current one — a
          guessed position would be worse than none. Design and Plan stay readable as a
          record of the choices already made; the three steps that describe something
          running are locked until the workload can be read again.
        </div>
      )}

      {offFlow && (
        <div className="panel mt-4 border-white/10 px-4 py-3 text-sm text-muted">
          {/* WP-3 taxonomy sweep (umbrella #347): this used to name the EBU
              "Control vertical" here — true, but expert-tier vocabulary that
              does not belong at default level (Art. 3). The rail's own
              "Control" group label stays (a navigation grouping, not the
              taxonomy term), and the grouping fact this sentence needs to
              convey — Operate isn't a step in this flow — survives without
              naming the ontology it comes from. */}
          This workload is operating. Operate isn&apos;t a step in this flow — its
          surface is observational, so it lives on its own page —{' '}
          <Link
            to={`/media-workloads/${encodeURIComponent(workload.slug)}/operate`}
            className="text-accent hover:underline"
          >
            open the monitoring view
          </Link>
          . The steps below stay reviewable, and Finalise &amp; Review is where it ends.
        </div>
      )}

      {requestedIsLocked && (
        <div
          role="status"
          aria-live="polite"
          className="panel mt-4 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          {STEP_LABEL[requestedStep as FlowStepId]} isn&apos;t open yet:{' '}
          {LOCKED_REASON[requestedStep as FlowStepId]}
        </div>
      )}

      <FlowStep
        ref={panelRef}
        anchorId={activeStep}
        number={activeIndex + 1}
        label={STEP_LABEL[activeStep]}
        state={steps[activeStep]}
        isCurrentPosition={activeStep === current}
        lockedReason={LOCKED_REASON[activeStep]}
        canPrevious={canPrevious}
        canNext={canNext}
        onPrevious={() => prevStep && selectStep(prevStep)}
        onNext={() => nextStep && selectStep(nextStep)}
        previousReason={previousReason}
        nextReason={nextReason}
      >
        {stageBody[activeStep]}
      </FlowStep>
    </div>
  )
}
