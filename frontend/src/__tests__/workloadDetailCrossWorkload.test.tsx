/**
 * GATE-D1.4 (operator review round 2, PR #70): every piece of the wizard's
 * per-workload state must NOT bleed from one workload to another when the
 * operator navigates /media-workloads/A -> /media-workloads/B — same route,
 * only the :slug param changes, which React does not remount for on its
 * own. WorkloadDetail.tsx now keys the wizard subtree on `workload.slug`
 * (`<WorkloadWizard key={workload.slug} .../>`) so a workload change tears
 * the old instance down and mounts a fresh one; these tests prove that
 * holds for the three concrete failure modes the review named: selection,
 * the job-in-flight lock, and hash-focus consumption.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import type {
  CatalogEntry,
  MediaWorkload,
  MediaWorkloadInstance,
  MediaWorkloadsGroupedResponse,
} from '../api/types'

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: '',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'bootstrapped',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint',
    finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [],
    ingress_url: null,
    ...overrides,
  }
}

function workloadA(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [],
    functions: [{ function_key: 'crosspoint', count: 0, running: 0, reconcile_pending: 0 }],
  }
}

function workloadB(): MediaWorkload {
  // Deliberately a DIFFERENT default position from A (offFlow -> Finalise &
  // Review) so a bled-over 'design' selection from A is observably wrong
  // for B, not coincidentally right.
  return {
    slug: 'studio-b',
    name: 'studio-b',
    lifecycle: 'operate',
    health: 'ok',
    instances: [],
    functions: [],
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mkFetch(opts: { holdDeploy?: boolean } = {}) {
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    workloads: [workloadA(), workloadB()],
    invalid_instances: [],
  }
  let releaseDeploy: (() => void) | undefined
  const deployGate = opts.holdDeploy
    ? new Promise<void>((resolve) => {
        releaseDeploy = resolve
      })
    : Promise.resolve()
  const deployCalls: string[] = []

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
    if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
    if (url.endsWith('/api/facility/summary')) return json({ site_count: 0, device_count: 0, sites: [] })
    if (url.match(/\/api\/catalog\/crosspoint\/deploy$/)) {
      deployCalls.push(url)
      await deployGate
      return json({ job_id: 501, status: 'launched', request_id: 'req-1' })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { deployCalls, releaseDeploy: () => releaseDeploy?.() }
}

function renderAt(initialSlug: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/media-workloads/${initialSlug}`]}>
        <nav>
          <Link to="/media-workloads/studio-a">go to A</Link>
          <Link to="/media-workloads/studio-b">go to B</Link>
        </nav>
        <Routes>
          <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
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
// 1. Selection reset
// ---------------------------------------------------------------------------

describe('selection does not bleed from one workload to the next', () => {
  it('B shows its OWN ladder-derived selection, not the step left selected on A', async () => {
    mkFetch()
    renderAt('studio-a')
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // A defaults to Provision (its backend position); explicitly select the
    // OPENABLE-but-not-default Design step instead.
    fireEvent.click(within(rail()).getByRole('button', { name: 'Design' }))
    expect(screen.getByRole('heading', { name: 'Design', level: 2 })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: 'go to B' }))

    // B is off-flow (lifecycle=operate) -> its own default is Finalise &
    // Review. Pre-fix, Design is ALSO openable for B (a `complete` step),
    // so a bled-over selectedStep='design' would silently "work" and this
    // assertion is the one that actually catches it.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Finalise & Review', level: 2 })).toBeTruthy(),
    )
    expect(screen.queryByRole('heading', { name: 'Design', level: 2 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Job-flag non-bleed (ownership-move lifecycle test, rule b)
// ---------------------------------------------------------------------------

describe('a job in flight on one workload does not lock navigation on another (ownership-move lifecycle test)', () => {
  it('mount A -> pending job -> navigate to B (live) -> navigate back to A (backend-derived, not the stale overlay)', async () => {
    const h = mkFetch({ holdDeploy: true })
    renderAt('studio-a')
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // MOUNT + PENDING: arm and confirm a deploy on A; hold its backend call
    // open so the job stays "in flight" for as long as A's instance exists.
    const provisionA = screen.getByRole('heading', { name: 'Provision', level: 2 }).closest('[data-step-state]') as HTMLElement
    fireEvent.click(await within(provisionA).findByRole('button', { name: /Deploy/ }))
    fireEvent.change(within(provisionA).getAllByRole('textbox')[0], { target: { value: 'go' } })
    fireEvent.click(within(provisionA).getByRole('button', { name: /Confirm deploy/ }))
    await waitFor(() => expect(h.deployCalls).toHaveLength(1))
    await waitFor(() => expect(within(rail()).queryByRole('button', { name: 'Design' })).toBeNull())

    // NAVIGATE (unmount A's wizard instance, mount B's): B's rail must be
    // live — not locked by a job that belongs to a different workload.
    fireEvent.click(screen.getByRole('link', { name: 'go to B' }))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Finalise & Review', level: 2 })).toBeTruthy(),
    )
    expect(within(rail()).getByRole('button', { name: 'Design' })).toBeTruthy()
    expect(within(rail()).getByRole('link', { name: 'Operate' })).toBeTruthy()

    // REMOUNT A: no crash, and the local busy overlay is GONE — this is the
    // documented reload-equivalence (the backend's own `lifecycle: 'provision'`
    // for A never changed in this fixture, and the fetch mock still holds
    // the original deploy call open, but that promise is orphaned now that
    // A's ProvisionStage instance that owned it was torn down). Provision
    // reads straight from the backend position again: Deploy is offered.
    fireEvent.click(screen.getByRole('link', { name: 'go to A' }))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Provision', level: 2 })).toBeTruthy(),
    )
    const provisionAAgain = screen.getByRole('heading', { name: 'Provision', level: 2 }).closest('[data-step-state]') as HTMLElement
    expect(within(provisionAAgain).getByRole('button', { name: /Deploy/ })).toBeTruthy()
    expect(within(rail()).queryByRole('button', { name: 'Design' })).not.toBeNull()

    h.releaseDeploy()
  })
})

// ---------------------------------------------------------------------------
// 3. Hash-focus reset
// ---------------------------------------------------------------------------

function viewerInstance(
  id: string,
  netboxId: number,
): MediaWorkloadInstance & { workload_assignment: string } {
  return {
    instance: id,
    netbox_id: netboxId,
    function_key: 'viewer',
    live_view: false,
    requested_state: 'active',
    observed_state: 'running',
    reconcile_pending: false,
    placement: { node: 'node-1', ports: [], protocol: null },
    workload_assignment: 'ok',
  }
}

/** Both workloads are lifecycle=operate with a running instance, so
 *  Configure genuinely bears switch-source (openable) for EACH of them —
 *  the only shape where a stale, already-consumed hashFocusedRef from A can
 *  actually be observed suppressing B's own hash-driven focus, as opposed
 *  to both landing on Configure "by accident" via the ordinary ladder. */
