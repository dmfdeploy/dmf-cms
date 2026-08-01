import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useCatalog, useMediaWorkloadsGrouped } from '../../api/hooks'
import {
  STAGES,
  classifyWorkloadLifecycle,
  stageActions,
  type WorkloadLifecycleInput,
} from '../../lib/workloadLifecycle'
import type { SwitchSourceResult } from '../../api/types'
import DesignStage from './stages/DesignStage'
import PlanStage from './stages/PlanStage'
import ProvisionStage from './stages/ProvisionStage'
import ConfigureStage from './stages/ConfigureStage'
import OperateStage from './stages/OperateStage'
import FinaliseStage from './stages/FinaliseStage'

/**
 * Workload detail — the EBU lifecycle rail (umbrella #285 S1). This is the
 * one surface Catalog's deploy/teardown UI and Activity's job-progress feel
 * relocate onto, so hiding those nav items never darkens the deploy/switch/
 * teardown feedback loop.
 *
 * The rail's active stage + per-stage states come ENTIRELY from
 * lib/workloadLifecycle.ts, fed by:
 *   - the backend's own derived lifecycle (workload.lifecycle, verbatim —
 *     never re-derived here), and
 *   - three local booleans this page tracks itself: whether a deploy,
 *     switch, or teardown job is currently in flight. Each action stage
 *     owns its own mutation(s) and reports its busy state up via a plain
 *     setState setter — no second lifecycle model, just an observation
 *     overlay on top of the one the backend already computed.
 */
const HEADER_LIFECYCLE_LABEL: Record<string, string> = {
  provision: 'Provision',
  configure: 'Configure',
  operate: 'Operate',
  unknown: 'Undetermined',
}

export default function WorkloadDetail() {
  const { slug } = useParams<{ slug: string }>()
  const { data, isLoading, error } = useMediaWorkloadsGrouped()
  const { data: catalogData, isLoading: catalogLoading } = useCatalog()

  // The rail's own job-tracking overlay (see file docstring). Each is set
  // by the stage that owns the corresponding mutation; none of it is
  // persisted — a page reload re-derives purely from the backend again,
  // which is correct: a job this tab forgot is still visible as whatever
  // lifecycle it left the workload in.
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
  }
  const { active, states } = classifyWorkloadLifecycle(input)

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Media Workloads</p>
        <h1 className="capitalize">{workload.name}</h1>
        <p>
          {HEADER_LIFECYCLE_LABEL[workload.lifecycle]}
          {workload.health === 'degraded' ? ' · degraded' : ''}
          {active == null &&
            " — the backend could not determine this workload's stage; the rail below has no active stage rather than a guess."}
        </p>
      </div>

      {/* The rail: all six stages, always visible (Art. 3 — this is the
          pedagogy). A pill's colour is the SAME state driving the card
          below it; nothing here is a second, independent judgment. */}
      <div className="mt-6 flex flex-wrap gap-2" role="list" aria-label="Lifecycle stage">
        {STAGES.map((stage) => (
          <span
            key={stage.id}
            role="listitem"
            className={`badge text-xs ${
              states[stage.id] === 'active'
                ? 'bg-accent/20 text-accent'
                : states[stage.id] === 'available'
                  ? 'bg-green-900/30 text-green-300'
                  : states[stage.id] === 'not-applicable'
                    ? 'bg-white/5 text-muted/70'
                    : 'bg-white/10 text-muted'
            }`}
          >
            {stage.label}
          </span>
        ))}
      </div>

      <div className="mt-4 space-y-4">
        <DesignStage
          workload={workload}
          catalogEntries={catalogData?.entries ?? []}
          catalogLoading={catalogLoading}
          state={states.design}
        />
        <PlanStage workload={workload} state={states.plan} />
        <ProvisionStage
          workload={workload}
          state={states.provision}
          actions={stageActions('provision', input)}
          onBusyChange={setLaunching}
        />
        <ConfigureStage
          workload={workload}
          state={states.configure}
          actions={stageActions('configure', input)}
          onBusyChange={setSwitching}
          onSwitchResult={setLastSwitchResult}
        />
        <OperateStage workload={workload} state={states.operate} />
        <FinaliseStage
          workload={workload}
          state={states.finalise}
          actions={stageActions('finalise', input)}
          onBusyChange={setTearingDown}
          lastSwitchResult={lastSwitchResult}
        />
      </div>
    </div>
  )
}
