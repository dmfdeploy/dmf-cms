import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useMediaWorkloadsGrouped } from '../../api/hooks'
import type { MediaWorkload, MediaWorkloadInstance } from '../../api/types'
import LivePreviewBox from './LivePreviewBox'
import {
  LIVE_TILE_CAP,
  useDocumentVisible,
  usePrefersReducedMotion,
} from './liveView'

/**
 * Media Workloads (ADR-0037 + ADR-0046) — S1 IA cut (umbrella #285).
 *
 * One square control-surface TILE per workload, opening the workload detail
 * page. The per-instance grid/table/live-modal/clear-for-deployment UI that
 * used to live here has moved onto WorkloadDetail's lifecycle rail.
 *
 * The tile keeps a LIVE PREVIEW. That is not decoration: the preview is what
 * makes this a media-native console rather than an inventory list, and the
 * simplification is not allowed to cost it. It also keeps the preview's
 * polling bounds intact (codex P2/P3) — visible-tab only, capped number of
 * concurrently-churning tiles, reduced-motion honoured, fixed aspect box —
 * because a backgrounded console must never hammer the sidecars.
 *
 * What stays, unchanged, is the grouped-inventory HONESTY: not-configured,
 * degraded, and invalid-workload-assignment are still designed states, not a
 * blank page. A tile that renders nothing when the source of truth is
 * unreachable would be a worse lie than the list it replaced.
 *
 * The visual treatment (provider mark, tile faces, colour) is deliberately
 * NOT done here — that is the streamdeck skin pass. This commit is the
 * structure that skin will hang on.
 */

const LIFECYCLE_BADGE: Record<string, string> = {
  provision: 'bg-blue-500/20 text-blue-300',
  configure: 'bg-amber-500/20 text-amber-300',
  operate: 'bg-green-500/20 text-green-300',
  unknown: 'bg-white/10 text-muted',
}

/**
 * The instance whose preview represents the workload on its tile: the first
 * live-view-capable one in deterministic order, so an unchanged poll never
 * swaps which instance the tile is showing.
 */
function representativeInstance(wl: MediaWorkload): MediaWorkloadInstance | null {
  const sorted = [...wl.instances].sort((a, b) => a.instance.localeCompare(b.instance))
  return sorted.find((i) => i.live_view && i.function_key?.startsWith('mxl')) ?? sorted[0] ?? null
}

export default function MediaWorkloads() {
  const { data, isLoading, error } = useMediaWorkloadsGrouped()
  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()

  // Deterministic workload order: sorted by slug, unassigned last.
  const workloads = useMemo(() => {
    const wls = data?.workloads ?? []
    return [...wls].sort((a, b) => {
      if (a.slug === 'unassigned') return 1
      if (b.slug === 'unassigned') return -1
      return a.slug.localeCompare(b.slug)
    })
  }, [data?.workloads])

  // The live-tile cap applies across the whole page, exactly as it did for the
  // instance grid: only the first N previews auto-churn, the rest hold a frame.
  const motionTiles = useMemo(() => {
    const set = new Set<string>()
    let n = 0
    for (const wl of workloads) {
      const rep = representativeInstance(wl)
      if (rep?.live_view && n < LIVE_TILE_CAP) {
        set.add(wl.slug)
        n += 1
      }
    }
    return set
  }, [workloads])

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Media Workloads</p>
        <h1>Media Workloads</h1>
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

      {data?.configured && (
        <>
          {Array.isArray(data.scope) && (
            <p className="mt-6 text-xs text-muted">
              Scope: {data.scope.length > 0 ? data.scope.join(', ') : 'none'}
            </p>
          )}

          {workloads.length === 0 ? (
            <div className="panel mt-4 py-10 text-center text-sm text-muted">
              No Media Function instances in your scope.
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {workloads.map((wl) => (
                <WorkloadEntryTile
                  key={wl.slug}
                  workload={wl}
                  active={visible}
                  motionAllowed={motionTiles.has(wl.slug) && !reducedMotion}
                />
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
    </div>
  )
}

/* ─── the square entry tile ─── */

function WorkloadEntryTile({
  workload,
  active,
  motionAllowed,
}: {
  workload: MediaWorkload
  active: boolean
  motionAllowed: boolean
}) {
  const rep = representativeInstance(workload)

  return (
    <Link
      to={`/media-workloads/${encodeURIComponent(workload.slug)}`}
      // Square control-surface tile. aspect-square is the structural
      // commitment the skin pass depends on; everything inside lays out
      // within it rather than driving its height.
      className="card group flex aspect-square flex-col gap-3 overflow-hidden rounded-xl transition hover:border-accent/40 hover:bg-white/5"
      aria-label={`Open ${workload.name} workload detail`}
    >
      {rep ? (
        <LivePreviewBox
          instance={rep}
          displayName={workload.name}
          active={active}
          motionAllowed={motionAllowed}
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-md border border-white/10 bg-black/40 text-xs text-muted">
          No instances yet
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold capitalize">{workload.name}</h2>
          <span
            className={`badge shrink-0 text-xs ${LIFECYCLE_BADGE[workload.lifecycle] ?? LIFECYCLE_BADGE.unknown}`}
          >
            {workload.lifecycle}
          </span>
          {workload.health === 'degraded' && (
            <span className="badge shrink-0 bg-red-500/20 text-xs text-red-300">degraded</span>
          )}
        </div>

        <p className="mt-auto truncate text-xs text-muted">
          {workload.instances.length} instance{workload.instances.length !== 1 ? 's' : ''}
          {workload.functions.length > 0 && ' · '}
          {workload.functions.map((f) => `${f.function_key}(${f.running}/${f.count})`).join(', ')}
        </p>
      </div>
    </Link>
  )
}
