import { useEffect } from 'react'
import { create } from 'zustand'
import type { FlowStepId, FlowStepState } from '../lib/workloadFlow'

/**
 * The typed, route-scoped header slot (umbrella dmfdeploy/dmfdeploy#347 Arc
 * 4 WP-2). Topbar renders a second header row beneath the h-14 breadcrumb
 * row on workload-detail routes, and only there; WP-3 registers into it
 * from WorkloadDetail — the route component that already owns steps,
 * selection, locked reasons, and job-in-flight state. Topbar itself must
 * never derive that state — lib/workloadLifecycle.ts exists precisely to
 * keep "where is this workload" a single derivation, and a second one
 * living in Topbar (or smuggled in through this slot) would defeat that.
 *
 * WHAT IS ACTUALLY ENFORCED, not just claimed:
 *
 * 1. `rail` is DATA — the exact prop shape LifecycleStrip already takes
 *    (steps/activeStep/current/offFlow/lockedReasons/jobOwnerLabel/
 *    jobInFlight/onSelect), not a ReactNode. Topbar is the only place that
 *    turns it into pixels, via `<LifecycleStrip {...rail} slug={slug} />`.
 *    A caller cannot register a rail computed any way other than through
 *    classifyWorkloadFlow, because the payload IS that derivation's output
 *    — not "a caller could pass anything, but by convention doesn't."
 * 2. `primaryAction` is a narrow descriptor (label/onClick/disabled/
 *    disabledReason), not a node — Topbar owns the `<button>` markup, the
 *    caller supplies intent only.
 * 3. The raw Zustand store is NOT exported. `useRegisterHeaderSlot` (write)
 *    and `useHeaderSlotContent` (read, Topbar-only) are the entire public
 *    surface — there is no `setHeaderSlot` reachable from outside this
 *    module to bypass either guarantee above.
 *
 * `slug` guards against a stale registration surviving past the route that
 * owns it — Topbar renders content only when it matches the workload slug
 * parsed from the current URL, so even a caller that forgets to clear on
 * unmount cannot leak its rail onto a different route.
 *
 * WP-2 registers nothing into this slot — it wires the container only.
 * Reshaping LifecycleStrip's own layout to fit a single non-wrapping row
 * (it currently carries mt-6, wraps, and stacks captions beneath each
 * chip) is WP-3's job, not this module's.
 */
export interface HeaderSlotRailModel {
  steps: Record<FlowStepId, FlowStepState>
  activeStep: FlowStepId
  current: FlowStepId | null
  offFlow: boolean
  lockedReasons: Record<FlowStepId, string>
  jobOwnerLabel: string | null
  jobInFlight: boolean
  onSelect: (step: FlowStepId) => void
}

export interface HeaderSlotPrimaryAction {
  label: string
  onClick: () => void
  disabled?: boolean
  /** Shown (e.g. as a title/tooltip) when disabled — Art. 7/8: a disabled
   *  control states why, it does not just go inert. */
  disabledReason?: string
}

export interface HeaderSlotContent {
  /** The workload slug this content belongs to. */
  slug: string
  rail: HeaderSlotRailModel
  primaryAction?: HeaderSlotPrimaryAction
}

interface HeaderSlotState {
  content: HeaderSlotContent | null
  setHeaderSlot: (content: HeaderSlotContent) => void
  clearHeaderSlot: () => void
}

// NOT exported — see "what is actually enforced" above. useRegisterHeaderSlot
// and useHeaderSlotContent are the only sanctioned read/write paths.
const useHeaderSlotStore = create<HeaderSlotState>((set) => ({
  content: null,
  setHeaderSlot: (content) => set({ content }),
  clearHeaderSlot: () => set({ content: null }),
}))

/**
 * Convenience hook for the route component that owns the slot's state
 * (WP-3: WorkloadDetail). Registers on mount/update, clears on unmount —
 * so navigating away always clears the row even if the caller forgets to,
 * rather than leaving a stale rail for the slug guard above to catch.
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

/** Topbar-only reader. Nothing else needs the raw content. */
export function useHeaderSlotContent(): HeaderSlotContent | null {
  return useHeaderSlotStore((s) => s.content)
}
