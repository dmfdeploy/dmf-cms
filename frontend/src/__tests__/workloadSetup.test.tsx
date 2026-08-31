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
 * dedicated regression suite in workloadSetupWizard.test.tsx (dmfdeploy#414
 * renamed from workloadDetailWizard.test.tsx) — that file is this WO's
 * required Acceptance Criterion 1 test.
 *
 * GUARD LABEL (dmfdeploy#414 gate, round 1): every test in this file is a
 * GUARD pinning pre-#414 wizard behaviour (umbrella #347 WO-D1 and the
 * fix-round history each test's own comment cites) that dmfdeploy#414 did
 * not change — only the mount route moved, from the bare slug to /setup.
 * Baseline: the pre-#414 commit on `main` (immediately before this arc's
 * own branch), where these same assertions passed identically against
 * WorkloadDetail.tsx at the bare slug. Sections explicitly titled
 * "(dmfdeploy#414)" are the exception — those pin THIS arc's own new
 * behaviour and are not guards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
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
  /**
   * dmfdeploy/dmfdeploy#390 (T2/G4 regression test): keyed by operation_id,
   * served for GET /api/operations/:id — lets a test dispatch an ASYNC
   * teardown (teardownResult carrying operation_id) and control exactly
   * what the operation poll reports, independent of the job-status mock
   * below (which the sync-only path used by every other test in this file
   * never exercises).
   */
  operationResponses?: Record<string, Record<string, unknown>>
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
    const opMatch = url.match(/\/api\/operations\/([^/]+)$/)
    if (opMatch && opts.operationResponses?.[opMatch[1]]) {
      return json(opts.operationResponses[opMatch[1]])
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
      <MemoryRouter initialEntries={[`/media-workloads/${slug}/setup`]}>
        <Routes>
          <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
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

/** Clicks the rail chip for `label` and returns the newly-mounted section.
 *
 *  dmfdeploy#405 FIX ROUND: the parenthetical this docstring used to carry
 *  here — "must be openable — a locked step has no button to click, by
 *  design" — stopped being true the moment #405 shipped: every key, locked
 *  included, is now a reachable <button> WHEN NO JOB IS IN FLIGHT
 *  (LifecycleStrip.tsx's `interactive = !jobInFlight` — a job in flight
 *  still demotes every key to an inert, non-interactive <div>, locked or
 *  not; that suppression is a different fact from locked and #405 did not
 *  touch it), specifically so a locked step CAN be clicked and read its own
 *  stated reason. `expectFinaliseWithheld` below relies on exactly that —
 *  it calls this helper on a locked Finalise & Review key on purpose, with
 *  no job in flight in any of its callers.
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

// ---- rail: exactly five keys, every state -----------------------------

describe('the rail is exactly the five orchestration steps (dmfdeploy#414)', () => {
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

  // dmfdeploy#414: supersedes the pre-#414 "names all six lifecycle stages
  // in the vocabulary strip, verbatim, Operate included" test — the Arc 4
  // WP-2 ruling that promoted Operate into the rail's vocabulary at all is
  // itself superseded (see `docs/design/DMF Console Glossary.md`'s
  // wording-pass log). Operate is not merely un-selectable now; it is not
  // present in the rail's accessibility tree in any form.
  it('renders NOTHING that reads as a sixth key — no Operate text, link, or group, anywhere in the rail', async () => {
    mkFetch({ workload: workload({ lifecycle: 'operate' }) })
    renderDetail()
    const strip = await findRail()

    expect(within(strip).queryByText('Operate')).toBeNull()
    expect(within(strip).queryByRole('link', { name: 'Operate' })).toBeNull()
    expect(within(strip).queryByRole('link')).toBeNull()
    expect(within(strip).queryByLabelText('Control')).toBeNull()
    expect(within(strip).queryByRole('group')).toBeNull()

    // Exactly five aria-labelled keys, nothing more — the same explicit,
    // unambiguous isolator the pre-#414 version of this suite used to prove
    // chip ordering, now also proving there is no sixth.
    const knownLabels = ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']
    const chipLabels = Array.from(strip.querySelectorAll('[aria-label]'))
      .map((el) => el.getAttribute('aria-label'))
      .filter((label): label is string => label !== null)
    expect(chipLabels).toEqual(knownLabels)
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

  it('marks the workload as operating and points home rather than losing it', async () => {
    // `current` is null at Operate exactly as it is on an undetermined
    // position, so the page must distinguish the two. This is the
    // off-flow half; the undetermined half is asserted below.
    mkFetch({ workload: workload({ lifecycle: 'operate' }) })
    renderDetail()
    await findRail()

    const panel = screen.getByText(/This workload is operating/)
    expect(panel).toBeTruthy()
    // dmfdeploy#414: the retired /operate route is gone — this now points
    // at the workload's home (the bare slug), not a "monitoring view" link.
    const link = screen.getByRole('link', { name: 'open the live view' })
    expect(link.getAttribute('href')).toBe('/media-workloads/studio-a')
    expect(screen.queryByText(/could not place this workload/)).toBeNull()

    // Operate isn't a step in this flow, not a lifecycle stage — the panel
    // copy must say so, not the overturned "is a lifecycle stage" claim.
    // Arc 4 WP-3 taxonomy sweep (umbrella #347): the EBU "Control vertical"
    // naming this used to carry is expert-tier vocabulary that must not
    // reach the operator at default level (Art. 3) — this default-level
    // banner has no System details disclosure to hide it behind, so the
    // fix is dropping the ontology name from the copy entirely, not
    // relocating it.
    expect(panel.textContent).not.toContain('vertical')
    expect(panel.textContent).not.toContain('EBU')
    expect(panel.textContent).not.toContain('is a lifecycle stage')
  })
})

// umbrella #432 G1: FlowStep used to render a fixed "The workload is here
// now" caption beside its own state badge, driven by `isCurrentPosition`
// (activeStep === the backend's position) — independent of which STATE
// badge that step actually carried. CORRECTION to the originating report's
// premise, found while building this test: the badge next to it is "Now"
// ONLY while that step's OWN job is in flight (classifyWorkloadFlow's
// ladder puts `stageActions().length > 0` — i.e. "open"/Ready — ahead of
// "is the position" — i.e. "current"/Now — and provision/configure always
// have a real action the instant they are NOT busy: deploy, switch-source).
// So the FAR MORE COMMON case is the position sitting behind a "Ready"
// badge, not "Now" — the caption was never purely a "Now" echo; it was
// redundant with the RAIL's own position marker at the time (aria-current
// "step" + PositionTally, mounted directly above via the header slot).
//
// FIX ROUND (orchestrator/codex gate, redesign): that rail-side position
// marker this comment used to point to is GONE — removed entirely, not
// restyled (see LifecycleStrip.tsx's own docstring point B: the backend
// can never derive design/plan/finalise as a position, so a marker could
// only ever land on two of five keys, and aria-current="step" contradicted
// the IA doc's #493 "peer view, not a gated sequence" amendment). This
// comment's OWN claim — that the caption was redundant with the rail's
// marker — is now a historical fact about why the caption stayed removed,
// not a description of anything currently on screen. Both cases below are
// still pinned; neither ever asserted on the rail's marker directly, so
// nothing here needed re-pointing beyond this comment.
//
// DISCRIMINATING at the wizard level, not FlowStep's own unit tests:
// FlowStep's `isCurrentPosition` prop was removed outright (see
// FlowStep.tsx), so a FlowStep-only test can no longer pass the pre-fix
// true/false split at all — swapping the pre-fix FlowStep.tsx back in under
// a caller that no longer supplies the prop would just read `undefined`
// there, which is ALSO falsy, and the caption would stay absent for a
// reason that has nothing to do with the fix. Mounting the real wizard
// exercises the actual wiring instead.
describe('umbrella #432 G1: no "here now" caption beside the position badge', () => {
  it('never renders it beside "Ready" — the common case: positioned here, with an action still open', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await findRail()
    const provisionSection = stageSection('Provision')

    expect(within(provisionSection).getByText('Ready')).toBeTruthy()
    expect(within(provisionSection).queryByText('The workload is here now')).toBeNull()
    expect(screen.queryByText('The workload is here now')).toBeNull()
  })

  it('never renders it beside "Now" either — reached only while THIS step\'s own job is in flight', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await findRail()
    const provisionSection = stageSection('Provision')

    fireEvent.click(await within(provisionSection).findByRole('button', { name: '▶ Deploy' }))
    fireEvent.change(within(provisionSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'demo launch' },
    })
    fireEvent.click(within(provisionSection).getByRole('button', { name: 'Confirm deploy' }))

    await waitFor(() => expect(within(provisionSection).getByText('Now')).toBeTruthy())
    expect(within(provisionSection).queryByText('The workload is here now')).toBeNull()
    expect(screen.queryByText('The workload is here now')).toBeNull()
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

    // dmfdeploy#405 FIX ROUND: the three runtime steps are locked, but a
    // locked key is now a real, reachable <button> (LifecycleStrip.tsx's
    // P1/P2) sharing the OPEN key's own accessible name — a bare
    // `queryByRole('button', { name: label })).toBeNull()` no longer proves
    // "locked" (it would also match the permitting case's own button). The
    // LOAD-BEARING discriminator is the key's own stated LOCKED description
    // (P3), plus navigating in and confirming FlowStep's locked branch
    // renders the reason (P5) — that reason text is a single ternary branch
    // in FlowStep.tsx, so finding it already proves the stage's real
    // children never mounted, by construction. The control-name checks below
    // (scoped to the section AND page-wide) are added defense-in-depth, not
    // an independent proof of their own: this fixture's default catalog/
    // topology (a single matching catalog entry, `{}` topology for every
    // instance) mean a stage COULD fail to render its control for a reason
    // that has nothing to do with the lock gate at all (Configure's own
    // no-topology bail-out, in particular) — so their absence here is
    // consistent with the lock holding, not separate proof that it does.
    const LOCKED_REASON_TEXT: Record<string, RegExp> = {
      Provision: /the workload can be read again/,
      Configure: /there is no source to select/,
      'Finalise & Review': /nothing to tear down/,
    }
    const STAGE_CONTROL_NAME: Record<string, RegExp> = {
      Provision: /Deploy/,
      Configure: /Switch source/,
      'Finalise & Review': /Teardown|Delete permanently/,
    }
    for (const label of ['Provision', 'Configure', 'Finalise & Review']) {
      const reasonText = LOCKED_REASON_TEXT[label]
      const chipEl = within(strip).getByRole('button', { name: label })
      expect(within(chipEl).getByText(reasonText), `${label} chip states its own lock`).toBeTruthy()

      const section = await selectStep(label)
      expect(section.getAttribute('data-step-state'), `${label} section state`).toBe('locked')
      expect(within(section).getByText(reasonText), `${label} section prose`).toBeTruthy()
      expect(
        within(section).queryByRole('button', { name: STAGE_CONTROL_NAME[label] }),
        `${label} control mounted inside its own locked section`,
      ).toBeNull()
      expect(
        screen.queryByRole('button', { name: STAGE_CONTROL_NAME[label] }),
        `${label} control leaked somewhere else on the page`,
      ).toBeNull()
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

describe('a locked step is reachable and explains itself, but a stage control never mounts', () => {
  it('lifecycle=provision: Configure and Finalise explain themselves, offering no stage action', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    const strip = await findRail()

    // Provision is the one authorised action at this lifecycle, and it is
    // the workload's position — auto-selected, no navigation required. Its
    // state reads `open`, not `current`: it bears the deploy action, and
    // affordance outranks position in workloadFlow.ts's own ladder (the
    // same rule Configure/'switch-source' pins in workloadFlow.test.ts).
    // Checked FIRST, before the locked-step navigation below moves the
    // wizard's single mounted panel away from it — this page mounts exactly
    // one step at a time, so `stageSection('Provision')` would find nothing
    // once Configure or Finalise is selected.
    const provisionSection = stageSection('Provision')
    expect(provisionSection.getAttribute('data-step-state')).toBe('open')
    expect(await within(provisionSection).findByRole('button', { name: '▶ Deploy' })).toBeTruthy()

    // Arc B/S1 asserted this on 'not-applicable' stage cards, which rendered
    // their own explanatory prose. The wizard gates one level up: a locked
    // step never mounts a stage control OF ITS OWN KIND — the KEY itself is
    // now a control (see below), but its stage body never is.
    //
    // dmfdeploy#405 FIX ROUND: the discriminator used to be a bare
    // `queryByRole('button', { name: label })).toBeNull()` plus a click on
    // the separate "Why <label> is locked" disclosure toggle — both gone.
    // #405 made the key ITSELF the disclosure: every rail key, locked
    // included, is now a reachable <button> sharing the OPEN key's own
    // accessible name (LifecycleStrip.tsx P1/P2), so a bare button-absence
    // check no longer proves anything, and the standalone toggle it used to
    // click no longer exists. The LOAD-BEARING discriminator is the key's
    // own stated LOCKED description (P3), plus navigating in (the whole
    // point of #405) and confirming FlowStep's locked branch renders the
    // reason (P5) — a single ternary branch, so finding it already proves
    // the stage's real children never mounted. The control-name checks below
    // (scoped to the section AND page-wide) are added defense-in-depth, not
    // independent proof on their own: this fixture's topology defaults to
    // `{}` for every instance, so Configure's own no-topology bail-out could
    // independently explain "Switch source" being absent regardless of which
    // one is actually doing the withholding.
    const configureChip = within(strip).getByRole('button', { name: 'Configure' })
    expect(within(configureChip).getByText(/there is no source to select/)).toBeTruthy()
    const configureSection = await selectStep('Configure')
    expect(configureSection.getAttribute('data-step-state')).toBe('locked')
    expect(within(configureSection).getByText(/there is no source to select/)).toBeTruthy()
    expect(within(configureSection).queryByRole('button', { name: 'Switch source' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()

    const finaliseChip = within(strip).getByRole('button', { name: 'Finalise & Review' })
    expect(within(finaliseChip).getByText(/nothing to tear down/)).toBeTruthy()
    const finaliseSection = await selectStep('Finalise & Review')
    expect(finaliseSection.getAttribute('data-step-state')).toBe('locked')
    expect(within(finaliseSection).getByText(/nothing to tear down/)).toBeTruthy()
    expect(within(finaliseSection).queryByRole('button', { name: /Teardown|Delete permanently/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Teardown|Delete permanently/ })).toBeNull()
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
    expect(await within(finaliseSection).findByRole('button', { name: 'Delete permanently' })).toBeTruthy()
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

  // umbrella #432 §D1: exactly one cyan promoted control per screen — the
  // rule ProvisionStage.tsx's own comment states and WorkloadSetup's
  // nextIsPrimary composes from ProvisionStage's reported eligibility.
  //
  // ONLY ONE BRANCH IS REACHABLE HERE, AND THAT IS STATED RATHER THAN
  // HIDDEN. `deploy` is only ever an offered action while
  // `input.lifecycle === 'provision'` exactly (lib/workloadLifecycle.ts's
  // stageActions), and classifyWorkloadFlow's own ladder locks Configure
  // (so FlowStep's Next does not render AT ALL — `canNext` is false, not
  // merely non-primary) until the workload's position has moved PAST
  // provision — which structurally means lifecycle is no longer
  // 'provision'. A live "▶ Deploy" offer and a visible Next can therefore
  // never coexist on screen for this real, backend-driven wizard: whenever
  // Next is reachable on Provision, `eligibleDeployEntries` is provably
  // empty (deploy was never an offered action to begin with), so
  // `hasPromotedAction` is always false there. The "neutral while offered"
  // branch this rule also requires IS reachable — in the DRAFT wizard,
  // where Next is UNCONDITIONAL on lock state by design (CreateWorkload.tsx's
  // own file docstring) — see createWorkload.test.tsx's identically-named
  // describe block for both branches proven together.
  describe('umbrella #432 §D1: Next carries primary weight only when the mounted step has none of its own', () => {
    it('is primary on Provision once its position has moved on (no deploy action left to offer)', async () => {
      mkFetch({ workload: workload({ lifecycle: 'configure' }) })
      renderDetail()
      await findRail()
      const provisionSection = await selectStep('Provision')
      const next = within(provisionSection).getByRole('button', { name: 'Next →' })
      expect(next.className.split(/\s+/)).toContain('btn-primary')
      expect(next.className.split(/\s+/)).not.toContain('btn-secondary')
    })

    it('is primary on Design, which never renders a promoted action of its own', async () => {
      mkFetch({ workload: workload({ lifecycle: 'provision' }) })
      renderDetail()
      await findRail()
      const designSection = await selectStep('Design')
      const next = within(designSection).getByRole('button', { name: 'Next →' })
      expect(next.className.split(/\s+/)).toContain('btn-primary')
      expect(next.className.split(/\s+/)).not.toContain('btn-secondary')
    })
  })

  // fix-round 5 (PR #81, codex sibling sweep): a failed /api/catalog read
  // left `entries` empty exactly like a genuinely-empty catalog would, and
  // this stage announced a confident "No catalog templates matched this
  // workload's functions" manufactured out of an unhandled error path —
  // verbatim the failure mode PlanStage.tsx's own docstring names, already
  // fixed there and in CreateWorkload.tsx's TemplatePicker.
  it('a failed catalog read names the real cause, never "No catalog templates matched"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return new Response('boom', { status: 500 })
        if (url.endsWith('/api/me')) {
          return json({
            subject: 'ops', display_name: 'Ops', email: 'ops@dmf.example.com', role: 'engineer',
            real_role: 'engineer', view_as_active: false, groups: [], awx_configured: true, authentik_configured: true,
          })
        }
        if (url.endsWith('/api/media-workloads/grouped')) {
          return json({
            configured: true,
            degraded: false,
            scope: [],
            workloads: [workload({ lifecycle: 'provision' })],
            invalid_instances: [],
          })
        }
        return json({})
      }),
    )
    renderDetail()
    await findRail()
    const provisionSection = stageSection('Provision')
    expect(
      await within(provisionSection).findByText(
        /The catalog couldn.t be read right now, so this workload's templates can't be listed\. Reload the page to try the read again\./,
      ),
    ).toBeTruthy()
    expect(within(provisionSection).queryByText("No catalog templates matched this workload's functions.")).toBeNull()
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
    // umbrella dmfdeploy/dmfdeploy#378: the INITIAL action buttons are
    // mutually exclusive by construction (stageActions('finalise') returns
    // ['tear-down'] alone while anything is running — see that function's
    // own comment), so this fresh mount offers no Delete permanently button
    // alongside Teardown. That exclusivity is narrower than "never both, in
    // any state": FinaliseStage.tsx's own `purgeArming` (set by a Delete
    // permanently click, cleared only on a successful purge or an explicit
    // cancel) is checked ahead of `purgeAllowed` in the Delete-permanently
    // ternary — `allowed` (Teardown's own gate) is not part of that chain at
    // all, it is a separate prop handed to a sibling `<FinaliseEntry>` on an
    // independent render path, which is a STRONGER reason the two can
    // coexist than ordering would be: neither surface gates the other. This
    // is precisely so an already-armed purge confirmation survives a
    // background poll moving the workload to a running lifecycle mid-arm —
    // a distinct, deliberate case this assertion does not exercise.
    expect(within(finaliseSection).queryByRole('button', { name: 'Delete permanently' })).toBeNull()
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

  // umbrella #432, FIX ROUND (operator: "a large friendly message is
  // missing for teardown, that it takes a while and so on"). ADDITIVE —
  // the pre-existing job-progress line ("job #502", from JobStatusLine)
  // must still render alongside the new loud layer, not in its place.
  it('shows the loud in-progress message and both links once the teardown job is in flight', async () => {
    mkFetch({
      workload: workload({ lifecycle: 'operate' }),
      catalog: [catalogEntry({ lifecycle: 'active' })],
    })
    renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')
    fireEvent.click(within(finaliseSection).getByRole('button', { name: '⏏ Teardown' }))
    fireEvent.change(within(finaliseSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'decommission' },
    })
    fireEvent.click(within(finaliseSection).getByRole('button', { name: 'Confirm teardown' }))

    // dmfdeploy/dmfdeploy#390: the big action label and the duration claim
    // are now two separate lines (spinner+clock sit alongside the former).
    const heading = await within(finaliseSection).findByText('Tearing down')
    expect(heading.className).toMatch(/text-lg/)
    const duration = within(finaliseSection).getByText(/Typically takes/)
    expect(duration.textContent).toMatch(/typically takes/i)
    expect(duration.textContent).not.toMatch(/\bwill take\b/)

    const workspace = within(finaliseSection).getByRole('link', { name: 'Workspace' })
    expect(workspace.getAttribute('href')).toBe('/')
    const mediaWorkloads = within(finaliseSection).getByRole('link', { name: 'Media Workloads' })
    expect(mediaWorkloads.getAttribute('href')).toBe('/media-workloads')
    // States a fact; never instructs.
    const surroundingText = workspace.closest('p')?.textContent ?? ''
    expect(surroundingText).toMatch(/shows up on/)
    expect(surroundingText).not.toMatch(/watch/i)

    // The pre-existing, quiet job-progress line is untouched, alongside it.
    expect(await within(finaliseSection).findByText(/job #502/)).toBeTruthy()
  })

  // codex adversarial review (feat/390-throbber, T2/G4): the running count
  // must NEVER render next to a terminal result. The claim that callers
  // "stop rendering the notice once resolved" was contradicted by the
  // code — track.opId (and therefore `inFlight`/the mounted notice) can
  // outlive the operation's OWN real terminal state by the deliberate 1-3s
  // pacing window OperationStatusLine's onTerminal hand-off uses. This
  // drives the ASYNC teardown path (an operation_id, not a bare job_id) so
  // the operation poll — which the notice's own progress subscription
  // reads independently via track.progressOpId — is exercised at all; the
  // sync-only path every other test in this file uses never touches it.
  it('G4: never shows the running count once the operation has ITSELF resolved, even while track is still clearing', async () => {
    const h = mkFetch({
      workload: workload({
        lifecycle: 'operate',
        instances: [
          instance({ instance: 'crosspoint-1', observed_state: 'running' }),
          instance({ instance: 'crosspoint-2', observed_state: 'running' }),
          instance({ instance: 'crosspoint-3', observed_state: 'failing' }),
        ],
      }),
      catalog: [catalogEntry({ lifecycle: 'active' })],
      teardownResult: { operation_id: 'op-teardown-1', status: 'launched', request_id: 'req-teardown-1' },
      operationResponses: {
        'op-teardown-1': {
          operation_id: 'op-teardown-1',
          action: 'teardown',
          target: 'crosspoint',
          // Terminal on the VERY FIRST poll — proves the guard closes the
          // gap immediately, not "eventually after enough polls".
          state: 'run_complete',
          job_id: 999,
          error: null,
          progress_step: 'finalising',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:05Z',
        },
      },
    })
    renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')
    fireEvent.click(within(finaliseSection).getByRole('button', { name: '⏏ Teardown' }))
    fireEvent.change(within(finaliseSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'decommission' },
    })
    fireEvent.click(within(finaliseSection).getByRole('button', { name: 'Confirm teardown' }))

    await within(finaliseSection).findByText('Tearing down')

    // The operation's OWN data has already loaded (progress_step is
    // recognized) and inTail's own condition is true — the step phrase
    // renders, proving this isn't "nothing loaded yet".
    await waitFor(() => expect(within(finaliseSection).getByText('Finalising cleanup')).toBeTruthy())

    // The core assertion: even though the workload has a real, trustworthy,
    // non-empty running/total (2 of 3) and inTail is true, the count must
    // never appear — the SAME operation poll that supplied progress_step
    // also reports state=run_complete, and the guard must see that.
    expect(within(finaliseSection).queryByText(/services running/)).toBeNull()
    expect(h.calls.teardown).toHaveLength(1)
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

  // umbrella #432 §D2: Teardown used to render btn-secondary — visually
  // identical to "← Previous" (measured live: 98×29 vs 91×29, same fill,
  // same border). It's destructive (tears down a running instance), just a
  // lower danger tier than "Delete permanently" (btn-danger, filled) —
  // teardown's workload entry survives and can be re-provisioned.
  //
  // umbrella #432 §D2 REVERSAL (operator, live on 0.27.1: "the teardown
  // button is still not very readable with the nearblack and red
  // combination"): the intermediate btn-danger-outline tier this test used
  // to pin is gone — colour now matches Delete permanently exactly (filled
  // btn-danger for both), and the two-tier distinction moved to friction
  // (reason-only here vs the typed-slug gate there) instead of colour.
  it('carries the filled danger treatment, same as Delete permanently — not btn-secondary, not an outline tier', async () => {
    mkFetch({
      workload: workload({ lifecycle: 'operate' }),
      catalog: [catalogEntry({ lifecycle: 'active' })],
    })
    renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')
    const teardown = within(finaliseSection).getByRole('button', { name: '⏏ Teardown' })
    expect(teardown.className.split(/\s+/)).toContain('btn-danger')
    expect(teardown.className.split(/\s+/)).not.toContain('btn-secondary')
    expect(teardown.className.split(/\s+/)).not.toContain('btn-danger-outline')
  })

  // fix-round 5 (PR #81, codex sibling sweep): same fix as Provision's
  // identical gap above — see that test for the full reasoning.
  it('a failed catalog read names the real cause, never "No catalog templates matched"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return new Response('boom', { status: 500 })
        if (url.endsWith('/api/me')) {
          return json({
            subject: 'ops', display_name: 'Ops', email: 'ops@dmf.example.com', role: 'engineer',
            real_role: 'engineer', view_as_active: false, groups: [], awx_configured: true, authentik_configured: true,
          })
        }
        if (url.endsWith('/api/media-workloads/grouped')) {
          return json({
            configured: true,
            degraded: false,
            scope: [],
            workloads: [workload({ lifecycle: 'operate' })],
            invalid_instances: [],
          })
        }
        return json({})
      }),
    )
    renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')
    expect(
      await within(finaliseSection).findByText(
        /The catalog couldn.t be read right now, so this workload's templates can't be listed\. Reload the page to try the read again\./,
      ),
    ).toBeTruthy()
    expect(within(finaliseSection).queryByText("No catalog templates matched this workload's functions.")).toBeNull()
  })
})

// umbrella #432 G3: pre-fix, a live-measured teardown rendered "A Finalise &
// Review job is in progress — wait for its outcome." FOUR times at once —
// the rail's own note, the Previous span, the Next span, and the View-live
// exit — not the two (Previous + View-live) the originating report caught.
//
// GATE ROUND 2, FINDING A2: the first pass here fixed only Finalise & Review
// and left Provision and Configure at THREE copies each (rail, Next, View
// live) — worse than the shipped case, because an outsider walking the demo
// reaches Provision and Configure BEFORE Finalise. Per-owner matrix below,
// one `it` per job owner, so no single stage's fix can regress unnoticed
// the way Provision/Configure did the first time.
//
// See WorkloadSetup.tsx's own G3 comment for the ORIGINAL resolution: the
// rail was the one canonical carrier for every job owner; Previous went
// quiet for all three; Next went quiet too EXCEPT on Finalise & Review,
// where it states the always-true "last step" fact instead (untrue as a
// fallback for Provision/Configure, which do have a real next step once the
// job clears); View live names only what IT adds (leaving is blocked),
// never which job.
//
// SHELL ROUND 2 (dmfdeploy#481, folding in dmfdeploy#499's acceptance
// criteria): the rail's OWN copy of the sentence is now GONE outright, not
// relocated — "with a real job in flight, the lifecycle band contains zero
// status text." Previous/Next/View-live's OWN wording was already silent
// about WHICH job (this same G3 work made it so, on the theory that the
// rail said it once) — that silence still holds, so the sentence now
// renders ZERO times through this page's own chrome. What still tells the
// operator "a job is running, here's what and how long" is the point-of-
// action surface each stage already owns (JobStatusLine/OperationStatusLine
// on Provision/Configure, AutomationInProgressNotice on Finalise &
// Review) — a DIFFERENT wording, unaffected by and not asserted on here.
describe('umbrella #481/#499: the rail states no job-in-progress sentence at all — Previous/Next/View live stay as quiet as G3 already made them', () => {
  it('Provision: nothing on this page states "A Provision job is in progress" — Next and View live each say something else instead', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await findRail()
    const provisionSection = stageSection('Provision')

    fireEvent.click(await within(provisionSection).findByRole('button', { name: '▶ Deploy' }))
    fireEvent.change(within(provisionSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'demo launch' },
    })
    fireEvent.click(within(provisionSection).getByRole('button', { name: 'Confirm deploy' }))

    // THE discriminating assertion: zero on-screen copies of the rail's old
    // sentence — dmfdeploy#481 removed it outright (Shell Round 2), it does
    // not merely move to exactly one surface any more.
    await waitFor(() => {
      expect(screen.queryAllByText(/A Provision job is in progress/).length).toBe(0)
    })

    expect(within(provisionSection).queryByRole('button', { name: '← Previous' })).toBeNull()
    expect(within(provisionSection).queryByRole('button', { name: 'Next →' })).toBeNull()
    // Next has no honest reason to state while armed — quiet, same as
    // before (Provision is never the last step, so unlike Finalise there is
    // no always-true fallback fact to state instead).
    expect(within(provisionSection).queryByText(/is in progress/)).toBeNull()
    // umbrella #499: the reason moved on demand (title + sr-only text) —
    // never painted alongside "View live" itself, rail or no rail.
    expect(screen.getByText('View live').getAttribute('title')).toBe('Unavailable until the job finishes.')
  })

  it('Configure: nothing on this page states "A Configure job is in progress" — Next and View live each say something else instead', async () => {
    const wl = viewerWorkload()
    // umbrella #432 G3 (gate round 2): the switch mock resolves near-
    // instantly by default — a plain `waitFor` after clicking Confirm can
    // land AFTER the job already settled, observing the idle state rather
    // than the in-flight one and passing for the wrong reason (this is
    // exactly what happened while building this test: it saw "Active
    // source: source-b" already rendered, the switch long done). holdSwitch
    // keeps the fetch open so the in-flight state is the only state on
    // screen until releaseSwitch() fires.
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
      target: { value: 'operator requested' },
    })
    fireEvent.change(within(configureSection).getByRole('combobox'), { target: { value: 'source-b' } })
    fireEvent.click(within(configureSection).getByRole('button', { name: 'Confirm switch' }))

    // THE discriminating assertion: zero on-screen copies of the rail's old
    // sentence — see the Provision case above for why.
    await waitFor(() => {
      expect(screen.queryAllByText(/A Configure job is in progress/).length).toBe(0)
    })

    expect(within(configureSection).queryByRole('button', { name: '← Previous' })).toBeNull()
    expect(within(configureSection).queryByRole('button', { name: 'Next →' })).toBeNull()
    expect(within(configureSection).queryByText(/is in progress/)).toBeNull()
    // umbrella #499: on demand, not painted — see the Provision case above.
    expect(screen.getByText('View live').getAttribute('title')).toBe('Unavailable until the job finishes.')

    releaseSwitch()
  })

  it('Finalise & Review: nothing on this page states "A Finalise & Review job is in progress" — Previous, Next, and View live each say something else instead', async () => {
    mkFetch({
      workload: workload({ lifecycle: 'operate' }),
      catalog: [catalogEntry({ lifecycle: 'active' })],
    })
    renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')

    fireEvent.click(within(finaliseSection).getByRole('button', { name: '⏏ Teardown' }))
    fireEvent.change(within(finaliseSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'decommission' },
    })
    fireEvent.click(within(finaliseSection).getByRole('button', { name: 'Confirm teardown' }))

    // THE discriminating assertion: zero on-screen copies of the sentence —
    // pre-#481 this settled at one (the rail alone), pre-fix (round 1
    // baseline) it settled at four.
    await waitFor(() => {
      // No trailing period in the regex — this isolates the COUNT claim
      // from G2's wording change, so it discriminates on dedup alone.
      expect(screen.queryAllByText(/A Finalise & Review job is in progress/).length).toBe(0)
    })

    expect(within(finaliseSection).queryByRole('button', { name: '← Previous' })).toBeNull()
    expect(within(finaliseSection).queryByRole('button', { name: 'Next →' })).toBeNull()
    // Next states an unrelated, always-true fact — never a dead control.
    // Unlike Provision/Configure above, Finalise & Review genuinely has no
    // next step, job or no job, so this fallback is never a lie.
    expect(within(finaliseSection).getByText('This is the last step.')).toBeTruthy()
    // View live names its own unavailability without restating which job —
    // also never a dead control. umbrella #499: on demand, not painted.
    expect(screen.getByText('View live').getAttribute('title')).toBe('Unavailable until the job finishes.')
  })
})

// umbrella #432 G6: the Review panel used to keep claiming "No teardown,
// switch, or delete has run yet in this session." for as long as a
// teardown was genuinely in flight — those four facts only populate on a
// TERMINAL outcome, so the false "nothing has run" claim persisted for the
// entire in-flight window. Fixed by reading FinaliseStage's own `busy` —
// the SAME fact it already reports upward via onBusyChange to drive
// Previous/Next/View live/the rail — not a second, independently-computed
// answer (the exact mistake §F(a) already spent three rounds fixing).
describe('umbrella #432 G6: the Review panel does not contradict an in-flight teardown', () => {
  it('says a teardown is running instead of claiming nothing has run yet', async () => {
    mkFetch({
      workload: workload({ lifecycle: 'operate' }),
      catalog: [catalogEntry({ lifecycle: 'active' })],
    })
    renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')

    expect(
      within(finaliseSection).getByText('No teardown, switch, or delete has run yet in this session.'),
    ).toBeTruthy()

    fireEvent.click(within(finaliseSection).getByRole('button', { name: '⏏ Teardown' }))
    fireEvent.change(within(finaliseSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'decommission' },
    })
    fireEvent.click(within(finaliseSection).getByRole('button', { name: 'Confirm teardown' }))

    await within(finaliseSection).findByText('A teardown is in progress.')
    expect(
      within(finaliseSection).queryByText('No teardown, switch, or delete has run yet in this session.'),
    ).toBeNull()
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
    // goes inert, not just Configure's own, and the mounted panel's own
    // Next/Previous do too. dmfdeploy#481 (Shell Round 2) removed the
    // rail's own "A Configure job is in progress" note outright — the
    // suppression itself (every key demoted to a non-button) is what this
    // asserts now, not a repeated sentence.
    await waitFor(() => {
      expect(within(rail()).queryByRole('button', { name: 'Finalise & Review' })).toBeNull()
    })
    expect(within(rail()).queryAllByText(/A Configure job is in progress/).length).toBe(0)
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
        <MemoryRouter initialEntries={['/media-workloads/does-not-exist/setup']}>
          <Routes>
            <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
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
  it('dmfdeploy#405: honours the hash, selects and focuses Configure, and mounts its own locked reason — no separate banner', async () => {
    // lifecycle=provision with no bootstrapped members: Configure is
    // locked (nothing has been deployed yet, so there is no source to
    // select) — WorkloadHome.tsx's "request configuration change" link is
    // the one real caller of this hash (now aimed at /setup#configure,
    // dmfdeploy#414).
    //
    // dmfdeploy#405 FIX ROUND: this test used to prove a stale/crafted hash
    // aimed at a locked step COULD NOT reach it — the wizard fell back to
    // the backend position (Provision) and announced the refusal via a
    // separate banner (role="status"). #405 inverted that on purpose
    // (WorkloadSetup.tsx's `defaultSelection`: "the hash target is
    // honoured whatever its lock state"), and de1b94d deleted the banner
    // outright — see that commit's own comment: "the operator lands ON
    // Configure and FlowStep mounts that same locked reason as the panel's
    // own body. Keeping the banner would have printed the reason twice on
    // one screen." This test now pins the REPLACEMENT guarantee: the
    // operator gets the reason, AT the step they asked for.
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/studio-a/setup#configure']}>
          <Routes>
            <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
          </Routes>
          <HeaderSlotProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // The hash wins the initial-selection ladder OUTRIGHT, whatever its
    // lock state — the mounted panel is Configure itself, never a fallback
    // to the backend position.
    const configureHeading = await screen.findByRole('heading', { name: 'Configure', level: 2 })
    expect(configureHeading).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Provision', level: 2 })).toBeNull()

    // Genuinely FOCUSED, not merely mounted — the same hash-focus contract
    // the OPEN-hash sibling test above pins; the effect that drives it
    // (WorkloadSetup.tsx's hashFocusedRef effect) checks only `activeStep
    // === requestedStep`, never lock state.
    const panel = configureHeading.closest('[data-step-state]') as HTMLElement
    expect(document.activeElement).toBe(panel)
    expect(panel.getAttribute('data-step-state')).toBe('locked')

    // The lock reason renders AS Configure's own body (FlowStep.tsx's
    // locked branch, P5) — not a separate role=status announcement. The
    // requested-lock banner itself is gone outright (P8); this is not a
    // claim that NO role="status" node can ever exist on this page —
    // LifecycleStrip's own job-in-flight note and ViewLiveExit both render
    // one conditionally — only that neither fires in this no-job fixture,
    // so any role="status" found here would have to be the deleted banner
    // resurrected.
    expect(screen.queryByRole('status')).toBeNull()
    expect(within(panel).getByText(/there is no source to select/)).toBeTruthy()

    // No Configure content is reachable anywhere on the page — not folded,
    // not hidden, simply never mounted (P5: FlowStep never renders children
    // while locked).
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()
    expect(screen.queryByText(/Switch active source/)).toBeNull()

    // The rail's own Configure key: present, reachable (#405), and its
    // stated description matches the same reason the panel gives.
    const rail = screen.getByRole('navigation', { name: 'Media workload lifecycle' })
    const configureChip = within(rail).getByRole('button', { name: 'Configure' })
    expect(within(configureChip).getByText(/there is no source to select/)).toBeTruthy()
  })
})

// dmfdeploy#414 gate, round 1 (P2): the locked case above proves the hash
// CANNOT reach a closed gate — it says nothing about what happens when the
// gate is open, so the deep link's own happy path was unpinned.
//
// dmfdeploy#414 gate, round 2 (P2): GUARD, relabelled — round 1 called this
// a "NEW test", which overstated it. The hash-selection ladder itself
// (FLOW_STEPS membership, the initial-selection precedence, the hash-focus
// contract) is pre-#414 behaviour, unowned by this change — it lived on
// WorkloadDetail.tsx before the rename and #414 did not touch it. What IS
// new here is only the URL this test drives it through (/setup instead of
// the old bare-slug route); the ladder's own OPEN-gate outcome is the same
// baseline WorkloadDetail.tsx always had. Kept, because a route rename that
// silently broke the hash contract underneath it would be exactly the kind
// of regression this arc's own H2/H3 hazards exist to catch — but it pins
// continuity across the rename, not new #414 logic.
describe('a #configure deep link when Configure is OPEN (GATE-D1 P2.6)', () => {
  it('selects and focuses Configure directly — the hash wins the initial-selection ladder outright', async () => {
    // lifecycle=operate: running(input) is true, so Configure bears
    // switch-source and reads 'open'. Off-flow's own default (no hash)
    // would land on Finalise & Review instead — asserted absent below, so
    // this proves the HASH is what selected Configure, not the ladder.
    mkFetch({ workload: workload({ lifecycle: 'operate' }) })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/studio-a/setup#configure']}>
          <Routes>
            <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
          </Routes>
          <HeaderSlotProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    expect(await screen.findByRole('heading', { name: 'Configure', level: 2 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Finalise & Review', level: 2 })).toBeNull()
    // No lock announcement — the hash reached a real, openable step.
    expect(screen.queryByRole('status')).toBeNull()

    // Genuinely FOCUSED, not merely mounted — the same hash-focus contract
    // workloadSetupCrossWorkload.test.tsx's own hash-focus-consumption
    // tests pin for the cross-workload case, exercised here for the
    // single-workload one.
    const panel = screen
      .getByRole('heading', { name: 'Configure', level: 2 })
      .closest('[data-step-state]')
    expect(document.activeElement).toBe(panel)
  })
})

// ---- dmfdeploy#414 point 3: the setup exit ----------------------------

describe('the "View live" setup exit', () => {
  it('is present, plainly labelled, and points home — never a bare icon', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await findRail()
    const link = screen.getByRole('link', { name: 'View live' })
    expect(link.getAttribute('href')).toBe('/media-workloads/studio-a')
  })

  it('is present on the loading-safe state, ahead of the workload record resolving', async () => {
    // Gate the grouped read open so the loading branch is observable rather
    // than a race — the exit must not depend on the wizard's own data.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    mkFetch({
      workload: workload({ lifecycle: 'provision' }),
      groupedDelayAfter: 0,
      groupedGate: gate,
    })
    renderDetail()
    expect(await screen.findByText('Loading workload…')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'View live' })
    expect(link.getAttribute('href')).toBe('/media-workloads/studio-a')
    release()
  })

  it('is present on the not-found state', async () => {
    mkFetch({})
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/does-not-exist/setup']}>
          <Routes>
            <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByText('Workload not found')
    const link = screen.getByRole('link', { name: 'View live' })
    expect(link.getAttribute('href')).toBe('/media-workloads/does-not-exist')
  })

  it('obeys the job-navigation lock: goes inert with a stated reason while a job is in flight, never a disabled control', async () => {
    const { deploy } = mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail()
    await findRail()

    // Real link before any job starts.
    expect(screen.getByRole('link', { name: 'View live' })).toBeTruthy()

    const provisionSection = stageSection('Provision')
    fireEvent.click(await within(provisionSection).findByRole('button', { name: '▶ Deploy' }))
    fireEvent.change(within(provisionSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'go' },
    })
    fireEvent.click(within(provisionSection).getByRole('button', { name: 'Confirm deploy' }))

    // startJob sets jobInFlight synchronously in the same click handler
    // (the wizard's own "zero window" guarantee — see WorkloadSetup.tsx's
    // file docstring point 3) — waitFor here only absorbs Testing
    // Library's own act()/microtask settling, the same caution this file's
    // other job-in-flight assertions already apply.
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'View live' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'View live' })).toBeNull()
      // umbrella #432 G3 (gate round 2, finding A2): View live states its
      // own affordance's unavailability, not which job — the rail (still
      // showing "A Provision job is in progress.") already said that.
      // umbrella #499: that reason is on demand (title + sr-only text) now,
      // not painted next to "View live" as a fourth on-screen restatement.
      expect(screen.getByText('View live').getAttribute('title')).toBe('Unavailable until the job finishes.')
    })

    await within(provisionSection).findByText(/job #501/)
    expect(deploy).toHaveLength(1)
    // Once the job settles, the exit is a real link again — the job-status
    // poll (JobProgress.tsx) runs on a 2s interval, longer than
    // waitFor's 1s default, so this needs its own explicit timeout; the
    // point being proved (suppression LIFTS, not just applies) mirrors this
    // file's own "a job in flight suppresses navigation everywhere" test.
    await waitFor(() => expect(screen.getByRole('link', { name: 'View live' })).toBeTruthy(), {
      timeout: 3000,
    })
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
// it also drops the whole step to 'locked' (nothing else makes it openable).
//
// dmfdeploy#405 FIX ROUND: the discriminator used to be "the rail loses its
// Finalise button" — a locked step rendered as an inert, non-interactive
// <div>, so a bare `queryByRole('button', { name: 'Finalise & Review' }))
// .toBeNull()` proved withholding on its own. #405 made every rail key —
// locked included — a reachable <button> WHEN NO JOB IS IN FLIGHT, carrying
// the SAME accessible name the open key has (LifecycleStrip.tsx:
// `interactive = !jobInFlight`, `aria-label={STEP_LABEL[id]}`) — a job in
// flight still demotes every key to an inert <div>, locked or not; that
// suppression is a different fact from locked and #405 did not touch it.
// The qualified case above is deliberate, so a locked step can still be
// visited and read its own stated reason (the removed "Why … is locked"
// disclosure toggle folded into the key itself). The button therefore no
// longer discriminates
// offered from withheld — only its DESCRIPTION
// (aria-describedby, "Locked. …", P3) does. `expectFinaliseWithheld` below
// asserts that description, then navigates in anyway (#405's whole point:
// a locked step is reachable, not merely present) and confirms
// FlowStep.tsx's locked branch renders the SAME reason prose and never
// mounts the purge control (FlowStep.tsx:174-183) — absence observed at the
// place the control would actually live, not inferred from a step the
// wizard never reached, which a stage-local "not offered" check alone could
// satisfy vacuously (see this file's own git history: the step drops to
// 'locked' the moment the last action withdraws, so FinaliseStage is never
// even mounted for an unconditional-render regression to be caught by a
// stage-local absence check).
// ---------------------------------------------------------------------------

/**
 * Shared discriminator for the #378a/b/c gate tests below. See the section
 * comment above for why a bare rail-button absence check stopped proving
 * anything once dmfdeploy#405 made locked keys reachable buttons.
 *
 *   (a) present + locked — the key's own stated description (P3), not its
 *       absence;
 *   (b) actually navigate there — #405 makes it reachable, so click it;
 *   (c) the locked reason prose renders and there is no purge control —
 *       BOTH scoped to where the control would live (proves the RIGHT
 *       place stays empty) AND page-wide (proves the control isn't
 *       leaking somewhere else on the page entirely — a stage-scoped
 *       query cannot see a control rendered as a sibling of the mounted
 *       stage rather than inside it, so scoping alone would pass even if
 *       the gate leaked the button outside FinaliseStage's own subtree).
 */
async function expectFinaliseWithheld(strip: HTMLElement): Promise<void> {
  const chip = await waitFor(() => within(strip).getByRole('button', { name: 'Finalise & Review' }))
  expect(within(chip).getByText(/nothing to tear down/)).toBeTruthy()
  const finaliseSection = await selectStep('Finalise & Review')
  expect(within(finaliseSection).getByText(/nothing to tear down/)).toBeTruthy()
  expect(within(finaliseSection).queryByRole('button', { name: 'Delete permanently' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull()
}

describe('delete-permanently gate: completeness (umbrella dmfdeploy/dmfdeploy#378a)', () => {
  it('withholds the affordance when the grouped read reports degraded, even for an otherwise-eligible workload', async () => {
    // The bug this guards: !isError && !isFetching is true here (the query
    // succeeded and isn't in flight) — only the widened check catches that
    // the payload itself declared members excluded.
    mkFetch({ workload: purgeEligibleWorkload(), grouped: { degraded: true } })
    renderDetail()
    const strip = await findRail()

    await expectFinaliseWithheld(strip)
  })

  it('still offers it when the read is fresh, error-free, configured, and not degraded', async () => {
    // The positive control: same eligible workload, degraded left at its
    // mkFetch default (false) — proves the test above fails for the stated
    // reason, not because purgeEligibleWorkload stopped being eligible.
    mkFetch({ workload: purgeEligibleWorkload() })
    renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')
    expect(within(finaliseSection).getByRole('button', { name: 'Delete permanently' })).toBeTruthy()
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

    await expectFinaliseWithheld(strip)
  })

  it('withholds it from an admin viewing as viewer — the EFFECTIVE role gates, not the real one', async () => {
    mkFetch({
      workload: purgeEligibleWorkload(),
      user: { role: 'viewer', real_role: 'admin', view_as_active: true },
    })
    renderDetail()
    const strip = await findRail()

    await expectFinaliseWithheld(strip)
  })

  it('offers it to operator, engineer, and admin once every other gate passes', async () => {
    for (const role of ['operator', 'engineer', 'admin'] as const) {
      cleanup()
      mkFetch({ workload: purgeEligibleWorkload(), user: { role, real_role: role } })
      renderDetail()
      await findRail()
      const finaliseSection = await selectStep('Finalise & Review')
      expect(
        within(finaliseSection).getByRole('button', { name: 'Delete permanently' }),
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
    await within(finaliseSection).findByRole('button', { name: 'Delete permanently' })
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
    // going untrustworthy mid-refetch) drops the WHOLE step to locked.
    //
    // dmfdeploy#405 FIX ROUND: unlike the sibling gate tests above, this one
    // starts the operator ALREADY selected on Finalise, and #405
    // (WorkloadSetup.tsx:571-577) means a SELECTED step is no longer
    // abandoned for becoming locked — "a selection is no longer abandoned
    // for becoming locked... A non-null selection is now always honoured."
    // The pre-#405 bounce this test used to rely on ("the wizard's own
    // selection ladder returns to Provision, and the rail losing its
    // Finalise button is the discriminator") no longer happens: the rail's
    // Finalise & Review key stays SELECTED (aria-pressed) and reachable
    // throughout, so the discriminator is the key's own LOCKED description
    // (P3), not a rail absence that no longer occurs.
    //
    // MID-FLIGHT, the rail and the panel genuinely disagree for a moment,
    // and both halves are load-bearing: the rail reads LIVE `flow.steps`
    // (buildHeaderSlotRail), which folds `userQuery.isFetching` into
    // isPurgeAuthorized's fail-closed check, so the key's description flips
    // to locked the INSTANT the refetch starts. The wizard's PANEL reads the
    // frozen `displaySteps` instead (umbrella #392's own fix: a still-
    // fetching read must not evict an operator's already-typed reason), so
    // FinaliseStage stays mounted through this window — it is FinaliseStage's
    // OWN action-gated content (not yet FlowStep's locked prose) that
    // withholds the button here, and that is `#392`'s claim, not a bug this
    // test should paper over.
    await waitFor(() => {
      const finaliseChip = within(rail()).getByRole('button', { name: 'Finalise & Review' })
      expect(within(finaliseChip).getByText(/nothing to tear down/)).toBeTruthy()
    })
    // Still reachable, not merely present — click it, same as the operator
    // could.
    fireEvent.click(within(rail()).getByRole('button', { name: 'Finalise & Review' }))
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull()

    // Release the held read — it throws (meRejectFlag was set before the
    // release). Once the read SETTLES, `displaySteps` catches up to locked
    // too (#392's freeze holds only through the UNSETTLED window, never past
    // it) — FlowStep.tsx's own locked branch (P5) now takes over the panel:
    // reason prose, no mounted children. The control must stay withdrawn,
    // never re-arm off the stale-but-still-authorized payload react-query
    // kept around.
    releaseMe?.()
    await waitFor(() => expect(queryClient.getQueryState(['user'])?.fetchStatus).toBe('idle'))
    const lockedFinaliseSection = stageSection('Finalise & Review')
    expect(within(lockedFinaliseSection).getByText(/nothing to tear down/)).toBeTruthy()
    // Scoped (proves the right place stays empty) AND page-wide (proves
    // nothing leaked outside FinaliseStage's own subtree — a scoped-only
    // check cannot see a control rendered as a sibling of the mounted
    // stage rather than inside it).
    expect(within(lockedFinaliseSection).queryByRole('button', { name: 'Delete permanently' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull()
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
    expect(within(finaliseSection).getByRole('button', { name: 'Delete permanently' })).toBeTruthy()
    expect(h.calls.me).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// umbrella dmfdeploy/dmfdeploy#392: a background grouped-inventory poll must
// not evict the operator from an already-selected Finalise & Review, and
// must not wipe an armed delete-permanently form's typed reason.
//
// Root cause: isGroupedReadTrustworthy (workloadLifecycle.ts) fails closed on
// groupedRead.isFetching by design — membersDataTrustworthy, and therefore
// stageActions('finalise')'s delete-permanently branch, correctly go empty
// for the duration of every background refetch, exactly like the #378a/b/c
// gates above. Before this fix, WorkloadDetail.tsx's (dmfdeploy#414 renamed
// this file WorkloadSetup.tsx) activeStep/selectedStep persisted that
// MOMENTARY dip as if it were a durable lock (the very next
// render's effect wrote the fallback into state unconditionally), so a
// refetch that resolved a heartbeat later still left the operator bounced to
// Provision — and FinaliseStage's purgeAllowed-gated form unmounted on the
// same dip, discarding whatever reason the operator had typed. Simulates
// useMediaWorkloadsGrouped's real 15000ms refetchInterval with an explicit
// refetch (deterministic and controllable, not a real 15s wait) — the poll
// mechanism is what production's refetchInterval triggers on a timer; this
// drives the identical react-query state transition without the wall-clock
// dependency.
describe('Finalise & Review selection survives a background poll (umbrella dmfdeploy/dmfdeploy#392)', () => {
  it('holds the panel on Finalise, and keeps the armed form + typed reason intact, across FOUR consecutive in-flight grouped refetches', async () => {
    // Four consecutive cycles — the same "four times the old ~15-20s
    // failure window" bar #392 itself sets, expressed as four actual
    // isFetching transitions instead of a 60s wall-clock wait: each
    // iteration re-arms its own gate so the NEXT simulated poll is held
    // in flight exactly like the previous one, proving this isn't a
    // "survives once" fix that a second poll could still catch out.
    let releaseGrouped: () => void = () => {}
    const fetchOpts: Parameters<typeof mkFetch>[0] = {}
    const armGroupedGate = () => {
      fetchOpts.groupedGate = new Promise((r) => { releaseGrouped = () => r(null) })
    }
    armGroupedGate()

    const eligible = purgeEligibleWorkload()
    const REASON_TEXT = 'no longer needed for this run'
    Object.assign(fetchOpts, {
      workload: eligible,
      user: { role: 'operator', real_role: 'operator' },
      // Only the SECOND-and-later grouped read (the simulated background
      // poll) hangs — the initial load must resolve normally so the wizard
      // can reach Finalise & Review in the first place.
      groupedDelayAfter: 1,
    })
    const h = mkFetch(fetchOpts)
    const queryClient = renderDetail()
    await findRail()
    const finaliseSection = await selectStep('Finalise & Review')

    fireEvent.click(within(finaliseSection).getByRole('button', { name: 'Delete permanently' }))
    fireEvent.change(within(finaliseSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: REASON_TEXT },
    })
    fireEvent.change(within(finaliseSection).getByPlaceholderText(eligible.slug), {
      target: { value: eligible.slug },
    })
    expect(
      (within(finaliseSection).getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled,
    ).toBe(false)

    for (let cycle = 1; cycle <= 4; cycle++) {
      const callsBefore = h.calls.grouped
      // The same trigger shape as production's refetchInterval firing while
      // the operator is mid-review — explicit here so each in-flight window
      // is observable and controllable instead of a real 15s wait.
      void queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
      await waitFor(() => expect(h.calls.grouped).toBeGreaterThan(callsBefore))

      // Assertions below query the LIVE document (screen), not the
      // `finaliseSection` reference captured before the first poll — a
      // stale detached node would still report its old children even if
      // the wizard actually navigated away underneath it, which is exactly
      // the failure mode this test exists to catch.
      expect(screen.getByRole('heading', { name: 'Finalise & Review', level: 2 }), `cycle ${cycle}`).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Provision', level: 2 }), `cycle ${cycle}`).toBeNull()
      expect(
        (screen.getByPlaceholderText(REASON_PLACEHOLDER) as HTMLTextAreaElement).value,
        `cycle ${cycle}`,
      ).toBe(REASON_TEXT)

      const release = releaseGrouped
      armGroupedGate() // next cycle's gate is live before this one releases
      release()
      await waitFor(() =>
        expect(queryClient.getQueryState(['media-workloads-grouped'])?.fetchStatus).toBe('idle'),
      )
    }

    // Settled again afterward — still on Finalise, form still intact, the
    // delete-permanently button's own gating (unrelated to navigation) is
    // untouched by this fix and still correctly re-enabled once the read is
    // fresh again.
    expect(screen.getByRole('heading', { name: 'Finalise & Review', level: 2 })).toBeTruthy()
    expect((screen.getByPlaceholderText(REASON_PLACEHOLDER) as HTMLTextAreaElement).value).toBe(REASON_TEXT)
    expect(
      (screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})

describe('delete-permanently gate: entity identity (umbrella dmfdeploy/dmfdeploy#378c)', () => {
  it('never renders the affordance for the synthetic unassigned bucket', async () => {
    mkFetch({ workload: purgeEligibleWorkload({ slug: 'unassigned', name: 'Unassigned' }) })
    renderDetail('unassigned')
    const strip = await findRail()

    await expectFinaliseWithheld(strip)
  })
})
