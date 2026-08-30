/**
 * Create Media Workload — the draft leg of the guided sequential flow
 * (umbrella #285 addendum). Harness copied from workloadSetup.test.tsx:
 * MSW-free, a fresh react-query QueryClient per render, fetch stubbed via
 * vi.stubGlobal.
 *
 * WP-3 spec C: this page is now a ONE-STEP-AT-A-TIME WIZARD (Identity, then
 * Design/Plan/Provision/Configure/Finalise & Review through FlowStep.tsx),
 * not the old all-five-panels accordion. Only the step the operator has
 * navigated to is ever mounted, so every test below that needs a later
 * step's DOM must walk there first via the Next/Previous chrome (clickNext/
 * clickPrevious below) — see CreateWorkload.tsx's own file docstring for
 * why Design → Finalise & Review's Next/Previous are an UNCONDITIONAL index
 * walk, never gated on lock state: a locked step is still reachable by
 * navigating to it, only its own action is withheld (it renders its stated
 * reason instead of its children).
 *
 * What must hold, and why each is its own test rather than one giant one:
 *   - the gate: Plan/Provision stay locked until Design/Plan complete, and
 *     the flow never contradicts lib/workloadFlow.ts's own ladder;
 *   - the slug the operator will get is SHOWN, not silently derived
 *     (Art. 1) — typing a studio name must produce visible slug text;
 *   - an invalid slug is a designed state, not a silent non-completion;
 *   - the deploy POST carries both the mandatory reason and the workload
 *     slug, because that pairing is the entire persistence seam this page
 *     depends on;
 *   - a failed deploy leaves a STANDING failure on the Provision step
 *     (Art. 2/8), not a toast that could vanish before it's read;
 *   - the draft-loss limit is stated in the rendered output, not just in a
 *     comment only a developer will ever read;
 *   - the draft's DATA (not the wizard's own navigation position) survives
 *     navigating away and back within the tab, via a non-persisted store,
 *     and is architecturally incapable of surviving a reload.
 *
 * GUARD LABEL (dmfdeploy#414 gate, round 1): every test in this file is a
 * GUARD pinning the pre-#414 WP-3 spec C draft-wizard contract described
 * above, EXCEPT the two describe blocks explicitly marked "dmfdeploy#414"
 * below ("the destination never denies a just-launched workload"'s two new
 * "View live" lock tests, and the H1 destination-route change baked into
 * renderCreate() itself) — those pin THIS arc's own new behaviour, not a
 * guard. Baseline for the guards: the pre-#414 commit on `main`, where
 * these same assertions passed identically with the destination mounted at
 * the bare slug rather than /setup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import CreateWorkload from '../pages/MediaWorkloads/CreateWorkload'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import { readLaunchState } from '../pages/MediaWorkloads/WorkloadMaterializing'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import { useDraftWorkloadStore } from '../store/draftWorkload'
import type { CatalogEntry, MediaWorkload } from '../api/types'

// ---- fixtures ---------------------------------------------------------

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'mxl-viewer',
    display_name: 'MXL Viewer (3-pod)',
    summary: 'Source, crosspoint and viewer for one studio.',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'bootstrapped',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: null,
    finalise_awx_job_template: null,
    dependencies: [],
    ingress_url: null,
    provision_demand: null,
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
  catalog?: CatalogEntry[]
  catalogStatus?: number
  facilitySites?: Array<{ name: string; slug: string | null; device_count: number }>
  deployStatus?: number
  deployResult?: Record<string, unknown>
  /** Throw from fetch itself — transport loss, NOT an HTTP error response. */
  deployThrows?: boolean
  /** Workloads the grouped inventory reports. Empty = not recorded yet. */
  workloads?: MediaWorkload[]
  /** Job status the destination polls, by job id. */
  jobStatus?: Record<number, { status: string; is_done: boolean }>
  /** Operation status the destination polls, for the async launch path. */
  operation?: Record<string, unknown>
  /** dmfdeploy#414 gate, round 3: HTTP status the grouped-inventory read
   *  returns, simulating a persistently failing read (WorkloadSetup's own
   *  `error` branch). */
  groupedStatus?: number
  /** dmfdeploy#414 gate, round 3: the `configured` flag the grouped-
   *  inventory read reports (WorkloadSetup's own unconfigured branch). */
  groupedConfigured?: boolean
  /** dmfdeploy#414 gate, round 3: never resolves the grouped-inventory
   *  read, pinning the query in `isLoading` for the whole test — the exact
   *  race the gate found (a launch handoff reaching WorkloadSetup while its
   *  own read has not resolved even once). */
  groupedPending?: boolean
}

function mkFetch(opts: FetchOpts = {}) {
  // Mutable for the same reason `workloads` is: a template's lifecycle can
  // change under the operator mid-draft, and that transition is a case the
  // guard has to survive rather than a hypothetical.
  let catalog = opts.catalog ?? [catalogEntry()]
  let catalogStatus = opts.catalogStatus
  // Lets a test hold the catalog response open so "a re-read is in flight"
  // is an observed state rather than a race the test hopes to hit.
  let catalogGate: Promise<void> | null = null
  // Mutable so a test can simulate the launcher stamping the tag partway
  // through the journey, which is the real sequence.
  let workloads: MediaWorkload[] = opts.workloads ?? []
  // FIX ROUND P2-4: mutable, so a test can simulate the facility summary's
  // own periodic refresh returning a DIFFERENT single site mid-draft — the
  // reachable transition the confirmed-facility identity check exists for.
  let facilitySites = opts.facilitySites ?? [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }]
  const jobStatus: Record<number, { status: string; is_done: boolean }> = { ...(opts.jobStatus ?? {}) }
  const calls = { deploy: [] as Array<{ url: string; init?: RequestInit }>, grouped: 0 }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()

    if (url.endsWith('/api/catalog')) {
      if (catalogGate) {
        const gate = catalogGate
        catalogGate = null
        await gate
      }
      if (catalogStatus) return json({ error: 'nope' }, catalogStatus)
      return json({ entries: catalog })
    }
    if (url.endsWith('/api/facility/summary')) {
      return json({ reason: '', site_count: facilitySites.length, device_count: 0, sites: facilitySites })
    }
    if (url.match(/\/api\/catalog\/[^/]+\/deploy$/)) {
      calls.deploy.push({ url, init })
      // A THROW, not a response: this is the transport-loss path, where the
      // console never learns whether AWX got the request.
      if (opts.deployThrows) throw new TypeError('Failed to fetch')
      if (opts.deployStatus) return json({ error: 'boom' }, opts.deployStatus)
      return json(opts.deployResult ?? { job_id: 900, status: 'launched', request_id: 'req-1' })
    }
    if (url.endsWith('/api/media-workloads/grouped')) {
      calls.grouped += 1
      // dmfdeploy#414 gate, round 3: checked before the ordinary response
      // below, same shape as catalogGate above — a promise that never
      // settles pins isLoading indefinitely rather than racing a real delay.
      if (opts.groupedPending) return new Promise<Response>(() => {})
      if (opts.groupedStatus) return json({ error: 'boom' }, opts.groupedStatus)
      return json({
        configured: opts.groupedConfigured ?? true,
        degraded: false,
        scope: [],
        workloads,
        invalid_instances: [],
      })
    }
    const jobMatch = url.match(/\/api\/catalog\/[^/]+\/status\/(\d+)$/)
    if (jobMatch) {
      const id = Number(jobMatch[1])
      const st = jobStatus[id] ?? { status: 'running', is_done: false }
      return json({ job_id: id, status: st.status, is_done: st.is_done, is_running: !st.is_done })
    }
    const opMatch = url.match(/\/api\/operations\/(.+)$/)
    if (opMatch) {
      return json(opts.operation ?? { operation_id: opMatch[1], state: 'launching', job_id: null })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    ...calls,
    fetchMock,
    setWorkloads: (next: MediaWorkload[]) => {
      workloads = next
    },
    setCatalog: (next: CatalogEntry[]) => {
      catalog = next
    },
    setCatalogStatus: (next: number | undefined) => {
      catalogStatus = next
    },
    setCatalogGate: (gate: Promise<void>) => {
      catalogGate = gate
    },
    setJobStatus: (id: number, next: { status: string; is_done: boolean }) => {
      jobStatus[id] = next
    },
    setFacilitySites: (next: Array<{ name: string; slug: string | null; device_count: number }>) => {
      facilitySites = next
    },
  }
}

// GATE-B item 1: this used to mount a STUB at the destination
// (<div>Workload detail: studio-a</div>), which made the create journey look
// finished while hiding the actual bug — the real page had no idea a launch
// had just happened and rendered "Workload not found" for the workload the
// operator had just created. The stub was the reason the defect shipped, so
// the harness now mounts the REAL WorkloadSetup and the journey is asserted
// end to end.
function renderCreate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/new']}>
        <Routes>
          <Route path="/media-workloads/new" element={<CreateWorkload />} />
          <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // Returned so a test can force a catalog re-read mid-flow; every other
  // caller ignores it.
  return queryClient
}

// Scopes assertions to whichever step's DOM is actually mounted, via its
// <h2>. The wizard mounts exactly one step at a time (WP-3 spec C), so this
// only finds a step the test has genuinely navigated to. Matched against
// EITHER `[data-step-state]` (FlowStep.tsx's own root — Design through
// Finalise & Review) OR `section` (IdentityStep's own root, which carries
// no data-step-state of its own: it is deliberately NOT one of FlowStep's
// five numbered, coloured lifecycle stages — see CreateWorkload.tsx's file
// docstring). `.closest()` with a selector list returns the nearest
// ancestor matching either half, so one helper covers both step shapes —
// the same fix workloadSetupStageWedge.test.tsx's `stageSection()` already
// applies for the real wizard's FlowStep-only case.
function stepSection(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: label, level: 2 })
  return heading.closest('[data-step-state], section') as HTMLElement
}

async function chooseTemplate() {
  const design = stepSection('Design')
  fireEvent.click(await within(design).findByRole('button', { name: 'Use this template' }))
}

function typeStudioName(value: string) {
  fireEvent.change(screen.getByLabelText('Studio name'), { target: { value } })
}

// ---- wizard navigation helpers -----------------------------------------
//
// Only one step's content is ever mounted (WP-3 spec C), so reaching a
// later step means clicking through it, not just querying for it. `findBy`
// rather than `getBy` because Identity's own Next only appears once its own
// gate (a valid name) is satisfied, and some callers fire this in the same
// tick as the keystroke that makes it true.

async function clickNext() {
  fireEvent.click(await screen.findByRole('button', { name: /Next/ }))
}

async function clickPrevious() {
  fireEvent.click(await screen.findByRole('button', { name: /Previous/ }))
}

