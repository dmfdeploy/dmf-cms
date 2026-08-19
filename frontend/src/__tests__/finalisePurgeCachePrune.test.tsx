/**
 * dmfdeploy#418 FIX ROUND 2 (P2, adversarial gate — mutation-proven gap).
 * The purge terminal effect's own synchronous cache write (P1-2, round 1:
 * FinaliseStage.tsx's `queryClient.setQueryData` filtering this workload's
 * slug out of ['media-workloads-grouped'] once `purge_verified_at` lands)
 * had ZERO test coverage before this file existed — proven, not assumed:
 * deleting that write entirely and re-running workloadSetupLeavingGuard.
 * test.tsx (2/2) plus every other touched/new test file at the time (12/12)
 * still passed. The reason, located rather than guessed: that suite's own
 * delete-permanently test either discards the QueryClient `renderSetup()`
 * returns, or — even when it's captured — the P1-1 guard freezes
 * WorkloadWizard on the OLD `{workload, groupedRead}` snapshot the instant
 * `onLeaveFlow()` fires (the same synchronous handler as the cache write),
 * so the invalidated refetch's own eventual settle can never reach a render
 * that would expose whether the write happened at all — the guard, working
 * exactly as designed, incidentally hides the one write it doesn't itself
 * test.
 *
 * THE APPROACH sidesteps both problems by never going through
 * WorkloadSetup/WorkloadWizard at all — FinaliseStage is mounted in
 * isolation (finalisePurgeProvenance.test.tsx's own pattern, same file's
 * reasoning for why that's a clean, unraced render), with a QueryClient
 * PRE-SEEDED with a realistic ['media-workloads-grouped'] payload before
 * render. There is no `leavingFlowRef` freeze anywhere in this tree to hide
 * behind, and no active OBSERVER of that query key either (FinaliseStage
 * itself never subscribes to it — only WorkloadSetup/WorkloadWizard do), so
 * `invalidateQueries` here marks it stale with nothing to refetch and
 * nothing to race: this test reads `queryClient.getQueryData` directly,
 * straight off the SAME synchronous write the production effect performs,
 * with no timing dependency on anything at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import FinaliseStage from '../pages/MediaWorkloads/stages/FinaliseStage'
import type { MediaWorkload, MediaWorkloadsGroupedResponse, UserIdentity } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

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

// Matches finalisePurgeProvenance.test.tsx's own fixture shape.
function purgeEligibleWorkload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [],
    functions: [],
  }
}

// A second, UNTOUCHED workload in the same seeded cache payload — proves the
// write is a targeted per-slug filter, not a wholesale cache wipe that would
// vacuously "pass" a looser assertion (e.g. `workloads.length === 0`).
function siblingWorkload(): MediaWorkload {
  return {
    slug: 'studio-b',
    name: 'studio-b',
    lifecycle: 'operate',
    health: 'ok',
    instances: [],
    functions: [],
  }
}

function renderIsolated(workload: MediaWorkload, queryClient: QueryClient) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FinaliseStage
          workload={workload}
          state="available"
          actions={['delete-permanently']}
          onBusyChange={() => {}}
          lastSwitchResult={null}
          onJobStart={() => {}}
          user={OPERATOR}
          onLeaveFlow={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('FinaliseStage: the purge-completion cache prune, isolated from any observer or navigation guard', () => {
  it('filters ONLY this workload out of the cached grouped-inventory payload once purge_verified_at lands', async () => {
    const workload = purgeEligibleWorkload()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const seeded: MediaWorkloadsGroupedResponse = {
      configured: true,
      degraded: false,
      scope: [],
      workloads: [workload, siblingWorkload()],
      invalid_instances: [],
    }
    // Pre-seeded BEFORE render, standing in for a grouped read some OTHER
    // mounted consumer (WorkloadSetup, the collection view, ...) already
    // populated — this test's whole point is what the terminal effect does
    // to that shared cache entry, in isolation from whoever populated it.
    queryClient.setQueryData<MediaWorkloadsGroupedResponse>(['media-workloads-grouped'], seeded)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.match(/\/api\/media-workloads\/studio-a\/purge$/) && (init?.method ?? 'GET') === 'POST') {
          return json({
            operation_id: 'op-cp-1', action: 'finalise-purge', target: 'studio-a', state: 'launching',
            job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-purge-cp-1',
          })
        }
        if (url.endsWith('/api/operations/op-cp-1')) {
          return json({
            operation_id: 'op-cp-1', action: 'finalise-purge', target: 'studio-a', state: 'run_complete',
            job_id: 4242, error: null, l3_outcome: 'success', purge_verified_at: '2026-08-19T12:00:00Z',
            created_at: 't0', updated_at: 't1',
          })
        }
        // /api/catalog and anything else this component reads incidentally.
        return json({})
      }),
    )

    renderIsolated(workload, queryClient)

    fireEvent.click(await screen.findByRole('button', { name: '🗑 Delete permanently' }))
    fireEvent.change(screen.getByPlaceholderText(/Reason \(required/), { target: { value: 'confirmed clean' } })
    fireEvent.change(screen.getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    // Proves the terminal effect actually ran to completion (the SAME
    // synchronous block that performs the cache write) before inspecting
    // the cache below — same discipline as finalisePurgeProvenance.test.tsx.
    await waitFor(() => expect(screen.getByText(/Deleted permanently — confirmed absent/)).toBeTruthy())

    const cached = queryClient.getQueryData<MediaWorkloadsGroupedResponse>(['media-workloads-grouped'])
    expect(cached?.workloads.find((w) => w.slug === 'studio-a')).toBeUndefined()
    // The untouched sibling survives — this was a targeted filter.
    expect(cached?.workloads.find((w) => w.slug === 'studio-b')).toBeTruthy()
  })
})
