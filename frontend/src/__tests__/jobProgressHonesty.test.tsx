/**
 * JobProgress.tsx — OperationStatusLine / JobStatusLine retained-error
 * honesty (fix-round 6, PR #81, umbrella #385 codex sweep). Both used to
 * destructure only `data` from their poll — a settled failed refetch that
 * retained the last-good state rendered it with no notice at all. This is
 * the canonical (shared, exported) implementation; JobsLane.tsx's and
 * Catalog/index.tsx's own copies of the same two lines got the identical
 * fix (same settleQuery primitive, same copy) — see finalisePurgeWedge
 * .test.tsx for FinaliseStage's third, non-JobProgress poller.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OperationStatusLine, JobStatusLine, OPERATION_LABEL, OPERATION_CLASS } from '../pages/MediaWorkloads/stages/JobProgress'
import { OPERATION_STATES } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderWithQuery(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { queryClient, ...render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>) }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('OperationStatusLine: a settled failed poll never silently keeps showing a stale state', () => {
  it('a healthy poll shows the state with no notice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      operation_id: 'op-1', action: 'launch', state: 'launching', job_id: null, error: null,
      created_at: 't0', updated_at: 't0',
    })))
    renderWithQuery(<OperationStatusLine operationId="op-1" onLaunched={() => {}} onError={() => {}} />)
    expect(await screen.findByText('Launching job')).toBeTruthy()
    expect(screen.queryByText(/Could not confirm/)).toBeNull()
  })

  it('a settled failed refetch keeps the retained state but adds a notice', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) {
          return json({
            operation_id: 'op-1', action: 'launch', state: 'launching', job_id: null, error: null,
            created_at: 't0', updated_at: 't0',
          })
        }
        return new Response('boom', { status: 500 })
      }),
    )
    const { queryClient } = renderWithQuery(
      <OperationStatusLine operationId="op-1" onLaunched={() => {}} onError={() => {}} />,
    )
    expect(await screen.findByText('Launching job')).toBeTruthy()

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['operation', 'op-1'] })
    })

    await waitFor(() => {
      expect(screen.getByText('Launching job')).toBeTruthy()
      expect(screen.getByText('Could not confirm — showing the last read, retrying')).toBeTruthy()
    })
  })

  it('a failed poll with no data ever retained reads as a named failure, not silence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    renderWithQuery(<OperationStatusLine operationId="op-2" onLaunched={() => {}} onError={() => {}} />)
    expect(await screen.findByText('Could not query operation status — retrying automatically')).toBeTruthy()
    expect(screen.queryByText('Querying operation status…')).toBeNull()
  })
})

describe('JobStatusLine: a settled failed poll never silently keeps showing a stale status', () => {
  it('a healthy poll shows the status with no notice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      job_id: 7, status: 'running', elapsed: 1.2, is_done: false,
    })))
    renderWithQuery(<JobStatusLine entryKey="k1" jobId={7} onComplete={() => {}} />)
    expect(await screen.findByText(/Running/)).toBeTruthy()
    expect(screen.queryByText(/Could not confirm/)).toBeNull()
  })

  it('a settled failed refetch keeps the retained status but adds a notice', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) return json({ job_id: 7, status: 'running', elapsed: 1.2, is_done: false })
        return new Response('boom', { status: 500 })
      }),
    )
    const { queryClient } = renderWithQuery(<JobStatusLine entryKey="k1" jobId={7} onComplete={() => {}} />)
    expect(await screen.findByText(/Running/)).toBeTruthy()

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['catalog-job', 'k1', 7] })
    })

    await waitFor(() => {
      expect(screen.getByText(/Running/)).toBeTruthy()
      expect(screen.getByText('Could not confirm — showing the last read, retrying')).toBeTruthy()
    })
  })

  it('a failed poll with no data ever retained reads as a named failure, not silence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    renderWithQuery(<JobStatusLine entryKey="k2" jobId={9} onComplete={() => {}} />)
    expect(await screen.findByText('Could not query job status — retrying automatically')).toBeTruthy()
    expect(screen.queryByText('Querying job status…')).toBeNull()
  })
})

describe('OPERATION_LABEL / OPERATION_CLASS: every OperationState has an entry (PR #127 review fix)', () => {
  // umbrella #499 / PR #127: `running` shipped in OperationState with no
  // entry in either table (both were `Record<string, string>`, a shape
  // TypeScript cannot check for missing keys). Both are now typed
  // `Record<OperationState, string>`, which turns a missing key into a
  // `tsc` build failure — but this repo's `npm test` (vitest) does not run
  // tsc (only `npm run build` does), so that compile-time guarantee alone
  // would never fail a plain test run. These two assertions iterate
  // OPERATION_STATES — the same array OperationState is derived FROM, not
  // a hand-copied list — so they stay a genuine "does the map cover the
  // union" check (not "do these three known strings exist") for every
  // state that exists today AND every state added in the future.
  it('OPERATION_LABEL has a non-empty label for every OperationState', () => {
    for (const state of OPERATION_STATES) {
      expect(OPERATION_LABEL[state], `missing OPERATION_LABEL entry for '${state}'`).toBeTruthy()
    }
  })

  it('OPERATION_CLASS has a non-empty style class for every OperationState', () => {
    for (const state of OPERATION_STATES) {
      expect(OPERATION_CLASS[state], `missing OPERATION_CLASS entry for '${state}'`).toBeTruthy()
    }
  })
})
