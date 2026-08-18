/**
 * Page identity regression net (WP-4 stage 2, umbrella #385 findings 4 + 5):
 * before this arc, `document.title` was the literal string "dmfdeploy" on
 * every route (finding 4) and zero routes had an `<h1>` at all (finding 5).
 * usePageTitle.ts and PageHeading.tsx fix both; this file is the test
 * coverage that was entirely absent for either hook/component (WO item 3).
 *
 * Three things this sweep pins, cheaply and mechanically — render-based
 * (RTL against the real page components), not source-text scanning like
 * queryErrorHandlingSweep.test.ts, because h1 count and document.title are
 * DOM/runtime facts a regex over source can't see:
 *
 *   1. Every one of App.tsx's 12 routed pages renders EXACTLY ONE <h1> on
 *      its happy path, and `document.title` matches usePageTitle's own
 *      contract for that route EXACTLY (not a generic "isn't the bare
 *      fallback" check — Workspace's title genuinely IS just
 *      "Workspace · DMF Console", so a loose check would miss a real
 *      regression there).
 *   2. The THREE states that already carried their own visible <h1> before
 *      this arc (WorkloadSetup's and WorkloadHome's "Workload not found",
 *      WorkloadMaterializing's "Launch failed"/"Provisioning") still render
 *      exactly one — proving PageHeading was never ALSO mounted alongside
 *      them (PageHeading.tsx's own documented invariant).
 *   3. A representative sample of the loading/degraded/unauthenticated
 *      branches the WP-4 stage 2 rebase audit found silently missing an
 *      <h1> entirely (a DIFFERENT bug from #2 above — these had ZERO, not
 *      two) — one example per distinct fix shape (a branch-local addition,
 *      and a hoisted-once-above-every-branch mount) rather than all of
 *      them, to stay proportionate; see PageHeading.tsx's own docstring for
 *      the full up-to-date rule these pin.
 *
 * Route components are rendered DIRECTLY (QueryClientProvider + MemoryRouter
 * only, no <App/>/<Shell/>/<Sidebar/>/<Topbar/>) — the established per-page
 * convention in this suite (adminUsers.test.tsx, facility.test.tsx,
 * workloadSetup.test.tsx). Neither Shell nor Topbar renders an <h1>
 * (confirmed by inspection), so this doesn't hide anything the fuller
 * App-level render in nav.test.tsx/railRouteContract.test.tsx would catch.
 *
 * DMFDEPLOY#414: the old Operate route case is gone — /operate is now a
 * bare compatibility redirect (App.tsx's OperateRedirect) with no page
 * identity of its own to pin here; railRouteContract.test.tsx covers its
 * redirect behaviour instead. In its place: a Workload home case (the bare
 * slug, formerly WorkloadDetail's route, now WorkloadHome.tsx) and a new
 * Workload setup case (the guided flow's own `/setup` route, WorkloadSetup.tsx).
 *
 * GUARD LABEL (dmfdeploy#414 gate, round 1): every case in this file OTHER
 * than "Workload home"/"Workload setup" (added by #414, above) and the two
 * WorkloadSetup/WorkloadHome-specific rows inside sections 2 and 3 (renamed
 * from WorkloadDetail/Operate, content unchanged) is a GUARD pinning the
 * pre-#414 WP-4 stage 2 contract described above, entirely untouched by
 * this arc. Baseline: the pre-#414 commit on `main`, where these same
 * assertions passed identically.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Workspace from '../pages/Workspace'
import Facility from '../pages/Facility'
import FacilityDetail from '../pages/Facility/Detail'
import Activity from '../pages/Activity'
import Catalog from '../pages/Catalog'
import Monitoring from '../pages/Monitoring'
import MediaWorkloads from '../pages/MediaWorkloads'
import CreateWorkload from '../pages/MediaWorkloads/CreateWorkload'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import WorkloadHome from '../pages/MediaWorkloads/WorkloadHome'
import Admin from '../pages/Admin'
import Settings from '../pages/Settings'
import type {
  CatalogEntry,
  CatalogListResponse,
  FacilityDetailResponse,
  FacilitySummary,
  MediaWorkload,
  MediaWorkloadsGroupedResponse,
  UserIdentity,
} from '../api/types'

// ---- fixtures -----------------------------------------------------------

const IDENTITY: UserIdentity = {
  subject: 'ops',
  display_name: 'Ops Operator',
  email: 'ops@dmf.example.com',
  role: 'admin',
  real_role: 'admin',
  view_as_active: false,
  groups: [],
  awx_configured: true,
  authentik_configured: true,
}

const FACILITY_SUMMARY: FacilitySummary = {
  reason: '',
  site_count: 1,
  device_count: 3,
  sites: [{ name: 'DMF Lab', slug: 'dmf-lab', device_count: 3 }],
}

const FACILITY_DETAIL: FacilityDetailResponse = {
  requested_site: 'dmf-lab',
  prometheus_configured: true,
  netbox_configured: true,
  site: { slug: 'dmf-lab', name: 'DMF Lab', architecture: null, reason: '' },
  nodes: { reason: '', items: [] },
  platform_services: { reason: '', items: [] },
  storage: { reason: '', items: [] },
  capacity: {
    reason: '',
    node_name: null,
    allocatable_cpu_m: null,
    allocatable_mem_b: null,
    requests_committed_cpu_m: null,
    requests_committed_mem_b: null,
    pod_count: null,
  },
}

function workload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
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
    ...overrides,
  }
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
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
    ...overrides,
  }
}

const CATALOG: CatalogListResponse = { entries: [catalogEntry()] }

function grouped(workloads: MediaWorkload[]): MediaWorkloadsGroupedResponse {
  return { configured: true, degraded: false, scope: [], workloads, invalid_instances: [] }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Never resolves — pins a query in `isLoading` indefinitely, for the
 *  loading-branch cases below. Matches the technique already used across
 *  this suite for un-polled-hook loading assertions. */
