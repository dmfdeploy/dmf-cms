/**
 * Media-native tile grid + live modal (WP-C, dmfdeploy/dmfdeploy#185).
 *
 * Covers the load-bearing behaviours: deterministic keyed grid + catalog
 * display-name join; the Grid|Table toggle (persisted); the codex P2/P3 polling
 * bounds (no churn in table view / hidden tab / beyond the live-tile cap /
 * under reduced motion); the fixed 16:9 box that never resizes on a dropped
 * frame; the live modal open/close; and the C5 clear-for-deployment flow from a
 * tile (reason required + Activity record).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import MediaWorkloads from '../pages/MediaWorkloads'
import {
  LIVE_TILE_CAP,
  MODAL_STATUS_POLL_MS,
  PREVIEW_TICK_MS,
  STATUS_POLL_MS,
} from '../pages/MediaWorkloads/liveView'
import { useActivityStore } from '../store/activity'
import type {
  CatalogEntry,
  MediaWorkloadInstance,
  MediaWorkloadsResponse,
} from '../api/types'

// ---- fixtures --------------------------------------------------------------

function inst(overrides: Partial<MediaWorkloadInstance> = {}): MediaWorkloadInstance {
  return {
    instance: 'mxl-a',
    netbox_id: 1,
    function_key: 'mxl-videotest-view',
    live_view: true,
    requested_state: 'active',
    observed_state: 'running',
    reconcile_pending: false,
    placement: { node: 'node-1', ports: [9000], protocol: 'tcp' },
    ...overrides,
  }
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'mxl-videotest-view',
    display_name: 'MXL Video Test View',
    summary: '',
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
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const AVAILABLE_STATUS = {
  available: true,
  role: 'receiver',
  provider: 'aliyun',
  preview: true,
  mxl_version: '1.2.3',
  flow: {
    head_index: 42,
    latency_ms: 3.5,
    latency_grains: 2,
    active: true,
    format: 'Video',
    grain_rate: '50/1',
  },
}

interface HarnessOpts {
  instances?: MediaWorkloadInstance[]
  catalog?: CatalogEntry[]
  // per-instance status override; defaults to AVAILABLE_STATUS
  statusFor?: (instance: string) => Record<string, unknown>
  clearResult?: Record<string, unknown>
}

function mkFetch(opts: HarnessOpts) {
  const workloads: MediaWorkloadsResponse = {
    configured: true,
    degraded: false,
    scope: [],
    instances: opts.instances ?? [inst()],
    functions: [],
  }
  const statusCalls: Record<string, number> = {}
  const clearCalls: Array<{ url: string; init?: RequestInit }> = []
  // The legacy aggregate endpoint (MxlDetailPanel). After the R1 P1 fix nothing
  // should hit it unless the modal fallback is explicitly opened.
  const counters = { aggregateStatus: 0, aggregatePreview: 0 }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/catalog')) return json({ entries: opts.catalog ?? [catalogEntry()] })
    if (url.endsWith('/api/media-workloads')) return json(workloads)
    if (url.match(/\/api\/mxl\/status$/)) {
      counters.aggregateStatus += 1
      return json({ configured: true, reachable: true, nodes: [], flow: {}, transport: {} })
    }
    if (url.match(/\/api\/mxl\/preview/)) {
      counters.aggregatePreview += 1
      return json({})
    }
    const m = url.match(/\/api\/media-workloads\/([^/]+)\/mxl\/status/)
    if (m) {
      const name = decodeURIComponent(m[1])
      statusCalls[name] = (statusCalls[name] ?? 0) + 1
      const body = opts.statusFor ? opts.statusFor(name) : AVAILABLE_STATUS
      return json({ instance: name, ...body })
    }
    if (url.match(/\/api\/media-workloads\/[^/]+\/clear/)) {
      clearCalls.push({ url, init })
      return json(
        opts.clearResult ?? {
          instance: 'x',
          requested_state: 'active',
          previous_state: 'bootstrapped',
          request_id: 'req-1',
          actor: 'ops',
          role: 'operator',
          reason: 'go',
          reconcile: { expectation: 'converging', watch: '' },
        },
      )
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { statusCalls, clearCalls, counters, fetchMock }
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MediaWorkloads />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function srcTick(img: HTMLImageElement): number {
  const raw = img.getAttribute('src') ?? ''
  const t = new URL(raw, 'http://localhost').searchParams.get('t')
  return Number(t)
}

// Advance fake timers inside act() so react-query's async fetch chain resolves
// and React flushes the resulting re-render before we assert.
async function settle(ms = 60) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  window.localStorage.clear()
  useActivityStore.setState({ records: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // reset any visibilityState override
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

// ---- tests -----------------------------------------------------------------

describe('grid: deterministic order + display-name join', () => {
  it('renders tiles sorted by instance and joins catalog display_name (with fallback)', async () => {
    mkFetch({
      instances: [
        inst({ instance: 'mxl-c', function_key: 'mxl-videotest-view' }),
        inst({ instance: 'mxl-a', function_key: 'mxl-videotest-view' }),
        inst({ instance: 'mxl-b', function_key: 'unknown-fn' }),
      ],
    })
    renderPage()

    // display_name from catalog for known keys; fallback to function_key.
    expect(await screen.findAllByText('MXL Video Test View')).toHaveLength(2)
    expect(screen.getByText('unknown-fn')).toBeTruthy()

    // Deterministic order: mxl-a, mxl-b, mxl-c regardless of payload order.
    const monos = screen.getAllByText(/^mxl-[abc]$/)
    expect(monos.map((n) => n.textContent)).toEqual(['mxl-a', 'mxl-b', 'mxl-c'])
  })
})

describe('Grid|Table toggle', () => {
  it('defaults to grid, persists table to localStorage, and the table has no live thumbnails', async () => {
    mkFetch({})
    renderPage()

    await screen.findByText('MXL Video Test View')
    // Grid by default: a thumbnail image exists (once status resolves).
    expect(await screen.findByAltText(/Live preview of/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Table' }))
    expect(window.localStorage.getItem('dmf-console-mw-view')).toBe('table')
    // Table view: a real <table> and NO tile thumbnails.
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.queryByAltText(/Live preview of/)).toBeNull()
  })
})

describe('polling bounds (codex P2/P3)', () => {
  it('does not poll status or render a live thumbnail when the tab is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const { statusCalls } = mkFetch({})
    renderPage()

    await screen.findByText('MXL Video Test View')
    // No live thumbnail (placeholder shown instead) and status never fetched.
    expect(screen.queryByAltText(/Live preview of/)).toBeNull()
    expect(statusCalls['mxl-a'] ?? 0).toBe(0)
  })

  it('churns the thumbnail within the cap but pauses it under reduced motion', async () => {
    // First: motion allowed (matchMedia absent -> not reduced).
    vi.useFakeTimers()
    mkFetch({})
    renderPage()
    await settle() // settle initial status fetch

    const img = screen.getByAltText(/Live preview of/) as HTMLImageElement
    const t0 = srcTick(img)
    await settle(PREVIEW_TICK_MS + 20)
    expect(srcTick(screen.getByAltText(/Live preview of/) as HTMLImageElement)).toBeGreaterThan(t0)
    cleanup()
    vi.useRealTimers()

    // Then: reduced motion -> no churn, an explicit Refresh affordance instead.
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    vi.useFakeTimers()
    const rm = mkFetch({})
    renderPage()
    await settle()

    const img2 = screen.getByAltText(/Live preview of/) as HTMLImageElement
    const r0 = srcTick(img2)
    const statusAfterLoad = rm.statusCalls['mxl-a'] ?? 0
    await settle(STATUS_POLL_MS * 3)
    // No churn AND no auto-refetch: status was fetched once, not on an interval.
    expect(srcTick(screen.getByAltText(/Live preview of/) as HTMLImageElement)).toBe(r0)
    expect(rm.statusCalls['mxl-a'] ?? 0).toBe(statusAfterLoad)
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })

  it('caps concurrently-live tiles: the tile beyond the cap holds a static frame + Refresh', async () => {
    vi.useFakeTimers()
    const many = Array.from({ length: LIVE_TILE_CAP + 1 }, (_, i) =>
      inst({ instance: `mxl-${String(i).padStart(2, '0')}` }),
    )
    const cap = mkFetch({ instances: many })
    renderPage()
    await settle()

    const imgs = screen.getAllByAltText(/Live preview of/) as HTMLImageElement[]
    expect(imgs).toHaveLength(LIVE_TILE_CAP + 1)
    const before = imgs.map(srcTick)
    const capName = `mxl-${String(LIVE_TILE_CAP).padStart(2, '0')}` // the (cap+1)th tile
    const cappedCallsBefore = cap.statusCalls[capName] ?? 0
    await settle(STATUS_POLL_MS + PREVIEW_TICK_MS + 20)
    const after = (screen.getAllByAltText(/Live preview of/) as HTMLImageElement[]).map(srcTick)

    // First LIVE_TILE_CAP advanced; the last (beyond cap) held its frame.
    for (let i = 0; i < LIVE_TILE_CAP; i++) expect(after[i]).toBeGreaterThan(before[i])
    expect(after[LIVE_TILE_CAP]).toBe(before[LIVE_TILE_CAP])
    // And the capped tile never auto-refetches status (fetched once, then held) —
    // proves the cap bounds the ACTUAL polling, not just the image churn.
    expect(cap.statusCalls[capName] ?? 0).toBe(cappedCallsBefore)
    for (let i = 0; i < LIVE_TILE_CAP; i++) {
      const name = `mxl-${String(i).padStart(2, '0')}`
      expect(cap.statusCalls[name] ?? 0).toBeGreaterThan(1)
    }
    // Exactly one Refresh affordance (the capped tile).
    expect(screen.getAllByRole('button', { name: 'Refresh' })).toHaveLength(1)
  })

  it('pauses tile polling while the modal is open (the single fast-cadence surface)', async () => {
    vi.useFakeTimers()
    const h = mkFetch({
      instances: [inst({ instance: 'mxl-a' }), inst({ instance: 'mxl-b' })],
    })
    renderPage()
    await settle()
    await settle(STATUS_POLL_MS * 2)
    const bBefore = h.statusCalls['mxl-b'] ?? 0
    expect(bBefore).toBeGreaterThan(1) // tile B was actively polling

    // Open the modal for A → every tile query is disabled.
    const tileA = screen.getAllByText('MXL Video Test View')[0].closest('[role="button"]')!
    fireEvent.click(tileA)
    await settle(STATUS_POLL_MS * 3)

    expect(screen.getByRole('dialog')).toBeTruthy()
    // B's tile stopped polling entirely while the modal owns the fast cadence.
    expect(h.statusCalls['mxl-b'] ?? 0).toBe(bBefore)
  })

  it('table view never hits the legacy aggregate; its Live view opens the same modal', async () => {
    window.localStorage.setItem('dmf-console-mw-view', 'table') // start in table
    vi.useFakeTimers()
    const h = mkFetch({})
    renderPage()
    await settle(STATUS_POLL_MS * 3)

    // No inline live panel: neither the aggregate endpoint nor per-instance polling runs.
    expect(h.counters.aggregateStatus).toBe(0)
    expect(h.statusCalls['mxl-a'] ?? 0).toBe(0)

    // The table Live view opens the SAME per-instance modal, not the aggregate panel.
    fireEvent.click(screen.getByRole('button', { name: 'Live view' }))
    await settle(STATUS_POLL_MS)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(h.counters.aggregateStatus).toBe(0)
    expect(h.statusCalls['mxl-a'] ?? 0).toBeGreaterThan(0)
  })
})

describe('fixed 16:9 box (hard gate 5)', () => {
  it('swaps a dropped frame for a placeholder without removing the aspect box', async () => {
    mkFetch({})
    renderPage()
    const img = (await screen.findByAltText(/Live preview of/)) as HTMLImageElement
    const box = img.parentElement as HTMLElement
    expect(box.className).toContain('aspect-video')

    fireEvent.error(img)
    // The image is gone but the SAME fixed box remains (no reflow).
    expect(screen.queryByAltText(/Live preview of/)).toBeNull()
    expect(box.className).toContain('aspect-video')
    expect(box.isConnected).toBe(true)
  })
})

describe('live modal', () => {
  it('opens on tile click and closes on Escape', async () => {
    mkFetch({})
    renderPage()
    const tile = (await screen.findByText('MXL Video Test View')).closest('[role="button"]')!
    fireEvent.click(tile)

    const dialog = await screen.findByRole('dialog')
    // 200ms cache-busted preview present inside the modal.
    expect(within(dialog).getByAltText(/Live preview of mxl-a/)).toBeTruthy()
    // Node stat is the NetBox placement, labelled as such.
    expect(within(dialog).getByText('Node (NetBox)')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves focus into the dialog on open (aria-modal focus management)', async () => {
    mkFetch({})
    renderPage()
    const tile = (await screen.findByText('MXL Video Test View')).closest('[role="button"]')!
    fireEvent.click(tile)
    const dialog = await screen.findByRole('dialog')
    // Focus is pulled into the dialog rather than left on background controls.
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('polls the modal flow stats at the fast 200ms cadence', async () => {
    expect(MODAL_STATUS_POLL_MS).toBe(200) // the flow stats/head index must tick at 200ms, not slower
    vi.useFakeTimers()
    const h = mkFetch({})
    renderPage()
    await settle()

    const tile = screen.getByText('MXL Video Test View').closest('[role="button"]')!
    fireEvent.click(tile)
    await settle(0)
    const base = h.statusCalls['mxl-a'] ?? 0 // after the modal's initial fetch

    await settle(MODAL_STATUS_POLL_MS * 5)
    // ~5 refetches over 5 windows (allow slack) — proves the status endpoint,
    // not just the preview image, ticks at 200ms while the modal is open.
    expect((h.statusCalls['mxl-a'] ?? 0) - base).toBeGreaterThanOrEqual(4)
  })
})

describe('clear-for-deployment from a tile (C5)', () => {
  it('arms a reason, does not POST until confirmed, then records to Activity', async () => {
    const { clearCalls } = mkFetch({
      instances: [inst({ instance: 'mxl-a', requested_state: 'bootstrapped', reconcile_pending: false })],
      clearResult: {
        instance: 'mxl-a',
        requested_state: 'active',
        previous_state: 'bootstrapped',
        request_id: 'req-xyz',
        actor: 'ops',
        role: 'operator',
        reason: 'scheduled run',
        reconcile: { expectation: 'converging', watch: '' },
      },
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Clear for deployment' }))
    // Armed; nothing sent yet.
    const textbox = await screen.findByRole('textbox')
    expect(clearCalls).toHaveLength(0)
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.change(textbox, { target: { value: 'scheduled run' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await screen.findByText(/requested state is now active/)
    expect(clearCalls).toHaveLength(1)
    expect(JSON.parse(clearCalls[0].init?.body as string)).toEqual({ reason: 'scheduled run' })
    // C5: the console-local Activity record landed, correlated by request_id.
    const records = useActivityStore.getState().records
    expect(records.some((r) => r.request_id === 'req-xyz')).toBe(true)
  })
})