/**
 * Types a valid studio name on Identity and clicks past the wizard's ONE
 * structural gate (CreateWorkload.tsx's file docstring: "Identity's own
 * Next is the one gate"), landing on Design. Every step after Design is
 * reached by chaining further clickNext() calls from there — Design →
 * Finalise & Review's own Next never re-checks lock state.
 */
async function reachDesign(name = 'Studio A') {
  typeStudioName(name)
  await clickNext()
  return stepSection('Design')
}

/**
 * True when every button inside `section` is the wizard's own Previous/Next
 * chrome — i.e. the step itself offers no action of its own. Named rather
 * than asserting zero buttons outright, because FlowStep's Previous/Next
 * controls are UNCONDITIONAL and live in the same container as a step's
 * (locked-or-not) content, so a locked step still has buttons in it now —
 * just none that DO anything. Mirrors the identical discipline
 * workloadSetup.test.tsx's Design-step assertion already uses for the real
 * wizard's own nav chrome.
 */
function onlyNavButtons(section: HTMLElement): boolean {
  return within(section)
    .queryAllByRole('button')
    .every((b) => b.textContent === '← Previous' || b.textContent === 'Next →')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // The draft store is a module-level Zustand singleton (store/draftWorkload.ts
  // has no persist middleware, but it is still one instance shared by every
  // test in this file) — without an explicit reset, a name typed in one test
  // would still be sitting there when the next test renders the page fresh.
  useDraftWorkloadStore.getState().reset()
})

// ---- taxonomy stays out of default level -------------------------------

describe('EBU taxonomy on the draft template picker', () => {
  it('keeps layer/vertical/function-type/lifecycle-owner behind a closed System details disclosure', async () => {
    // Arc 4 WP-3 (umbrella #347): same contract as the real workload's
    // Design step (workloadSetup.test.tsx) — see that test's own comment
    // for what a jsdom-based test can and cannot prove about a closed
    // <details>'s accessibility. This pins the draft's own TemplatePicker,
    // which renders the identical disclosure independently.
    mkFetch({
      catalog: [
        catalogEntry({
          ebu_layer: 5,
          ebu_vertical: 'orchestration',
          ebu_media_function_type: 'crosspoint',
          ebu_lifecycle_owner: 'platform',
        }),
      ],
    })
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    await reachDesign()
    await screen.findByText('MXL Viewer (3-pod)')

    const disclosure = screen.getByText('System details').closest('details') as HTMLDetailsElement
    expect(disclosure, 'System details must be a native <details> disclosure').toBeTruthy()
    expect(disclosure.open, 'closed by default').toBe(false)
    expect(within(disclosure).getByText(/EBU layer 5/)).toBeTruthy()
    expect(screen.getByText('System details').tagName).toBe('SUMMARY')
  })
})

// ---- the gate: only-then progression -----------------------------------

describe('the draft gate', () => {
  it('locks Plan and Provision until a valid name and a template are both chosen', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })

    // Identity's own Next is the wizard's ONE structural gate (file
    // docstring): a valid name is required just to LEAVE Identity, so the
    // pre-wizard "nothing chosen at all" reading of Plan/Provision can no
    // longer be produced — Design/Plan/Provision are simply unreachable
    // before the name resolves. What survives, and still proves the AND,
    // is that a name ALONE is not enough: with no template chosen, Plan and
    // Provision — read by navigating to them, since a locked step is still
    // reachable and only its controls are withheld — both name the same
    // "Design is complete" reason, and offer nothing but the wizard's own
    // nav chrome.
    typeStudioName('Studio A')
    await clickNext() // Identity → Design
    await clickNext() // Design → Plan (unconditional; Design isn't "done")
    expect(within(stepSection('Plan')).getByText(/This step opens once Design is complete/)).toBeTruthy()
    expect(onlyNavButtons(stepSection('Plan'))).toBe(true)
    await clickNext() // Plan → Provision
    expect(
      within(stepSection('Provision')).getByText(/This step opens once Plan is complete/),
    ).toBeTruthy()

    // Choosing the template completes Design; Plan opens.
    await clickPrevious() // Provision → Plan
    await clickPrevious() // Plan → Design
    await chooseTemplate()
    await clickNext() // Design → Plan
    await waitFor(() =>
      expect(within(stepSection('Plan')).queryByText(/This step opens once Design is complete/)).toBeNull(),
    )
  })

  // WP-3 spec D: the placement CONFIRMATION gate. Resolving the single
  // facility is necessary but no longer sufficient — Provision opens only
  // once the operator has explicitly acknowledged it.
  describe('Provision opens only once the resolved facility is confirmed', () => {
    it('stays locked once the facility resolves, before the operator confirms it', async () => {
      mkFetch()
      renderCreate()
      await screen.findByRole('heading', { name: 'Identity' })

      await reachDesign()
      await chooseTemplate()
      await clickNext() // Design → Plan

      // The facility itself is readable — a true fact, not "select"/
      // "assign" — but Provision has not opened on that alone.
      await within(stepSection('Plan')).findByText(/This workload will run on/)
      await clickNext() // Plan → Provision
      expect(
        within(stepSection('Provision')).getByText(/This step opens once Plan is complete/),
      ).toBeTruthy()
    })

    it('opens once the operator clicks Confirm placement', async () => {
      mkFetch()
      renderCreate()
      await screen.findByRole('heading', { name: 'Identity' })

      await reachDesign()
      await chooseTemplate()
      await clickNext() // Design → Plan

      fireEvent.click(await within(stepSection('Plan')).findByRole('button', { name: 'Confirm placement' }))
      await clickNext() // Plan → Provision

      expect(within(stepSection('Provision')).queryByText(/This step opens once Plan is complete/)).toBeNull()
      expect(
        within(stepSection('Provision')).getByRole('button', { name: '▶ Provision now' }),
      ).toBeTruthy()

      // Plan is now `complete` — reviewable, not folded: the wizard has no
      // fold/expand state to re-open (FlowStep.tsx mounts exactly one
      // step's content regardless of completion, unlike the old
      // accordion's per-panel Review/Hide toggle — see FlowStep.tsx's own
      // docstring). Navigating back is how the operator, and this test,
      // reads it: the confirmation itself reads back as a settled fact, not
      // as a control still waiting to be pressed again.
      await clickPrevious() // Provision → Plan
      expect(within(stepSection('Plan')).getByText(/Confirmed — this workload will run on/)).toBeTruthy()
      expect(within(stepSection('Plan')).queryByRole('button', { name: 'Confirm placement' })).toBeNull()
    })

    // FIX ROUND (WP-3 spec D gate, P2-4). Mutation-tested repro: confirm
    // dmf-lab, the facility summary's own periodic refresh then returns a
    // DIFFERENT single site, navigate back to Plan — before this fix the
    // page read "Confirmed — this workload will run on replacement-lab"
    // with no Confirm button, asserting the operator confirmed a placement
    // they never actually saw (a bare boolean survives any single-site
    // read, not just the one it was set against).
    it('does not carry a confirmation over to a DIFFERENT single facility the read starts returning', async () => {
      const h = mkFetch()
      const queryClient = renderCreate()
      await screen.findByRole('heading', { name: 'Identity' })

      await reachDesign()
      await chooseTemplate()
      await clickNext() // Design → Plan

      // "dmf-lab" lands in its own <span>, split from "This workload will
      // run on" by the element boundary — findByText matches per-node by
      // default, so this checks the two facts the two separate queries
      // that actually exist for.
      await within(stepSection('Plan')).findByText(/This workload will run on/)
      expect(within(stepSection('Plan')).getByText('dmf-lab')).toBeTruthy()
      fireEvent.click(within(stepSection('Plan')).getByRole('button', { name: 'Confirm placement' }))
      expect(within(stepSection('Plan')).getByText(/Confirmed — this workload will run on/)).toBeTruthy()

      // The reachable transition: the SAME single-site shape, a DIFFERENT
      // facility.
      h.setFacilitySites([{ name: 'replacement-lab', slug: 'replacement-lab', device_count: 2 }])
      await queryClient.invalidateQueries({ queryKey: ['facility', 'summary'] })

      // Must read as UNCONFIRMED for the new facility — the true fact
      // ("this workload will run on replacement-lab") stays visible, but
      // asks for a fresh acknowledgement rather than silently inheriting
      // the old one.
      await waitFor(() => {
        expect(within(stepSection('Plan')).getByText(/This workload will run on/)).toBeTruthy()
        expect(within(stepSection('Plan')).queryByText(/Confirmed —/)).toBeNull()
      })
      expect(
        within(stepSection('Plan')).getByRole('button', { name: 'Confirm placement' }),
      ).toBeTruthy()

      // And Provision must have re-locked behind it — the gate this whole
      // fix is actually protecting, not just the Plan step's own copy.
      await clickNext() // Plan → Provision
      expect(
        within(stepSection('Provision')).getByText(/This step opens once Plan is complete/),
      ).toBeTruthy()
    })
  })

  // GATE ONLY IN THE EXACTLY-ONE-FACILITY CASE: both non-answers below are
  // untouched by the confirmation gate — there is nothing to confirm, and
  // no "Confirm placement" control ever appears to be skipped or missed.
  it('gives an honest non-answer instead of a picker when zero facilities are registered, and Provision stays locked', async () => {
    mkFetch({ facilitySites: [] })
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })

    await reachDesign()
    await chooseTemplate()
    await clickNext() // Design → Plan

    await within(stepSection('Plan')).findByText(/can't be shown/)
    expect(within(stepSection('Plan')).queryByRole('button', { name: 'Confirm placement' })).toBeNull()
    await clickNext() // Plan → Provision
    expect(
      within(stepSection('Provision')).getByText(/This step opens once Plan is complete/),
    ).toBeTruthy()
  })

  it('gives an honest non-answer instead of a picker when more than one facility is registered, and Provision stays locked', async () => {
    mkFetch({
      facilitySites: [
        { name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 },
        { name: 'dmf-lab-2', slug: 'dmf-lab-2', device_count: 1 },
      ],
    })
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })

    await reachDesign()
    await chooseTemplate()
    await clickNext() // Design → Plan

    await within(stepSection('Plan')).findByText(/2 facilities are registered/)
    expect(within(stepSection('Plan')).queryByRole('button', { name: 'Confirm placement' })).toBeNull()
    await clickNext() // Plan → Provision
    expect(
      within(stepSection('Provision')).getByText(/This step opens once Plan is complete/),
    ).toBeTruthy()
  })

  it('Configure and Finalise & Review are locked throughout, with a stated plain-words reason', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })

    await reachDesign()
    await chooseTemplate()
    await clickNext() // Design → Plan
    fireEvent.click(await within(stepSection('Plan')).findByRole('button', { name: 'Confirm placement' }))
    await clickNext() // Plan → Provision
    await clickNext() // Provision → Configure
    expect(within(stepSection('Configure')).getByText(/nothing to configure/)).toBeTruthy()
    expect(onlyNavButtons(stepSection('Configure'))).toBe(true)
    await clickNext() // Configure → Finalise & Review
    // Distinct wording from Configure's own reason (CreateWorkload.tsx's own
    // comment: "do not merge those sentences") — matched narrowly enough
    // that these two assertions cannot both pass against a single, merged
    // "nothing has been provisioned yet" sentence used for both steps.
    expect(
      within(stepSection('Finalise & Review')).getByText(/nothing to finalise or tear down/),
    ).toBeTruthy()
    expect(onlyNavButtons(stepSection('Finalise & Review'))).toBe(true)
  })
})

