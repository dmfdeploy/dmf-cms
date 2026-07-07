/**
 * IA nav spine (#174 WP1/WP4): route migration + role/group-gated sidebar.
 *
 * Redirect tests assert on the router location via a probe, so they hold
 * regardless of what the target page renders. Sidebar tests pin the IA §7
 * role→surface matrix and the media-engineers group consumer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import App from '../App'
import Sidebar from '../components/Sidebar'
import type { UserIdentity } from '../api/types'

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'u1',
    display_name: 'Test User',
    email: 'test@dmf.example.com',
    role: 'viewer',
    real_role: 'viewer',
    view_as_active: false,
    groups: [],
    awx_configured: false,
    authentik_configured: false,
    ...overrides,
  }
}

function stubFetch(user: UserIdentity) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const body = url.toString().endsWith('/api/me') ? user : {}
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderAt(path: string, user: UserIdentity = identity()) {
  stubFetch(user)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('route migration (IA §9)', () => {
  it('serves Workspace at /', async () => {
    renderAt('/')
    expect(await screen.findByRole('heading', { name: 'Workspace' })).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('redirects retired /facility to /facilities', async () => {
    renderAt('/facility')
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/facilities'),
    )
  })

  it('keeps the retired /mxl-flows redirect to /media-workloads', async () => {
    renderAt('/mxl-flows')
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/media-workloads'),
    )
  })

  it('sends unknown paths home', async () => {
    renderAt('/no-such-page')
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/'),
    )
  })

  it('redirects retired /workflows to the Activity Jobs lane', async () => {
    renderAt('/workflows', identity({ role: 'operator' }))
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/activity/jobs'),
    )
  })

  it('redirects retired /changes to the Activity History lane', async () => {
    renderAt('/changes')
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/activity/history'),
    )
  })
})

describe('Activity lanes (IA §5 merge condition)', () => {
  it('defaults operators to the Jobs lane', async () => {
    renderAt('/activity', identity({ role: 'operator' }))
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/activity/jobs'),
    )
  })

  it('defaults viewers to History and keeps them out of Jobs', async () => {
    renderAt('/activity/jobs', identity({ role: 'viewer' }))
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/activity/history'),
    )
    expect(screen.queryByRole('link', { name: 'Jobs' })).toBeNull()
  })

  it('renders both lane tabs for operators', async () => {
    renderAt('/activity/history', identity({ role: 'operator' }))
    expect(await screen.findByRole('link', { name: 'Jobs' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'History' })).toBeTruthy()
  })
})

function renderSidebar(user: UserIdentity) {
  stubFetch(user)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function visibleLabels() {
  const nav = await screen.findByRole('navigation')
  await within(nav).findByText('Workspace')
  return within(nav)
    .queryAllByRole('link')
    .map((link) => link.textContent)
}

describe('sidebar rails + role-gated secondaries (IA §3/§7)', () => {
  it('viewer sees the ungated rails and secondaries only', async () => {
    renderSidebar(identity({ role: 'viewer' }))
    expect(await visibleLabels()).toEqual([
      'Workspace',
      'Facilities',
      'Monitoring',
      'Activity',
    ])
  })

  it('operator gains Catalog', async () => {
    renderSidebar(identity({ role: 'operator' }))
    expect(await visibleLabels()).toEqual([
      'Workspace',
      'Facilities',
      'Catalog',
      'Monitoring',
      'Activity',
    ])
  })

  it('engineer gains Media Workloads', async () => {
    renderSidebar(identity({ role: 'engineer' }))
    expect(await visibleLabels()).toContain('Media Workloads')
  })

  it('media-engineers group grants Media Workloads without the role', async () => {
    renderSidebar(identity({ role: 'viewer', groups: ['media-engineers'] }))
    const labels = await visibleLabels()
    expect(labels).toContain('Media Workloads')
    expect(labels).not.toContain('Catalog')
  })

  it('admin sees everything including Admin', async () => {
    renderSidebar(identity({ role: 'admin' }))
    expect(await visibleLabels()).toEqual([
      'Workspace',
      'Facilities',
      'Media Workloads',
      'Catalog',
      'Monitoring',
      'Activity',
      'Admin',
    ])
  })

  it('never surfaces Settings in the sidebar — it lives in the avatar menu (#185 WP-E)', async () => {
    for (const role of ['viewer', 'operator', 'engineer', 'admin'] as const) {
      cleanup()
      renderSidebar(identity({ role }))
      expect(await visibleLabels()).not.toContain('Settings')
    }
  })
})
