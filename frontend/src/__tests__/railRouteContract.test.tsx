/**
 * The rail's ROUTE-SCOPED MOUNTING CONTRACT (Arc 4 WP-3, umbrella
 * dmfdeploy/dmfdeploy#347; dmfdeploy#414 supersedes the contract this file
 * pins — see below): absent on the create route, present and SELECTING on
 * the guided flow (/setup), present and NAVIGATING (nothing selected) on
 * the workload's home (the bare slug). This is an App/Shell integration
 * test on purpose — a LifecycleStrip unit test (lifecycleStrip.test.tsx)
 * cannot observe route-scoped mounting, and the per-page tests
 * (workloadSetup.test.tsx and friends) render each page in isolation via
 * testUtils/HeaderSlotProbe, which reproduces the header slot's CONTENT but
 * not Topbar's own route-gating logic. This file renders the real <App/>
 * (real Topbar, real routing) specifically to prove that gating end to end.
 *
 * DMFDEPLOY#414 — THE ROUTE CONTRACT ITSELF. Supersedes the pre-#414
 * contract this file used to pin (bare slug = the guided flow, Operate on
 * its own `/operate` route, selected on the rail, its five entries
 * navigating back to the flow's hash). The new contract:
 *   /media-workloads/:slug          -> home (WorkloadHome.tsx), rail
 *                                       present, nothing selected, its five
 *                                       entries navigate to /setup#<step>
 *   /media-workloads/:slug/setup    -> the guided flow (WorkloadSetup.tsx),
 *                                       rail present, SELECTING locally
 *   /media-workloads/:slug/operate  -> compatibility redirect to home,
 *                                       `replace` (no back-button loop)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
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

// GUARD LABEL (dmfdeploy#414 gate, round 1): unlike the rest of this file,
// /new's own rail-absence is a GUARD — dmfdeploy#414 did not touch the
// create route at all. Baseline: the pre-#414 commit on `main`, where this
// same assertion passed identically (the route contract change is entirely
// about /:slug and /:slug/setup/operate, never /new).
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

describe('the rail is present and SELECTING on the setup route', () => {
  it('clicking a chip mounts that step locally, without navigating', async () => {
    renderAppAt('/media-workloads/studio-a/setup')
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // Provision is the default selection (the workload's own position);
    // Design is `complete` (behind it) and openable — click it to prove
    // selection actually moves.
    fireEvent.click(within(rail()).getByRole('button', { name: 'Design' }))

    expect(await screen.findByRole('heading', { name: 'Design', level: 2 })).toBeTruthy()
    // No navigation happened — same route, no hash.
    expect(screen.getByTestId('location').textContent).toBe('/media-workloads/studio-a/setup')
  })
})

describe('the rail is present and NAVIGATING on home, with nothing selected (dmfdeploy#414)', () => {
  it('none of the five keys reads as selected on the bare-slug route', async () => {
    renderAppAt('/media-workloads/studio-a')
    const strip = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // dmfdeploy#414: Operate is no longer a rail entry to select — home
    // itself is not one of the five stages, so nothing on the rail reads
    // as selected here at all.
    expect(within(strip).queryByRole('link')).toBeNull()
    for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']) {
      const chip = within(strip).getByLabelText(label)
      expect(chip.className, `${label} should not read as selected on home`).not.toContain('bg-text')
    }
  })

  it('clicking a stage chip navigates to the setup route with that step\'s hash, rather than selecting locally', async () => {
    renderAppAt('/media-workloads/studio-a')
    const strip = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    fireEvent.click(within(strip).getByRole('button', { name: 'Design' }))

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/media-workloads/studio-a/setup#design'),
    )
    // Landed on WorkloadSetup's own wizard, with Design mounted.
    expect(await screen.findByRole('heading', { name: 'Design', level: 2 })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// dmfdeploy#414: the /operate compatibility alias. A plain redirect to home,
// `replace` so it cannot create a back-button loop — see App.tsx's
// OperateRedirect for the mechanism.
// ---------------------------------------------------------------------------

function BackProbe() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(-1)}>
      go back (test probe)
    </button>
  )
}

/** Models the operator's own browser navigating to a saved URL cold —
 *  react-router's `navigate()` to an absolute path is the same fresh-entry
 *  history semantics a real address-bar navigation has, distinct from a
 *  same-page in-app <Link> click. Used by the full-journey test below to
 *  exercise an old /operate bookmark and an old stage-hash bookmark for the
 *  workload it just created, without a second full render. */
function GotoProbe() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" onClick={() => navigate('/media-workloads/studio-journey/operate')}>
        go to /operate (test probe)
      </button>
      <button type="button" onClick={() => navigate('/media-workloads/studio-journey#design')}>
        go to #design (test probe)
      </button>
    </>
  )
}

