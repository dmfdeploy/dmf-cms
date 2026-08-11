/**
 * The workload detail wizard + its EBU lifecycle rail (umbrella #347 WO-D1,
 * operator direction 2026-08-02: "one lifecycle step visible at a time,
 * Next/Previous, the EBU-colored rail as the prominent navigation spine").
 *
 * The single most important thing this file proves is that the deploy /
 * switch / teardown click paths SURVIVED the restructure from an
 * all-steps-mounted accordion (Arc B) to a single-step-mounted wizard: arm →
 * nothing fires → reason (and, for switch, a target) required → Confirm →
 * exactly one POST with the expected body → the job/outcome renders.
 *
 * Alongside that: every stage renders at every reachable state, a locked
 * step is always prose with no rail control (never a control anywhere), no
 * stage ever renders an action lib/workloadLifecycle.ts's stageActions() did
 * not authorise, the null-active (`lifecycle: 'unknown'`) case renders the
 * honest undetermined rail, and — the cross-stage architectural risk this
 * page's design takes on — a job in flight on ONE stage suppresses
 * navigation everywhere, not just its own stage's action.
 *
 * The wizard-specific navigation contract (Previous/Next/rail selection
 * gating, job ownership, membership-change-while-pending) has its own
 * dedicated regression suite in workloadDetailWizard.test.tsx — that file is
 * this WO's required Acceptance Criterion 1 test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
import MediaWorkloads from '../pages/MediaWorkloads'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import type {
  CatalogEntry,
  MediaWorkload,
  MediaWorkloadInstance,
  MediaWorkloadsGroupedResponse,
  UserIdentity,
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

// umbrella dmfdeploy/dmfdeploy#378: the shape the precedent test at
// "renders the desired-state clear control on Provision..." already
// establishes as delete-permanently-eligible on member state alone — every
// member bootstrapped (nothing cleared to run), none observed running. The
// three gate tests below start from this and violate exactly one further
// fact each.
function purgeEligibleWorkload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return workload({
    lifecycle: 'provision',
    instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
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
  /** Overrides merged onto the default /api/me identity (umbrella #378). */
  user?: Partial<UserIdentity>
  /** Overrides merged onto the grouped response's top-level fields. */
  grouped?: Partial<Pick<MediaWorkloadsGroupedResponse, 'configured' | 'degraded'>>
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
  /**
   * Gate /api/me reads while armed (umbrella #378b fix round) — a FLAG
   * rather than a call-count threshold (unlike groupedDelayAfter/
   * groupedGate above) because useCurrentUser() is called from more than
   * one mounted component (WorkloadWizard, FinaliseStage, ProvisionStage)
   * and react-query's default staleTime:0 means the FIRST navigation to a
   * step that mounts a second caller triggers its own incidental
   * refetch-on-mount — a real, harmless background refetch this test must
   * let settle before arming the gate, not a call index it can predict.
   * When the held read resolves, `meRejectFlag.current` (checked at that
   * moment) decides whether it throws.
   */
  meHoldFlag?: { current: boolean }
  meGate?: Promise<unknown>
  meRejectFlag?: { current: boolean }
}

function mkFetch(opts: FetchOpts = {}) {
  let wl = opts.workload ?? workload()
  const groupedResponse: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    ...opts.grouped,
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
    me: 0,
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
      calls.me += 1
      if (opts.meHoldFlag?.current && opts.meGate) {
        await opts.meGate
        if (opts.meRejectFlag?.current) throw new Error('identity refetch failed')
      }
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
        ...opts.user,
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
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // Returned so a test can drive a background refetch itself (umbrella
  // #378b fix round) — every other caller in this file already ignores it.
  return queryClient
}

/** Waits for the wizard to finish loading — the rail only mounts once the
 *  workload has resolved, replacing the old per-page hero heading wait. */
async function findRail(): Promise<HTMLElement> {
  return screen.findByRole('navigation', { name: 'Media workload lifecycle' })
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Media workload lifecycle' })
}

