/**
 * WorkloadHome — the live grid, its tiles, and its modal must SURVIVE a
 * background refetch, and must do so HONESTLY (umbrella dmfdeploy#432 §A,
 * fix round on the blocked first attempt).
 *
 * WHAT A PLAIN RENDER TEST CANNOT PROVE, AND WHY THIS FILE IS SHAPED THE WAY
 * IT IS.
 *
 * `membersDataRetained` (workloadLifecycle.ts) — not the stricter,
 * isFetching-folding `membersDataTrustworthy` — is what `classifyHomeState`
 * gates on since this fix round, precisely so an in-flight background poll
 * of an UNCHANGED, error-free payload is not treated as a semantic change
 * (UX Constitution §3 hard gate #5). A test that only asserts "the grid is
 * present after the refetch" would pass against the ORIGINAL blocked code
 * too, because a remounted grid is also present. Every identity assertion
 * below instead holds a reference to a DOM node (or reads react-query's own
 * `isFetching` count directly, never a UI flicker) and requires the SAME
 * node/behaviour across the boundary a remount or a re-classification would
 * disturb.
 *
 * The first attempt at this fix only proved ONE narrow invariant — the
 * `<section aria-label="Live view">` node surviving an in-flight refetch —
 * on a `live_view:false` fixture, so it created no preview `<img>`, no
 * cache-buster, and no openable modal: it could not prove the production
 * symptom (#432 §A: "preview <img> lost element identity, ?t=5 -> ?t=1").
 * This file adds exactly those missing proofs, plus the transitions the
 * fix-round work order named: a failed background refetch, setup staying
 * setup (never flashing "Live view") through a GENUINE transition to
 * unresolved, trustworthy partial bring-up, a degraded FIRST response, and
 * deletion of the instance behind an open modal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadHome from '../pages/MediaWorkloads/WorkloadHome'
import type { CatalogEntry, MediaWorkload, MediaWorkloadInstance } from '../api/types'
import { PREVIEW_TICK_MS } from '../pages/MediaWorkloads/liveView'

const AMBIGUOUS_NOTICE = /status isn't clear enough right now/i
const FAILED_NOTICE = /could not be loaded right now\. Retrying automatically/i

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: 'Routes media flows between sources and viewers.',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'active',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint',
    finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [],
    ingress_url: null,
    provision_demand: null,
    ...overrides,
  }
}

function instance(overrides: Partial<MediaWorkloadInstance> = {}): MediaWorkloadInstance & {
  workload_assignment: string
} {
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

// A function_key starting `mxl` is what makes WorkloadTile's tile openable
// (isMxl, LivePreviewBox.tsx) — the modal/preview tests below need this, not
// merely `live_view: true`.
function mxlInstance(overrides: Partial<MediaWorkloadInstance> = {}): MediaWorkloadInstance & {
  workload_assignment: string
} {
  return instance({
    instance: 'mxl-crosspoint-1',
    function_key: 'mxl-crosspoint',
    live_view: true,
    ...overrides,
  })
}

function workload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'operate',
    health: 'ok',
    instances: [instance()],
    functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
    ...overrides,
  }
}

const AVAILABLE_MXL_STATUS = {
  available: true,
  role: 'receiver',
  provider: 'aliyun',
  preview: true,
  mxl_version: '1.2.3',
  flow: { head_index: 1, latency_ms: 1, latency_grains: 1, active: true, format: 'Video', grain_rate: '50/1' },
}

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/studio-a']}>
        <Routes>
          <Route path="/media-workloads/:slug" element={<WorkloadHome />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The cache-buster tick out of a preview <img>'s `?t=N` src, or NaN. */
function tickOf(img: HTMLElement): number {
  const src = img.getAttribute('src') ?? ''
  const match = src.match(/[?&]t=(\d+)/)
  return match ? Number(match[1]) : NaN
}

