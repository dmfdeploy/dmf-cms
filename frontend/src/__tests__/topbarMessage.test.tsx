/**
 * The topbar's transient-message surface (GATE-D1 P2.4): a producer emits a
 * brief echo of a job lifecycle moment, it renders inside the aria-live
 * region, and it self-expires — never the authoritative outcome (that stays
 * anchored at the acting stage, Constitution Art. 2), just a courtesy echo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Topbar from '../components/Topbar'
import { useAuthStore } from '../store/auth'
import { useTopbarMessageStore } from '../store/topbarMessage'
import type { UserIdentity } from '../api/types'

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderTopbar() {
  useAuthStore.getState().setUser(identity())
  vi.stubGlobal('fetch', vi.fn(async () => json({})))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Topbar />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function messageRegion(): HTMLElement {
  return screen.getByRole('status')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  useAuthStore.getState().setUser(null)
  // Reset the store to a clean slate between tests — it has no reset action
  // of its own (there is exactly one producer pattern: emit), so poke the
  // internal setState directly.
  useTopbarMessageStore.setState({ message: null })
})

describe('a producer-emitted message renders in the topbar region', () => {
  it('shows the emitted text inside the aria-live=polite status region', () => {
    renderTopbar()
    expect(messageRegion().textContent).toBe('')

    act(() => {
      useTopbarMessageStore.getState().emit('Configure job for studio-a started')
    })

    const region = messageRegion()
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toBe('Configure job for studio-a started')
  })
})

describe('the message self-expires', () => {
  it('clears itself after its TTL with no further action from the producer', () => {
    vi.useFakeTimers()
    renderTopbar()

    act(() => {
      useTopbarMessageStore.getState().emit('Provision job for studio-a completed')
    })
    expect(messageRegion().textContent).toBe('Provision job for studio-a completed')

    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    expect(messageRegion().textContent).toBe('')
  })

  it('a newer message is never clobbered by an older one\'s expiry', () => {
    vi.useFakeTimers()
    renderTopbar()

    act(() => {
      useTopbarMessageStore.getState().emit('first message')
    })
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    act(() => {
      useTopbarMessageStore.getState().emit('second message')
    })
    // The first message's own expiry timer fires here (6s after ITS emit,
    // i.e. 3s after the second one started) — it must not clear the second.
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(messageRegion().textContent).toBe('second message')
  })
})
