import { useEffect, useState } from 'react'
import { useInstanceMxlStatus } from '../../api/hooks'
import type { MediaWorkloadInstance } from '../../api/types'
import { PREVIEW_TICK_MS, STATUS_POLL_MS } from './liveView'
import { settleQuery } from '../../lib/queryState'
import StaticPatternCard, { hasStaticPattern } from './StaticPatternCard'

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
  /**
   * Cadence override for the one surface allowed to be lively: the open
   * modal (codex P2 — the fast rate is bounded to a single view). The
   * BOUNDS still apply there; only the rate differs. Defaults to the tile
   * cadence.
   */
  statusPollMs?: number
  previewTickMs?: number
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
  statusPollMs = STATUS_POLL_MS,
  previewTickMs = PREVIEW_TICK_MS,
}: Omit<LivePreviewBoxProps, 'displayName'>) {
  const isMxl = instance.function_key?.startsWith('mxl') ?? false
  const liveEligible = isMxl && (instance.live_view ?? false)

  // Enabled whenever this surface can poll. It auto-refetches ONLY when motion
  // is allowed; otherwise fetch-once-and-hold with an explicit Refresh (P2/P3).
  const canPoll = liveEligible && active
  const status = useInstanceMxlStatus(instance.instance, {
    enabled: canPoll,
    refetchInterval: canPoll && motionAllowed ? statusPollMs : false,
  })

  // fix-round 6 (PR #81, umbrella #385 codex sweep): `status.isError` was
  // never checked — a settled failed refetch after a successful
  // available+preview read kept the "Live · sidecar preview" caption, the
  // live dot, and the rendered image with no notice that the current poll
  // had actually failed. `settleQuery` makes `failed` win unconditionally;
  // `data` below is still the RETAINED payload on purpose (Art. 5 — the
  // frame keeps showing, `caption`/`liveDot` are what carry the caveat).
  //
  // Computed BEFORE the tick effect below (umbrella #452) so that effect can
  // gate on `hasPreview` too, not just `canPoll`/`motionAllowed`.
  const settled = settleQuery(status)
  const data = settled.data
  const available = data?.available === true
  const hasPreview = available && data?.preview === true

  const [tick, setTick] = useState(0)
  useEffect(() => {
    // umbrella #452: the tick exists ONLY to cache-bust the <img> src below —
    // pointless churn (a re-render every previewTickMs) when there is no
    // preview to refresh, which is every topology-spawned SOURCE instance
    // (live_view sidecar present, but its own preview endpoint 404s for a
    // source role) as well as any other live-eligible instance with no
    // preview capability. `!hasPreview` added alongside the pre-existing
    // `motionAllowed` gate, not a replacement for it.
    if (!canPoll || !motionAllowed || !hasPreview) return
    const id = setInterval(() => setTick((t) => (t + 1) % 100000), previewTickMs)
    return () => clearInterval(id)
  }, [canPoll, motionAllowed, hasPreview, previewTickMs])

  // A fresh src is a fresh chance for a recovered preview to render.
  const [imgError, setImgError] = useState(false)
  useEffect(() => setImgError(false), [tick])

  const showImage = canPoll && hasPreview && !imgError

  // umbrella #452: a topology-spawned source's declared test pattern, drawn
  // as a static illustration whenever there is no live image to show AND
  // StaticPatternCard actually knows how to draw it (an unrecognised
  // pattern string, or an ordinary non-topology instance with no pattern at
  // all, falls through to the existing PlaceholderThumb branch below/in
  // LivePreviewFrame — never a guessed illustration).
  const pattern = instance.topology_source_pattern ?? null
  const showStaticCard = !showImage && !!pattern && hasStaticPattern(pattern)

  // Honest about whether the frame is live, paused, or unavailable — never a
  // still frame silently presented as live (Art. 1). The static-card branch
  // takes priority over every other caption below: it is drawing something
  // concrete in the box (not a placeholder glyph) and that fact stays true
  // regardless of `active`/`liveEligible`/`available` — the same "no image,
  // no live claim" note those states would otherwise print.
  let caption: string
  if (showStaticCard) {
    caption = `Emits the ${pattern} pattern · static illustration`
  } else if (!liveEligible) {
    caption = 'No live view for this function'
  } else if (!active) {
    caption = 'Paused — tab not visible'
  } else if (settled.failed) {
    caption = hasPreview
      ? 'Could not be refreshed — showing the last reading'
      : 'Live view unavailable (read failed)'
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
    /** The raw status payload, so a caller needing flow stats does not open
     *  a SECOND query against the same endpoint at a different cadence. */
    data,
    isMxl,
    liveEligible,
    canPoll,
    available,
    showImage,
    showStaticCard,
    pattern,
    tick,
    caption,
    setImgError,
    // Held frames get an explicit way forward rather than a stale-looking
    // tile — but a static illustration is not a held live frame, so it gets
    // no Refresh affordance either (umbrella #452).
    showRefresh: !showStaticCard && liveEligible && active && !motionAllowed,
    // A settled failed poll can never light the live dot, even off retained
    // available:true data — the dot claims the CURRENT read confirmed live,
    // and a failed read is the one thing that did not confirm it. Nor can
    // the static-card branch: `available` alone (the sidecar answering at
    // all) is not "this box is showing you something live" (umbrella #452).
    liveDot: !showStaticCard && liveEligible && active && available && motionAllowed && !settled.failed,
    refresh: () => {
      setTick((t) => (t + 1) % 100000)
      if (canPoll) status.refetch()
    },
  }
}

/**
 * The frame alone, driven by an ALREADY-OBSERVED preview state. A caller that
 * needs the status payload for itself (the modal, for its flow stats) passes
 * its own observation in rather than mounting a second one: two
 * useLivePreview calls on one instance means two queries and two tick
 * effects, which is the duplicate this file exists to prevent.
 */
export function LivePreviewFrame({
  instance,
  displayName,
  preview,
}: {
  instance: MediaWorkloadInstance
  displayName: string
  preview: ReturnType<typeof useLivePreview>
}) {
  const { liveEligible, available, showImage, showStaticCard, pattern, tick, setImgError } = preview

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
      ) : showStaticCard ? (
        // umbrella #452: `pattern` is non-null whenever showStaticCard is —
        // see useLivePreview's own derivation of both above.
        <StaticPatternCard pattern={pattern as string} displayName={displayName} />
      ) : (
        <PlaceholderThumb
          label={liveEligible ? (available ? 'no preview' : 'offline') : 'no live view'}
        />
      )}
    </div>
  )
}

/** Observes and renders in one step — the common case (tiles). */
export default function LivePreviewBox({
  instance,
  displayName,
  active,
  motionAllowed,
  statusPollMs,
  previewTickMs,
}: LivePreviewBoxProps) {
  const preview = useLivePreview({
    instance,
    active,
    motionAllowed,
    statusPollMs,
    previewTickMs,
  })
  return (
    <LivePreviewFrame instance={instance} displayName={displayName} preview={preview} />
  )
}
