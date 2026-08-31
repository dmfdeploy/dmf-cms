/**
 * dmfdeploy/dmfdeploy#481, FIX ROUND (orchestrator/codex gate). The lifecycle
 * rail must not be a descendant of the top bar's `banner` landmark.
 *
 * WHY. `Topbar.tsx` renders `<header>` as a direct child of a plain `<div>`
 * (`Shell.tsx` — confirmed on the live tree, not assumed: no article, aside,
 * main, nav or section ancestor sits between them) — the HTML/ARIA mapping
 * for a `<header>` in that ancestry is the implicit `banner` role. `banner`
 * is for site-oriented content repeated across most pages (logo, primary
 * nav, search); the lifecycle rail is route-specific (`showSlotRow` gates it
 * to workload-detail routes only, confirmed by railRouteContract.test.tsx's
 * own contract). Before this fix a screen-reader user landing on a workload
 * page found a per-workload lifecycle rail announced inside "banner" — this
 * file pins that it no longer is.
 *
 * This is an App/Shell integration test on purpose, matching
 * railRouteContract.test.tsx's own reasoning: a LifecycleStrip unit test
 * cannot observe landmark containment (it never renders Topbar/Shell at
 * all), and the per-page tests render via testUtils/HeaderSlotProbe, which
 * reproduces the header slot's CONTENT but not Topbar's real DOM structure.
 *
 * MUTATION-VERIFIED (fix round): reverting the header-slot row to a child of
 * `<header>` (its pre-fix position) makes the assertion below fail with
 * `expected null, received: <div data-testid="header-slot-row">...` — the
 * banner-containment fact itself, not an incidental symptom. See the PR
 * description for the actual failure output.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse, UserIdentity } from '../api/types'

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

function catalogEntry(): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: 'Routes media flows between sources and viewers.',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'bootstrapped',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint',
    finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [],
    ingress_url: null,
  }
}

function workload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [
      {
        instance: 'crosspoint-1',
        netbox_id: 1,
        function_key: 'crosspoint',
        live_view: false,
        requested_state: 'active',
        observed_state: 'running',
        reconcile_pending: false,
        placement: { node: 'node-1', ports: [], protocol: null },
        workload_assignment: 'ok',
      },
    ],
    functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
  }
}

function stubFetch() {
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    workloads: [workload()],
    invalid_instances: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json(identity())
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
      if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
      if (url.endsWith('/api/facility/summary')) {
        return json({ site_count: 1, device_count: 3, sites: [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }] })
      }
      return json({})
    }),
  )
}

function renderAppAt(path: string) {
  stubFetch()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the lifecycle rail is never inside the banner landmark', () => {
  it('renders the top bar as role=banner, and the rail outside it, on a workload-detail route', async () => {
    renderAppAt('/media-workloads/studio-a/setup')
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // Confirms the premise before asserting the consequence — if this ever
    // stops holding (e.g. Shell.tsx grows a <main>/<section> ancestor above
    // Topbar), the landmark mapping this file relies on has changed and the
    // assertion below would need re-deriving, not silently keep passing for
    // the wrong reason.
    const banner = screen.getByRole('banner')
    expect(banner.tagName).toBe('HEADER')

    // THE DISCRIMINATING ASSERTION.
    expect(
      within(banner).queryByRole('navigation', { name: 'Media workload lifecycle' }),
      'the lifecycle rail must not be a descendant of the banner landmark — it is route-specific, banner is site-wide',
    ).toBeNull()

    // The rail still exists, in the document, just not inside banner — an
    // absence-only check could pass vacuously if the rail failed to render
    // at all for an unrelated reason.
    expect(screen.getByRole('navigation', { name: 'Media workload lifecycle' })).toBeTruthy()
  })

  it('holds on the workload home route too, not just /setup', async () => {
    renderAppAt('/media-workloads/studio-a')
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    const banner = screen.getByRole('banner')
    expect(
      within(banner).queryByRole('navigation', { name: 'Media workload lifecycle' }),
    ).toBeNull()
  })

  it('the create route carries no rail and still exposes exactly one banner', async () => {
    renderAppAt('/media-workloads/new')
    await screen.findByLabelText('Studio name')

    expect(screen.getAllByRole('banner').length).toBe(1)
    expect(screen.queryByRole('navigation', { name: 'Media workload lifecycle' })).toBeNull()
  })
})