/**
 * A gated grouped-inventory mock: reads after the first block on `gate`
 * until the test releases it, so `isFetching` stays true for the whole
 * window the assertions need it in, rather than for one microtask. Also
 * serves `/api/catalog` and (optionally) `/mxl/status`, since the preview
 * and modal tests below need a real MXL status read to hold a preview open.
 */
function gatedFetch({
  workloads,
  catalog = [catalogEntry()],
  mxlStatus = AVAILABLE_MXL_STATUS,
}: {
  workloads: MediaWorkload[]
  catalog?: CatalogEntry[]
  mxlStatus?: unknown
}) {
  let releaseGate: () => void = () => {}
  let gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  let held = false
  let groupedCalls = 0

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/catalog')) return json({ entries: catalog })
    if (url.endsWith('/api/media-workloads/grouped')) {
      groupedCalls += 1
      if (groupedCalls > 1 && held) await gate
      return json({
        configured: true,
        degraded: false,
        scope: [],
        workloads,
        invalid_instances: [],
      })
    }
    if (url.includes('/mxl/status')) return json({ instance: 'mxl-crosspoint-1', ...(mxlStatus as object) })
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    /** Arms the gate so the NEXT grouped read (call #2 onward) blocks. */
    armGate: () => {
      held = true
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
    },
    release: () => releaseGate(),
  }
}

// ---------------------------------------------------------------------------
// item 3: the amber flicker itself — an ordinary background poll of
// unchanged, trustworthy data must not read as 'unresolved' at all.
// ---------------------------------------------------------------------------

describe('an ordinary background poll of unchanged, trustworthy data (item 3)', () => {
  it('mounts no amber notice, and the live-view section survives as the SAME node', async () => {
    const { armGate, release } = gatedFetch({ workloads: [workload()] })
    const queryClient = renderHome()

    const before = await screen.findByRole('region', { name: 'Live view' })

    armGate()
    void queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBeGreaterThan(0),
    )

    // THE fix-round assertion: unlike the pre-fix code, an in-flight poll of
    // unchanged data must not read as 'unresolved' — neither notice mounts.
    expect(screen.queryByText(AMBIGUOUS_NOTICE)).toBeNull()
    expect(screen.queryByText(FAILED_NOTICE)).toBeNull()
    expect(screen.getByRole('region', { name: 'Live view' })).toBe(before)

    release()
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBe(0))
    expect(screen.getByRole('region', { name: 'Live view' })).toBe(before)
  })

  it('keeps every homeState==="live" sibling mounted as the SAME node — intro paragraph, Active source, Configure link', async () => {
    const wl = workload({
      instances: [instance({ instance: 'viewer-1', function_key: 'viewer' })],
      functions: [{ function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 }],
    })
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let groupedCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) {
          return json({ entries: [catalogEntry({ key: 'viewer', display_name: 'MXL Viewer' })] })
        }
        if (url.endsWith('/api/media-workloads/grouped')) {
          groupedCalls += 1
          if (groupedCalls > 1) await gate
          return json({ configured: true, degraded: false, scope: [], workloads: [wl], invalid_instances: [] })
        }
        // Topology fixture so ActiveSourceSection actually mounts — same
        // shape as workloadHome.test.tsx's own freshTopology().
        if (url.match(/\/api\/media-workloads\/viewer-1\/topology$/)) {
          return json({
            receiver_instance: 'viewer-1',
            sources: [{ id: 'source-a', flow_id: 'f1', pattern: 'smpte' }],
            active_source: 'source-a',
            provenance: 'observed-flow',
            observed_at: new Date(0).toISOString(),
          })
        }
        return json({})
      }),
    )
    const queryClient = renderHome()

    const introBefore = await screen.findByText(/The monitoring surface for this workload/)
    const activeSourceBefore = await screen.findByRole('region', { name: 'Active source' })
    const configureLinkBefore = await screen.findByRole('link', { name: /Go to Configure/i })

    void queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBeGreaterThan(0),
    )

    // THE discriminating window: mid-fetch, before the gate is released.
    // These three must survive as the SAME nodes, and the ambiguous notice
    // must never mount, purely because of an in-flight poll of unchanged
    // data.
    expect(screen.getByText(/The monitoring surface for this workload/)).toBe(introBefore)
    expect(screen.getByRole('region', { name: 'Active source' })).toBe(activeSourceBefore)
    expect(screen.getByRole('link', { name: /Go to Configure/i })).toBe(configureLinkBefore)
    expect(screen.queryByText(AMBIGUOUS_NOTICE)).toBeNull()

    releaseGate()
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBe(0))
    expect(screen.getByText(/The monitoring surface for this workload/)).toBe(introBefore)
    expect(screen.getByRole('region', { name: 'Active source' })).toBe(activeSourceBefore)
    expect(screen.getByRole('link', { name: /Go to Configure/i })).toBe(configureLinkBefore)
  })
})

