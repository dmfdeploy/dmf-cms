/**
 * Two Arc 4 WP-2 contracts (umbrella dmfdeploy/dmfdeploy#347) that live in
 * Topbar.tsx but aren't covered by nav.test.tsx or topbarMessage.test.tsx:
 *
 * 1. Exactly one accessible brand name at a time — the wordmark (Workspace
 *    only) and the logo glyph never both carry the "dmfdeploy" name.
 * 2. The header slot is genuinely ROUTE-scoped, not merely
 *    content-presence-gated: registering content while on a non-workload
 *    route (or under a mismatched slug) must never render row 2. WP-2
 *    registers nothing in production, so this drives the store directly —
 *    the same contract WP-3's real registration will rely on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Topbar from '../components/Topbar'
import { useAuthStore } from '../store/auth'
import { useHeaderSlotStore } from '../store/headerSlot'
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

function renderTopbarAt(path: string) {
  useAuthStore.getState().setUser(identity())
  vi.stubGlobal('fetch', vi.fn(async () => json({})))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Topbar />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAuthStore.getState().setUser(null)
  useHeaderSlotStore.setState({ content: null })
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
    renderTopbarAt('/')
    act(() => {
      useHeaderSlotStore.getState().setHeaderSlot({ slug: 'studio-a', rail: <div>Rail</div> })
    })
    expect(screen.queryByTestId('header-slot-row')).toBeNull()
  })

  it('registering content under a slug that does not match the URL never renders it', () => {
    renderTopbarAt('/media-workloads/studio-a')
    act(() => {
      useHeaderSlotStore.getState().setHeaderSlot({ slug: 'a-different-workload', rail: <div>Rail</div> })
    })
    expect(screen.queryByTestId('header-slot-row')).toBeNull()
  })

  it('renders the registered rail and primary action on the matching workload-detail route', () => {
    renderTopbarAt('/media-workloads/studio-a')
    act(() => {
      useHeaderSlotStore.getState().setHeaderSlot({
        slug: 'studio-a',
        rail: <div data-testid="fake-rail">Rail</div>,
        primaryAction: <button type="button">Deploy</button>,
      })
    })
    const row = screen.getByTestId('header-slot-row')
    expect(row.querySelector('[data-testid="fake-rail"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeTruthy()
  })

  it('also renders on the /operate child route for the same slug', () => {
    renderTopbarAt('/media-workloads/studio-a/operate')
    act(() => {
      useHeaderSlotStore.getState().setHeaderSlot({ slug: 'studio-a', rail: <div>Rail</div> })
    })
    expect(screen.getByTestId('header-slot-row')).toBeTruthy()
  })
})
