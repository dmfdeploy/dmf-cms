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
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Facility from '../pages/Facility'
import FacilityDetail, {
  classifyFacilityDetail,
  facilityReasonCopy,
  type FacilityDetailQueryLike,
} from '../pages/Facility/Detail'
import type { FacilityDetailResponse, FacilitySummary } from '../api/types'
import { assertNoInteractiveDescendant } from './testUtils/domAssertions'

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
  vi.useRealTimers()
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

  // umbrella #339 item 4: the single facility rendered as a wide row-card
  // while Media Workloads rendered square control-surface tiles, so the two
  // single-entry pages the S1 cut created did not look like one console. The
  // skin pass hangs on this structure, so the structure is what is pinned.
  //
  // WP-4 (umbrella #347 Arc 4): this tile is now the shared Tile component
  // (components/Tile.tsx) — aspect-square/card/hover live on Tile's outer,
  // non-interactive container, a SIBLING of the Link, not the Link's own
  // class list (so a future actions slot is never nested inside the anchor).
  // Re-pinned against the element that now actually carries the structural
  // commitment, rather than weakened or dropped.
  it('renders the facility as a square control-surface tile, not a wide row-card', async () => {
    stubFetch({ '/api/facility/summary': summary() })
    renderWithQuery(
      <MemoryRouter>
        <Facility />
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: /DMF Lab/ })
    const container = link.parentElement
    const className = container?.getAttribute('class') ?? ''
    expect(className).toContain('aspect-square')
    // The row-card affordances are gone, not merely restyled.
    expect(className).not.toContain('items-center justify-between')
    expect(className).not.toContain('panel')
  })

  // codex P2-1 (umbrella #347 WP-4, rounds 1-2): Tile.tsx's `children` prop
  // is typed React.ReactNode, so nothing at the TYPE level stops this call
  // site from putting an interactive element inside it (which would land
  // inside the primary Link — the exact defect Tile exists to prevent for
  // the `actions` slot). tile.test.tsx proves the slot is safe in isolation;
  // it can't prove THIS real call site keeps `children` clean, so that's
  // pinned here directly against the actual rendered page, via the shared,
  // bounded check (testUtils/domAssertions.ts) — round 1's inline check only
  // rejected button/a/[role="button"], narrower than Tile.tsx's own
  // contract; this uses the same broader definition mediaWorkloadsGrid's
  // call-site test now shares.
  it("the tile's primary link contains no interactive descendant", async () => {
    stubFetch({ '/api/facility/summary': summary() })
    renderWithQuery(
      <MemoryRouter>
        <Facility />
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: /DMF Lab/ })
    assertNoInteractiveDescendant(link)
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

  // fix-round 4 (PR #81, codex sibling sweep): this page ignored
  // `summary.isError` entirely — a settled failed read with NO retained
  // data ever fell through FacilityEntry's whole reason ladder to `!site`,
  // which reads "NetBox has no site recorded yet" — a real environment
  // fact this is not; it misstated a read failure as a facility that was
  // never provisioned.
  it('a settled failed read with no retained data reads honestly, never "no site recorded yet"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    renderWithQuery(
      <MemoryRouter>
        <Facility />
      </MemoryRouter>,
    )
    expect(await screen.findByText('The facility inventory could not be read. Retrying automatically.')).toBeTruthy()
    expect(screen.queryByText(/no site recorded yet/)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  // Hold-then-reject, not first-load: a settled failed refetch must not
  // suppress a retained, previously-successful tile (Art. 5) — but must
  // add a notice, not silently present it as a current read.
  it('a settled failed refetch keeps the retained tile visible but adds a notice', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) {
          return new Response(JSON.stringify(summary()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('boom', { status: 500 })
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Facility />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    const link = screen.getByRole('link', { name: /DMF Lab/ })
    expect(link).toBeTruthy()
    expect(screen.queryByText(/could not be refreshed/)).toBeNull()

    // Advance past useFacilitySummary's 60s refetchInterval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_100)
    })

    // Retained tile STILL shown (Art. 5) — now qualified by a notice.
    expect(screen.getByRole('link', { name: /DMF Lab/ })).toBeTruthy()
    expect(
      screen.getByText(
        'The facility inventory could not be refreshed just now — showing the last successful read. Retrying automatically.',
      ),
    ).toBeTruthy()
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
    site: { slug: 'dmf-lab', name: 'DMF Lab', architecture: null, reason: '' },
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

  // fix-round 5 (PR #81, codex sibling sweep): the 'unconfigured' branch
  // used to hardcode `stale: false`, never consulting `q.isError` — a
  // settled failed refetch after a retained "unconfigured" read silently
  // presented that stale config posture as current.
  it('stale is computed for unconfigured too, not hardcoded false', () => {
    const q: FacilityDetailQueryLike = {
      isLoading: false,
      isError: true,
      data: detailPayload({ prometheus_configured: false, netbox_configured: false }),
    }
    const s = classifyFacilityDetail(q)
    expect(s.phase).toBe('unconfigured')
    expect(s.stale).toBe(true)
  })

  it('loaded also carries stale from isError, with data retained', () => {
    const q: FacilityDetailQueryLike = { isLoading: false, isError: true, data: detailPayload() }
    const s = classifyFacilityDetail(q)
    expect(s.phase).toBe('loaded')
    expect(s.stale).toBe(true)
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
        site: { slug: null, name: null, architecture: null, reason: 'netbox-not-configured' },
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

  // fix-round 5 (PR #81, codex sibling sweep): the 'unconfigured' branch
  // hardcoded `stale: false` — a settled failed refetch after a retained
  // "unconfigured" read rendered the same message with no staleness
  // notice, presenting it as a fresh, current read. Hold-then-reject.
  it('a settled failed refetch after a retained unconfigured read adds a staleness notice', async () => {
    vi.useFakeTimers()
    const unconfiguredPayload = detailPayload({
      prometheus_configured: false,
      netbox_configured: false,
      site: { slug: null, name: null, architecture: null, reason: 'netbox-not-configured' },
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
    })
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/facility/dmf-lab/detail')) {
          calls += 1
          if (calls === 1) {
            return new Response(JSON.stringify(unconfiguredPayload), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return new Response('boom', { status: 500 })
        }
        if (url.endsWith('/api/media-workloads/grouped')) {
          return new Response(
            JSON.stringify({ configured: true, degraded: false, scope: [], workloads: [], invalid_instances: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        throw new Error(`unrouted fetch in test: ${url}`)
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/facilities/dmf-lab']}>
          <Routes>
            <Route path="/facilities/:site" element={<FacilityDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText(/Neither monitoring nor NetBox is configured/)).toBeTruthy()
    expect(screen.queryByText(/could not be confirmed/)).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_100)
    })

    expect(screen.getByText(/Neither monitoring nor NetBox is configured/)).toBeTruthy()
    expect(screen.getByText(/could not be confirmed just now/)).toBeTruthy()
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

  // fix-round 4 (PR #81, codex sibling sweep): classifyFacilityDetail only
  // treated isError as authoritative when NO data was ever retained
  // (`isError && !q.data`) — a settled failed refetch with a RETAINED
  // successful payload still classified as 'loaded' with no staleness
  // notice at all, presenting the whole facility-detail page (nodes,
  // storage, capacity, the works) as current after the read that would
  // have confirmed it had failed. Hold-then-reject, not first-load.
  it('a settled failed refetch keeps the retained page visible but adds a staleness notice', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/facility/dmf-lab/detail')) {
          calls += 1
          if (calls === 1) {
            return new Response(JSON.stringify(detailPayload()), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return new Response('boom', { status: 500 })
        }
        if (url.endsWith('/api/media-workloads/grouped')) {
          return new Response(
            JSON.stringify({ configured: true, degraded: false, scope: [], workloads: [], invalid_instances: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        throw new Error(`unrouted fetch in test: ${url}`)
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/facilities/dmf-lab']}>
          <Routes>
            <Route path="/facilities/:site" element={<FacilityDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // First (successful) read settles — real content, no staleness notice.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('Allocatable')).toBeTruthy()
    expect(screen.queryByText(/could not be refreshed/)).toBeNull()

    // Advance past useFacilityDetail's 60s refetchInterval so the
    // background refetch fires and rejects, while the old (successful)
    // detail payload stays retained.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_100)
    })

    // The retained page content is STILL shown (Art. 5) — now qualified.
    expect(screen.getByText('Allocatable')).toBeTruthy()
    expect(
      screen.getByText(
        'Facility detail could not be refreshed just now — showing the last successful read. Retrying automatically.',
      ),
    ).toBeTruthy()
  })

  // umbrella #339 item 1. The page shipped saying "not found in this cluster"
  // for services whose PVCs it listed as present two sections below, because
  // presence was inferred from an ingress several of them deliberately do not
  // have. The DETECTION fix is in facility.py, and its discriminating test is
  // test_read_platform_services_ingressless_service_is_still_detected — this
  // one guards the rendered end of that contract: given the payload the fixed
  // backend now produces, the operator sees a version and an honest dash.
  it('a service running without an ingress shows its version and a dashed access, never "not found"', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload({
        platform_services: {
          reason: '',
          items: [
            {
              key: 'awx',
              display_name: 'AWX',
              namespace: 'awx',
              image_repositories: ['ansible/awx'],
              url: null,
              images: ['quay.io/ansible/awx:24.6.1'],
            },
          ],
        },
      }),
    })
    expect(await screen.findByText('AWX')).toBeTruthy()
    expect(screen.getByText('quay.io/ansible/awx:24.6.1')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open →' })).toBeNull()
    // The overclaim itself, pinned: this copy must not come back.
    expect(screen.queryByText(/not found in this cluster/)).toBeNull()
  })

  it('a searched-but-unmatched service states what was checked, not that it is absent', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload({
        platform_services: {
          reason: '',
          items: [
            {
              key: 'librenms',
              display_name: 'LibreNMS',
              namespace: 'librenms',
              image_repositories: ['librenms/librenms'],
              url: null,
              images: [],
            },
            {
              key: 'netbox',
              display_name: 'NetBox',
              namespace: 'netbox',
              image_repositories: ['netbox-community/netbox'],
              url: 'https://netbox.dmf.lab.example/',
              images: ['ghcr.io/netbox-community/netbox:v4.1.0'],
            },
          ],
        },
      }),
    })
    expect(await screen.findByText('LibreNMS')).toBeTruthy()
    // A statement about the check, which an operator can falsify — not a
    // claim about the cluster, which they cannot.
    expect(screen.getByText('no matching pods in cluster metrics')).toBeTruthy()
    expect(screen.queryByText(/not found in this cluster/)).toBeNull()
    const link = screen.getByRole('link', { name: 'Open →' })
    expect(link.getAttribute('href')).toBe('https://netbox.dmf.lab.example/')
    expect(screen.getByText('ghcr.io/netbox-community/netbox:v4.1.0')).toBeTruthy()
  })

  it('a service with no declared cluster location reads as unchecked, distinct from unmatched', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload({
        platform_services: {
          reason: '',
          items: [
            {
              key: 'mystery',
              display_name: 'Mystery',
              namespace: null,
              image_repositories: [],
              url: null,
              images: [],
            },
          ],
        },
      }),
    })
    expect(await screen.findByText('Mystery')).toBeTruthy()
    expect(screen.getByText('no cluster location declared for this service')).toBeTruthy()
    // "We didn't look" must not read as "we looked and found nothing".
    expect(screen.queryByText('no matching pods in cluster metrics')).toBeNull()
  })

  // umbrella #339 item 2 — the fallback chain, at the pixel.
  it('renders the node arch and names NetBox when that is where it came from', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload({
        nodes: {
          reason: '',
          items: [
            { name: 'n1', kubelet_version: 'v1.29.0', arch: 'aarch64', arch_source: 'node' },
            { name: 'n2', kubelet_version: 'v1.29.0', arch: 'arm64', arch_source: 'netbox' },
            { name: 'n3', kubelet_version: 'v1.29.0', arch: null, arch_source: null },
          ],
        },
      }),
    })
    expect(await screen.findByText('aarch64')).toBeTruthy()
    expect(screen.getByText('arm64')).toBeTruthy()
    // Provenance shown only for the declared value — a measured arch must not
    // be dressed up as a NetBox fact, and vice versa.
    expect(screen.getAllByText('(from NetBox)')).toHaveLength(1)
    // The designed cannot-be-read state survives as the final fallback.
    expect(screen.getByText('cannot be read')).toBeTruthy()
  })
})