// ---------------------------------------------------------------------------
// item 6: the actual production symptom the first attempt's fixture
// (live_view:false) could not exercise — preview <img> identity/tick
// continuity, and modal identity, across an ordinary poll.
// ---------------------------------------------------------------------------

describe('the preview <img> and the modal survive an ordinary poll (item 6)', () => {
  it('preserves the preview <img> ELEMENT IDENTITY and its tick continuity across a background refetch', async () => {
    const { armGate, release } = gatedFetch({ workloads: [workload({ instances: [mxlInstance()] })] })
    const queryClient = renderHome()

    const img = await screen.findByAltText(/Live preview of/)
    // Wait for at least one real tick (PREVIEW_TICK_MS) so there is a
    // non-zero cache-buster to prove continuity against.
    await waitFor(() => expect(tickOf(img)).toBeGreaterThan(0), { timeout: PREVIEW_TICK_MS * 3 })
    const tickBefore = tickOf(img)

    armGate()
    void queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBeGreaterThan(0),
    )

    // THE discriminating assertion: the very same <img> node, not merely an
    // <img> with the same alt text (a remount would produce a structurally
    // identical but different node here).
    expect(screen.getByAltText(/Live preview of/)).toBe(img)

    // Continuity: the tick interval kept running rather than resetting to 0
    // — proven WHILE still mid-fetch, before the gate is released.
    await waitFor(() => expect(tickOf(img)).toBeGreaterThan(tickBefore), { timeout: PREVIEW_TICK_MS * 3 })

    release()
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBe(0))
    expect(screen.getByAltText(/Live preview of/)).toBe(img)
  })

  it('keeps the open modal mounted as the SAME node across a background refetch', async () => {
    const { armGate, release } = gatedFetch({ workloads: [workload({ instances: [mxlInstance()] })] })
    const queryClient = renderHome()

    const tile = await screen.findByTitle('Open the live preview + flow detail')
    fireEvent.click(tile)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).not.toMatch(/no longer part of the workload/i)

    armGate()
    void queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBeGreaterThan(0),
    )
    expect(screen.getByRole('dialog')).toBe(dialog)

    release()
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBe(0))
    // Reconciled against the fresh (still-present) instance on settle —
    // still the SAME dialog node, and still not marked unavailable.
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(dialog.textContent).not.toMatch(/no longer part of the workload/i)
  })
})

// ---------------------------------------------------------------------------
// item 2: a BACKGROUND refetch failure retains its data — render it with a
// notice, never blank the page the way a first-load failure correctly does.
// ---------------------------------------------------------------------------

