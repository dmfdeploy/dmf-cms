import type { ClearForDeploymentResult, MediaWorkloadInstance } from '../../api/types'
import ClearForDeployment from './ClearForDeployment'
import {
  observedBadge,
  OBSERVED_TITLE,
  requestedBadge,
  REQUESTED_TITLE,
} from './stateBadges'
import LivePreviewBox, { useLivePreview } from './LivePreviewBox'

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
  /**
   * Whether the C5 clear-for-deployment control may appear in the footer.
   * The Operate stage passes false: the lifecycle rail authorises actions
   * per stage, and Operate deliberately carries none — a control smuggled in
   * via a shared tile would break that invariant from the side.
   */
  showClear?: boolean
}

export default function WorkloadTile({
  instance,
  displayName,
  active,
  motionAllowed,
  onOpen,
  onCleared,
  showClear = true,
}: WorkloadTileProps) {
  const { isMxl, caption, showRefresh, liveDot, refresh } = useLivePreview({
    instance,
    active,
    motionAllowed,
  })

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
        <LivePreviewBox
          instance={instance}
          displayName={displayName}
          active={active}
          motionAllowed={motionAllowed}
        />

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
          {liveDot && (
            <span className="inline-block h-2 w-2 rounded-full bg-green-400" aria-hidden="true" />
          )}
          <span className="truncate">{caption}</span>
        </div>
      </div>

      {/* Footer: refresh affordance for held frames + the C5 clear control. */}
      <div className="flex flex-wrap items-center gap-2">
        {showRefresh && (
          <button className="btn btn-secondary btn-sm" onClick={refresh}>
            Refresh
          </button>
        )}
        {showClear &&
          !instance.reconcile_pending &&
          instance.requested_state === 'bootstrapped' && (
            <ClearForDeployment instance={instance.instance} onCleared={onCleared} />
          )}
      </div>
    </div>
  )
}