// WP-4 (umbrella #347 Arc 4): the four data-table panels regroup into a
// 2-row x 2-col grid at the wrapper/layout level only. This is the evidence
// that claim is true, not just asserted: every panel renders, WorkloadCount
// stays outside the grid, and every pre-existing assertion in this file
// (reason banners, empty states, stale handling, above) keeps passing
// UNMODIFIED — that's what proves the table markup, columns, reason-banner
// branching, and empty-state text in all four panels are unchanged (codex
// round-2 P3-2 — an earlier version of this comment said "byte-for-byte
// unchanged" without qualification, which overstated it: PlatformServices/
// CapacityPanel each carry exactly their directed subtitle edit, see
// Detail.tsx's own comment above the grid wrapper for the precise split).
describe('Facility Detail — panel regroup (WP-4, umbrella #347)', () => {
  it('renders all four data-table panels inside the grid wrapper, in a 2-col grid', async () => {
    renderDetail('dmf-lab', { '/api/facility/dmf-lab/detail': detailPayload() })
    const nodesHeading = await screen.findByRole('heading', { name: 'Nodes', level: 2 })
    const platformHeading = screen.getByRole('heading', { name: 'Platform services', level: 2 })
    const storageHeading = screen.getByRole('heading', { name: 'Storage', level: 2 })
    const capacityHeading = screen.getByRole('heading', { name: 'Capacity', level: 2 })

    // All four panels share the same grid-wrapper ancestor...
    const grid = nodesHeading.closest('.grid')
    expect(grid).toBeTruthy()
    expect(grid?.contains(platformHeading)).toBe(true)
    expect(grid?.contains(storageHeading)).toBe(true)
    expect(grid?.contains(capacityHeading)).toBe(true)
    expect(grid?.className ?? '').toContain('lg:grid-cols-2')

    // ...and WorkloadCountPanel — prose, not a table — is NOT one of the
    // four grid cells: it renders outside the grid wrapper entirely.
    const workloadHeading = await screen.findByRole('heading', { name: 'Media workloads', level: 2 })
    expect(grid?.contains(workloadHeading)).toBe(false)
  })

  it('PlatformServicesPanel renders with no subtitle; CapacityPanel keeps its subtitle visible', async () => {
    renderDetail('dmf-lab', { '/api/facility/dmf-lab/detail': detailPayload() })
    await screen.findByRole('heading', { name: 'Platform services', level: 2 })
    expect(screen.queryByText(/As-deployed versions read from the containers/)).toBeNull()
    expect(screen.getByText(/Requests committed is not usage/)).toBeTruthy()
  })
})

