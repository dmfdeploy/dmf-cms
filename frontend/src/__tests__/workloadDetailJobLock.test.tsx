/**
 * WorkloadDetail's OWN synchronous job-lock contract (GATE-D1 P1.1),
 * isolated from any stage's real mutation timing.
 *
 * WHY THIS IS A SEPARATE FILE WITH A MOCKED STAGE. The obvious test —
 * render the real ConfigureStage, fire a switch, assert immediately with no
 * `await`/`waitFor` — turned out NOT to discriminate: fireEvent's implicit
 * act() wrapping flushes the resulting cascade (state update -> stage
 * re-render -> its onBusyChange effect -> the parent's own setState)
 * synchronously enough, in this harness, that the busy flag was already
 * true by the time the assertion ran EVEN WITHOUT the fix. That made the
 * test pass for the wrong reason, which is worse than not having it.
 *
 * This file removes that ambiguity entirely: ConfigureStage is replaced
 * with a minimal fake that calls `onJobStart()` and NEVER calls
 * `onBusyChange` at all — no react-query mutation, no busy computation, no
 * effect anywhere in this test that could set the flag. If WorkloadDetail's
 * own `startJob` does not flip `switching` itself, `jobInFlight` can never
 * become true through any path this test exercises, and the rail would stay
 * live. That isolates the exact property the fix claims: the parent sets
 * its own busy flag in the SAME synchronous handler that starts the job,
 * independent of whatever the stage's own mutation library does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
import type { MediaWorkload, MediaWorkloadsGroupedResponse } from '../api/types'

vi.mock('../pages/MediaWorkloads/stages/ConfigureStage', () => ({
  default: ({ onJobStart }: { onJobStart: () => void }) => (
    <button type="button" onClick={onJobStart}>
      Fake start job
    </button>
  ),
}))

function workload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'operate',
    health: 'ok',
    instances: [],
    functions: [],
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mkFetch() {
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    workloads: [workload()],
    invalid_instances: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
      if (url.endsWith('/api/catalog')) return json({ entries: [] })
      if (url.endsWith('/api/facility/summary')) return json({ site_count: 0, device_count: 0, sites: [] })
      return json({})
    }),
  )
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/studio-a']}>
        <Routes>
          <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("WorkloadDetail's own job-lock contract, isolated from any stage's mutation timing (GATE-D1 P1.1)", () => {
  it('locks the rail on the SAME synchronous click that starts a job — no stage effect involved at all', async () => {
    mkFetch()
    renderDetail()
    const rail = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // Navigate to Configure (lifecycle=operate defaults to Finalise & Review).
    fireEvent.click(within(rail).getByRole('button', { name: 'Configure' }))

    // The fake stage's only behaviour: call onJobStart(). It never reports
    // busy on its own — nothing here could set jobInFlight except
    // WorkloadDetail's own startJob.
    fireEvent.click(await screen.findByRole('button', { name: 'Fake start job' }))

    // No await, no waitFor: this assertion runs on the exact render produced
    // by the click above.
    expect(within(rail).queryByRole('button', { name: 'Design' })).toBeNull()
    expect(within(rail).getAllByText(/A Configure job is in progress — wait for its outcome\./).length).toBeGreaterThan(0)
  })
})
