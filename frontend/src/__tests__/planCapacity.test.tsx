/**
 * Plan stage — the capacity comparison (umbrella #285 S3).
 *
 * PlanStage is rendered directly here (not through WorkloadDetail/the full
 * rail) — its capacity comparison only depends on `workload.functions`,
 * `/api/catalog`, `/api/facility/summary` and `/api/facility/{slug}/detail`,
 * so isolating it keeps this file self-contained and unaffected by the
 * other stages' own machinery. Same MSW-free idiom as workloadDetail.test.tsx:
 * a test QueryClient, fetch stubbed via vi.stubGlobal.
 *
 * The point of this file is the regression guard at the bottom: this
 * comparison must NEVER render a fit/no-fit verdict (Constitution Art. 1) —
 * that judgment belongs to capacity.py's own deploy-time preflight gate,
 * not to a stage the operator reads before anything is even armed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import PlanStage from '../pages/MediaWorkloads/stages/PlanStage'
import type { CatalogEntry, FacilityDetailResponse, MediaWorkload } from '../api/types'

const MI = 1024 ** 2
const GI = 1024 ** 3

// ---- fixtures ---------------------------------------------------------

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'mxl-videotestsrc',
    display_name: 'MXL Test-Pattern Source',
    summary: 'Fabrics demo source.',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'active',
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

function workload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [],
    functions: [{ function_key: 'mxl-videotestsrc', count: 1, running: 1, reconcile_pending: 0 }],
    ...overrides,
  }
}

function facilityDetailResponse(overrides: Partial<FacilityDetailResponse> = {}): FacilityDetailResponse {
  return {
    requested_site: 'dmf-lab',
    prometheus_configured: true,
    netbox_configured: true,
    // `architecture` became a required field on FacilitySiteIdentity when
    // Arc A (#339) added the NetBox site-level arch fallback. Null here:
    // this fixture is about capacity, and a site that never reported an
    // architecture is the honest default rather than an invented value.
    site: { slug: 'dmf-lab', name: 'dmf-lab', architecture: null, reason: '' },
    nodes: { reason: '', items: [] },
    platform_services: { reason: '', items: [] },
    storage: { reason: '', items: [] },
    capacity: {
      reason: '',
      node_name: 'n1',
      allocatable_cpu_m: 3000,
      allocatable_mem_b: 6 * GI,
      requests_committed_cpu_m: 500,
      requests_committed_mem_b: 1 * GI,
      pod_count: 5,
    },
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
  facilitySites?: Array<{ name: string; slug: string | null; device_count: number }>
  facilityDetail?: FacilityDetailResponse
  facilityDetailStatus?: number
}

function mkFetch(opts: FetchOpts = {}) {
  const catalog = opts.catalog ?? []
  const sites = opts.facilitySites ?? [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }]
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/catalog')) return json({ entries: catalog })
    if (url.endsWith('/api/facility/summary')) {
      return json({ reason: '', site_count: sites.length, device_count: 0, sites })
    }
    if (url.match(/\/api\/facility\/[^/]+\/detail$/)) {
      if (opts.facilityDetailStatus) return json({ error: 'nope' }, opts.facilityDetailStatus)
      return json(opts.facilityDetail ?? facilityDetailResponse())
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPlan(wl: MediaWorkload = workload()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PlanStage workload={wl} state="informational" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---- the two numbers + committed context -------------------------------

describe('a fully-declared workload against a readable facility', () => {
  it('renders requests and allocatable side by side, with committed as context', async () => {
    mkFetch({
      catalog: [
        catalogEntry({
          key: 'mxl-videotestsrc',
          provision_demand: { cpu_m: 450, mem_b: 160 * MI },
        }),
      ],
      facilityDetail: facilityDetailResponse(),
    })
    renderPlan(
      workload({
        functions: [{ function_key: 'mxl-videotestsrc', count: 1, running: 1, reconcile_pending: 0 }],
      }),
    )

    expect(await screen.findByText('Requests (this workload)')).toBeTruthy()
    expect(screen.getByText('Allocatable (facility)')).toBeTruthy()
    expect(screen.getByText(/450m CPU/)).toBeTruthy()
    expect(screen.getByText(/160 MiB memory/)).toBeTruthy()
    expect(screen.getByText(/3000m CPU/)).toBeTruthy()
    expect(screen.getByText(/6\.0 GiB memory/)).toBeTruthy()
    // Committed rides along as scheduler CONTEXT, in that exact word — never
    // "used"/"free" (a scheduler bound is not a utilisation measurement).
    expect(screen.getByText(/Committed/)).toBeTruthy()
    expect(screen.getByText(/500m/)).toBeTruthy()
    expect(screen.getByText(/1\.0 GiB/)).toBeTruthy()
  })

  it('scales a function\'s demand by how many instances the workload runs', async () => {
    // 2 instances of a 450m/160Mi template -> 900m/320Mi, not 450m/160Mi —
    // the workload's total request footprint, not one instance's.
    mkFetch({
      catalog: [
        catalogEntry({
          key: 'mxl-videotestsrc',
          provision_demand: { cpu_m: 450, mem_b: 160 * MI },
        }),
      ],
    })
    renderPlan(
      workload({
        functions: [{ function_key: 'mxl-videotestsrc', count: 2, running: 2, reconcile_pending: 0 }],
      }),
    )
    expect(await screen.findByText(/900m CPU/)).toBeTruthy()
    expect(screen.getByText(/320 MiB memory/)).toBeTruthy()
  })
})

// ---- partial demand: some templates declare, some don't ----------------

describe('a workload where only some templates declare a demand', () => {
  it('sums the declared ones and states the sum is partial, naming the count', async () => {
    mkFetch({
      catalog: [
        catalogEntry({ key: 'mxl-videotestsrc', provision_demand: { cpu_m: 450, mem_b: 160 * MI } }),
        // 'mxl-videotest-view' has no matching catalog entry at all — an
        // absent entry counts exactly like a present-but-undeclared one.
      ],
    })
    renderPlan(
      workload({
        functions: [
          { function_key: 'mxl-videotestsrc', count: 1, running: 1, reconcile_pending: 0 },
          { function_key: 'mxl-videotest-view', count: 1, running: 1, reconcile_pending: 0 },
        ],
      }),
    )

    expect(await screen.findByText(/Partial/)).toBeTruthy()
    expect(screen.getByText(/1 of 2 templates/)).toBeTruthy()
    // The partial sum is still the real number for the ones that DID declare
    // — never silently dropped in favour of a blanket "unknown".
    expect(screen.getByText(/450m CPU/)).toBeTruthy()
  })
})

describe('a workload where no template declares a demand at all', () => {
  it('says none declare a demand, with no fabricated number', async () => {
    mkFetch({ catalog: [catalogEntry({ key: 'mxl-videotestsrc', provision_demand: null })] })
    renderPlan()
    expect(await screen.findByText(/None of this workload's 1 template/)).toBeTruthy()
    expect(screen.getByText(/comparison here is incomplete/)).toBeTruthy()
  })
})

// ---- capacity unreadable: designed copy, never the raw token ------------

describe('an unreadable facility capacity', () => {
  it('states the capacity could not be read, in operator language, never the raw reason token', async () => {
    mkFetch({
      catalog: [catalogEntry({ provision_demand: { cpu_m: 450, mem_b: 160 * MI } })],
      facilityDetail: facilityDetailResponse({
        capacity: {
          reason: 'budget-unavailable',
          node_name: null,
          allocatable_cpu_m: null,
          allocatable_mem_b: null,
          requests_committed_cpu_m: null,
          requests_committed_mem_b: null,
          pod_count: null,
        },
      }),
    })
    renderPlan()

    expect(await screen.findByText(/could not be read/)).toBeTruthy()
    expect(screen.getByText(/monitoring could not be read just now/)).toBeTruthy()
    // Art. 8: the fail-soft token itself must never reach the operator raw.
    expect(screen.queryByText(/budget-unavailable/)).toBeNull()
    // And no number rides along with an unreadable read — there's nothing
    // honest to show beside it.
    expect(screen.queryByText(/CPU/)).toBeNull()
  })

  it('also degrades honestly when the facility-detail request itself fails', async () => {
    mkFetch({
      catalog: [catalogEntry({ provision_demand: { cpu_m: 450, mem_b: 160 * MI } })],
      facilityDetailStatus: 500,
    })
    renderPlan()
    expect(await screen.findByText(/could not be read/)).toBeTruthy()
    expect(screen.queryByText(/500/)).toBeNull()
  })
})

// ---- the regression guard: no verdict, ever -----------------------------

describe('no verdict language, even when requests plainly exceed allocatable', () => {
  it('renders only the two numbers — no fits/sufficient/enough/insufficient/OK anywhere', async () => {
    // 9000m requested against a 3000m allocatable facility: exactly the
    // scenario a verdict-shaped UI would be most tempted to narrate. This
    // stage is not that UI — capacity.py's deploy-time gate is.
    mkFetch({
      catalog: [catalogEntry({ key: 'mxl-videotestsrc', provision_demand: { cpu_m: 9000, mem_b: 160 * MI } })],
      facilityDetail: facilityDetailResponse(),
    })
    renderPlan(
      workload({
        functions: [{ function_key: 'mxl-videotestsrc', count: 1, running: 1, reconcile_pending: 0 }],
      }),
    )

    expect(await screen.findByText(/9000m CPU/)).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\bfits?\b/i)
    expect(text).not.toMatch(/\bwill fit\b/i)
    expect(text).not.toMatch(/won't fit/i)
    expect(text).not.toMatch(/\bsufficient\b/i)
    expect(text).not.toMatch(/\benough\b/i)
    expect(text).not.toMatch(/\binsufficient\b/i)
    expect(text).not.toMatch(/\bOK\b/)
  })
})
