/**
 * Five Arc 4 WP-2/WP-3 contracts (umbrella dmfdeploy/dmfdeploy#347) that
 * live in Topbar.tsx/store/headerSlot.ts but aren't covered by
 * nav.test.tsx or topbarMessage.test.tsx:
 *
 * 1. Exactly one accessible brand name at a time — the wordmark (Workspace
 *    only) and the logo glyph never both carry the "dmfdeploy" name.
 * 2. The header slot is genuinely ROUTE-scoped, not merely
 *    content-presence-gated: registering content while on a non-workload
 *    route (or under a mismatched slug) must never render row 2.
 * 3. The module surface enforces "data in, Topbar renders" rather than
 *    merely claiming it (fix round 2): no raw store setter is reachable
 *    from outside store/headerSlot.ts, and the only way to register
 *    content is useRegisterHeaderSlot with the typed rail MODEL — there
 *    is no way to hand Topbar a pre-rendered node instead.
 * 4. The rail model is UNFORGEABLE (fix round 3), pinned by
 *    @ts-expect-error. (The primary-action descriptor this point used to
 *    also cover — a disabled action's reason required to typecheck — was
 *    deleted in the WP-3 spec B gate's fix round: it had no producer, the
 *    promoted action that shipped is a portal instead. See headerSlot.ts's
 *    own docstring.)
 * 5. classifyWorkloadForHeaderSlot takes the workload's raw
 *    WorkloadLifecycleInput, not a FlowState (fix round 4). Classification
 *    is a two-phase call — classifyWorkloadForHeaderSlot
 *    (input -> ClassifiedFlow) then buildHeaderSlotRail (ClassifiedFlow +
 *    extras -> HeaderSlotRailModel) — split for WP-3 (a caller needs the
 *    classifier's own steps/current/offFlow to compute its selection
 *    before it can build a rail), and buildHeaderSlotRail's first
 *    argument is exactly as unforgeable as round 4's single-call
 *    factory was: a plain FlowState-shaped object does not typecheck
 *    there either. Every fixture in this file builds its rail through
 *    both real calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Topbar from '../components/Topbar'
import { useAuthStore } from '../store/auth'
import * as headerSlotModule from '../store/headerSlot'
import {
  useRegisterHeaderSlot,
  classifyWorkloadForHeaderSlot,
  buildHeaderSlotRail,
  type ClassifiedFlow,
  type HeaderSlotContent,
  type HeaderSlotRailModel,
} from '../store/headerSlot'
import { classifyWorkloadFlow } from '../lib/workloadFlow'
import type { FlowState, FlowStepId, FlowStepState } from '../lib/workloadFlow'
import type { WorkloadLifecycle, WorkloadLifecycleInput } from '../lib/workloadLifecycle'
import type { UserIdentity } from '../api/types'

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'engineer',
    real_role: 'engineer',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const OPEN_STEPS: Record<FlowStepId, FlowStepState> = {
  design: 'open',
  plan: 'open',
  provision: 'open',
  configure: 'open',
  finalise: 'open',
}

const NO_LOCKED_REASONS: Record<FlowStepId, string> = {
  design: '',
  plan: '',
  provision: '',
  configure: '',
  finalise: '',
}

const NOOP_EXTRAS = {
  lockedReasons: NO_LOCKED_REASONS,
  jobOwnerLabel: null,
  jobInFlight: false,
  onSelect: () => {},
}

// FIX ROUND (dmf-cms#391, codex gate — P1, the counts): RailModelExtras no
// longer has a runningReadout field of any kind — NOOP_EXTRAS above dropped
// it entirely, and classifyWorkloadForHeaderSlot now takes the workload's
// raw instances directly as its own second argument instead. This fixture
// stands in for that array everywhere in this file that doesn't care about
// the specific count.
const NOOP_INSTANCES: { observed_state: string }[] = [{ observed_state: 'running' }]

/** Builds a rail model the only sanctioned way — classifyWorkloadForHeaderSlot
 *  then buildHeaderSlotRail, fed a real WorkloadLifecycleInput (and
 *  instances array), never a hand-built object literal (see the
 *  unforgeability describe block below for what happens when a test tries
 *  that anyway). */
