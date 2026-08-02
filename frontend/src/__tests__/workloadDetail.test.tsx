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
  /** Per-instance HTTP status for the topology read, for the 404 path. */
  topologyStatus?: Record<string, number>
  deployResult?: Record<string, unknown>
  teardownResult?: Record<string, unknown>
  switchResult?: Record<string, unknown>
  clearResult?: Record<string, unknown>
  facilitySites?: Array<{ name: string; slug: string | null; device_count: number }>
  // Holds the switch-source POST open until releaseSwitch() is called — the
  // one seam the cross-stage busy-suppression test needs to control timing.
  holdSwitch?: boolean
  // Same idea for the clear POST: awaited before the response resolves, so
  // "a clear is pending" is an observable state rather than a race.
  clearDelay?: Promise<unknown>
  /** Force the clear POST to fail, for the stage-level failure test. */
  clearStatus?: number
  /** Gate grouped reads after the Nth call, to test the slow-refetch race. */
  groupedDelayAfter?: number
  groupedGate?: Promise<unknown>
}

function mkFetch(opts: FetchOpts = {}) {
  let wl = opts.workload ?? workload()
  const groupedResponse: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    get workloads() { return [wl] },
    invalid_instances: [],
  }
  const catalog = opts.catalog ?? [catalogEntry()]
  const calls = {
    deploy: [] as Array<{ url: string; init?: RequestInit }>,
    teardown: [] as Array<{ url: string; init?: RequestInit }>,
    switch: [] as Array<{ url: string; init?: RequestInit }>,
    clear: [] as Array<{ url: string; init?: RequestInit }>,
    grouped: 0,
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
    if (url.endsWith('/api/media-workloads/grouped')) {
      calls.grouped += 1
      if (opts.groupedGate && opts.groupedDelayAfter != null && calls.grouped > opts.groupedDelayAfter) {
        await opts.groupedGate
      }
      return json(groupedResponse)
    }
    if (url.endsWith('/api/facility/summary')) {
      const sites = opts.facilitySites ?? [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }]
      return json({ site_count: sites.length, device_count: 0, sites })
    }
    const topoMatch = url.match(/\/api\/media-workloads\/([^/]+)\/topology$/)
    if (topoMatch) {
      const name = decodeURIComponent(topoMatch[1])
      const status = opts.topologyStatus?.[name]
      if (status != null) return json({ error: 'receiver-not-found', detail: 'no catalog entry' }, status)
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
      if (opts.clearDelay) await opts.clearDelay
      if (opts.clearStatus) return json({ error: 'nope' }, opts.clearStatus)
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
  return { ...calls, calls, fetchMock, releaseSwitch: () => releaseSwitch?.(), setWorkload: (next: MediaWorkload) => { wl = next } }
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

// Scope assertions to one flow step via its <h2>, not aria landmark
// inference — robust regardless of how <section aria-label> maps to roles.
function stageSection(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: label, level: 2 })
  return heading.closest('section') as HTMLElement
}

/**
 * ARC B: the flow folds. Only the step the workload is AT is pinned open;
 * every other openable step is collapsed behind a Review control, and a
 * locked step renders no body at all.
 *
 * So a test that reaches into a step it did not navigate to must open it
 * first, exactly as the operator would. This helper is deliberately NOT a
 * bypass — it clicks the same control the operator clicks, and it cannot
 * open a locked step (there is no Review control on one), which is what
 * keeps these tests honest about what the gate actually permits.
 */
function openStep(label: string): HTMLElement {
  const section = stageSection(label)
  const review = within(section).queryByRole('button', { name: 'Review' })
  if (review) fireEvent.click(review)
  return stageSection(label)
}

const REASON_PLACEHOLDER = 'Reason (required, recorded in the audit trail)'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---- rail: all six stages, every state -------------------------------

