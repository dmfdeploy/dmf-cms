/**
 * dmfdeploy#418 FIX ROUND (P1-1, adversarial gate). Pins the GUARD, not the
 * timing — see WorkloadSetup.tsx's own `leavingFlowRef` docstring for the
 * full mechanism this closes.
 *
 * WHY workloadSetupTerminalLanding.test.tsx'S OWN TESTS DO NOT COVER THIS.
 * Those tests prove the navigation happens and lands honestly — real
 * scheduling, real timers, `waitFor`. They cannot prove the ladder CANNOT
 * fire, only that in the runs observed it didn't get the chance to — which
 * is exactly the gap the adversarial gate found in the original #418
 * commit's own "synchronous calls -> synchronous commit" reasoning (false:
 * react-router 7's <BrowserRouter> wraps its route-state update in
 * React.startTransition, a LOW-PRIORITY commit that a NORMAL-priority
 * settled-query notification can preempt).
 *
 * THE APPROACH. `useNavigate` is mocked to a no-op spy for this file only —
 * not to avoid exercising navigation (the spy's own call is asserted below,
 * so a regression that stops calling it at all still fails this test), but
 * to remove the ONE genuinely non-deterministic variable (whether the real
 * route transition has already unmounted this tree by the time the test
 * gets to assert) so what remains is deterministic: onLeaveFlow() either
 * DOES or DOES NOT actually prevent a subsequent, ordinarily-normal-
 * priority query-cache update (queryClient.setQueryData, no transition
 * involved at all) from reclassifying which step renders. That is a
 * property of the guard's own code, not of React's scheduler, and this
 * test would fail on a build that removed the guard regardless of how fast
 * or slow any real navigation happens to be.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import { workloadHomePath } from '../lib/routes'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse, UserIdentity } from '../api/types'

const navigateSpy = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigateSpy }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function identity(): UserIdentity {
  return {
    subject: 'ops', display_name: 'Ops', email: 'ops@dmf.example.com', role: 'operator',
    real_role: 'operator', view_as_active: false, groups: [], awx_configured: true, authentik_configured: true,
  }
}

function catalogEntry(): CatalogEntry {
  return {
    key: 'crosspoint', display_name: 'MXL Crosspoint', summary: 'Routes media flows.',
    ebu_layer: null, ebu_vertical: null, ebu_media_function_type: null, ebu_lifecycle_owner: null,
    lifecycle: 'active', provision_image: null, provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint', finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [], ingress_url: null,
  }
}

// Off-flow, operating — Finalise & Review is the default selection with no
// rail click, same fixture shape as workloadSetupTerminalLanding.test.tsx's
// own operatingWorkload().
function operatingWorkload(): MediaWorkload {
  return {
    slug: 'studio-a', name: 'studio-a', lifecycle: 'operate', health: 'ok',
    instances: [{
      instance: 'crosspoint-1', netbox_id: 1, function_key: 'crosspoint', live_view: false,
      requested_state: 'active', observed_state: 'running', reconcile_pending: false,
      placement: { node: 'node-1', ports: [], protocol: null }, workload_assignment: 'ok',
    }],
    functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
  }
}

// The settled-but-adversarial read the ladder must not act on: lifecycle
// already moved to `provision` (killing tear-down), the member's own tag
// hasn't caught up (killing delete-permanently too) — Finalise genuinely
// locks in this read, same fixture as workloadSetupTerminalLanding.test.tsx's
// own postTeardownWorkload().
function postTeardownWorkload(): MediaWorkload {
  return {
    slug: 'studio-a', name: 'studio-a', lifecycle: 'provision', health: 'ok',
    instances: [{
      instance: 'crosspoint-1', netbox_id: 1, function_key: 'crosspoint', live_view: false,
      requested_state: 'active', observed_state: 'unknown', reconcile_pending: false,
      placement: { node: 'node-1', ports: [], protocol: null }, workload_assignment: 'ok',
    }],
    functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
  }
}

// A second, distinct workload for the P2 (fix round 2) guard-SCOPE test
// below — deliberately a different slug/name than every `studio-a` fixture
// above, so PageHeading's `${workload.name} — Setup` text is an unambiguous
// discriminator between "rendering studio-a's frozen snapshot" and
// "rendering studio-b's own, live data".
function otherWorkload(): MediaWorkload {
  return {
    slug: 'studio-b', name: 'studio-b', lifecycle: 'operate', health: 'ok',
    instances: [], functions: [],
  }
}

function purgeEligibleWorkload(): MediaWorkload {
  return {
    slug: 'studio-a', name: 'studio-a', lifecycle: 'provision', health: 'ok',
    instances: [{
      instance: 'crosspoint-1', netbox_id: 1, function_key: 'crosspoint', live_view: false,
      requested_state: 'bootstrapped', observed_state: 'unknown', reconcile_pending: false,
      placement: { node: 'node-1', ports: [], protocol: null }, workload_assignment: 'ok',
    }],
    functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
  }
}

function renderSetup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/studio-a/setup']}>
        <Routes>
          <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Media workload lifecycle' })
}

function stageSection(label: string): HTMLElement {
  return screen.getByRole('heading', { name: label, level: 2 }).closest('[data-step-state]') as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  navigateSpy.mockClear()
})

describe('WorkloadSetup leaving guard (dmfdeploy#418 P1-1): cannot fire, not raced', () => {
  it(
    'GUARD (teardown): a forced settled reclassification after completion cannot select Provision',
    async () => {
      let jobDone = false
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = (typeof input === 'string' ? input : (input as Request).url).toString()
          if (url.endsWith('/api/me')) return json(identity())
          if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
          if (url.endsWith('/api/media-workloads/grouped')) {
            const grouped: MediaWorkloadsGroupedResponse = {
              configured: true, degraded: false, scope: [],
              workloads: [operatingWorkload()], invalid_instances: [],
            }
            return json(grouped)
          }
          if (url.match(/\/api\/catalog\/crosspoint\/teardown$/) && (init?.method ?? 'GET') === 'POST') {
            return json({ job_id: 900, status: 'launched', request_id: 'req-td-1' })
          }
          if (url.match(/\/api\/catalog\/crosspoint\/status\/900$/)) {
            return json({ job_id: 900, status: jobDone ? 'successful' : 'running', is_done: jobDone, is_running: !jobDone })
          }
          return json({})
        }),
      )

      const queryClient = renderSetup()
      await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
      const finalise = await screen.findByRole('heading', { name: 'Finalise & Review', level: 2 })
      const finaliseSection = finalise.closest('[data-step-state]') as HTMLElement

      fireEvent.click(await within(finaliseSection).findByRole('button', { name: /Teardown/ }))
      fireEvent.change(within(finaliseSection).getAllByRole('textbox')[0], { target: { value: 'go' } })
      fireEvent.click(within(finaliseSection).getByRole('button', { name: /Confirm teardown/ }))
      await within(finaliseSection).findByText(/job #900/)

      jobDone = true
      // handleJobComplete fires: onLeaveFlow() then navigate() — the mocked
      // navigate() is a no-op, so nothing about location changes, but the
      // ref it sets is the same real ref production code sets. JobStatusLine
      // polls every 2s with real timers (api/hooks.ts), hence the timeout.
      await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith(workloadHomePath('studio-a')), { timeout: 8000 })

      // THE FORCE. A plain cache write — no router, no transition, nothing
      // scheduling-adjacent — landing the exact settled, correctly-locked-
      // Finalise reclassification the original bug's own recovery ladder
      // would otherwise act on. If `leavingFlowRef` were not checked here,
      // this alone reclassifies `workload`, locks Finalise (lifecycle now
      // `provision`, member not yet re-tagged), and defaultSelection's
      // fallback lands on `current` — Provision.
      await act(async () => {
        queryClient.setQueryData<MediaWorkloadsGroupedResponse>(['media-workloads-grouped'], {
          configured: true, degraded: false, scope: [],
          workloads: [postTeardownWorkload()], invalid_instances: [],
        })
        // TanStack Query's notifyManager flushes observer notifications via
        // a scheduled tick, not synchronously within setQueryData itself —
        // a real (short) delay, not just a microtask hop, so this act()
        // does not return before the resulting re-render has had every
        // normal opportunity to commit.
        await new Promise((resolve) => setTimeout(resolve, 100))
      })

      // Still on /setup (navigate() is a no-op in this file) — the page had
      // every chance to reclassify and did not.
      expect(screen.queryByRole('heading', { name: 'Provision', level: 2 })).toBeNull()
      expect(screen.getByRole('heading', { name: 'Finalise & Review', level: 2 })).toBeTruthy()
    },
    15000,
  )

  it(
    'GUARD (delete permanently): the collection-cache absence write cannot flip to "Workload not found"',
    async () => {
      let purgeState = 'launching'
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = (typeof input === 'string' ? input : (input as Request).url).toString()
          if (url.endsWith('/api/me')) return json(identity())
          if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
          if (url.endsWith('/api/media-workloads/grouped')) {
            // Mirrors reality once the purge genuinely completes: the SAME
            // backend re-read that stamps purge_verified_at is the one this
            // endpoint's own grouping derives from, so a REAL refetch landing
            // here also stops listing the workload — not a static fixture
            // this test can leave permanently eligible while asserting a
            // completed purge. Matters here specifically: this is what makes
            // the invalidateQueries-triggered refetch this same effect fires
            // an equally-adversarial (not merely inert) source of the exact
            // condition being guarded against.
            const grouped: MediaWorkloadsGroupedResponse = {
              configured: true, degraded: false, scope: [],
              workloads: purgeState === 'run_complete' ? [] : [purgeEligibleWorkload()],
              invalid_instances: [],
            }
            return json(grouped)
          }
          if (url.match(/\/api\/media-workloads\/studio-a\/purge$/) && (init?.method ?? 'GET') === 'POST') {
            return json({
              operation_id: 'op-purge-1', action: 'finalise-purge', target: 'studio-a', state: 'launching',
              job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-purge-1',
            })
          }
          if (url.endsWith('/api/operations/op-purge-1')) {
            return json({
              operation_id: 'op-purge-1', action: 'finalise-purge', target: 'studio-a', state: purgeState,
              job_id: 4242, error: null, l3_outcome: purgeState === 'run_complete' ? 'success' : null,
              purge_verified_at: purgeState === 'run_complete' ? '2026-08-19T12:00:00Z' : null,
              created_at: 't0', updated_at: 't1',
            })
          }
          return json({})
        }),
      )

      renderSetup()
      await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
      fireEvent.click(await waitFor(() => within(rail()).getByRole('button', { name: 'Finalise & Review' })))
      const finaliseSection = stageSection('Finalise & Review')

      fireEvent.click(await within(finaliseSection).findByRole('button', { name: '🗑 Delete permanently' }))
      fireEvent.change(within(finaliseSection).getByPlaceholderText(/Reason \(required/), { target: { value: 'go' } })
      fireEvent.change(within(finaliseSection).getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
      fireEvent.click(within(finaliseSection).getByRole('button', { name: 'Delete permanently' }))

      await within(finaliseSection).findByText(/Deleting.*permanently/, {}, { timeout: 8000 })
      purgeState = 'run_complete'

      // The purge terminal effect's OWN synchronous cache write (P1-2, this
      // same fix round) filters this slug out of ['media-workloads-grouped']
      // as a matter of course once purge_verified_at lands — no forcing
      // needed here, this IS the adversarial condition, produced by ordinary
      // operation. onLeaveFlow() runs in the SAME synchronous handler as
      // that write. navigate() is a no-op in this file, so nothing about
      // location changes; WorkloadSetup stays mounted and gets every
      // opportunity to reclassify `workload` to undefined and render
      // "Workload not found" instead. useOperationStatus polls every 3s with
      // real timers (api/hooks.ts), hence the timeout.
      await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/media-workloads'), { timeout: 8000 })
      // Give the SAME cache write's own query-observer notification every
      // normal opportunity to actually commit a re-render before asserting
      // — see the teardown test above for why this isn't a no-op wait.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
      })

      expect(screen.queryByRole('heading', { name: 'Workload not found' })).toBeNull()
      expect(screen.getByRole('heading', { name: 'Finalise & Review', level: 2 })).toBeTruthy()
    },
    15000,
  )
})

/**
 * dmfdeploy#418 FIX ROUND 2 (P2, adversarial gate). The guard above proves
 * `leavingFlowRef` prevents a stray reclassification while a departure is
 * pending. It does NOT, on its own, prove the guard ever releases —
 * WorkloadSetup is not keyed by workload identity (only WorkloadWizard,
 * further down that file, is), so the SAME instance — and the SAME ref —
 * survives a navigation from one workload's own /setup route to another's.
 * A departure that gets SUPERSEDED before its own navigate() actually
 * commits (Back, or a direct link to a different workload's own /setup)
 * used to leave `leavingFlowRef.current` permanently `true` with nothing to
 * ever reset it, pinning the FIRST workload's frozen snapshot under the
 * SECOND workload's URL forever.
 *
 * THE APPROACH here is deliberately the mirror image of the guard test
 * above: `navigate()` is mocked to a no-op for this whole file (see the top
 * of it), which means the INTENDED destination of a terminal Finalise
 * action never actually happens in this suite — the operator visibly never
 * leaves /setup. That is exactly what makes this file able to model a
 * superseded navigation cleanly: trigger the departure (pins the ref to
 * studio-a), then drive a REAL router transition — a <Link> click, exactly
 * as workloadSetupCrossWorkload.test.tsx's own cross-workload tests do — to
 * a DIFFERENT workload's own /setup route, and check which workload's data
 * renders under that URL.
 */