// ---- the slug the operator will get is SHOWN, not hidden ---------------

describe('studio name → shown workload identity', () => {
  it('derives and displays the slug that will actually be recorded as the operator types', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })

    typeStudioName('Studio A')
    const slugField = screen.getByLabelText('Workload identity') as HTMLInputElement
    expect(slugField.value).toBe('studio-a')
  })

  it('lets the operator edit the slug directly without the name field clobbering it', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })

    typeStudioName('Studio A')
    const slugField = screen.getByLabelText('Workload identity') as HTMLInputElement
    fireEvent.change(slugField, { target: { value: 'custom-slug' } })
    // Further edits to the name must not overwrite the operator's own edit.
    typeStudioName('Studio A Updated')
    expect(slugField.value).toBe('custom-slug')
  })

  it('renders the designed invalid-slug state, and blocks advancing past Identity entirely', async () => {
    // Reinterpreted for the wizard (was: "does not complete Design"). Under
    // the accordion, an invalid slug meant Design silently failed to
    // complete while its own panel stayed visible. Under the wizard,
    // Identity's own Next is gated on `hasName` (IdentityStep's
    // `canAdvance` prop) — with an invalid slug there is no Next BUTTON at
    // all, only the inert reason naming what's missing (CreateWorkload.tsx's
    // file docstring: "advancing past it before the name resolves to a
    // valid slug would let Design mount with nothing for the eventual
    // deploy to carry"). So Design isn't reachable to "not complete" — the
    // stronger, structural fact is that it can't be reached in the first
    // place, and that is what this now proves.
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })

    const slugField = screen.getByLabelText('Workload identity')
    fireEvent.change(slugField, { target: { value: 'Not Valid!' } })

    expect(screen.getByText(/lowercase letters, digits and hyphens/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Next/ })).toBeNull()
    expect(
      screen.getByText(/Enter a studio name that resolves to a valid workload identity/),
    ).toBeTruthy()
  })

  it('states the draft-loss limit near the name field', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    expect(
      screen.getByText(/refreshing or closing the tab before then loses it/),
    ).toBeTruthy()
  })

  // umbrella #432 §G (gate round 2, finding B2): the name typed here is
  // collected as though it were durable identity ("Studio identity",
  // "Studio name", a draft-loss warning implying the whole draft becomes
  // recorded on Provision) but is silently discarded — only the derived
  // slug below it is ever sent (Provision: the deploy POST tests below pin
  // that the body carries no name field at all). Both fixes are stated
  // near the name field itself, before the operator ever reaches Provision.
  it('explains near the name field that only the derived identifier is recorded, with a concrete example', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    expect(
      screen.getByText("Used to derive the workload's identifier — 'UI Review Studio' becomes 'ui-review-studio'."),
    ).toBeTruthy()
  })

  it('does not overclaim that the draft becomes recorded on Provision — only the identifier does, never the name', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    // THE discriminating assertion: the old text claimed "nothing about it
    // is recorded anywhere until then" (until Provision runs) — implying
    // the whole draft, name included, becomes recorded at that point. It
    // never does; only the slug is ever sent.
    expect(screen.queryByText(/nothing about it is recorded anywhere/)).toBeNull()
    expect(
      screen.getByText(/Provision records the workload identifier only; the studio name above is never stored anywhere\./),
    ).toBeTruthy()
  })
})

// ---- the deploy POST: the actual persistence seam -----------------------

// The ladder to a workable Provision step, shared by the deploy-POST tests
// and the journey tests below so both start from an identical state rather
// than two setups that can drift apart.
async function reachProvision() {
  await reachDesign()
  await chooseTemplate()
  await clickNext() // Design → Plan
  // WP-3 spec D: the facility resolving is no longer enough on its own —
  // Provision opens only once the operator confirms the resolved
  // placement (see "Provision opens only once the resolved facility is
  // confirmed" above for the gate itself, tested in isolation).
  fireEvent.click(await within(stepSection('Plan')).findByRole('button', { name: 'Confirm placement' }))
  await clickNext() // Plan → Provision
  return stepSection('Provision')
}

