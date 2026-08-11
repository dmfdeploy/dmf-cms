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

/** Builds a rail model the only sanctioned way — classifyWorkloadForHeaderSlot
 *  then buildHeaderSlotRail, fed a real WorkloadLifecycleInput, never a
 *  hand-built object literal (see the unforgeability describe block below
 *  for what happens when a test tries that anyway). */
function railModel(overrides: { activeChip?: FlowStepId | 'operate'; lifecycle?: WorkloadLifecycle } = {}): HeaderSlotRailModel {
  const flow = classifyWorkloadForHeaderSlot({ lifecycle: overrides.lifecycle ?? 'provision' })
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
    const forged: HeaderSlotRailModel = {
      steps: OPEN_STEPS,
      activeChip: 'design',
      current: null,
      offFlow: false,
      lockedReasons: NO_LOCKED_REASONS,
      jobOwnerLabel: null,
      jobInFlight: false,
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
    const flow: ClassifiedFlow = classifyWorkloadForHeaderSlot(input)
    const rail = buildHeaderSlotRail(flow, { activeChip: 'configure', ...NOOP_EXTRAS })
    expect(flow.steps).toEqual(direct.steps)
    expect(flow.current).toBe(direct.current)
    expect(flow.offFlow).toBe(direct.offFlow)
    expect(rail.steps).toEqual(direct.steps)
    expect(rail.current).toBe(direct.current)
    expect(rail.offFlow).toBe(direct.offFlow)
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
