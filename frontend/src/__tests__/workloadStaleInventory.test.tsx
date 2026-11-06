/**
 * dmfdeploy#319: a stale inventory (a last-good payload served after a failed
 * NetBox read) must not license a write and must not assert current facts.
 *
 * Every route-level test drives fresh -> stale -> fresh through the real
 * grouped query, so it covers the wiring from the API field to the control,
 * not only the lifecycle helper.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import WorkloadHome from '../pages/MediaWorkloads/WorkloadHome'
import MediaWorkloads from '../pages/MediaWorkloads'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import type { MediaWorkload, MediaWorkloadInstance } from '../api/types'

function instance(overrides: Partial<MediaWorkloadInstance> = {}): MediaWorkloadInstance & {
  workload_assignment: string
} {
  return {
    instance: 'crosspoint-1',
    netbox_id: 1,
    function_key: 'crosspoint',
    live_view: false,
    requested_state: 'active',
    observed_state: 'running',
    reconcile_pending: false,
    placement: { node: 'node-1', ports: [], protocol: null },
    workload_assignment: 'ok',
    ...overrides,
  }
}

function workload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
    functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
    ...overrides,
  }
}

const CATALOG = {
  key: 'crosspoint',
  display_name: 'MXL Crosspoint',
  summary: 's',
  lifecycle: 'planned',
  configure_awx_job_template: 'deploy-crosspoint',
  finalise_awx_job_template: 'teardown-crosspoint',
  dependencies: [],
}

interface Inventory {
  workloads: MediaWorkload[]
  stale: boolean
}

/** Every POST the page sent, by URL. */
const posts: string[] = []

const ONE_MINUTE_AGO = () => new Date(Date.now() - 60_000).toISOString()

/** The grouped response follows `inv`; flip `inv.stale` to model a failed read. */
function mockApi(inv: Inventory, catalogLifecycle = 'planned', hold: Promise<void> | null = null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (init?.method === 'POST') posts.push(url)
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/api/me')) {
        return json({ subject: 'ops', display_name: 'Ops', email: 'o@x', role: 'engineer', real_role: 'engineer', groups: [] })
      }
      if (url.endsWith('/api/catalog')) return json({ entries: [{ ...CATALOG, lifecycle: catalogLifecycle }] })
      if (url.endsWith('/api/media-workloads/grouped')) {
        if (hold) await hold
        return json({
          configured: true,
          degraded: false,
          scope: [],
          workloads: inv.workloads,
          invalid_instances: [],
          stale: inv.stale,
          last_success: inv.stale ? ONE_MINUTE_AGO() : null,
          failure_since: inv.stale ? ONE_MINUTE_AGO() : null,
        })
      }
      return json({})
    }),
  )
}

