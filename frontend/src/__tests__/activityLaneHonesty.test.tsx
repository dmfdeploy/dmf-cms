/**
 * Activity's two lanes, degraded-read honesty (hard gate 1, umbrella #385).
 *
 * Both lanes had the same shape the Media Workloads list page was fixed for
 * (mediaWorkloadsGrid.test.tsx's "degraded-read honesty" describe): an empty
 * or errored read rendered identically to a genuinely empty one.
 *
 *  - Jobs lane: AWX IS configured (the "not configured" branch already
 *    handles that honestly), but the read itself fails — react-query's own
 *    `isError`, never checked before this fix — and the template list was
 *    empty by construction, so it read as "No workflows available".
 *  - History lane: /api/changes/commits and /api/changes/pulls used to
 *    answer "Forgejo not configured" with a bare empty array (see
 *    api_changes_commits's docstring) — indistinguishable from Forgejo
 *    genuinely having nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import JobsLane from '../pages/Activity/JobsLane'
import HistoryLane from '../pages/Activity/HistoryLane'
import type { UserIdentity } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'engineer',
    real_role: 'engineer',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
}

function renderWithQuery(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Jobs lane: a failed read is not "No workflows available"', () => {
  it('renders an honest retry message when AWX is configured but the read errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(identity())
        if (url.endsWith('/api/workflows')) return json({ error: 'boom' }, 500)
        return json({})
      }),
    )
    renderWithQuery(<JobsLane />)

    expect(await screen.findByText(/Workflows could not be loaded right now/)).toBeTruthy()
    expect(screen.queryByText('No workflows available')).toBeNull()
  })

  it('still renders the genuine empty state when AWX answers with zero templates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(identity())
        if (url.endsWith('/api/workflows')) return json({ templates: [] })
        return json({})
      }),
    )
    renderWithQuery(<JobsLane />)

    expect(await screen.findByText('No workflows available')).toBeTruthy()
  })
})

describe('History lane: Forgejo commits/pulls degraded-read honesty', () => {
  function mkFetch(routes: { commits?: unknown; pulls?: unknown }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: 'awx-unconfigured' })
        if (url.endsWith('/api/changes/commits')) return json(routes.commits ?? { repos: [], reason: '' })
        if (url.endsWith('/api/changes/pulls')) return json(routes.pulls ?? { pulls: [], reason: '' })
        return json({})
      }),
    )
  }

  it('a not-configured Forgejo reads as "not configured", never a claimed-empty history', async () => {
    mkFetch({
      commits: { repos: [], reason: 'forgejo-unconfigured' },
      pulls: { pulls: [], reason: 'forgejo-unconfigured' },
    })
    renderWithQuery(<HistoryLane />)

    expect(
      await screen.findAllByText(
        'Source control is not configured in this environment — an administrator can connect it to show recent commits and pull requests here.',
      ),
    ).toHaveLength(2)
    expect(screen.queryByText('No recent commits')).toBeNull()
    expect(screen.queryByText('No recent pull requests')).toBeNull()
  })

  it('an unreachable Forgejo reads as unreachable, never a silent/false empty', async () => {
    mkFetch({
      commits: { repos: [], reason: 'forgejo-unreachable' },
      pulls: { pulls: [], reason: 'forgejo-unreachable' },
    })
    renderWithQuery(<HistoryLane />)

    expect(
      await screen.findByText('Source control is unreachable — recent commits cannot be read right now. Retrying automatically.'),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Source control is unreachable — recent pull requests cannot be read right now. Retrying automatically.',
      ),
    ).toBeTruthy()
  })

  it('a genuinely empty, successful read still says "No recent commits" / "No pull requests"', async () => {
    mkFetch({ commits: { repos: [], reason: '' }, pulls: { pulls: [], reason: '' } })
    renderWithQuery(<HistoryLane />)

    expect(await screen.findByText('No recent commits')).toBeTruthy()
    expect(screen.getByText('No recent pull requests')).toBeTruthy()
  })

  // fix-round P1-2 (PR #81, second pass): the first pass only ever called
  // forgejoEmptyCopy INSIDE the length===0 branch, so a partial read that
  // still retained rows (the common case — some repos succeeded) rendered
  // those rows with no incompleteness notice at all, looking exactly as
  // authoritative as a fully successful read. The earlier version of this
  // test made BOTH panels partial at once and only checked the repo header,
  // which is what let it pass without ever exercising the commits panel's
  // own partial notice — split into two, one per panel, each asserting the
  // notice renders ALONGSIDE real retained rows, not just in its absence.
  it('a partial commits read shows retained rows AND a visible incompleteness notice', async () => {
    mkFetch({
      commits: {
        repos: [{ name: 'dmfdeploy/dmf-cms', commits: [] }],
        reason: 'forgejo-partial',
      },
      pulls: { pulls: [], reason: '' },
    })
    renderWithQuery(<HistoryLane />)

    expect(await screen.findByText('dmfdeploy/dmf-cms')).toBeTruthy()
    expect(
      await screen.findByText('Some repositories could not be read — recent commits may be incomplete. Retrying automatically.'),
    ).toBeTruthy()
  })

  it('a partial pulls read shows retained rows AND a visible incompleteness notice', async () => {
    mkFetch({
      commits: { repos: [], reason: '' },
      pulls: {
        pulls: [{ repo: 'dmfdeploy/dmf-cms', number: 1, title: 't', state: 'open', author: 'a', created: '', url: '' }],
        reason: 'forgejo-partial',
      },
    })
    renderWithQuery(<HistoryLane />)

    expect(await screen.findByText('t')).toBeTruthy()
    expect(
      await screen.findByText(
        'Some repositories could not be read — recent pull requests may be incomplete. Retrying automatically.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText('No pull requests')).toBeNull()
    expect(screen.queryByText('No recent pull requests')).toBeNull()
  })

  it('a partial-but-empty read shows the incompleteness notice alone, never a contradicting "No recent ..."', async () => {
    mkFetch({
      commits: { repos: [], reason: 'forgejo-partial' },
      pulls: { pulls: [], reason: '' },
    })
    renderWithQuery(<HistoryLane />)

    expect(
      await screen.findByText('Some repositories could not be read — recent commits may be incomplete. Retrying automatically.'),
    ).toBeTruthy()
    expect(screen.queryByText('No recent commits')).toBeNull()
  })

  // fix-round P2-3: a settled failed refetch must win over TanStack Query's
  // retained prior-success data — hold-then-reject, not first-load (see the
  // matching pins in mediaWorkloadsGrid.test.tsx and facility.test.tsx).
  it('a settled failed refetch overrides a retained "No recent commits" — never re-states it', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: 'awx-unconfigured' })
        if (url.endsWith('/api/changes/pulls')) return json({ pulls: [], reason: '' })
        if (url.endsWith('/api/changes/commits')) {
          calls += 1
          if (calls === 1) return json({ repos: [], reason: '' })
          return new Response('boom', { status: 500 })
        }
        return json({})
      }),
    )
    renderWithQuery(<HistoryLane />)

    // First (successful, genuinely empty) read settles. Fake timers active,
    // so settle() + getBy*, never findBy* (findBy* waits on real timers).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('No recent commits')).toBeTruthy()

    // Advance past useChangesCommits' 30s refetchInterval so the background
    // refetch fires and rejects, while the old (empty, reason: "") data
    // stays retained.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100)
    })

    expect(screen.getByText('Recent commits could not be loaded. Retrying automatically.')).toBeTruthy()
    expect(screen.queryByText('No recent commits')).toBeNull()
  })

  // fix-round 3 (PR #81): the empty-only hold-then-reject test above passed
  // even before this round's fix, because an EMPTY retained payload already
  // fell through to the (correct) empty-branch copy. The actual gap the
  // reviewer found only shows with NON-EMPTY retained rows: the commits/
  // pulls panels only ever showed a notice for the 'partial' phase, so a
  // settled failed refetch that retained real rows rendered them with NO
  // notice at all — indistinguishable from a fully current, successful
  // read. Both panels covered here, each seeding one real row before the
  // refetch that rejects.
  it('a settled failed refetch keeps retained COMMIT rows visible but adds a notice — never silently current', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: 'awx-unconfigured' })
        if (url.endsWith('/api/changes/pulls')) return json({ pulls: [], reason: '' })
        if (url.endsWith('/api/changes/commits')) {
          calls += 1
          if (calls === 1) {
            return json({
              repos: [
                {
                  name: 'dmfdeploy/dmf-cms',
                  commits: [
                    { sha_short: 'abc1234', message: 'fix: x', author: 'a', date: '2026-08-01T00:00:00Z', url: '' },
                  ],
                },
              ],
              reason: '',
            })
          }
          return new Response('boom', { status: 500 })
        }
        return json({})
      }),
    )
    renderWithQuery(<HistoryLane />)

    // First (successful, non-empty) read settles — the row is present with
    // no notice, a genuinely current read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('dmfdeploy/dmf-cms')).toBeTruthy()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()

    // The background refetch fires and rejects; TanStack Query retains the
    // prior successful `data` (isLoading settles false, the row stays).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100)
    })

    // The retained row is STILL shown (Art. 5: the screen stays still) —
    // but it must now be qualified: the read that would have confirmed it
    // failed, and that must be visible alongside it, not silently absent.
    expect(screen.getByText('dmfdeploy/dmf-cms')).toBeTruthy()
    expect(screen.getByText('Recent commits could not be loaded. Retrying automatically.')).toBeTruthy()
  })

  it('a settled failed refetch keeps retained PULL ROWS visible but adds a notice — never silently current', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: 'awx-unconfigured' })
        if (url.endsWith('/api/changes/commits')) return json({ repos: [], reason: '' })
        if (url.endsWith('/api/changes/pulls')) {
          calls += 1
          if (calls === 1) {
            return json({
              pulls: [{ repo: 'dmfdeploy/dmf-cms', number: 1, title: 't', state: 'open', author: 'a', created: '', url: '' }],
              reason: '',
            })
          }
          return new Response('boom', { status: 500 })
        }
        return json({})
      }),
    )
    renderWithQuery(<HistoryLane />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('t')).toBeTruthy()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100)
    })

    expect(screen.getByText('t')).toBeTruthy()
    expect(screen.getByText('Recent pull requests could not be loaded. Retrying automatically.')).toBeTruthy()
  })
})
