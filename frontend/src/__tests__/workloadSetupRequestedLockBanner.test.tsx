/**
 * dmfdeploy#416: the "isn't open yet" banner (WorkloadSetup.tsx's
 * `requestedIsLocked`) must not assert a step is locked while the grouped
 * read is mid-poll and the LATCHED classification says it is open.
 *
 * Root cause: every other consumer of the flow's per-step classification on
 * this page reads `displaySteps` — the value `settledStepsRef` latches
 * while `dataUnsettled` (groupedRead.isFetching || userQuery.isFetching) is
 * true, specifically so a background poll's transient dip can't be
 * presented as a durable fact (umbrella dmfdeploy#392 fixed this for
 * selection/mounting). `requestedIsLocked` read the LIVE `steps` value
 * instead — the one holdout — so during each background poll of the
 * grouped inventory it could assert a step is closed while it is open, and
 * announce that (role="status" aria-live="polite") to assistive tech.
 *
 * Harness copied from workloadSetup.test.tsx (MSW-free, a fresh react-query
 * QueryClient per render, fetch stubbed via vi.stubGlobal) — same
 * convention every other dedicated workloadSetup*.test.tsx file follows:
 * each defines its own local fixtures rather than importing another test
 * file's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import type { MediaWorkload, MediaWorkloadInstance, MediaWorkloadsGroupedResponse, UserIdentity } from '../api/types'

// ---- fixtures ---------------------------------------------------------

function instance(
  overrides: Partial<MediaWorkloadInstance> = {},
): MediaWorkloadInstance & { workload_assignment: string } {
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
    lifecycle: 'provision',
    health: 'ok',
    instances: [instance()],
    functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
    ...overrides,
  }
}

// The exact shape workloadSetup.test.tsx's own #378/#392 gates use:
// finalise is delete-permanently-eligible on member state alone — every
// member bootstrapped (nothing cleared to run), none observed running.
// stageActions('finalise', input) is the ONLY thing that makes finalise
// `open` here, and it is the one branch that fails closed on
// groupedRead.isFetching/userQuery.isFetching (via membersDataTrustworthy/
// purgeAuthorized) — exactly the mechanism this bug needs to reproduce.
function purgeEligibleWorkload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return workload({
    lifecycle: 'provision',
    instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })],
    ...overrides,
  })
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface FetchOpts {
  workload: MediaWorkload
  user?: Partial<UserIdentity>
  /** Gate grouped reads after the Nth call — lets the initial load settle
   *  normally and holds only a later, explicitly-triggered refetch. */
  groupedDelayAfter?: number
  groupedGate?: Promise<unknown>
}

function mkFetch(opts: FetchOpts) {
  const wl = opts.workload
  const groupedResponse: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    get workloads() { return [wl] },
    invalid_instances: [],
  }
  const calls = { grouped: 0 }

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()

    if (url.endsWith('/api/me')) {
      return json({
        subject: 'ops',
        display_name: 'Ops',
        email: 'ops@dmf.example.com',
        role: 'operator',
        real_role: 'operator',
        view_as_active: false,
        groups: [],
        awx_configured: true,
        authentik_configured: true,
        ...opts.user,
      })
    }
    if (url.endsWith('/api/catalog')) return json({ entries: [] })
    if (url.endsWith('/api/media-workloads/grouped')) {
      calls.grouped += 1
      if (opts.groupedGate && opts.groupedDelayAfter != null && calls.grouped > opts.groupedDelayAfter) {
        await opts.groupedGate
      }
      return json(groupedResponse)
    }
    if (url.endsWith('/api/facility/summary')) {
      return json({ site_count: 1, device_count: 0, sites: [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }] })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

