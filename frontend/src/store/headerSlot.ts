import { useEffect } from 'react'
import { create } from 'zustand'
import { classifyWorkloadFlow, type FlowState, type FlowStepId, type FlowStepState } from '../lib/workloadFlow'
import type { WorkloadLifecycleInput } from '../lib/workloadLifecycle'

/**
 * The typed, route-scoped header slot (umbrella dmfdeploy/dmfdeploy#347 Arc
 * 4 WP-2). Topbar renders a second header row beneath the h-14 breadcrumb
 * row on workload-detail routes, and only there; WP-3 registers into it
 * from WorkloadDetail — the route component that already owns steps,
 * selection, locked reasons, and job-in-flight state. Topbar itself must
 * never derive that state — lib/workloadLifecycle.ts is the single
 * derivation of "where is this workload", and a second one living in
 * Topbar (or smuggled in through this slot) would defeat that.
 *
 * WHAT IS ACTUALLY ENFORCED, not just claimed (fix round 4 — round 3's
 * brand made hand-BUILDING a rail model impossible, but not hand-building
 * the FlowState fed into the factory that minted it: FlowState was, and
 * still is, a plain structural type, so a caller could fabricate one and
 * pass it through unchanged. That is the same defect one level deeper —
 * the earlier fix pinned the CEREMONY of going through a factory, not the
 * PROVENANCE of the data the factory used):
 *
 * 1. `rail` is UNFORGEABLE, and now for the property that actually matters:
 *    classifyWorkloadForHeaderSlot is the only function that can produce a
 *    HeaderSlotRailModel, AND it is the only place classifyWorkloadFlow is
 *    called for this purpose — it takes the workload's raw
 *    WorkloadLifecycleInput, not a FlowState, so no FlowState (real or
 *    fabricated) ever crosses the boundary from outside. Classification
 *    happens exactly once; the function returns both the FlowState the
 *    page needs for its own rendering and the branded rail model for the
 *    slot, so nothing calls classifyWorkloadFlow a second time. Pinned by
 *    a `@ts-expect-error` case in topbarBrand.test.tsx asserting that a
 *    hand-built model fails to typecheck — mutation-verified: removing
 *    the brand, or reopening a FlowState-shaped parameter, makes that
 *    directive go unused and `npm run build`'s tsc pass fails.
 * 2. `primaryAction` is a discriminated union: `disabledReason` is
 *    REQUIRED whenever `disabled` is `true` (fails to typecheck
 *    otherwise). Topbar renders the reason as visible text beside the
 *    button, not a hover-only `title` — reachable by keyboard, touch and
 *    screen readers alike (Art. 11).
 * 3. The raw Zustand store is NOT exported. `useRegisterHeaderSlot` (write)
 *    and `useHeaderSlotContent` (read, Topbar-only) are the entire public
 *    surface — there is no `setHeaderSlot` reachable from outside this
 *    module to bypass any guarantee above.
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

// Module-private brand — deliberately not exported. TypeScript is
// structurally typed, so without a brand that no other module can name, a
// hand-built object matching HeaderSlotRailModel's public fields would
// satisfy the type. Only code in this file can reference RAIL_BRAND, so
// only classifyWorkloadForHeaderSlot (below) can produce a value
// assignable to it.
const RAIL_BRAND: unique symbol = Symbol('HeaderSlotRailModel')

export interface HeaderSlotRailModel {
  steps: Record<FlowStepId, FlowStepState>
  activeStep: FlowStepId
  current: FlowStepId | null
  offFlow: boolean
  lockedReasons: Record<FlowStepId, string>
  jobOwnerLabel: string | null
  jobInFlight: boolean
  onSelect: (step: FlowStepId) => void
  readonly [RAIL_BRAND]: true
}

/** Everything a rail model needs beyond classification itself —
 *  presentation/interaction facts WorkloadDetail already owns directly
 *  (wizard selection, locked-reason copy, job tracking, the click handler),
 *  none of which is a lifecycle-derivation fact. */
export interface RailModelExtras {
  activeStep: FlowStepId
  lockedReasons: Record<FlowStepId, string>
  jobOwnerLabel: string | null
  jobInFlight: boolean
  onSelect: (step: FlowStepId) => void
}

/**
 * The single entry point from a workload's raw lifecycle input to both the
 * FlowState the page needs for its own rendering (which step is openable,
 * what the position is, ...) and the branded rail model the header slot
 * accepts. Takes `WorkloadLifecycleInput`, NOT `FlowState` — classification
 * happens exactly once, inside this function, so no FlowState, real or
 * fabricated, ever crosses the module boundary from outside. That is what
 * makes calling classifyWorkloadFlow itself mandatory, not merely calling
 * this function with data shaped like its output.
 */
export function classifyWorkloadForHeaderSlot(
  input: WorkloadLifecycleInput,
  extras: RailModelExtras,
): { flow: FlowState; rail: HeaderSlotRailModel } {
  const flow = classifyWorkloadFlow(input)
  const rail: HeaderSlotRailModel = {
    steps: flow.steps,
    current: flow.current,
    offFlow: flow.offFlow,
    ...extras,
    [RAIL_BRAND]: true,
  }
  return { flow, rail }
}

export type HeaderSlotPrimaryAction =
  | { label: string; onClick: () => void; disabled?: false }
  | {
      label: string
      onClick: () => void
      disabled: true
      /** Rendered as visible text beside the button — Art. 11 requires a
       *  disabled control's reason to be reachable without hovering. */
      disabledReason: string
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