describe('WorkloadSetup leaving guard SCOPE (dmfdeploy#418 P2, fix round 2): pinned only to the departing workload', () => {
  it(
    "a superseded navigation to a different workload's own /setup route releases the pin instead of keeping the departed workload's snapshot",
    async () => {
      let jobDone = false
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = (typeof input === 'string' ? input : (input as Request).url).toString()
          if (url.endsWith('/api/me')) return json(identity())
          if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
          if (url.endsWith('/api/media-workloads/grouped')) {
            const grouped: MediaWorkloadsGroupedResponse = {
              configured: true, degraded: false, scope: [],
              workloads: [operatingWorkload(), otherWorkload()], invalid_instances: [],
            }
            return json(grouped)
          }
          if (url.match(/\/api\/catalog\/crosspoint\/teardown$/) && (init?.method ?? 'GET') === 'POST') {
            return json({ job_id: 901, status: 'launched', request_id: 'req-td-2' })
          }
          if (url.match(/\/api\/catalog\/crosspoint\/status\/901$/)) {
            return json({ job_id: 901, status: jobDone ? 'successful' : 'running', is_done: jobDone, is_running: !jobDone })
          }
          return json({})
        }),
      )

      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/media-workloads/studio-a/setup']}>
            <nav>
              <Link to="/media-workloads/studio-b/setup">go to B</Link>
            </nav>
            <Routes>
              <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
            </Routes>
            <HeaderSlotProbe />
          </MemoryRouter>
        </QueryClientProvider>,
      )
      await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
      const finalise = await screen.findByRole('heading', { name: 'Finalise & Review', level: 2 })
      const finaliseSection = finalise.closest('[data-step-state]') as HTMLElement

      fireEvent.click(await within(finaliseSection).findByRole('button', { name: /Teardown/ }))
      fireEvent.change(within(finaliseSection).getAllByRole('textbox')[0], { target: { value: 'go' } })
      fireEvent.click(within(finaliseSection).getByRole('button', { name: /Confirm teardown/ }))
      await within(finaliseSection).findByText(/job #901/)

      jobDone = true
      // handleJobComplete fires: onLeaveFlow() pins `leavingFlowRef` (AND,
      // this round, `leavingFlowSlugRef`) to studio-a, then navigate() —
      // mocked to a no-op in this file, so the operator never actually
      // leaves /setup. The pending departure is about to be SUPERSEDED
      // below, not fulfilled — the real-world shape of the bug.
      await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith(workloadHomePath('studio-a')), { timeout: 8000 })

      // THE SUPERSEDING NAVIGATION: a genuine router transition (Back, or a
      // direct link — react-router does not distinguish) to a DIFFERENT
      // workload's own /setup route. The SAME WorkloadSetup instance is
      // reused (only the :slug param differs — no remount), so a
      // `leavingFlowRef` that never resets pins studio-a's frozen snapshot
      // under studio-b's URL, forever.
      fireEvent.click(screen.getByRole('link', { name: 'go to B' }))

      // THE DISCRIMINATOR: PageHeading renders `${workload.name} — Setup`
      // straight off whichever workload actually got selected to render —
      // studio-a's frozen snapshot (pre-fix) vs. studio-b's own live data
      // (fixed). Must fail against the pre-scoping code, where this stays
      // "studio-a — Setup" forever once the ref is pinned.
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'studio-b — Setup', level: 1 })).toBeTruthy(),
      )
      expect(screen.queryByRole('heading', { name: 'studio-a — Setup', level: 1 })).toBeNull()
    },
    15000,
  )
})
