import { useLayoutEffect } from 'react'
import { create } from 'zustand'
import { classifyWorkloadFlow, type FlowState, type FlowStepId, type FlowStepState } from '../lib/workloadFlow'
import type { WorkloadLifecycleInput } from '../lib/workloadLifecycle'

/**
 * The typed, route-scoped header slot (umbrella dmfdeploy/dmfdeploy#347 Arc
 * 4 WP-2/WP-3). Topbar renders a second header row beneath the h-14
 * breadcrumb row on workload-detail routes, and only there; WorkloadDetail
 * and Operate register into it — the route components that already own
 * steps, selection, locked reasons, and job-in-flight state. Topbar itself
 * must never derive that state — lib/workloadLifecycle.ts is the single
 * derivation of "where is this workload", and a second one living in
 * Topbar (or smuggled in through this slot) would defeat that.
 *
 * WHAT IS ACTUALLY ENFORCED, not just claimed:
 *
 * 1. `rail` is UNFORGEABLE, and only classifyWorkloadFlow's real output can
 *    produce one. Classification is a TWO-PHASE, still-single-call-per-page
 *    process, split for a real reason (WP-3): a caller needs the
 *    classifier's own steps/current/offFlow to compute its selection
 *    (activeChip) BEFORE it can build the extras a rail needs — so one
 *    function can't take raw input and the caller's selection in a single
 *    call, and returning a plain FlowState between the phases would reopen
 *    exactly the gap round 4 closed (a hand-built FlowState reaching the
 *    rail without ever calling the classifier).
 *      - classifyWorkloadForHeaderSlot(input) calls classifyWorkloadFlow
 *        once and returns a ClassifiedFlow — structurally a FlowState (the
 *        caller reads .steps/.current/.offFlow/.undetermined exactly as
 *        before) plus a module-private brand.
 *      - buildHeaderSlotRail(flow, extras) accepts ONLY a ClassifiedFlow —
 *        a plain FlowState-shaped object literal does not typecheck here
 *        either, so the two-phase split does not reopen the single-call
 *        version's guarantee. Pinned by @ts-expect-error cases in
 *        topbarBrand.test.tsx, mutation-verified the same way round 4's
 *        pin was.
 *    Honest limit, unchanged from round 4: WorkloadLifecycleInput itself is
 *    a plain structural type, so a caller can still choose what to feed
 *    classifyWorkloadFlow. The brand makes calling the classifier
 *    mandatory; it does not make its input tamper-proof.
 * 2. The raw Zustand store is NOT exported. `useRegisterHeaderSlot` (write)
 *    and `useHeaderSlotContent` (read, Topbar-only) are the entire public
 *    surface — there is no `setHeaderSlot` reachable from outside this
 *    module to bypass any guarantee above.
 *
 * `slug` guards against a stale registration surviving past the route that
 * owns it — Topbar renders content only when it matches the workload slug
 * parsed from the current URL, so even a caller that forgets to clear on
 * unmount cannot leak its rail onto a different route.
 *
 * `activeChip` names which chip (one of the five orchestration stages, or
 * `'operate'`, or none) reads as selected — WorkloadDetail passes its own
 * wizard selection; Operate always passes `'operate'`, since on that route
 * Operate is what the operator is looking at regardless of the workload's
 * backend position (that fact is `offFlow`, a separate axis — see
 * lib/workloadFlow.ts's FlowState docstring). The two must not be
 * conflated: a workload can sit at Operate (offFlow) while the operator
 * has a flow step selected on the detail page, and vice versa is not
 * reachable but the type does not assume it never will be.
 *
 * FIX ROUND (WP-3 spec B gate, P2-1): this module used to also carry a
 * `primaryAction` descriptor (`HeaderSlotPrimaryAction`, a branded
 * discriminated union) plus a matching renderer in Topbar.tsx, built for a
 * simple label/onClick/disabled affordance. Nothing ever produced one — the
 * promoted action WP-3 spec B actually shipped needs the FULL arm/confirm/
 * pending/error loop, which is a portal (components/PromotedAction.tsx,
 * store/headerActionSlot.ts) so the owning stage keeps its own state and
 * mutation, never a data descriptor Topbar would have to re-render generic
 * pixels from. The descriptor was a complete second, unused architecture —
 * a decoy for the next reader, not a fallback — so it is deleted rather
 * than left beside the mechanism that actually ships. The portal does NOT
 * carry the descriptor's type-level guarantee (a disabled control's reason
 * required to typecheck): PromotedAction takes arbitrary ReactNode, by
 * design, since it only relocates pixels the stage already built. The
 * "never a dead control, a disabled action's reason is always visible text"
 * property still holds for the promoted Deploy control — Provision offers
 * it or doesn't (ProvisionStage.tsx's own no-dead-controls comment), and
 * ReasonConfirm's error/pending states are always plain visible text — but
 * that is now a PRODUCER-side property, verified in ProvisionStage's own
 * tests, not something this module's types enforce for whatever portals in.
 */