describe('Provision: the deploy POST', () => {
  it('carries both the mandatory reason and the workload slug, then navigates to the real workload route', async () => {
    const { deploy } = mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await reachProvision()

    fireEvent.click(within(provision).getByRole('button', { name: '▶ Provision now' }))
    const confirm = within(provision).getByRole('button', { name: 'Confirm provision' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(deploy).toHaveLength(0)

    fireEvent.change(
      within(provision).getByPlaceholderText('Reason (required, recorded in the audit trail)'),
      { target: { value: 'demo launch' } },
    )
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    // The destination is the REAL WorkloadSetup. The workload does not exist
    // yet — the launcher has not stamped the tag — so what must appear is the
    // materializing state, never a not-found.
    await screen.findByText('Deploy accepted.')
    expect(deploy).toHaveLength(1)
    const body = JSON.parse(deploy[0].init?.body as string)
    expect(body.reason).toBe('demo launch')
    expect(body.workload).toBe('studio-a')
  })

  it('leaves a persistent, non-vanishing failure on the step when the deploy fails', async () => {
    mkFetch({ deployStatus: 500 })
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await reachProvision()

    fireEvent.click(within(provision).getByRole('button', { name: '▶ Provision now' }))
    fireEvent.change(
      within(provision).getByPlaceholderText('Reason (required, recorded in the audit trail)'),
      { target: { value: 'demo launch' } },
    )
    fireEvent.click(within(provision).getByRole('button', { name: 'Confirm provision' }))

    // Failure is stated in plain words, never a raw exception, and it stays
    // up after the confirm panel itself closes.
    await waitFor(() =>
      expect(within(provision).getByText(/didn't go through — nothing was created/)).toBeTruthy(),
    )
    expect(within(provision).queryByPlaceholderText('Reason (required, recorded in the audit trail)')).toBeNull()
    // Never navigated away — nothing was created, so there is nothing to
    // navigate TO. Asserted against what the real destination would render
    // (its materializing state); the old form of this assertion named the
    // stub route element, which means it kept passing after the stub was
    // removed and would have kept passing if the page HAD navigated.
    expect(screen.queryByText('Deploy accepted.')).toBeNull()
    // Still on Create, not materializing — and still on the Provision step
    // specifically, since a failure never navigates away, so Identity's own
    // fields aren't mounted here to check any more (WP-3 spec C: only one
    // step is ever mounted). "Start over" is the page-level control that
    // IS always present regardless of step, and unique to CreateWorkload —
    // the retired per-page hero heading the old assertion named is gone.
    expect(screen.getByRole('button', { name: 'Start over' })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// An already-deployed template cannot be provisioned again (operator review,
// PR #66)
//
// ProvisionStage.tsx has always suppressed its deploy for an entry whose
// catalog lifecycle is `active` — one template provisions one NetBox service,
// so a second deploy is a duplicate against the same target. This page reused
// that page's deploy seam and did NOT carry the guard across: the picker
// offered "Use this template" and the Provision step offered "Provision now"
// for an entry already tagged active. Nothing here existed before, which is
// how it shipped.
//
// The pair that matters is the suppression AND the boundary below it: a guard
// that never offers anything would satisfy every suppression assertion, so
// the non-active lifecycles are driven table-style to pin `=== 'active'`
// rather than some broader refusal.
// ---------------------------------------------------------------------------

const ACTIVE = { key: 'mxl-viewer', lifecycle: 'active' as const }

describe('a template already deployed on this facility', () => {
  it('is marked in the picker instead of being offered', async () => {
    mkFetch({ catalog: [catalogEntry(ACTIVE)] })
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const design = await reachDesign()

    expect(await within(design).findByText('Already deployed')).toBeTruthy()
    // Not offered, and not offered-then-disabled: no dead control at all.
    expect(within(design).queryByRole('button', { name: 'Use this template' })).toBeNull()
    expect(within(design).getByText(/can't start a new workload here/)).toBeTruthy()
  })

  it('cannot be driven to an open Provision step by anything the picker offers', async () => {
    // The end-to-end consequence, driven the way the defect was reached
    // rather than restated as a second "no button" assertion: the operator
    // supplies a name and clicks WHATEVER the picker actually offers. With
    // the guard there is nothing to click, so Design never completes and the
    // gate holds Plan (and behind it Provision) shut. Without it, the click
    // lands, Design completes, and the flow walks straight to the duplicate
    // deploy — which is why this loops over the offers instead of asserting
    // their absence. Plan and Provision are still NAVIGABLE (the wizard's
    // Next is an unconditional index walk), which is exactly why this
    // checks their content rather than their reachability — see
    // onlyNavButtons's own doc comment.
    mkFetch({ catalog: [catalogEntry(ACTIVE)] })
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    await reachDesign()

    const design = stepSection('Design')
    for (const offer of within(design).queryAllByRole('button', { name: 'Use this template' })) {
      fireEvent.click(offer)
    }

    // hasName && hasTemplate are both synchronous, so Plan would have
    // unlocked by now if the click had been allowed to land.
    await clickNext() // Design → Plan
    expect(within(stepSection('Plan')).getByText(/This step opens once Design is complete/)).toBeTruthy()
    await clickNext() // Plan → Provision
    expect(onlyNavButtons(stepSection('Provision'))).toBe(true)
  })

  it('withdraws the Provision action if the template goes active after it was chosen', async () => {
    // THE REACHABLE PATH the picker guard alone does not close. The operator
    // selects a bootstrapped template, someone else deploys it, the catalog
    // re-reads — and the draft is now sitting on Provision with a live
    // button aimed at a duplicate deploy.
    const h = mkFetch({ catalog: [catalogEntry({ key: 'mxl-viewer', lifecycle: 'bootstrapped' })] })
    const queryClient = renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await reachProvision()
    // Precondition: it really was offered a moment ago, so what follows is a
    // withdrawal and not a test that never had anything to withdraw.
    expect(within(provision).getByRole('button', { name: '▶ Provision now' })).toBeTruthy()

    h.setCatalog([catalogEntry(ACTIVE)])
    await queryClient.invalidateQueries({ queryKey: ['catalog'] })

    await waitFor(() =>
      expect(within(stepSection('Provision')).queryByRole('button', { name: '▶ Provision now' })).toBeNull(),
    )
    expect(within(stepSection('Provision')).getByText(/nothing here to launch/)).toBeTruthy()
  })

  it('withdraws an ALREADY-ARMED confirm, with a filled-in reason, and fires no deploy', async () => {
    // The narrower half of the same race, driven to the last moment before
    // the POST: the confirm panel is open and the reason is typed when the
    // lifecycle flips. Suppressing only the arm button would leave "Confirm
    // provision" standing — one click from the deploy this whole guard
    // exists to refuse. The deploy count is asserted at the seam rather than
    // at the pixels, because that is the assertion that would have caught
    // the defect in the first place.
    const h = mkFetch({ catalog: [catalogEntry({ key: 'mxl-viewer', lifecycle: 'bootstrapped' })] })
    const queryClient = renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await reachProvision()
    fireEvent.click(within(provision).getByRole('button', { name: '▶ Provision now' }))
    fireEvent.change(
      within(provision).getByPlaceholderText('Reason (required, recorded in the audit trail)'),
      { target: { value: 'demo launch' } },
    )
    // Armed and satisfied: the confirm is live and would fire if clicked.
    expect(
      (within(provision).getByRole('button', { name: 'Confirm provision' }) as HTMLButtonElement).disabled,
    ).toBe(false)

    h.setCatalog([catalogEntry(ACTIVE)])
    await queryClient.invalidateQueries({ queryKey: ['catalog'] })

    await waitFor(() =>
      expect(within(stepSection('Provision')).queryByRole('button', { name: 'Confirm provision' })).toBeNull(),
    )
    expect(h.deploy).toHaveLength(0)
    expect(screen.queryByText('Deploy accepted.')).toBeNull()
  })

  // ---- a lifecycle the console can no longer read ------------------------

  // GATE-B7. The guard above is only as good as the read it judges, and the
  // first version of it trusted `entry.lifecycle` unconditionally. react-query
  // KEEPS the last successful data alongside isError, so on a failed refetch
  // the entry is a stale snapshot that can still say `bootstrapped` for a
  // template that went active in exactly the window the console stopped being
  // able to look — and the deploy fired. Driven here as an observed sequence
  // (the query really is put into `error` with data retained) rather than
  // argued from react-query's semantics.
  it('withholds provisioning while the catalog read is failing, and fires no deploy', async () => {
    const h = mkFetch({ catalog: [catalogEntry({ key: 'mxl-viewer', lifecycle: 'bootstrapped' })] })
    const queryClient = renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await reachProvision()
    fireEvent.click(within(provision).getByRole('button', { name: '▶ Provision now' }))
    fireEvent.change(
      within(provision).getByPlaceholderText('Reason (required, recorded in the audit trail)'),
      { target: { value: 'demo launch' } },
    )

    h.setCatalogStatus(500)
    await queryClient.invalidateQueries({ queryKey: ['catalog'] })
    await waitFor(() => expect(queryClient.getQueryState(['catalog'])?.status).toBe('error'))
    // The precondition that makes this defect possible, asserted rather than
    // assumed: the failed read did NOT clear the entries the guard reads.
    expect(queryClient.getQueryState(['catalog'])?.data).toBeTruthy()

    await waitFor(() =>
      expect(within(stepSection('Provision')).queryByRole('button', { name: 'Confirm provision' })).toBeNull(),
    )
    expect(within(stepSection('Provision')).queryByRole('button', { name: '▶ Provision now' })).toBeNull()
    expect(h.deploy).toHaveLength(0)

    // Withheld, not refused: it must not claim the template IS deployed,
    // because a failed read is not evidence of that either.
    const text = stepSection('Provision').textContent ?? ''
    expect(text).toMatch(/deployment state is unknown/)
    expect(text).toMatch(/Provisioning is withheld/)
    expect(text).not.toMatch(/already deployed on this facility/)
    // A withheld action has to say how it clears, and the recovery it names
    // has to be one the client actually performs. Two earlier drafts did
    // not: "keeps retrying on its own" (retry is 1, nothing polls) and
    // "read again when you return to this tab" (refetchOnWindowFocus only
    // refetches a STALE query, and staleTime is 30s). The surviving claim is
    // the condition plus a reload, which always re-reads because it builds a
    // fresh QueryClient.
    expect(text).toMatch(/withheld until the catalog can be read again/)
    expect(text).toMatch(/Reload the page/)
    expect(text).not.toMatch(/keeps retrying/)
    expect(text).not.toMatch(/return to this tab/)
  })

  it('does not promise an automatic retry the catalog query never performs', async () => {
    // The picker's failed branch carried the console's stock "Retrying
    // automatically." tail. That tail is true of the hooks that poll — most
    // of hooks.ts sets a refetchInterval — but useCatalog sets none, and the
    // client's retry is 1, so once it is exhausted nothing further happens.
    // Untested until now, which is how it sat two hundred lines from the
    // identical claim the Provision step had to have corrected twice.
    mkFetch({ catalogStatus: 500 })
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const design = await reachDesign()

    await waitFor(() => expect(design.textContent).toMatch(/couldn't be read right now/))
    expect(design.textContent).not.toMatch(/Retrying automatically/)
    expect(design.textContent).toMatch(/Reload the page/)
  })

  it('withdraws the action while a catalog re-read is still in flight', async () => {
    // GATE-B7 round 3. The read in flight is precisely the one that would
    // correct a lifecycle that has moved, so acting on the superseded answer
    // while its replacement is on the wire is the closeable part of the
    // staleness problem. Driven with a catalog response the test holds open,
    // so "in flight" is an actual observed state and not a timing accident.
    let release: (() => void) | null = null
    const h = mkFetch({ catalog: [catalogEntry({ key: 'mxl-viewer', lifecycle: 'bootstrapped' })] })
    const queryClient = renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await reachProvision()
    fireEvent.click(within(provision).getByRole('button', { name: '▶ Provision now' }))
    fireEvent.change(
      within(provision).getByPlaceholderText('Reason (required, recorded in the audit trail)'),
      { target: { value: 'demo launch' } },
    )
    expect(within(provision).getByRole('button', { name: 'Confirm provision' })).toBeTruthy()

    h.setCatalogGate(new Promise<void>((resolve) => { release = resolve }))
    void queryClient.invalidateQueries({ queryKey: ['catalog'] })
    await waitFor(() => expect(queryClient.getQueryState(['catalog'])?.fetchStatus).toBe('fetching'))

    await waitFor(() =>
      expect(within(stepSection('Provision')).queryByRole('button', { name: 'Confirm provision' })).toBeNull(),
    )
    expect(stepSection('Provision').textContent).toMatch(/Checking whether/)
    expect(h.deploy).toHaveLength(0)

    // And it is a window, not a latch: the answer lands clean and the action
    // returns. It comes back as the ARMED panel, because `arming` is the
    // page's state and the check never cancelled it — note the cost that
    // carries, which is real and accepted: ReasonConfirm was unmounted, so
    // the operator's typed reason is gone and has to be retyped. Losing an
    // unsubmitted reason is recoverable; firing a duplicate deploy is not.
    release!()
    await waitFor(() =>
      expect(within(stepSection('Provision')).getByRole('button', { name: 'Confirm provision' })).toBeTruthy(),
    )
    expect(stepSection('Provision').textContent).not.toMatch(/Checking whether/)
    expect(
      (within(stepSection('Provision')).getByRole('button', { name: 'Confirm provision' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(h.deploy).toHaveLength(0)
  })

  it('does not convert a stale "active" into a confident already-deployed claim', async () => {
    // The ordering inside `blocked` is load-bearing, so it gets a test
    // rather than only a comment. If the last successful read said active
    // and the NEXT read fails, checking lifecycle first would render "already
    // deployed — open it from Media Workloads": advice the console cannot
    // stand behind, because the same failed read hides a teardown just as
    // well as it hides a deploy. Both orderings suppress the action, so only
    // the claim distinguishes them — which is the whole point.
    const h = mkFetch({ catalog: [catalogEntry({ key: 'mxl-viewer', lifecycle: 'bootstrapped' })] })
    const queryClient = renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    await reachProvision()

    // Last GOOD read says active — the console may say so while it can see.
    h.setCatalog([catalogEntry({ key: 'mxl-viewer', lifecycle: 'active' })])
    await queryClient.invalidateQueries({ queryKey: ['catalog'] })
    await waitFor(() =>
      expect(stepSection('Provision').textContent).toMatch(/already deployed on this facility/),
    )

    // Now it cannot see. The retained data still says active; the claim must go.
    h.setCatalogStatus(500)
    await queryClient.invalidateQueries({ queryKey: ['catalog'] })
    await waitFor(() =>
      expect(stepSection('Provision').textContent).toMatch(/deployment state is unknown/),
    )
    const text = stepSection('Provision').textContent ?? ''
    expect(text).not.toMatch(/already deployed on this facility/)
    expect(text).not.toMatch(/There is nothing here to launch/)
    expect(h.deploy).toHaveLength(0)
  })

  it('offers provisioning again once the catalog read recovers', async () => {
    // The withholding must be a window, not a latch — otherwise a single
    // transient failure would strand the draft for good, and the test above
    // would be satisfied by a permanent refusal.
    const h = mkFetch({ catalog: [catalogEntry({ key: 'mxl-viewer', lifecycle: 'bootstrapped' })] })
    const queryClient = renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    await reachProvision()

    h.setCatalogStatus(500)
    await queryClient.invalidateQueries({ queryKey: ['catalog'] })
    await waitFor(() =>
      expect(within(stepSection('Provision')).queryByRole('button', { name: '▶ Provision now' })).toBeNull(),
    )

    h.setCatalogStatus(undefined)
    await queryClient.invalidateQueries({ queryKey: ['catalog'] })
    await waitFor(() =>
      expect(within(stepSection('Provision')).getByRole('button', { name: '▶ Provision now' })).toBeTruthy(),
    )
    expect(stepSection('Provision').textContent).not.toMatch(/Provisioning is withheld/)
  })

  // ---- the boundary: ONLY `active` is refused ---------------------------

  // Every other lifecycle the catalog can report must still be offered.
  // Without this, narrowing the guard to "never offer a template" — or to
  // `lifecycle !== 'bootstrapped'` — would pass every test above.
  for (const lifecycle of ['bootstrapped', 'unknown', 'error'] as const) {
    it(`still offers a "${lifecycle}" template, in the picker and at Provision`, async () => {
      mkFetch({ catalog: [catalogEntry({ key: 'mxl-viewer', lifecycle })] })
      renderCreate()
      await screen.findByRole('heading', { name: 'Identity' })

      // Checked mid-sequence, on Design, rather than via reachProvision()
      // outright: that helper starts back at Identity, and we need the
      // "not marked" assertion to run while Design is actually mounted.
      const design = await reachDesign()
      expect(within(design).queryByText('Already deployed')).toBeNull()
      await chooseTemplate()
      await clickNext() // Design → Plan
      fireEvent.click(await within(stepSection('Plan')).findByRole('button', { name: 'Confirm placement' }))
      await clickNext() // Plan → Provision
      const provision = stepSection('Provision')
      expect(within(provision).getByRole('button', { name: '▶ Provision now' })).toBeTruthy()
      expect(within(provision).queryByText(/nothing here to launch/)).toBeNull()
    })
  }

  it('offers the deployable templates alongside the ones it refuses', async () => {
    // A mixed catalog is the realistic shape, and the one where a guard
    // written as "if any entry is active, offer nothing" would show itself.
    mkFetch({
      catalog: [
        catalogEntry({ key: 'mxl-viewer', display_name: 'MXL Viewer', lifecycle: 'active' }),
        catalogEntry({ key: 'mxl-src', display_name: 'MXL Source', lifecycle: 'bootstrapped' }),
      ],
    })
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const design = await reachDesign()

    expect(await within(design).findByText('Already deployed')).toBeTruthy()
    // Exactly one entry is still selectable — the one that isn't deployed.
    const offers = within(design).getAllByRole('button', { name: 'Use this template' })
    expect(offers).toHaveLength(1)
    fireEvent.click(offers[0])

    // And it was the DEPLOYABLE one that became selectable — asserted on the
    // row itself, since the chosen template's name also lands in the Design
    // step's summary line and a document-wide lookup would match either.
    const chosen = within(design).getByText('Selected').closest('li') as HTMLElement
    expect(chosen.textContent).toMatch(/MXL Source/)
    expect(chosen.textContent).not.toMatch(/MXL Viewer/)
    const refused = within(design).getByText('Already deployed').closest('li') as HTMLElement
    expect(refused.textContent).toMatch(/MXL Viewer/)
  })
})

// ---------------------------------------------------------------------------
// The create JOURNEY (umbrella #285, GATE-B item 1)
//
// Deploy-accept is not existence. These drive the whole handoff against the
// REAL destination component: what the operator sees between "the POST
// resolved" and "the launcher stamped the tag", what happens when the launch
// job fails, and what the console says when it never learned the outcome at
// all. The bug these exist to prevent is the console denying the existence of
// a workload it had just created.
// ---------------------------------------------------------------------------

/**
 * Drive the create form all the way to a fired deploy, reusing the same
 * reachProvision() ladder the other tests use so the journey starts from the
 * identical state rather than a second, drifting setup.
 */
async function armAndConfirm() {
  renderCreate()
  await screen.findByRole('heading', { name: 'Identity' })
  const provision = await reachProvision()
  fireEvent.click(within(provision).getByRole('button', { name: '▶ Provision now' }))
  fireEvent.change(
    within(provision).getByPlaceholderText('Reason (required, recorded in the audit trail)'),
    { target: { value: 'demo launch' } },
  )
  fireEvent.click(within(provision).getByRole('button', { name: 'Confirm provision' }))
}

function workloadFixture(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [],
    functions: [],
  }
}

/**
 * dmfdeploy#414 gate, round 3: renders WorkloadSetup directly with a launch
 * handoff already in router state, bypassing armAndConfirm() — the create
 * journey's own fetch mock has no way to control the grouped read's
 * TIMING/OUTCOME independently of the deploy call, and that is exactly what
 * these tests need to hold open (isLoading forever, or force error/
 * unconfigured) while the launch handoff is what's actually under test.
 */
function renderSetupWithLaunch(launch: Record<string, unknown>, slug = 'studio-a') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: `/media-workloads/${slug}/setup`, state: { launch } }]}>
        <Routes>
          <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the destination never denies a just-launched workload', () => {
  it('renders the materializing state, not "Workload not found"', async () => {
    mkFetch({ workloads: [] })
    await armAndConfirm()

    await screen.findByText('Deploy accepted.')
    // THE regression this whole item exists for.
    expect(screen.queryByText('Workload not found')).toBeNull()
    expect(screen.queryByText(/No workload named/)).toBeNull()
    // It says what it is waiting for rather than implying the record exists.
    expect(screen.getByText(/appears here once the launcher records it/)).toBeTruthy()
  })

  // umbrella #432, FIX ROUND (operator feedback: "if you must keep all the
  // small text just add large friendly message... users will ignore all the
  // small text"). ADDITIVE per the operator's own amendment — the existing
  // "appears here once the launcher records it" paragraph (asserted above)
  // stays untouched; these pin the NEW loud layer on top of it.
  describe('the loud, friendly layer added on top of the existing record', () => {
    it('states a large, friendly message with a typical (not guaranteed) duration', async () => {
      mkFetch({ workloads: [] })
      await armAndConfirm()
      await screen.findByText('Deploy accepted.')

      const lead = screen.getByText(/The automation is running/)
      expect(lead.className).toMatch(/text-lg/)
      // Constitution hard gate 1 — no uncertainty stated as certainty: a
      // duration claim has to read as typical, never promised.
      expect(lead.textContent).toMatch(/typically takes/)
      expect(lead.textContent).not.toMatch(/\bwill take\b/)
    })

    it('links to Workspace and to Media Workloads, worded as facts rather than instructions', async () => {
      mkFetch({ workloads: [] })
      await armAndConfirm()
      await screen.findByText('Deploy accepted.')

      const workspace = screen.getByRole('link', { name: 'Workspace' })
      expect(workspace.getAttribute('href')).toBe('/')
      const mediaWorkloads = screen.getByRole('link', { name: 'Media Workloads' })
      expect(mediaWorkloads.getAttribute('href')).toBe('/media-workloads')

      // "The app states what it is doing; it never instructs" — the
      // operator's own example ("Watch the progress on…") is an
      // instruction; this states the same fact instead.
      const surroundingText = workspace.closest('p')?.textContent ?? ''
      expect(surroundingText).toMatch(/shows up on/)
      expect(surroundingText).not.toMatch(/watch/i)
    })

    // The honesty constraint the operator's amendment explicitly still
    // requires confirming, even though nothing here had to change to keep
    // it true: the part-way-through fact is the SAME pinned paragraph from
    // the first test in this describe block, still rendered, not replaced
    // or hidden behind the new message.
    it('still renders the part-way-through fact untouched, alongside the new message', async () => {
      mkFetch({ workloads: [] })
      await armAndConfirm()
      await screen.findByText('Deploy accepted.')

      expect(screen.getByText(/The automation is running/)).toBeTruthy()
      expect(
        screen.getByText(/The launcher does that PART-WAY through the job below/),
      ).toBeTruthy()
    })
  })

  it('still renders not-found for a slug that arrives WITHOUT a launch', async () => {
    // The materializing state must be reachable only via the create handoff —
    // otherwise a genuinely missing workload would render as "provisioning"
    // forever, which is the same lie pointed the other way.
    mkFetch({ workloads: [] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/ghost/setup']}>
          <Routes>
            <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Workload not found')).toBeTruthy()
    expect(screen.queryByText('Deploy accepted.')).toBeNull()
  })

  it('becomes the real flow once the launcher records the workload', async () => {
    // The happy path ends by the materializing view disappearing ON ITS OWN,
    // driven by the INVENTORY. This drives the real causal chain rather than
    // waiting out a poll: the launcher stamps the tag, the job finishes, the
    // finished job prompts a re-read, and the re-read is what swaps the page.
    // Note the ordering — the workload is recorded BEFORE the job completes,
    // which is the actual sequence; the job finishing is merely when the
    // console next looks.
    const h = mkFetch({ workloads: [], jobStatus: { 900: { status: 'running', is_done: false } } })
    await armAndConfirm()
    await screen.findByText('Deploy accepted.')
    expect(screen.queryByText('Workload not found')).toBeNull()

    h.setWorkloads([workloadFixture()])
    h.setJobStatus(900, { status: 'successful', is_done: true })

    await waitFor(
      () => expect(screen.queryByText('Deploy accepted.')).toBeNull(),
      { timeout: 8000 },
    )
    // It became the actual flow page, not a third state.
    expect(screen.getByRole('navigation', { name: 'Media workload lifecycle' })).toBeTruthy()
  }, 15000)

  // dmfdeploy#414 gate, round 1 (P1): the setup exit here is the SAME
  // shared ViewLiveExit WorkloadSetup.tsx's loading-safe branches use, and
  // it obeys the identical job-navigation lock — while the launch job is
  // genuinely still being polled, "View live" would send the operator into
  // home's own not-found/unresolved reading for the workload they just
  // created, since the launcher has not stamped its identity into NetBox
  // yet. NEW test — the earlier round shipped this exit always-active,
  // reasoned (wrongly) as safe because leaving does not cancel the launch
  // job server-side. Of the tests in this describe block, this is the one
  // that discriminates round 1's fix on its own: it checks BOTH the locked
  // state and the release, so a baseline that never locked at all (round 1's
  // actual bug) fails it. The FAILED-terminal test right after it checks
  // only a single unlocked state and is labelled a guard accordingly (round
  // 2 gate correction); the operation-level test further below is round 2's
  // own discriminating test, labelled where it sits.
  it('the "View live" exit stays locked while the launch job is polling, then unlocks once it settles', async () => {
    const h = mkFetch({ workloads: [], jobStatus: { 900: { status: 'running', is_done: false } } })
    await armAndConfirm()
    await screen.findByText('Deploy accepted.')

    // Locked: inert text naming the reason, never a disabled link. umbrella
    // #499: the reason is on demand (title + sr-only text) rather than
    // painted inline — see ViewLiveExit.tsx's own docstring.
    expect(screen.queryByRole('link', { name: 'View live' })).toBeNull()
    expect(screen.getByText('View live').getAttribute('title')).toBe('The launch job is in progress.')

    h.setJobStatus(900, { status: 'successful', is_done: true })

    // Unlocked the moment the job reaches a terminal state — even though
    // the workload has not yet appeared in the inventory (still
    // materialising, still says "Deploy accepted."). The job-status poll
    // (JobProgress.tsx) runs on a 2s interval, longer than waitFor's 1s
    // default — same reasoning workloadSetup.test.tsx's own
    // ViewLiveExit-settles test already documents for the identical class
    // of wait.
    await waitFor(() => expect(screen.getByRole('link', { name: 'View live' })).toBeTruthy(), {
      timeout: 5000,
    })
    expect(screen.queryByText(/View live — /)).toBeNull()
  }, 10000)

  // dmfdeploy#414 gate, round 2 (P2): GUARD, relabelled — this was carried
  // over from round 1 under the same "NEW test" framing as the one above,
  // but on its own it does not discriminate the fix from its absence. The
  // pre-round-1 baseline (ViewLiveExit always rendered the active Link,
  // unconditionally) would ALSO show the Link here, since that baseline
  // never withheld it for ANY job state — a test that only checks the
  // unlocked case cannot tell "correctly unlocked" apart from "never
  // locked at all". The test immediately above already proves the lock
  // exists AND releases (checks both states); this one only extends that
  // already-proven mechanism to the FAILED-terminal case rather than
  // independently proving anything new. Kept as a guard because the
  // FAILED-vs-successful distinction is still worth pinning on its own.
  //
  // Re-checked against round 2's P1 fix (the operation-level raw-terminal
  // signal, JobProgress.tsx): this test drives armAndConfirm()'s SYNC
  // deploy path (job_id present in the launch handoff from the very
  // first render, no operationId), so OperationStatusLine never mounts and
  // the new operationDone signal never leaves its initial `false` — this
  // case is governed entirely by jobDone (round 1) both before and after
  // round 2's change. It does not become newly discriminating; still a
  // guard.
  it('unlocks on a FAILED terminal job too, not only a successful one', async () => {
    mkFetch({ workloads: [], jobStatus: { 900: { status: 'failed', is_done: true } } })
    await armAndConfirm()
    await screen.findByText(/did not succeed/, {}, { timeout: 4000 })

    // A real failure is something to go and look at, not a reason to keep
    // the operator here — see ViewLiveExit.tsx's own docstring.
    expect(screen.getByRole('link', { name: 'View live' })).toBeTruthy()
  })

  // dmfdeploy#414 gate, round 2 (P1): round 1's fix above covered the JOB
  // half of this lock (jobDone, fed by JobStatusLine's unpaced
  // onDoneChange) but left the OPERATION half reading operationFailed —
  // set from OperationStatusLine's onError callback, which is deliberately
  // PACED (3s, "long enough to actually read before the line clears", per
  // that timer's own comment) so a human watching the status line has time
  // to read "Error" before whatever consumes the callback reacts. That left
  // the exit locked, still claiming "wait for its outcome", for up to 3
  // more seconds after the status line right next to it had already
  // switched to "Error" — the identical defect class as round 1's P1, one
  // layer down. NEW test: it asserts the unlock is observable WHILE the
  // heading is still "Provisioning", i.e. strictly before the paced flip to
  // "Launch failed" — a fix that reads only the paced signal cannot pass
  // this, since operationFailed (and therefore the heading) does not exist
  // yet at that point. Mutation-verified: reverting jobInFlight to ignore
  // operationDone reproduces the failure this test exists to catch.
  it('the "View live" exit unlocks on a raw operation error before the paced failure heading catches up', async () => {
    mkFetch({
      workloads: [],
      deployResult: { operation_id: 'op-err2', state: 'launching' },
      operation: { operation_id: 'op-err2', state: 'error', job_id: null, error: 'no capacity' },
    })
    await armAndConfirm()
    // Anchors on the materializing view specifically, before checking the
    // lock. Before dmfdeploy#414 gate round 3's fix, WorkloadSetup's own
    // isLoading branch reached an (unconditionally active) "View live"
    // link on the very first render — before the grouped read had resolved
    // even once — so checking for the link without anchoring here could
    // have matched THAT link instead of this one. Round 3 hoisted the
    // launch-handoff check ahead of isLoading (see WorkloadSetup.tsx), so
    // that branch is no longer reachable while `launch` is present at
    // all — the anchor stays as defensive test hygiene, not because the
    // race it used to guard against can still happen.
    await screen.findByText('Deploy accepted.')

    // Caught early — well inside the 3s pace on the failure heading below —
    // so this cannot be passing merely because both eventually happen.
    await waitFor(() => expect(screen.getByRole('link', { name: 'View live' })).toBeTruthy(), {
      timeout: 1500,
    })
    expect(screen.getByRole('heading', { name: 'Provisioning' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Launch failed' })).toBeNull()

    // The paced heading catches up afterwards, on its own unchanged
    // schedule — this only needs to show the two are no longer coupled, not
    // re-prove the heading transition other tests already cover.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Launch failed' })).toBeTruthy(), {
      timeout: 4000,
    })
  }, 10000)

  // dmfdeploy#414 gate, round 3 (P1): a THIRD instance of the same defect
  // shape as the two rounds above — reasoning correct about one path,
  // silently wrong about the path that bypasses it. WorkloadSetup's own
  // isLoading/error/unconfigured early returns sat ABOVE the launch-handoff
  // check that routes to WorkloadMaterializing, and every one of them
  // rendered ExitRow — the loading-safe exit with no jobInFlight at all,
  // reasoned (correctly, but incompletely) as safe because "no job of THIS
  // wizard's own can be in flight before its workload record resolves".
  // True about the wizard's own jobs; false about a HANDED-OFF launch,
  // which has its own job/operation in flight regardless of what this
  // page's read is doing. Three gate rounds and a green CI run all missed
  // this — it was found by the review harness, on a path none of them
  // enumerated. Fixed by hoisting the launch-handoff check ahead of all
  // three (WorkloadSetup.tsx). All three tests below must fail against
  // 39f4e0f — the commit these gate rounds had been squashing into before
  // this fix landed.
  it('the exit is locked, not active, while the grouped read is still loading for a launch handoff', async () => {
    mkFetch({ groupedPending: true, operation: { operation_id: 'op-load', state: 'launching', job_id: null } })
    renderSetupWithLaunch({ entryKey: 'crosspoint', operationId: 'op-load' })

    // The grouped read never resolves for the lifetime of this test, so
    // reaching the materializing view (and its lock) at all proves it did
    // not wait on isLoading to clear — the old code could only have reached
    // "Loading workload…" here, forever.
    await screen.findByText('Deploy accepted.')
    expect(screen.queryByRole('link', { name: 'View live' })).toBeNull()
    // umbrella #499: the reason is on demand (title), not painted inline.
    expect(screen.getByText('View live').getAttribute('title')).toBe('The launch job is in progress.')
  })

  it('the exit is locked, not active, when the grouped read is persistently failing for a launch handoff', async () => {
    mkFetch({ groupedStatus: 500, operation: { operation_id: 'op-err3', state: 'launching', job_id: null } })
    renderSetupWithLaunch({ entryKey: 'crosspoint', operationId: 'op-err3' })

    await screen.findByText('Deploy accepted.')
    // Proves the ERROR branch's own copy never rendered — this is the
    // materializing view, not WorkloadSetup's "could not be loaded" panel.
    expect(screen.queryByText(/could not be loaded right now/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'View live' })).toBeNull()
    expect(screen.getByText('View live').getAttribute('title')).toBe('The launch job is in progress.')
  })

  it('the exit is locked, not active, when the environment reports unconfigured for a launch handoff', async () => {
    mkFetch({ groupedConfigured: false, operation: { operation_id: 'op-unconf', state: 'launching', job_id: null } })
    renderSetupWithLaunch({ entryKey: 'crosspoint', operationId: 'op-unconf' })

    await screen.findByText('Deploy accepted.')
    expect(screen.queryByText(/not configured for this environment/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'View live' })).toBeNull()
    expect(screen.getByText('View live').getAttribute('title')).toBe('The launch job is in progress.')
  })
})

describe('a launch job that does not succeed surfaces, and stops promising a workload', () => {
  // Table-driven over EVERY terminal state, because a set membership test
  // that only ever exercises one member pins nothing about the others: with
  // only 'failed' driven, narrowing the set to failed-only survived the whole
  // suite. Each of these must independently produce the failure surface.
  for (const status of ['failed', 'error', 'canceled'] as const) {
    it(`treats a "${status}" job as terminal, not as still-in-progress`, async () => {
      mkFetch({ workloads: [], jobStatus: { 900: { status, is_done: true } } })
      await armAndConfirm()

      expect(await screen.findByText(/did not succeed/, {}, { timeout: 4000 })).toBeTruthy()
      // The specific state is named, not flattened to a generic failure.
      expect(screen.getByText(new RegExp(`finished as "${status}"`))).toBeTruthy()
      // And it stops claiming something is coming.
      expect(screen.queryByText(/appears here once the launcher records it/)).toBeNull()
    })
  }

  it('does not deny that a failed job may already have recorded the workload', async () => {
    // The launcher writes the tagged record PART-WAY through the run and the
    // fault boundary sits after it, so a job that fails later has already
    // created it — and the run guard only MARKS failed_rollback_required, it
    // does not roll back. Copy that said "nothing is recorded" was therefore
    // misinformation about the facility, not a loose sentence.
    mkFetch({ workloads: [], jobStatus: { 900: { status: 'failed', is_done: true } } })
    await armAndConfirm()

    const panel = await screen.findByLabelText('Workload provisioning')
    await waitFor(() => expect(panel.textContent).toMatch(/did not succeed/))
    expect(panel.textContent).toMatch(/may still have recorded the workload before it failed/)
    expect(panel.textContent).toMatch(/until a rollback is run/)
    // The claim that must NOT be made on this path.
    expect(panel.textContent).not.toMatch(/[Nn]othing was recorded/)
  })

  it('DOES say nothing was recorded when the job never started', async () => {
    // The one branch where the stronger statement is earned: an operation
    // error means no task ran, so no mutation happened.
    mkFetch({
      workloads: [],
      deployResult: { operation_id: 'op-err', state: 'launching' },
      operation: { operation_id: 'op-err', state: 'error', job_id: null, error: 'no capacity' },
    })
    await armAndConfirm()

    const panel = await screen.findByLabelText('Workload provisioning')
    await waitFor(() => expect(panel.textContent).toMatch(/did not succeed/), { timeout: 8000 })
    expect(panel.textContent).toMatch(/nothing ran and nothing was recorded/)
    expect(panel.textContent).not.toMatch(/may still have recorded/)
  }, 15000)

  it('still becomes the real flow if a failed launch left the record behind', async () => {
    // "Failed" bounds what the console knows, not what the facility contains:
    // if the inventory does report the workload, the page must swap exactly as
    // it would have on a clean launch rather than staying stuck on the failure.
    const h = mkFetch({ workloads: [], jobStatus: { 900: { status: 'failed', is_done: true } } })
    await armAndConfirm()
    await screen.findByText(/did not succeed/)

    h.setWorkloads([workloadFixture()])
    await waitFor(() => expect(screen.queryByText(/did not succeed/)).toBeNull(), { timeout: 8000 })
    expect(screen.getByRole('navigation', { name: 'Media workload lifecycle' })).toBeTruthy()
  }, 15000)

  it('does NOT treat a still-running job as terminal', async () => {
    // The other side of the boundary: without this, a set containing every
    // string would also pass the cases above.
    mkFetch({ workloads: [], jobStatus: { 900: { status: 'running', is_done: false } } })
    await armAndConfirm()

    await screen.findByText('Deploy accepted.')
    expect(screen.queryByText(/did not succeed/)).toBeNull()
  })

  it('does NOT treat a successful job as a failure', async () => {
    // As first written this awaited 'Deploy accepted.', which renders on MOUNT
    // — before the job-status poll has resolved — so the no-failure assertion
    // ran against the initial render and held no matter what the component
    // did with a successful job. It was vacuous AS NAMED: the boundary was
    // covered elsewhere in the file, which is exactly what made it easy to
    // miss. Now it waits for the successful status to have been OBSERVED
    // before asserting, so it discriminates on its own.
    mkFetch({ workloads: [], jobStatus: { 900: { status: 'successful', is_done: true } } })
    await armAndConfirm()

    // The success-specific copy only renders once jobStatus === 'successful'
    // has reached the component, so finding it proves the status was applied.
    await screen.findByText(/The job has finished but the record still is not readable/)
    expect(screen.queryByText(/did not succeed/)).toBeNull()
    expect(screen.queryByText(/finished as "successful"/)).toBeNull()
  })
})

describe('an outcome the console never learned is never reported as "nothing happened"', () => {
  it('says OUTCOME UNKNOWN when the connection is lost mid-deploy', async () => {
    mkFetch({ deployThrows: true })
    await armAndConfirm()

    const provision = stepSection('Provision')
    await waitFor(() => expect(provision.textContent).toMatch(/Outcome unknown/))
    // The specific claim that must NOT be made: transport loss cannot
    // establish that nothing was created.
    expect(provision.textContent).not.toMatch(/nothing was created/)
    expect(provision.textContent).toMatch(/Check Media Workloads before trying again/)
  })

  it('DOES say nothing was created when the server itself refused', async () => {
    // The other half of the split: a 409 is an answer, so the stronger
    // statement is earned here.
    mkFetch({ deployStatus: 409 })
    await armAndConfirm()

    const provision = stepSection('Provision')
    await waitFor(() => expect(provision.textContent).toMatch(/nothing was created/))
    expect(provision.textContent).toMatch(/already in flight/)
    expect(provision.textContent).not.toMatch(/Outcome unknown/)
  })
})

// ---------------------------------------------------------------------------
// WP-3 spec C acceptance: the draft survives navigating away and back within
// the tab (a non-persisted store the wizard makes newly reachable), and is
// architecturally incapable of surviving a reload — the trade
// store/draftWorkload.ts's own docstring states, and the copy pinned above
// (see "states the draft-loss limit near the name field") states to the
// operator. These pin the acceptance criterion itself, distinct from the
// copy that describes it.
// ---------------------------------------------------------------------------

describe('the draft survives the tab, not the browser', () => {
  it('navigate away and back — draft preserved', async () => {
    mkFetch()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function renderAt(path: string) {
      return render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/media-workloads" element={<div>Media Workloads (stand-in)</div>} />
              <Route path="/media-workloads/new" element={<CreateWorkload />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      )
    }

    let mounted = renderAt('/media-workloads/new')
    await screen.findByRole('heading', { name: 'Identity' })
    typeStudioName('Studio A')
    expect((screen.getByLabelText('Workload identity') as HTMLInputElement).value).toBe('studio-a')

    // "Navigate away": CreateWorkload's own presentation state (selectedStep)
    // is explicitly NOT what this proves — it resets to null on every mount
    // by design (CreateWorkload.tsx's own comment on selectedStep). What
    // must survive is the DRAFT DATA, which lives outside the component tree
    // entirely, in useDraftWorkloadStore. Unmounting the routed tree and
    // mounting a different route is the faithful jsdom analogue of an in-app
    // route change: React tears the page down exactly as the router would on
    // a real navigation, while the module-level store singleton — never
    // touched by that teardown — is not.
    mounted.unmount()
    mounted = renderAt('/media-workloads')
    expect(screen.getByText('Media Workloads (stand-in)')).toBeTruthy()
    mounted.unmount()

    mounted = renderAt('/media-workloads/new')
    // The remounted wizard's own default-step derivation (CreateWorkload.tsx:
    // `defaultStep = draft.hasName && flow.current ? flow.current : 'identity'`)
    // lands on DESIGN here, not Identity — the preserved name is still a
    // valid slug, so the wizard picks up exactly where the progress it can
    // read left off, rather than making the operator re-walk a step they
    // already finished. That is a STRONGER form of "preserved" than the
    // fields alone, so it is asserted rather than routed around.
    await screen.findByRole('heading', { name: 'Design' })
    await clickPrevious() // Design → Identity, to read the preserved fields
    // Read through the rendered DOM, not the store directly — this is what
    // the operator actually sees on returning to the page.
    expect((screen.getByLabelText('Studio name') as HTMLInputElement).value).toBe('Studio A')
    expect((screen.getByLabelText('Workload identity') as HTMLInputElement).value).toBe('studio-a')
  })

  it('reload — draft GONE: no persist middleware ever writes it to storage', async () => {
    // A genuine reload is not reproducible inside jsdom without literally
    // restarting the module registry (the store singleton, like every other
    // module, is cached for the life of the test file). A same-process
    // remount — which the test above deliberately relies on, to prove the
    // OPPOSITE property — would prove nothing here: the store survives a
    // remount whether or not persistence exists, so it cannot discriminate
    // "gone on reload" from "misleadingly still there", which is exactly the
    // failure mode store/draftWorkload.ts's own docstring warns a persisted
    // store would produce.
    //
    // What CAN be proven in-process, and is the actual acceptance criterion
    // ("NO persist middleware, deliberately"), is architectural: does
    // anything the draft's own setters do write through to storage that
    // would outlive a real reload? zustand's `persist` middleware, if it
    // were ever wired back in, calls localStorage.setItem/sessionStorage.
    // setItem on every tracked state change — so driving every field the
    // draft has (name, slug, template, facility confirmation) and finding
    // both storages exactly as they started is a direct, code-path-level
    // proof of "no persist middleware", not an inference from a remount
    // that can't tell the difference.
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })

    const localBefore = window.localStorage.length
    const sessionBefore = window.sessionStorage.length

    await reachProvision()

    expect(window.localStorage.length).toBe(localBefore)
    expect(window.sessionStorage.length).toBe(sessionBefore)
  })

  it('Start over clears the draft', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    await reachDesign()
    await chooseTemplate()

    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))

    // Start over resets BOTH the draft store's data and the wizard's own
    // navigation position back to Identity (CreateWorkload.tsx's own
    // handleStartOver) — landing anywhere else would show a step whose
    // content had silently emptied out from under the operator instead of a
    // plain, legible reset.
    await screen.findByRole('heading', { name: 'Identity' })
    expect((screen.getByLabelText('Studio name') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Workload identity') as HTMLInputElement).value).toBe('')
  })

  it('a successful provision clears the draft', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await reachProvision()

    fireEvent.click(within(provision).getByRole('button', { name: '▶ Provision now' }))
    fireEvent.change(
      within(provision).getByPlaceholderText('Reason (required, recorded in the audit trail)'),
      { target: { value: 'demo launch' } },
    )
    fireEvent.click(within(provision).getByRole('button', { name: 'Confirm provision' }))

    // handleProvisionConfirm's resetDraft() runs before the navigation that
    // carries the launch, so pinned directly on the store rather than
    // through the DOM: by the time the operator can see anything, the page
    // has already navigated away from Create entirely (see "the destination
    // never denies a just-launched workload" above for what renders there
    // instead).
    await screen.findByText('Deploy accepted.')
    expect(useDraftWorkloadStore.getState().studioName).toBe('')
    expect(useDraftWorkloadStore.getState().slug).toBe('')
    expect(useDraftWorkloadStore.getState().selectedKey).toBeNull()
    // FIX ROUND P2-4: renamed from a bare boolean to the confirmed
    // facility's own identity — see draftWorkload.ts's own docstring.
    expect(useDraftWorkloadStore.getState().confirmedFacilityName).toBeNull()
  })
})

describe('readLaunchState narrows untrusted router state', () => {
  // Router state is not validated by anything upstream — it survives history
  // entries, back/forward, and anything a caller chooses to put there. A
  // malformed launch must resolve to null (so the page falls through to the
  // ordinary not-found) rather than half-populating a launch whose entryKey
  // would compose a broken job-status URL like /api/catalog//status/900.
  it('accepts a well-formed launch, in both shapes the deploy seam returns', () => {
    expect(readLaunchState({ launch: { entryKey: 'mxl-viewer', jobId: 900 } })).toEqual({
      entryKey: 'mxl-viewer',
      operationId: undefined,
      jobId: 900,
    })
    expect(readLaunchState({ launch: { entryKey: 'mxl-viewer', operationId: 'op-1' } })).toEqual({
      entryKey: 'mxl-viewer',
      operationId: 'op-1',
      jobId: undefined,
    })
  })

  it('rejects a launch with a missing, empty or non-string entry key', () => {
    // The empty-string case is the one that matters: it is truthy-adjacent
    // enough to slip a bare `typeof === "string"` check and then silently
    // produce a malformed request path.
    expect(readLaunchState({ launch: { entryKey: '', jobId: 900 } })).toBeNull()
    expect(readLaunchState({ launch: { jobId: 900 } })).toBeNull()
    expect(readLaunchState({ launch: { entryKey: 7, jobId: 900 } })).toBeNull()
  })

  it('rejects anything that is not a launch at all', () => {
    expect(readLaunchState(null)).toBeNull()
    expect(readLaunchState(undefined)).toBeNull()
    expect(readLaunchState('mxl-viewer')).toBeNull()
    expect(readLaunchState({})).toBeNull()
    expect(readLaunchState({ launch: null })).toBeNull()
    expect(readLaunchState({ launch: 'mxl-viewer' })).toBeNull()
  })

  it('rejects a launch left with nothing to poll after wrong-typed ids are dropped', () => {
    // This used to assert the OPPOSITE — that an entryKey-only object was an
    // acceptable launch. It is not: the destination would render "Deploy
    // accepted" with no job to follow, permanently, for a workload that may
    // never arrive. A launch with no pollable reference is malformed, and the
    // page must fall through to the ordinary not-found.
    expect(readLaunchState({ launch: { entryKey: 'k', jobId: '900', operationId: 42 } })).toBeNull()
    expect(readLaunchState({ launch: { entryKey: 'k' } })).toBeNull()
    expect(readLaunchState({ launch: { entryKey: 'k', operationId: '' } })).toBeNull()
  })

  it('keeps a launch that retains at least one usable reference', () => {
    // The narrowing must reject only what is unusable — a good job id beside
    // a junk operation id is still pollable and must survive.
    expect(readLaunchState({ launch: { entryKey: 'k', jobId: 900, operationId: 42 } })).toEqual({
      entryKey: 'k',
      operationId: undefined,
      jobId: 900,
    })
    expect(readLaunchState({ launch: { entryKey: 'k', jobId: '900', operationId: 'op-1' } })).toEqual({
      entryKey: 'k',
      operationId: 'op-1',
      jobId: undefined,
    })
  })

  it('never lands the destination on an unpollable "Deploy accepted" ghost', () => {
    // The end-to-end consequence of the rule above, asserted at the page.
    mkFetch({ workloads: [] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[
            { pathname: '/media-workloads/studio-a/setup', state: { launch: { entryKey: 'mxl-viewer' } } },
          ]}
        >
          <Routes>
            <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.queryByText('Deploy accepted.')).toBeNull()
    return waitFor(() => expect(screen.getByText('Workload not found')).toBeTruthy())
  })
})

// ---------------------------------------------------------------------------
// umbrella #432 §C — the shared form-field primitive (components/FormField.tsx)
//
// Measured live on 0.26.0: document.activeElement was BODY on load (nothing
// focused), the studio name field was 1295px wide, its fill read ~1.03:1
// against its panel, and its border rendered sub-pixel (0.667px at 10%
// white). The width/fill/border symptoms are fixed inside the primitive
// itself and pinned once, generically, in formFieldPrimitive.test.tsx —
// what's specific to THIS page is focus-on-entry (Identity is the wizard's
// first step) and that both Identity fields actually render through it.
// ---------------------------------------------------------------------------

describe('umbrella #432 §C: Identity fields and focus-on-entry', () => {
  it('focuses the studio name field on mount, not BODY', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    expect(document.activeElement).toBe(screen.getByLabelText('Studio name'))
  })

  it('renders the studio name and workload slug fields through the shared .field primitive', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })

    const nameField = screen.getByLabelText('Studio name')
    const slugField = screen.getByLabelText('Workload identity')
    expect(nameField.className.split(/\s+/)).toContain('field')
    expect(slugField.className.split(/\s+/)).toContain('field')
  })
})

// ---------------------------------------------------------------------------
// umbrella #432 §D1 — exactly one cyan promoted control per screen. Unlike
// the real WorkloadSetup wizard (see workloadSetup.test.tsx's identically-
// named describe block for why only ONE branch is reachable there), THIS
// wizard's Next is UNCONDITIONAL on lock state by design (this file's own
// docstring: "Design → Finalise & Review is UNCONDITIONAL... never gated on
// lock state") — so both branches of the rule are genuinely observable
// here, on the very same Provision step, just by changing whether it has
// something of its own to offer.
// ---------------------------------------------------------------------------

describe('umbrella #432 §D1: Next carries primary weight only when the mounted step has none of its own', () => {
  it('Identity\'s own Next is primary — Identity never offers a promoted action of its own', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    typeStudioName('Studio A')
    const next = await screen.findByRole('button', { name: /Next/ })
    expect(next.className.split(/\s+/)).toContain('btn-primary')
    expect(next.className.split(/\s+/)).not.toContain('btn-secondary')
  })

  // umbrella #432 §D1 REVERSAL (operator report, live in Chrome on 0.27.1):
  // this test used to assert Design's Next was ALWAYS primary — that was
  // itself the regression §D1 shipped. "Use this template" is Design's own
  // commitment; while it's showing, Next must NOT be the one cyan control
  // on screen — it points at a locked Plan, while the actual unblocking
  // action sits there looking like a neutral back button.
  it('stays neutral on Design while "Use this template" is showing', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const design = await reachDesign()
    within(design).getByRole('button', { name: 'Use this template' })
    const next = within(design).getByRole('button', { name: 'Next →' })
    expect(next.className.split(/\s+/)).toContain('btn-secondary')
    expect(next.className.split(/\s+/)).not.toContain('btn-primary')
  })

  // The other half of the dynamic — the same shape ProvisionStage already
  // has: once the commitment is made, the step's own control disappears
  // and Next may go primary again.
  it('goes primary on Design once a template is chosen (the commitment button is gone)', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const design = await reachDesign()
    await chooseTemplate()
    expect(within(design).queryByRole('button', { name: 'Use this template' })).toBeNull()
    const next = within(design).getByRole('button', { name: 'Next →' })
    expect(next.className.split(/\s+/)).toContain('btn-primary')
    expect(next.className.split(/\s+/)).not.toContain('btn-secondary')
  })

  // The equivalent pair for Plan's own "Confirm placement".
  it('stays neutral on Plan while "Confirm placement" is showing', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    await reachDesign()
    await chooseTemplate()
    await clickNext() // Design -> Plan
    const plan = stepSection('Plan')
    await within(plan).findByRole('button', { name: 'Confirm placement' })
    const next = within(plan).getByRole('button', { name: 'Next →' })
    expect(next.className.split(/\s+/)).toContain('btn-secondary')
    expect(next.className.split(/\s+/)).not.toContain('btn-primary')
  })

  it('goes primary on Plan once placement is confirmed (the confirm button is gone)', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    await reachDesign()
    await chooseTemplate()
    await clickNext() // Design -> Plan
    const plan = stepSection('Plan')
    fireEvent.click(await within(plan).findByRole('button', { name: 'Confirm placement' }))
    expect(within(plan).queryByRole('button', { name: 'Confirm placement' })).toBeNull()
    const next = within(plan).getByRole('button', { name: 'Next →' })
    expect(next.className.split(/\s+/)).toContain('btn-primary')
    expect(next.className.split(/\s+/)).not.toContain('btn-secondary')
  })

  it('stays neutral on Provision while "▶ Provision now" is showing', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await reachProvision()
    within(provision).getByRole('button', { name: '▶ Provision now' })
    const next = within(provision).getByRole('button', { name: 'Next →' })
    expect(next.className.split(/\s+/)).toContain('btn-secondary')
    expect(next.className.split(/\s+/)).not.toContain('btn-primary')
  })

  it('goes primary on Provision once nothing is offered (the catalog read is failing)', async () => {
    const h = mkFetch()
    const queryClient = renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await reachProvision()
    within(provision).getByRole('button', { name: '▶ Provision now' })

    h.setCatalogStatus(500)
    await queryClient.invalidateQueries({ queryKey: ['catalog'] })
    await waitFor(() =>
      expect(within(stepSection('Provision')).queryByRole('button', { name: '▶ Provision now' })).toBeNull(),
    )

    const next = within(stepSection('Provision')).getByRole('button', { name: 'Next →' })
    expect(next.className.split(/\s+/)).toContain('btn-primary')
    expect(next.className.split(/\s+/)).not.toContain('btn-secondary')
  })
})

