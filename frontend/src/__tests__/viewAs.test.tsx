/**
 * View-as role switching (dmfdeploy/dmfdeploy#185 WP-B): an admin can
 * simulate a lower role. UI surface lives in Topbar (avatar dropdown control
 * + persistent amber chip); the sidebar follows the effective role.
 *
 * Topbar reads the user from the zustand auth store (App populates it from
 * /api/me), so these tests seed the store directly and render Topbar in
 * isolation. The sidebar test uses useCurrentUser (fed by the /api/me stub),
 * mirroring nav.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Topbar from '../components/Topbar'
import Sidebar from '../components/Sidebar'
import { useAuthStore } from '../store/auth'
import type { UserIdentity } from '../api/types'

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'u1',
    display_name: 'Admin User',
    email: 'admin@dmf.example.com',
    role: 'admin',
    real_role: 'admin',
    view_as_active: false,
    groups: [],
    awx_configured: false,
    authentik_configured: false,
    ...overrides,
  }
}

const fetchMock = vi.fn()

function stubFetch(user: UserIdentity) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    const method = init?.method ?? 'GET'
    let body: unknown = {}
    if (url.endsWith('/api/me') && method === 'GET') body = user
    else if (url.endsWith('/api/me/view-as') && method === 'POST') body = { ...user, view_as_active: true }
    else if (url.endsWith('/api/me/view-as') && method === 'DELETE') body = { ...user, view_as_active: false }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/** Render Topbar with the auth store seeded (as App would after /api/me). */
function renderTopbar(user: UserIdentity) {
  stubFetch(user)
  useAuthStore.setState({ user, isLoading: false })
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>
        <Topbar />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Render Sidebar, which reads the user via useCurrentUser (/api/me stub). */
function renderSidebar(user: UserIdentity) {
  stubFetch(user)
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function viewAsCalls(method: 'POST' | 'DELETE') {
  return fetchMock.mock.calls.filter((call) => {
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined]
    return url.toString().endsWith('/api/me/view-as') && (init?.method ?? 'GET') === method
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  useAuthStore.setState({ user: null, isLoading: true })
})

describe('view-as dropdown control', () => {
  it('is absent for non-admin users', () => {
    renderTopbar(identity({ role: 'operator', real_role: 'operator' }))
    fireEvent.click(screen.getByRole('button', { name: /AU/i }))
    expect(screen.queryByText('View as')).toBeNull()
  })

  it('is present for admin users, offering the three downgrade roles', () => {
    renderTopbar(identity())
    fireEvent.click(screen.getByRole('button', { name: /AU/i }))
    expect(screen.getByText('View as')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'viewer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'operator' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'engineer' })).toBeTruthy()
    // "admin" is never an option — view-as is strictly a downgrade
    expect(screen.queryByRole('button', { name: 'admin' })).toBeNull()
  })
})

describe('account menu — Settings placement (#185 WP-E)', () => {
  it('offers Settings (own prefs) in the avatar dropdown, linking to /settings', () => {
    renderTopbar(identity())
    fireEvent.click(screen.getByRole('button', { name: /AU/i }))
    const settings = screen.getByRole('link', { name: 'Settings' })
    expect(settings.getAttribute('href')).toBe('/settings')
  })
})

describe('amber view-as chip', () => {
  it('renders when active, showing the effective role, with a Reset', () => {
    renderTopbar(identity({ role: 'viewer', real_role: 'admin', view_as_active: true }))
    expect(screen.getByText('Viewing as viewer')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy()
  })

  it('is absent when no view-as is active', () => {
    renderTopbar(identity())
    expect(screen.queryByText(/Viewing as/)).toBeNull()
  })
})

describe('view-as API calls', () => {
  it('POSTs the chosen role to /api/me/view-as', async () => {
    renderTopbar(identity())
    fireEvent.click(screen.getByRole('button', { name: /AU/i }))
    fireEvent.click(screen.getByRole('button', { name: 'viewer' }))
    await waitFor(() => expect(viewAsCalls('POST').length).toBeGreaterThanOrEqual(1))
    const [, init] = viewAsCalls('POST')[0] as [unknown, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ role: 'viewer' })
  })

  it('DELETEs /api/me/view-as when Reset is clicked', async () => {
    renderTopbar(identity({ role: 'viewer', real_role: 'admin', view_as_active: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(viewAsCalls('DELETE').length).toBeGreaterThanOrEqual(1))
  })
})

describe('sidebar follows the effective role', () => {
  it('admin viewing-as viewer sees the viewer nav set (no Catalog, no Admin)', async () => {
    renderSidebar(identity({ role: 'viewer', real_role: 'admin', view_as_active: true }))
    const nav = await screen.findByRole('navigation')
    await within(nav).findByText('Workspace')
    const labels = within(nav).queryAllByRole('link').map((l) => l.textContent)
    expect(labels).toContain('Workspace')
    expect(labels).not.toContain('Catalog')
    expect(labels).not.toContain('Admin')
  })
})