function railModel(overrides: { activeChip?: FlowStepId | 'operate'; lifecycle?: WorkloadLifecycle } = {}): HeaderSlotRailModel {
  const flow = classifyWorkloadForHeaderSlot({ lifecycle: overrides.lifecycle ?? 'provision' }, NOOP_INSTANCES)
  return buildHeaderSlotRail(flow, { activeChip: overrides.activeChip ?? 'design', ...NOOP_EXTRAS })
}

/** The only sanctioned way to register slot content — mirrors how a real
 *  caller (WorkloadDetail/Operate) uses the hook, rather than reaching
 *  into store internals. */
function SlotRegistrar({ content }: { content: HeaderSlotContent | null }) {
  useRegisterHeaderSlot(content)
  return null
}

function renderTopbarAt(path: string, slotContent: HeaderSlotContent | null = null) {
  useAuthStore.getState().setUser(identity())
  vi.stubGlobal('fetch', vi.fn(async () => json({})))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Topbar />
        <SlotRegistrar content={slotContent} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  // Unmounting SlotRegistrar runs useRegisterHeaderSlot's cleanup, which
  // clears the store itself — no manual store reset needed (and none is
  // possible from outside the module; see the module-surface tests below).
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAuthStore.getState().setUser(null)
})

describe('exactly one accessible brand name at a time', () => {
  it('on Workspace: the wordmark is visible and the glyph is decorative', () => {
    renderTopbarAt('/')
    expect(screen.getByText('dmfdeploy')).toBeTruthy()
    // alt="" removes the <img> from the accessibility tree as a named
    // image (it exposes role "presentation"/"none" instead) — getByRole
    // would find nothing to match a "dmfdeploy"-named image here.
    expect(screen.queryByAltText('dmfdeploy')).toBeNull()
    expect(screen.queryByRole('img', { name: 'dmfdeploy' })).toBeNull()
  })

  it('off Workspace: the glyph is named and no visible wordmark text renders', () => {
    renderTopbarAt('/facilities')
    expect(screen.getByRole('img', { name: 'dmfdeploy' })).toBeTruthy()
    expect(screen.queryByText('dmfdeploy')).toBeNull()
  })
})

describe('the header slot module surface enforces its guarantees, not just claims them', () => {
  it('does not export a raw store setter or the store hook itself', () => {
    // A caller with only these exports cannot register a rail computed any
    // way other than through classifyWorkloadForHeaderSlot +
    // buildHeaderSlotRail + useRegisterHeaderSlot — there is no
    // setHeaderSlot / useHeaderSlotStore to reach around it.
    expect('useHeaderSlotStore' in headerSlotModule).toBe(false)
    expect('setHeaderSlot' in headerSlotModule).toBe(false)
    const exported = Object.keys(headerSlotModule).sort()
    expect(exported).toEqual([
      'buildHeaderSlotRail',
      'classifyWorkloadForHeaderSlot',
      'useHeaderSlotContent',
      'useRegisterHeaderSlot',
    ])
  })
})

