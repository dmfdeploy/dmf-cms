import { create } from 'zustand'

/**
 * The header row's PROMOTED-ACTION mount point (umbrella #347 WP-3 spec B).
 * A DOM node, not a data model: Topbar publishes the node it renders inside
 * the header slot row; whichever stage control currently qualifies as "the
 * current step's one eligible primary action" portals its own button +
 * ReasonConfirm panel into it. Nothing about the control's OWNERSHIP moves —
 * arming/pending/error state stays exactly where it already lived (the
 * stage's own entry component); this only relocates its rendered pixels.
 *
 * WHY A PORTAL, NOT A SECOND HeaderSlotContent FIELD. store/headerSlot.ts's
 * `primaryAction` descriptor is a plain {label, onClick, disabled} button —
 * enough for a click, not for the WHOLE loop the ruling requires (arming,
 * ReasonConfirm, pending, error, terminal result). Building that loop out of
 * data passed through a store would mean re-deriving, in WorkloadDetail, the
 * exact runtime eligibility + mutation state each stage already owns — a
 * second copy of logic the stage is the only correct owner of. A portal
 * keeps the owning component the SAME component; only its mount point moves.
 *
 * WHY THIS IS SAFE WITHOUT A SLUG GUARD OF ITS OWN. The node in this store is
 * only ever non-null while Topbar's header-slot row is actually mounted for
 * the CURRENT route (see Topbar.tsx's showSlotRow, unchanged) — and the one
 * caller of this store's node, a stage's own entry component, only exists
 * while WorkloadWizard is mounted, which is keyed on `workload.slug`
 * (WorkloadDetail.tsx) and therefore torn down — taking any portal it
 * created with it — before a different workload's wizard mounts. There is no
 * window where a promoted control from workload A can portal into a node
 * still labelled with workload B: React unmounts A's tree (running the
 * portal's own cleanup) before B's tree exists to look up the node again.
 */
interface HeaderActionSlotState {
  node: HTMLElement | null
  setNode: (node: HTMLElement | null) => void
}

// NOT exported — Topbar is the only sanctioned writer, via the ref callback
// below. A stage reads the node; it never sets one.
const useHeaderActionSlotStore = create<HeaderActionSlotState>((set) => ({
  node: null,
  setNode: (node) => set({ node }),
}))

/** Topbar-only: a ref callback that publishes (or clears) the mount point. */
export function useSetHeaderActionSlotNode() {
  return useHeaderActionSlotStore((s) => s.setNode)
}

/**
 * Any stage's leaf control reads this to decide where to render. Null
 * whenever no workload-detail header row currently exists — a unit test
 * that mounts a stage without Topbar, or a route where the row is absent,
 * simply never has anywhere to portal into, so promotion silently no-ops
 * and the control renders inline exactly as it always has. Promotion is
 * therefore a progressive enhancement, never a second code path a caller
 * has to opt out of.
 */
export function useHeaderActionSlotNode(): HTMLElement | null {
  return useHeaderActionSlotStore((s) => s.node)
}
