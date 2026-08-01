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
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import MediaWorkloads from '../pages/MediaWorkloads'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
import WorkloadOperate from '../pages/MediaWorkloads/Operate'
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
  MediaWorkloadsGroupedResponse,
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
  // umbrella #201 WP5 — undefined means "no topology" (the fetch catch-all's
  // `{}` response), matching every non-viewer instance today.
  topology?: Record<string, unknown>
  switchResult?: Record<string, unknown>
  /** The backend's derived workload lifecycle (ADR-0046 §3). Defaults to
   *  'operate'; a fixture with bootstrapped instances must say 'provision',
   *  because that is what the backend would actually derive for them. */
  lifecycle?: 'provision' | 'configure' | 'operate' | 'unknown'
}

function mkFetch(opts: HarnessOpts) {
  const instances = (opts.instances ?? [inst()]).map((i) => ({
    ...i,
    workload_assignment: 'ok',
  }))
  const groupedResponse: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    workloads: [
      {
        slug: 'test',
        name: 'test',
        lifecycle: opts.lifecycle ?? 'operate',
        health: 'ok',
        instances,
        functions: [],
      },
    ],
    invalid_instances: [],
  }
  const statusCalls: Record<string, number> = {}
  const clearCalls: Array<{ url: string; init?: RequestInit }> = []
  const switchCalls: Array<{ url: string; init?: RequestInit }> = []
  // The legacy aggregate endpoint (MxlDetailPanel). After the R1 P1 fix nothing
  // should hit it unless the modal fallback is explicitly opened.
  const counters = { aggregateStatus: 0, aggregatePreview: 0 }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/catalog')) return json({ entries: opts.catalog ?? [catalogEntry()] })
    if (url.endsWith('/api/media-workloads/grouped')) return json(groupedResponse)
    if (url.endsWith('/api/media-workloads')) return json(groupedResponse)
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
    if (url.match(/\/api\/media-workloads\/[^/]+\/topology$/)) {
      return json(opts.topology ?? {})
    }
    if (url.match(/\/api\/media-workloads\/[^/]+\/switch-source$/)) {
      switchCalls.push({ url, init })
      return json(
        opts.switchResult ?? {
          command_id: 'cmd-1',
          receiver_instance: 'mxl-a',
          source_instance: 'source-b',
          reason: 'go',
          status: 'active',
          previous_source: 'source-a',
          error: null,
          request_id: 'req-switch-1',
          initiator: 'ops',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          actor: 'ops',
          role: 'engineer',
        },
      )
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { statusCalls, clearCalls, switchCalls, counters, fetchMock }
}

// S1 (umbrella #285): these behaviours did not change, their HOME did. The
// per-instance tile grid, the live modal and the switch/clear controls moved
// off the Media Workloads list page and onto the workload detail page's
// lifecycle rail, so the tests follow them there rather than being deleted —
// the polling bounds and focus management below are exactly the kind of
// reviewed behaviour a relocation quietly loses if nothing keeps watching.
//
// ARC B moved a subset AGAIN, for the same reason and with the same
// treatment. Operate left the workload flow page onto its own monitoring
// route (operator direction 2026-08-01), taking the tile grid, the live
// modal and every polling bound with it — so those blocks now mount
// renderOperatePage() and the switch/clear blocks stay here. Nothing was
// deleted in the move: if a bound below stops being asserted, it is because
// someone removed it deliberately, not because a page got renamed.
function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/test']}>
        <Routes>
          <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/**
 * The Operate route — where the live view, the modal and every polling bound
 * moved in Arc B. Mounted at the real path so useParams resolves the slug
 * exactly as the app does.
 */