// umbrella #385 (hard gate 1, sweep): the media-workloads count line reused
// the SAME shape the Media Workloads list page was fixed for — an empty
// `workloads` array from a degraded (source-unreachable) read is not
// evidence of a zero count, and the panel must not state one.
describe('Facility Detail — media workloads count panel honesty (umbrella #385)', () => {
  it('a degraded, reason-carrying read never states a fabricated zero count', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload(),
      '/api/media-workloads/grouped': {
        configured: true,
        degraded: true,
        reason: 'netbox-unreachable',
        scope: [],
        workloads: [],
        invalid_instances: [],
      },
    })
    expect(await screen.findByText('Media workloads')).toBeTruthy()
    // fix-round P2-4 (PR #81): this used to pipe MediaWorkloads' own
    // "netbox-unreachable" token through Facility's OWN reason vocabulary
    // (facilityReasonCopy), which does not define it (its nearest entry is
    // the differently-spelled "netbox-unreadable") and fell through to a
    // generic "this section cannot be read" that named neither the failed
    // source nor gave a next step. Now shares degradedReasonCopy with
    // MediaWorkloads/index.tsx so the two surfaces can't disagree.
    expect(await screen.findByText(/isn.t responding right now/)).toBeTruthy()
    expect(screen.queryByText(/0 media workload/)).toBeNull()
  })

  // fix-round P1-1 (PR #81): same shape as MediaWorkloads/index.tsx's own
  // pin — `workloads: []` with `invalid_instances` non-empty PROVES an
  // instance exists (excluded, not absent). "0 media workloads provisioned"
  // is exactly the false-absence claim hard gate 1 forbids.
  it('a degraded read with no reason token (invalid-instances-only) never states a fabricated zero count', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload(),
      '/api/media-workloads/grouped': {
        configured: true,
        degraded: true,
        scope: [],
        workloads: [],
        invalid_instances: [
          {
            instance: 'bad-svc',
            function_key: 'mxl-videotestsrc',
            workload_assignment: 'invalid-multiple',
            conflicting_workloads: ['alpha', 'beta'],
          },
        ],
      },
    })
    expect(await screen.findByText('Media workloads')).toBeTruthy()
    expect(await screen.findByText(/This count is incomplete/)).toBeTruthy()
    expect(screen.queryByText(/0 media workload/)).toBeNull()
    // NetBox WAS reachable — must not borrow the unreachable-specific copy.
    expect(screen.queryByText(/isn.t responding right now/)).toBeNull()
  })

  // fix-round P1-1, SECOND PASS (PR #81): the first pass only withheld the
  // number when `workloads` was empty — this is the missing counter-example
  // the reviewer named. One VALID group ("alpha") plus an invalid instance
  // that names workload:beta AND workload:gamma: those two tags could each
  // name an entire group with NO other member at all, so the true total is
  // unknown — it could be 1, 2, or 3. The endpoint cannot tell, so this
  // panel must not print "1 media workload provisioned" as if it could.
  it('a degraded read with SOME valid groups still refuses an exact count — states a lower bound instead', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload(),
      '/api/media-workloads/grouped': {
        configured: true,
        degraded: true,
        scope: [],
        workloads: [
          { slug: 'alpha', name: 'alpha', lifecycle: 'operate', health: 'ok', instances: [], functions: [] },
        ],
        invalid_instances: [
          {
            instance: 'bad-svc',
            function_key: 'mxl-videotestsrc',
            workload_assignment: 'invalid-multiple',
            conflicting_workloads: ['beta', 'gamma'],
          },
        ],
      },
    })
    expect(await screen.findByText('Media workloads')).toBeTruthy()
    // The exact-count sentence must never appear here.
    expect(
      screen.queryByText(
        (_, el) => el?.tagName === 'P' && /^1 media workload provisioned on this facility\.$/.test((el.textContent ?? '').trim()),
      ),
    ).toBeNull()
    // A stated lower bound instead — real, but explicitly not the total.
    expect(
      await screen.findByText(
        (_, el) => el?.tagName === 'P' && /At least 1 media workload/.test(el.textContent ?? ''),
      ),
    ).toBeTruthy()
    expect(screen.getByText(/this count may be incomplete/)).toBeTruthy()
  })

  // fix-round P2-3 (PR #81): a settled failed refetch must win over stale
  // retained data — hold-then-reject, not first-load (see the matching pin
  // in mediaWorkloadsGrid.test.tsx for the full reasoning). Fake timers so
  // the 15s refetchInterval (api/hooks.ts's useMediaWorkloadsGrouped) can be
  // advanced deterministically; settle() + getBy*, never findBy* under fake
  // timers (findBy* waits on real timers and would hang).
  it('a settled failed refetch overrides a retained honest zero — never re-states it', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/facility/dmf-lab/detail')) {
          return new Response(JSON.stringify(detailPayload()), { status: 200 })
        }
        if (url.endsWith('/api/media-workloads/grouped')) {
          calls += 1
          if (calls === 1) {
            return new Response(
              JSON.stringify({ configured: true, degraded: false, scope: [], workloads: [], invalid_instances: [] }),
              { status: 200 },
            )
          }
          return new Response('boom', { status: 500 })
        }
        throw new Error(`unrouted fetch in test: ${url}`)
      }),
    )
    renderWithQuery(
      <MemoryRouter initialEntries={['/facilities/dmf-lab']}>
        <Routes>
          <Route path="/facilities/:site" element={<FacilityDetail />} />
        </Routes>
      </MemoryRouter>,
    )

    // First (successful, genuinely empty) read settles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && /0 media workloads provisioned on this facility\./.test(el.textContent ?? ''),
      ),
    ).toBeTruthy()

    // Advance past the 15s poll interval so the background refetch fires
    // and rejects, while the old (empty, non-degraded) data stays retained.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100)
    })

    expect(
      screen.getByText('Cannot confirm the media workload count — the last read attempt failed. Retrying automatically.'),
    ).toBeTruthy()
    expect(
      screen.queryByText(
        (_, el) => el?.tagName === 'P' && /0 media workloads provisioned on this facility\./.test(el.textContent ?? ''),
      ),
    ).toBeNull()
  })

  // fix-round 5 (PR #81, codex sibling sweep): `!data.configured` was
  // checked BEFORE `isError`, contradicting the panel's own doc comment
  // ("isError wins regardless of retained data") — a settled failed
  // refetch that retained a `configured: false` payload silently kept
  // presenting that stale config posture as current instead of surfacing
  // the failed read. Hold-then-reject: first read retained is genuinely
  // not-configured, second read (after isError flips true) must show the
  // failed-read message, not the stale not-configured message.
  it('isError wins over a retained not-configured payload too, not just a retained count', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/facility/dmf-lab/detail')) {
          return new Response(JSON.stringify(detailPayload()), { status: 200 })
        }
        if (url.endsWith('/api/media-workloads/grouped')) {
          calls += 1
          if (calls === 1) {
            return new Response(
              JSON.stringify({ configured: false, reason: '', workloads: [], invalid_instances: [] }),
              { status: 200 },
            )
          }
          return new Response('boom', { status: 500 })
        }
        throw new Error(`unrouted fetch in test: ${url}`)
      }),
    )
    renderWithQuery(
      <MemoryRouter initialEntries={['/facilities/dmf-lab']}>
        <Routes>
          <Route path="/facilities/:site" element={<FacilityDetail />} />
        </Routes>
      </MemoryRouter>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('Media workloads are not configured for this environment.')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100)
    })

    expect(
      screen.getByText('Cannot confirm the media workload count — the last read attempt failed. Retrying automatically.'),
    ).toBeTruthy()
    expect(screen.queryByText('Media workloads are not configured for this environment.')).toBeNull()
  })

  it('a genuinely successful read with zero workloads still states the honest zero', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload(),
      '/api/media-workloads/grouped': {
        configured: true,
        degraded: false,
        scope: [],
        workloads: [],
        invalid_instances: [],
      },
    })
    expect(
      await screen.findByText(
        (_, el) => el?.tagName === 'P' && /0 media workloads provisioned on this facility\./.test(el.textContent ?? ''),
      ),
    ).toBeTruthy()
  })

  it('renders the real count when the read succeeds', async () => {
    renderDetail('dmf-lab', {
      '/api/facility/dmf-lab/detail': detailPayload(),
      '/api/media-workloads/grouped': {
        configured: true,
        degraded: false,
        scope: [],
        workloads: [
          { slug: 'a', name: 'a', lifecycle: 'operate', health: 'ok', instances: [], functions: [] },
          { slug: 'b', name: 'b', lifecycle: 'operate', health: 'ok', instances: [], functions: [] },
        ],
        invalid_instances: [],
      },
    })
    expect(
      await screen.findByText(
        (_, el) => el?.tagName === 'P' && /2 media workloads provisioned on this facility\./.test(el.textContent ?? ''),
      ),
    ).toBeTruthy()
  })
})

