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
import type { CatalogEntry } from '../api/types'

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
}

function mkFetch(opts: FetchOpts = {}) {
  const catalog = opts.catalog ?? [catalogEntry()]
  const calls = { deploy: [] as Array<{ url: string; init?: RequestInit }> }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()

    if (url.endsWith('/api/catalog')) {
      if (opts.catalogStatus) return json({ error: 'nope' }, opts.catalogStatus)
      return json({ entries: catalog })
    }
    if (url.endsWith('/api/facility/summary')) {
      const sites = opts.facilitySites ?? [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }]
      return json({ reason: '', site_count: sites.length, device_count: 0, sites })
    }
    if (url.match(/\/api\/catalog\/[^/]+\/deploy$/)) {
      calls.deploy.push({ url, init })
      if (opts.deployStatus) return json({ error: 'boom' }, opts.deployStatus)
      return json(opts.deployResult ?? { job_id: 900, status: 'launched', request_id: 'req-1' })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { ...calls, fetchMock }
}

// A stand-in for the real WorkloadDetail route — this leg only needs to
// prove navigation LANDS on /media-workloads/<slug>, not what that page
// renders (that page is a sibling's owned file).
function renderCreate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/new']}>
        <Routes>
          <Route path="/media-workloads/new" element={<CreateWorkload />} />
          <Route path="/media-workloads/:slug" element={<div>Workload detail: studio-a</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
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

  it('opens Provision once Plan resolves the single facility', async () => {
    mkFetch()
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })

    await chooseTemplate()
    typeStudioName('Studio A')

    await waitFor(() =>
      expect(within(stepSection('Provision')).queryByText(/This step opens once Plan is complete/)).toBeNull(),
    )
    expect(
      within(stepSection('Provision')).getByRole('button', { name: '▶ Provision now' }),
    ).toBeTruthy()
  })

  it('gives an honest non-answer instead of a picker when zero facilities are registered, and Provision stays locked', async () => {
    mkFetch({ facilitySites: [] })
    renderCreate()
    await screen.findByRole('heading', { name: 'Design' })

    await chooseTemplate()
    typeStudioName('Studio A')

    await within(stepSection('Plan')).findByText(/can't be shown/)
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

describe('Provision: the deploy POST', () => {
  async function reachProvision() {
    await chooseTemplate()
    typeStudioName('Studio A')
    await waitFor(() =>
      expect(within(stepSection('Provision')).queryByText(/This step opens once Plan is complete/)).toBeNull(),
    )
    return stepSection('Provision')
  }

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

    await screen.findByText('Workload detail: studio-a')
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
    // Never left on the real workload route — nothing was actually created.
    expect(screen.queryByText('Workload detail: studio-a')).toBeNull()
  })
})