describe('the flow is five steps under a six-stage vocabulary', () => {
  // ARC B replaces S1's "six stage cards always visible". The MODEL is
  // unchanged and still has to be taught in full — an EBU-literate viewer
  // must be able to count six — but the WORKING FLOW covers the five
  // orchestration stages, because Operate is something you watch rather
  // than something you work through. Both halves are asserted here, and
  // together they are the pedagogy guarantee umbrella #200 tests for.
  it('renders five worked steps for every backend lifecycle value, including unknown', async () => {
    for (const lifecycle of ['provision', 'configure', 'operate', 'unknown'] as const) {
      cleanup()
      mkFetch({ workload: workload({ lifecycle }) })
      renderDetail()
      await screen.findByRole('heading', { name: 'studio-a' })
      for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']) {
        expect(stageSection(label), `${label} @ lifecycle=${lifecycle}`).toBeTruthy()
      }
      // Operate has no step, at any lifecycle value.
      expect(
        screen.queryByRole('heading', { name: 'Operate', level: 2 }),
        `Operate must not be a step @ lifecycle=${lifecycle}`,
      ).toBeNull()
    }
  })

  it('names all six lifecycle stages in the vocabulary strip, verbatim, Operate included', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const strip = screen.getByRole('navigation', { name: 'Media workload lifecycle' })
    for (const label of [
      'Design',
      'Plan',
      'Provision',
      'Configure',
      'Operate',
      'Finalise & Review',
    ]) {
      expect(within(strip).getByText(label), `${label} missing from the strip`).toBeTruthy()
    }
  })

  it('makes the Operate chip a link out to the monitoring surface, not a step', async () => {
    mkFetch({ workload: workload({ lifecycle: 'operate' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const strip = screen.getByRole('navigation', { name: 'Media workload lifecycle' })
    const operate = within(strip).getByRole('link', { name: 'Operate' })
    expect(operate.getAttribute('href')).toBe('/media-workloads/studio-a/operate')
  })

  it('regroups the strip into five orchestration chips plus a Control group holding Operate', async () => {
    // Per the operator's 2026-08-02 ruling: Operate is not a sixth step of
    // the orchestration flow, it sits in the Control vertical. The strip
    // must render that as a visible group split, not just a flat six.
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const strip = screen.getByRole('navigation', { name: 'Media workload lifecycle' })
    expect(within(strip).getByText('Control'), 'Control group label missing').toBeTruthy()

    const chipTexts = within(strip)
      .getAllByText(/^(Design|Plan|Provision|Configure|Finalise & Review|Control|Operate)$/)
      .map((el) => el.textContent)
    expect(chipTexts).toEqual([
      'Design',
      'Plan',
      'Provision',
      'Configure',
      'Finalise & Review',
      'Control',
      'Operate',
    ])
  })

  it('marks the workload as operating and points at monitoring rather than losing it', async () => {
    // `current` is null at Operate exactly as it is on an undetermined
    // position, so the page must distinguish the two. This is the
    // off-flow half; the undetermined half is asserted below.
    mkFetch({ workload: workload({ lifecycle: 'operate' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const panel = screen.getByText(/This workload is operating/)
    expect(panel).toBeTruthy()
    expect(screen.getByRole('link', { name: 'open the monitoring view' })).toBeTruthy()
    expect(screen.queryByText(/could not place this workload/)).toBeNull()

    // Operate is the Control vertical (operator ruling 2026-08-02), not a
    // lifecycle stage — the panel copy must say so, not the overturned claim.
    expect(panel.textContent).toContain('Control vertical')
    expect(panel.textContent).not.toContain('is a lifecycle stage')
  })
})

describe('the honest undetermined flow (backend lifecycle=unknown)', () => {
  it('opens no step and says so honestly, instead of guessing', async () => {
    mkFetch({ workload: workload({ lifecycle: 'unknown' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    expect(screen.getByText(/could not place this workload in its lifecycle/)).toBeTruthy()
    expect(screen.queryByText('Now')).toBeNull()
    // Not the off-flow message: an unreadable workload and an operating one
    // both report no current step, and the page must not blur them.
    expect(screen.queryByText(/This workload is operating/)).toBeNull()

    // The three runtime steps are locked, rendered as prose with no control
    // — never a guessed position, never a dead button.
    for (const label of ['Provision', 'Configure', 'Finalise & Review']) {
      const section = stageSection(label)
      expect(within(section).queryByRole('button'), `${label} bears a control`).toBeNull()
    }
  })

  it('keeps Design and Plan readable, because a choice already made is still a fact', async () => {
    // Carried over from S1 deliberately. Design and Plan describe CHOICES,
    // not runtime, so an unreadable position is no reason to hide them —
    // locking them would withhold truth the console is holding. They read
    // as `record` rather than `complete`, because "complete" would claim
    // the workload got past them and that is exactly what is unknown.
    mkFetch({ workload: workload({ lifecycle: 'unknown' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    for (const label of ['Design', 'Plan']) {
      expect(stageSection(label).getAttribute('data-step-state')).toBe('record')
    }
    expect(within(openStep('Design')).getByText('MXL Crosspoint')).toBeTruthy()
  })
})

describe('locked steps are always prose, never a control', () => {
  it('lifecycle=provision: Configure and Finalise explain themselves with no button', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    // S1 asserted this on 'not-applicable' stage cards, which rendered
    // their own explanatory prose. Arc B gates them instead: the step is
    // locked and states the reason, and — the stronger property — renders
    // no body at all, so there is nothing inside to disable.
    const configureSection = stageSection('Configure')
    expect(configureSection.getAttribute('data-step-state')).toBe('locked')
    expect(within(configureSection).getByText(/there is no source to select/)).toBeTruthy()
    expect(within(configureSection).queryByRole('button')).toBeNull()

    const finaliseSection = stageSection('Finalise & Review')
    expect(finaliseSection.getAttribute('data-step-state')).toBe('locked')
    expect(within(finaliseSection).getByText(/nothing to tear down/)).toBeTruthy()
    expect(within(finaliseSection).queryByRole('button', { name: /Teardown/ })).toBeNull()

    // Only Provision — the one authorised action at this lifecycle — bears
    // a deploy control, and it is the pinned step so it needs no expanding.
    expect(within(stageSection('Provision')).getByRole('button', { name: '▶ Deploy' })).toBeTruthy()
  })

  it('renders the desired-state clear control on Provision, under the rail, and never on Finalise', async () => {
    // GATE-S1 P1: this control used to render on Finalise OUTSIDE the action
    // model, so it survived the not-applicable rule and the busy suppression
    // alike. It is a provision-time action — it moves a workload from "no
    // active intent" to an active one — so it now flows through
    // stageActions('provision') like every other write.
    const wl = workload({
      lifecycle: 'provision',
      instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
    })
    mkFetch({ workload: wl })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    expect(
      within(stageSection('Provision')).getByRole('button', { name: 'Clear for deployment' }),
    ).toBeTruthy()

    const finaliseSection = stageSection('Finalise & Review')
    expect(within(finaliseSection).getByText(/nothing to tear down/)).toBeTruthy()
    expect(
      within(finaliseSection).queryByRole('button', { name: 'Clear for deployment' }),
    ).toBeNull()
  })

  it('suppresses the clear control while a job is in flight, like every other action', async () => {
    // The point of bringing it under the model: busy suppression now reaches
    // it. Before, a NetBox intent flip could fire mid-job.
    const wl = workload({
      lifecycle: 'provision',
      instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
    })
    mkFetch({ workload: wl })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    // Arm and fire a deploy so a launch job is in flight.
    const provision = stageSection('Provision')
    fireEvent.click(within(provision).getByRole('button', { name: /Deploy/ }))
    // Scope to the reason field: the deploy panel also carries the optional
    // workload-slug input, so an unscoped textbox query is ambiguous.
    fireEvent.change(within(provision).getAllByRole('textbox')[0], { target: { value: 'go' } })
    fireEvent.click(within(provision).getByRole('button', { name: /Confirm deploy/ }))

    await waitFor(() =>
      expect(
        within(stageSection('Provision')).queryByRole('button', { name: 'Clear for deployment' }),
      ).toBeNull(),
    )
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

    const configureSection = openStep('Configure')
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
    const finaliseSection = openStep('Finalise & Review')
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
    const configureSection = openStep('Configure')
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

    const finaliseSection = openStep('Finalise & Review')
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
    const finaliseSection = openStep('Finalise & Review')
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

    const configureSection = openStep('Configure')
    // Finalise is opened up front so the teardown control's disappearance
    // below is a real suppression, not merely a step that stayed folded.
    openStep('Finalise & Review')
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

    const designSection = openStep('Design')
    expect(within(designSection).getByText('MXL Viewer')).toBeTruthy()
    expect(within(designSection).getByText('Renders a media flow.')).toBeTruthy()
    expect(await within(designSection).findByText(/composed of/)).toBeTruthy()
    // Design carries no ACTION. The only button in the step is FlowStep's
    // own disclosure control — chrome, not an affordance the stage offers —
    // so the assertion names it rather than banning buttons outright, which
    // would now fail for a reason that has nothing to do with the invariant.
    const designButtons = within(designSection)
      .queryAllByRole('button')
      .map((b) => b.textContent)
    expect(designButtons).toEqual(['Hide'])
  })

  // umbrella #339 item 5: this is the state that produced the 404s — the
  // function key is gone from the catalog, so its instance has no topology.
  // The drift warning was always right; only the fetch treated the answer as
  // a failure. Deliberately a PRESERVATION guard, not a discriminator — it
  // passes against the old hook too, and it should, because "keeps rendering
  // exactly as it does" is the requirement. The behaviour that changed is
  // pinned in instanceTopology.test.tsx, on the hook.
  it('keeps the catalog-drift warning when the instance has no topology to fetch', async () => {
    mkFetch({
      workload: viewerWorkload(),
      catalog: [],
      topologyStatus: { 'viewer-1': 404 },
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    // Arc B folds the flow: this fixture is a viewerWorkload (lifecycle
    // 'operate'), so no step is pinned and Design is collapsed. The
    // assertion is unchanged — only the step has to be opened first, the
    // same click the operator makes.
    const designSection = openStep('Design')
    expect(
      await within(designSection).findByText(/isn't in the current catalog/),
    ).toBeTruthy()
    // No composition line, and no failure surfaced in its place: "there is no
    // topology here" is an answer, not an error to report.
    expect(within(designSection).queryByText(/composed of/)).toBeNull()
    expect(within(designSection).queryByText(/could not|failed|error/i)).toBeNull()
  })
})

describe('Plan: the assigned facility', () => {
  it('links to the single registered facility', async () => {
    mkFetch({ facilitySites: [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 4 }] })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })
    const planSection = openStep('Plan')
    const link = await within(planSection).findByRole('link', { name: 'dmf-lab' })
    expect(link.getAttribute('href')).toBe('/facilities/dmf-lab')
  })

  it('gives an honest non-answer when no facility is registered, never a guess', async () => {
    mkFetch({ facilitySites: [] })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })
    const planSection = openStep('Plan')
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

// ---------------------------------------------------------------------------
// GATE-S1-RV: each defect class gets a test that FAILS if the fix is reverted.
// ---------------------------------------------------------------------------

describe('a clear in flight owns the rail like any other write', () => {
  it('suppresses Deploy and sibling clears while a clear POST is pending', async () => {
    // Before the fix, clear owned a private mutation the stage could not see,
    // so Deploy and other instances' clears stayed live mid-write.
    let releaseClear: (v: unknown) => void = () => {}
    const wl = workload({
      lifecycle: 'provision',
      instances: [
        instance({ instance: 'mxl-a', requested_state: 'bootstrapped', observed_state: 'unknown' }),
        instance({ instance: 'mxl-b', requested_state: 'bootstrapped', observed_state: 'unknown' }),
      ],
    })
    mkFetch({
      workload: wl,
      // Hold the clear POST open so "pending" is observable.
      clearDelay: new Promise((r) => { releaseClear = r }),
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const provision = stageSection('Provision')
    const clears = within(provision).getAllByRole('button', { name: 'Clear for deployment' })
    expect(clears).toHaveLength(2)

    fireEvent.click(clears[0])
    fireEvent.change(within(provision).getByRole('textbox'), { target: { value: 'go' } })
    fireEvent.click(within(provision).getByRole('button', { name: 'Confirm' }))

    // While the POST is open the whole write surface is suppressed.
    await waitFor(() =>
      expect(within(stageSection('Provision')).queryAllByRole('button', { name: 'Clear for deployment' }))
        .toHaveLength(0),
    )
    expect(within(stageSection('Provision')).queryByRole('button', { name: /Deploy/ })).toBeNull()

    // ...and comes BACK when it completes. This half is the discriminator:
    // suppression that never lifts is not suppression, it is a dead rail.
    // The control used to OWN the mutation from inside this hidden subtree,
    // so firing it unmounted its own owner and the pending flag could never
    // fall (GATE-S1-RV2 P1).
    releaseClear(null)
    await waitFor(() =>
      expect(within(stageSection('Provision')).queryByRole('button', { name: /Deploy/ }))
        .not.toBeNull(),
    )
  })
})

describe('a successful clear closes its own loop', () => {
  it('re-reads the grouped inventory instead of leaving a stale repeatable action', async () => {
    // The control decides whether to render from the inventory. Without
    // invalidation the already-taken action stayed clickable until the 15s
    // poll — the operator could fire it twice at a state that had moved.
    const wl = workload({
      lifecycle: 'provision',
      instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
    })
    const h = mkFetch({ workload: wl })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const before = h.calls.grouped
    const provision = stageSection('Provision')
    fireEvent.click(within(provision).getByRole('button', { name: 'Clear for deployment' }))
    fireEvent.change(within(provision).getByRole('textbox'), { target: { value: 'go' } })
    fireEvent.click(within(provision).getByRole('button', { name: 'Confirm' }))

    // The fixture TRANSITIONS, as the real backend would: the instance is now
    // cleared, so the next read no longer reports it as bootstrapped. With a
    // SINGLE member now active and healthy the backend's derivation is
    // `operate` (all_active + all_healthy), not `configure` — configure is
    // what it returns while some member still lags.
    h.setWorkload(
      workload({
        lifecycle: 'operate',
        instances: [instance({ requested_state: 'active', observed_state: 'running' })],
      }),
    )

    await waitFor(() => expect(h.calls.grouped).toBeGreaterThan(before))
    // The DISAPPEARANCE is the claim: asserting only that a refetch happened
    // would pass even if the control ignored the new inventory.
    await waitFor(() =>
      expect(
        within(stageSection('Provision')).queryByRole('button', { name: 'Clear for deployment' }),
      ).toBeNull(),
    )
  })
})

describe("clearing one sibling never strands the other (GATE-S1-RV3 P1)", () => {
  it('keeps the second bootstrapped instance clearable after the first is cleared', async () => {
    // Codex's exact scenario. Clearing one member flips the backend
    // derivation to configure (any_active wins), which used to withdraw the
    // clear affordance from the rail and strand the remaining sibling with
    // no path forward at all.
    const h = mkFetch({
      workload: workload({
        lifecycle: 'provision',
        instances: [
          instance({ instance: 'mxl-a', requested_state: 'bootstrapped', observed_state: 'unknown' }),
          instance({ instance: 'mxl-b', requested_state: 'bootstrapped', observed_state: 'unknown' }),
        ],
      }),
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })
    expect(
      within(stageSection('Provision')).getAllByRole('button', { name: 'Clear for deployment' }),
    ).toHaveLength(2)

    const provision = stageSection('Provision')
    fireEvent.click(within(provision).getAllByRole('button', { name: 'Clear for deployment' })[0])
    fireEvent.change(within(provision).getByRole('textbox'), { target: { value: 'go' } })
    fireEvent.click(within(provision).getByRole('button', { name: 'Confirm' }))

    // The backend now derives `configure`: one member active, one still not.
    h.setWorkload(
      workload({
        lifecycle: 'configure',
        instances: [
          instance({ instance: 'mxl-a', requested_state: 'active', observed_state: 'running' }),
          instance({ instance: 'mxl-b', requested_state: 'bootstrapped', observed_state: 'unknown' }),
        ],
      }),
    )

    // The surviving sibling keeps a reachable clear path, and the rail still
    // reports the backend's position honestly.
    await waitFor(() =>
      expect(
        within(stageSection('Provision')).queryAllByRole('button', { name: 'Clear for deployment' }),
      ).toHaveLength(1),
    )
  })
})

describe('failure and loop-closure are visible and atomic', () => {
  it('shows a clear failure at stage level, after the confirm panel closes', async () => {
    const h = mkFetch({
      workload: workload({
        lifecycle: 'provision',
        instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
      }),
      clearStatus: 500,
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const provision = stageSection('Provision')
    fireEvent.click(within(provision).getByRole('button', { name: 'Clear for deployment' }))
    fireEvent.change(within(provision).getByRole('textbox'), { target: { value: 'go' } })
    fireEvent.click(within(provision).getByRole('button', { name: 'Confirm' }))

    // Panel closed, failure still stated — no re-arming required to see it.
    await waitFor(() =>
      expect(within(stageSection('Provision')).getByText(/was not recorded/)).toBeTruthy(),
    )
    expect(within(stageSection('Provision')).queryByRole('textbox')).toBeNull()
    expect(h.calls.clear).toHaveLength(1)
  })

  it('holds the write pending until the refreshed inventory lands', async () => {
    // The slow-refetch interval: with a fire-and-forget invalidation, `busy`
    // fell first and a stale Clear/Deploy flashed back while NetBox was
    // still being re-read.
    let releaseGrouped: (v: unknown) => void = () => {}
    const h = mkFetch({
      workload: workload({
        lifecycle: 'provision',
        instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
      }),
      groupedDelayAfter: 1,
      groupedGate: new Promise((r) => { releaseGrouped = r }),
    })
    renderDetail()
    await screen.findByRole('heading', { name: 'studio-a' })

    const provision = stageSection('Provision')
    fireEvent.click(within(provision).getByRole('button', { name: 'Clear for deployment' }))
    fireEvent.change(within(provision).getByRole('textbox'), { target: { value: 'go' } })
    fireEvent.click(within(provision).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(h.calls.clear).toHaveLength(1))
    // While the re-read is outstanding the write surface stays withdrawn.
    expect(within(stageSection('Provision')).queryByRole('button', { name: /Deploy/ })).toBeNull()

    releaseGrouped(null)
    await waitFor(() =>
      expect(within(stageSection('Provision')).queryByRole('button', { name: /Deploy/ })).not.toBeNull(),
    )
  })
})