// Module-private brands — deliberately not exported. TypeScript is
// structurally typed, so without a brand no other module can name, a
// hand-built object matching either type's public fields would satisfy it.
const FLOW_BRAND: unique symbol = Symbol('ClassifiedFlow')
const RAIL_BRAND: unique symbol = Symbol('HeaderSlotRailModel')

export type ClassifiedFlow = FlowState & { readonly [FLOW_BRAND]: true }

/**
 * Phase 1: the only function that can produce a ClassifiedFlow. Calls
 * classifyWorkloadFlow exactly once.
 */
export function classifyWorkloadForHeaderSlot(input: WorkloadLifecycleInput): ClassifiedFlow {
  const flow = classifyWorkloadFlow(input)
  return { ...flow, [FLOW_BRAND]: true }
}

export interface HeaderSlotRailModel {
  steps: Record<FlowStepId, FlowStepState>
  activeChip: FlowStepId | 'operate' | null
  current: FlowStepId | null
  offFlow: boolean
  lockedReasons: Record<FlowStepId, string>
  jobOwnerLabel: string | null
  jobInFlight: boolean
  onSelect: (step: FlowStepId) => void
  readonly [RAIL_BRAND]: true
}

/** Everything a rail model needs beyond classification itself —
 *  presentation/interaction facts the caller already owns directly
 *  (wizard selection or route identity, locked-reason copy, job tracking,
 *  the click/navigate handler), none of which is a lifecycle-derivation
 *  fact. */
export interface RailModelExtras {
  activeChip: FlowStepId | 'operate' | null
  lockedReasons: Record<FlowStepId, string>
  jobOwnerLabel: string | null
  jobInFlight: boolean
  onSelect: (step: FlowStepId) => void
}

/**
 * Phase 2: the only function that can produce a HeaderSlotRailModel. Takes
 * ONLY a ClassifiedFlow (phase 1's output) — a plain FlowState-shaped
 * object literal does not typecheck as the first argument, so splitting
 * classification into two calls does not reopen the gap round 4 closed.
 */
export function buildHeaderSlotRail(flow: ClassifiedFlow, extras: RailModelExtras): HeaderSlotRailModel {
  return {
    steps: flow.steps,
    current: flow.current,
    offFlow: flow.offFlow,
    ...extras,
    [RAIL_BRAND]: true,
  }
}

export interface HeaderSlotContent {
  /** The workload slug this content belongs to. */
  slug: string
  rail: HeaderSlotRailModel
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
 * (WorkloadDetail, Operate). Registers on mount/update, clears on unmount —
 * so navigating away always clears the row even if the caller forgets to,
 * rather than leaving a stale rail for the slug guard above to catch.
 *
 * useLayoutEffect, not useEffect: the registering page and the slot's
 * consumer (Topbar) are separate subtrees now — the rail no longer
 * commits in the SAME render pass as the rest of the page the way it did
 * when LifecycleStrip rendered inline. In a real browser, a layout
 * effect's setState cascades synchronously before paint, so there is no
 * frame where the page's other content is visible but the rail isn't; a
 * passive effect's cascade is only guaranteed to land before the NEXT
 * paint, which leaves a real (if usually brief) in-between frame.
 *
 * FIX ROUND (P3-7): that real-browser guarantee is NOT currently pinned by
 * any test in this suite, and the claim that it was has been made and
 * shown false twice now — aliasing this import to useEffect leaves
 * railRouteContract.test.tsx, topbarBrand.test.tsx, workloadDetail.test.tsx
 * and workloadOperate.test.tsx (74 tests) fully green. That is not a gap in
 * those tests' coverage of THEIR OWN contracts; it is Testing Library's
 * act() intentionally flushing passive effects synchronously as part of
 * settling a render/fireEvent/waitFor, specifically so tests don't have to
 * care about this distinction — which means jsdom+RTL cannot observe the
 * one frame this hook exists to prevent, by design of the tool, not by
 * omission here. No test in this file's own suite claims otherwise as of
 * this fix. useLayoutEffect stays because it is still the correct choice
 * for actual browser paint timing (and costs nothing — this is a
 * purely client-side SPA, no SSR) — kept on that engineering merit alone,
 * not on any test-enforced guarantee.
 */
export function useRegisterHeaderSlot(content: HeaderSlotContent | null) {
  const setHeaderSlot = useHeaderSlotStore((s) => s.setHeaderSlot)
  const clearHeaderSlot = useHeaderSlotStore((s) => s.clearHeaderSlot)

  useLayoutEffect(() => {
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