describe('a failed background refetch retains its content (item 2)', () => {
  it('shows the retained grid alongside the failed-read notice instead of blanking the page', async () => {
    let groupedCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) {
          groupedCalls += 1
          if (groupedCalls > 1) return new Response('boom', { status: 500 })
          return json({ configured: true, degraded: false, scope: [], workloads: [workload()], invalid_instances: [] })
        }
        return json({})
      }),
    )
    const queryClient = renderHome()

    await screen.findByRole('region', { name: 'Live view' })
    expect(screen.getByRole('link', { name: /Go to Configure/i })).toBeTruthy()

    await queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })

    // The notice AND the retained tile both present — never the bare error
    // page this used to hard-return (that page has no "Live view" region at
    // all, so the region assertion below is what actually discriminates).
    await waitFor(() => expect(screen.getByText(FAILED_NOTICE)).toBeTruthy())
    expect(screen.getByRole('region', { name: 'Live view' })).toBeTruthy()
    expect(screen.getByText('crosspoint-1')).toBeTruthy()

    // Claims still withheld — a failed read is not a trustworthy one.
    expect(screen.queryByRole('link', { name: /Go to Configure/i })).toBeNull()
    expect(screen.queryByText(/The monitoring surface for this workload/)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// item 1: `anyMemberObservedRunning`, not raw membership, gates the grid —
// a setup workload must never flash "Live view", even on a GENUINE
// transition into 'unresolved' (not merely an in-flight poll, which item 3
// already keeps out of 'unresolved' entirely).
// ---------------------------------------------------------------------------

describe('setup never flashes "Live view", even on a genuine unresolved transition (item 1)', () => {
  it('a workload with bootstrapped, never-started instances stays gridless through a degraded read', async () => {
    const setupWorkload = workload({
      lifecycle: 'provision',
      instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
    })
    let groupedCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) {
          groupedCalls += 1
          return json({
            configured: true,
            degraded: groupedCalls > 1, // second-and-later reads: a REAL degradation
            scope: [],
            workloads: [setupWorkload],
            invalid_instances: [],
          })
        }
        return json({})
      }),
    )
    const queryClient = renderHome()

    await screen.findByRole('link', { name: 'Continue setup' })
    expect(screen.queryByRole('region', { name: 'Live view' })).toBeNull()

    await queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })

    // A genuine transition to 'unresolved' — the ambiguous notice appears —
    // and STILL no grid: nothing was ever observed running, so
    // anyMemberObservedRunning stays false throughout.
    await waitFor(() => expect(screen.getByText(AMBIGUOUS_NOTICE)).toBeTruthy())
    expect(screen.queryByRole('region', { name: 'Live view' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Continue setup' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// item 1 (other direction) + item 5: partial bring-up and a degraded FIRST
// response must show tiles when something is genuinely observed running —
// the corrected comment's claim ("a first response can be degraded:true
// WITH instances").
// ---------------------------------------------------------------------------

describe('the grid shows retained tiles whenever something is observed running, not only when homeState==="live" (item 1 / item 5)', () => {
  it('trustworthy partial bring-up (lifecycle=configure, some running, some not) shows tiles with the non-current heading', async () => {
    const partial = workload({
      lifecycle: 'configure',
      instances: [
        instance({ instance: 'a', observed_state: 'running' }),
        instance({ instance: 'b', requested_state: 'bootstrapped', observed_state: 'unknown' }),
      ],
      functions: [{ function_key: 'crosspoint', count: 2, running: 1, reconcile_pending: 0 }],
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) {
          return json({ configured: true, degraded: false, scope: [], workloads: [partial], invalid_instances: [] })
        }
        return json({})
      }),
    )
    renderHome()

    // Ambiguous per classifyHomeState (position short of Operate, yet
    // something already observed running) — the notice shows...
    await waitFor(() => expect(screen.getByText(AMBIGUOUS_NOTICE)).toBeTruthy())
    // ...and the tiles STILL show, both of them (§A's partial-bring-up
    // requirement), under the honest non-current heading (item 5).
    const region = await screen.findByRole('region', { name: 'Live view' })
    expect(screen.getByText('Live view — showing last known state')).toBeTruthy()
    expect(screen.getByText('a')).toBeTruthy()
    expect(screen.getByText('b')).toBeTruthy()
    void region
  })

  it('a degraded FIRST response with a running instance shows tiles — degraded does not mean empty', async () => {
    const degradedFirst = workload({ lifecycle: 'operate', instances: [instance()] })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) {
          return json({ configured: true, degraded: true, scope: [], workloads: [degradedFirst], invalid_instances: [] })
        }
        return json({})
      }),
    )
    renderHome()

    // degraded:true fails membersDataRetained regardless of lifecycle, so
    // this is 'unresolved' even though the position is 'operate' — never
    // 'live' on an incomplete read.
    await waitFor(() => expect(screen.getByText(AMBIGUOUS_NOTICE)).toBeTruthy())
    expect(await screen.findByRole('region', { name: 'Live view' })).toBeTruthy()
    expect(screen.getByText('crosspoint-1')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// item 4: the phantom modal — reconcile by id on a trustworthy settled
// read; preserve untouched during an in-flight or degraded one.
// ---------------------------------------------------------------------------

describe('the open modal reconciles against the current inventory (item 4)', () => {
  it('marks the modal unavailable once a trustworthy settled read confirms the instance is gone', async () => {
    let groupedCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) {
          groupedCalls += 1
          const wl = groupedCalls > 1 ? workload({ instances: [] }) : workload({ instances: [mxlInstance()] })
          return json({ configured: true, degraded: false, scope: [], workloads: [wl], invalid_instances: [] })
        }
        if (url.includes('/mxl/status')) return json({ instance: 'mxl-crosspoint-1', ...AVAILABLE_MXL_STATUS })
        return json({})
      }),
    )
    const queryClient = renderHome()

    const tile = await screen.findByTitle('Open the live preview + flow detail')
    fireEvent.click(tile)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).not.toMatch(/no longer part of the workload/i)

    // A genuine, settled, trustworthy read — no longer includes the instance.
    await queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })

    await waitFor(() => expect(screen.getByRole('dialog').textContent).toMatch(/no longer part of the workload/i))
    // Still the SAME dialog node — this is a state change, not a remount —
    // and the header still names the last-known instance.
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByRole('dialog').textContent).toMatch(/mxl-crosspoint-1/)
  })

  it('preserves the modal untouched (not reconciled, not marked gone) while a settled read is DEGRADED', async () => {
    let groupedCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) {
          groupedCalls += 1
          // Second read: settled (not in flight), but DEGRADED — and
          // happens to omit the instance too, which would look like a
          // deletion if the reconciliation effect wrongly ignored
          // `membersDataTrustworthy` and fired anyway.
          const wl = groupedCalls > 1 ? workload({ instances: [] }) : workload({ instances: [mxlInstance()] })
          return json({
            configured: true,
            degraded: groupedCalls > 1,
            scope: [],
            workloads: [wl],
            invalid_instances: [],
          })
        }
        if (url.includes('/mxl/status')) return json({ instance: 'mxl-crosspoint-1', ...AVAILABLE_MXL_STATUS })
        return json({})
      }),
    )
    const queryClient = renderHome()

    const tile = await screen.findByTitle('Open the live preview + flow detail')
    fireEvent.click(tile)
    const dialog = await screen.findByRole('dialog')

    await queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBe(0))
    // The settle above only proves the QUERY resolved — asserting a NEGATIVE
    // (nothing changed) needs a real dwell afterward too, or a wrongly-
    // triggered reconciliation whose OWN downstream setState/re-render
    // hasn't landed yet would pass this assertion by sheer timing, not by
    // being correct. `waitFor` can't help here (it stops at the FIRST
    // passing check, which the racing case still is).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    // The read settled, but degraded:true means membersDataTrustworthy is
    // still false — the reconciliation effect must not have fired.
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByRole('dialog').textContent).not.toMatch(/no longer part of the workload/i)
  })
})

