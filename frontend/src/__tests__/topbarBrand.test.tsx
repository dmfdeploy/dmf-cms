/**
 * Four Arc 4 WP-2 contracts (umbrella dmfdeploy/dmfdeploy#347) that live in
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
  railModelFromFlow,
  type HeaderSlotContent,
  type HeaderSlotRailModel,
  type HeaderSlotPrimaryAction,
} from '../store/headerSlot'
import type { FlowState, FlowStepId, FlowStepState } from '../lib/workloadFlow'
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

/** Builds a rail model the only sanctioned way — through railModelFromFlow,
 *  never as a hand-built object literal (see the unforgeability describe
 *  block below for what happens when a test tries that anyway). */
function railModel(overrides: { activeStep?: FlowStepId; current?: FlowStepId | null; offFlow?: boolean } = {}): HeaderSlotRailModel {
  const flow: FlowState = {
    current: overrides.current ?? null,
    offFlow: overrides.offFlow ?? false,
    undetermined: false,
    steps: OPEN_STEPS,
  }
  return railModelFromFlow(flow, {
    activeStep: overrides.activeStep ?? 'design',
    lockedReasons: NO_LOCKED_REASONS,
    jobOwnerLabel: null,
    jobInFlight: false,
    onSelect: () => {},
  })
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
    // way other than through railModelFromFlow + useRegisterHeaderSlot —
    // there is no setHeaderSlot / useHeaderSlotStore to reach around it.
    expect('useHeaderSlotStore' in headerSlotModule).toBe(false)
    expect('setHeaderSlot' in headerSlotModule).toBe(false)
    const exported = Object.keys(headerSlotModule).sort()
    expect(exported).toEqual(['railModelFromFlow', 'useHeaderSlotContent', 'useRegisterHeaderSlot'])
  })
})

describe('the rail model is unforgeable — only railModelFromFlow can produce one', () => {
  it('a hand-built object matching every PUBLIC field does not typecheck as HeaderSlotRailModel', () => {
    // @ts-expect-error — HeaderSlotRailModel carries a module-private brand
    // that only railModelFromFlow can attach. This object is structurally
    // complete for every public field, yet must still fail to typecheck;
    // if this stops erroring, the brand has regressed to a plain
    // structural interface. Enforced by `npm run build`'s tsc pass — this
    // include=["src"] project type-checks __tests__ too — not by vitest,
    // which strips types without checking them.
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

  it('copies steps/current/offFlow straight from the classifier-shaped FlowState it is given', () => {
    const flow: FlowState = { current: 'configure', offFlow: false, undetermined: false, steps: OPEN_STEPS }
    const model = railModelFromFlow(flow, {
      activeStep: 'configure',
      lockedReasons: NO_LOCKED_REASONS,
      jobOwnerLabel: null,
      jobInFlight: false,
      onSelect: () => {},
    })
    expect(model.steps).toBe(flow.steps)
    expect(model.current).toBe('configure')
    expect(model.offFlow).toBe(false)
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
      rail: railModel({ activeStep: 'configure', current: 'configure' }),
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
