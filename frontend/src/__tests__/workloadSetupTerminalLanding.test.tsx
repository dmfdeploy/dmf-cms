/**
 * dmfdeploy#418: where the guided flow sends the operator after a terminal
 * Finalise & Review action — Teardown or Delete permanently — completes.
 *
 * Renders the real <App/> (real Topbar/Shell, real cross-route routing),
 * the same pattern railRouteContract.test.tsx already established for
 * exactly this reason: the behaviour under test IS a route change, which a
 * single-route render (every other workloadSetup*.test.tsx file's own
 * pattern) cannot observe at all.
 *
 * THE BUG THIS GUARDS (Teardown). Traced to source in the issue's own third
 * comment, not assumed: once the teardown job's busy window closes, the
 * backend lifecycle has already moved to `provision`, but in the window
 * before every member's own tag has caught up, stageActions('finalise') is
 * momentarily empty in a SETTLED (not merely unsettled) read — no
 * tear-down (lifecycle moved off configure/operate), no delete-permanently
 * (not every member is bootstrapped yet). classifyWorkloadFlow's ladder
 * then falls through to `locked`, WorkloadSetup's step-recovery effect
 * fires, and defaultSelection's fallback lands on `current` — Provision.
 * This is NOT dmfdeploy#416's mechanism (a transiently-UNSETTLED read) —
 * the classifier is behaving correctly throughout, on real, settled data —
 * so the fixture below reproduces that settled transition explicitly
 * rather than gesturing at "some transient state".
 *
 * THE FIX moves the navigation seam earlier: FinaliseStage's own
 * teardown-completion handler now leaves for the workload's home
 * synchronously, in the SAME handler that fires the grouped-inventory
 * invalidation — so the route change (and WorkloadWizard's own unmount,
 * recovery ladder included) commits before that invalidation's network
 * round-trip can ever land the settled read the ladder would act on. This
 * test proves the OUTCOME (no Provision bounce, honest states along the
 * way), not that internal mechanism.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import App from '../App'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse, UserIdentity } from '../api/types'

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'operator',
    real_role: 'operator',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
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
    ...overrides,
  }
}

// The workload BEFORE teardown: operating (offFlow), one running member —
// tear-down is offered, and Finalise & Review is the default selection for
// an off-flow workload (defaultSelection's own offFlow branch).
function operatingWorkload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'operate',
    health: 'ok',
    instances: [
      {
        instance: 'crosspoint-1',
        netbox_id: 1,
        function_key: 'crosspoint',
        live_view: false,
        requested_state: 'active',
        observed_state: 'running',
        reconcile_pending: false,
        placement: { node: 'node-1', ports: [], protocol: null },
        workload_assignment: 'ok',
      },
    ],
    functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
  }
}

// The workload AFTER a successful teardown, at the moment the grouped read
// next settles — the exact transition traced in the issue's third comment:
// position has already moved to `provision` (killing tear-down, since
// stageActions('finalise')'s tear-down branch is gated on lifecycle alone),
// but the member's own tag has NOT yet flipped to bootstrapped (still
// `requested_state: 'active'`, killing delete-permanently too, since that
// branch requires EVERY member bootstrapped). Both dead ends at once is
// what drops finalise all the way to `locked` in a read that is genuinely
// settled, not merely mid-poll.
function postTeardownWorkload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [
      {
        instance: 'crosspoint-1',
        netbox_id: 1,
        function_key: 'crosspoint',
        live_view: false,
        requested_state: 'active',
        observed_state: 'unknown',
        reconcile_pending: false,
        placement: { node: 'node-1', ports: [], protocol: null },
        workload_assignment: 'ok',
      },
    ],
    functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
  }
}

// A workload eligible for delete-permanently on member state alone (the
// same shape workloadSetup.test.tsx's own #378 gate tests use): every
// member bootstrapped, none observed running.
function purgeEligibleWorkload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [
      {
        instance: 'crosspoint-1',
        netbox_id: 1,
        function_key: 'crosspoint',
        live_view: false,
        requested_state: 'bootstrapped',
        observed_state: 'unknown',
        reconcile_pending: false,
        placement: { node: 'node-1', ports: [], protocol: null },
        workload_assignment: 'ok',
      },
    ],
    functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface FetchState {
  workload: MediaWorkload | null
  jobStatus: { status: string; is_done: boolean }
  purgeOp: { state: string } | null
  /** Held open until released — simulates the grouped-inventory refetch a
   *  completion's own invalidateQueries call triggers, so a test can inspect
   *  the honest in-between state before it resolves. */
  groupedGate: Promise<void> | null
  releaseGroupedGate: (() => void) | null
  /** Only the grouped call AFTER this index is gated — the initial load
   *  must resolve normally so the wizard can even reach Finalise & Review. */
  gateGroupedAfterCall: number | null
  groupedCalls: number
}