describe('the rail model is unforgeable — only buildHeaderSlotRail can produce one', () => {
  it('a hand-built object matching every PUBLIC field does not typecheck as HeaderSlotRailModel', () => {
    // @ts-expect-error — HeaderSlotRailModel carries a module-private brand
    // that only buildHeaderSlotRail can attach. This object is
    // structurally complete for every public field, yet must still fail to
    // typecheck; if this stops erroring, the brand has regressed to a
    // plain structural interface. Enforced by `npm run build`'s tsc pass —
    // this project's tsconfig include=["src"] type-checks __tests__ too —
    // not by vitest, which strips types without checking them.
    //
    // FIX ROUND (codex gate, P1b): this object used to OMIT runningReadout
    // entirely, which became a required field when dmf-cms#391 added it —
    // meaning the @ts-expect-error was satisfied by "runningReadout is
    // missing", not by the brand, and would have stayed green even with the
    // brand deleted outright. Mutation-verified (see the PR description):
    // temporarily removed `readonly [RAIL_BRAND]: true` from
    // HeaderSlotRailModel in store/headerSlot.ts, ran `tsc --noEmit`, and
    // confirmed the error on this exact line disappeared (the object below
    // is now genuinely structurally complete for every OTHER field) —
    // restored immediately after.
    const forged: HeaderSlotRailModel = {
      steps: OPEN_STEPS,
      activeChip: 'design',
      current: null,
      offFlow: false,
      lockedReasons: NO_LOCKED_REASONS,
      jobOwnerLabel: null,
      jobInFlight: false,
      runningReadout: { running: 1, total: 1, trustworthy: true },
      onSelect: () => {},
    }
    expect(forged.activeChip).toBe('design')
  })

  it('a hand-built object matching FlowState does not typecheck as ClassifiedFlow — buildHeaderSlotRail\'s own input is just as unforgeable as the single-call factory round 4 pinned', () => {
    // classifyWorkloadForHeaderSlot is the only function that can produce a
    // ClassifiedFlow; buildHeaderSlotRail accepts ONLY that branded type,
    // not a plain FlowState. Splitting classification into two calls for
    // WP-3 does not reopen round 4's gap: a hand-built FlowState still
    // cannot reach a rail model, it just fails one call earlier now.
    const flowShaped: FlowState = { current: 'configure', offFlow: false, undetermined: false, steps: OPEN_STEPS }
    // @ts-expect-error — flowShaped is FlowState, not ClassifiedFlow.
    const rail = buildHeaderSlotRail(flowShaped, { activeChip: 'configure', ...NOOP_EXTRAS })
    expect(rail).toBeTruthy()
  })

  it('classifies via the real classifyWorkloadFlow — matches its own direct output for the same input', () => {
    const input: WorkloadLifecycleInput = { lifecycle: 'configure' }
    const direct = classifyWorkloadFlow(input)
    const flow: ClassifiedFlow = classifyWorkloadForHeaderSlot(input, NOOP_INSTANCES)
    const rail = buildHeaderSlotRail(flow, { activeChip: 'configure', ...NOOP_EXTRAS })
    expect(flow.steps).toEqual(direct.steps)
    expect(flow.current).toBe(direct.current)
    expect(flow.offFlow).toBe(direct.offFlow)
    expect(rail.steps).toEqual(direct.steps)
    expect(rail.current).toBe(direct.current)
    expect(rail.offFlow).toBe(direct.offFlow)
  })
})

