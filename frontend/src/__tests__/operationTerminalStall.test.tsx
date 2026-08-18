/**
 * umbrella #403: an operation tracked by OPERATION id (not job id) used to
 * have no way back out of the tracker unless the transient `launched` state
 * was actually observed — neither onOpLaunched nor onOpError fires on any of
 * the operation state machine's REAL terminal states (run_complete,
 * run_failed, failed_rollback_required, rollback_incomplete,
 * run_status_unknown). A watched action (teardown/deploy/rollback/
 * finalise-purge) keeps running right past `launched` toward one of those
 * regardless of whether any poll happened to land during that window — and
 * once a real terminal state is reached, useOperationStatus itself stops
 * polling (_WATCHED_TERMINAL_STATES), so nothing short of a remount ever
 * revisited the tracker again. Live-reproduced on a teardown: the busy
 * banner ("A Finalise & Review job is in progress") stayed up long after the
 * cluster was confirmed clean, with no self-recovery.
 *
 * T1/T2/T3 exercise the real defect through FinaliseStage/WorkloadSetup —
 * the busy flag and the honesty of what the operator is shown are both
 * properties of that integration, not of OperationStatusLine in isolation.
 * T4 pins the shared component's label table directly, mirroring
 * jobProgressHonesty.test.tsx's own style for OperationStatusLine.
 *
 * GUARD LABEL (dmfdeploy#414 gate, round 1): every test in this file is a
 * GUARD pinning the pre-#414 umbrella #403 fix described above, unchanged
 * by this arc — only T1-T3's mount route moved, from the bare slug to
 * /setup. Baseline: the pre-#414 commit on `main`, where these same
 * assertions passed identically against WorkloadDetail.tsx at the bare
 * slug.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import { OperationStatusLine } from '../pages/MediaWorkloads/stages/JobProgress'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse } from '../api/types'

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: '',
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderDetail() {
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

function offFlowWorkload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'operate',
    health: 'ok',
    instances: [],
    functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
  }
}

function armAndConfirmTeardown(finalise: HTMLElement) {
  fireEvent.click(within(finalise).getAllByRole('button', { name: /Teardown/ })[0])
  fireEvent.change(within(finalise).getAllByRole('textbox')[0], { target: { value: 'go' } })
  fireEvent.click(within(finalise).getByRole('button', { name: /Confirm teardown/ }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Finalise & Review: a teardown operation that never passes through `launched`', () => {
  it('T1: run_complete on the very first poll still clears the busy state', async () => {
    const wl = offFlowWorkload()
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true, degraded: false, scope: [], workloads: [wl], invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.match(/\/api\/catalog\/crosspoint\/teardown$/)) {
          return json({
            operation_id: 'op-t1', action: 'teardown', target: 'crosspoint', state: 'waking',
            job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-t1',
          })
        }
        if (url.endsWith('/api/operations/op-t1')) {
          // ALWAYS run_complete, from the very first poll — this operation
          // is NEVER observed at `launched`. That is the entire point: any
          // eventual recovery below cannot be riding the pre-existing
          // onLaunched hand-off.
          return json({
            operation_id: 'op-t1', action: 'teardown', target: 'crosspoint', state: 'run_complete',
            job_id: 9001, error: null, created_at: 't0', updated_at: 't1',
          })
        }
        return json({})
      }),
    )

    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const finalise = stageSection('Finalise & Review')
    await within(finalise).findByRole('button', { name: /Teardown/ })
    armAndConfirmTeardown(finalise)

    // Busy immediately, same as any other in-flight job.
    await waitFor(() => expect(within(rail()).queryByRole('button', { name: 'Design' })).toBeNull())
    // Never observed — proves this run genuinely never passed through it.
    expect(within(finalise).queryByText('Launched')).toBeNull()

    // The fix: busy still clears even though `launched` was never seen.
    await waitFor(
      () => expect(within(rail()).getByRole('button', { name: 'Design' })).toBeTruthy(),
      { timeout: 5000 },
    )
    expect(within(finalise).queryByText('Launched')).toBeNull()
    // Plain DOM textContent, not an RTL text query: the entry key renders
    // inside its own <span class="font-mono">, so the review sentence is
    // split across element boundaries and getByText's default node-text
    // algorithm (direct text-node children only) can never see it whole.
    await waitFor(() => expect(finalise.textContent).toContain('Teardown of crosspoint completed.'))
  })

  it('T2 (regression guard): the launched -> job hand-off still completes normally', async () => {
    const wl = offFlowWorkload()
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true, degraded: false, scope: [], workloads: [wl], invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.match(/\/api\/catalog\/crosspoint\/teardown$/)) {
          return json({
            operation_id: 'op-t2', action: 'teardown', target: 'crosspoint', state: 'waking',
            job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-t2',
          })
        }
        if (url.endsWith('/api/operations/op-t2')) {
          return json({
            operation_id: 'op-t2', action: 'teardown', target: 'crosspoint', state: 'launched',
            job_id: 7001, error: null, created_at: 't0', updated_at: 't1',
          })
        }
        if (url.match(/\/api\/catalog\/crosspoint\/status\/7001$/)) {
          return json({ job_id: 7001, status: 'successful', elapsed: 1.2, is_done: true })
        }
        return json({})
      }),
    )

    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const finalise = stageSection('Finalise & Review')
    await within(finalise).findByRole('button', { name: /Teardown/ })
    armAndConfirmTeardown(finalise)

    await waitFor(() => expect(within(rail()).queryByRole('button', { name: 'Design' })).toBeNull())
    // The transient state DOES render on this path — the contrast with T1.
    await within(finalise).findByText('Launched', {}, { timeout: 3000 })
    // The existing hand-off: onLaunched -> job-id tracking -> JobStatusLine.
    await within(finalise).findByText(/job #7001/, {}, { timeout: 3000 })

    await waitFor(
      () => expect(within(rail()).getByRole('button', { name: 'Design' })).toBeTruthy(),
      { timeout: 5000 },
    )
  })

  it('T3: a FAILING terminal state (run_failed) also clears busy, and surfaces the failure rather than clearing silently', async () => {
    const wl = offFlowWorkload()
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true, degraded: false, scope: [], workloads: [wl], invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.match(/\/api\/catalog\/crosspoint\/teardown$/)) {
          return json({
            operation_id: 'op-t3', action: 'teardown', target: 'crosspoint', state: 'waking',
            job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-t3',
          })
        }
        if (url.endsWith('/api/operations/op-t3')) {
          // Never observed at `launched` either — same missed-transient
          // shape as T1, but this time the operation failed.
          return json({
            operation_id: 'op-t3', action: 'teardown', target: 'crosspoint', state: 'run_failed',
            job_id: 9002, error: 'ansible-timeout', created_at: 't0', updated_at: 't1',
          })
        }
        return json({})
      }),
    )

    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const finalise = stageSection('Finalise & Review')
    await within(finalise).findByRole('button', { name: /Teardown/ })
    armAndConfirmTeardown(finalise)

    await waitFor(() => expect(within(rail()).queryByRole('button', { name: 'Design' })).toBeNull())
    expect(within(finalise).queryByText('Launched')).toBeNull()

    // Busy clears — same recovery as a clean run_complete.
    await waitFor(
      () => expect(within(rail()).getByRole('button', { name: 'Design' })).toBeTruthy(),
      { timeout: 5000 },
    )
    // Art. 1: never a fake success — the operator can still see it failed.
    // (Plain textContent, not an RTL text query — see T1's identical note.)
    await waitFor(() =>
      expect(finalise.textContent).toContain('Teardown of crosspoint did not complete — ansible-timeout'),
    )
    expect(finalise.textContent).not.toContain('Teardown of crosspoint completed.')
  })
})

describe('OperationStatusLine: every real terminal state renders an actual label, not a blank one', () => {
  function renderLine(state: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({
        operation_id: 'op-label', action: 'teardown', target: 'crosspoint', state,
        job_id: 1, error: null, created_at: 't0', updated_at: 't0',
      })),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <OperationStatusLine operationId="op-label" onLaunched={() => {}} onError={() => {}} />
      </QueryClientProvider>,
    )
  }

  it.each([
    ['run_complete', 'Complete'],
    ['run_failed', 'Failed'],
    ['failed_rollback_required', 'Rollback required'],
    ['rollback_incomplete', 'Rollback incomplete'],
    ['run_status_unknown', 'Status unknown'],
  ])('T4: %s renders "%s", not blank space next to the operation id', async (state, label) => {
    renderLine(state)
    // Without an OPERATION_LABEL entry for this state, the label span
    // renders nothing — this is the old symptom (operation id, then blank
    // space) — so finding the real label text is what discriminates it.
    expect(await screen.findByText(label)).toBeTruthy()
  })
})
