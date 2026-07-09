import { useEffect, useMemo, useState } from 'react'
import { useCatalog, useMediaWorkloadsGrouped } from '../../api/hooks'
import ClearForDeployment from './ClearForDeployment'
import WorkloadTile from './WorkloadTile'
import InstanceLiveModal from './InstanceLiveModal'
import {
  LIVE_TILE_CAP,
  useDocumentVisible,
  usePrefersReducedMotion,
} from './liveView'
import {
  observedBadge,
  OBSERVED_TITLE,
  requestedBadge,
  REQUESTED_TITLE,
} from './stateBadges'
import type {
  ClearForDeploymentResult,
  MediaWorkload,
  MediaWorkloadInstance,
} from '../../api/types'

/**
 * Media Workloads (ADR-0037 + ADR-0046): workload-first grouped inventory.
 *
 * Consumes the additive /api/media-workloads/grouped endpoint which groups
 * instances by workload:<slug> tag, derives per-workload lifecycle, and
 * joins observed state by per-instance identity (ADR-0046 §3).
 *
 * Hard gate 5: workloads keyed by slug, instances by name — deterministic
 * sort so a no-op poll never reflows. Desired vs observed rendered separately.
 */

type ViewMode = 'grid' | 'table'
const VIEW_KEY = 'dmf-console-mw-view'

function loadView(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'grid'
  } catch {
    return 'grid'
  }
}

const LIFECYCLE_BADGE: Record<string, string> = {
  provision: 'bg-blue-500/20 text-blue-300',
  configure: 'bg-amber-500/20 text-amber-300',
  operate: 'bg-green-500/20 text-green-300',
  unknown: 'bg-white/10 text-muted',
}