// ---------------------------------------------------------------------------
// umbrella #432 §D1 FIX ROUND (codex gate item 6, confirmed against be4a44b
// by both the reviewer and independently here): Next was never primary
// ONLY on Provision — the guard at CreateWorkload.tsx's own `nextIsPrimary`
// only checks `stepId === 'provision'`, so for every OTHER stepId the
// expression is unconditionally true. Configure and Finalise & Review are
// LOCKED FOR THE WHOLE DRAFT (this file's own docstring) regardless of
// anything the operator does, so a cyan Next pointing at locked prose was
// not a contrived edge case — it was hit by simply pressing Next through
// the wizard. Provision itself could ALSO render it whenever the catalog
// read merely happened to be fetching or failing, with no template chosen
// at all — an accident of network timing, unrelated to reachability.
//
// Fixed at FlowStep.tsx (`nextPrimary && !locked`), not by adding a lock
// check to every caller's own `nextIsPrimary` — one clamp, reusing the
// `state` prop every caller already passes for the children guard, covers
// every stepId in both wizards at once and cannot be gotten wrong per call
// site (the same "defence in depth" property this component's own
// docstring already claims for suppressing `children` on a locked step).
//
// Finalise & Review is deliberately NOT one of the cases pinned below: it
// is the wizard's LAST step (DRAFT_WIZARD_STEPS), so `canNext` is false
// there and Next never renders in the first place — nothing to observe.
// The orchestrator's own table computed `nextIsPrimary` as `true` for it
// too, which is correct AS AN INTERNAL VALUE, but that value never reaches
// a rendered button, so it's not a second reachable case to test.
// ---------------------------------------------------------------------------

