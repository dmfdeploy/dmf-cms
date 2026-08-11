/**
 * Five Arc 4 WP-2 contracts (umbrella dmfdeploy/dmfdeploy#347) that live in
 * Topbar.tsx/store/headerSlot.ts but aren't covered by nav.test.tsx or
 * topbarMessage.test.tsx:
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
 * 4. The rail model is UNFORGEABLE, not merely typed, and a disabled
 *    primary action cannot omit its reason (fix round 3): both are
 *    @ts-expect-error-pinned, and the reason renders as visible text, not
 *    a hover-only title.
 * 5. classifyWorkloadForHeaderSlot takes the workload's raw
 *    WorkloadLifecycleInput, not a FlowState (fix round 4 — round 3's
 *    factory took FlowState directly, so a hand-built FlowState could
 *    still reach a branded model without ever calling classifyWorkloadFlow;
 *    the brand pinned the ceremony, not the provenance). Every fixture in
 *    this file now builds its rail through the real classifier.
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
  type HeaderSlotContent,
  type HeaderSlotRailModel,
  type HeaderSlotPrimaryAction,
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

/** Builds a rail model the only sanctioned way — through
 *  classifyWorkloadForHeaderSlot, fed a real WorkloadLifecycleInput, never
 *  as a hand-built object literal (see the unforgeability describe block
 *  below for what happens when a test tries that anyway). */
function railModel(overrides: { activeStep?: FlowStepId; lifecycle?: WorkloadLifecycle } = {}): HeaderSlotRailModel {
  const { rail } = classifyWorkloadForHeaderSlot(
    { lifecycle: overrides.lifecycle ?? 'provision' },
    { activeStep: overrides.activeStep ?? 'design', ...NOOP_EXTRAS },
  )
  return rail
}

/** The only sanctioned way to register slot content — mirrors how a real
 *  caller (WP-3's WorkloadDetail) uses the hook, rather than reaching into
 *  store internals. */
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
    // useRegisterHeaderSlot — there is no setHeaderSlot / useHeaderSlotStore
    // to reach around it.
    expect('useHeaderSlotStore' in headerSlotModule).toBe(false)
    expect('setHeaderSlot' in headerSlotModule).toBe(false)
    const exported = Object.keys(headerSlotModule).sort()
    expect(exported).toEqual(['classifyWorkloadForHeaderSlot', 'useHeaderSlotContent', 'useRegisterHeaderSlot'])
  })
})

describe('the rail model is unforgeable — only classifyWorkloadForHeaderSlot can produce one', () => {
  it('a hand-built object matching every PUBLIC field does not typecheck as HeaderSlotRailModel', () => {
    // @ts-expect-error — HeaderSlotRailModel carries a module-private brand
    // that only classifyWorkloadForHeaderSlot can attach. This object is
    // structurally complete for every public field, yet must still fail to
    // typecheck; if this stops erroring, the brand has regressed to a
    // plain structural interface. Enforced by `npm run build`'s tsc pass —
    // this project's tsconfig include=["src"] type-checks __tests__ too —
    // not by vitest, which strips types without checking them.
    const forged: HeaderSlotRailModel = {
      steps: OPEN_STEPS,
      activeStep: 'design',
      current: null,
      offFlow: false,
      lockedReasons: NO_LOCKED_REASONS,
      jobOwnerLabel: null,
      jobInFlight: false,
      onSelect: () => {},
    }
    expect(forged.activeStep).toBe('design')
  })

  it('a FlowState-shaped object does not typecheck as the classifier input — only a real WorkloadLifecycleInput does', () => {
    // classifyWorkloadForHeaderSlot's first parameter is
    // WorkloadLifecycleInput (lifecycle, launching, ...), not FlowState
    // (steps, current, offFlow, ...) — the classifier's own OUTPUT shape.
    // Round 3's factory took FlowState directly, so a caller could
    // hand-build one and skip classifyWorkloadFlow entirely; this closes
    // that gap by making the classifier's real input the only thing that
    // typechecks here, not data shaped like what it returns. Declared
    // separately (rather than inline) so the @ts-expect-error below sits
    // on the single line that actually carries the error — TypeScript
    // anchors a multi-line object literal's excess-property diagnostic to
    // the specific property line, not the call's opening line.
    const flowShaped: FlowState = { current: 'configure', offFlow: false, undetermined: false, steps: OPEN_STEPS }
    // @ts-expect-error — see above: flowShaped is FlowState, not WorkloadLifecycleInput.
    const { rail } = classifyWorkloadForHeaderSlot(flowShaped, { activeStep: 'configure', ...NOOP_EXTRAS })
    expect(rail).toBeTruthy()
  })

  it('classifies via the real classifyWorkloadFlow — matches its own direct output for the same input', () => {
    const input: WorkloadLifecycleInput = { lifecycle: 'configure' }
    const direct = classifyWorkloadFlow(input)
    const { flow, rail } = classifyWorkloadForHeaderSlot(input, { activeStep: 'configure', ...NOOP_EXTRAS })
    expect(flow).toEqual(direct)
    expect(rail.steps).toEqual(direct.steps)
    expect(rail.current).toBe(direct.current)
    expect(rail.offFlow).toBe(direct.offFlow)
  })
})

describe('the primary-action descriptor requires a reason whenever disabled is true', () => {
  it('{ disabled: true } with no disabledReason does not typecheck', () => {
    // @ts-expect-error — disabledReason is required when disabled is true
    // (discriminated union, not two independently-optional fields).
    const forged: HeaderSlotPrimaryAction = { label: 'Deploy', onClick: () => {}, disabled: true }
    expect(forged.label).toBe('Deploy')
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
  it('renders the real LifecycleStrip chips from rail data, and the primary action from its descriptor', () => {
    renderTopbarAt('/media-workloads/studio-a', {
      slug: 'studio-a',
      rail: railModel({ activeStep: 'configure', lifecycle: 'configure' }),
      primaryAction: { label: 'Deploy', onClick: () => {} },
    })
    const row = screen.getByTestId('header-slot-row')
    // The five real orchestration chips + Operate, rendered by Topbar from
    // the model — a caller never supplied this markup itself.
    for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']) {
      expect(within(row).getByLabelText(label), `${label} chip missing`).toBeTruthy()
    }
    expect(within(row).getByRole('link', { name: 'Operate' })).toBeTruthy()
    // Topbar owns the button markup — the caller supplied only intent.
    expect(within(row).getByRole('button', { name: 'Deploy' })).toBeTruthy()
  })

  it('a disabled primary action states why as visible text, not a hover-only title', () => {
    renderTopbarAt('/media-workloads/studio-a', {
      slug: 'studio-a',
      rail: railModel(),
      primaryAction: { label: 'Deploy', onClick: () => {}, disabled: true, disabledReason: 'A job is already running.' },
    })
    const button = screen.getByRole('button', { name: 'Deploy' })
    expect(button.hasAttribute('disabled')).toBe(true)
    // Reachable without hovering: a normal text query finds it...
    expect(screen.getByText('A job is already running.')).toBeTruthy()
    // ...and it is not stashed in a title attribute (hover-only, fails
    // keyboard/touch/screen-reader users — Art. 11).
    expect(button.hasAttribute('title')).toBe(false)
  })
})
