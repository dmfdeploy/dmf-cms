/**
 * "Recent changes" degraded states (dmfdeploy/dmfdeploy#285).
 *
 * The widget used to render one generic "temporarily unavailable. Retrying
 * automatically." for every backend failure, and "No recent changes
 * recorded" when AWX was merely unconfigured — the first reads as a console
 * bug, the second asserts AWX answered when it did not. The backend is now
 * fail-soft (always 200 + a reason token) and every state is designed.
 *
 * Load-bearing wording check: a refused connection proves AWX is not
 * accepting connections, NOT that it was deliberately put to sleep. The copy
 * must never say "asleep" (Constitution Art. 1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import RecentChanges from '../pages/Workspace/RecentChanges'
import { classifyChanges, changesEmptyCopy } from '../lib/changesState'
import type { AdminJobsResponse } from '../api/types'

function renderWidget(body: AdminJobsResponse | { status: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if ('status' in body && typeof body.status === 'number') {
        return new Response(JSON.stringify({ error: 'boom' }), {
          status: body.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RecentChanges />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('classifyChanges', () => {
  const base = { isLoading: false, isError: false }

  it('maps each backend token to its own phase', () => {
    expect(classifyChanges({ ...base, data: { jobs: [], reason: '' } }).phase).toBe('ok')
    expect(classifyChanges({ ...base, data: { jobs: [], reason: 'awx-not-running' } }).phase).toBe('not-running')
    expect(classifyChanges({ ...base, data: { jobs: [], reason: 'awx-unreachable' } }).phase).toBe('unreachable')
    expect(classifyChanges({ ...base, data: { jobs: [], reason: 'awx-unconfigured' } }).phase).toBe('unconfigured')
  })

  it('treats a payload with no reason field as ok (older payloads/fixtures)', () => {
    expect(classifyChanges({ ...base, data: { jobs: [] } }).phase).toBe('ok')
  })

  it('reports a genuine console API failure as error', () => {
    expect(classifyChanges({ isLoading: false, isError: true }).phase).toBe('error')
  })

  it('reports loading only before any data arrives', () => {
    expect(classifyChanges({ isLoading: true, isError: false }).phase).toBe('loading')
    expect(classifyChanges({ isLoading: true, isError: false, data: { jobs: [], reason: '' } }).phase).toBe('ok')
  })
})

describe('changesEmptyCopy', () => {
  it('never claims AWX is asleep — we cannot know that', () => {
    // The only authoritative discriminator is spec.replicas, which the
    // console does not read. Guard the wording, not just the token.
    for (const phase of ['not-running', 'unreachable', 'unconfigured', 'error', 'ok'] as const) {
      expect(changesEmptyCopy(phase).toLowerCase()).not.toContain('asleep')
      expect(changesEmptyCopy(phase).toLowerCase()).not.toContain('sleep')
    }
  })

  it('gives every phase distinct copy', () => {
    const all = (['not-running', 'unreachable', 'unconfigured', 'error', 'ok'] as const).map(changesEmptyCopy)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('RecentChanges widget states', () => {
  it('renders the honest not-running state, not a console fault', async () => {
    renderWidget({ jobs: [], reason: 'awx-not-running' })
    expect(await screen.findByText(/Facility automation is not running/)).toBeTruthy()
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull()
    expect(screen.queryByText(/No recent changes recorded/)).toBeNull()
  })

  it('renders unreachable as an honest error that keeps retrying', async () => {
    renderWidget({ jobs: [], reason: 'awx-unreachable' })
    expect(await screen.findByText(/Facility automation is unreachable/)).toBeTruthy()
    expect(screen.getByText(/Retrying automatically/)).toBeTruthy()
  })

  it('renders unconfigured as such, never as "no changes recorded"', async () => {
    renderWidget({ jobs: [], reason: 'awx-unconfigured' })
    expect(await screen.findByText(/Facility automation is not configured/)).toBeTruthy()
    expect(screen.queryByText(/No recent changes recorded/)).toBeNull()
  })

  it('only claims "no recent changes" when AWX actually answered', async () => {
    renderWidget({ jobs: [], reason: '' })
    expect(await screen.findByText(/No recent changes recorded/)).toBeTruthy()
  })

  it('still renders real runs when AWX answers with jobs', async () => {
    renderWidget({
      jobs: [
        {
          id: 101,
          name: 'media-launch-mxl-videotestsrc',
          status: 'successful',
          started: '2026-08-01T10:00:00Z',
          finished: '2026-08-01T10:01:00Z',
          elapsed: 60,
          failed: false,
        },
      ],
      reason: '',
    })
    expect(await screen.findByText('media-launch-mxl-videotestsrc')).toBeTruthy()
    expect(screen.queryByText(/Facility automation/)).toBeNull()
  })

  it('a genuine console API failure still degrades honestly', async () => {
    renderWidget({ status: 500 })
    expect(await screen.findByText(/Recent changes could not be loaded/)).toBeTruthy()
  })

  // umbrella #339 item 3: the S1 cut took Activity out of the nav, and this
  // header kept advertising it. The route stays URL-reachable — the link is
  // what goes, so assert on the link, not on the route.
  it('the header advertises no route into the nav-hidden Activity page', async () => {
    renderWidget({ jobs: [], reason: '' })
    expect(await screen.findByText('Recent changes')).toBeTruthy()
    expect(screen.queryByText(/Open Activity/)).toBeNull()
    expect(screen.queryByRole('link', { name: /Activity/ })).toBeNull()
  })
})
