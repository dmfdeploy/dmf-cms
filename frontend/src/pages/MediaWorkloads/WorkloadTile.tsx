import { useEffect, useState } from 'react'
import { useInstanceMxlStatus } from '../../api/hooks'
import type { ClearForDeploymentResult, MediaWorkloadInstance } from '../../api/types'
import ClearForDeployment from './ClearForDeployment'
import {
  observedBadge,
  OBSERVED_TITLE,
  requestedBadge,
  REQUESTED_TITLE,
} from './stateBadges'
import { PREVIEW_TICK_MS, STATUS_POLL_MS } from './liveView'

/**
 * A single Media Function instance as a media-native tile (WP-C).
 *
 * Hard gate 5: the 16:9 thumbnail box is a FIXED aspect box that never resizes.
 * A cache-busted preview ticks inside it; an onError swaps to a placeholder
 * glyph in the SAME box, so a dropped frame or a paused tile never reflows the
 * grid. Tiles are keyed + sorted by the parent, so an unchanged poll changes
 * nothing in the DOM.
 *
 * Node is read from the inventory `placement.node` (NetBox source of truth) —
 * NEVER from the sidecar status (WP-D R2 contract).
 */

export interface WorkloadTileProps {
  instance: MediaWorkloadInstance
  displayName: string
  // grid view + tab visible + no modal open: the status query may run at all.
  active: boolean
  // within the live-tile cap AND not reduced-motion: the preview auto-churns.
  motionAllowed: boolean
  onOpen: (instance: MediaWorkloadInstance) => void
  onCleared?: (result: ClearForDeploymentResult) => void
}

function PlaceholderThumb({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
      <svg
        className="h-8 w-8 opacity-60"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="9" cy="11" r="1.5" />
        <path d="M4 17l5-4 3 2 4-3 4 3" />
      </svg>
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
    </div>
  )
}

export default function WorkloadTile({
  instance,
  displayName,
  active,
  motionAllowed,
  onOpen,
  onCleared,
}: WorkloadTileProps) {
  const isMxl = instance.function_key?.startsWith('mxl') ?? false
  const liveEligible = isMxl && (instance.live_view ?? false)

  // Status query: enabled whenever this tile can poll (grid + visible + live).
  // It auto-refetches ONLY when motion is allowed; otherwise it fetches once
  // and holds a static last frame with an explicit Refresh affordance (P2/P3).
  const canPoll = liveEligible && active
  const status = useInstanceMxlStatus(instance.instance, {
    enabled: canPoll,
    refetchInterval: canPoll && motionAllowed ? STATUS_POLL_MS : false,
  })

  // Preview cache-bust tick — only churns while motion is allowed.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!canPoll || !motionAllowed) return
    const id = setInterval(
      () => setTick((t) => (t + 1) % 100000),
      PREVIEW_TICK_MS,
    )
    return () => clearInterval(id)
  }, [canPoll, motionAllowed])

  // A fresh src is a fresh chance for a recovered preview to render.
  const [imgError, setImgError] = useState(false)
  useEffect(() => setImgError(false), [tick])

  const data = status.data
  const available = data?.available === true
  const hasPreview = available && data?.preview === true
  const showImage = canPoll && hasPreview && !imgError

  const manualRefresh = () => {
    setTick((t) => (t + 1) % 100000)
    if (canPoll) status.refetch()
  }

  // Caption: honest about whether the frame is live, paused, or unavailable.
  let caption: string
  if (!liveEligible) {
    caption = 'No live view for this function'
  } else if (!active) {
    caption = 'Paused — tab not visible'
  } else if (!available) {
    const reason = data?.reason ?? (status.isLoading ? 'connecting' : 'unavailable')
    caption = `Live view unavailable (${reason})`
  } else if (!hasPreview) {
    caption = 'Sidecar live · no preview on this side'
  } else if (motionAllowed) {
    caption = 'Live · sidecar preview'
  } else {
    caption = 'Last frame — press Refresh for a new one'
  }

  const openable = isMxl // live modal, or the split-node aggregate fallback
  const open = () => openable && onOpen(instance)

  return (
    <div className="card flex flex-col gap-3">
      {/* Clickable body opens the detail modal. Footer controls sit outside so
          their buttons are never nested inside this activator. */}
      <div
        role={openable ? 'button' : undefined}
        tabIndex={openable ? 0 : undefined}
        onClick={open}
        onKeyDown={(e) => {
          if (openable && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            open()
          }
        }}
        className={`flex flex-col gap-2 ${openable ? 'cursor-pointer' : ''}`}
        title={
          openable
            ? 'Open the live preview + flow detail'
            : undefined
        }
      >
        <div
          className="relative aspect-video w-full overflow-hidden rounded-md border border-white/10 bg-black/40"
          title="Preview proxied from the instance's MXL sidecar; placement (node) from NetBox"
        >
          {showImage ? (
            <img
              src={`/api/media-workloads/${encodeURIComponent(
                instance.instance,
              )}/mxl/preview?t=${tick}`}
              alt={`Live preview of ${displayName}`}
              className="h-full w-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <PlaceholderThumb
              label={liveEligible ? (available ? 'no preview' : 'offline') : 'no live view'}
            />
          )}
        </div>

        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium text-text">{displayName}</div>
            <div className="truncate font-mono text-xs text-muted">
              {instance.instance}
            </div>
          </div>
          {instance.reconcile_pending && (
            <span
              className="badge shrink-0 bg-amber-900/30 text-xs text-amber-300"
              title="Requested and observed state disagree — waiting to converge"
            >
              reconciling
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`badge text-xs ${requestedBadge[instance.requested_state] ?? requestedBadge.unknown}`}
            title={REQUESTED_TITLE}
          >
            {instance.requested_state}
          </span>
          <span
            className={`badge text-xs ${observedBadge[instance.observed_state] ?? observedBadge.unknown}`}
            title={OBSERVED_TITLE}
          >
            {instance.observed_state}
          </span>
          <span className="text-xs text-muted">
            node {instance.placement.node ?? '—'}
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted">
          {liveEligible && active && available && motionAllowed && (
            <span className="inline-block h-2 w-2 rounded-full bg-green-400" aria-hidden="true" />
          )}
          <span className="truncate">{caption}</span>
        </div>
      </div>

      {/* Footer: refresh affordance for held frames + the C5 clear control. */}
      <div className="flex flex-wrap items-center gap-2">
        {liveEligible && active && !motionAllowed && (
          <button className="btn btn-secondary btn-sm" onClick={manualRefresh}>
            Refresh
          </button>
        )}
        {!instance.reconcile_pending && instance.requested_state === 'bootstrapped' && (
          <ClearForDeployment instance={instance.instance} onCleared={onCleared} />
        )}
      </div>
    </div>
  )
}