function pending(): Promise<Response> {
  return new Promise(() => {})
}

/** Sensible successful default for every endpoint the 12 routed pages (and
 *  the sub-components they mount) can call — keyed loosely (`includes`) so
 *  route-param URLs (`/api/facility/dmf-lab/detail`, `/.../topology`) match
 *  without one entry per slug. `overrides` short-circuits by the same
 *  loose match, checked first, for the handful of cases that need a
 *  specific status/shape/pending promise instead. */
function stubFetch(overrides: Record<string, Response | Promise<Response>> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      for (const [needle, resp] of Object.entries(overrides)) {
        if (url.includes(needle)) return resp
      }
      if (url.endsWith('/api/me')) return json(IDENTITY)
      if (url.endsWith('/api/facility/summary')) return json(FACILITY_SUMMARY)
      if (url.endsWith('/detail') && url.includes('/api/facility/')) return json(FACILITY_DETAIL)
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped([workload()]))
      if (url.endsWith('/api/catalog')) return json(CATALOG)
      if (url.endsWith('/api/admin/users')) return json({ users: [] })
      if (url.endsWith('/api/admin/groups')) return json({ groups: [] })
      if (url.endsWith('/api/admin/health')) {
        const ok = { connected: true }
        return json({ authentik: ok, awx: ok, netbox: ok, prometheus: ok })
      }
      if (url.endsWith('/api/monitoring/metrics')) {
        return json({ cpu_percent: 10, memory_percent: 20, pod_restarts_24h: 0, pvc_usage_percent: 5 })
      }
      if (url.endsWith('/api/monitoring/alerts')) return json({ alerts: [] })
      if (url.endsWith('/api/monitoring/targets')) return json({ targets: [] })
      if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: '' })
      if (url.endsWith('/api/changes/commits')) return json({ repos: [], reason: '' })
      if (url.endsWith('/api/changes/pulls')) return json({ pulls: [], reason: '' })
      if (url.endsWith('/api/workflows')) return json({ templates: [] })
      if (url.includes('/topology')) return json({})
      if (url.includes('/status/')) return json({ job_id: 1, status: 'running', is_done: false, is_running: true })
      if (url.includes('/api/operations/')) {
        return json({
          operation_id: 'op-1', action: 'deploy', target: 'crosspoint', state: 'launching',
          job_id: null, error: null, created_at: '', updated_at: '',
        })
      }
      return json({})
    }),
  )
}

