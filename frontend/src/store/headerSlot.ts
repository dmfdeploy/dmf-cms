import { useLayoutEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { create } from 'zustand'
import {
  classifyWorkloadFlow,
  type FlowState,
  type FlowStepId,
  type FlowStepState,
  type StageCompleteness,
} from '../lib/workloadFlow'
import type { WorkloadLifecycleInput } from '../lib/workloadLifecycle'

/**
 * The typed, route-scoped header slot (umbrella dmfdeploy/dmfdeploy#347 Arc
 * 4 WP-2/WP-3). Topbar renders a second header row beneath the h-14
 * breadcrumb row on workload-detail routes, and only there; WorkloadSetup
 * and WorkloadHome register into it — the route components that already own
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
 *      - classifyWorkloadForHeaderSlot(input, instances) calls
 *        classifyWorkloadFlow once and returns a ClassifiedFlow —
 *        structurally a FlowState (the caller reads
 *        .steps/.current/.offFlow/.undetermined exactly as before) plus a
 *        module-private brand. FIX ROUND (codex gate — P1, the counts):
 *        `instances` is a second, REQUIRED parameter as of that fix — see
 *        point 3 below and the TRUST side table's own docstring for why.
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
 * 3. dmf-cms#391: the run-count readout — BOTH the `trustworthy` flag AND
 *    the `running`/`total` counts themselves — is likewise unforgeable.
 *    Earlier fix rounds only covered `trustworthy`: a first pass put it on
 *    ClassifiedFlow as a public `readonly` field (still forgeable — a spread
 *    copy ignores `readonly`), a second pass moved it into a WeakMap keyed
 *    on the flow's identity (closed for real) — but left `running`/`total`
 *    on RailModelExtras as plain caller-supplied numbers with no formula
 *    behind them at all: a caller holding a genuine, honestly-obtained
 *    `trustworthy: true` flow could STILL pair it with `runningReadout: {
 *    running: 999, total: 1 }` and the rail would print exactly that, no
 *    cast required. FIX ROUND (codex gate — P1, the counts): closed by
 *    storing all three facts together in ONE WeakMap entry, computed
 *    together, in the ONE function that is allowed to write to it —
 *    `classifyWorkloadForHeaderSlot` now takes the workload's raw
 *    `instances` array (the same one buildWorkloadLifecycleInput already
 *    consumes to derive `anyMemberObservedRunning`) and derives
 *    `running`/`total` itself, rather than trusting a parallel channel for
 *    them. RailModelExtras no longer has a `runningReadout` field of any
 *    shape — there is no field left through which a caller could specify a
 *    count, matching or mismatched. See the TRUST side table's own
 *    docstring, right below the brand symbols, for the full account.
 *
 *    The exact guarantee, stated precisely rather than broadly (fix round,
 *    codex gate — precision pass; earlier phrasing here read close to "no
 *    caller can ever cause a wrong count to render", which overclaims):
 *    a rail model produced by buildHeaderSlotRail carries counts derived
 *    from the instances actually given to classifyWorkloadForHeaderSlot,
 *    and — FIX ROUND (codex gate — mutable output): as of this fix, both
 *    `runningReadout` and the rail model itself are `Object.freeze`d before
 *    being returned, so neither field-mutation (`rail.runningReadout.running
 *    = 999`) nor whole-object replacement (`rail.runningReadout = {...}`)
 *    takes effect afterwards either — pinned in topbarBrand.test.tsx by
 *    asserting on the actual RENDERED output after an attempted mutation,
 *    not merely that the object is frozen. That is the whole guarantee.
 *    It is deliberately NOT "no caller can ever cause a wrong count to
 *    render" — two narrower, accepted gaps remain, same register as point
 *    1's own "Honest limit" above:
 *      (a) HeaderSlotRailModel's own brand (RAIL_BRAND) is exactly as
 *          compile-time-only as ClassifiedFlow's readonly field was before
 *          an earlier fix — a caller willing to write `as unknown as
 *          HeaderSlotRailModel` can hand-build a whole rail model, every
 *          field included, and register it directly via
 *          useRegisterHeaderSlot, bypassing buildHeaderSlotRail (and
 *          therefore TRUST, and the freeze) entirely. This one genuinely
 *          does require a deliberate, visible cast to reach — TypeScript's
 *          own error on the unforced attempt is exactly what
 *          topbarBrand.test.tsx's brand-forgery tests pin.
 *      (b) NO CAST NEEDED for this one: classifyWorkloadForHeaderSlot takes
 *          `input` and `instances` as two independent parameters, and
 *          nothing at the type level binds either one to a specific real
 *          workload's identity. A caller that calls it with workload A's
 *          `input` and workload B's `instances` — an ordinary, otherwise
 *          well-typed function call, no cast, no trickery — gets back a
 *          `ClassifiedFlow` whose position facts and count facts genuinely
 *          describe two different workloads, and TRUST stores that
 *          mismatched pairing exactly as trustingly as a consistent one.
 *          Not reachable in practice today (both real call sites pass
 *          `input`/`instances` derived from the SAME `workload` object
 *          already in scope), but nothing enforces that they must.
 *    DECLARED OUT OF SCOPE, not merely unmentioned: LifecycleStrip's own
 *    `runningReadout` PROP being plain and fabricable by a direct component
 *    consumer (e.g. testUtils/HeaderSlotProbe.tsx, or the dev harness, both
 *    of which call classifyWorkloadForHeaderSlot/buildHeaderSlotRail
 *    themselves rather than hand-building props, but nothing stops some
 *    future caller from doing otherwise). A React component's props are not
 *    a trust boundary and cannot be made into one — the guarantee this
 *    module makes is about what buildHeaderSlotRail itself produces, never
 *    about what any arbitrary consumer of LifecycleStrip directly could, in
 *    principle, hand it instead.
 *    All three items above are accepted rather than chased further —
 *    closing (a) or (b) completely means runtime-validating every call site
 *    forever, not a one-time fix, and (c) is categorically not this
 *    module's boundary to enforce — for the same reason the round-4 limit
 *    above is accepted: the CLIENT is affordance control here, never the
 *    authorization boundary; the real one is the server, which this
 *    module's own guarantees were never a substitute for.
 *
 * `slug` guards against a stale registration surviving past the route that
 * owns it — Topbar renders content only when it matches the workload slug
 * parsed from the current URL, so even a caller that forgets to clear on
 * unmount cannot leak its rail onto a different route.
 *
 * `activeChip` names which of the five orchestration stages reads as
 * selected, or none — WorkloadSetup.tsx passes its own wizard selection;
 * WorkloadHome.tsx (dmfdeploy#414, the retired Operate route's successor)
 * always passes `null`, since none of the five stages is what the operator
 * is looking at there regardless of the workload's backend position (that
 * fact is `offFlow`, a separate axis on the underlying FlowState — see
 * lib/workloadFlow.ts's own docstring). `offFlow` still rides along on
 * HeaderSlotRailModel below (a plain passthrough of `flow.offFlow`, read by
 * the dev inspection harness's debug printout) but dmfdeploy#414 removed
 * LifecycleStrip's own use of it: nothing on the five-key rail renders a
 * position for Operate any more, because Operate is no longer a rail entry
 * at all — see that component's own docstring.
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
 * required to typecheck): PromotedAction took arbitrary ReactNode, by
 * design, since it only relocated pixels the stage already built.
 *
 * RETIRED IN TURN (umbrella #518, operator ruling: "redeploy matches
 * creation"). The portal this paragraph describes is itself gone —
 * components/PromotedAction.tsx and store/headerActionSlot.ts are deleted,
 * and ProvisionStage.tsx's Deploy control renders inline unconditionally
 * now. This module (headerSlot.ts) is unaffected — it only ever carried the
 * RAIL model, never the action — so the account above stays accurate as
 * history for why the descriptor-vs-portal choice was made; it just no
 * longer describes anything still shipping.
 */

// Module-private brands — deliberately not exported. TypeScript is
// structurally typed, so without a brand no other module can name, a
// hand-built object matching either type's public fields would satisfy it.
const FLOW_BRAND: unique symbol = Symbol('ClassifiedFlow')
const RAIL_BRAND: unique symbol = Symbol('HeaderSlotRailModel')

/**
 * FIX ROUND (dmf-cms#391, codex gate — P1 RESIDUAL, then P1 the counts): a
 * first pass put `membersDataTrustworthy` on ClassifiedFlow as a public
 * `readonly` field. `readonly` is a COMPILE-TIME-ONLY guarantee — `{
 * ...realFlow, membersDataTrustworthy: true }` still typechecks (object
 * spread doesn't respect the source's readonly-ness on the COPY) and
 * produces a real runtime object with `trustworthy` genuinely forged to
 * `true`. The bar this module sets for itself is "cannot be
 * hand-fabricated", not merely "not casually fabricated" — a public field
 * of any kind, mutable or not, fails that bar, because a value having the
 * field is exactly what a forger needs to succeed.
 *
 * Fixed with a module-private WeakMap side table instead of a second type.
 * Both the trust fact AND the run counts are keyed by OBJECT IDENTITY,
 * entirely off the type system — NOT split across two channels (an earlier
 * version of this fix moved `trustworthy` here but left `running`/`total`
 * as plain caller-supplied numbers on RailModelExtras, which meant a caller
 * holding a genuine `trustworthy: true` flow could still pair it with
 * fabricated counts and have them print unchanged; see this file's own
 * "WHAT IS ACTUALLY ENFORCED" point 3 for the full account of that gap and
 * why storing everything in one entry closes it). `classifyWorkloadForHeaderSlot`
 * is the only function that ever calls `TRUST.set`, on the exact object it
 * is about to return, from the same WorkloadLifecycleInput classifyWorkloadFlow
 * itself consumed PLUS the workload's own instances array. There is no
 * longer a public field on ClassifiedFlow for a forger to set at all, and no
 * separate caller-suppliable count field anywhere — the facts simply aren't
 * reachable through object literal syntax any more. A spread copy (`{
 * ...realFlow }`) is a DIFFERENT object than the one `TRUST.set` was called
 * on, even though it is structurally identical and — since object spread
 * copies symbol keys too — even still satisfies ClassifiedFlow's brand
 * typecheck; its lookup in TRUST simply MISSES, and `buildHeaderSlotRail`
 * reads that miss as "not trustworthy, zero counts". That is the correct
 * failure direction: an object that merely LOOKS like a real
 * classification, however it was obtained, fails closed rather than
 * inheriting whatever the original had. Pinned in topbarBrand.test.tsx: a
 * spread copy, and a hand-built fake cast through `as unknown as
 * ClassifiedFlow`, both yield `trustworthy: false`; and the exact
 * fabrication codex demonstrated (a genuine trustworthy flow paired with a
 * hand-supplied `runningReadout: { running: 999, total: 1 }`) no longer
 * typechecks at all, on either end of the call.
 */
interface TrustedRunningCounts {
  trustworthy: boolean
  running: number
  total: number
}
const TRUST = new WeakMap<object, TrustedRunningCounts>()

export type ClassifiedFlow = FlowState & { readonly [FLOW_BRAND]: true }

/**
 * Phase 1: the only function that can produce a ClassifiedFlow. Calls
 * classifyWorkloadFlow exactly once, and is the ONE place that ever writes
 * to TRUST (see that side table's own docstring above).
 *
 * `instances` is the workload's raw member-instance array — the SAME shape
 * (and, at both real call sites, the literal same array) lib/workloadLifecycle.ts's
 * buildWorkloadLifecycleInput already consumes to derive
 * `anyMemberObservedRunning`. Threaded in here, rather than accepting a
 * pre-computed `running`/`total` from the caller, so this function is the
 * ONE place those numbers are ever computed — closing the gap where a
 * caller-supplied count could disagree with the caller-supplied trust flag
 * (see the TRUST docstring above).
 */
export function classifyWorkloadForHeaderSlot(
  input: WorkloadLifecycleInput,
  instances: { observed_state: string }[],
): ClassifiedFlow {
  const flow = classifyWorkloadFlow(input)
  const classified: ClassifiedFlow = { ...flow, [FLOW_BRAND]: true }
  TRUST.set(classified, {
    trustworthy: input.membersDataTrustworthy ?? false,
    running: instances.filter((i) => i.observed_state === 'running').length,
    total: instances.length,
  })
  return classified
}

export interface HeaderSlotRailModel {
  steps: Record<FlowStepId, FlowStepState>
  /**
   * dmfdeploy#449: per-stage completeness for the rail's dot grammar. Read
   * off the ClassifiedFlow, NOT off RailModelExtras — deliberately, and for
   * the same reason the run counts moved into TRUST. Completeness is a
   * derivation fact, so letting a caller supply it would reopen exactly the
   * gap point 3 above closed for counts: a caller holding a genuine flow
   * could pair it with a hand-written "everything complete" and the rail
   * would paint five filled dots on a workload that had provisioned nothing.
   * There is no field on RailModelExtras through which to try.
   */
  completeness: Record<FlowStepId, StageCompleteness>
  activeChip: FlowStepId | null
  current: FlowStepId | null
  offFlow: boolean
  lockedReasons: Record<FlowStepId, string>
  jobOwnerLabel: string | null
  jobInFlight: boolean
  /** dmf-cms#391 Pass 1: the rail's row-end run-count readout. */
  runningReadout: RailRunningReadout
  onSelect: (step: FlowStepId) => void
  readonly [RAIL_BRAND]: true
}

/**
 * dmf-cms#391 Pass 1: the rail's row-end "N of M running" readout — what
 * LifecycleStrip actually renders. Every field here is DERIVED, never
 * caller-supplied; there is no corresponding "extras" type any more (see
 * FIX ROUND below) — this interface exists purely as buildHeaderSlotRail's
 * output shape and LifecycleStrip's prop type.
 *
 * FIX ROUND (codex gate — P1 blocker): `trustworthy` used to be a plain
 * caller-supplied field, threaded straight through RailModelExtras/
 * buildHeaderSlotRail via `...extras`. Closed by moving it into the TRUST
 * WeakMap (see that side table's own docstring, above the brand symbols).
 *
 * FIX ROUND (codex gate — P1 residual): the WeakMap itself first keyed on a
 * `readonly` field's mistaken belief that `readonly` meant unforgeable — it
 * doesn't (a spread copy ignores it). Fixed by moving trust off any public
 * field entirely and onto WeakMap identity, which a spread copy genuinely
 * cannot reproduce.
 *
 * FIX ROUND (codex gate — P1, the counts): neither earlier round touched
 * `running`/`total` — they stayed on RailModelExtras as plain caller-
 * supplied numbers with no formula behind them, so a caller holding a
 * genuine `trustworthy: true` flow could still pair it with fabricated
 * counts and have them print unchanged. Closed by storing running/total in
 * the SAME TRUST entry as trustworthy, computed together in
 * classifyWorkloadForHeaderSlot from the workload's real instances array —
 * see that function's own docstring. RailModelExtras no longer has a
 * `runningReadout` field of any shape at all (the RailRunningCounts type
 * that used to sit there has been removed outright, not merely emptied) —
 * there is no channel left through which a caller could specify a count,
 * matching or mismatched.
 */
export interface RailRunningReadout {
  running: number
  total: number
  trustworthy: boolean
}

/** Everything a rail model needs beyond classification itself —
 *  presentation/interaction facts the caller already owns directly
 *  (wizard selection or route identity, locked-reason copy, job tracking,
 *  the click/navigate handler), none of which is a lifecycle-derivation
 *  fact. FIX ROUND (codex gate — P1, the counts): `runningReadout` is GONE
 *  from this interface — see RailRunningReadout's own docstring for why a
 *  caller no longer supplies any part of the run-count readout at all. */
export interface RailModelExtras {
  activeChip: FlowStepId | null
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
 *
 * `runningReadout` is built entirely from the TRUST side table now — NOT
 * from `extras` at all, because `extras` (RailModelExtras) no longer has
 * anywhere to carry it. `TRUST.get(flow)` fails closed on a miss (a `flow`
 * this function never saw come out of classifyWorkloadForHeaderSlot — a
 * spread copy, a hand-built fake) to `{ trustworthy: false, running: 0,
 * total: 0 }` — the exact-zero fallback values don't matter functionally
 * (LifecycleStrip never renders running/total when trustworthy is false),
 * they exist only so this function always returns a fully-typed
 * RailRunningReadout.
 *
 * FIX ROUND (codex gate — mutable output): both the returned rail object
 * AND its nested `runningReadout` are `Object.freeze`d before returning.
 * Without this, a caller holding a genuinely-produced rail could still do
 * `rail.runningReadout.running = 999` (field mutation) or
 * `rail.runningReadout = {...}` (whole-object replacement) after the fact,
 * with no cast and no trickery — every guarantee above only covers HOW the
 * object was built, not whether it stays that way once handed back.
 * Freezing both levels closes field-mutation (the nested object) and
 * whole-object replacement (the outer one) in one pass — see
 * topbarBrand.test.tsx for a test that asserts on the actual RENDERED
 * output after an attempted mutation, not merely `Object.isFrozen`.
 */
export function buildHeaderSlotRail(flow: ClassifiedFlow, extras: RailModelExtras): HeaderSlotRailModel {
  const trust = TRUST.get(flow) ?? { trustworthy: false, running: 0, total: 0 }
  const runningReadout = Object.freeze({ running: trust.running, total: trust.total, trustworthy: trust.trustworthy })
  const rail: HeaderSlotRailModel = {
    steps: flow.steps,
    completeness: flow.completeness,
    current: flow.current,
    offFlow: flow.offFlow,
    ...extras,
    runningReadout,
    [RAIL_BRAND]: true,
  }
  return Object.freeze(rail)
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
 * (WorkloadSetup, WorkloadHome). Registers on mount/update, clears on unmount —
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
 * and workloadOperate.test.tsx (74 tests at the time this was measured;
 * dmfdeploy#414 renamed the latter two workloadSetup.test.tsx/
 * workloadHome.test.tsx and both have since gained tests of their own, so
 * this count is a historical snapshot, not a live assertion) fully green.
 * That is not a gap in
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

/**
 * Topbar-only reader (the rail content itself). A gate P1 fix round
 * (umbrella #515) briefly made Shell.tsx a second reader too, to reserve
 * <main>'s own clearance against a `position: fixed` header-slot row — that
 * approach broke at narrow widths (the row's real height varies by wrap,
 * a fixed offset elsewhere couldn't track it) and was replaced by making
 * `<Sidebar/>` the fixed element instead (Shell.tsx's own comment). Shell no
 * longer reads header-slot state of any kind.
 */
export function useHeaderSlotContent(): HeaderSlotContent | null {
  return useHeaderSlotStore((s) => s.content)
}

/**
 * The workload slug parsed from a pathname alone when the route is a
 * workload-detail route (…/:slug or …/:slug/setup, "new" excluded) —
 * otherwise ''. Exported so useShowHeaderSlotRow below and Topbar.tsx's own
 * useBreadcrumbTrail (which additionally needs the facility/workload data
 * fetches breadcrumb LABELS require, which this function deliberately does
 * not do) share this one rule rather than each keeping an independent copy
 * of the same route-shape test — see useShowHeaderSlotRow's own comment for
 * why that specific drift is a repeat of a mistake this file already made
 * once.
 */
export function deriveWorkloadSlugFromPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean)
  return segments[0] === 'media-workloads' && segments[1] && segments[1] !== 'new' ? segments[1] : ''
}

/**
 * Whether Topbar's header-slot row is currently showing — used by Topbar
 * itself to decide whether to render the row at all. umbrella #515, gate
 * P1: a prior version of this fix round ALSO made Shell.tsx a reader (the
 * row was `position: fixed` then, so <main> needed this boolean to know
 * whether to reserve clearance) — that positioning approach was replaced
 * (Shell.tsx's own comment has the full account: the row is back in normal
 * flow, `<Sidebar/>` is the fixed element instead), and Shell no longer
 * needs this value or any other header-slot state. Left exported and
 * separate from `showSlotRow`'s inline use in Topbar anyway, matching
 * `deriveWorkloadSlugFromPath` immediately above: a single caller today
 * doesn't make re-inlining the rule worth the risk of a second copy
 * drifting apart from this one later, the same failure shape this file's
 * own history already has one entry for (see the FIX ROUND note on the
 * deleted `primaryAction` descriptor, above).
 */
export function useShowHeaderSlotRow(): boolean {
  const { pathname } = useLocation()
  const workloadSlug = deriveWorkloadSlugFromPath(pathname)
  const slotContent = useHeaderSlotContent()
  return workloadSlug !== '' && slotContent !== null && slotContent.slug === workloadSlug
}
