/**
 * Operate's own monitoring route (umbrella #285, operator direction
 * 2026-08-01: "Operate leaves this page entirely").
 *
 * What this file has to prove, beyond "it renders": the live view and the
 * requested/observed pair survive the relocation off WorkloadDetail intact
 * (same tile, same badges, same titles — Art. 1's provenance distinction is
 * not allowed to blur in the move); Active Source is genuinely conditional
 * per instance, never an empty box for a producer with no topology; the
 * "Request a configuration change" affordance is a real navigation, never a
 * mutation wearing a link's clothes; and its copy never drifts into
 * wording that reads as this page controlling the flow live. The last one
 * is the point of the whole item, per the work order, so it gets its own
 * scoped guard rather than riding along inside a snapshot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadOperate from '../pages/MediaWorkloads/Operate'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import { REQUESTED_TITLE, OBSERVED_TITLE } from '../pages/MediaWorkloads/stateBadges'
import type { CatalogEntry, MediaWorkload, MediaWorkloadInstance, UserIdentity } from '../api/types'

// ---- fixtures (same shapes as workloadDetail.test.tsx) -----------------

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

function freshTopology(overrides: Record<string, unknown> = {}) {
  return {
    receiver_instance: 'viewer-1',
    sources: [
      { id: 'source-a', flow_id: 'f1', pattern: 'smpte' },
      { id: 'source-b', flow_id: 'f2', pattern: 'ball' },
    ],
    active_source: 'source-a',
    provenance: 'observed-flow',
    observed_at: new Date().toISOString(),
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
  workload?: MediaWorkload | null
  configured?: boolean
  degraded?: boolean
  errorStatus?: number
  catalog?: CatalogEntry[]
  /** Keyed by instance id. Absent => the endpoint 404s (no topology). */
  topology?: Record<string, unknown>
  /** Keyed by instance id: after this many successful topology reads for that instance, subsequent reads 500 — models a refetch that fails after an initial success, with react-query retaining the stale payload (mirrors planCapacity.test.tsx's facilityDetailFailAfter). */
  topologyFailAfter?: Record<string, number>
  /** After this many grouped-inventory reads, subsequent reads return `workload` instead of the base fixture — models an inventory change observed on a later poll/refetch (same after-N-reads shape as topologyFailAfter). */
  workloadAfter?: { reads: number; workload: MediaWorkload | null }
  /** After this many grouped-inventory reads, subsequent reads 500 — models a BACKGROUND refetch that fails after an initial success, with react-query retaining the stale `data` alongside the new `error` (same after-N-reads shape as topologyFailAfter; PR #90 review, dmf-cms#391 header-rail regression coverage). */
  groupedFailAfter?: number
  /** FIX ROUND P2-3: /api/me response — defaults to a bare {} (no role),
   *  which isPurgeAuthorized fails closed on, matching every pre-fix-round
   *  test in this file (they never exercised delete-permanently). Override
   *  to prove Operate's rail now reads purge-eligibility consistently with
   *  WorkloadDetail's. */
  user?: UserIdentity
}

