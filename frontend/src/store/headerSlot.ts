import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { create } from 'zustand'

/**
 * The typed, route-scoped header slot (umbrella dmfdeploy/dmfdeploy#347 Arc
 * 4 WP-2). Topbar renders a second header row beneath the h-14 breadcrumb
 * row on workload-detail routes, and only there; WP-3 registers the
 * lifecycle rail and the current step's promoted primary action into it
 * from WorkloadDetail — the route component that already owns steps,
 * selection, locked reasons, and job-in-flight state. Topbar itself must
 * never derive that state — lib/workloadLifecycle.ts exists precisely to
 * keep "where is this workload" a single derivation, and a second one
 * living in Topbar would defeat that.
 *
 * TYPED, NOT A BARE ReactNode: a caller gets two named fields — `rail` and
 * an optional `primaryAction` — rather than one opaque node it could stuff
 * arbitrary UI into. Topbar owns the row's own layout (single non-wrapping
 * line, horizontal overflow scroll); callers supply content only.
 *
 * `slug` guards against a stale registration surviving past the route that
 * owns it — Topbar renders content only when it matches the workload slug
 * parsed from the current URL, so even a caller that forgets to clear on
 * unmount cannot leak its rail onto a different route.
 *
 * WP-2 registers nothing into this slot — it wires the container only.
 */
export interface HeaderSlotContent {
  /** The workload slug this content belongs to. */
  slug: string
  rail: ReactNode
  primaryAction?: ReactNode
}

interface HeaderSlotState {
  content: HeaderSlotContent | null
  setHeaderSlot: (content: HeaderSlotContent) => void
  clearHeaderSlot: () => void
}

export const useHeaderSlotStore = create<HeaderSlotState>((set) => ({
  content: null,
  setHeaderSlot: (content) => set({ content }),
  clearHeaderSlot: () => set({ content: null }),
}))

/**
 * Convenience hook for the route component that owns the slot's state
 * (WP-3: WorkloadDetail). Registers on mount/update, clears on unmount —
 * so navigating away always clears the row even if the caller forgets to,
 * rather than leaving a stale rail for the guard above to catch.
 */
export function useRegisterHeaderSlot(content: HeaderSlotContent | null) {
  const setHeaderSlot = useHeaderSlotStore((s) => s.setHeaderSlot)
  const clearHeaderSlot = useHeaderSlotStore((s) => s.clearHeaderSlot)

  useEffect(() => {
    if (content) {
      setHeaderSlot(content)
    }
    return () => clearHeaderSlot()
  }, [content, setHeaderSlot, clearHeaderSlot])
}
