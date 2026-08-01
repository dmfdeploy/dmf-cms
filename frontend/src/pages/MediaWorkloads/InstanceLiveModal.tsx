import { useEffect, useRef } from 'react'
import type { MediaWorkloadInstance } from '../../api/types'
import MxlDetailPanel from './MxlDetailPanel'
import { LivePreviewFrame, useLivePreview } from './LivePreviewBox'
import {
  MODAL_PREVIEW_TICK_MS,
  MODAL_STATUS_POLL_MS,
  useDocumentVisible,
  usePrefersReducedMotion,
} from './liveView'

/**
 * The deliberate, single detail surface (WP-C): open an instance and see a
 * live preview plus its flow stats. READ-ONLY. It carried a switch control
 * until GATE-S1 — which put a mutation on Operate, outside Configure and
 * outside the rail's in-flight suppression entirely. Switching is Configure's
 * alone now; nothing here writes.
 *
 * Bounds come from LivePreviewBox's hook, observed ONCE here and passed to
 * the frame: the fast cadence is a rate, not an exemption, so a hidden tab
 * pauses it and reduced-motion stops the churn like everywhere else.
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

/**
 * The modal body: the live frame plus this instance's flow stats. One
 * observation drives both (see LivePreviewFrame) rather than the frame
 * opening a second query of its own.
 */
function LiveBody({ instance }: { instance: MediaWorkloadInstance }) {
  // ONE bounds implementation, shared with the tiles (GATE-S1 P2b). The modal
  // is the single surface allowed the fast cadence, but "lively" never meant
  // "unbounded": a hidden tab still pauses it, and prefers-reduced-motion
  // still stops the churn. Before this it ran its own timer that honoured
  // neither, which is exactly how a second copy of the rules silently drops
  // them.
  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const preview = useLivePreview({
    instance,
    active: visible,
    motionAllowed: !reducedMotion,
    statusPollMs: MODAL_STATUS_POLL_MS,
    previewTickMs: MODAL_PREVIEW_TICK_MS,
  })
  const { caption, showRefresh, refresh, data } = preview
  const flow = data?.flow

  const headIndex =
    flow?.head_index != null ? Number(flow.head_index).toLocaleString() : '—'

  return (
    <div className="mt-4 flex flex-col gap-4">
      {/* ONE observation, used for both the frame and the stats below. */}
      <LivePreviewFrame
        instance={instance}
        displayName={instance.instance}
        preview={preview}
      />

      <div className="flex items-center gap-2 text-xs text-muted">
        <span>{caption}</span>
        {showRefresh && (
          <button className="btn btn-secondary btn-sm" onClick={refresh}>
            Refresh
          </button>
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
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Focus management for aria-modal (codex P3): pull focus into the dialog on
  // open, keep Tab within it, and restore focus to the opener on close so
  // keyboard users are never left interacting with inert background controls.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const focusables = () =>
      panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null || el === document.activeElement)
        : []

    ;(focusables()[0] ?? panel)?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        panel?.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    panel?.addEventListener('keydown', onKeyDown)
    return () => {
      panel?.removeEventListener('keydown', onKeyDown)
      opener?.focus?.()
    }
  }, [])

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
        ref={panelRef}
        tabIndex={-1}
        className="panel w-full max-w-2xl p-5 outline-none"
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
