/**
 * Workspace AdminPanels IA alignment (PR-D, dmfdeploy/dmfdeploy#243): Users
 * and Workflows are no longer Workspace widgets (IA 2026-06-23 §4.1/§5/§7) —
 * Users moved to the admin secondary rail (pages/Admin.tsx), Workflows to the
 * Activity → Jobs lane. This asserts the cut is discriminating: Integration
 * Status and Infrastructure Services still render, but no Users table and no
 * Workflows panel (Available Templates / Recent Jobs) appear anywhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import AdminPanels from '../pages/Workspace/AdminPanels'
import type { AdminHealthResponse, AppContract, UserIdentity } from '../api/types'

const ADMIN_USER: UserIdentity = {
  subject: 'u1',
  display_name: 'Admin User',
  email: 'admin@dmf.example.com',
  role: 'admin',
  real_role: 'admin',
  view_as_active: false,
  groups: [],
  awx_configured: true,
  authentik_configured: true,
}

const HEALTH: AdminHealthResponse = {
  authentik: { connected: true, user_count: 5 },
  awx: { connected: true, template_count: 2 },
  netbox: { connected: true },
  prometheus: { connected: false, error: 'unreachable' },
}

const CONTRACT: AppContract = {
  product_name: 'DMF',
  facility_name: 'Test Facility',
  catalog_source: 'test',
  apps: [
    { key: 'grafana', display_name: 'Grafana', lane: 'private', summary: '', links: [] },
  ],
}

const fetchMock = vi.fn()

function stubFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    let body: unknown = {}
    if (url.endsWith('/api/me')) body = ADMIN_USER
    else if (url.endsWith('/api/contract')) body = CONTRACT
    else if (url.endsWith('/api/admin/health')) body = HEALTH
    // Deliberately NOT stubbing /api/admin/users, /api/admin/jobs, or
    // /api/workflows: AdminPanels must not call them at all post-cut.
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
}

async function renderAdminPanels() {
  stubFetch()
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AdminPanels />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByText('Grafana')
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('Workspace AdminPanels (post IA cut)', () => {
  it('renders Integration Status and Infrastructure Services', async () => {
    await renderAdminPanels()

    expect(screen.getByText('Integration Status')).toBeTruthy()
    expect(screen.getByText('Authentik')).toBeTruthy()
    expect(screen.getByText('Infrastructure Services')).toBeTruthy()
    expect(screen.getByText('Grafana')).toBeTruthy()
  })

  it('does not render a Users panel or table', async () => {
    await renderAdminPanels()

    expect(screen.queryByRole('heading', { name: 'Users' })).toBeNull()
    expect(screen.queryByText('+ Invite new user')).toBeNull()
    expect(screen.queryByText('Manage DMF Console access and roles')).toBeNull()
  })

  it('does not render a Workflows panel', async () => {
    await renderAdminPanels()

    expect(screen.queryByRole('heading', { name: 'Workflows' })).toBeNull()
    expect(screen.queryByText('Available Templates')).toBeNull()
    expect(screen.queryByText('Recent Jobs')).toBeNull()
  })

  it('never calls the retired admin/users, admin/jobs, or workflows endpoints', async () => {
    await renderAdminPanels()

    const calledUrls = fetchMock.mock.calls.map((call) => {
      const [input] = call as [RequestInfo | URL]
      return (typeof input === 'string' ? input : (input as Request).url).toString()
    })
    expect(calledUrls.some((u) => u.endsWith('/api/admin/users'))).toBe(false)
    expect(calledUrls.some((u) => u.endsWith('/api/admin/jobs'))).toBe(false)
    expect(calledUrls.some((u) => u.includes('/api/workflows'))).toBe(false)
  })
})

// fix-round 5 (PR #81, codex sibling sweep): this component is currently
// unreferenced (see pages/Workspace/index.tsx), but fixed alongside
// Admin.tsx rather than left as a landmine for a future re-wire — see its
// own doc comment.
describe('Workspace AdminPanels — retained-error honesty (fix-round 5)', () => {
  it('a failed contract/user read never gets stuck on "Loading..." forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return new Response(JSON.stringify(ADMIN_USER), { status: 200 })
        if (url.endsWith('/api/contract')) return new Response('boom', { status: 500 })
        return new Response('{}', { status: 200 })
      }),
    )
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <AdminPanels />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Could not be read right now. Reload the page to try again.')).toBeTruthy()
    expect(screen.queryByText('Loading...')).toBeNull()
  })

  it('a failed health read with no data at all names the real cause, never a bare blank grid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return new Response(JSON.stringify(ADMIN_USER), { status: 200 })
        if (url.endsWith('/api/contract')) return new Response(JSON.stringify(CONTRACT), { status: 200 })
        if (url.endsWith('/api/admin/health')) return new Response('boom', { status: 500 })
        return new Response('{}', { status: 200 })
      }),
    )
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <AdminPanels />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Integration status could not be read right now. Retrying automatically.')).toBeTruthy()
    expect(screen.queryByText('Authentik')).toBeNull()
  })
})
