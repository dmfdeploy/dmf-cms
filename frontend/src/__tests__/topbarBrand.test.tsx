/**
 * Three Arc 4 WP-2 contracts (umbrella dmfdeploy/dmfdeploy#347) that live in
 * Topbar.tsx/store/headerSlot.ts but aren't covered by nav.test.tsx or
 * topbarMessage.test.tsx:
 *
 * 1. Exactly one accessible brand name at a time — the wordmark (Workspace
 *    only) and the logo glyph never both carry the "dmfdeploy" name.
 * 2. The header slot is genuinely ROUTE-scoped, not merely
 *    content-presence-gated: registering content while on a non-workload
 *    route (or under a mismatched slug) must never render row 2.
 * 3. The module surface enforces "data in, Topbar renders" rather than
 *    merely claiming it (fix round 2, umbrella #347): no raw store setter
 *    is reachable from outside store/headerSlot.ts, and the only way to
 *    register content is useRegisterHeaderSlot with the typed rail MODEL —
 *    there is no way to hand Topbar a pre-rendered node instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Topbar from '../components/Topbar'
import { useAuthStore } from '../store/auth'
import * as headerSlotModule from '../store/headerSlot'
import { useRegisterHeaderSlot, type HeaderSlotContent, type HeaderSlotRailModel } from '../store/headerSlot'
import type { FlowStepId, FlowStepState } from '../lib/workloadFlow'
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

function railModel(overrides: Partial<HeaderSlotRailModel> = {}): HeaderSlotRailModel {
  return {
    steps: OPEN_STEPS,
    activeStep: 'design',
    current: null,
    offFlow: false,
    lockedReasons: NO_LOCKED_REASONS,
    jobOwnerLabel: null,
    jobInFlight: false,
    onSelect: () => {},
    ...overrides,
  }
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
    // way other than through useRegisterHeaderSlot's typed HeaderSlotContent
    // — there is no setHeaderSlot / useHeaderSlotStore to reach around it.
    expect('useHeaderSlotStore' in headerSlotModule).toBe(false)
    expect('setHeaderSlot' in headerSlotModule).toBe(false)
    const exported = Object.keys(headerSlotModule).sort()
    expect(exported).toEqual(['useHeaderSlotContent', 'useRegisterHeaderSlot'])
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

  it('the primary-action button is disabled with a stated reason when the descriptor says so', () => {
    renderTopbarAt('/media-workloads/studio-a', {
      slug: 'studio-a',
      rail: railModel(),
      primaryAction: { label: 'Deploy', onClick: () => {}, disabled: true, disabledReason: 'A job is already running.' },
    })
    const button = screen.getByRole('button', { name: 'Deploy' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('title')).toBe('A job is already running.')
  })
})
