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
import { act, cleanup, render, screen } from '@testing-library/react'
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
  vi.useRealTimers()
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

  // umbrella #432 §F fix-round 3 (codex gate): the title and the badge used
  // to be TWO independent jobOutcome(job.status) reads (one inside
  // describeJob, one in this widget) — they always agreed for the 5 known
  // outcome words, but an empty status (the backend's own default for a
  // missing AWX status) made them diverge: title "Queued to remove X",
  // badge "Unknown", same job, same row. This is the exact reachable case,
  // rendered end-to-end through the real widget rather than asserted only
  // against describeJob in isolation.
  it('never lets the title and badge disagree, even for an empty/unrecognised status', async () => {
    renderWidget({
      jobs: [
        {
          id: 202,
          name: 'media-finalise-mxl-videotest-view',
          status: '',
          started: null,
          finished: null,
          elapsed: 0,
          failed: false,
        },
      ],
      reason: '',
    })
    // Exactly two: the title ("Unknown — MXL Test-Pattern Viewer") and the
    // badge ("Unknown") — the same word, not a guessed tense on one side.
    const matches = await screen.findAllByText(/Unknown/)
    expect(matches.length).toBe(2)
    expect(screen.queryByText(/^Queued/)).toBeNull()
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

  // fix-round 4 (PR #81, codex sibling sweep): classifyChanges only treated
  // isError as authoritative when NO data was ever retained
  // (`isError && !q.data`). TanStack Query retains the last-good `jobs`
  // across a failed background refetch — isLoading settles false, isError
  // flips true, and the retained rows kept rendering with NO notice at
  // all, presenting last-good data as current after the poll that would
  // have confirmed it had failed. Hold-then-reject, not first-load: the
  // first fetch succeeds (real retained data) before the second rejects.
  it('a settled failed refetch keeps retained jobs visible but adds a notice — never silently current', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) {
          return new Response(
            JSON.stringify({
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
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('boom', { status: 500 })
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RecentChanges />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // First (successful, non-empty) read settles. Fake timers active, so
    // settle() + getBy*, never findBy* (findBy* waits on real timers).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('media-launch-mxl-videotestsrc')).toBeTruthy()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()

    // Advance past useChangesJobs' 30s refetchInterval so the background
    // refetch fires and rejects, while the old (successful, non-empty)
    // data stays retained.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100)
    })

    // Retained job STILL shown (Art. 5: the screen stays still) — but now
    // qualified by a notice, not silently presented as current.
    expect(screen.getByText('media-launch-mxl-videotestsrc')).toBeTruthy()
    expect(screen.getByText('Recent changes could not be loaded. Retrying automatically.')).toBeTruthy()
  })
})
