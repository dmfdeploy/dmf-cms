import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useHeaderActionSlotNode } from '../store/headerActionSlot'

/**
 * Renders `children` into the header row's promoted-action mount point when
 * `promote` is true AND that mount point currently exists; otherwise renders
 * them in place, unchanged (umbrella #347 WP-3 spec B).
 *
 * This is the ONLY thing that moves — a control's pixels, never its state.
 * The caller decides `promote` from its own runtime action model (how many
 * of ITS OWN actions are currently eligible), never from a count borrowed
 * from elsewhere; see ProvisionStage.tsx's eligibleEntries for the pattern.
 */
export default function PromotedAction({ promote, children }: { promote: boolean; children: ReactNode }) {
  const node = useHeaderActionSlotNode()
  if (promote && node) return createPortal(children, node)
  return <>{children}</>
}