function mkFetchBothConfigurable() {
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    workloads: [
      {
        slug: 'studio-a',
        name: 'studio-a',
        lifecycle: 'operate',
        health: 'ok',
        instances: [viewerInstance('viewer-a', 1)],
        functions: [{ function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 }],
      },
      {
        slug: 'studio-b',
        name: 'studio-b',
        lifecycle: 'operate',
        health: 'ok',
        instances: [viewerInstance('viewer-b', 2)],
        functions: [{ function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 }],
      },
    ],
    invalid_instances: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/catalog')) return json({ entries: [] })
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
      // No topology fixture for either instance — InstanceSwitchControl
      // renders nothing for a topology-less instance, which is fine: this
      // test is about which STEP gets selected+focused, not the switch
      // control itself.
      return json({})
    }),
  )
}

describe('hash-focus consumption does not bleed from one workload to the next', () => {
  it('A consumes its own #configure focus, then B — navigated to with its OWN #configure — gets focused too, not silently skipped', async () => {
    // Asserted via a spy on the actual `.focus()` call, not via
    // document.activeElement: React reconciles the SAME <FlowStep> element
    // type at the SAME tree position across an A->B re-render (this was
    // true even pre-fix, since the buggy version never unmounted anything),
    // so the DOM node hosting Configure's panel is REUSED rather than
    // recreated — meaning focus can appear to "survive" on B's panel by
    // simple DOM persistence, whether or not the hash-focus effect actually
    // ran for B. Counting `.focus()` invocations sidesteps that entirely:
    // it can only reach 2 if the effect body genuinely executed a second
    // time, which is exactly what a bled (already-true) hashFocusedRef
    // would prevent.
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    mkFetchBothConfigurable()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/studio-a#configure']}>
          <nav>
            <Link to="/media-workloads/studio-b#configure">go to B with #configure</Link>
          </nav>
          <Routes>
            <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
          </Routes>
          <HeaderSlotProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // A: Configure is selected via the hash AND genuinely focused — this is
    // the real consumption event (hashFocusedRef -> true) that a bled ref
    // would wrongly suppress for B.
    await waitFor(() => expect(focusSpy).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('heading', { name: 'Configure', level: 2 })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: 'go to B with #configure' }))

    // B mounts a FRESH WorkloadWizard (keyed on studio-b) with its own
    // unconsumed hashFocusedRef, so its own #configure focus effect fires
    // too — a SECOND real `.focus()` call. Pre-fix, the single shared ref
    // (already true from A) leaves B correctly SELECTED (defaultSelection
    // reads the hash directly, ungated by the ref) but the panel is never
    // actually re-focused — exactly the gap this proves is closed.
    await waitFor(() => expect(focusSpy).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('heading', { name: 'Configure', level: 2 })).toBeTruthy()
  })
})
