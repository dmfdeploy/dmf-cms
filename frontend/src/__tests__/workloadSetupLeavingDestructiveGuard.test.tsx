/**
 * dmfdeploy#418 FIX ROUND 3 (adversarial gate, operator's harness). Pins a
 * DIFFERENT leak than workloadSetupLeavingGuard.test.tsx's own two GUARD
 * tests: those prove `leavingFlowRef` stops WorkloadSetup's step-recovery
 * ladder from reclassifying `workload`/`selectedStep` while a departure is
 * pending. They say nothing about whether the STAGE ITSELF stays honest
 * during that same window — and it did not.
 *
 * THE LEAK. While `leavingFlowRef.current` is true, WorkloadSetup.tsx keeps
 * WorkloadWizard mounted on the FROZEN pre-action `workload`/`groupedRead`
 * snapshot (the state in which the destructive control was offered in the
 * first place — the workload still running, or still purgeable). But the
 * BUSY barrier that was suppressing that control is not part of that
 * freeze: `tearingDown` is WorkloadWizard's own local state, cleared by
 * FinaliseStage's own `onBusyChange(busy)` effect once the mutation/track
 * settles — which happens BEFORE the low-priority route transition
 * `onLeaveFlow()`'s own navigate() call started actually commits. Once
 * `tearingDown` clears, `stageActions('finalise', input)` recomputes
 * against the still-frozen `workload` — the SAME pre-action read — and
 * hands back the SAME action list it did before the destructive action
 * ran, re-arming the Teardown/Delete-permanently control in the window
 * before the operator ever leaves the page.
 *
 * THE APPROACH is the same one workloadSetupLeavingGuard.test.tsx already
 * established for this exact class of problem: mock `useNavigate` to a
 * no-op spy (asserted below, so a regression that stops calling it still
 * fails this file), which keeps WorkloadSetup mounted at /setup forever
 * after the departure is pinned — the deterministic way to inspect
 * everything that DOES or DOES NOT render during a window a real browser
 * would only hold open for one low-priority commit.
 *
 * THE DISCRIMINATOR. Both tests below assert the destructive control is
 * ABSENT once `leaving` is pinned. That assertion is only meaningful if the
 * SAME control is first proven reachable pre-action (before the fix ever
 * has anything to suppress) — both tests do that as their opening
 * assertion, so a fixture that simply never offers the control in the
 * first place cannot make this pass by accident.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
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
// rail click, tear-down offered. Same fixture shape as
// workloadSetupLeavingGuard.test.tsx's own operatingWorkload() — this test
// relies on the SAME frozen-snapshot mechanism that fixture already proves
// stays frozen, just checking a different consequence of it.
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

// Real effects (FinaliseStage's onBusyChange -> WorkloadWizard's
// setTearingDown -> a fresh stageActions() recompute) need an extra beat
// past whatever async event already resolved to actually commit — the
// exact idiom workloadSetupLeavingGuard.test.tsx's own GUARD tests already
// use after a synchronous cache write, applied here after a real navigate()
// call instead.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  navigateSpy.mockClear()
})

describe('FinaliseStage destructive controls during the leaving window (dmfdeploy#418 fix round 3)', () => {
  it(
    'the just-fired Teardown control does not re-arm once the busy flag clears but before navigation lands',
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

      renderSetup()
      await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
      const finalise = await screen.findByRole('heading', { name: 'Finalise & Review', level: 2 })
      const finaliseSection = finalise.closest('[data-step-state]') as HTMLElement

      // THE DISCRIMINATOR's opening half: the control is genuinely reachable
      // before any of this fires — proves the fixture offers it, not that
      // absence later is just the fixture never having offered it at all.
      // findByRole is the proof of reachability itself — this codebase never
      // renders a disabled destructive button (FinaliseEntry's own "Never a
      // disabled button" convention, matching ProvisionEntry's), so a real
      // element found here IS a clickable one; there is no separate
      // disabled/enabled axis to assert.
      const teardownButton = await within(finaliseSection).findByRole('button', { name: /Teardown/ })

      fireEvent.click(teardownButton)
      fireEvent.change(within(finaliseSection).getAllByRole('textbox')[0], { target: { value: 'go' } })
      fireEvent.click(within(finaliseSection).getByRole('button', { name: /Confirm teardown/ }))
      await within(finaliseSection).findByText(/job #900/)

      jobDone = true
      // handleJobComplete fires: setTrack(EMPTY) clears this entry's own
      // `inFlight`, then onLeaveFlow() pins `leavingFlowRef`, then the
      // mocked navigate() (a no-op) "commits" instantly — so, unlike a real
      // browser, this page never actually leaves /setup, which is exactly
      // what lets this test inspect the window a real one only holds open
      // for a single low-priority commit. JobStatusLine polls every 2s with
      // real timers (api/hooks.ts), hence the timeout.
      await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith(workloadHomePath('studio-a')), { timeout: 8000 })

      // Give FinaliseStage's own `onBusyChange(busy)` effect and
      // WorkloadWizard's resulting `setTearingDown(false)` every normal
      // opportunity to actually commit and re-render — this is what makes
      // `stageActions('finalise', input)` recompute against the still-
      // frozen pre-teardown `workload` a second time, which is the defect
      // this test pins.
      await flush()

      // THE ASSERTION. Fixed: no destructive control reachable while
      // `leavingFlowRef.current` is still true (navigateSpy has been called
      // and stays the only call — this page never actually left /setup in
      // this file). Unfixed: the SAME Teardown button this test already
      // proved reachable above reappears here, fully enabled — this
      // assertion fails, not by timeout, but because the query below finds
      // a real, enabled button.
      expect(within(finaliseSection).queryByRole('button', { name: /Teardown/ })).toBeNull()
      expect(within(finaliseSection).getAllByText(/Leaving this flow/)).toHaveLength(2)
    },
    15000,
  )

  it(
    'the just-fired Delete permanently control does not re-arm once the busy flag clears but before navigation lands',
    async () => {
      let purgeState = 'launching'
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = (typeof input === 'string' ? input : (input as Request).url).toString()
          if (url.endsWith('/api/me')) return json(identity())
          if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
          if (url.endsWith('/api/media-workloads/grouped')) {
            // The frozen-snapshot mechanism under test needs this to stay
            // eligible even after purge dispatches — unlike
            // workloadSetupLeavingGuard.test.tsx's own purge GUARD test,
            // which deliberately makes a REAL refetch stop listing the
            // workload once verified. That test proves the READ can't leak
            // through the freeze; this one proves the STAGE'S OWN affordance
            // ladder can't re-arm once busy clears — the frozen `workload`
            // this page holds during the leaving window never sees this
            // response at all, so what it returns after dispatch is moot for
            // what's under test here, only kept realistic.
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

      // THE DISCRIMINATOR's opening half — same purpose as the teardown
      // test above.
      // Same "findByRole is the reachability proof" note as the teardown
      // test above.
      const purgeButton = await within(finaliseSection).findByRole('button', { name: '🗑 Delete permanently' })

      fireEvent.click(purgeButton)
      fireEvent.change(within(finaliseSection).getByPlaceholderText(/Reason \(required/), { target: { value: 'go' } })
      fireEvent.change(within(finaliseSection).getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
      fireEvent.click(within(finaliseSection).getByRole('button', { name: 'Delete permanently' }))

      await within(finaliseSection).findByText(/Deleting.*permanently/, {}, { timeout: 8000 })
      purgeState = 'run_complete'

      // The purge terminal effect fires: setPurgeOpId(null) clears the
      // "Deleting…" readout's own gate, then (verified) onLeaveFlow() pins
      // `leavingFlowRef`, then the mocked navigate() "commits" instantly —
      // same no-op shape as the teardown test above. useOperationStatus
      // polls every 3s with real timers, hence the timeout.
      await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/media-workloads'), { timeout: 8000 })
      await flush()

      // THE ASSERTION. Fixed: no destructive control reachable. Unfixed:
      // the Delete permanently button this test already proved reachable
      // above reappears here, fully enabled, for a workload the operator
      // just watched get deleted.
      expect(within(finaliseSection).queryByRole('button', { name: '🗑 Delete permanently' })).toBeNull()
      expect(within(finaliseSection).getAllByText(/Leaving this flow/)).toHaveLength(2)
    },
    15000,
  )
})
