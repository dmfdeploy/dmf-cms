/**
 * The rail's ROUTE-SCOPED MOUNTING CONTRACT (Arc 4 WP-3, umbrella
 * dmfdeploy/dmfdeploy#347): absent on the create route, present and
 * SELECTING on workload detail, present and NAVIGATING on Operate. This is
 * an App/Shell integration test on purpose — a LifecycleStrip unit test
 * (lifecycleStrip.test.tsx) cannot observe route-scoped mounting, and the
 * per-page tests (workloadDetail.test.tsx and friends) render each page in
 * isolation via testUtils/HeaderSlotProbe, which reproduces the header
 * slot's CONTENT but not Topbar's own route-gating logic. This file
 * renders the real <App/> (real Topbar, real routing) specifically to
 * prove that gating end to end.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
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

// lifecycle=provision, one running+bootstrapped member: Design/Plan read
// `complete` (openable, behind the position) and Provision is the position
// — enough to exercise chip selection without needing every stage's own
// full data shape.
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

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}{location.hash}</div>
}

function renderAppAt(path: string) {
  stubFetch()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Media workload lifecycle' })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the rail is absent on the create route', () => {
  it('renders no header-slot-row on /media-workloads/new', async () => {
    renderAppAt('/media-workloads/new')
    // Wait for the create page itself to settle, so an absence check isn't
    // just catching a route that hasn't rendered anything yet.
    await screen.findByLabelText('Studio name')
    expect(screen.queryByTestId('header-slot-row')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Media workload lifecycle' })).toBeNull()
  })
})

describe('the rail is present and SELECTING on workload detail', () => {
  it('clicking a chip mounts that step locally, without navigating', async () => {
    renderAppAt('/media-workloads/studio-a')
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // Provision is the default selection (the workload's own position);
    // Design is `complete` (behind it) and openable — click it to prove
    // selection actually moves.
    fireEvent.click(within(rail()).getByRole('button', { name: 'Design' }))

    expect(await screen.findByRole('heading', { name: 'Design', level: 2 })).toBeTruthy()
    // No navigation happened — same route, no hash.
    expect(screen.getByTestId('location').textContent).toBe('/media-workloads/studio-a')
  })
})

describe('the rail is present on Operate, with Operate selected, and its stage entries NAVIGATE', () => {
  it('Operate reads as the selected chip', async () => {
    renderAppAt('/media-workloads/studio-a/operate')
    const strip = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    const operateLink = within(strip).getByRole('link', { name: 'Operate' })
    // The inverted "selected" treatment — same class LifecycleStrip gives
    // any selected chip, per the rail-treatment ruling.
    expect(operateLink.className).toContain('bg-text')
    expect(operateLink.className).toContain('text-bg')

    // None of the five stage chips carries the selected treatment here —
    // Operate is the only thing "selected" on this route.
    for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']) {
      const chip = within(strip).getByLabelText(label)
      expect(chip.className, `${label} should not read as selected on Operate`).not.toContain('bg-text')
    }
  })

  it('clicking a stage chip navigates to the detail route with that step\'s hash, rather than selecting locally', async () => {
    renderAppAt('/media-workloads/studio-a/operate')
    const strip = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    fireEvent.click(within(strip).getByRole('button', { name: 'Design' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/media-workloads/studio-a#design'))
    // Landed on WorkloadDetail's own wizard, with Design mounted.
    expect(await screen.findByRole('heading', { name: 'Design', level: 2 })).toBeTruthy()
  })
})