describe('the /operate compatibility alias (dmfdeploy#414)', () => {
  it('redirects to home — not a second live implementation', async () => {
    renderAppAt('/media-workloads/studio-a/operate')
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/media-workloads/studio-a'))
    // Landed on WorkloadHome, not on anything still claiming to be Operate.
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    expect(screen.queryByRole('link', { name: 'Operate' })).toBeNull()
  })

  it('uses `replace`: going back from home lands before the alias, never bounces forward through it again', async () => {
    stubFetch()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={['/media-workloads', '/media-workloads/studio-a/operate']}
          initialIndex={1}
        >
          <App />
          <LocationProbe />
          <BackProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // The alias resolves to home first.
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/media-workloads/studio-a'))

    // If the redirect had used a plain push instead of `replace`, the
    // history stack would be [.../media-workloads, .../operate, .../studio-a]
    // and one "back" would land on the alias entry, which would immediately
    // redirect forward again — the bounce loop `replace` exists to rule
    // out. With `replace`, the alias entry was overwritten, not added to,
    // so one "back" lands on the entry BEFORE it.
    fireEvent.click(screen.getByRole('button', { name: 'go back (test probe)' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/media-workloads'))
    // Never bounced back onto home via a redirect the alias re-fired.
    expect(screen.queryByRole('navigation', { name: 'Media workload lifecycle' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// dmfdeploy#414: the full journey, end to end against the real <App/> — list
// entry, create, materialising, the recorded workload, an old /operate
// bookmark, and an old stage-hash bookmark. Each piece has its own focused
// test elsewhere in this suite (or in createWorkload.test.tsx); this proves
// they compose into one coherent path, not five isolated facts that happen
// to each pass.
// ---------------------------------------------------------------------------

describe('the full journey: list entry, create, materialising, old /operate, old hash URLs (dmfdeploy#414)', () => {
  it('walks the whole path against the real App', async () => {
    let workloads: MediaWorkload[] = []
    const catalog = [catalogEntry()]

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(identity())
        if (url.endsWith('/api/catalog')) return json({ entries: catalog })
        if (url.endsWith('/api/media-workloads/grouped')) {
          return json({ configured: true, degraded: false, scope: [], workloads, invalid_instances: [] })
        }
        if (url.endsWith('/api/facility/summary')) {
          return json({ site_count: 1, device_count: 3, sites: [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }] })
        }
        if (url.match(/\/api\/catalog\/[^/]+\/deploy$/)) {
          return json({ job_id: 900, status: 'launched', request_id: 'req-journey' })
        }
        if (url.match(/\/api\/catalog\/[^/]+\/status\/\d+$/)) {
          return json({ job_id: 900, status: 'successful', is_done: true, is_running: false })
        }
        return json({})
      }),
    )

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads']}>
          <App />
          <LocationProbe />
          <GotoProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // 1. LIST ENTRY — nothing recorded yet, "Create media workload" reachable.
    await screen.findByText("No media workloads yet — they'll appear here once you create one.")
    fireEvent.click(screen.getByRole('link', { name: 'Create media workload' }))
    expect(screen.getByTestId('location').textContent).toBe('/media-workloads/new')

    // 2. WALK THE WIZARD to Provision and fire the deploy.
    await screen.findByRole('heading', { name: 'Identity' })
    fireEvent.change(screen.getByLabelText('Studio name'), { target: { value: 'Studio Journey' } })
    fireEvent.click(await screen.findByRole('button', { name: /Next/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this template' }))
    fireEvent.click(await screen.findByRole('button', { name: /Next/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm placement' }))
    fireEvent.click(await screen.findByRole('button', { name: /Next/ }))
    fireEvent.click(await screen.findByRole('button', { name: '▶ Provision now' }))
    fireEvent.change(
      screen.getByPlaceholderText('Reason (required, recorded in the audit trail)'),
      { target: { value: 'journey test' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm provision' }))

    // 3. MATERIALISING — dmfdeploy#414 H1: lands on /setup (not the bare
    // slug), and renders the materialising story rather than a false
    // "Workload not found" for the workload the operator just created.
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/media-workloads/studio-journey/setup'),
    )
    await screen.findByText('Deploy accepted.')

    // 4. THE LAUNCHER RECORDS IT — the inventory now reports the workload;
    // the materialising view gives way to the real guided-flow wizard, still
    // on /setup.
    workloads = [
      {
        slug: 'studio-journey',
        name: 'studio-journey',
        lifecycle: 'provision',
        health: 'ok',
        instances: [],
        functions: [{ function_key: 'crosspoint', count: 0, running: 0, reconcile_pending: 0 }],
      },
    ]
    await queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    expect(screen.queryByText('Deploy accepted.')).toBeNull()

    // 5. AN OLD /operate BOOKMARK, typed cold rather than clicked through —
    // GotoProbe models the operator's own browser navigating to a saved URL,
    // the same fidelity BackProbe above gives the back button. Redirects to
    // home, not a second live implementation.
    fireEvent.click(screen.getByRole('button', { name: 'go to /operate (test probe)' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/media-workloads/studio-journey'))
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    expect(screen.queryByRole('link', { name: 'Operate' })).toBeNull()

    // 6. AN OLD STAGE-HASH BOOKMARK — /:slug#design used to open the flow
    // directly at Design; redirects to the equivalent /setup#design URL.
    fireEvent.click(screen.getByRole('button', { name: 'go to #design (test probe)' }))
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/media-workloads/studio-journey/setup#design'),
    )
    expect(await screen.findByRole('heading', { name: 'Design', level: 2 })).toBeTruthy()
  })
})
