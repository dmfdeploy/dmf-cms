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
  classifyForwardExit,
  isStepOpenable,
  lifecycleBadge,
  type FlowStepId,
  type FlowStepState,
  type ForwardExit,
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
import PageHeading from '../../components/PageHeading'
import { usePageTitle } from '../../hooks/usePageTitle'

/**
 * Workload detail — the WIZARD (umbrella #347 WO-D1, operator direction
 * 2026-08-02: "the workload detail page becomes a wizard — one lifecycle
 * step visible at a time, Next/Previous, the EBU-colored rail as the
 * prominent navigation spine"). VERBATIM HISTORICAL QUOTE, not a live
 * description — FIX ROUND (codex gate — P3): flagged explicitly here,
 * rather than only 30 lines down, because a reader skimming just the
 * opening could otherwise take "EBU-colored" as current. It stopped being
 * accurate at the Arc 4 WP-2 ruling (see point 2 below and
 * LifecycleStrip.tsx's own docstring): colour tracks SELECTION now, not EBU
 * stage identity, and as of dmf-cms#391 Pass 1 the rail is neutral/
 * selection-coloured only — the six EBU stage hues are retired as key
 * fills entirely.
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
 * dmfdeploy#412: the array-position adjacency Next/Previous walk. FLOW_STEPS
 * itself is untouched (still five steps, in this order, no 'operate' — the
 * hard constraint) — this is narrower: Finalise & Review is no longer the
 * "next" constructive step out of Configure. It stays fully reachable from
 * the rail and from Previous (Finalise's own Previous still resolves to
 * Configure via FLOW_STEPS below, unaffected), because it is a lifecycle
 * action an operator can take at any time a workload runs, not a step that
 * gates anything after it. FORWARD_STEPS is FLOW_STEPS minus Finalise for
 * exactly this one purpose, computed once — see WorkloadWizard's `nextStep`
 * for the only place it is read, and lib/workloadFlow.ts's
 * classifyForwardExit for what now offers forward progress out of Configure
 * instead of a Next that used to land on Teardown/Delete.
 */
