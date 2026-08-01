/**
 * The workload detail page + its EBU lifecycle rail (umbrella #285 S1).
 *
 * The single most important thing this file proves is that the deploy /
 * switch / teardown click paths SURVIVED relocation off Catalog and
 * InstanceLiveModal onto Provision / Configure / Finalise & Review: arm →
 * nothing fires → reason (and, for switch, a target) required → Confirm →
 * exactly one POST with the expected body → the job/outcome renders.
 *
 * Alongside that: every stage renders at every reachable state, a
 * not-applicable stage is always prose (never a control), no stage ever
 * renders an action lib/workloadLifecycle.ts's stageActions() did not
 * authorise, the null-active (`lifecycle: 'unknown'`) case renders the
 * honest undetermined rail, and — the cross-stage architectural risk this
 * page's design takes on — a job in flight on ONE stage suppresses the
 * action on every OTHER stage, not just its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
import MediaWorkloads from '../pages/MediaWorkloads'
import type {
  CatalogEntry,
  MediaWorkload,
  MediaWorkloadInstance,
  MediaWorkloadsGroupedResponse,
} from '../api/types'

// ---- fixtures ---------------------------------------------------------

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

function instance(
  overrides: Partial<MediaWorkloadInstance> = {},
): MediaWorkloadInstance & { workload_assignment: string } {
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
    instances: [instance()],
    functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
    ...overrides,
  }
}

// A workload with one receiver/"viewer" instance — the shape Design's
// composition line and Configure's switch control both need a topology for.
function viewerWorkload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return workload({
    lifecycle: 'operate',
    instances: [
      instance({
        instance: 'viewer-1',
        function_key: 'viewer',
        requested_state: 'active',
        observed_state: 'running',
      }),
    ],
    functions: [{ function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 }],
    ...overrides,
  })
}

function freshTopology(overrides: Record<string, unknown> = {}) {
  return {
    receiver_instance: 'viewer-1',
    sources: [
      { id: 'source-a', flow_id: 'f1', pattern: 'smpte' },
      { id: 'source-b', flow_id: 'f2', pattern: 'ball' },
    ],
    active_source: 'source-a',
    provenance: 'observed-flow',
    observed_at: new Date(Date.now() - 1_000).toISOString(), // 1s old, well under the 15s staleness bound
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface FetchOpts {
  workload?: MediaWorkload
  catalog?: CatalogEntry[]
  topology?: Record<string, unknown>
  deployResult?: Record<string, unknown>
  teardownResult?: Record<string, unknown>
  switchResult?: Record<string, unknown>
  clearResult?: Record<string, unknown>
  facilitySites?: Array<{ name: string; slug: string | null; device_count: number }>
  // Holds the switch-source POST open until releaseSwitch() is called — the
  // one seam the cross-stage busy-suppression test needs to control timing.
  holdSwitch?: boolean
}

function mkFetch(opts: FetchOpts = {}) {
  const wl = opts.workload ?? workload()
  const groupedResponse: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    workloads: [wl],
    invalid_instances: [],
  }
  const catalog = opts.catalog ?? [catalogEntry()]
  const calls = {
    deploy: [] as Array<{ url: string; init?: RequestInit }>,
    teardown: [] as Array<{ url: string; init?: RequestInit }>,
    switch: [] as Array<{ url: string; init?: RequestInit }>,
    clear: [] as Array<{ url: string; init?: RequestInit }>,
  }

  let releaseSwitch: (() => void) | undefined
  const switchGate = opts.holdSwitch
    ? new Promise<void>((resolve) => {
        releaseSwitch = resolve
      })
    : Promise.resolve()

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()

    if (url.endsWith('/api/me')) {
      return json({
        subject: 'ops',
        display_name: 'Ops',
        email: 'ops@dmf.example.com',
        role: 'engineer',
        real_role: 'engineer',
        view_as_active: false,
        groups: [],
        awx_configured: true,
        authentik_configured: true,
      })
    }
    if (url.endsWith('/api/catalog')) return json({ entries: catalog })
    if (url.endsWith('/api/media-workloads/grouped')) return json(groupedResponse)
    if (url.endsWith('/api/facility/summary')) {
      const sites = opts.facilitySites ?? [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }]
      return json({ site_count: sites.length, device_count: 0, sites })
    }
    const topoMatch = url.match(/\/api\/media-workloads\/([^/]+)\/topology$/)
    if (topoMatch) {
      const name = decodeURIComponent(topoMatch[1])
      return json(opts.topology?.[name] ?? {})
    }
    if (url.match(/\/api\/media-workloads\/[^/]+\/switch-source$/)) {
      calls.switch.push({ url, init })
      await switchGate
      return json(
        opts.switchResult ?? {
          command_id: 'cmd-1',
          receiver_instance: 'viewer-1',
          source_instance: 'source-b',
          reason: 'go',
          status: 'active',
          previous_source: 'source-a',
          error: null,
          outcome: 'switch_success',
          outcome_message: null,
          request_id: 'req-switch-1',
          initiator: 'ops',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          actor: 'ops',
          role: 'engineer',
        },
      )
    }
    if (url.match(/\/api\/media-workloads\/[^/]+\/clear$/)) {
      calls.clear.push({ url, init })
      return json(
        opts.clearResult ?? {
          instance: 'crosspoint-1',
          requested_state: 'active',
          previous_state: 'bootstrapped',
          request_id: 'req-clear-1',
          actor: 'ops',
          role: 'engineer',
          reason: 'go',
          reconcile: { expectation: 'converging', watch: '' },
        },
      )
    }
    if (url.match(/\/api\/catalog\/[^/]+\/deploy$/)) {
      calls.deploy.push({ url, init })
      return json(opts.deployResult ?? { job_id: 501, status: 'launched', request_id: 'req-deploy-1' })
    }
    if (url.match(/\/api\/catalog\/[^/]+\/teardown$/)) {
      calls.teardown.push({ url, init })
      return json(opts.teardownResult ?? { job_id: 502, status: 'launched', request_id: 'req-teardown-1' })
    }
    if (url.match(/\/api\/catalog\/[^/]+\/status\/\d+$/)) {
      return json({ job_id: 501, status: 'successful', is_done: true, is_running: false })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { ...calls, fetchMock, releaseSwitch: () => releaseSwitch?.() }
}

function renderDetail(slug = 'studio-a') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/media-workloads/${slug}`]}>
        <Routes>
          <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// Scope assertions to one stage card via its <h2>, not aria landmark
// inference — robust regardless of how <section aria-label> maps to roles.
function stageSection(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: label, level: 2 })
  return heading.closest('section') as HTMLElement
}

const REASON_PLACEHOLDER = 'Reason (required, recorded in the audit trail)'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---- rail: all six stages, every state -------------------------------

describe('rail — all six stages always visible', () => {
  it('renders six labelled stage cards for every backend lifecycle value, including unknown', async () => {
    for (const lifecycle of ['provision', 'configure', 'operate', 'unknown'] as const) {
      cleanup()
      mkFetch({ workload: workload({ lifecycle }) })
      renderDetail()
      await screen.findByRole('heading', { name: 'studio-a' })
      for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Operate', 'Finalise & Review']) {
        expect(stageSection(label), `${label} @ lifecycle=${lifecycle}`).toBeTruthy()
      }
    }
  })
})

describe('the honest undetermined rail (backend lifecycle=unknown)', () => {
  it('places no active stage and says so honestly, instead of guessing', async () => {
    mkFetch({ workload: workload({ lifecycle: 'unknown' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    expect(
      screen.getByText(/the backend could not determine this workload's stage/),
    ).toBeTruthy()
    expect(screen.queryByText('You are here')).toBeNull()

    // Post-provision stages are not-applicable, rendered as prose with no
    // control — never a guessed position, never a dead button.
    for (const label of ['Provision', 'Configure', 'Operate', 'Finalise & Review']) {
      const section = stageSection(label)
      expect(within(section).queryByRole('button')).toBeNull()
    }
    // Design and Plan remain informational facts even on an undetermined stage.
    expect(within(stageSection('Design')).getByText('MXL Crosspoint')).toBeTruthy()
  })
})

describe('not-applicable stages are always prose, never a control', () => {
  it('lifecycle=provision: Configure/Operate/Finalise explain themselves with no button', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const configureSection = stageSection('Configure')
    expect(within(configureSection).getByText(/there is no source to configure/)).toBeTruthy()
    expect(within(configureSection).queryByRole('button')).toBeNull()

    const finaliseSection = stageSection('Finalise & Review')
    expect(within(finaliseSection).getByText(/nothing to tear down/)).toBeTruthy()
    expect(within(finaliseSection).queryByRole('button', { name: /Teardown/ })).toBeNull()

    const operateSection = stageSection('Operate')
    expect(within(operateSection).getByText(/Operate will show live state/)).toBeTruthy()

    // Only Provision — the one authorised action at this lifecycle — bears a button.
    expect(within(stageSection('Provision')).getByRole('button', { name: '▶ Deploy' })).toBeTruthy()
  })

  it('renders the desired-state clear control in Finalise even while its own teardown action is not-applicable', async () => {
    // ClearForDeployment is a different write seam the lifecycle module
    // doesn't model at all — it must not be swept up in the not-applicable
    // "no control" rule that governs teardown/deploy/switch specifically.
    const wl = workload({
      lifecycle: 'provision',
      instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
    })
    mkFetch({ workload: wl })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const finaliseSection = stageSection('Finalise & Review')
    expect(within(finaliseSection).getByText(/nothing to tear down/)).toBeTruthy()
    expect(within(finaliseSection).getByRole('button', { name: 'Clear for deployment' })).toBeTruthy()
  })
})

// ---- the click paths (the load-bearing proof) -------------------------

describe('Provision: deploy click path', () => {
  it('arms, fires nothing until a reason is entered, then POSTs and shows job progress', async () => {
    const { deploy } = mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const provisionSection = stageSection('Provision')
    fireEvent.click(within(provisionSection).getByRole('button', { name: '▶ Deploy' }))

    expect(deploy).toHaveLength(0)
    const confirm = within(provisionSection).getByRole('button', { name: 'Confirm deploy' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    const textbox = within(provisionSection).getByPlaceholderText(REASON_PLACEHOLDER)
    fireEvent.change(textbox, { target: { value: 'demo launch' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await within(provisionSection).findByText(/job #501/)
    expect(deploy).toHaveLength(1)
    const body = JSON.parse(deploy[0].init?.body as string)
    expect(body.reason).toBe('demo launch')
    // The optional workload field is relocated pre-filled to THIS workload.
    expect(body.workload).toBe('studio-a')
  })

  it('never renders Deploy once the entry is already active', async () => {
    mkFetch({
      workload: workload({ lifecycle: 'provision' }),
      catalog: [catalogEntry({ lifecycle: 'active' })],
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })
    const provisionSection = stageSection('Provision')
    expect(within(provisionSection).queryByRole('button', { name: '▶ Deploy' })).toBeNull()
    expect(within(provisionSection).getByText('Already deployed.')).toBeTruthy()
  })
})

describe('Configure: switch click path', () => {
  it('offers a target only against a fresh observation, requires target + reason, then POSTs and reviews', async () => {
    const wl = viewerWorkload()
    const { switch: switchCalls } = mkFetch({
      workload: wl,
      catalog: [catalogEntry({ key: 'viewer', display_name: 'MXL Viewer', lifecycle: 'active' })],
      topology: { 'viewer-1': freshTopology() },
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const configureSection = stageSection('Configure')
    const switchButton = await within(configureSection).findByRole('button', { name: 'Switch source' })
    fireEvent.click(switchButton)

    const confirm = within(configureSection).getByRole('button', { name: 'Confirm switch' }) as HTMLButtonElement
    const select = within(configureSection).getByRole('combobox') as HTMLSelectElement
    const textbox = within(configureSection).getByPlaceholderText(REASON_PLACEHOLDER)

    expect(confirm.disabled).toBe(true)
    expect(switchCalls).toHaveLength(0)

    fireEvent.change(textbox, { target: { value: 'operator requested' } })
    expect(confirm.disabled).toBe(true) // reason alone isn't enough
    fireEvent.change(select, { target: { value: 'source-b' } })
    expect(confirm.disabled).toBe(false)

    fireEvent.click(confirm)
    await within(configureSection).findByText(/Active source: source-b/)
    expect(switchCalls).toHaveLength(1)
    expect(JSON.parse(switchCalls[0].init?.body as string)).toEqual({
      source_instance: 'source-b',
      reason: 'operator requested',
    })

    // The structured outcome is also the Finalise & Review "review" — the
    // same DMF_L3_SWITCH_OUTCOME data, not a re-derived summary.
    const finaliseSection = stageSection('Finalise & Review')
    expect(within(finaliseSection).getByText(/Last switch outcome/)).toBeTruthy()
  })

  it('fails closed (no target offered) when the observation is stale', async () => {
    const wl = viewerWorkload()
    mkFetch({
      workload: wl,
      catalog: [catalogEntry({ key: 'viewer', lifecycle: 'active' })],
      topology: {
        'viewer-1': freshTopology({ observed_at: new Date(Date.now() - 60_000).toISOString() }),
      },
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })
    const configureSection = stageSection('Configure')
    await within(configureSection).findByText(/Live source is unknown or stale/)
    expect(within(configureSection).queryByRole('button', { name: 'Switch source' })).toBeNull()
  })
})

describe('Finalise & Review: teardown click path', () => {
  it('arms, fires nothing until a reason is entered, then POSTs and shows job progress', async () => {
    const { teardown } = mkFetch({
      workload: workload({ lifecycle: 'operate' }),
      catalog: [catalogEntry({ lifecycle: 'active' })],
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const finaliseSection = stageSection('Finalise & Review')
    fireEvent.click(within(finaliseSection).getByRole('button', { name: '⏏ Teardown' }))

    expect(teardown).toHaveLength(0)
    const confirm = within(finaliseSection).getByRole('button', { name: 'Confirm teardown' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    const textbox = within(finaliseSection).getByPlaceholderText(REASON_PLACEHOLDER)
    fireEvent.change(textbox, { target: { value: 'decommission' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await within(finaliseSection).findByText(/job #502/)
    expect(teardown).toHaveLength(1)
    expect(JSON.parse(teardown[0].init?.body as string)).toEqual({ reason: 'decommission' })
  })

  it('never renders Teardown for an entry that is not currently deployed', async () => {
    mkFetch({
      workload: workload({ lifecycle: 'operate' }),
      catalog: [catalogEntry({ lifecycle: 'bootstrapped' })],
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })
    const finaliseSection = stageSection('Finalise & Review')
    expect(within(finaliseSection).queryByRole('button', { name: '⏏ Teardown' })).toBeNull()
    expect(within(finaliseSection).getByText('Not currently deployed.')).toBeTruthy()
  })
})

// ---- cross-stage suppression: the architectural risk this page takes on

describe('a job in flight suppresses every OTHER stage\'s action, not just its own', () => {
  it('a pending switch removes Finalise\'s teardown button until it resolves', async () => {
    const wl = viewerWorkload()
    const { releaseSwitch } = mkFetch({
      workload: wl,
      catalog: [catalogEntry({ key: 'viewer', lifecycle: 'active' })],
      topology: { 'viewer-1': freshTopology() },
      holdSwitch: true,
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const configureSection = stageSection('Configure')
    fireEvent.click(await within(configureSection).findByRole('button', { name: 'Switch source' }))
    fireEvent.change(within(configureSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'go' },
    })
    fireEvent.change(within(configureSection).getByRole('combobox'), { target: { value: 'source-b' } })

    // Before Confirm: Finalise still offers Teardown (nothing in flight yet).
    expect(within(stageSection('Finalise & Review')).getByRole('button', { name: '⏏ Teardown' })).toBeTruthy()

    fireEvent.click(within(configureSection).getByRole('button', { name: 'Confirm switch' }))

    // The switch is now pending (fetch is held open) — stageActions()
    // suppresses EVERY stage's action while any job is in flight, so
    // Finalise's Teardown button must vanish even though it never touched
    // the switch itself.
    await waitFor(() => {
      expect(
        within(stageSection('Finalise & Review')).queryByRole('button', { name: '⏏ Teardown' }),
      ).toBeNull()
    })

    releaseSwitch()

    // Once the switch resolves, the rail is idle again and Teardown returns.
    await waitFor(() => {
      expect(
        within(stageSection('Finalise & Review')).getByRole('button', { name: '⏏ Teardown' }),
      ).toBeTruthy()
    })
  })
})

// ---- Design + Plan: informational, never an action ---------------------

describe('Design: read-only template + composition', () => {
  it('shows the catalog template and the receiver composition, with no control', async () => {
    const wl = viewerWorkload()
    mkFetch({
      workload: wl,
      catalog: [
        catalogEntry({
          key: 'viewer',
          display_name: 'MXL Viewer',
          summary: 'Renders a media flow.',
          lifecycle: 'active',
        }),
      ],
      topology: { 'viewer-1': freshTopology() },
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const designSection = stageSection('Design')
    expect(within(designSection).getByText('MXL Viewer')).toBeTruthy()
    expect(within(designSection).getByText('Renders a media flow.')).toBeTruthy()
    expect(await within(designSection).findByText(/composed of/)).toBeTruthy()
    expect(within(designSection).queryByRole('button')).toBeNull()
  })
})

describe('Plan: the assigned facility', () => {
  it('links to the single registered facility', async () => {
    mkFetch({ facilitySites: [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 4 }] })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })
    const planSection = stageSection('Plan')
    const link = await within(planSection).findByRole('link', { name: 'dmf-lab' })
    expect(link.getAttribute('href')).toBe('/facilities/dmf-lab')
  })

  it('gives an honest non-answer when no facility is registered, never a guess', async () => {
    mkFetch({ facilitySites: [] })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })
    const planSection = stageSection('Plan')
    expect(await within(planSection).findByText(/can't be shown/)).toBeTruthy()
    expect(within(planSection).queryByRole('link')).toBeNull()
  })
})

// ---- workload-not-found honesty ---------------------------------------

describe('an unknown slug', () => {
  it('renders an honest not-found state, not a blank page or a crash', async () => {
    mkFetch({})
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/does-not-exist']}>
          <Routes>
            <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Workload not found')).toBeTruthy()
    expect(screen.getByText(/No workload named "does-not-exist"/)).toBeTruthy()
  })
})

// ---- the list page: single entry, links to detail ----------------------

describe('the Media Workloads list — single entry per workload', () => {
  it('links each workload to its detail page and keeps the degraded/invalid-assignment honesty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/media-workloads/grouped')) {
          return json({
            configured: true,
            degraded: true,
            scope: [],
            workloads: [{ ...workload(), slug: 'studio-a', name: 'studio-a' }],
            invalid_instances: [
              {
                instance: 'bad-svc',
                function_key: 'mxl-videotestsrc',
                workload_assignment: 'invalid-multiple',
                conflicting_workloads: ['alpha', 'beta'],
              },
            ],
          })
        }
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <MediaWorkloads />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const link = await screen.findByRole('link', { name: /studio-a/ })
    expect(link.getAttribute('href')).toBe('/media-workloads/studio-a')
    // Degraded inventory + invalid-assignment honesty survive the simplification.
    expect(screen.getByText('Invalid workload assignments')).toBeTruthy()
    expect(screen.getByText(/bad-svc/)).toBeTruthy()
  })
})