// GATE-S1-RV2 P2: a degradation reason nothing renders is a reason that does
// not exist. Both halves asserted, so the banner cannot become unconditional.
describe('partial NetBox data is stated, not swallowed', () => {
  it('warns beside the facility tile when rows were unreadable', async () => {
    stubFetch({ '/api/facility/summary': summary({ reason: 'netbox-rows-unparseable' }) })
    renderWithQuery(<MemoryRouter><Facility /></MemoryRouter>)
    expect(await screen.findByText(/Some NetBox records could not be read/)).toBeTruthy()
    expect(screen.getByText('DMF Lab')).toBeTruthy()
  })

  it('states BOTH faults when the site also has no slug', async () => {
    // Ordering matters: the no-slug branch returned early and swallowed the
    // partial warning, so the operator learned the link was broken but not
    // that the data was incomplete (GATE-S1-RV3 P3).
    stubFetch({
      '/api/facility/summary': summary({
        reason: 'netbox-rows-unparseable',
        sites: [{ name: 'DMF Lab', slug: null, device_count: 0 }],
      }),
    })
    renderWithQuery(<MemoryRouter><Facility /></MemoryRouter>)
    expect(await screen.findByText(/Some NetBox records could not be read/)).toBeTruthy()
    expect(screen.getByText(/no slug for it/)).toBeTruthy()
  })

  it('states only the slug fault when the rows were all readable', async () => {
    // The other ordering, so neither message becomes unconditional.
    stubFetch({
      '/api/facility/summary': summary({
        reason: '',
        sites: [{ name: 'DMF Lab', slug: null, device_count: 0 }],
      }),
    })
    renderWithQuery(<MemoryRouter><Facility /></MemoryRouter>)
    expect(await screen.findByText(/no slug for it/)).toBeTruthy()
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })

  it('says nothing of the sort when every row parsed', async () => {
    stubFetch({ '/api/facility/summary': summary() })
    renderWithQuery(<MemoryRouter><Facility /></MemoryRouter>)
    await screen.findByText('DMF Lab')
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })
})