function mount(path: string, routePath: string, element: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

async function refetch(qc: QueryClient) {
  await act(async () => {
    await qc.refetchQueries({ queryKey: ['media-workloads-grouped'] })
  })
}

const STALE_NOTICE = /This view may be out of date/

afterEach(() => {
  posts.length = 0
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openStep(label: string): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
  const button = await waitFor(() => within(nav).getByRole('button', { name: label }))
  fireEvent.click(button)
  return screen.getByRole('heading', { name: label, level: 2 }).closest('[data-step-state]') as HTMLElement
}

describe('WorkloadSetup: stale withdraws every write, then restores them', () => {
  it('Provision: deploy and clear-for-deployment', async () => {
    const inv: Inventory = { workloads: [workload()], stale: false }
    mockApi(inv)
    const qc = mount('/media-workloads/studio-a/setup', '/media-workloads/:slug/setup', <WorkloadSetup />)

    const fresh = await openStep('Provision')
    expect(await within(fresh).findByRole('button', { name: '▶ Deploy' })).toBeTruthy()
    expect(within(fresh).getByText('Clear for deployment')).toBeTruthy()
    expect(screen.queryByText(STALE_NOTICE)).toBeNull()

    inv.stale = true
    await refetch(qc)
    await screen.findByText(STALE_NOTICE)
    expect(screen.getByText(/Last confirmed 1 minute ago/)).toBeTruthy()
    const stale = await openStep('Provision')
    expect(within(stale).queryByRole('button', { name: '▶ Deploy' })).toBeNull()
    expect(within(stale).queryByText('Clear for deployment')).toBeNull()

    inv.stale = false
    await refetch(qc)
    await waitFor(() => expect(screen.queryByText(STALE_NOTICE)).toBeNull())
    const back = await openStep('Provision')
    expect(await within(back).findByRole('button', { name: '▶ Deploy' })).toBeTruthy()
  })

  it('Configure (switch source) and Finalise (tear down)', async () => {
    const running = workload({
      lifecycle: 'operate',
      instances: [instance({ instance: 'viewer-1', function_key: 'viewer' })],
    })
    const inv: Inventory = { workloads: [running], stale: false }
    mockApi(inv, 'active')
    const qc = mount('/media-workloads/studio-a/setup', '/media-workloads/:slug/setup', <WorkloadSetup />)

    const finalise = await openStep('Finalise & Review')
    expect(await within(finalise).findByRole('button', { name: '⏏ Teardown' })).toBeTruthy()

    inv.stale = true
    await refetch(qc)
    await screen.findByText(STALE_NOTICE)
    const finaliseStale = await openStep('Finalise & Review')
    expect(within(finaliseStale).queryByRole('button', { name: '⏏ Teardown' })).toBeNull()
    const configureStale = await openStep('Configure')
    expect(within(configureStale).queryByRole('button', { name: 'Switch source' })).toBeNull()

    inv.stale = false
    await refetch(qc)
    const finaliseBack = await openStep('Finalise & Review')
    expect(await within(finaliseBack).findByRole('button', { name: '⏏ Teardown' })).toBeTruthy()
  })

  it('does not call a workload operating, or missing, from stale data', async () => {
    const inv: Inventory = { workloads: [workload({ lifecycle: 'operate', instances: [instance()] })], stale: true }
    mockApi(inv)
    mount('/media-workloads/studio-a/setup', '/media-workloads/:slug/setup', <WorkloadSetup />)
    expect(await screen.findByText(/When the inventory was last confirmed, this workload was operating/)).toBeTruthy()
    expect(screen.queryByText(/^This workload is operating\./)).toBeNull()
    expect(screen.getByText(STALE_NOTICE)).toBeTruthy()
  })

  it('a stale inventory without the workload is not a "not found"', async () => {
    mockApi({ workloads: [], stale: true })
    mount('/media-workloads/gone/setup', '/media-workloads/:slug/setup', <WorkloadSetup />)
    expect(await screen.findByText(/could not be confirmed right now/)).toBeTruthy()
    expect(screen.queryByText('Workload not found')).toBeNull()
    expect(screen.queryByText(/is in your scope right now/)).toBeNull()
  })
})

describe('WorkloadSetup: no write is offered before the first inventory read settles', () => {
  it('renders no Deploy or Confirm and sends no POST until the read settles', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    mockApi({ workloads: [workload()], stale: false }, 'planned', hold)
    mount('/media-workloads/studio-a/setup', '/media-workloads/:slug/setup', <WorkloadSetup />)
    expect(await screen.findByText('Loading workload…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Deploy|Confirm|Teardown|Switch source/ })).toBeNull()
    expect(posts).toHaveLength(0)

    release()
    const provision = await openStep('Provision')
    expect(await within(provision).findByRole('button', { name: '▶ Deploy' })).toBeTruthy()
    expect(posts).toHaveLength(0)
  })
})

describe('WorkloadHome: stale qualifies what it shows', () => {
  it('a stale inventory without the workload is not a "not in your scope" claim', async () => {
    mockApi({ workloads: [], stale: true })
    mount('/media-workloads/gone', '/media-workloads/:slug', <WorkloadHome />)
    expect(await screen.findByText(STALE_NOTICE)).toBeTruthy()
    expect(screen.queryByText(/is in your scope right now/)).toBeNull()
    expect(screen.queryByText('Workload not found')).toBeNull()
  })

  it('fresh -> stale -> fresh: the present workload shows the notice only while stale', async () => {
    const inv: Inventory = { workloads: [workload({ lifecycle: 'operate', instances: [instance()] })], stale: false }
    mockApi(inv)
    const qc = mount('/media-workloads/studio-a', '/media-workloads/:slug', <WorkloadHome />)
    await screen.findByText(/The monitoring surface for this workload/)
    expect(screen.queryByText(STALE_NOTICE)).toBeNull()

    inv.stale = true
    await refetch(qc)
    expect(await screen.findByText(STALE_NOTICE)).toBeTruthy()
    expect(screen.queryByText(/The monitoring surface for this workload/)).toBeNull()
    expect(screen.queryByText(/isn.t clear enough right now/)).toBeNull()

    inv.stale = false
    await refetch(qc)
    await screen.findByText(/The monitoring surface for this workload/)
    expect(screen.queryByText(STALE_NOTICE)).toBeNull()
  })
})

/** The grouped response is `body` as given, for payloads `mockApi` cannot shape. */
function mockGrouped(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/api/me')) {
        return json({ subject: 'ops', display_name: 'Ops', email: 'o@x', role: 'engineer', real_role: 'engineer', groups: [] })
      }
      if (url.endsWith('/api/catalog')) return json({ entries: [CATALOG] })
      if (url.endsWith('/api/media-workloads/grouped')) return json(body)
      return json({})
    }),
  )
}