function mkFetch(opts: FetchOpts = {}) {
  const wl = opts.workload === undefined ? workload() : opts.workload
  const catalog = opts.catalog ?? [catalogEntry()]
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const topologyCalls: Record<string, number> = {}
  let groupedCalls = 0

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    calls.push({ url, init })

    if (opts.errorStatus) {
      return json({ error: 'boom' }, opts.errorStatus)
    }
    if (opts.user && url.endsWith('/api/me')) return json(opts.user)
    if (url.endsWith('/api/catalog')) return json({ entries: catalog })
    if (url.endsWith('/api/media-workloads/grouped')) {
      groupedCalls += 1
      if (opts.groupedFailAfter != null && groupedCalls > opts.groupedFailAfter) {
        return json({ error: 'boom' }, 500)
      }
      const current =
        opts.workloadAfter && groupedCalls > opts.workloadAfter.reads ? opts.workloadAfter.workload : wl
      return json({
        configured: opts.configured ?? true,
        degraded: opts.degraded ?? false,
        scope: [],
        workloads: current ? [current] : [],
        invalid_instances: [],
      })
    }
    const topoMatch = url.match(/\/api\/media-workloads\/([^/]+)\/topology$/)
    if (topoMatch) {
      const name = decodeURIComponent(topoMatch[1])
      topologyCalls[name] = (topologyCalls[name] ?? 0) + 1
      const failAfter = opts.topologyFailAfter?.[name]
      if (failAfter != null && topologyCalls[name] > failAfter) {
        return json({ error: 'boom' }, 500)
      }
      const body = opts.topology?.[name]
      // No fixture for this instance: the real endpoint 404s for a receiver
      // with no topology (the common case — most instances are producers).
      if (!body) return json({ error: 'not-found' }, 404)
      return json(body)
    }
    // Any other endpoint this page might touch (e.g. a live-view instance's
    // mxl/status poll) — no test here exercises live_view:true, so this is
    // never hit, but a stray call gets an honest empty body rather than an
    // unhandled-mock throw.
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

function renderOperate(slug = 'studio-a') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/media-workloads/${slug}/operate`]}>
        <Routes>
          <Route path="/media-workloads/:slug/operate" element={<WorkloadOperate />} />
        </Routes>
        {/* Test-only stand-in for Topbar's own header-slot rendering — see
            HeaderSlotProbe's own docstring. Existing tests in this file never
            queried the rail (they only assert on the page body), so this is
            a no-op for them; the FIX ROUND P2-3 tests below are the first
            to need it. */}
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // Returned so a test can force a genuine react-query refetch mid-flow
  // (createWorkload.test.tsx's same precedent); every other caller ignores it.
  return queryClient
}

// Scope to a labelled <section>, same technique workloadDetail.test.tsx uses
// via its own heading-based stageSection helper — robust regardless of how
// aria-label maps to an implicit role in this jsdom/RTL version.
function section(label: string): HTMLElement {
  return screen.getByRole('heading', { name: label, level: 2 }).closest('section') as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---- designed states ----------------------------------------------------

describe('designed states', () => {
  it('shows a loading state before the grouped inventory resolves', async () => {
    // Hold the grouped fetch open so the loading render is observable.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/media-workloads/grouped')) {
          await gate
          return json({ configured: true, degraded: false, scope: [], workloads: [workload()], invalid_instances: [] })
        }
        return json({ entries: [] })
      }),
    )
    renderOperate()
    expect(screen.getByText('Loading workload…')).toBeTruthy()
    release()
    await screen.findByText(/The monitoring surface for this workload/)
  })

  it('states the grouped inventory is unreachable, never a raw error', async () => {
    mkFetch({ errorStatus: 500 })
    renderOperate()
    expect(
      await screen.findByText(/This workload could not be loaded right now\. Retrying automatically\./),
    ).toBeTruthy()
  })

  it('states Media Workloads is not configured for this environment', async () => {
    mkFetch({ configured: false, workload: null })
    renderOperate()
    expect(await screen.findByText(/Media Workloads is not configured for this environment/)).toBeTruthy()
  })

  it('renders an honest not-found state for an unknown slug', async () => {
    mkFetch({ workload: null })
    renderOperate('does-not-exist')
    expect(await screen.findByText('Workload not found')).toBeTruthy()
    expect(screen.getByText(/No workload named "does-not-exist"/)).toBeTruthy()
    const back = screen.getByRole('link', { name: /Back to Media Workloads/ })
    expect(back.getAttribute('href')).toBe('/media-workloads')
  })

  it('renders the no-instances-yet state instead of an empty live view', async () => {
    mkFetch({ workload: workload({ instances: [], functions: [] }) })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)
    expect(await screen.findByText(/Nothing is running yet for this workload/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Live view' })).toBeNull()
  })
})

// ---- the live view + instance health ------------------------------------

describe('the live view', () => {
  it('renders the running workload\'s instance via the shared tile', async () => {
    mkFetch({ workload: workload() })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    const live = section('Live view')
    expect(within(live).getByText('MXL Crosspoint')).toBeTruthy()
    expect(within(live).getByText('crosspoint-1')).toBeTruthy()
  })

  it('renders the requested/observed pair with the intent-vs-observed distinction intact', async () => {
    mkFetch({ workload: workload() })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    const live = section('Live view')
    const requested = within(live).getByTitle(REQUESTED_TITLE)
    const observed = within(live).getByTitle(OBSERVED_TITLE)
    expect(requested.textContent).toBe('active')
    expect(observed.textContent).toBe('running')
  })
})

// ---- active source: conditional per instance -----------------------------

describe('active source', () => {
  it('renders sources and the active one when topology exists', async () => {
    const wl = workload({
      instances: [instance({ instance: 'viewer-1', function_key: 'viewer' })],
      functions: [{ function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 }],
    })
    mkFetch({
      workload: wl,
      catalog: [catalogEntry({ key: 'viewer', display_name: 'MXL Viewer' })],
      topology: { 'viewer-1': freshTopology() },
    })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    const active = await screen.findByRole('heading', { name: 'Active source' })
    const activeSection = active.closest('section') as HTMLElement
    expect(within(activeSection).getByText('source-a')).toBeTruthy()
    expect(within(activeSection).getByText('source-b (ball)')).toBeTruthy()
  })

  it('withdraws the stale row when a refetch fails after an earlier success', async () => {
    // The defect the operator caught on PR #66 (fix round 2, 2026-08-02):
    // InstanceActiveSource derived `has` from topology.data alone, so once
    // the first read succeeded, a later refetch failure left react-query's
    // retained previous payload looking exactly like a fresh, current one —
    // this route kept presenting a stale active source as current instead
    // of withdrawing a row it could no longer vouch for.
    const wl = workload({
      instances: [instance({ instance: 'viewer-1', function_key: 'viewer' })],
      functions: [{ function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 }],
    })
    mkFetch({
      workload: wl,
      catalog: [catalogEntry({ key: 'viewer', display_name: 'MXL Viewer' })],
      topology: { 'viewer-1': freshTopology() },
      topologyFailAfter: { 'viewer-1': 1 },
    })
    const queryClient = renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    const active = await screen.findByRole('heading', { name: 'Active source' })
    const activeSection = active.closest('section') as HTMLElement
    expect(within(activeSection).getByText('source-a')).toBeTruthy()

    // A genuine react-query refetch, not a hand-forced rerender: the same
    // path an invalidation-driven or window-focus refetch takes. The hook
    // has no refetchInterval (hooks.ts), so this is the mechanism the app
    // itself would use to notice the topology changed underneath it.
    await queryClient.invalidateQueries({ queryKey: ['media-workloads-topology', 'viewer-1'] })

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Active source' })).toBeNull())
    expect(screen.queryByText('source-a')).toBeNull()
    expect(screen.queryByText('source-b (ball)')).toBeNull()
  })

  it('unmounts the Active source panel when its only topology-bearing instance leaves the inventory', async () => {
    // The defect the operator caught on PR #66 (fix round 3, 2026-08-02):
    // ActiveSourceSection's hasTopology map is never pruned when an instance
    // leaves `instances` — the wrapper used to read the whole map, so a
    // departed instance's stale `true` kept outvoting every current row
    // (all resolved to null), leaving an empty "Active source" panel behind.
    const wl = workload({
      instances: [
        instance({ instance: 'viewer-1', function_key: 'viewer' }),
        instance({ instance: 'crosspoint-2', function_key: 'crosspoint', netbox_id: 2 }),
      ],
      functions: [
        { function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 },
        { function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 },
      ],
    })
    const wlAfter = workload({
      instances: [instance({ instance: 'crosspoint-2', function_key: 'crosspoint', netbox_id: 2 })],
      functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
    })
    mkFetch({
      workload: wl,
      catalog: [catalogEntry(), catalogEntry({ key: 'viewer', display_name: 'MXL Viewer' })],
      topology: { 'viewer-1': freshTopology() },
      workloadAfter: { reads: 1, workload: wlAfter },
    })
    const queryClient = renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    await screen.findByRole('heading', { name: 'Active source' })
    // The section itself (the aria-label="Active source" panel in
    // Operate.tsx) is a named region — assert on the region, not just its
    // heading, or a fix that hides/renames the heading while leaving the
    // section (and its empty panel chrome) mounted would still pass this
    // test.
    expect(screen.getByRole('region', { name: 'Active source' })).toBeTruthy()
    expect(screen.getByText('source-a')).toBeTruthy()
    expect(within(section('Live view')).getByText('crosspoint-2')).toBeTruthy()

    // A genuine react-query refetch of the grouped inventory — the same
    // path the 15s poll (useMediaWorkloadsGrouped, hooks.ts:347-353) takes.
    await queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Active source' })).toBeNull())
    expect(screen.queryByRole('heading', { name: 'Active source' })).toBeNull()
    expect(screen.queryByText('source-a')).toBeNull()
    // The remaining instance still renders — the route didn't collapse.
    expect(within(section('Live view')).getByText('crosspoint-2')).toBeTruthy()
  })

  it('renders nothing for this section when no instance has a topology', async () => {
    // Default fixture instance is a plain crosspoint producer — the
    // topology endpoint 404s for it (no `topology` fixture supplied).
    mkFetch({ workload: workload() })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    // Give the topology query a tick to resolve (it 404s quickly) before
    // asserting its absence, so this isn't just "hasn't rendered yet".
    await waitFor(() => expect(screen.queryByText('Loading workload…')).toBeNull())
    expect(screen.queryByRole('heading', { name: 'Active source' })).toBeNull()
  })
})

// ---- request configuration change: a link, never a mutation -------------

describe('request configuration change', () => {
  it('is a real navigation link to the flow\'s Configure step, not a button that posts', async () => {
    mkFetch({ workload: workload() })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    const request = section('Request a configuration change')
    const link = within(request).getByRole('link', { name: /Go to Configure/ })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/media-workloads/studio-a#configure')
    expect(within(request).queryAllByRole('button')).toHaveLength(0)
  })

  it('never issues a POST from this affordance', async () => {
    const { calls } = mkFetch({ workload: workload() })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)
    const posts = calls.filter((c) => c.init?.method === 'POST')
    expect(posts).toHaveLength(0)
  })

  it('copy guard: never reads as live flow control', async () => {
    mkFetch({ workload: workload() })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    const request = section('Request a configuration change')
    const text = (request.textContent ?? '').toLowerCase()
    for (const forbidden of ['switch now', 're-route', 'take', 'cut', 'live']) {
      expect(text.includes(forbidden), `"${forbidden}" must not appear in: ${text}`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// FIX ROUND (WP-3 spec B gate, P2-3): this route used to build its rail
// input with only lifecycle/hasBootstrappedMembers set, leaving
// allMembersBootstrapped/anyMemberObservedRunning/membersDataTrustworthy/
// purgeAuthorized/isPurgeableEntity all silently absent — read as
// false/withheld regardless of the real workload, so a purge-eligible
// workload could show Finalise & Review OPEN on WorkloadDetail and LOCKED
// here. Both routes now build through the same buildWorkloadLifecycleInput
// constructor; this proves the two routes agree, not just that each one
// individually renders something.
// ---------------------------------------------------------------------------

describe('FIX ROUND P2-3: the rail agrees with WorkloadDetail for a purge-eligible workload', () => {
  const OPERATOR: UserIdentity = {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'operator',
    real_role: 'operator',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
  }

  function purgeEligibleWorkload(): MediaWorkload {
    // Same shape workloadDetail.test.tsx's own purgeEligibleWorkload uses:
    // every member bootstrapped (nothing cleared to run), none observed
    // running.
    return workload({
      lifecycle: 'provision',
      instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
    })
  }

  it('does not lock Finalise & Review when the workload is purge-eligible and the operator is authorized', async () => {
    mkFetch({ workload: purgeEligibleWorkload(), user: OPERATOR })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    const strip = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    // A locked chip renders as an inert <div>, never a <button> — see
    // LifecycleStrip.tsx. Before this fix, a purge-eligible workload still
    // read as Finalise-locked here (allMembersBootstrapped/
    // anyMemberObservedRunning/membersDataTrustworthy/purgeAuthorized were
    // all silently absent), the same shape workloadDetail.test.tsx's own
    // "locked steps are always prose in the rail" pins as the WRONG state
    // for this workload.
    expect(
      within(strip).getByRole('button', { name: 'Finalise & Review' }),
      'Finalise & Review must be a real button (not-locked), same as WorkloadDetail reads this workload',
    ).toBeTruthy()
  })

  it('withholds it the same way WorkloadDetail does when the operator is not authorized', async () => {
    mkFetch({ workload: purgeEligibleWorkload(), user: { ...OPERATOR, role: 'viewer', real_role: 'viewer' } })
    renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    // stageActions('finalise', ...) has NO action to offer without
    // purgeAuthorized (running(input) is false for lifecycle: 'provision'),
    // so the chip reads as locked — the fail-closed default, not a missing
    // field silently producing the same visual result for the wrong reason.
    const strip = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    expect(within(strip).queryByLabelText('Finalise & Review')?.tagName).toBe('DIV')
  })
})

// ---------------------------------------------------------------------------
// PR #90 REVIEW (dmf-cms#391): the rail used to be registered from
// `workloadForRail` alone, with no reference to `error`/`configured` at all.
// React Query retains the prior successful `data` on a failed BACKGROUND
// refetch (isError/error flip while `data` stays populated — documented
// behaviour, proven elsewhere in this codebase: catalogHonesty.test.tsx,
// activityLaneHonesty.test.tsx), so a poll that failed after an earlier
// success left the Topbar showing a fully populated, running-count-bearing
// rail built from stale data while the body said the workload could not be
// loaded. The case that matters is exactly this one — isError true while
// `data` is still around — not the simpler "never loaded at all" case
// (already covered above by "states the grouped inventory is unreachable").
// ---------------------------------------------------------------------------

describe('the header rail during a failed background refetch (PR #90 review, dmf-cms#391)', () => {
  it('withdraws the rail from the Topbar when a background refetch fails with retained data', async () => {
    mkFetch({ workload: workload(), groupedFailAfter: 1 })
    const queryClient = renderOperate()
    await screen.findByText(/The monitoring surface for this workload/)

    // First (successful) read settles — the rail is present, with a real
    // running-count readout (the thing Pass 1 added and the thing that must
    // not survive into the error state below).
    const strip = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    expect(strip.textContent).toMatch(/1 of 1 running/)

    // A genuine react-query refetch — same mechanism the 15s poll
    // (useMediaWorkloadsGrouped, hooks.ts) and the "active source" tests
    // above use. The grouped endpoint now 500s, but react-query retains the
    // prior successful `data`: `error`/`isError` flip true while `data`
    // stays populated with the SAME workload the rail above was built from.
    await queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })

    await waitFor(() =>
      expect(
        screen.getByText(/This workload could not be loaded right now\. Retrying automatically\./),
      ).toBeTruthy(),
    )
    // THE ASSERTION THAT MATTERS: the rail is ABSENT from the Topbar, not
    // merely that the body shows the error — a naive `if (!data)` guard
    // would pass "body shows the error" while still leaving the stale rail
    // (and its stale running count) mounted, which is exactly the bug the
    // reviewer caught.
    expect(screen.queryByRole('navigation', { name: 'Media workload lifecycle' })).toBeNull()
  })
})