function mkFetch(initialWorkload: MediaWorkload) {
  const state: FetchState = {
    workload: initialWorkload,
    jobStatus: { status: 'running', is_done: false },
    purgeOp: null,
    groupedGate: null,
    releaseGroupedGate: null,
    gateGroupedAfterCall: null,
    groupedCalls: 0,
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()

    if (url.endsWith('/api/me')) return json(identity())
    if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
    if (url.endsWith('/api/facility/summary')) {
      return json({ site_count: 1, device_count: 0, sites: [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }] })
    }
    if (url.endsWith('/api/media-workloads/grouped')) {
      state.groupedCalls += 1
      if (state.gateGroupedAfterCall != null && state.groupedCalls > state.gateGroupedAfterCall) {
        state.groupedGate = new Promise((resolve) => {
          state.releaseGroupedGate = () => resolve()
        })
        await state.groupedGate
      }
      const grouped: MediaWorkloadsGroupedResponse = {
        configured: true,
        degraded: false,
        scope: [],
        workloads: state.workload ? [state.workload] : [],
        invalid_instances: [],
      }
      return json(grouped)
    }
    if (url.match(/\/api\/catalog\/crosspoint\/teardown$/) && (init?.method ?? 'GET') === 'POST') {
      return json({ job_id: 900, status: 'launched', request_id: 'req-td-1' })
    }
    if (url.match(/\/api\/catalog\/crosspoint\/status\/900$/)) {
      return json({
        job_id: 900,
        status: state.jobStatus.status,
        is_done: state.jobStatus.is_done,
        is_running: !state.jobStatus.is_done,
      })
    }
    if (url.match(/\/api\/media-workloads\/studio-a\/purge$/) && (init?.method ?? 'GET') === 'POST') {
      state.purgeOp = { state: 'launching' }
      return json({
        operation_id: 'op-purge-1', action: 'finalise-purge', target: 'studio-a', state: 'launching',
        job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-purge-1',
      })
    }
    if (url.endsWith('/api/operations/op-purge-1')) {
      const opState = state.purgeOp?.state ?? 'launching'
      return json({
        operation_id: 'op-purge-1', action: 'finalise-purge', target: 'studio-a', state: opState,
        job_id: 4242, error: null, l3_outcome: opState === 'run_complete' ? 'success' : null,
        purge_verified_at: opState === 'run_complete' ? '2026-08-19T12:00:00Z' : null,
        created_at: 't0', updated_at: 't1',
      })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)

  return {
    state,
    setWorkload: (wl: MediaWorkload | null) => { state.workload = wl },
    setJobDone: (status: string) => { state.jobStatus = { status, is_done: true } },
    setPurgeState: (s: string) => { state.purgeOp = { state: s } },
    /** Gate every grouped call AFTER the current call count — call once the
     *  wizard has already reached its starting state. */
    armGroupedGate: () => { state.gateGroupedAfterCall = state.groupedCalls },
    releaseGroupedGate: () => state.releaseGroupedGate?.(),
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderAppAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Media workload lifecycle' })
}

function location(): string {
  return screen.getByTestId('location').textContent ?? ''
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Teardown completing lands on the workload home (dmfdeploy#418)', () => {
  it(
    'DISCRIMINATOR: does not silently re-select Provision, and respects home\'s honest states along the way',
    async () => {
      const h = mkFetch(operatingWorkload())
      renderAppAt('/media-workloads/studio-a/setup')
      await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

      // offFlow default selection: Finalise & Review, with no rail click.
      const finalise = await screen.findByRole('heading', { name: 'Finalise & Review', level: 2 })
      const finaliseSection = finalise.closest('[data-step-state]') as HTMLElement
      expect(within(rail()).getByRole('button', { name: 'Finalise & Review' })).toBeTruthy()

      fireEvent.click(await within(finaliseSection).findByRole('button', { name: /Teardown/ }))
      fireEvent.change(within(finaliseSection).getAllByRole('textbox')[0], { target: { value: 'go' } })
      fireEvent.click(within(finaliseSection).getByRole('button', { name: /Confirm teardown/ }))
      await within(finaliseSection).findByText(/job #900/)

      // The world changes by the time the job is next observed done — same
      // ordering finalisePurgeWedge.test.tsx's own purge fixture uses ("the
      // real world has already changed by the time the operation reaches
      // run_complete"). Gate the NEXT grouped read (the completion's own
      // invalidateQueries-triggered refetch) so the honest in-between state
      // is observable rather than racing past it.
      h.setWorkload(postTeardownWorkload())
      h.armGroupedGate()
      h.setJobDone('successful')

      // Left /setup for home — proven by the ROUTE, not by absence of the
      // old page (an unmounted component can't be asserted against either
      // way; the location probe is what actually discriminates).
      await waitFor(() => expect(location()).toBe('/media-workloads/studio-a'), { timeout: 8000 })

      // THE DISCRIMINATOR ITSELF: never landed back on /setup with Provision
      // selected — must fail against current `main`, where no navigation
      // happens at all and the operator stays on /setup, bounced onto
      // Provision by the step-recovery ladder once the (ungated, on main)
      // refetch resolves.
      expect(screen.queryByRole('heading', { name: 'Provision', level: 2 })).toBeNull()

      // HOME'S HONEST STATES, while the grouped refetch this navigation
      // triggered is still gated: the query cache still holds the
      // PRE-teardown payload (lifecycle=operate, something running), but
      // isFetching is true, so membersDataTrustworthy is false and
      // classifyHomeState fails closed to 'unresolved' — never the stale
      // "live" reading, and never a premature "nothing is running" claim
      // manufactured ahead of a settled read.
      await screen.findByText(/status isn.t clear enough right now/)
      expect(screen.queryByText(/isn't running yet/)).toBeNull()
      expect(screen.queryByText(/Nothing is currently observed running/)).toBeNull()

      // Release the gate: the SAME invalidated query resolves with the real
      // post-teardown data, and home settles into its correctly-classified,
      // honest cold-entry state — the workload IS real, at `provision`,
      // nothing observed running.
      h.releaseGroupedGate()
      await screen.findByText(/This workload isn.t running yet\. Continue setup to provision it\./)
    },
    15000,
  )

  it('still renders for a genuinely locked step once the read has settled (no teardown involved)', async () => {
    // Positive control, same spirit as dmfdeploy#416's own: proves the fix
    // is a navigation seam, not a change to when Finalise locks. A workload
    // that never ran at all (lifecycle=provision, nothing bootstrapped-
    // cleared) genuinely, durably locks Finalise — reached only by a direct
    // hash, since defaultSelection never selects a locked step.
    mkFetch({
      slug: 'studio-a', name: 'studio-a', lifecycle: 'provision', health: 'ok',
      instances: [], functions: [],
    })
    renderAppAt('/media-workloads/studio-a/setup#finalise')
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    await screen.findByText(/Finalise & Review isn.t open yet/)
    expect(location()).toBe('/media-workloads/studio-a/setup')
  })
})

describe('Delete permanently completing lands on the collection view (dmfdeploy#418)', () => {
  it('leaves for /media-workloads on run_complete, which no longer lists the deleted workload', async () => {
    const h = mkFetch(purgeEligibleWorkload())
    renderAppAt('/media-workloads/studio-a/setup')
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // lifecycle=provision is ON-flow (current=provision), so Finalise &
    // Review needs an explicit rail click — unlike the teardown tests
    // above, which fixture an off-flow (operating) workload where it is
    // already the default selection.
    fireEvent.click(await waitFor(() => within(rail()).getByRole('button', { name: 'Finalise & Review' })))
    const finalise = await screen.findByRole('heading', { name: 'Finalise & Review', level: 2 })
    const finaliseSection = finalise.closest('[data-step-state]') as HTMLElement

    fireEvent.click(await within(finaliseSection).findByRole('button', { name: '🗑 Delete permanently' }))
    fireEvent.change(within(finaliseSection).getByPlaceholderText(/Reason \(required/), {
      target: { value: 'no longer needed' },
    })
    fireEvent.change(within(finaliseSection).getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
    fireEvent.click(within(finaliseSection).getByRole('button', { name: 'Delete permanently' }))

    // Wait for the operation to actually be tracked (purgeOpId set, the
    // mutation resolved) before mutating the fixture out from under it —
    // otherwise the fixture change can land before React has processed the
    // mutation's own resolution.
    await within(finaliseSection).findByText(/Deleting.*permanently/, {}, { timeout: 8000 })

    // The real world (a NetBox record removal) has already happened by the
    // time the operation is next observed run_complete — same ordering as
    // finalisePurgeWedge.test.tsx's own fixture.
    h.setWorkload(null)
    h.setPurgeState('run_complete')

    await waitFor(() => expect(location()).toBe('/media-workloads'), { timeout: 8000 })

    // Landed on the REAL collection page (not a stand-in) — proves the
    // navigation target is right AND that the completion's own
    // invalidateQueries call genuinely refreshed the shared cache: the
    // collection view reads the SAME ['media-workloads-grouped'] query, so
    // its own absence claim is never a locally-asserted "it's gone".
    await screen.findByRole('heading', { name: 'Media Workloads', level: 1 })
    expect(screen.queryByText('studio-a')).toBeNull()
  }, 15000)

  it('does NOT navigate when the operation does not complete cleanly', async () => {
    const h = mkFetch(purgeEligibleWorkload())
    renderAppAt('/media-workloads/studio-a/setup')
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    // lifecycle=provision is ON-flow (current=provision), so Finalise &
    // Review needs an explicit rail click — unlike the teardown tests
    // above, which fixture an off-flow (operating) workload where it is
    // already the default selection.
    fireEvent.click(await waitFor(() => within(rail()).getByRole('button', { name: 'Finalise & Review' })))
    const finalise = await screen.findByRole('heading', { name: 'Finalise & Review', level: 2 })
    const finaliseSection = finalise.closest('[data-step-state]') as HTMLElement

    fireEvent.click(await within(finaliseSection).findByRole('button', { name: '🗑 Delete permanently' }))
    fireEvent.change(within(finaliseSection).getByPlaceholderText(/Reason \(required/), { target: { value: 'go' } })
    fireEvent.change(within(finaliseSection).getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
    fireEvent.click(within(finaliseSection).getByRole('button', { name: 'Delete permanently' }))

    await within(finaliseSection).findByText(/Deleting.*permanently/, {}, { timeout: 8000 })
    h.setPurgeState('run_failed')

    await within(finaliseSection).findByText(/did not complete/, {}, { timeout: 8000 })
    expect(location()).toBe('/media-workloads/studio-a/setup')
  }, 15000)
})
