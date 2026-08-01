import { useCallback, useMemo, useState, useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useCatalog, useMediaWorkloadsGrouped, useInstanceTopology } from '../../api/hooks'
import type { MediaWorkloadInstance } from '../../api/types'
import WorkloadTile from './WorkloadTile'
import InstanceLiveModal from './InstanceLiveModal'
import { LIVE_TILE_CAP, useDocumentVisible, usePrefersReducedMotion } from './liveView'

/**
 * Operate — the workload's own monitoring route (umbrella #285, operator
 * direction 2026-08-01: "Operate leaves this page entirely").
 *
 * WHY THIS IS A SEPARATE ROUTE, NOT A STAGE ON THE FLOW. The guided flow
 * (workloadFlow.ts) walks five steps the operator WORKS THROUGH in order;
 * Operate is a thing they WATCH, indefinitely, with no "only then" gate of
 * its own — nothing has to finish here before anything else opens. (The flow
 * does continue past it: Finalise & Review is open throughout, because a
 * running workload can always be torn down. Operate simply is not the thing
 * that gates it.) Folding it back onto the flow page would either
 * force it through the same locked/open/complete vocabulary it doesn't fit,
 * or special-case it there — both worse than the mount the orchestrator
 * already wired: its own URL, reachable independent of where the flow
 * currently sits.
 *
 * WHY IT CARRIES NO ACTION OF ITS OWN. The EBU coverage matrix marks
 * live Operate-time control as not-implemented, and that is accurate — but
 * the reason is about the KIND of write, not the count. The console has two
 * writes reachable while a workload runs: Configure's switch-source and
 * Finalise & Review's teardown (Finalise is open throughout Operate, because
 * a running workload can always be torn down). Neither is live flow control:
 * the switch is a configure-time re-point performed by an automation job, and
 * a teardown ends the workload rather than steering it. What is missing is
 * any seam that steers media WHILE it runs, and that is what this stage would
 * need to carry an action of its own. A control here that looked like it
 * re-routed media live would misstate what actually happens — so the one
 * affordance below is a navigation to the real seam, never a mutation.
 *
 * Reuses exactly what the retired Operate STAGE panel reused —
 * WorkloadTile, InstanceLiveModal, and the liveView.ts polling bounds — for
 * the same reason that panel did: a second implementation of "visible tab
 * only, capped concurrent churn, reduced-motion honoured" is how a
 * backgrounded console quietly starts hammering the sidecars again.
 */

// Mirrors the first four designed states WorkloadDetail.tsx uses for this
// same grouped-inventory read, so a workload that fails to resolve reads
// identically whether the operator is on the flow page or here (Art. 1 —
// two pages disagreeing about "is this workload loaded" would itself be an
// uncertainty the console presented as settled).
export default function WorkloadOperate() {
  const { slug } = useParams<{ slug: string }>()
  const { data, isLoading, error } = useMediaWorkloadsGrouped()
  const { data: catalogData } = useCatalog()
  const [openInstance, setOpenInstance] = useState<MediaWorkloadInstance | null>(null)

  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()

  // Human names, not catalog slugs — same fallback chain the retired
  // Operate stage panel used:
  // catalog display_name, then the function key, then the instance id, so a
  // catalog miss degrades to something true rather than a blank label.
  const displayNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of catalogData?.entries ?? []) map.set(entry.key, entry.display_name)
    return map
  }, [catalogData?.entries])
  const nameFor = (i: MediaWorkloadInstance) =>
    displayNames.get(i.function_key ?? '') ?? i.function_key ?? i.instance

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

  const workload = data?.workloads.find((w) => w.slug === slug)

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

  const instances = [...workload.instances].sort((a, b) => a.instance.localeCompare(b.instance))

  // Same cap + gating as the retired Operate stage panel: only the first
  // LIVE_TILE_CAP eligible
  // tiles auto-churn, and every tile's polling stops outright while the
  // modal is open (the modal is the one surface allowed the fast cadence).
  const motionTiles = new Set<string>()
  for (const inst of instances) {
    if (inst.live_view && motionTiles.size < LIVE_TILE_CAP) motionTiles.add(inst.instance)
  }
  const tilesActive = visible && openInstance === null

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Media Workloads · Operate</p>
        <h1 className="capitalize">{workload.name}</h1>
        <p>
          The monitoring surface for this workload — observed running state only.
          Changes are requested at the flow's own steps, not from here.
        </p>
      </div>

      <Link
        to={`/media-workloads/${workload.slug}`}
        className="mt-2 inline-block text-sm text-accent hover:underline"
      >
        ← Back to {workload.name}
      </Link>

      {instances.length === 0 ? (
        <div className="panel mt-6 py-10 text-center text-sm text-muted">
          Nothing is running yet for this workload — Operate will show live state once
          Provision and Configure have run.
        </div>
      ) : (
        <>
          {/*
            THE LIVE VIEW doubles as INSTANCE HEALTH: WorkloadTile already
            renders the requested-vs-observed pair (stateBadges.ts palettes
            and titles) beside the preview, and the WO for this page is
            explicit that the two must not be shown twice on one page — a
            second list of the same requested/observed facts would be a
            second, potentially divergent, presentation of a single truth
            (Art. 1's whole complaint). So there is one grid here, not two.
          */}
          <section className="panel mt-6 border border-white/10" aria-label="Live view">
            <div className="border-b border-white/10 px-4 py-3">
              <h2 className="text-base font-semibold">Live view</h2>
            </div>
            <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
              {instances.map((inst) => (
                <WorkloadTile
                  key={inst.instance}
                  instance={inst}
                  displayName={nameFor(inst)}
                  active={tilesActive}
                  motionAllowed={motionTiles.has(inst.instance) && !reducedMotion}
                  onOpen={setOpenInstance}
                />
              ))}
            </div>
          </section>

          <ActiveSourceSection instances={instances} />
        </>
      )}

      {openInstance && (
        <InstanceLiveModal
          instance={openInstance}
          displayName={nameFor(openInstance)}
          onClose={() => setOpenInstance(null)}
        />
      )}

      {/*
        The one affordance this page offers, and it is a navigation, not a
        write: Operate owns no mutation, so there is nothing here to arm or
        confirm. Copy is held to the register the operator specified —
        "request", "configure-time re-point performed by an automation job"
        — and away from anything that reads as this page controlling the
        flow live (the forbidden-words test in workloadOperate.test.tsx
        pins that this section never regresses into "switch"/"re-route"/
        "cut"/"take"/"live" phrasing).
      */}
      <section
        className="panel mt-6 border border-white/10 p-4 text-sm"
        aria-label="Request a configuration change"
      >
        <h2 className="text-base font-semibold">Request a configuration change</h2>
        <p className="mt-2 text-muted">
          Source selection happens at the Configure step — changing this workload&apos;s
          source is a configure-time re-point performed by an automation job, not
          real-time flow control.
        </p>
        <Link
          to={`/media-workloads/${workload.slug}#configure`}
          className="mt-3 inline-block text-accent hover:underline"
        >
          Go to Configure →
        </Link>
      </section>
    </div>
  )
}