// ---------------------------------------------------------------------------
// gate round 3: `membersDataRetained` lets homeState stay 'live'/'setup'
// through an in-flight background poll, which is CORRECT (case (a) — the
// last settled read is sound; a poll in flight over unchanged, error-free
// data is not a semantic change). What round 2's own code and comments got
// wrong was describing this as "claims do not persist" — they do, for
// exactly this case. These two tests lock in the specific residue named by
// the gate: the "Live view" heading must not qualify to "showing last known
// state" merely because a poll is in flight, and the setup CTA must survive
// one too (the previous round's own "every live sibling persists" test only
// exercised homeState==='live', never 'setup', and checked the SECTION's
// static aria-label, never the <h2> TEXT that actually varies).
//
// NOT discriminating against the current tree — homeState already stays
// 'live'/'setup' through an in-flight poll as of the prior round, so these
// already pass. They exist to (a) close a real coverage gap named by the
// gate and (b) guard against the EXACT wrong fix the gate explicitly
// forbade (mechanically re-gating any of this on the stricter
// `membersDataTrustworthy`, which would reintroduce the flicker). See the
// mutation-test note on the first of the two below for the discriminating
// proof against that specific, real risk.
// ---------------------------------------------------------------------------

describe('claims gated on homeState persist through an in-flight poll too, not only "content" (gate round 3)', () => {
  it('the "Live view" heading stays UNQUALIFIED through an in-flight poll of retained, good live data', async () => {
    const { armGate, release } = gatedFetch({ workloads: [workload()] })
    const queryClient = renderHome()

    await screen.findByText('Live view')
    expect(screen.queryByText('Live view — showing last known state')).toBeNull()

    armGate()
    void queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBeGreaterThan(0),
    )

    // THE assertion gate round 3 named: homeStateIsLive (and therefore the
    // heading's wording) must not flip merely because this read is in
    // flight — only a GENUINE transition (error/degraded/position change)
    // may qualify it. Mutation-tested: swapping `homeStateIsLive`'s
    // definition from `homeState === 'live'` to
    // `input.membersDataTrustworthy === true` (the exact "mechanically
    // re-gate on strict" fix the gate forbids) makes this assertion fail —
    // `screen.queryByText('Live view')` returns null and the qualified text
    // appears instead, mid-poll, on perfectly good data.
    expect(screen.getByText('Live view')).toBeTruthy()
    expect(screen.queryByText('Live view — showing last known state')).toBeNull()

    release()
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBe(0))
    expect(screen.getByText('Live view')).toBeTruthy()
  })

  it('the setup CTA ("Continue setup") persists as the SAME node through an in-flight poll of retained, good setup data', async () => {
    const setupWorkload = workload({
      lifecycle: 'provision',
      instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
    })
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let groupedCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) {
          groupedCalls += 1
          if (groupedCalls > 1) await gate
          return json({
            configured: true,
            degraded: false,
            scope: [],
            workloads: [setupWorkload],
            invalid_instances: [],
          })
        }
        return json({})
      }),
    )
    const queryClient = renderHome()

    const ctaBefore = await screen.findByRole('link', { name: 'Continue setup' })
    const copyBefore = screen.getByText(/isn't running yet/i)

    void queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBeGreaterThan(0),
    )

    // Mid-poll: the CTA and its copy must survive as the SAME nodes, and
    // neither notice must mount — this is 'setup' data, unchanged and
    // error-free, exactly the case (a) the gate's design call describes.
    expect(screen.getByRole('link', { name: 'Continue setup' })).toBe(ctaBefore)
    expect(screen.getByText(/isn't running yet/i)).toBe(copyBefore)
    expect(screen.queryByText(AMBIGUOUS_NOTICE)).toBeNull()

    releaseGate()
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ['media-workloads-grouped'] })).toBe(0))
    expect(screen.getByRole('link', { name: 'Continue setup' })).toBe(ctaBefore)
  })
})