function renderRoute(routePattern: string, path: string, element: React.ReactElement, state?: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: path, state }]}>
        <Routes>
          <Route path={routePattern} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Waits for `document.title` to reach usePageTitle's exact contracted
 *  value for this route, THEN asserts exactly one h1. Title, not h1 count,
 *  is the settle condition on purpose: several of these pages mount their
 *  PageHeading unconditionally, with a slug/param fallback, before their
 *  data resolves — an h1 is already present (and already exactly one)
 *  during THAT interim render, so waiting on h1 count alone can resolve on
 *  the loading state and read a stale/fallback title one render early
 *  (caught live: FacilityDetail and Operate both raced this way before the
 *  fix). document.title only reaches its FINAL value once the real data a
 *  data-dependent title depends on has actually resolved, so waiting on it
 *  is the precise "happy path settled" signal every route case needs. */
async function expectSingleHeadingAndTitle(expectedTitle: string) {
  await waitFor(() => {
    expect(document.title).toBe(expectedTitle)
  })
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Every routed page: exactly one h1, exact document.title.
// ---------------------------------------------------------------------------

describe('every routed page renders exactly one h1 with the title usePageTitle promises', () => {
  const cases: Array<{ name: string; run: () => void; title: string }> = [
    {
      name: 'Workspace (/)',
      run: () => renderRoute('/', '/', <Workspace />),
      title: 'Workspace · DMF Console',
    },
    {
      name: 'Facilities (/facilities)',
      run: () => renderRoute('/facilities', '/facilities', <Facility />),
      title: 'Facilities · DMF Console',
    },
    {
      name: 'Facility detail (/facilities/:site)',
      run: () => renderRoute('/facilities/:site', '/facilities/dmf-lab', <FacilityDetail />),
      title: 'DMF Lab · DMF Console',
    },
    {
      name: 'Activity — Jobs (/activity/jobs)',
      run: () => renderRoute('/activity/:lane?', '/activity/jobs', <Activity />),
      title: 'Activity — Jobs · DMF Console',
    },
    {
      name: 'Activity — History (/activity/history)',
      run: () => renderRoute('/activity/:lane?', '/activity/history', <Activity />),
      title: 'Activity — History · DMF Console',
    },
    {
      name: 'Catalog (/catalog)',
      run: () => renderRoute('/catalog', '/catalog', <Catalog />),
      title: 'Catalog · DMF Console',
    },
    {
      name: 'Monitoring (/monitoring)',
      run: () => renderRoute('/monitoring', '/monitoring', <Monitoring />),
      title: 'Monitoring · DMF Console',
    },
    {
      name: 'Media Workloads (/media-workloads)',
      run: () => renderRoute('/media-workloads', '/media-workloads', <MediaWorkloads />),
      title: 'Media Workloads · DMF Console',
    },
    {
      name: 'Create media workload (/media-workloads/new)',
      run: () => renderRoute('/media-workloads/new', '/media-workloads/new', <CreateWorkload />),
      title: 'Create media workload · DMF Console',
    },
    {
      name: 'Workload home (/media-workloads/:slug)',
      run: () => renderRoute('/media-workloads/:slug', '/media-workloads/studio-a', <WorkloadHome />),
      title: 'studio-a · DMF Console',
    },
    {
      name: 'Workload setup (/media-workloads/:slug/setup)',
      run: () =>
        renderRoute('/media-workloads/:slug/setup', '/media-workloads/studio-a/setup', <WorkloadSetup />),
      title: 'studio-a — Setup · DMF Console',
    },
    {
      name: 'Admin (/admin)',
      run: () => renderRoute('/admin', '/admin', <Admin />),
      title: 'Admin · DMF Console',
    },
    {
      name: 'Settings (/settings)',
      run: () => renderRoute('/settings', '/settings', <Settings />),
      title: 'Settings · DMF Console',
    },
  ]

  for (const { name, run, title } of cases) {
    it(name, async () => {
      stubFetch()
      run()
      await expectSingleHeadingAndTitle(title)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Pre-existing states with their OWN visible h1 — PageHeading must not
//    double up alongside them (PageHeading.tsx's documented invariant).
// ---------------------------------------------------------------------------

describe('states that already carry their own visible h1 are not doubled', () => {
  it('WorkloadSetup: "Workload not found" is the only heading', async () => {
    stubFetch({ '/api/media-workloads/grouped': json(grouped([])) })
    renderRoute('/media-workloads/:slug/setup', '/media-workloads/does-not-exist/setup', <WorkloadSetup />)
    expect(await screen.findByText('Workload not found')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('WorkloadHome: "Workload not found" is the only heading', async () => {
    stubFetch({ '/api/media-workloads/grouped': json(grouped([])) })
    renderRoute('/media-workloads/:slug', '/media-workloads/does-not-exist', <WorkloadHome />)
    expect(await screen.findByText('Workload not found')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('WorkloadMaterializing: "Provisioning" is the only heading (deploy accepted, workload not yet in the inventory)', async () => {
    stubFetch({ '/api/media-workloads/grouped': json(grouped([])) })
    renderRoute(
      '/media-workloads/:slug/setup',
      '/media-workloads/studio-a/setup',
      <WorkloadSetup />,
      { launch: { entryKey: 'crosspoint', jobId: 42 } },
    )
    expect(await screen.findByText('Deploy accepted.')).toBeTruthy()
    expect(screen.getByText('Provisioning')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('WorkloadMaterializing: "Launch failed" is the only heading (launch job errored before yielding a job id)', async () => {
    stubFetch({
      '/api/media-workloads/grouped': json(grouped([])),
      '/api/operations/': json({
        operation_id: 'op-1', action: 'deploy', target: 'crosspoint', state: 'error',
        job_id: null, error: 'AWX unreachable', created_at: '', updated_at: '',
      }),
    })
    renderRoute(
      '/media-workloads/:slug/setup',
      '/media-workloads/studio-a/setup',
      <WorkloadSetup />,
      { launch: { entryKey: 'crosspoint', operationId: 'op-1' } },
    )
    // WorkloadMaterializing's own onError path is a deliberate 3s-delayed
    // transition (OperationStatusLine holds the "error" state on screen
    // briefly before calling back) — RTL's default findByText timeout
    // (1000ms) isn't long enough to observe it; extend it rather than
    // faking timers against a component with live react-query polling.
    expect(await screen.findByText('Launch failed', {}, { timeout: 4000 })).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. WP-4 stage 2 rebase audit: representative sample of the branches found
//    with ZERO h1 (a different bug from #2 above) — one per distinct fix
//    shape, not all of them (see PageHeading.tsx for the full list).
// ---------------------------------------------------------------------------

describe('loading/degraded/unauthenticated branches get a page identity too (rebase audit fix)', () => {
  it('Catalog: the loading branch (a per-branch PageHeading addition) has an h1', async () => {
    stubFetch({ '/api/catalog': pending() })
    renderRoute('/catalog', '/catalog', <Catalog />)
    expect(await screen.findByText('Loading catalog…')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('WorkloadSetup: the loading branch has an h1', async () => {
    stubFetch({ '/api/media-workloads/grouped': pending() })
    renderRoute('/media-workloads/:slug/setup', '/media-workloads/studio-a/setup', <WorkloadSetup />)
    expect(await screen.findByText('Loading workload…')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('WorkloadHome: the loading branch has an h1', async () => {
    stubFetch({ '/api/media-workloads/grouped': pending() })
    renderRoute('/media-workloads/:slug', '/media-workloads/studio-a', <WorkloadHome />)
    expect(await screen.findByText('Loading workload…')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('Settings: a genuine 401 (own visible-text branch, not PageHeading-shaped ambiguity) has an h1', async () => {
    stubFetch({ '/api/me': json({ error: 'unauthorized' }, 401) })
    renderRoute('/settings', '/settings', <Settings />)
    expect(await screen.findByText('Not authenticated')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('Facilities: the netbox-not-configured branch (a hoisted-once-above-every-branch mount) has an h1', async () => {
    stubFetch({ '/api/facility/summary': json({ ...FACILITY_SUMMARY, reason: 'netbox-not-configured', sites: [] }) })
    renderRoute('/facilities', '/facilities', <Facility />)
    expect(await screen.findByText(/NetBox is not configured/)).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('Facility detail: the loading branch (a hoisted-once-above-every-phase mount) has an h1', async () => {
    stubFetch({ '/api/facility/dmf-lab/detail': pending() })
    renderRoute('/facilities/:site', '/facilities/dmf-lab', <FacilityDetail />)
    expect(await screen.findByText('Loading facility detail…')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})