export default function MediaWorkloads() {
  const { data, isLoading, error, refetch } = useMediaWorkloadsGrouped()
  const { data: catalog } = useCatalog()
  const [view, setView] = useState<ViewMode>(loadView)
  const [lastResult, setLastResult] = useState<ClearForDeploymentResult | null>(null)
  const [openInstance, setOpenInstance] = useState<MediaWorkloadInstance | null>(null)

  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view)
    } catch {
      /* private mode / storage disabled */
    }
  }, [view])

  const displayNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of catalog?.entries ?? []) {
      map.set(entry.key, entry.display_name)
    }
    return map
  }, [catalog?.entries])

  const onCleared = (result: ClearForDeploymentResult) => {
    setLastResult(result)
    refetch()
  }

  // Deterministic workload order: sorted by slug, unassigned last.
  const workloads = useMemo(() => {
    const wls = data?.workloads ?? []
    return [...wls].sort((a, b) => {
      if (a.slug === 'unassigned') return 1
      if (b.slug === 'unassigned') return -1
      return a.slug.localeCompare(b.slug)
    })
  }, [data?.workloads])

  // Flatten all instances across workloads for the live-tile cap calculation.
  const allInstances = useMemo(() => {
    const out: (MediaWorkloadInstance & { workload_assignment: string; _workload_slug: string })[] = []
    for (const wl of workloads) {
      for (const inst of wl.instances) {
        out.push({ ...inst, _workload_slug: wl.slug })
      }
    }
    return out
  }, [workloads])

  const motionTiles = useMemo(() => {
    const set = new Set<string>()
    let n = 0
    for (const inst of allInstances) {
      if (inst.live_view && n < LIVE_TILE_CAP) {
        set.add(inst.instance)
        n += 1
      }
    }
    return set
  }, [allInstances])

  const tilesActive = view === 'grid' && visible && openInstance === null

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Media Workloads</p>
        <h1>Media Workloads</h1>
        <p>
          Workload-first view of deployed Media Function instances — grouped by
          workload identity with per-workload lifecycle and health rollup.
        </p>
      </div>

      {!isLoading && error != null && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Media Workloads could not be loaded: {String(error)}
        </div>
      )}

      {!isLoading && data && !data.configured && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Media Workloads is not configured for this environment (tenancy posture
          undeclared — set <span className="font-mono">DMF_CONSOLE_MEDIA_TENANCY</span>).
        </div>
      )}

      {!isLoading && data?.configured && data.degraded && (!data.workloads || data.workloads.length === 0) && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Inventory is degraded ({data.reason ?? 'unknown reason'}) — the source
          of truth is unreachable.
        </div>
      )}

      {lastResult && (
        <div className="panel mt-6 border border-green-500/20 bg-green-500/10 px-4 py-3 text-sm text-green-200">
          <div className="font-semibold">
            {lastResult.instance}: requested state is now {lastResult.requested_state}
            {' '}(was {lastResult.previous_state})
          </div>
          <p className="mt-1 text-green-200/80">{lastResult.reconcile.expectation}</p>
          <p className="mt-1 text-xs text-green-200/60">
            Recorded: {lastResult.actor} ({lastResult.role}) · reason: "{lastResult.reason}" ·
            ref {lastResult.request_id}
          </p>
        </div>
      )}

      {data?.configured && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {Array.isArray(data.scope) && (
              <span className="text-xs text-muted">
                Scope: {data.scope.length > 0 ? data.scope.join(', ') : 'none'}
              </span>
            )}
            <div
              className="ml-auto inline-flex overflow-hidden rounded-md border border-white/10"
              role="group"
              aria-label="View mode"
            >
              <button
                className={`px-3 py-1 text-sm ${view === 'grid' ? 'bg-accent text-bg' : 'bg-black/20 text-muted'}`}
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                Grid
              </button>
              <button
                className={`px-3 py-1 text-sm ${view === 'table' ? 'bg-accent text-bg' : 'bg-black/20 text-muted'}`}
                aria-pressed={view === 'table'}
                onClick={() => setView('table')}
              >
                Table
              </button>
            </div>
          </div>

          {workloads.length === 0 ? (
            <div className="panel mt-4 py-10 text-center text-sm text-muted">
              No Media Function instances in your scope.
            </div>
          ) : (
            <div className="mt-4 space-y-6">
              {workloads.map((wl: MediaWorkload) => (
                <div key={wl.slug} className="panel">
                  {/* Workload header */}
                  <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
                    <h2 className="text-lg font-semibold capitalize">{wl.name}</h2>
                    <span
                      className={`badge text-xs ${LIFECYCLE_BADGE[wl.lifecycle] ?? LIFECYCLE_BADGE.unknown}`}
                    >
                      {wl.lifecycle}
                    </span>
                    {wl.health === 'degraded' && (
                      <span className="badge bg-red-500/20 text-xs text-red-300">
                        degraded
                      </span>
                    )}
                    <span className="text-xs text-muted">
                      {wl.instances.length} instance{wl.instances.length !== 1 ? 's' : ''} ·{' '}
                      {wl.functions.map((f) => `${f.function_key}(${f.running}/${f.count})`).join(', ')}
                    </span>
                  </div>

                  {/* Instances within this workload */}
                  {view === 'grid' ? (
                    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                      {[...wl.instances].sort((a, b) => a.instance.localeCompare(b.instance)).map((inst) => (
                        <WorkloadTile
                          key={inst.instance}
                          instance={inst}
                          displayName={
                            displayNames.get(inst.function_key ?? '') ??
                            inst.function_key ??
                            '—'
                          }
                          active={tilesActive}
                          motionAllowed={
                            motionTiles.has(inst.instance) && !reducedMotion
                          }
                          onOpen={setOpenInstance}
                          onCleared={onCleared}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="overflow-x-auto p-0">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted">
                            <th className="px-4 py-3">Instance</th>
                            <th className="px-4 py-3">Function</th>
                            <th className="px-4 py-3">Node</th>
                            <th className="px-4 py-3">Requested</th>
                            <th className="px-4 py-3">Observed</th>
                            <th className="px-4 py-3" />
                          </tr>
                        </thead>
                        <tbody>
                          {[...wl.instances].sort((a, b) => a.instance.localeCompare(b.instance)).map((inst) => (
                            <tr
                              key={inst.instance}
                              className="border-b border-white/5"
                            >
                              <td className="px-4 py-3 font-mono text-xs">
                                {inst.instance}
                              </td>
                              <td className="px-4 py-3">
                                {inst.function_key ?? '—'}
                                {inst.function_key?.startsWith('mxl') && (
                                  <button
                                    className="btn btn-secondary btn-sm ml-2"
                                    onClick={() => setOpenInstance(inst)}
                                  >
                                    Live view
                                  </button>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                {inst.placement.node ?? '—'}
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={`badge text-xs ${
                                    requestedBadge[inst.requested_state] ??
                                    requestedBadge.unknown
                                  }`}
                                  title={REQUESTED_TITLE}
                                >
                                  {inst.requested_state}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={`badge text-xs ${
                                    observedBadge[inst.observed_state] ??
                                    observedBadge.unknown
                                  }`}
                                  title={OBSERVED_TITLE}
                                >
                                  {inst.observed_state}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-xs text-muted">
                                {inst.reconcile_pending ? (
                                  'Waiting to converge'
                                ) : inst.requested_state === 'bootstrapped' ? (
                                  <ClearForDeployment
                                    instance={inst.instance}
                                    onCleared={onCleared}
                                  />
                                ) : (
                                  ''
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Invalid instances section (ADR-0046 §2) */}
          {data.invalid_instances && data.invalid_instances.length > 0 && (
            <div className="panel mt-4 border border-red-500/20 bg-red-500/5">
              <div className="flex items-center gap-3 border-b border-red-500/20 px-4 py-3">
                <h2 className="text-lg font-semibold text-red-300">
                  Invalid workload assignments
                </h2>
                <span className="badge bg-red-500/20 text-xs text-red-300">
                  {data.invalid_instances.length} instance{data.invalid_instances.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="p-4 text-sm">
                <p className="text-red-200/80 mb-3">
                  These services have more than one workload:* tag. Each service must
                  belong to exactly one workload. Fix the NetBox tags to resolve.
                </p>
                <ul className="space-y-1 font-mono text-xs">
                  {data.invalid_instances.map((inv) => (
                    <li key={inv.instance} className="text-red-200/70">
                      {inv.instance} ({inv.function_key ?? '?'}): conflicting workloads{' '}
                      {inv.conflicting_workloads.join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </>
      )}

      {openInstance && (
        <InstanceLiveModal
          instance={openInstance}
          displayName={
            displayNames.get(openInstance.function_key ?? '') ??
            openInstance.function_key ??
            openInstance.instance
          }
          onClose={() => setOpenInstance(null)}
        />
      )}
    </div>
  )
}
