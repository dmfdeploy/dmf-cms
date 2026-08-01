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

  it('keeps the S1-cut surfaces reachable by URL — hidden, not deleted (#285)', async () => {
    // The sidebar cut is a visibility change. Their routes stay registered so
    // the expert lane (and any bookmark) still resolves instead of bouncing
    // home, which is what makes the cut one line each to reverse.
    for (const path of ['/catalog', '/monitoring']) {
      cleanup()
      renderAt(path, identity({ role: 'admin' }))
      await waitFor(() =>
        expect(screen.getByTestId('location').textContent).toBe(path),
      )
    }
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
  it('viewer sees the ungated rails only', async () => {
    renderSidebar(identity({ role: 'viewer' }))
    expect(await visibleLabels()).toEqual(['Workspace', 'Facilities'])
  })

  it('operator gains nothing — Catalog is cut from the sidebar', async () => {
    renderSidebar(identity({ role: 'operator' }))
    expect(await visibleLabels()).toEqual(['Workspace', 'Facilities'])
  })

  it('engineer gains Media Workloads', async () => {
    renderSidebar(identity({ role: 'engineer' }))
    expect(await visibleLabels()).toContain('Media Workloads')
  })

  it('media-engineers group grants Media Workloads without the role', async () => {
    renderSidebar(identity({ role: 'viewer', groups: ['media-engineers'] }))
    const labels = await visibleLabels()
    expect(labels).toContain('Media Workloads')
    // Still a viewer everywhere else — the group grants one surface, not a role.
    expect(labels).not.toContain('Admin')
  })

  it('admin sees everything including Admin', async () => {
    renderSidebar(identity({ role: 'admin' }))
    expect(await visibleLabels()).toEqual([
      'Workspace',
      'Facilities',
      'Media Workloads',
      'Admin',
    ])
  })

  it('shows none of the S1-cut items to any role (#285)', async () => {
    for (const role of ['viewer', 'operator', 'engineer', 'admin'] as const) {
      cleanup()
      renderSidebar(identity({ role, groups: ['media-engineers'] }))
      const labels = await visibleLabels()
      for (const cut of ['Catalog', 'Monitoring', 'Activity']) {
        expect(labels, `${cut} still in sidebar for ${role}`).not.toContain(cut)
      }
    }
  })

  it('never surfaces Settings in the sidebar — it lives in the avatar menu (#185 WP-E)', async () => {
    for (const role of ['viewer', 'operator', 'engineer', 'admin'] as const) {
      cleanup()
      renderSidebar(identity({ role }))
      expect(await visibleLabels()).not.toContain('Settings')
    }
  })
})

// umbrella #286 (operator icon direction, 2026-08-01). Glyphs are asserted by
// their drawn geometry because that is the whole change — a label-only check
// would pass against the icons these replace.
describe('rail glyphs', () => {
  function glyphFor(label: string) {
    const link = screen.getByRole('link', { name: label })
    const svg = link.querySelector('svg')
    if (!svg) throw new Error(`no glyph rendered for ${label}`)
    return svg
  }

  it('Workspace is a 2x2 grid, not the 9-cell one', async () => {
    renderSidebar(identity({ role: 'viewer' }))
    await screen.findByText('Workspace')
    const cells = glyphFor('Workspace').querySelectorAll('rect')
    expect(cells).toHaveLength(4)
  })

  it('Media Workloads carries a media-production glyph, not the clipboard', async () => {
    renderSidebar(identity({ role: 'engineer' }))
    await screen.findByText('Media Workloads')
    const svg = glyphFor('Media Workloads')
    // MonitorSpeaker: a display body plus the speaker cone. The clipboard it
    // replaces was a single path with neither.
    expect(svg.querySelector('rect')).toBeTruthy()
    expect(svg.querySelector('circle')).toBeTruthy()
  })
})
