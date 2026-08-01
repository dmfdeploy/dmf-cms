/**
 * Facility list + detail pages (S1, #285).
 *
 * Facilities list: the single-facility entry tile, and its own designed
 * states (unconfigured / unreachable / no site yet) now that the hardcoded
 * "Status: NetBox connected" card and the always-blank per-site Status
 * field are gone.
 *
 * Facility Detail: the page-level classifier (loading / unconfigured /
 * unreadable / loaded) plus every section's own honest sub-state
 * (malformed/unreadable never renders as a fabricated zero or a silent
 * blank), and — the claim most likely to regress into "used"/"free" — the
 * capacity table renders the exact "Allocatable" / "Requests committed"
 * wording.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Facility from '../pages/Facility'
import FacilityDetail, {
  classifyFacilityDetail,
  facilityReasonCopy,
  type FacilityDetailQueryLike,
} from '../pages/Facility/Detail'
import type { FacilityDetailResponse, FacilitySummary } from '../api/types'

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      for (const [suffix, body] of Object.entries(routes)) {
        if (url.endsWith(suffix)) {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }
      throw new Error(`unrouted fetch in test: ${url}`)
    }),
  )
}

function renderWithQuery(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Facilities list — single-entry tile
// ---------------------------------------------------------------------------

function summary(overrides: Partial<FacilitySummary> = {}): FacilitySummary {
  return {
    reason: '',
    site_count: 1,
    device_count: 3,
    sites: [{ name: 'DMF Lab', slug: 'dmf-lab', device_count: 3 }],
    ...overrides,
  }
}

describe('Facilities list (S1, #285)', () => {
  it('renders the single facility as a link to its detail page', async () => {
    stubFetch({ '/api/facility/summary': summary() })
    renderWithQuery(
      <MemoryRouter>
        <Facility />
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: /DMF Lab/ })
    expect(link.getAttribute('href')).toBe('/facilities/dmf-lab')
    expect(screen.getByText('3 devices in NetBox')).toBeTruthy()
    // The old hardcoded card and the always-blank per-site Status field
    // are gone, not merely hidden.
    expect(screen.queryByText(/NetBox connected/)).toBeNull()
    expect(screen.queryByText(/^Status:/)).toBeNull()
  })

  it('renders an honest not-configured state, no dead link', async () => {
    stubFetch({ '/api/facility/summary': summary({ reason: 'netbox-not-configured', sites: [] }) })
    renderWithQuery(
      <MemoryRouter>
        <Facility />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/NetBox is not configured/)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders an honest unreachable state, no dead link', async () => {
    stubFetch({ '/api/facility/summary': summary({ reason: 'netbox-unreachable', sites: [] }) })
    renderWithQuery(
      <MemoryRouter>
        <Facility />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/NetBox is unreachable/)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// classifyFacilityDetail — pure classifier
// ---------------------------------------------------------------------------

function detailPayload(overrides: Partial<FacilityDetailResponse> = {}): FacilityDetailResponse {
  return {
    requested_site: 'dmf-lab',
    prometheus_configured: true,
    netbox_configured: true,
    site: { slug: 'dmf-lab', name: 'DMF Lab', reason: '' },
    nodes: { reason: '', items: [] },
    platform_services: { reason: '', items: [] },
    storage: { reason: '', items: [] },
    capacity: {
      reason: '',
      node_name: 'n1',
      allocatable_cpu_m: 2000,
      allocatable_mem_b: 4 * 1024 ** 3,
      requests_committed_cpu_m: 500,
      requests_committed_mem_b: 512 * 1024 ** 2,
      pod_count: 3,
    },
    ...overrides,
  }
}

describe('classifyFacilityDetail', () => {
  it('loading with no data yet', () => {
    const q: FacilityDetailQueryLike = { isLoading: true, isError: false }
    expect(classifyFacilityDetail(q).phase).toBe('loading')
  })

  it('unreadable when the console API itself errors with no prior data', () => {
    const q: FacilityDetailQueryLike = { isLoading: false, isError: true }
    expect(classifyFacilityDetail(q).phase).toBe('unreadable')
  })

  it('unconfigured when neither prometheus nor netbox is configured', () => {
    const q: FacilityDetailQueryLike = {
      isLoading: false,
      isError: false,
      data: detailPayload({ prometheus_configured: false, netbox_configured: false }),
    }
    expect(classifyFacilityDetail(q).phase).toBe('unconfigured')
  })

  it('loaded when at least one integration is configured, even if the other is not', () => {
    const q: FacilityDetailQueryLike = {
      isLoading: false,
      isError: false,
      data: detailPayload({ netbox_configured: false }),
    }
    expect(classifyFacilityDetail(q).phase).toBe('loaded')
  })
})

describe('facilityReasonCopy', () => {
  it('never leaks a raw reason token as prose for known tokens', () => {
    expect(facilityReasonCopy('nodes-unreadable')).not.toBe('nodes-unreadable')
    expect(facilityReasonCopy('budget-unavailable')).not.toBe('budget-unavailable')
  })
})

// ---------------------------------------------------------------------------
// Facility Detail page — rendered states
// ---------------------------------------------------------------------------

function renderDetail(site: string, routes: Record<string, unknown>) {
  stubFetch(routes)
  return renderWithQuery(
    <MemoryRouter initialEntries={[`/facilities/${site}`]}>
      <Routes>
        <Route path="/facilities/:site" element={<FacilityDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Facility Detail page states', () => {
  it('unconfigured renders one honest message, no per-section spinners', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload({
        prometheus_configured: false,
        netbox_configured: false,
        site: { slug: null, name: null, reason: 'netbox-not-configured' },
        nodes: { reason: 'prometheus-not-configured', items: [] },
        platform_services: { reason: 'prometheus-not-configured', items: [] },
        storage: { reason: 'prometheus-not-configured', items: [] },
        capacity: {
          reason: 'prometheus-not-configured',
          node_name: null,
          allocatable_cpu_m: null,
          allocatable_mem_b: null,
          requests_committed_cpu_m: null,
          requests_committed_mem_b: null,
          pod_count: null,
        },
      }),
    })
    expect(
      await screen.findByText(/Neither monitoring nor NetBox is configured in this environment/),
    ).toBeTruthy()
    // No individual section panels render under the unconfigured umbrella —
    // one designed message, not five empty-looking cards.
    expect(screen.queryByText('Nodes')).toBeNull()
    expect(screen.queryByText('Capacity')).toBeNull()
  })

  it('a malformed/unreadable section renders its own honest banner, never a raw error or a fabricated value', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload({
        nodes: { reason: 'nodes-unreadable', items: [] },
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
    expect(await screen.findByText(/Node inventory cannot be read from monitoring right now/)).toBeTruthy()
    expect(screen.getByText(/Capacity cannot be read from monitoring right now/)).toBeTruthy()
    // Raw tokens never leak into rendered copy.
    expect(screen.queryByText('nodes-unreadable')).toBeNull()
    expect(screen.queryByText('budget-unavailable')).toBeNull()
  })

  it('loaded renders the capacity table with the committed/allocatable wording, never used/free', async () => {
    renderDetail('dmf-lab', { '/api/facility/dmf-lab/detail': detailPayload() })
    expect(await screen.findByText('Allocatable')).toBeTruthy()
    expect(screen.getByText('Requests committed')).toBeTruthy()
    expect(screen.queryByText(/\bUsed\b/)).toBeNull()
    expect(screen.queryByText(/\bFree\b/)).toBeNull()
    // The formatted figures themselves.
    expect(screen.getByText('2 cores')).toBeTruthy()
    expect(screen.getByText('4.0 GiB')).toBeTruthy()
    expect(screen.getByText('500m')).toBeTruthy()
    expect(screen.getByText('512 MiB')).toBeTruthy()
  })

  it('an app absent from the cluster ingress renders as honestly not found, not dropped', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload({
        platform_services: {
          reason: '',
          items: [
            { key: 'librenms', display_name: 'LibreNMS', namespace: null, url: null, images: [] },
            {
              key: 'netbox',
              display_name: 'NetBox',
              namespace: 'netbox',
              url: 'https://netbox.dmf.lab.example/',
              images: ['netboxcommunity/netbox:v4.1.0'],
            },
          ],
        },
      }),
    })
    expect(await screen.findByText('LibreNMS')).toBeTruthy()
    expect(screen.getByText('not found in this cluster')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Open →' })
    expect(link.getAttribute('href')).toBe('https://netbox.dmf.lab.example/')
    expect(screen.getByText('netboxcommunity/netbox:v4.1.0')).toBeTruthy()
  })


})
