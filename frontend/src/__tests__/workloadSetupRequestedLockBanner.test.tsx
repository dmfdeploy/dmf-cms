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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

// dmfdeploy#405 FIX ROUND: this file's own name and the "isn't open yet"
// phrase inside this describe title are now history, not current fact — the
// banner itself is gone (P8, de1b94d; see the second test's own comment for
// the full account). A title that states a falsehood is worse than a broken
// blame trail, so the title says what is actually under test: dmfdeploy#416's
// root cause (the LATCHED-vs-LIVE distinction) still lives here, and both
// tests are repurposed to pin the REPLACEMENT guarantee — the operator gets
// the reason, AT the step they asked for, and a background poll of unchanged
// data never disturbs an already-mounted, already-open panel — rather than
// deleted.
describe('dmfdeploy#416: the requested-lock reason reaches the operator (the "isn\'t open yet" banner it used to ride is gone)', () => {
  it('DISCRIMINATOR: the mounted Finalise & Review panel never switches to its LOCKED branch while a background poll is in flight and the latched classification says it is still open', async () => {
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

    // FIX ROUND: re-derive the panel by role+name EVERY time, never cache a
    // node reference and re-read only its attribute. A captured reference
    // stays live even if a regression bounces the wizard's selection to a
    // DIFFERENT step — React reconciles the SAME DOM position to render
    // whatever is now selected there, so a cached `panel.getAttribute(...)`
    // would keep reading truthfully about a node that no longer represents
    // Finalise at all, and every assertion below would pass while the
    // operator was silently evicted from the step they asked for — exactly
    // the property this test exists to protect. `getByRole('heading', {
    // name: 'Finalise & Review' })` THROWS if that heading is not the one
    // currently mounted, which is what actually proves identity; the rail
    // check that used to sit beside this (`getByRole('button', { name:
    // 'Finalise & Review' })`) proved nothing on its own either — #405 gives
    // a LOCKED key that identical button role and name, so its mere
    // presence no longer means open. Both replaced with the finding function
    // below plus an explicit rail-description check.
    function finalisePanel(): HTMLElement {
      const heading = screen.getByRole('heading', { name: 'Finalise & Review', level: 2 })
      return heading.closest('[data-step-state]') as HTMLElement
    }
    function railFinaliseNotLocked(): void {
      const chipEl = within(rail()).getByRole('button', { name: 'Finalise & Review' })
      expect(within(chipEl).queryByText(/nothing to tear down/)).toBeNull()
    }

    // Sanity, at the settled baseline: the hash-requested step is the one
    // mounted, in its OPEN branch (not locked), and the rail's own chip
    // agrees (its description does not name the lock reason).
    expect(finalisePanel().getAttribute('data-step-state')).toBe('open')
    expect(within(finalisePanel()).queryByText(/nothing to tear down/)).toBeNull()
    railFinaliseNotLocked()

    // Drive the identical react-query state transition production's real
    // useMediaWorkloadsGrouped 15000ms refetchInterval triggers on a timer —
    // deterministic and controllable rather than a wall-clock wait.
    const callsBefore = h.calls.grouped
    void queryClient.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    await waitFor(() => expect(h.calls.grouped).toBeGreaterThan(callsBefore))

    // Mid-poll: groupedRead.isFetching is true, so the LIVE classification
    // of `finalise` drops to `locked` — while the LATCHED (displaySteps)
    // classification, which is what FlowStep's own `state` prop actually
    // reads, still says open (umbrella #392). THE DISCRIMINATING ASSERTION:
    // the mounted panel must still BE Finalise & Review's own heading (not a
    // bounce to Provision, the backend position — `getByRole` above throws
    // if it is not), its data-step-state must stay 'open', and FlowStep must
    // never switch to its LOCKED branch and print lock prose over an
    // already-mounted step the operator is reviewing, for the duration of a
    // poll that has told them nothing new. (FinaliseStage's OWN internal
    // purge-control gating is a SEPARATE, deliberate fact — see
    // workloadSetup.test.tsx's own #378b identity-refetch test for why that
    // one legitimately DOES react to the live, unsettled read — this
    // assertion is scoped to the WRAPPER's branch, not the stage's own
    // action visibility.)
    expect(finalisePanel().getAttribute('data-step-state')).toBe('open')
    expect(within(finalisePanel()).queryByText(/nothing to tear down/)).toBeNull()

    releaseGrouped()
    await waitFor(() =>
      expect(queryClient.getQueryState(['media-workloads-grouped'])?.fetchStatus).toBe('idle'),
    )
    expect(finalisePanel().getAttribute('data-step-state')).toBe('open')
    railFinaliseNotLocked()
  })

  // dmfdeploy#405 FIX ROUND: this used to be the positive control proving
  // the #392/#416 fix above could not be satisfied by suppressing the
  // banner outright — a genuinely, durably locked step (no unsettled read
  // involved at all) still had to show SOMETHING. de1b94d then deleted the
  // banner itself: WorkloadSetup.tsx's own comment says why — "the operator
  // lands ON Configure and FlowStep mounts that same locked reason as the
  // panel's own body. Keeping the banner would have printed the reason
  // twice on one screen, one of them in an amber alert about a thing that
  // just succeeded." This test now pins THAT replacement guarantee instead
  // of the deleted banner: the reason still gets to the operator, at the
  // step they asked for, exactly once.
  it('still mounts the reason prose for a genuinely locked step once the read has settled — no separate banner', async () => {
    mkFetch({ workload: workload({ lifecycle: 'provision' }) })
    renderDetail('#configure')
    await findRail()

    // dmfdeploy#405: the hash target is honoured whatever its lock state
    // (WorkloadSetup.tsx's `defaultSelection`) — the wizard selects AND
    // focuses Configure itself, never falling back to the backend position.
    const configureHeading = await screen.findByRole('heading', { name: 'Configure', level: 2 })
    const panel = configureHeading.closest('[data-step-state]') as HTMLElement
    expect(panel.getAttribute('data-step-state')).toBe('locked')
    expect(document.activeElement).toBe(panel)

    // The exact reason the banner used to carry now renders as Configure's
    // own body (FlowStep.tsx's locked branch, P5) — same text, one home
    // instead of two.
    expect(within(panel).getByText(
      'Nothing is running for this workload yet, so there is no source to select. This step opens once Provision has deployed it.',
    )).toBeTruthy()
    // Defense-in-depth, not independent proof: this file's mkFetch returns
    // an empty catalog and an empty body for any topology read, so
    // ConfigureStage would decline to render "Switch source" on its own
    // account regardless of lock state — the reason-prose assertion above
    // is what actually discriminates locked from open here.
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()
  })
})