// Scope assertions to the wizard's currently MOUNTED step via its <h2> — the
// wizard mounts exactly one step at a time, so this only finds the step the
// operator has actually navigated to (matching what the gate genuinely
// permits — the same discipline the old accordion's openStep() enforced).
function stageSection(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: label, level: 2 })
  return heading.closest('[data-step-state]') as HTMLElement
}

/** Clicks the rail chip for `label` (must be openable — a locked step has
 *  no button to click, by design) and returns the newly-mounted section.
 *
 *  Arc 4 WP-3: the rail now registers into the header slot via a layout
 *  effect rather than rendering inline with the rest of the page (umbrella
 *  #347) — a real, structural change: some state this page's own render
 *  passes through transiently (e.g. a step briefly `locked` before a
 *  membership/identity query's `isFetching` settles) is no longer always
 *  batched into the SAME commit as the rail's own appearance the way it
 *  was when both were produced by one render. That transient state was
 *  always real; it just was not independently observable before. `waitFor`
 *  here waits it out rather than assuming the chip is already clickable
 *  the instant the rail itself is found. */
async function selectStep(label: string): Promise<HTMLElement> {
  const button = await waitFor(() => within(rail()).getByRole('button', { name: label }))
  fireEvent.click(button)
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
  it('names all five orchestration steps in the rail for every backend lifecycle value, including unknown', async () => {
    for (const lifecycle of ['provision', 'configure', 'operate', 'unknown'] as const) {
      cleanup()
      mkFetch({ workload: workload({ lifecycle }) })
      renderDetail()
      const strip = await findRail()
      for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']) {
        expect(within(strip).getByText(label), `${label} @ lifecycle=${lifecycle}`).toBeTruthy()
      }
      // Operate has no step, at any lifecycle value — it never becomes a
      // mounted wizard panel.
      expect(
        screen.queryByRole('heading', { name: 'Operate', level: 2 }),
        `Operate must not be a step @ lifecycle=${lifecycle}`,
      ).toBeNull()
    }
  })

  it('names all six lifecycle stages in the vocabulary strip, verbatim, Operate included', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    const strip = await findRail()
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
    const strip = await findRail()
    const operate = within(strip).getByRole('link', { name: 'Operate' })
    expect(operate.getAttribute('href')).toBe('/media-workloads/studio-a/operate')
  })

  it('regroups the strip into five orchestration chips plus a Control group holding Operate', async () => {
    // Per the operator's 2026-08-02 ruling: Operate is not a sixth step of
    // the orchestration flow, it sits in the Control vertical. The strip
    // must render that as a visible group split, not just a flat six.
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    const strip = await findRail()
    expect(within(strip).getByText('Control'), 'Control group label missing').toBeTruthy()

    // Arc 4 WP-3: each chip's label and state word now share one line/span
    // (the rail's single-line row), so an exact TEXT match no longer
    // isolates the label alone — aria-label does, unchanged, and reading
    // it off the DOM in document order proves the same ordering property.
    // Operate itself is not in this list: its accessible name comes from
    // its visible text content, not an aria-label, so it is checked
    // separately below.
    const knownLabels = ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review', 'Control']
    const chipLabels = Array.from(strip.querySelectorAll('[aria-label]'))
      .map((el) => el.getAttribute('aria-label'))
      .filter((label): label is string => knownLabels.includes(label ?? ''))
    expect(chipLabels).toEqual(knownLabels)

    const operateLink = within(strip).getByRole('link', { name: 'Operate' })
    const controlGroup = within(strip).getByLabelText('Control')
    expect(controlGroup.contains(operateLink), 'Operate must sit inside the Control group').toBe(true)
  })

  it('keeps EBU/layer/vertical taxonomy out of the default-level accessibility tree, reachable only behind System details', async () => {
    // Arc 4 WP-3 (umbrella #347): stage NAMES stay visible; the EBU
    // layer/vertical/function-type/lifecycle-owner ontology is expert-tier
    // vocabulary that must not reach the operator by default (Constitution
    // Art. 3). DesignStage.tsx already gates it behind a native <details>
    // disclosure — this pins that the disclosure is genuinely CLOSED by
    // default (not just present-but-styled-away), which is the actual
    // mechanism a real browser uses to withhold collapsed <details> content
    // from assistive technology.
    //
    // WHAT THIS CAN AND CANNOT PROVE (same limit as nav.test.tsx's tooltip
    // SMELL-PIN): jsdom has no rendering engine and does not implement a
    // real browser's own "collapsed <details> content is inaccessible"
    // behaviour — screen.getByRole/getByText here would find the taxonomy
    // text regardless of the <details>'s open state, because jsdom does not
    // hide it the way a real browser does. So this test does not assert
    // "getByText finds nothing" — a whole-DOM query would pass whether the
    // disclosure is closed OR ripped out entirely, and would silently stop
    // proving anything the moment it is (exactly the "a whole-DOM grep
    // cannot express this" trap the work order names). It asserts the
    // actual DOM property a real browser's accessibility computation keys
    // off: the <details> element is present, contains the taxonomy text,
    // and its own `.open` is false by default — and that it is reachable
    // by the same keyboard/tap-operable <summary> every other disclosure
    // in this console uses, not some other path.
    mkFetch({
      workload: workload({ lifecycle: 'provision' }),
      catalog: [
        catalogEntry({
          ebu_layer: 5,
          ebu_vertical: 'orchestration',
          ebu_media_function_type: 'crosspoint',
          ebu_lifecycle_owner: 'platform',
        }),
      ],
    })
    renderDetail()
    await findRail()
    const designSection = await selectStep('Design')

    // The stage NAME itself is default-level vocabulary and stays visible
    // unconditionally.
    expect(within(designSection).getByRole('heading', { name: 'Design', level: 2 })).toBeTruthy()

    const disclosure = within(designSection).getByText('System details').closest('details') as HTMLDetailsElement
    expect(disclosure, 'System details must be a native <details> disclosure').toBeTruthy()
    expect(
      disclosure.open,
      'closed by default — a real browser withholds this from the accessibility tree until opened',
    ).toBe(false)
    expect(
      within(disclosure).getByText(/EBU layer 5/),
      'the taxonomy text lives inside the disclosure, not deleted',
    ).toBeTruthy()

    // Reachable by the same tappable/keyboard-operable affordance every
    // other disclosure in this console uses — a real <summary>, not a
    // title= tooltip or a hover-only reveal.
    const summary = within(designSection).getByText('System details')
    expect(summary.tagName).toBe('SUMMARY')
    expect(summary.closest('details')).toBe(disclosure)
  })

  it('marks the workload as operating and points at monitoring rather than losing it', async () => {
    // `current` is null at Operate exactly as it is on an undetermined
    // position, so the page must distinguish the two. This is the
    // off-flow half; the undetermined half is asserted below.
    mkFetch({ workload: workload({ lifecycle: 'operate' }) })
    renderDetail()
    await findRail()

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
    const strip = await findRail()

    expect(screen.getByText(/could not place this workload in its lifecycle/)).toBeTruthy()
    expect(screen.queryByText('Now')).toBeNull()
    // Not the off-flow message: an unreadable workload and an operating one
    // both report no current step, and the page must not blur them.
    expect(screen.queryByText(/This workload is operating/)).toBeNull()

    // The three runtime steps are locked in the rail: no control at all
    // (not even a way to select them), and each states its reason.
    for (const label of ['Provision', 'Configure', 'Finalise & Review']) {
      expect(within(strip).queryByRole('button', { name: label }), `${label} bears a control`).toBeNull()
    }
  })

  it('keeps Design and Plan readable, because a choice already made is still a fact', async () => {
    // Carried over from S1/Arc B deliberately. Design and Plan describe
    // CHOICES, not runtime, so an unreadable position is no reason to hide
    // them — locking them would withhold truth the console is holding.
    // They read as `record` rather than `complete`, because "complete"
    // would claim the workload got past them and that is exactly what is
    // unknown.
    mkFetch({ workload: workload({ lifecycle: 'unknown' }) })
    renderDetail()
    await findRail()

    // Design is the wizard's default selection here (no current position,
    // not off-flow) — mounted with no navigation required.
    expect(stageSection('Design').getAttribute('data-step-state')).toBe('record')
    expect(await within(stageSection('Design')).findByText('MXL Crosspoint')).toBeTruthy()

    const planSection = await selectStep('Plan')
    expect(planSection.getAttribute('data-step-state')).toBe('record')
  })
})