function renderOperatePage(slug = 'test') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/media-workloads/${slug}/operate`]}>
        <Routes>
          <Route path="/media-workloads/:slug/operate" element={<WorkloadOperate />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/**
 * ARC B: the flow folds — only the step the workload is AT is pinned open.
 * A test reaching into another step opens it the way an operator would, by
 * clicking the same Review control. It cannot open a locked step, which is
 * what keeps these assertions honest about what the gate permits.
 */
function openStep(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: label, level: 2 })
  const section = heading.closest('section') as HTMLElement
  const review = within(section).queryByRole('button', { name: 'Review' })
  if (review) fireEvent.click(review)
  return heading.closest('section') as HTMLElement
}

/** The list page itself, for the entry-tile behaviours that stayed here. */
function renderListPage() {
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
    renderOperatePage()

    // display_name from catalog for known keys; fallback to function_key.
    expect(await screen.findAllByText('MXL Video Test View')).toHaveLength(2)
    expect(screen.getByText('unknown-fn')).toBeTruthy()

    // Deterministic order: mxl-a, mxl-b, mxl-c regardless of payload order.
    const monos = screen.getAllByText(/^mxl-[abc]$/)
    expect(monos.map((n) => n.textContent)).toEqual(['mxl-a', 'mxl-b', 'mxl-c'])
  })
})

// The Grid|Table toggle and its localStorage persistence were REMOVED by the
// S1 IA cut (umbrella #285), not relocated: the workload detail page shows one
// surface, and a view switcher on it would be a preference with nothing to
// prefer. Its coverage is deliberately deleted rather than repointed — keeping
// a passing test for a control that no longer exists would be worse than the
// gap. Restoring the toggle means restoring these assertions.

describe('polling bounds (codex P2/P3)', () => {
  it('does not poll status or render a live thumbnail when the tab is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const { statusCalls } = mkFetch({})
    renderOperatePage()

    await screen.findByText('MXL Video Test View')
    // No live thumbnail (placeholder shown instead) and status never fetched.
    expect(screen.queryByAltText(/Live preview of/)).toBeNull()
    expect(statusCalls['mxl-a'] ?? 0).toBe(0)
  })

  it('churns the thumbnail within the cap but pauses it under reduced motion', async () => {
    // First: motion allowed (matchMedia absent -> not reduced).
    vi.useFakeTimers()
    mkFetch({})
    renderOperatePage()
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
    renderOperatePage()
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
    renderOperatePage()
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
    renderOperatePage()
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

  // GATE-S1-RV: the old wording here ("never hit, on any surface") was FALSE
  // — the live_view=false fallback still mounts MxlDetailPanel, which is the
  // aggregate's one legitimate remaining caller. The honest claim is narrower
  // and still worth pinning: the LIVE path never reaches for it.
  it('never hits the retired legacy aggregate on the live path', async () => {
    vi.useFakeTimers()
    const h = mkFetch({})
    renderOperatePage()
    await settle()
    await settle(STATUS_POLL_MS * 3)

    expect(h.counters.aggregateStatus).toBe(0)
    expect(h.counters.aggregatePreview).toBe(0)

    // Opening the per-instance modal drives per-instance polling — never the
    // aggregate panel. getBy + settle, never findBy: findBy* waits on REAL
    // timers, which never advance under fake timers and would hang here.
    const tile = screen.getAllByText('MXL Video Test View')[0].closest('[role="button"]')!
    fireEvent.click(tile)
    await settle(STATUS_POLL_MS)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(h.counters.aggregateStatus).toBe(0)
    expect(h.statusCalls['mxl-a'] ?? 0).toBeGreaterThan(0)
  })
})

describe('fixed 16:9 box (hard gate 5)', () => {
  it('swaps a dropped frame for a placeholder without removing the aspect box', async () => {
    mkFetch({})
    renderOperatePage()
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
    renderOperatePage()
    const tile = (await screen.findByText('MXL Video Test View')).closest('[role="button"]')!
    fireEvent.click(tile)

    await screen.findByRole('dialog')
    // 200ms cache-busted preview present inside the modal.
    expect(screen.getByAltText(/Live preview of mxl-a/)).toBeTruthy()
    // Node stat is the NetBox placement, labelled as such.
    expect(screen.getByText('Node (NetBox)')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves focus into the dialog on open (aria-modal focus management)', async () => {
    mkFetch({})
    renderOperatePage()
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
    renderOperatePage()
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

describe('clear-for-deployment on the Provision stage (C5)', () => {
  it('arms a reason, does not POST until confirmed, then records to Activity', async () => {
    const { clearCalls } = mkFetch({
      // Bootstrapped members with no active intent IS the backend's
      // 'provision' derivation — and the stage that now grants the clear.
      lifecycle: 'provision',
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

// umbrella #320/#321 (runtime truth): active_source is now a live observation,
// not a static catalog value — fixtures need matching provenance/observed_at
// so the fail-closed switch control treats them as fresh, confirmed readings.
// These are computed lazily (factory functions, called at test-execution
// time) rather than baked into a module-level constant at import time — this
// file's other describes exercise real timers, so a value computed once at
// module load could genuinely cross the 15s staleness bound before a later
// test in the same run gets around to using it.
function freshObservedAt(): string {
  return new Date(Date.now() - 1_000).toISOString() // 1s old — well under the 15s staleness bound
}

function staleObservedAt(): string {
  return new Date(Date.now() - 60_000).toISOString() // 60s old — past the 15s staleness bound
}

function topologyMxlA(overrides: Record<string, unknown> = {}) {
  return {
    receiver_instance: 'mxl-a',
    sources: [
      { id: 'source-a', flow_id: '5fbec3b1-1b0f-417d-9059-8b94a47197ed', pattern: 'smpte' },
      { id: 'source-b', flow_id: 'b0ae9cba-a989-4568-ac96-8bd19272c966', pattern: 'ball' },
    ],
    active_source: 'source-a',
    provenance: 'observed-flow',
    observed_at: freshObservedAt(),
    ...overrides,
  }
}

// GATE-S1 P1: the switch control used to live in the live modal, which the
// Operate stage mounts — so switching existed outside Configure and outside
// the rail's busy suppression entirely. The control is now Configure's alone
// and renders inline on the stage, so these tests drive it there. Same
// behaviours, same fail-closed contract; only the host surface changed.
describe('switch source on the Configure stage (umbrella #201 WP5)', () => {
  it('renders no switch control when the instance carries no topology', async () => {
    mkFetch({})
    renderPage()
    await screen.findAllByText('Configure') // strip chip + step header
    openStep('Configure')
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()
  })

  it('lists the topology\'s OTHER sources only, and shows the current one before arming', async () => {
    mkFetch({ topology: topologyMxlA() })
    renderPage()
    await screen.findAllByText('Configure') // strip chip + step header
    openStep('Configure')

    expect(await screen.findByText('source-a')).toBeTruthy() // current active source shown

    fireEvent.click(screen.getByRole('button', { name: 'Switch source' }))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toContain('source-b')
    expect(optionValues).not.toContain('source-a') // the active source is never a switch target
  })

  it('shows the OBSERVED source (not a stale catalog value) and offers only the other sources', async () => {
    // Conceptually: a stale catalog might have said source-a, but the live
    // observation says source-b — the card and the offered targets must
    // follow the observation, not any catalog default.
    mkFetch({
      topology: topologyMxlA({
        active_source: 'source-b',
        provenance: 'observed-flow',
        observed_at: freshObservedAt(),
      }),
    })
    renderPage()
    await screen.findAllByText('Configure') // strip chip + step header
    openStep('Configure')

    expect(await screen.findByText('source-b')).toBeTruthy() // the OBSERVED source, shown

    fireEvent.click(screen.getByRole('button', { name: 'Switch source' }))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toContain('source-a')
    expect(optionValues).not.toContain('source-b') // never offer the already-active source
  })

  it('fails closed (control ABSENT, no offered sources) when the observation is unknown', async () => {
    mkFetch({
      topology: topologyMxlA({
        active_source: null,
        provenance: null,
        observed_at: null,
      }),
    })
    renderPage()
    await screen.findAllByText('Configure') // strip chip + step header
    openStep('Configure')

    // GATE-S1 P2c: fail-closed is now ABSENCE, not a disabled button. A
    // greyed control still advertises an affordance the console will refuse,
    // which is the dead control the rail exists to avoid.
    // Await the honest line: it appears once the topology read resolves.
    expect(
      await screen.findByText(/Live source is unknown or stale — refresh to retry before switching\./),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('fails closed (control ABSENT, no offered sources) when the observation has gone stale', async () => {
    mkFetch({
      topology: topologyMxlA({
        active_source: 'source-a',
        provenance: 'observed-flow',
        observed_at: staleObservedAt(),
      }),
    })
    renderPage()
    await screen.findAllByText('Configure') // strip chip + step header
    openStep('Configure')

    // GATE-S1 P2c: fail-closed is now ABSENCE, not a disabled button. A
    // greyed control still advertises an affordance the console will refuse,
    // which is the dead control the rail exists to avoid.
    // Await the honest line: it appears once the topology read resolves.
    expect(
      await screen.findByText(/Live source is unknown or stale — refresh to retry before switching\./),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('requires both a target source and a reason before Confirm switch is enabled, then POSTs and records to Activity', async () => {
    const { switchCalls } = mkFetch({
      topology: topologyMxlA(),
      switchResult: {
        command_id: 'cmd-9',
        receiver_instance: 'mxl-a',
        source_instance: 'source-b',
        reason: 'operator requested',
        status: 'active',
        previous_source: 'source-a',
        error: null,
        request_id: 'req-switch-9',
        initiator: 'ops',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        actor: 'ops',
        role: 'engineer',
      },
    })
    renderPage()
    await screen.findAllByText('Configure') // strip chip + step header
    openStep('Configure')

    fireEvent.click(await screen.findByRole('button', { name: 'Switch source' }))
    const confirm = screen.getByRole('button', { name: 'Confirm switch' }) as HTMLButtonElement
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const textbox = screen.getByRole('textbox')

    // Neither target nor reason set — disabled.
    expect(confirm.disabled).toBe(true)
    expect(switchCalls).toHaveLength(0)

    fireEvent.change(textbox, { target: { value: 'operator requested' } })
    expect(confirm.disabled).toBe(true) // reason alone is not enough — no target yet

    fireEvent.change(select, { target: { value: 'source-b' } })
    expect(confirm.disabled).toBe(false)

    fireEvent.click(confirm)

    await screen.findByText(/Active source: source-b/)
    expect(switchCalls).toHaveLength(1)
    expect(JSON.parse(switchCalls[0].init?.body as string)).toEqual({
      source_instance: 'source-b',
      reason: 'operator requested',
    })
    const records = useActivityStore.getState().records
    expect(records.some((r) => r.request_id === 'req-switch-9' && r.action === 'switch-source')).toBe(true)
  })

  it('surfaces failed_rollback_required honestly, never masked as success', async () => {
    mkFetch({
      topology: topologyMxlA(),
      switchResult: {
        command_id: 'cmd-2',
        receiver_instance: 'mxl-a',
        source_instance: 'source-b',
        reason: 'go',
        status: 'failed_rollback_required',
        previous_source: 'source-a',
        error: 'switch-job-failed',
        outcome: null,
        outcome_message: null,
        request_id: 'req-switch-2',
        initiator: 'ops',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        actor: 'ops',
        role: 'engineer',
      },
    })
    renderPage()
    await screen.findAllByText('Configure') // strip chip + step header
    openStep('Configure')

    fireEvent.click(await screen.findByRole('button', { name: 'Switch source' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'go' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'source-b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }))

    await screen.findByText(/Switch failed/)
    expect(screen.getByText(/switch-job-failed/)).toBeTruthy()
    expect(screen.getByText(/operator retry\/rollback required/)).toBeTruthy()
    expect(screen.queryByText(/Active source: source-b/)).toBeNull()
  })

  // umbrella #320/#321 gate follow-up (bug 2): outcome/outcome_message are
  // additive fields on the switch-source POST response. When the backend
  // supplies a canned outcome_message, it must win over the coarse
  // error-based text — the test above proves the null case still falls back.
  it('prefers outcome_message as the primary text when the backend supplies one', async () => {
    mkFetch({
      topology: topologyMxlA(),
      switchResult: {
        command_id: 'cmd-3',
        receiver_instance: 'mxl-a',
        source_instance: 'source-b',
        reason: 'go',
        status: 'failed_rollback_required',
        previous_source: 'source-a',
        error: 'switch-job-failed',
        outcome: 'switch_failed_previous_source_restored',
        outcome_message:
          'Switch did not complete; the previous source was restored. Safe to retry.',
        request_id: 'req-switch-3',
        initiator: 'ops',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        actor: 'ops',
        role: 'engineer',
      },
    })
    renderPage()
    await screen.findAllByText('Configure') // strip chip + step header
    openStep('Configure')

    fireEvent.click(await screen.findByRole('button', { name: 'Switch source' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'go' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'source-b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }))

    // Appears twice by design: Configure's immediate result and Finalise &
    // Review's outcome marker are the same truth shown at both stages.
    await screen.findAllByText(
      'Switch did not complete; the previous source was restored. Safe to retry.',
    )
    // The coarse fallback text must NOT also render alongside the canned message.
    expect(screen.queryByText(/Switch failed \(switch-job-failed\)/)).toBeNull()
    // Expert detail (request_id + raw outcome code) stays available, just out
    // of the primary line — never a raw-stdout debug view.
    expect(screen.getAllByText(/req-switch-3/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/switch_failed_previous_source_restored/).length).toBeGreaterThan(0)
  })

  // umbrella #320/#321 gate follow-up (bug 1, TOCTOU): isObservedFresh is
  // derived from Date.now() at render time, and typing into ReasonConfirm's
  // own reason/target fields is THAT component's local state — it never
  // re-renders SwitchSourceControl. Without the ticking re-render, arming
  // while fresh and then sitting on the form past the staleness bound would
  // leave Confirm enabled on stale data. This proves the control catches
  // that reactively, with no topology re-fetch involved.
  it('goes stale reactively while armed, disabling Confirm and blocking the POST', async () => {
    vi.useFakeTimers()
    const { switchCalls } = mkFetch({ topology: topologyMxlA() })
    renderPage()
    await settle() // let the grouped/catalog fetch resolve so the tile renders

    await settle(0) // let the Configure stage's topology fetch resolve

    // Arc B: no step is pinned at lifecycle=operate, so Configure is folded
    // until opened — the same click the operator makes.
    openStep('Configure')
    await settle(0) // flush the disclosure re-render under fake timers
    fireEvent.click(screen.getByRole('button', { name: 'Switch source' }))

    const confirm = screen.getByRole('button', { name: 'Confirm switch' }) as HTMLButtonElement
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const textbox = screen.getByRole('textbox')

    fireEvent.change(textbox, { target: { value: 'operator requested' } })
    fireEvent.change(select, { target: { value: 'source-b' } })
    expect(confirm.disabled).toBe(false) // armed, target + reason set, still fresh

    // Let more than OBSERVED_SOURCE_STALE_MS (15s) elapse with NO topology
    // re-fetch and no other user action — only wall-clock time passing while
    // the operator sits on the armed form.
    await settle(16_000)

    expect(confirm.disabled).toBe(true) // caught reactively, not just at submit time
    expect(
      screen.getByText(/Live source is unknown or stale — refresh to retry before switching\./),
    ).toBeTruthy()

    // Confirm is now a genuinely disabled native button — clicking it must
    // not reach the switch-source endpoint.
    fireEvent.click(confirm)
    expect(switchCalls).toHaveLength(0)
  })
})

describe('grouped endpoint + degraded rendering (P3)', () => {
  it('requests /api/media-workloads/grouped (not the flat endpoint)', async () => {
    const { fetchMock } = mkFetch({})
    renderPage()
    // Anchored on the flow page's own heading rather than a tile display
    // name: the tiles moved to the Operate route in Arc B, and this test is
    // about which inventory endpoint the page reads, not about tiles.
    await screen.findByRole('heading', { name: 'test', level: 1 })

    const urls = fetchMock.mock.calls.map(
      (c: [RequestInfo | URL, RequestInit?]) =>
        (typeof c[0] === 'string' ? c[0] : (c[0] as Request).url).toString(),
    )
    expect(urls.some((u: string) => u.endsWith('/api/media-workloads/grouped'))).toBe(true)
    // The page must NOT fall back to the flat endpoint
    const flatCalls = urls.filter(
      (u: string) => u.endsWith('/api/media-workloads') && !u.includes('grouped'),
    )
    expect(flatCalls).toHaveLength(0)
  })

  // A LIST-page behaviour: it stayed on Media Workloads, so it renders there.
  it('renders valid workloads alongside invalid instances (degraded does not blank page)', async () => {
    // Override the mock to include an invalid instance + a valid workload
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/catalog')) {
        return json({ entries: [catalogEntry()] })
      }
      if (url.endsWith('/api/media-workloads/grouped')) {
        return json({
          configured: true,
          degraded: true,
          scope: [],
          workloads: [
            {
              slug: 'videotest',
              name: 'videotest',
              lifecycle: 'operate',
              health: 'ok',
              instances: [{ ...inst(), workload_assignment: 'ok' }],
              functions: [],
            },
          ],
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
    }))
    renderListPage()

    // Valid workload still renders (NOT hidden behind degraded banner)
    expect(await screen.findByText('videotest')).toBeTruthy()
    // Invalid instances section appears
    expect(screen.getByText('Invalid workload assignments')).toBeTruthy()
    expect(screen.getByText(/bad-svc/)).toBeTruthy()
    expect(screen.getByText(/alpha, beta/)).toBeTruthy()
  })
})


// umbrella #285 addendum (operator direction 2026-08-01): the index-page
// tile badge, the "Create media workload" entry point, and the Unassigned
// group's disposal explanation. All three render on the LIST page, so these
// tests drive renderListPage() (like the grouped/degraded describe above),
// not renderPage() (which mounts WorkloadDetail at a fixed slug).
//
// mkFetch's harness bakes a single workload named 'test' into the grouped
// response, which cannot express multiple workloads or a distinct
// 'unassigned' slug/name — so, exactly like the existing "degraded does not
// blank page" test above, these stub fetch directly.
function mkListFetch(workloads: MediaWorkloadsGroupedResponse['workloads']) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
    if (url.endsWith('/api/media-workloads/grouped')) {
      const body: MediaWorkloadsGroupedResponse = {
        configured: true,
        degraded: false,
        scope: [],
        workloads,
        invalid_instances: [],
      }
      return json(body)
    }
    // Live-preview status polling isn't under test here; answer with an
    // unavailable sidecar so no tile claims a live thumbnail to churn.
    if (url.match(/\/api\/media-workloads\/[^/]+\/mxl\/status/)) {
      return json({ available: false, reason: 'no-sidecar' })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock }
}

describe('tile lifecycle badge grammar (umbrella #285 addendum)', () => {
  it.each([
    ['provision', 'planned'],
    ['configure', 'provisioned'],
    ['operate', 'configured'],
    ['unknown', 'unknown'],
  ] as const)('renders the resting participle for position %s', async (lifecycle, participle) => {
    mkListFetch([
      {
        slug: 'test',
        name: 'test',
        lifecycle,
        health: 'ok',
        instances: [{ ...inst(), workload_assignment: 'ok' }],
        functions: [],
      },
    ])
    renderListPage()

    expect(await screen.findByText(participle)).toBeTruthy()
    // The raw backend token must not leak onto the tile in its place — the
    // whole point of the grammar helper is that the reader never sees
    // "provision"/"configure"/"operate" printed as if they were labels.
    if (lifecycle !== participle) {
      expect(screen.queryByText(lifecycle, { selector: 'span' })).toBeNull()
    }
  })

  it('does NOT render a progressive ("provisioning") form for a reconcile_pending member', async () => {
    // The index page's grouped payload carries no job overlay, so a member
    // stuck disagreeing between requested and observed must never read as
    // in-flight progress — see lifecycleBadge's docstring (workloadFlow.ts)
    // for the exact failure this pins: a crashed pod that will never start
    // still holds reconcile_pending=true forever, and "provisioning" would
    // present that stall as motion.
    mkListFetch([
      {
        slug: 'test',
        name: 'test',
        lifecycle: 'configure',
        health: 'ok',
        instances: [
          { ...inst({ requested_state: 'active', observed_state: 'failing', reconcile_pending: true }), workload_assignment: 'ok' },
        ],
        functions: [],
      },
    ])
    renderListPage()

    // Resting form for 'configure' is 'provisioned' — present.
    expect(await screen.findByText('provisioned')).toBeTruthy()
    // The progressive form for the same stage must be absent everywhere.
    expect(screen.queryByText('provisioning')).toBeNull()
    // The disagreement is instead named honestly, as its own marker.
    expect(screen.getByText('reconciling')).toBeTruthy()
  })

  it('renders no reconciling marker when every member is converged', async () => {
    mkListFetch([
      {
        slug: 'test',
        name: 'test',
        lifecycle: 'operate',
        health: 'ok',
        instances: [{ ...inst(), workload_assignment: 'ok' }], // reconcile_pending: false
        functions: [],
      },
    ])
    renderListPage()

    expect(await screen.findByText('configured')).toBeTruthy()
    expect(screen.queryByText('reconciling')).toBeNull()
  })
})

describe('"Create media workload" entry point (umbrella #285 addendum)', () => {
  it('links to /media-workloads/new', async () => {
    mkListFetch([])
    renderListPage()

    // Waits for the grouped fetch to resolve (empty-scope designed state)
    // before asserting, so the link is checked in its settled render.
    await screen.findByText('No Media Function instances in your scope.')
    const link = screen.getByRole('link', { name: 'Create media workload' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/media-workloads/new')
  })
})

describe('Unassigned group disposal explanation (umbrella #285 addendum)', () => {
  it('renders the designed explanation and no disposal button', async () => {
    mkListFetch([
      {
        slug: 'unassigned',
        name: 'Unassigned',
        lifecycle: 'unknown',
        health: 'ok',
        instances: [
          { ...inst({ instance: 'stray-1' }), workload_assignment: 'unassigned' },
        ],
        functions: [],
      },
    ])
    renderListPage()

    expect(await screen.findByText('About the Unassigned group')).toBeTruthy()
    // (a) what these entries are
    expect(screen.getByText(/recorded in the facility source of truth/)).toBeTruthy()
    // (b) the console cannot dispose, and why
    expect(screen.getByText(/cannot remove one of these records/)).toBeTruthy()
    expect(screen.getByText(/holds no seam to/)).toBeTruthy()
    // (c) what does dispose of one, and that teardown does not
    expect(screen.getByText(/deleting the service record in the facility/)).toBeTruthy()
    expect(screen.getByText(/teardown will not do this/)).toBeTruthy()

    // Never a disabled/dead "Dispose" control — no button naming disposal
    // exists anywhere on the page.
    expect(screen.queryByRole('button', { name: /dispose/i })).toBeNull()
    expect(screen.queryByText(/coming soon/i)).toBeNull()
  })

  it('renders nothing extra when there is no unassigned group', async () => {
    mkListFetch([
      {
        slug: 'test',
        name: 'test',
        lifecycle: 'operate',
        health: 'ok',
        instances: [{ ...inst(), workload_assignment: 'ok' }],
        functions: [],
      },
    ])
    renderListPage()

    await screen.findByText('test')
    expect(screen.queryByText('About the Unassigned group')).toBeNull()
  })
})

describe('bounds are universal, including the fallback panel (GATE-S1-RV)', () => {
  it('does not poll the legacy aggregate while the tab is hidden', async () => {
    // The live_view=false fallback was the last unbounded 200ms poller. It
    // now takes the same hidden-tab pause as every other preview surface.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    vi.useFakeTimers()
    const h = mkFetch({ instances: [inst({ instance: 'mxl-a', live_view: false })] })
    renderOperatePage()
    await settle()
    await settle(STATUS_POLL_MS * 3)

    const tile = screen.getAllByText('MXL Video Test View')[0].closest('[role="button"]')!
    fireEvent.click(tile)
    await settle(1000)

    expect(h.counters.aggregateStatus).toBe(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })
})
