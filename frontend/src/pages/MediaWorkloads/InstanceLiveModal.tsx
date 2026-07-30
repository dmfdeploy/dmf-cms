import { useEffect, useRef, useState } from 'react'
import { useInstanceMxlStatus, useInstanceTopology, useSwitchSource } from '../../api/hooks'
import { useActivityStore } from '../../store/activity'
import ReasonConfirm from '../../components/ReasonConfirm'
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

/**
 * The coarse `reconnect` switch (umbrella #201 WP5, spec §6/§7): presents
 * the topology's OTHER sources as targets, requires a reason (C5, mirrors
 * ClearForDeployment's own graduated-friction pattern via the shared
 * ReasonConfirm), and surfaces the actuator's outcome honestly —
 * "Switching…" IS the live "reconnecting" status (the actuator's own
 * contract is synchronous-await, not a separate poll), and
 * failed_rollback_required is shown as a failure requiring operator
 * retry/rollback, never masked as success.
 *
 * Renders nothing (not an error state) when the instance carries no
 * topology at all — the common case for every non-viewer instance.
 *
 * umbrella #320/#321 (runtime truth): `active_source` now reflects a live
 * sidecar observation, not a static catalog value — so the switch control
 * itself must fail closed. It only ever offers a target when the topology's
 * `provenance`/`observed_at` prove the current active source was actually
 * seen, recently. Anything else (unreachable/unconfigured sidecar, no flow
 * match, or a reading that's gone stale) disables the control rather than
 * falling back to a possibly-wrong catalog default.
 */
// useInstanceTopology fetches once when the modal opens (and again only
// after a switch completes) rather than polling, so `observed_at` can
// genuinely go stale while the modal sits open; this bounds how old a
// reading may be before the switch is refused rather than trusted.
const OBSERVED_SOURCE_STALE_MS = 15_000

const OBSERVED_SOURCE_UNKNOWN_MESSAGE =
  'Live source is unknown or stale — refresh to retry before switching.'

function SwitchSourceControl({ instance }: { instance: string }) {
  const topology = useInstanceTopology(instance)
  const switchMutation = useSwitchSource()
  const recordAwxWrite = useActivityStore((s) => s.recordAwxWrite)
  const [arming, setArming] = useState(false)
  const [target, setTarget] = useState('')

  if (!topology.data || !Array.isArray(topology.data.sources)) return null

  const { sources, active_source, provenance, observed_at } = topology.data
  const isObservedFresh =
    provenance === 'observed-flow' &&
    !!active_source &&
    !!observed_at &&
    Date.now() - new Date(observed_at).getTime() < OBSERVED_SOURCE_STALE_MS

  // Fresh: today's behavior (offer every OTHER declared source; no control
  // at all when there's nothing else to switch to). Not fresh: never offer
  // a target — the disabled branch below renders instead.
  const otherSources = isObservedFresh ? sources.filter((s) => s.id !== active_source) : []
  if (isObservedFresh && otherSources.length === 0) return null

  const result = switchMutation.data

  const submit = (reason: string) => {
    if (!target) return
    switchMutation.mutate(
      { instance, sourceInstance: target, reason },
      {
        onSuccess: (res) => {
          // C5: the console-local record also lands in Activity → History.
          recordAwxWrite({
            request_id: res.request_id,
            action: 'switch-source',
            target: instance,
            reason: res.reason,
            actor: res.actor,
            role: res.role,
            outcome: res.status,
          })
          setArming(false)
          setTarget('')
          topology.refetch()
        },
      },
    )
  }

  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-wide text-muted">Source</div>
        {!arming && (
          <button
            className="btn btn-secondary btn-sm"
            disabled={!isObservedFresh}
            title={isObservedFresh ? undefined : OBSERVED_SOURCE_UNKNOWN_MESSAGE}
            onClick={() => {
              switchMutation.reset()
              setArming(true)
            }}
          >
            Switch source
          </button>
        )}
      </div>

      {!isObservedFresh && (
        <p className="mt-1 text-[11px] text-amber-200/60">{OBSERVED_SOURCE_UNKNOWN_MESSAGE}</p>
      )}

      {arming ? (
        <div className="mt-2">
          <ReasonConfirm
            title="Switch active source"
            description="Coarse reconfigure/reconnect actuator — not a live IS-05 switch. Re-points this viewer to a different source and is recorded in the audit trail with your reason."
            confirmLabel="Confirm switch"
            pendingLabel="Switching…"
            pending={switchMutation.isPending}
            error={switchMutation.isError ? switchMutation.error : undefined}
            onConfirm={submit}
            onCancel={() => {
              setArming(false)
              setTarget('')
            }}
            extraField={{
              label: 'Target source',
              placeholder: 'Select a source…',
              value: target,
              onChange: setTarget,
              invalid: target === '',
              options: otherSources.map((s) => ({ value: s.id, label: `${s.id} (${s.pattern})` })),
            }}
          />
        </div>
      ) : result ? (
        <div className={`mt-1 text-xs ${result.status === 'active' ? 'text-green-400' : 'text-red-300'}`}>
          {result.status === 'active'
            ? `Active source: ${result.source_instance}`
            : `Switch failed (${result.error ?? 'failed_rollback_required'}) — operator retry/rollback required.`}
        </div>
      ) : (
        <div className="mt-0.5 font-mono text-sm text-text">{active_source ?? '—'}</div>
      )}
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

      <SwitchSourceControl instance={instance.instance} />
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