describe('locked steps are always prose in the rail, never a control', () => {
  it('lifecycle=provision: Configure and Finalise explain themselves with no rail control', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    const strip = await findRail()

    // Arc B/S1 asserted this on 'not-applicable' stage cards, which rendered
    // their own explanatory prose. The wizard gates one level up: a locked
    // step has no rail control at all, and the rail itself states why —
    // behind a tap/keyboard-operable toggle now (Arc 4 WP-3), not a
    // permanent caption (does not fit the rail's single-line row).
    expect(within(strip).queryByRole('button', { name: 'Configure' })).toBeNull()
    fireEvent.click(within(strip).getByRole('button', { name: 'Why Configure is locked' }))
    expect(within(strip).getByText(/there is no source to select/)).toBeTruthy()
    expect(within(strip).queryByRole('button', { name: 'Finalise & Review' })).toBeNull()
    fireEvent.click(within(strip).getByRole('button', { name: 'Why Finalise & Review is locked' }))
    expect(within(strip).getByText(/nothing to tear down/)).toBeTruthy()

    // Provision is the one authorised action at this lifecycle, and it is
    // the workload's position — auto-selected, no navigation required. Its
    // state reads `open`, not `current`: it bears the deploy action, and
    // affordance outranks position in workloadFlow.ts's own ladder (the
    // same rule Configure/'switch-source' pins in workloadFlow.test.ts).
    const provisionSection = stageSection('Provision')
    expect(provisionSection.getAttribute('data-step-state')).toBe('open')
    expect(await within(provisionSection).findByRole('button', { name: '▶ Deploy' })).toBeTruthy()
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
    const strip = await findRail()

    expect(
      await within(stageSection('Provision')).findByRole('button', { name: 'Clear for deployment' }),
    ).toBeTruthy()

    // umbrella #347: this exact shape — every member bootstrapped, none
    // observed running — is now ALSO the delete-permanently condition, so
    // Finalise is legitimately OPEN here (not locked), offering that action
    // instead of tear-down. The regression this test actually guards
    // (GATE-S1 P1) is narrower than "Finalise stays locked": clear-for-
    // deployment must never appear there, which still holds.
    const strip2 = within(strip)
    expect(strip2.getByRole('button', { name: 'Finalise & Review' })).toBeTruthy()
    const finaliseSection = await selectStep('Finalise & Review')
    expect(within(finaliseSection).queryByRole('button', { name: 'Clear for deployment' })).toBeNull()
    expect(await within(finaliseSection).findByRole('button', { name: '🗑 Delete permanently' })).toBeTruthy()
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
    await findRail()

    // Arm and fire a deploy so a launch job is in flight.
    const provision = stageSection('Provision')
    fireEvent.click(await within(provision).findByRole('button', { name: /Deploy/ }))
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
    await findRail()

    const provisionSection = stageSection('Provision')
    fireEvent.click(await within(provisionSection).findByRole('button', { name: '▶ Deploy' }))

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
    await findRail()
    const provisionSection = stageSection('Provision')
    expect(await within(provisionSection).findByText('Already deployed.')).toBeTruthy()
    expect(within(provisionSection).queryByRole('button', { name: '▶ Deploy' })).toBeNull()
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
    await findRail()

    const configureSection = await selectStep('Configure')
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
    const finaliseSection = await selectStep('Finalise & Review')
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
    await findRail()
    const configureSection = await selectStep('Configure')
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
    await findRail()

    // lifecycle=operate is off-flow, so Finalise & Review is the wizard's
    // default selection already — selectStep still works, clicking an
    // already-selected chip is harmless.
    const finaliseSection = await selectStep('Finalise & Review')
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
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')
    expect(within(finaliseSection).queryByRole('button', { name: '⏏ Teardown' })).toBeNull()
    expect(within(finaliseSection).getByText('Not currently deployed.')).toBeTruthy()
  })
})