// NEW (dmf-cms#391, codex gate — P1 fix, then P1 RESIDUAL, then P1 the
// counts, then mutable output): four rounds of the same lesson, on the run-
// count readout's `trustworthy` flag and its running/total NUMBERS.
//
// THE PRECISE GUARANTEE THIS BLOCK PROVES, stated narrowly on purpose (fix
// round, codex gate — precision pass; an earlier version of this comment
// said "from ANY caller-suppliable channel at all", which overclaims): a
// rail model produced by buildHeaderSlotRail carries counts derived from
// the instances actually given to classifyWorkloadForHeaderSlot, and
// cannot be altered afterwards. It is NOT "no caller can ever cause a
// wrong count to render" — headerSlot.ts's own docstring documents two
// narrower, accepted gaps this suite does not chase (a brand-cast escape
// hatch; classifyWorkloadForHeaderSlot's input/instances pairing not being
// bound to a single workload identity) and one thing categorically out of
// scope (LifecycleStrip's own component props are not a trust boundary).
//
// The four rounds: the first fix closed the `extras.runningReadout.trustworthy`
// seam; it left `trustworthy` as a public `readonly` field on
// ClassifiedFlow, which a spread copy could still override despite
// `readonly` — closed for real with the module-private TRUST WeakMap. That
// WeakMap then only stored `trustworthy` — `running`/`total` stayed on
// RailModelExtras as plain caller-supplied numbers with NO formula behind
// them at all, so a caller holding a genuine `trustworthy: true` flow could
// still pair it with `runningReadout: { running: 999, total: 1 }` and the
// rail would print exactly that. Closed by moving running/total into the
// SAME TRUST entry, computed together from a real `instances` array
// classifyWorkloadForHeaderSlot now requires as its second argument. Then:
// even a genuinely-produced rail was plain, mutable JS — `rail.runningReadout.running
// = 999` after the fact took effect with no cast at all. Closed by
// Object.freeze on both the rail and its nested runningReadout — see
// headerSlot.ts's own docstring for the full four-round account.
describe('the run-count readout — trustworthy AND the counts themselves — is derived from the classification, not from extras, cannot be fabricated by identity tricks, and cannot be mutated afterwards', () => {
  it('rail.runningReadout.trustworthy matches the input the REAL classifier consumed, both true and false', () => {
    const trustworthyFlow = classifyWorkloadForHeaderSlot({ lifecycle: 'configure', membersDataTrustworthy: true }, NOOP_INSTANCES)
    const untrustworthyFlow = classifyWorkloadForHeaderSlot({ lifecycle: 'configure', membersDataTrustworthy: false }, NOOP_INSTANCES)
    const railA = buildHeaderSlotRail(trustworthyFlow, { activeChip: 'configure', ...NOOP_EXTRAS })
    const railB = buildHeaderSlotRail(untrustworthyFlow, { activeChip: 'configure', ...NOOP_EXTRAS })
    expect(railA.runningReadout.trustworthy).toBe(true)
    expect(railB.runningReadout.trustworthy).toBe(false)
  })

  // NEW (codex gate — P1, the counts): this is the actual reproduction of
  // the hole codex found — a genuine, honestly-obtained trustworthy flow,
  // with fabricated running/total numbers attached alongside it. Proves the
  // rendered count tracks the REAL instances fed to the classifier, not
  // anything a caller could separately specify.
  it('the rendered running/total tracks the instances actually fed to the classifier — there is no other channel for a count', () => {
    const instances = [
      { observed_state: 'running' },
      { observed_state: 'running' },
      { observed_state: 'failing' },
    ]
    const flow = classifyWorkloadForHeaderSlot({ lifecycle: 'configure', membersDataTrustworthy: true }, instances)
    const rail = buildHeaderSlotRail(flow, { activeChip: 'configure', ...NOOP_EXTRAS })
    expect(rail.runningReadout.running).toBe(2)
    expect(rail.runningReadout.total).toBe(3)
  })

  it('the exact fabrication codex demonstrated no longer typechecks, on either end of the call', () => {
    expect(() => {
      // @ts-expect-error — classifyWorkloadForHeaderSlot now requires an
      // `instances` second argument; this is the exact single-argument call
      // the original fabrication relied on to obtain a genuine trustworthy
      // flow with no instances bound to it at all. Wrapped in expect().toThrow()
      // rather than left bare: the JS itself still runs despite the
      // suppressed type error, and with no instances array to filter, it
      // throws — an incidental but confirming second signal that there is
      // truly nothing left to call this way, not just a type-checker
      // complaint.
      classifyWorkloadForHeaderSlot({ lifecycle: 'configure', membersDataTrustworthy: true })
    }).toThrow()

    const flow = classifyWorkloadForHeaderSlot({ lifecycle: 'configure', membersDataTrustworthy: true }, NOOP_INSTANCES)
    expect(() => {
      // @ts-expect-error — RailModelExtras no longer declares a
      // runningReadout field of any shape; this is the exact fabricated
      // `{ running: 999, total: 1 }` extras object the original hole
      // permitted with no cast at all. There is no field left to attach it
      // to, so this is a genuine excess-property error, not a suppressed
      // runtime concern — the call below still runs (extra properties on an
      // object literal are ignored at runtime once past the type checker)
      // and simply has no effect on the result.
      buildHeaderSlotRail(flow, { activeChip: 'configure', ...NOOP_EXTRAS, runningReadout: { running: 999, total: 1 } })
    }).not.toThrow()
  })

  // NEW (codex gate, P1 residual): a spread copy of a real, trustworthy
  // ClassifiedFlow. This is deliberately NOT a @ts-expect-error case —
  // object spread copies symbol-keyed properties same as string-keyed ones,
  // so `{ ...flow }` still genuinely satisfies ClassifiedFlow's brand
  // typecheck. That is exactly why a public field (even readonly) was the
  // wrong mechanism: the type system cannot tell "the real object" apart
  // from "a structurally-identical copy of it" — only reference identity
  // can, which is what the TRUST WeakMap keys on. Covers both trustworthy
  // AND the counts, since the counts fix moved them into the SAME entry.
  it('a spread copy of a real, trustworthy ClassifiedFlow fails closed to untrustworthy with a zero count — copying is not the same object', () => {
    const flow = classifyWorkloadForHeaderSlot({ lifecycle: 'configure', membersDataTrustworthy: true }, [
      { observed_state: 'running' },
      { observed_state: 'running' },
    ])
    const spreadCopy: ClassifiedFlow = { ...flow }
    const rail = buildHeaderSlotRail(spreadCopy, { activeChip: 'configure', ...NOOP_EXTRAS })
    expect(rail.runningReadout.trustworthy).toBe(false)
    expect(rail.runningReadout.running).toBe(0)
    expect(rail.runningReadout.total).toBe(0)
  })

  // NEW (codex gate, P1 residual): a wholly hand-built fake, forced through
  // the type system with `as unknown as ClassifiedFlow` — the type-level
  // brand check is bypassed entirely here on purpose, simulating a caller
  // willing to lie to the compiler outright. Still fails closed, because
  // TRUST.get on an object it never wrote returns undefined regardless of
  // what TypeScript was told to believe about that object's type.
  it('a hand-built fake forced through the type system also fails closed to untrustworthy with a zero count', () => {
    const fake = {
      steps: OPEN_STEPS,
      current: null,
      offFlow: false,
      undetermined: false,
    } as unknown as ClassifiedFlow
    const rail = buildHeaderSlotRail(fake, { activeChip: 'configure', ...NOOP_EXTRAS })
    expect(rail.runningReadout.trustworthy).toBe(false)
    expect(rail.runningReadout.running).toBe(0)
    expect(rail.runningReadout.total).toBe(0)
  })

  // NEW (codex gate — mutable output): a rail model is plain JS once built;
  // nothing stopped a caller from mutating it after the fact, with no cast
  // and no identity trickery at all — `rail.runningReadout.running = 999`
  // typechecked and took effect. Proves the fix at the level that actually
  // matters: what RENDERS, not merely that Object.isFrozen(rail) is true
  // (a mechanism check a reader would still have to trust actually mattered).
  it('mutating a built rail model — either the nested readout or the whole object — throws, and the RENDERED output never reflects the attempt', () => {
    const flow = classifyWorkloadForHeaderSlot({ lifecycle: 'configure', membersDataTrustworthy: true }, [
      { observed_state: 'running' },
    ])
    const rail = buildHeaderSlotRail(flow, { activeChip: 'configure', ...NOOP_EXTRAS })

    // Both mutation shapes throw — frozen at both levels, per
    // buildHeaderSlotRail's own docstring.
    expect(() => {
      ;(rail.runningReadout as { running: number }).running = 999
    }).toThrow()
    expect(() => {
      ;(rail as { runningReadout: unknown }).runningReadout = { running: 999, total: 1, trustworthy: true }
    }).toThrow()

    // The real proof: render it, exactly as Topbar does, and confirm the
    // ORIGINAL derived count is what a real operator would actually see —
    // not "999", and not merely "the object claims to be frozen".
    renderTopbarAt('/media-workloads/studio-a', { slug: 'studio-a', rail })
    const row = screen.getByTestId('header-slot-row')
    expect(within(row).getByText('1 of 1 running', { exact: false })).toBeTruthy()
    expect(within(row).queryByText('999', { exact: false })).toBeNull()
  })
})