/** What the grouped endpoint returns once the read-grace window has passed. */
const GRACE_EXPIRED = () => ({
  configured: true,
  degraded: true,
  reason: 'netbox-unreachable',
  workloads: [],
  invalid_instances: [],
  stale: false,
  last_success: ONE_MINUTE_AGO(),
  failure_since: ONE_MINUTE_AGO(),
})

/** A read that succeeded but excluded a conflicting-tag instance: degraded, no reason. */
const CONFLICTING_TAGS = {
  configured: true,
  degraded: true,
  workloads: [],
  invalid_instances: [
    { instance: 'x-1', function_key: 'crosspoint', workload_assignment: 'invalid-multiple', conflicting_workloads: ['a', 'b'] },
  ],
  stale: false,
}

const UNREAD_COPY = /could not read the facility inventory system/

describe('an unread inventory after the grace window is not a "not found"', () => {
  it('WorkloadSetup', async () => {
    mockGrouped(GRACE_EXPIRED())
    mount('/media-workloads/gone/setup', '/media-workloads/:slug/setup', <WorkloadSetup />)
    expect(await screen.findByText(UNREAD_COPY)).toBeTruthy()
    expect(screen.getByText(/could not be confirmed right now/)).toBeTruthy()
    expect(screen.getByText(/Last confirmed 1 minute ago/)).toBeTruthy()
    expect(screen.queryByText('Workload not found')).toBeNull()
    expect(screen.queryByText(/is in your scope right now/)).toBeNull()
  })

  it('WorkloadHome', async () => {
    mockGrouped(GRACE_EXPIRED())
    mount('/media-workloads/gone', '/media-workloads/:slug', <WorkloadHome />)
    expect(await screen.findByText(UNREAD_COPY)).toBeTruthy()
    expect(screen.getByText(/could not be loaded right now/)).toBeTruthy()
    expect(screen.queryByText('Workload not found')).toBeNull()
    expect(screen.queryByText(/is in your scope right now/)).toBeNull()
  })

  it('a read that only excluded conflicting tags still reports the workload as not found', async () => {
    mockGrouped(CONFLICTING_TAGS)
    mount('/media-workloads/gone/setup', '/media-workloads/:slug/setup', <WorkloadSetup />)
    expect(await screen.findByText('Workload not found')).toBeTruthy()
    cleanup()
    mount('/media-workloads/gone', '/media-workloads/:slug', <WorkloadHome />)
    expect(await screen.findByText('Workload not found')).toBeTruthy()
  })
})

describe('Media Workloads list: a stale empty inventory is not a healthy empty one', () => {
  it('shows the stale warning and no "ready for your first workload" canvas', async () => {
    const inv: Inventory = { workloads: [], stale: false }
    mockApi(inv)
    const qc = mount('/media-workloads', '/media-workloads', <MediaWorkloads />)
    expect(await screen.findByText(/No media workloads yet/)).toBeTruthy()

    inv.stale = true
    await refetch(qc)
    await screen.findByText(/This list may be out of date/)
    expect(screen.queryByText(/No media workloads yet/)).toBeNull()
    expect(screen.getByText(/cannot confirm there are none now/)).toBeTruthy()
  })
})