function renderDetail(hash: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/media-workloads/studio-a/setup${hash}`]}>
        <Routes>
          <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

async function findRail(): Promise<HTMLElement> {
  return screen.findByRole('navigation', { name: 'Media workload lifecycle' })
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Media workload lifecycle' })
}

/** The banner under test: role="status" aria-live="polite", "<Step> isn't
 *  open yet: <reason>". Queried by its role, not just text, so a future
 *  regression that drops the aria-live wiring is also caught — the ONLY
 *  role="status" element either fixture below can ever render (ViewLiveExit
 *  and LifecycleStrip's own role="status" notes are both gated on
 *  jobInFlight, which neither test ever sets). */
function lockBanner(): HTMLElement | null {
  return screen.queryByRole('status')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

describe('the "isn\'t open yet" banner (dmfdeploy#416)', () => {
  it('DISCRIMINATOR: stays absent while a background poll is in flight and the latched classification says the requested step is open', async () => {
    let releaseGrouped: () => void = () => {}
    const eligible = purgeEligibleWorkload()
    const h = mkFetch({
      workload: eligible,
      // Only the SECOND-and-later grouped read (the simulated background
      // poll) hangs — the initial load must resolve normally, and settle
      // BEFORE the poll under test, so finalise's LATCHED classification is
      // genuinely open going into it.
      groupedDelayAfter: 1,
      groupedGate: new Promise((r) => { releaseGrouped = () => r(null) }),
    })
    const queryClient = renderDetail('#finalise')
    await findRail()

    // Wait for BOTH queries this page reads (groupedRead + userRead, via
    // useCurrentUser) to reach their initial settled state — dataUnsettled
    // is the OR of both, and userQuery's own first fetch can still be in
    // flight for a render or two after the rail first appears. Settling
    // both here isolates the poll under test to the grouped query alone,
    // rather than conflating it with this unrelated startup race.
    await waitFor(() => expect(queryClient.getQueryState(['user'])?.fetchStatus).toBe('idle'))
    await waitFor(() => expect(queryClient.getQueryState(['media-workloads-grouped'])?.fetchStatus).toBe('idle'))

    // Sanity, at the settled baseline: finalise is genuinely open (the rail
    // — itself deliberately live, GATE-378b's own test — shows its
    // button), and the hash-requested step being open draws no banner.
    expect(within(rail()).getByRole('button', { name: 'Finalise & Review' })).toBeTruthy()
    expect(lockBanner()).toBeNull()

    // Drive the identical react-query state transition production's real
    // useMediaWorkloadsGrouped 15000ms refetchInterval triggers on a timer —
    // deterministic and controllable rather than a wall-clock wait.
    const callsBefore = h.calls.grouped
    void queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    await waitFor(() => expect(h.calls.grouped).toBeGreaterThan(callsBefore))

    // Mid-poll: groupedRead.isFetching is true, so membersDataTrustworthy
    // (and therefore stageActions('finalise')'s delete-permanently branch)
    // fails closed and the LIVE classification of `finalise` drops to
    // `locked` — while the LATCHED (displaySteps) classification says it is
    // still open, because nothing about the workload itself changed.
    // THE DISCRIMINATING ASSERTION — must fail against current `main`,
    // where requestedIsLocked reads the live `steps` value directly.
    expect(lockBanner()).toBeNull()

    releaseGrouped()
    await waitFor(() =>
      expect(queryClient.getQueryState(['media-workloads-grouped'])?.fetchStatus).toBe('idle'),
    )
    expect(lockBanner()).toBeNull()
    expect(within(rail()).getByRole('button', { name: 'Finalise & Review' })).toBeTruthy()
  })

  it('still renders for a genuinely locked step once the read has settled', async () => {
    // No unsettled read involved at all: lifecycle=provision, nothing
    // running, so `configure` is genuinely, durably locked — the positive
    // control proving the fix cannot be satisfied by suppressing the banner
    // outright.
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail('#configure')
    await findRail()

    await waitFor(() => expect(lockBanner()).not.toBeNull())
    expect(lockBanner()!.textContent).toBe(
      "Configure isn't open yet: Nothing is running for this workload yet, so there is no source to select. This step opens once Provision has deployed it.",
    )
    // The requested step was never selected — defaultSelection's
    // isStepOpenable guard already keeps a locked step off the wizard's own
    // selection, unaffected by this fix.
    expect(screen.queryByRole('heading', { name: 'Configure', level: 2 })).toBeNull()
  })
})