describe('the header slot is absent on every non-workload-detail route', () => {
  it.each(['/', '/facilities', '/facilities/site-1', '/media-workloads', '/media-workloads/new', '/admin'])(
    'renders no header-slot-row at %s',
    (path) => {
      renderTopbarAt(path)
      expect(screen.queryByTestId('header-slot-row')).toBeNull()
    },
  )
})

describe('the header slot is genuinely route-scoped, not just content-presence-gated', () => {
  it('registering content while on a non-workload route never renders it', () => {
    renderTopbarAt('/', { slug: 'studio-a', rail: railModel() })
    expect(screen.queryByTestId('header-slot-row')).toBeNull()
  })

  it('registering content under a slug that does not match the URL never renders it', () => {
    renderTopbarAt('/media-workloads/studio-a', { slug: 'a-different-workload', rail: railModel() })
    expect(screen.queryByTestId('header-slot-row')).toBeNull()
  })

  it('also renders on the /operate child route for the same slug', () => {
    renderTopbarAt('/media-workloads/studio-a/operate', { slug: 'studio-a', rail: railModel() })
    expect(screen.getByTestId('header-slot-row')).toBeTruthy()
  })
})

describe('the rail is rendered from the registered MODEL, not an injected node', () => {
  it('renders the real LifecycleStrip chips from rail data', () => {
    renderTopbarAt('/media-workloads/studio-a', {
      slug: 'studio-a',
      rail: railModel({ activeChip: 'configure', lifecycle: 'configure' }),
    })
    const row = screen.getByTestId('header-slot-row')
    // The five real orchestration chips + Operate, rendered by Topbar from
    // the model — a caller never supplied this markup itself.
    for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']) {
      expect(within(row).getByLabelText(label), `${label} chip missing`).toBeTruthy()
    }
    expect(within(row).getByRole('link', { name: 'Operate' })).toBeTruthy()
  })
})
