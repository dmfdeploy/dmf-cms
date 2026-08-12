/**
 * Admin page — retained-error honesty (fix-round 5, PR #81, codex sibling
 * sweep). None of users/groups/health checked `isError` anywhere:
 *  - Users (People/Machine identities): a failed read rendered "No people" /
 *    "No machine identities", or kept a retained roster with no notice.
 *  - Groups: same shape, plus a per-group member COUNT claim.
 *  - Integration Health: Connected/Disconnected + latency/user/template
 *    counts rendered as current off retained data with no isError check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Admin from '../pages/Admin'
import type { AdminUser } from '../api/types'

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    username: 'alice',
    display_name: 'Alice Human',
    email: 'alice@dmf.example.com',
    role: 'operator',
    last_login: null,
    is_active: true,
    user_type: 'human',
    is_break_glass: false,
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderAdmin(routes: { users?: unknown; usersStatus?: number; groups?: unknown; health?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/admin/users')) return json(routes.users ?? { users: [] }, routes.usersStatus ?? 200)
      if (url.endsWith('/api/admin/groups')) return json(routes.groups ?? { groups: [] })
      if (url.endsWith('/api/admin/health')) return json(routes.health ?? {})
      return json({})
    }),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Admin />
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

describe('Admin — Users roster honesty', () => {
  it('a failed users read with no data at all names the real cause, never "No people"', async () => {
    renderAdmin({ usersStatus: 500 })
    expect(await screen.findAllByText('Could not be read right now. Reload the page to try again.')).toHaveLength(2)
    expect(screen.queryByText('No people')).toBeNull()
    expect(screen.queryByText('No machine identities')).toBeNull()
  })

  it('the genuine empty state still says "No people" when the read succeeds with nothing', async () => {
    renderAdmin({ users: { users: [] } })
    expect(await screen.findByText('No people')).toBeTruthy()
  })
})

describe('Admin — Groups honesty', () => {
  it('a failed groups read names the real cause, never "No groups"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/admin/users')) return json({ users: [user()] })
        if (url.endsWith('/api/admin/groups')) return new Response('boom', { status: 500 })
        if (url.endsWith('/api/admin/health')) return json({})
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Admin />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Groups could not be read right now. Retrying automatically.')).toBeTruthy()
    expect(screen.queryByText('No groups')).toBeNull()
  })
})

describe('Admin — Integration Health honesty', () => {
  it('a failed health read with no data at all names the real cause', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/admin/users')) return json({ users: [user()] })
        if (url.endsWith('/api/admin/groups')) return json({ groups: [] })
        if (url.endsWith('/api/admin/health')) return new Response('boom', { status: 500 })
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Admin />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Integration status could not be read right now. Retrying automatically.')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
  })
})

describe('Admin — hold-then-reject (settled error over retained data)', () => {
  it('a settled failed users refetch keeps the retained roster visible but adds a notice', async () => {
    // No fake timers here: useAdminUsers has no refetchInterval, so the
    // refetch below is triggered directly via queryClient.refetchQueries,
    // and the final assertion uses waitFor on real timers to await the
    // resulting re-render (same approach as designStage.test.tsx's
    // equivalent topology-refetch pin).
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/admin/users')) {
          calls += 1
          if (calls === 1) return json({ users: [user()] })
          return new Response('boom', { status: 500 })
        }
        if (url.endsWith('/api/admin/groups')) return json({ groups: [] })
        if (url.endsWith('/api/admin/health')) return json({})
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Admin />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // First (successful) read settles.
    expect(await screen.findByText('alice')).toBeTruthy()
    expect(screen.queryByText(/could not be refreshed/)).toBeNull()

    // useAdminUsers has no refetchInterval, so trigger the equivalent of a
    // background refetch (e.g. a window refocus) directly on the client.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['admin', 'users'] })
    })

    // Retained roster STILL shown (Art. 5) — now qualified by a notice.
    // People had a retained user, so its table names the read as merely
    // unrefreshed; Machine identities never had one, so its own (correctly
    // narrower) claim is "could not be read" for that partition, not a
    // false "showing the last successful read" it never had.
    // waitFor: the observer's re-render notification can land a tick after
    // the refetch promise itself settles.
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeTruthy()
      expect(
        screen.getByText('Could not be refreshed just now — showing the last successful read. Reload the page to try again.'),
      ).toBeTruthy()
      expect(screen.getByText('Could not be read right now. Reload the page to try again.')).toBeTruthy()
    })
  })

  it('a settled failed health refetch keeps the retained status visible but adds a notice', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/admin/users')) return json({ users: [user()] })
        if (url.endsWith('/api/admin/groups')) return json({ groups: [] })
        if (url.endsWith('/api/admin/health')) {
          calls += 1
          if (calls === 1) return json({ netbox: { connected: true, latency_ms: 12 } })
          return new Response('boom', { status: 500 })
        }
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Admin />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.queryByText(/could not be refreshed/)).toBeNull()

    // Advance past useAdminHealth's 30s refetchInterval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100)
    })

    expect(screen.getByText('Connected')).toBeTruthy()
    expect(
      screen.getByText('Could not be refreshed just now — showing the last successful read. Retrying automatically.'),
    ).toBeTruthy()
  })
})