describe('umbrella #432 §D1 FIX ROUND: Next is never primary on a locked step', () => {
  // Reached with NO template chosen, so Design never completes and every
  // step from Provision onward stays locked for the whole rest of the
  // walk — this wizard's own Next is UNCONDITIONAL on lock state by design
  // (this file's own docstring), so all of them stay reachable to check.
  async function walkToLockedProvision() {
    typeStudioName('Studio A')
    await clickNext() // Identity -> Design
    await clickNext() // Design -> Plan
    await clickNext() // Plan -> Provision (locked: Design never completed)
    return stepSection('Provision')
  }

  function assertNextNeutral(section: HTMLElement) {
    const next = within(section).getByRole('button', { name: 'Next →' })
    expect(next.className.split(/\s+/)).not.toContain('btn-primary')
    expect(next.className.split(/\s+/)).toContain('btn-secondary')
  }

  it('stays neutral on a locked Provision when the catalog read has settled cleanly', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await walkToLockedProvision()
    expect(within(provision).getByText(/This step opens once Plan is complete/)).toBeTruthy()
    assertNextNeutral(provision)
  })

  it('stays neutral on a locked Provision while the catalog read is still fetching', async () => {
    const h = mkFetch()
    let release: (() => void) | null = null
    h.setCatalogGate(new Promise<void>((resolve) => { release = resolve }))
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await walkToLockedProvision()
    assertNextNeutral(provision)
    release!()
  })

  it('stays neutral on a locked Provision when the catalog read has failed', async () => {
    mkFetch({ catalogStatus: 500 })
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    const provision = await walkToLockedProvision()
    assertNextNeutral(provision)
  })

  // THE MORE REACHABLE CASE (raised after the Provision-only fix landed):
  // hit by simply pressing Next through the wizard with no special catalog
  // state at all — Configure is locked for the WHOLE draft, unconditionally.
  it('stays neutral on Configure, locked for the whole draft', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Identity' })
    await walkToLockedProvision()
    await clickNext() // Provision -> Configure
    const configure = stepSection('Configure')
    expect(within(configure).getByText(/nothing to configure/)).toBeTruthy()
    assertNextNeutral(configure)
  })
})
