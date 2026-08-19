/**
 * dmfdeploy#418 FIX ROUND (P2, adversarial gate). finalisePurgeWedge.test.tsx
 * used to assert the confirmed-absent provenance text ("Deleted permanently
 * — confirmed absent…", sourced from the terminal Operation's own
 * `purge_verified_at`) mid-flight through a full WorkloadSetup render, on
 * the premise that navigate() being a synchronous call meant the route
 * committed — and this text stayed on screen — before anything else could
 * happen. That premise is false (P1-1's fix, FinaliseStage's own
 * onLeaveFlow): the text is now genuinely racing an in-flight route
 * transition in that context, so pinning it there would couple a test to
 * timing rather than to a contract.
 *
 * The contract itself — a genuine terminal success renders the provenance,
 * sourced from the backend's own field, never fabricated locally — still
 * deserves coverage. This file provides it by mounting FinaliseStage
 * DIRECTLY, deliberately outside anything that reacts to navigation: no
 * <Routes> tree means navigate() changes the in-memory history entry but
 * nothing here unmounts or re-renders as a result, so the render this test
 * observes is not raced against anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import FinaliseStage from '../pages/MediaWorkloads/stages/FinaliseStage'
import type { MediaWorkload, UserIdentity } from '../api/types'

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

// Purge-eligible on member state alone — matches finalisePurgeWedge.test.tsx's
// own fixture shape. `actions`/`state` below are handed to FinaliseStage
// directly rather than derived, since this test's whole point is to isolate
// FinaliseStage from the wizard that would normally compute them.
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

function renderIsolated(workload: MediaWorkload) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
          leaving={false}
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

describe('FinaliseStage: delete-permanently provenance, isolated from navigation', () => {
  it('renders confirmed-absent provenance sourced from the terminal operation\'s purge_verified_at', async () => {
    const workload = purgeEligibleWorkload()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.match(/\/api\/media-workloads\/studio-a\/purge$/) && (init?.method ?? 'GET') === 'POST') {
          expect(JSON.parse(init?.body as string)).toEqual({ confirm: 'studio-a', reason: 'confirmed clean' })
          return json({
            operation_id: 'op-1', action: 'finalise-purge', target: 'studio-a', state: 'launching',
            job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-purge-1',
          })
        }
        if (url.endsWith('/api/operations/op-1')) {
          return json({
            operation_id: 'op-1', action: 'finalise-purge', target: 'studio-a', state: 'run_complete',
            job_id: 4242, error: null, l3_outcome: 'success', purge_verified_at: '2026-08-03T12:00:00Z',
            created_at: 't0', updated_at: 't1',
          })
        }
        // /api/catalog and anything else this component reads incidentally.
        return json({})
      }),
    )

    renderIsolated(workload)

    fireEvent.click(await screen.findByRole('button', { name: '🗑 Delete permanently' }))
    fireEvent.change(screen.getByPlaceholderText(/Reason \(required/), { target: { value: 'confirmed clean' } })
    fireEvent.change(screen.getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(screen.getByText(/Deleted permanently — confirmed absent/)).toBeTruthy())
    expect(screen.getByText(/2026-08-03T12:00:00Z/)).toBeTruthy()

    // Still here — nothing in this tree reacted to navigate() by unmounting
    // FinaliseStage, so this render was never a race to observe.
    await act(async () => {})
    expect(screen.getByText(/Deleted permanently — confirmed absent/)).toBeTruthy()
  })
})
