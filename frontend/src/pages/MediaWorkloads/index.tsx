import { useEffect, useMemo, useState } from 'react'
import { useCatalog, useMediaWorkloads } from '../../api/hooks'
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
import type { ClearForDeploymentResult, MediaWorkloadInstance } from '../../api/types'

/**
 * Media Workloads (ADR-0037): Media Function instance inventory from NetBox
 * with live status overlaid. WP-C makes the media-native tile grid the default
 * view (small live thumbnails + click-open preview modal) behind a Grid|Table
 * toggle; the proven table + clear-for-deployment flow stays intact.
 *
 * Hard gate 5: instances are keyed by stable identity and sorted
 * deterministically, so a poll that changes nothing semantic never reflows the
 * list. Desired (requested_state) and observed (observed_state) are rendered as
 * SEPARATE facts — intent is never shown as running. Node is always the NetBox
 * placement, never a sidecar self-report (WP-D R2).
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

export default function MediaWorkloads() {
  const { data, isLoading, error, refetch } = useMediaWorkloads()
  const { data: catalog } = useCatalog()
  const [functionFilter, setFunctionFilter] = useState<string>('')
  const [view, setView] = useState<ViewMode>(loadView)
  const [lastResult, setLastResult] = useState<ClearForDeploymentResult | null>(null)
  // Both the grid tiles and the table's Live view open the SAME detail surface
  // (InstanceLiveModal) — the single place the fast 200ms cadence runs. There
  // is no always-mounted inline live panel, so no view leaks unbounded polling.
  const [openInstance, setOpenInstance] = useState<MediaWorkloadInstance | null>(null)

  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view)
    } catch {
      /* private mode / storage disabled — the toggle just won't persist */
    }
  }, [view])

  // Catalog display_name join, keyed by function_key (fallback to the key).
  const displayNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of catalog?.entries ?? []) {
      map.set(entry.key, entry.display_name)
    }
    return map
  }, [catalog?.entries])

  const onCleared = (result: ClearForDeploymentResult) => {
    // WP3 (#174): the C5 record already landed in Activity inside the control;
    // here we surface the page-level confirmation banner and refetch inventory.
    setLastResult(result)
    refetch()
  }

  const instances = useMemo(() => {
    const rows = (data?.instances ?? []).filter(
      (i) => !functionFilter || i.function_key === functionFilter,
    )
    // Deterministic order by stable identity: unchanged data -> unchanged DOM.
    return [...rows].sort((a, b) => a.instance.localeCompare(b.instance))
  }, [data?.instances, functionFilter])

  // Live-tile cap (codex P2): only the first LIVE_TILE_CAP tiles that actually
  // resolve a sidecar auto-refresh at once; the rest hold a last frame with a
  // Refresh affordance. Computed over the deterministic order so it's stable.
  const motionTiles = useMemo(() => {
    const set = new Set<string>()
    let n = 0
    for (const inst of instances) {
      if (inst.live_view && n < LIVE_TILE_CAP) {
        set.add(inst.instance)
        n += 1
      }
    }
    return set
  }, [instances])

  // Tile polling is allowed only in grid view, with a visible tab, and while no
  // modal is open (the open modal is the single fast-cadence surface).
  const tilesActive = view === 'grid' && visible && openInstance === null

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Media Functions in operation</p>
        <h1>Media Workloads</h1>
        <p>
          Deployed Media Function instances — what is requested, how many, and where.
          Placement and requested state come from the facility source of truth; the
          running state is proven separately by live monitoring.
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

      {!isLoading && data?.configured && data.degraded && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Inventory is degraded ({data.reason ?? 'unknown reason'}) — the facility
          source of truth is unreachable. Showing nothing rather than stale guesses.
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
            Recorded: {lastResult.actor} ({lastResult.role}) · reason: “{lastResult.reason}” ·
            ref {lastResult.request_id}
          </p>
        </div>
      )}

      {data?.configured && !data.degraded && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <label className="text-sm text-muted" htmlFor="function-filter">
              Function
            </label>
            <select
              id="function-filter"
              className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm"
              value={functionFilter}
              onChange={(e) => setFunctionFilter(e.target.value)}
            >
              <option value="">All functions</option>
              {(data.functions ?? []).map((f) => (
                <option key={f.function_key} value={f.function_key}>
                  {f.function_key} ({f.running}/{f.count} running)
                </option>
              ))}
            </select>
            {Array.isArray(data.scope) && (
              <span className="text-xs text-muted">
                Scope: {data.scope.length > 0 ? data.scope.join(', ') : 'none'}
              </span>
            )}

            {/* Grid|Table segmented toggle (persisted). */}
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

          {instances.length === 0 ? (
            <div className="panel mt-4 py-10 text-center text-sm text-muted">
              No Media Function instances
              {functionFilter ? ` for ${functionFilter}` : ''} in your scope.
            </div>
          ) : view === 'grid' ? (
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {instances.map((inst) => (
                <WorkloadTile
                  key={inst.instance}
                  instance={inst}
                  displayName={displayNames.get(inst.function_key ?? '') ?? inst.function_key ?? '—'}
                  active={tilesActive}
                  motionAllowed={motionTiles.has(inst.instance) && !reducedMotion}
                  onOpen={setOpenInstance}
                  onCleared={onCleared}
                />
              ))}
            </div>
          ) : (
            <div className="panel mt-4 overflow-x-auto p-0">
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
                  {instances.map((inst: MediaWorkloadInstance) => (
                    <tr key={inst.instance} className="border-b border-white/5">
                      <td className="px-4 py-3 font-mono text-xs">{inst.instance}</td>
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
                      <td className="px-4 py-3">{inst.placement.node ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`badge text-xs ${requestedBadge[inst.requested_state] ?? requestedBadge.unknown}`}
                          title={REQUESTED_TITLE}
                        >
                          {inst.requested_state}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`badge text-xs ${observedBadge[inst.observed_state] ?? observedBadge.unknown}`}
                          title={OBSERVED_TITLE}
                        >
                          {inst.observed_state}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {inst.reconcile_pending ? (
                          'Waiting to converge'
                        ) : inst.requested_state === 'bootstrapped' ? (
                          <ClearForDeployment instance={inst.instance} onCleared={onCleared} />
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
