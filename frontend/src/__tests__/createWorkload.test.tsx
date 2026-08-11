/**
 * Create Media Workload — the draft leg of the guided sequential flow
 * (umbrella #285 addendum). Harness copied from workloadDetail.test.tsx:
 * MSW-free, a fresh react-query QueryClient per render, fetch stubbed via
 * vi.stubGlobal.
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
 *     comment only a developer will ever read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import CreateWorkload from '../pages/MediaWorkloads/CreateWorkload'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
import { readLaunchState } from '../pages/MediaWorkloads/WorkloadMaterializing'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
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
      const sites = opts.facilitySites ?? [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }]
      return json({ reason: '', site_count: sites.length, device_count: 0, sites })
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
      return json({
        configured: true,
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
  }
}

// GATE-B item 1: this used to mount a STUB at the destination
// (<div>Workload detail: studio-a</div>), which made the create journey look
// finished while hiding the actual bug — the real page had no idea a launch
// had just happened and rendered "Workload not found" for the workload the
// operator had just created. The stub was the reason the defect shipped, so
// the harness now mounts the REAL WorkloadDetail and the journey is asserted
// end to end.
function renderCreate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/new']}>
        <Routes>
          <Route path="/media-workloads/new" element={<CreateWorkload />} />
          <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // Returned so a test can force a catalog re-read mid-flow; every other
  // caller ignores it.
  return queryClient
}

function stepSection(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: label, level: 2 })
  return heading.closest('section') as HTMLElement
}

async function chooseTemplate() {
  const design = stepSection('Design')
  fireEvent.click(await within(design).findByRole('button', { name: 'Use this template' }))
}

function typeStudioName(value: string) {
  fireEvent.change(screen.getByLabelText('Studio name'), { target: { value } })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---- taxonomy stays out of default level -------------------------------

describe('EBU taxonomy on the draft template picker', () => {
  it('keeps layer/vertical/function-type/lifecycle-owner behind a closed System details disclosure', async () => {
    // Arc 4 WP-3 (umbrella #347): same contract as the real workload's
    // Design step (workloadDetail.test.tsx) — see that test's own comment
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
    await screen.findByRole('heading', { name: 'Design' })

    // Nothing chosen yet: Plan and Provision are locked, and locked means no
    // control is reachable inside them at all.
    expect(within(stepSection('Plan')).getByText(/This step opens once Design is complete/)).toBeTruthy()
    expect(within(stepSection('Plan')).queryByRole('button')).toBeNull()
    expect(
      within(stepSection('Provision')).getByText(/This step opens once Plan is complete/),
    ).toBeTruthy()

    // A template alone isn't enough — the name still gates Design.
    await chooseTemplate()
    expect(within(stepSection('Plan')).getByText(/This step opens once Design is complete/)).toBeTruthy()

    // Completing the name too opens Plan; Provision still waits on Plan's
    // facility resolution actually landing (async facility fetch).
    typeStudioName('Studio A')
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
      await screen.findByRole('heading', { name: 'Design' })

      await chooseTemplate()
      typeStudioName('Studio A')

      // The facility itself is readable — a true fact, not "select"/
      // "assign" — but Provision has not opened on that alone.
      await within(stepSection('Plan')).findByText(/This workload will run on/)
      expect(
        within(stepSection('Provision')).getByText(/This step opens once Plan is complete/),
      ).toBeTruthy()
    })

    it('opens once the operator clicks Confirm placement', async () => {
      mkFetch()
      renderCreate()
      await screen.findByRole('heading', { name: 'Design' })

      await chooseTemplate()
      typeStudioName('Studio A')

      fireEvent.click(await within(stepSection('Plan')).findByRole('button', { name: 'Confirm placement' }))

      await waitFor(() =>
        expect(within(stepSection('Provision')).queryByText(/This step opens once Plan is complete/)).toBeNull(),
      )
      expect(
        within(stepSection('Provision')).getByRole('button', { name: '▶ Provision now' }),
      ).toBeTruthy()

      // Plan is now `complete` — reviewable but folded by default, same as
      // any other completed draft step. The confirmation itself reads back
      // as settled, not as a control still waiting to be pressed again.
      fireEvent.click(within(stepSection('Plan')).getByRole('button', { name: 'Review' }))
      expect(within(stepSection('Plan')).getByText(/Confirmed — this workload will run on/)).toBeTruthy()
      expect(within(stepSection('Plan')).queryByRole('button', { name: 'Confirm placement' })).toBeNull()
    })
  })

  // GATE ONLY IN THE EXACTLY-ONE-FACILITY CASE: both non-answers below are
  // untouched by the confirmation gate — there is nothing to confirm, and
  // no "Confirm placement" control ever appears to be skipped or missed.
  it('gives an honest non-answer instead of a picker when zero facilities are registered, and Provision stays locked', async () => {
    mkFetch({ facilitySites: [] })
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })

    await chooseTemplate()
    typeStudioName('Studio A')

    await within(stepSection('Plan')).findByText(/can't be shown/)
    expect(within(stepSection('Plan')).queryByRole('button', { name: 'Confirm placement' })).toBeNull()
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
    await screen.findByRole('heading', { name: 'Design' })

    await chooseTemplate()
    typeStudioName('Studio A')

    await within(stepSection('Plan')).findByText(/2 facilities are registered/)
    expect(within(stepSection('Plan')).queryByRole('button', { name: 'Confirm placement' })).toBeNull()
    expect(
      within(stepSection('Provision')).getByText(/This step opens once Plan is complete/),
    ).toBeTruthy()
  })

  it('Configure and Finalise & Review are locked throughout, with a stated plain-words reason', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })

    await chooseTemplate()
    typeStudioName('Studio A')
    fireEvent.click(await within(stepSection('Plan')).findByRole('button', { name: 'Confirm placement' }))
    await waitFor(() =>
      expect(within(stepSection('Provision')).queryByText(/This step opens once Plan is complete/)).toBeNull(),
    )

    expect(within(stepSection('Configure')).getByText(/nothing has been provisioned yet/)).toBeTruthy()
    expect(within(stepSection('Configure')).queryByRole('button')).toBeNull()
    expect(
      within(stepSection('Finalise & Review')).getByText(/nothing has been provisioned yet/),
    ).toBeTruthy()
    expect(within(stepSection('Finalise & Review')).queryByRole('button')).toBeNull()
  })
})

// ---- the slug the operator will get is SHOWN, not hidden ---------------

describe('studio name → shown workload identity', () => {
  it('derives and displays the slug that will actually be recorded as the operator types', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })

    typeStudioName('Studio A')
    const slugField = screen.getByLabelText('Workload identity') as HTMLInputElement
    expect(slugField.value).toBe('studio-a')
  })

  it('lets the operator edit the slug directly without the name field clobbering it', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })

    typeStudioName('Studio A')
    const slugField = screen.getByLabelText('Workload identity') as HTMLInputElement
    fireEvent.change(slugField, { target: { value: 'custom-slug' } })
    // Further edits to the name must not overwrite the operator's own edit.
    typeStudioName('Studio A Updated')
    expect(slugField.value).toBe('custom-slug')
  })

  it('renders the designed invalid-slug state and does not complete Design', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })

    const slugField = screen.getByLabelText('Workload identity')
    fireEvent.change(slugField, { target: { value: 'Not Valid!' } })
    await chooseTemplate()

    expect(screen.getByText(/lowercase letters, digits and hyphens/)).toBeTruthy()
    // Design cannot be "done" on an invalid slug: Plan stays locked.
    expect(within(stepSection('Plan')).getByText(/This step opens once Design is complete/)).toBeTruthy()
  })

  it('states the draft-loss limit near the name field', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })
    expect(
      screen.getByText(/refreshing or closing the tab before then loses it/),
    ).toBeTruthy()
  })
})

// ---- the deploy POST: the actual persistence seam -----------------------

// The ladder to a workable Provision step, shared by the deploy-POST tests
// and the journey tests below so both start from an identical state rather
// than two setups that can drift apart.
async function reachProvision() {
  await chooseTemplate()
  typeStudioName('Studio A')
  // WP-3 spec D: the facility resolving is no longer enough on its own —
  // Provision opens only once the operator confirms the resolved
  // placement (see "Provision opens only once the resolved facility is
  // confirmed" above for the gate itself, tested in isolation).
  fireEvent.click(await within(stepSection('Plan')).findByRole('button', { name: 'Confirm placement' }))
  await waitFor(() =>
    expect(within(stepSection('Provision')).queryByText(/This step opens once Plan is complete/)).toBeNull(),
  )
  return stepSection('Provision')
}

describe('Provision: the deploy POST', () => {
  it('carries both the mandatory reason and the workload slug, then navigates to the real workload route', async () => {
    const { deploy } = mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })
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

    // The destination is the REAL WorkloadDetail. The workload does not exist
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
    await screen.findByRole('heading', { name: 'Design' })
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
    // Still on Create, not materializing: the studio-name field is unique to
    // this page's own form (the retired per-page hero heading it used to
    // assert against is gone — umbrella #347 WO-D1 spec C).
    expect(screen.getByLabelText('Studio name')).toBeTruthy()
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
    const design = stepSection('Design')

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
    // their absence.
    mkFetch({ catalog: [catalogEntry(ACTIVE)] })
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })
    typeStudioName('Studio A')

    const design = stepSection('Design')
    for (const offer of within(design).queryAllByRole('button', { name: 'Use this template' })) {
      fireEvent.click(offer)
    }

    // hasName && hasTemplate are both synchronous, so Plan would have
    // unlocked by now if the click had been allowed to land.
    expect(within(stepSection('Plan')).getByText(/This step opens once Design is complete/)).toBeTruthy()
    expect(within(stepSection('Provision')).queryByRole('button')).toBeNull()
  })

  it('withdraws the Provision action if the template goes active after it was chosen', async () => {
    // THE REACHABLE PATH the picker guard alone does not close. The operator
    // selects a bootstrapped template, someone else deploys it, the catalog
    // re-reads — and the draft is now sitting on Provision with a live
    // button aimed at a duplicate deploy.
    const h = mkFetch({ catalog: [catalogEntry({ key: 'mxl-viewer', lifecycle: 'bootstrapped' })] })
    const queryClient = renderCreate()
    await screen.findByRole('heading', { name: 'Design' })
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
    await screen.findByRole('heading', { name: 'Design' })
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
    await screen.findByRole('heading', { name: 'Design' })
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
    await screen.findByRole('heading', { name: 'Design' })

    const design = stepSection('Design')
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
    await screen.findByRole('heading', { name: 'Design' })
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
    await screen.findByRole('heading', { name: 'Design' })
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
    await screen.findByRole('heading', { name: 'Design' })
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
      await screen.findByRole('heading', { name: 'Design' })

      expect(within(stepSection('Design')).queryByText('Already deployed')).toBeNull()
      const provision = await reachProvision()
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
    const design = stepSection('Design')

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
  await screen.findByRole('heading', { name: 'Design' })
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

  it('still renders not-found for a slug that arrives WITHOUT a launch', async () => {
    // The materializing state must be reachable only via the create handoff —
    // otherwise a genuinely missing workload would render as "provisioning"
    // forever, which is the same lie pointed the other way.
    mkFetch({ workloads: [] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/ghost']}>
          <Routes>
            <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
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
            { pathname: '/media-workloads/studio-a', state: { launch: { entryKey: 'mxl-viewer' } } },
          ]}
        >
          <Routes>
            <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.queryByText('Deploy accepted.')).toBeNull()
    return waitFor(() => expect(screen.getByText('Workload not found')).toBeTruthy())
  })
})