const FORWARD_STEPS: FlowStepId[] = FLOW_STEPS.filter((id) => id !== 'finalise')

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
  // Unconditional (hooks must run every render): the slug is an honest
  // fallback before the workload record resolves, same provenance rule the
  // breadcrumb already applies (Topbar.tsx's useBreadcrumbTrail).
  usePageTitle(workload?.name ?? slug)

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        {/* Umbrella #385 finding 5 audit, WP-4 stage 2: this branch had no
            h1 at all — distinct from the !workload branch below, which
            already carries its own visible "Workload not found" heading and
            must not also get this one. */}
        <PageHeading>{workload?.name ?? slug}</PageHeading>
        <p className="text-muted">Loading workload…</p>
      </div>
    )
  }

  if (error != null) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <PageHeading>{workload?.name ?? slug}</PageHeading>
        <div className="panel border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          This workload could not be loaded right now. Retrying automatically.
        </div>
      </div>
    )
  }

  if (data && !data.configured) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <PageHeading>{workload?.name ?? slug}</PageHeading>
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
  // umbrella dmf-cms#391 Pass 1, FIX ROUND (codex gate — P1, the counts):
  // workload.instances threaded straight in — classifyWorkloadForHeaderSlot
  // derives the rail's running/total itself from this same array, rather
  // than trusting a pre-computed count from further down this function (see
  // store/headerSlot.ts's TRUST side table docstring for why that
  // caller-supplied channel was the actual gap).
  const flow = classifyWorkloadForHeaderSlot(input, workload.instances)
  const { steps, current, offFlow, undetermined } = flow
  const badge = lifecycleBadge(input)
  // dmfdeploy#412: what Configure's forward exit offers right now — see
  // lib/workloadFlow.ts's classifyForwardExit for the full state table and
  // why each branch is honest. Computed off the SAME live `input` every
  // other affordance on this page reads (not `displaySteps`'/`settledStepsRef`'s
  // frozen-during-a-poll value): row 1 of that table requires a stale or
  // in-flight read to withhold the affordance itself, not merely delay it —
  // the opposite of the #392 freeze this page applies to step selection.
  // Takes only `input` — no `workload.instances` — since the fix-round gate
  // (dmfdeploy#412): the earlier version read instance.live_view here to
  // pick between two operating-state labels, which is exactly the preview
  // claim classifyForwardExit's own docstring now explains live_view cannot
  // honestly support.
  const forwardExit = classifyForwardExit(input)

  // A fragment aimed at a step selects+focuses that step on arrival. The
  // Operate page's "request configuration change" link is the one caller.
  // It only changes the initial selection — a locked step is never selected
  // by it (defaultSelection's isStepOpenable guard), so a crafted fragment
  // can never reach a control the gate closed.
  const requestedStep = hash.replace(/^#/, '')

  // umbrella #392 fix round: groupedRead.isFetching/userQuery.isFetching
  // feed the SAME steps classification (via membersDataTrustworthy /
  // purgeAuthorized in workloadLifecycle.ts) that decides which step is
  // openable — deliberately, so a background poll can't make the operator
  // trust a mid-refetch read for the actual purge gate. But that fail-closed
  // value is presentation-UNSTABLE by design: it flips false for however
  // long the background request the operator didn't ask for is in flight,
  // then flips back once it settles, even when nothing about the workload
  // actually changed. Reacting to that flip live turned a one-tick
  // classification dip into silently evicting the operator from Finalise
  // mid-review, before they had time to read the confirmation, type a
  // reason, and click through (#392) — and it happened TWICE over: once in
  // activeStep's own fallback ladder, and independently in FlowStep.tsx,
  // which refuses to mount `children` at all whenever the `state` it's
  // handed is 'locked' (its own defence-in-depth comment), so even holding
  // `activeStep` steady still unmounted the stage component underneath it
  // for the poll's duration, wiping any local state (an armed
  // ReasonConfirm's typed reason) along with it.
  //
  // `settledStepsRef` latches the last STEPS classification computed while
  // neither read was in flight — the same "freeze the last good value
  // during render" idiom ProvisionStage.tsx's lastEligibleKeyRef already
  // uses for an analogous problem. `displaySteps` is what this component
  // uses for its OWN panel (openability + the state handed to FlowStep)
  // whenever the read is unsettled; deliberately NOT what feeds the rail
  // below (buildHeaderSlotRail still reads live `flow.steps`) — the rail is
  // supposed to keep reflecting a background poll in real time, exactly
  // what GATE-378b's own test already pins ("the rail losing its Finalise
  // button... is the discriminator"). isGroupedReadTrustworthy/
  // isPurgeAuthorized/stageActions and the delete-permanently button's own
  // gating are all untouched — `actions` passed to each stage below is
  // still recomputed fresh from `input` every render, so the button/action
  // list still correctly withholds while either read is unsettled. Only the
  // PANEL — which step is selected, and whether its content stays mounted —
  // stops reacting to a read that hasn't settled yet.
  const dataUnsettled = groupedRead.isFetching || userQuery.isFetching
  const settledStepsRef = useRef(steps)
  if (!dataUnsettled) settledStepsRef.current = steps
  const displaySteps = dataUnsettled ? settledStepsRef.current : steps

  const activeStep =
    selectedStep !== null && isStepOpenable(displaySteps[selectedStep])
      ? selectedStep
      : defaultSelection(displaySteps, current, offFlow, requestedStep)

  // React's sanctioned "derived state" pattern: persist the computed
  // fallback into state so a later query refresh that keeps the operator's
  // step openable does NOT re-run this priority order — spec A is explicit
  // that only ceasing to be openable re-triggers it. Needs no separate
  // `dataUnsettled` guard here: whenever selectedStep is non-null and the
  // read is unsettled, the ternary above already forces activeStep to equal
  // selectedStep (displaySteps[selectedStep] reflects the last SETTLED,
  // necessarily-non-locked classification for a step that was selected),
  // so this effect only ever fires on a REAL divergence (a settled,
  // still-locked classification, or the initial null->selection mount,
  // which should commit immediately regardless of fetch state).
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
  // dmfdeploy#412: forward adjacency walks FORWARD_STEPS (FLOW_STEPS minus
  // Finalise), not FLOW_STEPS itself — see that constant's own comment.
  // Previous is untouched (still FLOW_STEPS-based), so Finalise's own
  // Previous still lands back on Configure exactly as before.
  const forwardIndex = FORWARD_STEPS.indexOf(activeStep)
  const nextStep = forwardIndex !== -1 && forwardIndex < FORWARD_STEPS.length - 1
    ? FORWARD_STEPS[forwardIndex + 1]
    : null
  const canPrevious = !jobInFlight && prevStep !== null && steps[prevStep] !== 'locked'
  const canNext = !jobInFlight && nextStep !== null && steps[nextStep] !== 'locked'
  // dmfdeploy#412 FIX ROUND 3: nextStep === null is no longer one meaning.
  // It is true on Finalise & Review (forwardIndex === -1, off FORWARD_STEPS
  // entirely — genuinely the last step of FLOW_STEPS) AND on Configure
  // (forwardIndex is FORWARD_STEPS' last index — no further constructive
  // step, but the flow keeps going: Finalise & Review is still ahead,
  // still rail-reachable). The shared fallback used to say "This is the
  // last step." on both, which is false on Configure and, paired with
  // ConfigureForwardExit's 'none' rendering nothing, told the operator the
  // journey ended at Configure when it does not. isLastFlowStep is derived
  // from FLOW_STEPS' own length, not a hardcoded `activeStep === 'finalise'`
  // — it stays correct if FLOW_STEPS' shape ever changes, the same
  // brittleness FORWARD_STEPS' own comment already flags for the
  // media-specifics rule.
  const isLastFlowStep = activeIndex === FLOW_STEPS.length - 1

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
      ? isLastFlowStep
        ? 'This is the last step.'
        : 'There is no next step to configure. Finalise & Review stays reachable at any time from the steps above.'
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
      // umbrella dmf-cms#391 Pass 1, FIX ROUND (codex gate — P1, the
      // counts): this call site used to compute running/total itself and
      // hand them in here — that was the actual gap (a caller-supplied
      // count with no formula behind it, forgeable independently of
      // `trustworthy`). Removed entirely: buildHeaderSlotRail derives
      // running/total, alongside trustworthy, from the TRUST WeakMap —
      // populated a few lines up by classifyWorkloadForHeaderSlot(input,
      // workload.instances), the SAME instances array this object used to
      // read counts off directly before this fix. RailModelExtras no
      // longer has a runningReadout field for this call site to fill in at
      // all.
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
      <PageHeading>{workload.name}</PageHeading>
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
        // umbrella #392: displaySteps, not live `steps` — FlowStep refuses
        // to mount `children` at all when handed 'locked' (its own
        // defence-in-depth comment), so the live, transiently-locked value
        // would unmount the active stage's own local state (an armed
        // ReasonConfirm's typed reason) every time a background poll ticked
        // while this step happened to be selected. See displaySteps' own
        // comment above for why the rail a few lines below deliberately
        // does NOT get the same treatment.
        state={displaySteps[activeStep]}
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

      {/* dmfdeploy#412: the exit this issue adds — rendered ONLY while
          Configure is the selected step, because Configure is the last
          constructive step FORWARD_STEPS walks to (above). Not a sixth
          step, not inside FlowStep's own Previous/Next footer (which never
          says "Next" here any more — nextStep is null for Configure, see
          FORWARD_STEPS), and not a persistent banner: it is specifically
          the exit at the point the old array-position Next used to land on
          Teardown/Delete. */}
      {activeStep === 'configure' && <ConfigureForwardExit exit={forwardExit} slug={workload.slug} />}
    </div>
  )
}

