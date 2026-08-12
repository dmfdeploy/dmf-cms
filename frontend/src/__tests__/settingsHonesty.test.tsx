/**
 * Settings.tsx — useCurrentUser retained-error + unauthenticated-vs-failed
 * honesty (fix-round 7, PR #81, umbrella #385 codex gate).
 *
 *  - `!user` alone used to be the WHOLE gate for "Not authenticated" — a
 *    genuine 401 (real) and any OTHER failed read (a transient 500/network
 *    error) rendered identically.
 *  - A settled failed BACKGROUND refetch that retained `user` from an
 *    earlier successful mount rendered the whole stale profile with no
 *    notice at all that the current read had failed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Settings from '../pages/Settings'
import type { UserIdentity } from '../api/types'

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops Operator',
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { queryClient, ...render(<QueryClientProvider client={queryClient}><Settings /></QueryClientProvider>) }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Settings: a genuine 401 reads as "Not authenticated"; any other failure does not', () => {
  it('a real 401 (no session) reads as Not authenticated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized' }, 401)))
    renderSettings()
    expect(await screen.findByText('Not authenticated')).toBeTruthy()
  })

  it('a 500 / transient read failure does NOT claim "Not authenticated" — it says the read failed', async () => {
    // fix-round 8 (codex mutation-test find): a body that fails to parse as
    // JSON at all (`new Response('boom', { status: 500 })`) throws a plain
    // SyntaxError out of apiCall — `error instanceof APIError` is ALREADY
    // false for that reason alone, so this assertion would pass even with
    // the `.status === 401` check itself removed or mutated. A real,
    // well-formed 500 (apiCall's normal error shape) is required to
    // actually exercise that check.
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)))
    renderSettings()
    expect(
      await screen.findByText('Your account could not be read right now. Reload the page to try again.'),
    ).toBeTruthy()
    expect(screen.queryByText('Not authenticated')).toBeNull()
  })
})

describe('Settings: a settled failed refetch keeps the retained profile visible but adds a notice', () => {
  it('never silently presents a stale profile as current', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) return json(identity())
        return json({ error: 'boom' }, 500)
      }),
    )
    const { queryClient } = renderSettings()

    // First (successful) read settles — genuinely current, no notice.
    expect(await screen.findByText('Ops Operator')).toBeTruthy()
    expect(screen.queryByText(/Could not be refreshed/)).toBeNull()

    // Trigger the background refetch a poll/refocus/invalidation would
    // cause; useCurrentUser has no refetchInterval, so this is driven
    // directly rather than by advancing a timer (established pattern for
    // un-polled hooks elsewhere in this arc).
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['user'] })
    })

    await waitFor(() => {
      // The retained profile is STILL shown (Art. 5) — the operator's own
      // name doesn't vanish just because the latest background read failed.
      expect(screen.getByText('Ops Operator')).toBeTruthy()
      expect(
        screen.getByText('Could not be refreshed just now — showing the last successful read. Reload the page to try again.'),
      ).toBeTruthy()
    })
    // Never re-labelled as unauthenticated — the operator IS still signed
    // in, only the latest confirmation read failed.
    expect(screen.queryByText('Not authenticated')).toBeNull()
  })
})