// ---- cross-stage suppression: the architectural risk this page takes on

describe('a job in flight suppresses navigation everywhere, not just its own stage', () => {
  it('blocks the rail while a switch is pending, then releases it — and Finalise is genuinely live after, not just reachable', async () => {
    const wl = viewerWorkload()
    const { releaseSwitch } = mkFetch({
      workload: wl,
      catalog: [catalogEntry({ key: 'viewer', lifecycle: 'active' })],
      topology: { 'viewer-1': freshTopology() },
      holdSwitch: true,
    })
    renderDetail()
    await findRail()

    const configureSection = await selectStep('Configure')
    fireEvent.click(await within(configureSection).findByRole('button', { name: 'Switch source' }))
    fireEvent.change(within(configureSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'go' },
    })
    fireEvent.change(within(configureSection).getByRole('combobox'), { target: { value: 'source-b' } })

    // Before Confirm: Finalise is still a real, navigable rail step.
    expect(within(rail()).getByRole('button', { name: 'Finalise & Review' })).toBeTruthy()

    fireEvent.click(within(configureSection).getByRole('button', { name: 'Confirm switch' }))

    // The switch is now pending (fetch is held open) — every rail selector
    // goes inert with the stated reason, not just Configure's own, and the
    // mounted panel's own Next/Previous do too.
    await waitFor(() => {
      expect(within(rail()).queryByRole('button', { name: 'Finalise & Review' })).toBeNull()
    })
    // Every rail item states the same reason — not just the acting stage's.
    expect(within(rail()).getAllByText(/A Configure job is in progress/).length).toBeGreaterThan(0)
    expect(within(stageSection('Configure')).queryByRole('button', { name: 'Next →' })).toBeNull()

    releaseSwitch()

    // Once the switch resolves, the rail is idle again and Finalise is
    // reachable — and its OWN Teardown control is live there, which is the
    // real discriminator: a suppression that silently outlived the job would
    // still show a navigable-but-dead Finalise.
    await waitFor(() => {
      expect(within(rail()).getByRole('button', { name: 'Finalise & Review' })).toBeTruthy()
    })
    const finaliseSection = await selectStep('Finalise & Review')
    expect(within(finaliseSection).getByRole('button', { name: '⏏ Teardown' })).toBeTruthy()
  })
})