/**
 * The state-gated forward exit out of Configure (dmfdeploy#412) — see
 * lib/workloadFlow.ts's classifyForwardExit for what each `exit` value
 * means and why. 'none' renders nothing: every state that reaches 'none'
 * (untrustworthy read, a job in flight, not yet at Configure's position,
 * position unknown, running but not yet fully configured) already has its
 * own honest surface elsewhere on this page — Configure's own content, a
 * stage's own progress/failure display, or the busy reason text FlowStep
 * already renders — and a claim here would be exactly the sometimes-false
 * success affordance the issue's acceptance criteria rule out.
 *
 * Neither `label` nor `description` below asserts anything about whether a
 * preview exists (FIX ROUND, dmfdeploy#412 adversarial gate round 1) — see
 * classifyForwardExit's own docstring for why instance.live_view cannot
 * honestly support that claim in either direction. "Open live view" names
 * the destination ROUTE (that is what the console already calls it), not a
 * promise about what is on it.
 *
 * Nor does 'view-status's description assert anything about a JOB OUTCOME
 * (FIX ROUND, round 2) — see classifyForwardExit's own docstring on
 * 'view-status' for why the classifier has no job-outcome input to draw
 * that from. It states only that the position is configure and nothing has
 * been observed running yet, never that a deploy "succeeded".
 */
function ConfigureForwardExit({ exit, slug }: { exit: ForwardExit; slug: string }) {
  if (exit === 'none') return null

  const to = `/media-workloads/${encodeURIComponent(slug)}/operate`
  const COPY: Record<Exclude<ForwardExit, 'none'>, { label: string; description: string }> = {
    'view-status': {
      label: 'View workload status',
      description: 'This workload has not been observed running yet.',
    },
    live: {
      label: 'Open live view',
      description: 'A trusted read reports this workload operating.',
    },
  }
  const { label, description } = COPY[exit]

  return (
    <div className="panel mt-4 border-white/10 px-4 py-3 text-sm text-muted">
      {description}{' '}
      <Link to={to} className="text-accent hover:underline">
        {label} →
      </Link>
    </div>
  )
}
