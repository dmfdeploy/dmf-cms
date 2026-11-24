/**
 * Activity → History reads this browser's own action records from
 * localStorage (store/activity.ts), which is persisted and not validated on
 * read. A record whose action this version no longer records — such as
 * 'clear-for-deployment' from an earlier console — must not break the page,
 * and the records it does show stay visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import HistoryLane from '../pages/Activity/HistoryLane'
import { useActivityStore, type ConsoleActionRecord } from '../store/activity'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/audit/events')) {
        return json({
          reason: '',
          window: { known: true, seconds: 604800, reason: '' },
          capped: false,
          excluded: [],
          events: [],
        })
      }
      if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: '' })
      if (url.endsWith('/api/changes/commits')) return json({ repos: [], reason: '' })
      if (url.endsWith('/api/changes/pulls')) return json({ pulls: [], reason: '' })
      return json({})
    }),
  )
}

const OLD_RECORD = {
  request_id: 'req-old-clear',
  action: 'clear-for-deployment',
  target: 'mxl-a',
  reason: 'ready for demo',
  actor: 'ops',
  role: 'engineer',
  at: '2026-11-01T10:00:00.000Z',
  requested_state: 'active',
  previous_state: 'bootstrapped',
  reconcile_expectation: 'Desired state recorded.',
} as unknown as ConsoleActionRecord

const LAUNCH_RECORD: ConsoleActionRecord = {
  request_id: 'req-launch',
  action: 'launch',
  target: 'nightly-sync',
  reason: 'scheduled',
  actor: 'ops',
  role: 'operator',
  at: '2026-11-02T10:00:00.000Z',
  outcome: 'launched',
}

beforeEach(() => {
  window.localStorage.clear()
  stubFetch()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useActivityStore.setState({ records: [] })
})

describe('History lane with a stored record of an action this version does not record', () => {
  it('renders without crashing and still shows the records it knows', async () => {
    useActivityStore.setState({ records: [OLD_RECORD, LAUNCH_RECORD] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <HistoryLane />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Requested workflow launch: nightly-sync')).toBeTruthy()
    expect(screen.queryByText(/mxl-a/)).toBeNull()
    expect(screen.queryByText(/Desired state recorded/)).toBeNull()
  })
})