/**
 * ACTIVE SOURCE, for the subset of instances that resolve a topology (the
 * receiver/"viewer" role — most instances are producers with none).
 *
 * The heading and the per-instance rows are gated on the SAME fact: whether
 * any instance in this workload actually has one. Each InstanceActiveSource
 * below decides independently (its own useInstanceTopology call resolves or
 * 404s on its own schedule), so the parent cannot know in advance — it has
 * to be told as each child settles. Rendering the heading unconditionally
 * would produce exactly the "empty box" umbrella #285 rules out for a
 * workload with no viewer at all; gating it on the reported set means the
 * section is simply absent until real data exists for it (Art. 9 — no
 * undesigned blank, but also no designed chrome around an absence).
 */
function ActiveSourceSection({ instances }: { instances: MediaWorkloadInstance[] }) {
  const [hasTopology, setHasTopology] = useState<Record<string, boolean>>({})

  // Same bail-out-to-the-same-object shape as ConfigureStage's
  // setInstancePending: an instance reporting the same answer it already
  // reported must not trigger a re-render, or every 15s inventory poll would
  // re-run this state update for no observable change.
  const reportTopology = useCallback((instance: string, has: boolean) => {
    setHasTopology((prev) => (prev[instance] === has ? prev : { ...prev, [instance]: has }))
  }, [])

  // One row per instance regardless of the outcome below — each keeps
  // running its own useInstanceTopology so a topology that resolves later
  // (or a sibling's that never does) can still flip the wrapper on. The
  // rows themselves are the existing null-if-absent contract; what varies
  // here is only whether they sit inside a labelled panel or bare.
  const rows = instances.map((inst) => (
    <InstanceActiveSource key={inst.instance} instance={inst.instance} onResolved={reportTopology} />
  ))

  if (!Object.values(hasTopology).some(Boolean)) {
    // Nothing resolved yet (most workloads have no receiver at all): no
    // panel, no heading, no empty box — Art. 9 rules out designed chrome
    // around an absence as firmly as it rules out an undesigned blank.
    return <>{rows}</>
  }

  return (
    <section className="panel mt-6 border border-white/10" aria-label="Active source">
      <div className="border-b border-white/10 px-4 py-3">
        <h2 className="text-base font-semibold">Active source</h2>
      </div>
      <div className="p-4 text-sm">{rows}</div>
    </section>
  )
}

/** One instance's row: its declared sources and which one is active. */
function InstanceActiveSource({
  instance,
  onResolved,
}: {
  instance: string
  onResolved: (instance: string, has: boolean) => void
}) {
  const topology = useInstanceTopology(instance)
  const has = Boolean(topology.data && Array.isArray(topology.data.sources))
  useEffect(() => onResolved(instance, has), [instance, has, onResolved])

  // An instance without a topology renders nothing — not an empty card, not
  // an error: most instances are producers, not receivers, and "no topology"
  // is their normal resting fact, established already by ConfigureStage's
  // switch control (the same null-if-absent contract, reused rather than
  // reinvented here).
  if (!has || !topology.data) return null
  const { sources, active_source: activeSource } = topology.data

  return (
    <div className="border-t border-white/5 pt-3 first:border-t-0 first:pt-0">
      <div className="text-xs uppercase tracking-wide text-muted">
        Source · <span className="font-mono normal-case text-muted">{instance}</span>
      </div>
      <div className="mt-1 font-mono text-sm text-text">{activeSource ?? '—'}</div>
      <ul className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
        {sources.map((s) => (
          <li key={s.id} className={s.id === activeSource ? 'text-accent' : ''}>
            {s.id} ({s.pattern})
          </li>
        ))}
      </ul>
    </div>
  )
}
