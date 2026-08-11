import { useEffect } from 'react'
import { create } from 'zustand'
import type { FlowState, FlowStepId, FlowStepState } from '../lib/workloadFlow'

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
 * WHAT IS ACTUALLY ENFORCED, not just claimed (fix round 3 — a plain
 * structural interface and an independently-optional disabledReason both
 * promised guarantees the earlier types did not provide):
 *
 * 1. `rail` is UNFORGEABLE, not merely typed. `HeaderSlotRailModel` carries
 *    a module-private brand; `railModelFromFlow(flow, extras)` below is the
 *    only function anywhere that can produce one, and `flow` is
 *    `classifyWorkloadFlow`'s/`classifyDraftFlow`'s own `FlowState` — this
 *    function copies its `steps`/`current`/`offFlow` straight through
 *    rather than accepting them from `extras`. A caller cannot hand-build a
 *    rail model (pinned by a `@ts-expect-error` case in
 *    topbarBrand.test.tsx — that assignment must fail to typecheck).
 *    Honest limit: `FlowState` itself is a plain structural type owned by
 *    lib/workloadFlow.ts, so a caller could in principle fabricate a
 *    `FlowState` and hand it to `railModelFromFlow`. The brand makes
 *    calling the classifier MANDATORY; it does not make every field of its
 *    input tamper-proof, and this module does not claim otherwise.
 * 2. `primaryAction` is a discriminated union: `disabledReason` is
 *    REQUIRED whenever `disabled` is `true` (fails to typecheck
 *    otherwise — the earlier two-independent-optionals shape let
 *    `{ disabled: true }` through with no reason). Topbar renders the
 *    reason as visible text beside the button, not a hover-only `title` —
 *    reachable by keyboard, touch and screen readers alike (Art. 11: a
 *    disabled control states why, and a tooltip that only fires on hover
 *    does not satisfy that for every input method).
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
// only railModelFromFlow (below) can produce a value assignable to it.
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

/** Everything a rail model needs beyond the classifier's own FlowState —
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
 * The only way to produce a HeaderSlotRailModel. `flow` must be
 * classifyWorkloadFlow's (or classifyDraftFlow's) own output — its
 * steps/current/offFlow are copied through unchanged, so a registered
 * rail's lifecycle facts are provably the classifier's output rather than
 * a hand-built stand-in.
 */
export function railModelFromFlow(flow: FlowState, extras: RailModelExtras): HeaderSlotRailModel {
  return {
    steps: flow.steps,
    current: flow.current,
    offFlow: flow.offFlow,
    ...extras,
    [RAIL_BRAND]: true,
  }
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
