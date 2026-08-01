import { useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useCatalog, useMediaWorkloadsGrouped } from '../../api/hooks'
import {
  classifyWorkloadLifecycle,
  stageActions,
  type WorkloadLifecycleInput,
} from '../../lib/workloadLifecycle'
import {
  FLOW_STEPS,
  classifyWorkloadFlow,
  lifecycleBadge,
  type FlowStepId,
} from '../../lib/workloadFlow'
import type { SwitchSourceResult } from '../../api/types'
import FlowStep from './FlowStep'
import LifecycleStrip from './LifecycleStrip'
import DesignStage from './stages/DesignStage'
import PlanStage from './stages/PlanStage'
import ProvisionStage from './stages/ProvisionStage'
import ConfigureStage from './stages/ConfigureStage'
import FinaliseStage from './stages/FinaliseStage'

/**
 * Workload detail — the GUIDED SEQUENTIAL FLOW (umbrella #285, operator
 * direction 2026-08-01).
 *
 * S1 shipped this page as six stage cards stacked open at once under a
 * horizontal chip rail. The operator's verdict was "right direction, wrong
 * presentation": the model was correct, the page was not. This is the
 * rebuilt presentation, and every piece of S1 SUBSTANCE carries forward
 * underneath it unchanged — the state machine, the honesty states, and the
 * relocations that keep hidden nav items from darkening a feedback loop.
 *
 * THREE THINGS CHANGED, and only these:
 *
 * 1. PROGRESSION IS GATED. A step opens when its predecessor completes
 *    ("only then"); completed steps stay reviewable. The gate is
 *    lib/workloadFlow.ts, which derives ordering FROM lib/workloadLifecycle
 *    .ts and so cannot contradict it. Position still comes from the
 *    backend's ADR-0046 derivation, consumed 1:1, never re-derived here.
 *
 * 2. OPERATE LEFT THE PAGE. It has no card and no step; its surface is the
 *    monitoring route at /media-workloads/<slug>/operate. It remains a
 *    lifecycle STAGE — LifecycleStrip.tsx is how the six-stage vocabulary
 *    is still taught in full, and its docstring carries that reasoning.
 *
 * 3. THE CHIP RAIL BECAME A VOCABULARY STRIP PLUS NUMBERED STEPS, because
 *    the rail was doing two jobs at once and blurring both: naming the model
 *    and indicating progress. The strip names the model; the steps carry the
 *    progress.
 *
 * WHAT THE STAGE PANELS ARE TOLD. Each panel still takes a StageState, but
 * this page no longer passes a per-stage classification down — the flow
 * state above it already decided what is open, and a second state travelling
 * alongside it could disagree. Panels receive 'available' exactly when the
 * flow reports the step `open` (which is itself derived from stageActions),
 * and 'informational' otherwise. A locked step renders no panel at all, so
 * 'not-applicable' has no remaining call site here: the gate expresses that
 * case now, and it expresses it by withholding the content rather than by
 * rendering a stage that explains its own emptiness.
 *
 * The job overlay (which write is in flight) is still this page's own local
 * state, deliberately not persisted: a reload re-derives purely from the
 * backend, which is correct — a job this tab forgot is still visible as
 * whatever lifecycle it left the workload in.
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
const LOCKED_REASON: Record<FlowStepId, string> = {
  design: 'This step opens once the workload can be read again.',
  plan: 'This step opens once the workload can be read again.',
  provision: 'This step opens once the workload can be read again.',
  configure:
    'Nothing is running for this workload yet, so there is no source to select. This step opens once Provision has deployed it.',
  finalise:
    'Nothing is running for this workload yet, so there is nothing to tear down. This step opens once Provision has deployed it.',
}

export default function WorkloadDetail() {
  const { slug } = useParams<{ slug: string }>()
  const { hash } = useLocation()
  const { data, isLoading, error } = useMediaWorkloadsGrouped()
  const { data: catalogData, isLoading: catalogLoading } = useCatalog()

  const [launching, setLaunching] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [tearingDown, setTearingDown] = useState(false)
  const [lastSwitchResult, setLastSwitchResult] = useState<SwitchSourceResult | null>(null)

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

  if (!workload) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="hero">
          <p className="kicker">Media Workloads</p>
          <h1>Workload not found</h1>
        </div>
        <div className="panel mt-4 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          No workload named &quot;{slug}&quot; is in your scope right now.
        </div>
        <Link to="/media-workloads" className="mt-4 inline-block text-sm text-accent hover:underline">
          ← Back to Media Workloads
        </Link>
      </div>
    )
  }

  const input: WorkloadLifecycleInput = {
    lifecycle: workload.lifecycle,
    launching,
    switching,
    tearingDown,
    // Member state, not position: clearing one of several siblings moves the
    // position to configure while the rest still need clearing, so the flow
    // has to be told what the workload NEEDS as well as where it IS
    // (GATE-S1-RV3 P1). workloadFlow.ts ranks affordance above position for
    // exactly this case, which is what keeps the clear path reachable inside
    // an otherwise-completed Provision step.
    hasBootstrappedMembers: workload.instances.some(
      (i) => !i.reconcile_pending && i.requested_state === 'bootstrapped',
    ),
  }
  const { active } = classifyWorkloadLifecycle(input)
  const { steps, current, offFlow, undetermined } = classifyWorkloadFlow(input)
  const badge = lifecycleBadge(input)

  // A fragment aimed at a step folds that step open on arrival. The Operate
  // page's "request configuration change" link is the one caller, and this
  // is why that link lands on the work rather than at the top of the page.
  // It only changes the initial fold — a locked step still renders nothing,
  // so a crafted fragment can never reach a control the gate closed.
  const requestedStep = hash.replace(/^#/, '')

  const stageBody: Record<FlowStepId, ReactNode> = {
    design: (
      <DesignStage
        workload={workload}
        catalogEntries={catalogData?.entries ?? []}
        catalogLoading={catalogLoading}
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
      />
    ),
    configure: (
      <ConfigureStage
        workload={workload}
        state={steps.configure === 'open' ? 'available' : 'informational'}
        actions={stageActions('configure', input)}
        onBusyChange={setSwitching}
        onSwitchResult={setLastSwitchResult}
      />
    ),
    finalise: (
      <FinaliseStage
        workload={workload}
        state={steps.finalise === 'open' ? 'available' : 'informational'}
        actions={stageActions('finalise', input)}
        onBusyChange={setTearingDown}
        lastSwitchResult={lastSwitchResult}
      />
    ),
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Media Workloads</p>
        <h1 className="capitalize">{workload.name}</h1>
        <p>
          <span
            title={
              badge.grammar === 'in-flight'
                ? 'A job is running for this workload right now'
                : badge.grammar === 'unknown'
                  ? 'The facility source of truth could not place this workload'
                  : 'The last lifecycle step this workload completed'
            }
          >
            {badge.label}
          </span>
          {workload.health === 'degraded' ? ' · degraded' : ''}
        </p>
      </div>

      <LifecycleStrip active={active} slug={workload.slug} />

      {/* Two different reasons no step is current. The page must not blur
          them into one shrug: one is the console failing to read the
          workload, the other is the workload running normally somewhere
          this flow deliberately does not go. */}
      {undetermined && (
        <div className="panel mt-4 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          The facility source of truth could not place this workload in its lifecycle, so
          no step below is open and nothing is offered. The steps stay closed until the
          workload can be read again — a guessed position would be worse than none.
        </div>
      )}

      {offFlow && (
        <div className="panel mt-4 border-white/10 px-4 py-3 text-sm text-muted">
          This workload is operating. Operate is a lifecycle stage, but its surface is
          monitoring rather than a step to work through, so it lives on its own page —{' '}
          <Link
            to={`/media-workloads/${encodeURIComponent(workload.slug)}/operate`}
            className="text-accent hover:underline"
          >
            open the monitoring view
          </Link>
          . The steps below stay reviewable, and Finalise &amp; Review is where it ends.
        </div>
      )}

      <div className="mt-4 space-y-4">
        {FLOW_STEPS.map((id, i) => (
          <FlowStep
            key={id}
            anchorId={id}
            number={i + 1}
            label={STEP_LABEL[id]}
            state={steps[id]}
            // The position step is pinned open. `current` from the flow is
            // the POSITION — it stays the position even when the step reads
            // `open` because it also bears an action, which is exactly the
            // case where keying disclosure off the state string would fold
            // away the control the operator came for.
            pinned={id === current}
            lockedReason={LOCKED_REASON[id]}
            startExpanded={requestedStep === id}
            summary={
              id === current
                ? 'The workload is here now'
                : steps[id] === 'open'
                  ? 'Ready — this step has something you can do'
                  : undefined
            }
          >
            {stageBody[id]}
          </FlowStep>
        ))}
      </div>
    </div>
  )
}
