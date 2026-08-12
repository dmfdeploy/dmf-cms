/**
 * Sidebar / Activity — useCurrentUser gate honesty (fix-round 6, PR #81,
 * umbrella #385 codex sweep). Both used `user?.role`/`user?.awx_configured`
 * straight off `data`, defaulting to the LEAST-privileged reading whenever
 * `user` was `undefined` — which covers "still loading" and "read failed
 * with nothing ever retained" identically to "genuinely a viewer". Sidebar
 * silently narrowed the icon rail with no explanation; Activity/index.tsx
 * went further and fired a REPLACE redirect off /activity/jobs before the
 * role had a chance to resolve at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Sidebar from '../components/Sidebar'
import Activity from '../pages/Activity/index'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderWithQuery(node: React.ReactNode, initialEntries: string[] = ['/']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Sidebar: role gate never defaults to viewer-only in the operator\'s face without saying why', () => {
  it('holds an admin\'s Admin link once the role read resolves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      subject: 'ops', display_name: 'Ops', email: 'o@x', role: 'admin', real_role: 'admin',
      view_as_active: false, groups: [], awx_configured: true, authentik_configured: true,
    })))
    renderWithQuery(<Sidebar />)
    expect(await screen.findByLabelText('Admin')).toBeTruthy()
  })

  it('a failed read with nothing ever retained shows a visible warning instead of silently going viewer-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    renderWithQuery(<Sidebar />)
    await waitFor(() => expect(screen.queryByLabelText('Admin')).toBeNull())
    expect(
      await screen.findByText(
        'Could not confirm your role — Admin/Media Workloads may be hidden. Reload the page to try again.',
      ),
    ).toBeTruthy()
  })

  it('a genuine viewer sees no warning — the narrowed rail IS correct, not just defaulted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      subject: 'v', display_name: 'V', email: 'v@x', role: 'viewer', real_role: 'viewer',
      view_as_active: false, groups: [], awx_configured: true, authentik_configured: true,
    })))
    renderWithQuery(<Sidebar />)
    await screen.findByLabelText('Workspace')
    expect(screen.queryByLabelText('Admin')).toBeNull()
    expect(screen.queryByText(/Could not confirm your role/)).toBeNull()
  })
})

describe('Activity: the Jobs-lane redirect never fires before the role read has settled', () => {
  function renderActivity(initialEntries: string[]) {
    return renderWithQuery(
      <Routes>
        <Route path="/activity/:lane?" element={<Activity />} />
      </Routes>,
      initialEntries,
    )
  }

  it('a non-viewer landing directly on /activity/jobs on a fresh load stays on Jobs once resolved, never bounced first', async () => {
    const meControl: { resolve: (() => void) | null } = { resolve: null }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) {
          return new Promise<Response>((resolve) => {
            meControl.resolve = () => resolve(json({
              subject: 'eng', display_name: 'Eng', email: 'e@x', role: 'engineer', real_role: 'engineer',
              view_as_active: false, groups: [], awx_configured: true, authentik_configured: true,
            }))
          })
        }
        if (url.endsWith('/api/workflows')) return json({ templates: [] })
        return json({})
      }),
    )
    renderActivity(['/activity/jobs'])

    // While the role read is genuinely in flight, the page must not have
    // already replaced the URL away from Jobs — it shows a neutral loading
    // state instead of deciding blind.
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('No workflows available')).toBeNull()

    meControl.resolve?.()

    // Now that the role is confirmed non-viewer, Jobs renders — the operator
    // was never redirected away from the URL they actually loaded.
    await waitFor(() => expect(screen.getByRole('link', { name: 'Jobs' })).toBeTruthy())
    expect(await screen.findByText('No workflows available')).toBeTruthy()
  })

  it('a genuine viewer IS redirected off /activity/jobs, once the role read actually confirms it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) {
        return json({
          subject: 'v', display_name: 'V', email: 'v@x', role: 'viewer', real_role: 'viewer',
          view_as_active: false, groups: [], awx_configured: true, authentik_configured: true,
        })
      }
      if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: 'awx-unconfigured' })
      if (url.endsWith('/api/changes/commits')) return json({ repos: [], reason: '' })
      if (url.endsWith('/api/changes/pulls')) return json({ pulls: [], reason: '' })
      return json({})
    }))
    renderActivity(['/activity/jobs'])
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Jobs' })).toBeNull())
  })

  it('a settled failed role read on /activity/jobs explains itself rather than silently redirecting away', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return new Response('boom', { status: 500 })
      return json({})
    }))
    renderActivity(['/activity/jobs'])

    expect(
      await screen.findByText(/Could not confirm your role, so the Jobs lane can.t be shown right now\./),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to History' })).toBeTruthy()
  })
})