// ---- Design + Plan: informational, never an action ---------------------

describe('Design: read-only template + composition', () => {
  it('shows the catalog template and the receiver composition, with no stage-owned control', async () => {
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
    await findRail()

    const designSection = await selectStep('Design')
    expect(within(designSection).getByText('MXL Viewer')).toBeTruthy()
    expect(within(designSection).getByText('Renders a media flow.')).toBeTruthy()
    expect(await within(designSection).findByText(/composed of/)).toBeTruthy()
    // Design carries no ACTION. Any button inside the mounted step is the
    // wizard's own Previous/Next navigation chrome, never a stage-owned
    // affordance — named rather than banning buttons outright, which would
    // now fail for a reason unrelated to the invariant being pinned.
    const designButtons = within(designSection)
      .queryAllByRole('button')
      .map((b) => b.textContent)
    expect(designButtons.every((t) => t === '← Previous' || t === 'Next →'), designButtons.join(',')).toBe(
      true,
    )
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
    await findRail()

    const designSection = await selectStep('Design')
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
    await findRail()
    const planSection = await selectStep('Plan')
    const link = await within(planSection).findByRole('link', { name: 'dmf-lab' })
    expect(link.getAttribute('href')).toBe('/facilities/dmf-lab')
  })

  it('gives an honest non-answer when no facility is registered, never a guess', async () => {
    mkFetch({ facilitySites: [] })
    renderDetail()
    await findRail()
    const planSection = await selectStep('Plan')
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

// ---- a crafted #configure hash can never reach a locked Configure ------

describe('a #configure deep link when Configure is locked (GATE-D1 P2.6)', () => {
  it('leaves the initial-ladder selection unchanged, announces the lock reason, and mounts no Configure control', async () => {
    // lifecycle=provision with no bootstrapped members: Configure is
    // locked (nothing has been deployed yet, so there is no source to
    // select) — Operate.tsx's "request configuration change" link is the
    // one real caller of this hash, and this proves a stale/crafted one
    // aimed at a locked step cannot reach it.
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/studio-a#configure']}>
          <Routes>
            <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
          </Routes>
          <HeaderSlotProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // Selection falls through to the SAME ladder as with no hash at all:
    // Configure is not openable, so `current` ('provision', non-null) wins
    // — the mounted panel is Provision, never Configure.
    expect(screen.getByRole('heading', { name: 'Provision', level: 2 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Configure', level: 2 })).toBeNull()

    // The lock reason is announced (role=status, aria-live=polite) rather
    // than silently doing nothing.
    const announcement = screen.getByRole('status')
    expect(announcement.textContent).toContain('Configure')
    expect(announcement.textContent).toContain('there is no source to select')

    // No Configure content is reachable anywhere on the page — not folded,
    // not hidden, simply never mounted.
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()
    expect(screen.queryByText(/Switch active source/)).toBeNull()

    // The rail itself offers no way in either: Configure is a static,
    // non-interactive item with its own stated reason.
    const rail = screen.getByRole('navigation', { name: 'Media workload lifecycle' })
    expect(within(rail).queryByRole('button', { name: 'Configure' })).toBeNull()
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
    await findRail()

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
    await findRail()

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
    await findRail()
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
    await findRail()

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
    await findRail()

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

// ---------------------------------------------------------------------------
// GATE-378: three orthogonal gates on delete-permanently, none of which
// stageActions('finalise')'s pre-existing member-state checks cover. All
// three fixtures below are otherwise-eligible per purgeEligibleWorkload
// (lifecycle=provision, every member bootstrapped, none observed running —
// the exact shape the "renders the desired-state clear control on
// Provision..." test above proves is legitimately offered) and violate
// exactly one further fact. Since delete-permanently is the ONLY action
// stageActions() can offer at Finalise while lifecycle=provision, withdrawing
// it also drops the whole step to 'locked' (nothing else makes it openable)
// — so the discriminator is the rail losing its Finalise button and stating
// the lock reason, not a stage-local "not offered" paragraph the wizard
// never mounts in this position. Precedent: "locked steps are always prose
// in the rail, never a control" above pins the identical shape for the
// pre-existing gates.
// ---------------------------------------------------------------------------

describe('delete-permanently gate: completeness (umbrella dmfdeploy/dmfdeploy#378a)', () => {
  it('withholds the affordance when the grouped read reports degraded, even for an otherwise-eligible workload', async () => {
    // The bug this guards: !isError && !isFetching is true here (the query
    // succeeded and isn't in flight) — only the widened check catches that
    // the payload itself declared members excluded.
    mkFetch({ workload: purgeEligibleWorkload(), grouped: { degraded: true } })
    renderDetail()
    const strip = await findRail()

    expect(within(strip).queryByRole('button', { name: 'Finalise & Review' })).toBeNull()
    fireEvent.click(within(strip).getByRole('button', { name: 'Why Finalise & Review is locked' }))
    expect(within(strip).getByText(/nothing to tear down/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '🗑 Delete permanently' })).toBeNull()
  })

  it('still offers it when the read is fresh, error-free, configured, and not degraded', async () => {
    // The positive control: same eligible workload, degraded left at its
    // mkFetch default (false) — proves the test above fails for the stated
    // reason, not because purgeEligibleWorkload stopped being eligible.
    mkFetch({ workload: purgeEligibleWorkload() })
    renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')
    expect(within(finaliseSection).getByRole('button', { name: '🗑 Delete permanently' })).toBeTruthy()
  })
})

describe('delete-permanently gate: authorization (umbrella dmfdeploy/dmfdeploy#378b)', () => {
  it('withholds it from a viewer inside media-engineers — the grouped read admits them, the purge endpoint does not', async () => {
    mkFetch({
      workload: purgeEligibleWorkload(),
      user: { role: 'viewer', real_role: 'viewer', groups: ['media-engineers'] },
    })
    renderDetail()
    const strip = await findRail()

    expect(within(strip).queryByRole('button', { name: 'Finalise & Review' })).toBeNull()
    expect(screen.queryByRole('button', { name: '🗑 Delete permanently' })).toBeNull()
  })

  it('withholds it from an admin viewing as viewer — the EFFECTIVE role gates, not the real one', async () => {
    mkFetch({
      workload: purgeEligibleWorkload(),
      user: { role: 'viewer', real_role: 'admin', view_as_active: true },
    })
    renderDetail()
    const strip = await findRail()

    expect(within(strip).queryByRole('button', { name: 'Finalise & Review' })).toBeNull()
    expect(screen.queryByRole('button', { name: '🗑 Delete permanently' })).toBeNull()
  })

  it('offers it to operator, engineer, and admin once every other gate passes', async () => {
    for (const role of ['operator', 'engineer', 'admin'] as const) {
      cleanup()
      mkFetch({ workload: purgeEligibleWorkload(), user: { role, real_role: role } })
      renderDetail()
      await findRail()
      const finaliseSection = await selectStep('Finalise & Review')
      expect(
        within(finaliseSection).getByRole('button', { name: '🗑 Delete permanently' }),
        `role=${role}`,
      ).toBeTruthy()
    }
  })

  // umbrella #378b fix round: !isError && !isFetching is #343's discipline
  // for membersDataTrustworthy — TanStack Query retains the PREVIOUS payload
  // during a refetch and after a failed one, so `data` alone never proves
  // freshness. Reachable via useSetViewAs(), which invalidates every query
  // (no queryKey filter) including ['user'] — an admin switching view-as to
  // viewer re-fetches /api/me while the stale admin payload still `data`.
  it('withdraws the affordance during an identity refetch, and keeps it withdrawn after that refetch fails', async () => {
    let releaseMe: (() => void) | undefined
    const meGate = new Promise<void>((resolve) => { releaseMe = resolve })
    const meHoldFlag = { current: false }
    const meRejectFlag = { current: false }
    const h = mkFetch({
      workload: purgeEligibleWorkload(),
      user: { role: 'operator', real_role: 'operator' },
      meGate,
      meHoldFlag,
      meRejectFlag,
    })

    const queryClient = renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')
    await within(finaliseSection).findByRole('button', { name: '🗑 Delete permanently' })
    const meCallsBeforeInvalidate = h.calls.me

    // NOW arm the gate, then trigger the same shape useSetViewAs() does:
    // invalidate everything, no queryKey filter.
    meHoldFlag.current = true
    meRejectFlag.current = true
    void queryClient.invalidateQueries()

    await waitFor(() => expect(h.calls.me).toBeGreaterThan(meCallsBeforeInvalidate))
    // Same structural shape as the 378a/b/c gate tests above: delete-
    // permanently is the ONLY action stageActions() can offer at Finalise
    // while lifecycle=provision, so withdrawing it (here: the identity read
    // going untrustworthy mid-refetch) drops the WHOLE step to locked and
    // the wizard's own selection ladder bounces the operator back to
    // Provision (the backend position) — the rail losing its Finalise
    // button is the discriminator, not a stage-local absence.
    await waitFor(() =>
      expect(within(rail()).queryByRole('button', { name: 'Finalise & Review' })).toBeNull(),
    )
    expect(screen.queryByRole('button', { name: '🗑 Delete permanently' })).toBeNull()

    // Release the held read — it throws (meRejectFlag was set before the
    // release). The control must stay withdrawn, never re-arm off the
    // stale-but-still-authorized payload react-query kept around.
    releaseMe?.()
    await waitFor(() => expect(queryClient.getQueryState(['user'])?.fetchStatus).toBe('idle'))
    expect(screen.queryByRole('button', { name: '🗑 Delete permanently' })).toBeNull()
  })

  // umbrella #378b: the REJECTED fix for the test above was staleTime:
  // 30_000 on useCurrentUser(). It does not remove the duplicate ['user']
  // subscriber (FinaliseStage used to call useCurrentUser() itself, purely
  // for audit fields) — it only POSTPONES the mount-triggered refetch until
  // the cache is older than the staleTime window. That is worse than no
  // fix: a deterministic bug becomes an intermittent one, and it would
  // bounce the operator off Finalise & Review on every real demo, which
  // takes well over 30s to reach that step. The real fix is ONE subscriber
  // (WorkloadWizard's own userQuery, threaded down as a prop).
  //
  // Proving that requires a STRUCTURAL assertion, not a timing one. An
  // earlier version of this test aged the cache 120s and treated surviving
  // that as proof — it wasn't. Reintroduce the duplicate subscriber with
  // staleTime: 300_000 and a 120s-old cache is still fresh: no refetch
  // fires, calls.me stays 1, the control renders, and the rejected
  // implementation passes. Any finite aging duration has the same hole one
  // staleTime value higher, which is why no aging happens here at all.
  //
  // The invariant instead: the ['user'] query has TWO observers before the
  // operator navigates (measured against this fixture, not assumed —
  // WorkloadWizard's userQuery plus ProvisionStage's own useCurrentUser(),
  // since Provision is what's mounted initially at lifecycle=provision).
  // Correct code drops to ONE the moment Finalise is selected: Provision
  // unmounts and stops observing, and Finalise never subscribes at all —
  // it takes `user` as a prop. The rejected implementation stays at TWO
  // regardless of any staleTime, because the second subscription is a
  // structural fact rather than a timing race.
  it('drops the [\'user\'] query from two observers to one on the FIRST navigation to Finalise — no bounce to Provision', async () => {
    const h = mkFetch({
      workload: purgeEligibleWorkload(),
      user: { role: 'operator', real_role: 'operator' },
    })
    const queryClient = renderDetail()
    await findRail()
    await waitFor(() => expect(h.calls.me).toBe(1))

    const userQ = queryClient.getQueryCache().find({ queryKey: ['user'] })
    // Before navigating: WorkloadWizard (mounted always) + ProvisionStage
    // (the default-selected step at lifecycle=provision).
    expect(userQ?.getObserversCount()).toBe(2)

    // First-ever navigation to Finalise & Review. Deliberately a
    // synchronous assertion (getByRole, not findByRole/await): a bounce
    // back to Provision happens within the SAME click's synchronous
    // re-render (as observed reproducing the rejected fix's failure), so an
    // awaited findBy's own polling window could let a regression pass here
    // by accident.
    const finaliseSection = await selectStep('Finalise & Review')
    // After navigating: ProvisionStage unmounted (stopped observing),
    // FinaliseStage never subscribes — WorkloadWizard alone.
    expect(userQ?.getObserversCount()).toBe(1)
    expect(within(finaliseSection).getByRole('button', { name: '🗑 Delete permanently' })).toBeTruthy()
    expect(h.calls.me).toBe(1)
  })
})

describe('delete-permanently gate: entity identity (umbrella dmfdeploy/dmfdeploy#378c)', () => {
  it('never renders the affordance for the synthetic unassigned bucket', async () => {
    mkFetch({ workload: purgeEligibleWorkload({ slug: 'unassigned', name: 'Unassigned' }) })
    renderDetail('unassigned')
    const strip = await findRail()

    expect(within(strip).queryByRole('button', { name: 'Finalise & Review' })).toBeNull()
    expect(screen.queryByRole('button', { name: '🗑 Delete permanently' })).toBeNull()
  })
})
