import { useEffect, useState } from 'react'
import { useInstanceMxlStatus } from '../../api/hooks'
import type { MediaWorkloadInstance } from '../../api/types'
import { PREVIEW_TICK_MS, STATUS_POLL_MS } from './liveView'

/**
 * The live sidecar preview for ONE instance, with its polling bounds.
 *
 * Extracted from WorkloadTile (S1, umbrella #285) so the workload entry tile
 * and the Operate stage share ONE implementation. Two surfaces each growing
 * their own copy of the cadence rules is how the codex P2/P3 bounds below
 * quietly stop applying on one of them.
 *
 * The bounds are load-bearing, not decoration:
 *   - polling runs only when `active` (visible tab, surface in view)
 *   - the preview auto-churns only when `motionAllowed` (within the live-tile
 *     cap AND not prefers-reduced-motion); otherwise it fetches once and holds
 *     a static last frame with an explicit Refresh
 *   - the box is a FIXED 16:9 aspect box: a dropped frame swaps to a
 *     placeholder glyph in the SAME box, so nothing ever reflows (hard gate 5)
 */

export interface LivePreviewBoxProps {
  instance: MediaWorkloadInstance
  displayName: string
  active: boolean
  motionAllowed: boolean
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

/**
 * Everything the preview knows about itself, so a caller can render the box,
 * the honest caption and the Refresh affordance without re-deriving any of it.
 */
export function useLivePreview({
  instance,
  active,
  motionAllowed,
}: Omit<LivePreviewBoxProps, 'displayName'>) {
  const isMxl = instance.function_key?.startsWith('mxl') ?? false
  const liveEligible = isMxl && (instance.live_view ?? false)

  // Enabled whenever this surface can poll. It auto-refetches ONLY when motion
  // is allowed; otherwise fetch-once-and-hold with an explicit Refresh (P2/P3).
  const canPoll = liveEligible && active
  const status = useInstanceMxlStatus(instance.instance, {
    enabled: canPoll,
    refetchInterval: canPoll && motionAllowed ? STATUS_POLL_MS : false,
  })

  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!canPoll || !motionAllowed) return
    const id = setInterval(() => setTick((t) => (t + 1) % 100000), PREVIEW_TICK_MS)
    return () => clearInterval(id)
  }, [canPoll, motionAllowed])

  // A fresh src is a fresh chance for a recovered preview to render.
  const [imgError, setImgError] = useState(false)
  useEffect(() => setImgError(false), [tick])

  const data = status.data
  const available = data?.available === true
  const hasPreview = available && data?.preview === true
  const showImage = canPoll && hasPreview && !imgError

  // Honest about whether the frame is live, paused, or unavailable — never a
  // still frame silently presented as live (Art. 1).
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

  return {
    isMxl,
    liveEligible,
    canPoll,
    available,
    showImage,
    tick,
    caption,
    setImgError,
    // Held frames get an explicit way forward rather than a stale-looking tile.
    showRefresh: liveEligible && active && !motionAllowed,
    liveDot: liveEligible && active && available && motionAllowed,
    refresh: () => {
      setTick((t) => (t + 1) % 100000)
      if (canPoll) status.refetch()
    },
  }
}

export default function LivePreviewBox({
  instance,
  displayName,
  active,
  motionAllowed,
}: LivePreviewBoxProps) {
  const { liveEligible, available, showImage, tick, setImgError } = useLivePreview({
    instance,
    active,
    motionAllowed,
  })

  return (
    <div
      className="relative aspect-video w-full overflow-hidden rounded-md border border-white/10 bg-black/40"
      title="Preview proxied from the instance's MXL sidecar; placement (node) from NetBox"
    >
      {showImage ? (
        <img
          src={`/api/media-workloads/${encodeURIComponent(instance.instance)}/mxl/preview?t=${tick}`}
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
  )
}
