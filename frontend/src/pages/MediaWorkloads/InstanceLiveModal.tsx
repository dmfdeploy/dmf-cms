import { useEffect, useState } from 'react'
import { useInstanceMxlStatus } from '../../api/hooks'
import type { MediaWorkloadInstance } from '../../api/types'
import MxlDetailPanel from './MxlDetailPanel'
import { MODAL_PREVIEW_TICK_MS, MODAL_STATUS_POLL_MS } from './liveView'

/**
 * The deliberate, single detail surface (WP-C): click a tile → a live preview
 * + flow stats for that one instance. This is the ONLY place the fast 200ms
 * cache-bust cadence runs (codex P2), and it exists only while open.
 *
 * Flow stats are the server-shaped, bounded set from WP-D. `node` is shown from
 * the inventory `placement.node` (NetBox SoT), NOT the sidecar — the status
 * payload never carries a node string (WP-D R2).
 *
 * Fallback: when an MXL instance has no per-instance sidecar (`live_view`
 * false) but the static split-node aggregate is configured, mount the existing
 * MxlDetailPanel so the demo path still works.
 */

function fmtLatency(ms: number | null, grains: number | null): string {
  if (ms == null) return '—'
  const base = `${Number(ms).toFixed(1)} ms`
  return grains != null ? `${base} / ${grains} grains` : base
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-text">{value}</div>
    </div>
  )
}

function LiveBody({ instance }: { instance: MediaWorkloadInstance }) {
  const status = useInstanceMxlStatus(instance.instance, {
    enabled: true,
    refetchInterval: MODAL_STATUS_POLL_MS,
  })

  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(
      () => setTick((t) => (t + 1) % 100000),
      MODAL_PREVIEW_TICK_MS,
    )
    return () => clearInterval(id)
  }, [])

  const [imgError, setImgError] = useState(false)
  useEffect(() => setImgError(false), [tick])

  const data = status.data
  const available = data?.available === true
  const flow = data?.flow
  const hasPreview = available && data?.preview === true
  const headIndex =
    flow?.head_index != null ? Number(flow.head_index).toLocaleString() : '—'

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="relative aspect-video w-full overflow-hidden rounded-md border border-white/10 bg-black/40">
        {hasPreview && !imgError ? (
          <img
            src={`/api/media-workloads/${encodeURIComponent(
              instance.instance,
            )}/mxl/preview?t=${tick}`}
            alt={`Live preview of ${instance.instance}`}
            className="h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm text-muted">
            {available
              ? 'No preview on this side'
              : `Live view unavailable (${data?.reason ?? 'connecting'})`}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Head index" value={headIndex} />
        <Stat label="Latency" value={fmtLatency(flow?.latency_ms ?? null, flow?.latency_grains ?? null)} />
        <Stat label="Format" value={flow?.format ?? '—'} />
        <Stat label="Grain rate" value={flow?.grain_rate ?? '—'} />
        <Stat label="Role" value={data?.role ?? '—'} />
        <Stat label="Provider" value={data?.provider ?? '—'} />
        <Stat label="MXL version" value={data?.mxl_version ?? '—'} />
        <Stat label="Active" value={flow?.active == null ? '—' : flow.active ? 'yes' : 'no'} />
        {/* Node is the NetBox placement, never the sidecar's self-report. */}
        <Stat label="Node (NetBox)" value={instance.placement.node ?? '—'} />
      </div>

      <p className="text-xs text-muted">
        Preview + flow proxied live from the instance's MXL status sidecar;
        placement (node) is the NetBox source of truth. Updates ~5×/s while open.
      </p>
    </div>
  )
}

export default function InstanceLiveModal({
  instance,
  displayName,
  onClose,
}: {
  instance: MediaWorkloadInstance
  displayName: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const live = instance.live_view ?? false

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="live-modal-title"
    >
      <div
        className="panel w-full max-w-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="live-modal-title" className="truncate text-lg font-semibold text-text">
              {displayName}
            </h2>
            <div className="truncate font-mono text-xs text-muted">
              {instance.instance} · node {instance.placement.node ?? '—'}
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </header>

        {live ? (
          <LiveBody instance={instance} />
        ) : (
          <div className="mt-4">
            <MxlDetailPanel />
          </div>
        )}
      </div>
    </div>
  )
}
