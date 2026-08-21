/**
 * umbrella #432 §B: the personal (avatar) menu in Topbar.tsx had no
 * dismissal path other than re-clicking the avatar button — no outside-click
 * handler, no Escape handler, no focus-out handler. Follows the same
 * pattern NotificationBell.tsx already uses for its dropdown
 * (ref-containment check on a document 'mousedown' listener, removed on
 * unmount), plus a 'keydown' listener for Escape, a 'focusout' listener on
 * the wrapper for keyboard tab-away, and closes on its own Settings link
 * click (the view-as buttons already closed it; Logout is a full page nav
 * so its state dies anyway). aria-expanded reflects open state; aria-haspopup
 * and role="menu"/"menuitem" are deliberately absent — see the source
 * comment for why (this is a disclosure, not an ARIA menu widget).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Topbar from '../components/Topbar'
import { useAuthStore } from '../store/auth'
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
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Topbar />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// getInitials('Ops') -> single word, name.slice(0, 2).toUpperCase() -> 'OP'.
function openMenu() {
  const avatarButton = screen.getByRole('button', { name: 'OP' })
  fireEvent.click(avatarButton)
  return avatarButton
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAuthStore.getState().setUser(null)
})

describe('Topbar personal menu dismissal (umbrella #432 §B)', () => {
  it('dismisses the menu on an outside click', () => {
    renderTopbar()
    openMenu()
    expect(screen.getByText('ops@dmf.example.com')).toBeTruthy()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByText('ops@dmf.example.com')).toBeNull()
  })

  it('dismisses the menu on Escape', () => {
    renderTopbar()
    openMenu()
    expect(screen.getByText('ops@dmf.example.com')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByText('ops@dmf.example.com')).toBeNull()
  })

  it('does not dismiss on a click inside the menu itself', () => {
    renderTopbar()
    openMenu()
    fireEvent.mouseDown(screen.getByText('ops@dmf.example.com'))

    expect(screen.getByText('ops@dmf.example.com')).toBeTruthy()
  })

  it('carries aria-expanded on the trigger but no aria-haspopup — this is a disclosure, not an ARIA menu', () => {
    renderTopbar()
    const avatarButton = screen.getByRole('button', { name: 'OP' })
    // aria-haspopup is deliberately absent (umbrella #432 §B ruling, round
    // 2): WAI-ARIA treats aria-haspopup="true" as EQUIVALENT to
    // aria-haspopup="menu", which would make exactly the promise the panel
    // doesn't keep (no menuitem children, no arrow-key/roving-tabindex
    // keyboard model — see Topbar.tsx's own comment).
    expect(avatarButton.getAttribute('aria-haspopup')).toBeNull()
    expect(avatarButton.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(avatarButton)

    expect(avatarButton.getAttribute('aria-expanded')).toBe('true')
    // Deliberately NO role="menu" on the panel and NO role="menuitem" on its
    // items either: role="menu" requires menuitem children and commits to
    // arrow-key/roving-tabindex keyboard semantics this panel doesn't
    // implement — and role="menuitem" reclassifies a <button>/<a>'s
    // accessible role away from its native button/link role, which broke
    // viewAs.test.tsx's existing role-based queries. The items keep their
    // native roles.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy()
  })

  it('dismisses the menu when Settings is clicked (in-place navigation, Topbar stays mounted)', () => {
    renderTopbar()
    openMenu()
    expect(screen.getByText('ops@dmf.example.com')).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))

    expect(screen.queryByText('ops@dmf.example.com')).toBeNull()
  })

  it('dismisses the menu when focus moves outside it', () => {
    renderTopbar()
    const avatarButton = openMenu()
    expect(screen.getByText('ops@dmf.example.com')).toBeTruthy()

    const outsideEl = document.createElement('button')
    document.body.appendChild(outsideEl)
    // focusout bubbles from the element that lost focus up through its
    // ancestors — dispatching it on the trigger (inside the wrapper) with
    // relatedTarget pointing outside the wrapper is what a real Tab out of
    // the panel produces.
    fireEvent.focusOut(avatarButton, { relatedTarget: outsideEl })

    expect(screen.queryByText('ops@dmf.example.com')).toBeNull()
    outsideEl.remove()
  })

  // Non-discriminating sanity guard (same honesty bar as "does not dismiss
  // on a click inside the menu itself" above): passes on both the
  // unmodified and fixed component, since neither ever closes the panel on
  // an internal focus move. Included to pin the containment check's other
  // branch, not as evidence for the fix itself.
  it('does not dismiss when focus moves to another element inside the menu', () => {
    renderTopbar()
    const avatarButton = openMenu()
    const settingsLink = screen.getByRole('link', { name: 'Settings' })

    fireEvent.focusOut(avatarButton, { relatedTarget: settingsLink })

    expect(screen.getByText('ops@dmf.example.com')).toBeTruthy()
  })

  // umbrella #432 §B fix-round 2. renderTopbar() above seeds the auth store
  // BEFORE the first render, on every other test in this file — Topbar
  // therefore always has a real `user` and its wrapper div exists from its
  // very first commit. That is NOT the normal production path: the identity
  // fetch settles AFTER Topbar's first commit, so Topbar renders `null`
  // (see its early `if (!user) return null`) before the wrapper div (and
  // its `ref`) exist at all. Fix-round 1 hid a defect exactly there: a
  // manual `wrapper?.addEventListener('focusout', …)` inside a mount-only
  // (`[]`-deps) effect captured `menuRef.current` — null, at that point —
  // and never re-ran once the real wrapper mounted, so the listener was
  // never actually bound in production. This test builds that exact
  // null-then-populated sequence explicitly, rather than starting from an
  // already-populated store like every other test here.
  it('dismisses on focus-out when the auth store starts empty and populates after mount', () => {
    useAuthStore.getState().setUser(null)
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Topbar />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // First commit: Topbar's early return fires, nothing on screen yet.
    expect(screen.queryByRole('button', { name: 'OP' })).toBeNull()

    // The identity fetch settles AFTER Topbar's first commit — same order
    // as production.
    act(() => {
      useAuthStore.getState().setUser(identity())
    })

    const avatarButton = screen.getByRole('button', { name: 'OP' })
    fireEvent.click(avatarButton)
    expect(screen.getByText('ops@dmf.example.com')).toBeTruthy()

    const outsideEl = document.createElement('button')
    document.body.appendChild(outsideEl)
    fireEvent.focusOut(avatarButton, { relatedTarget: outsideEl })

    expect(screen.queryByText('ops@dmf.example.com')).toBeNull()
    outsideEl.remove()
  })

  // 'keydown' is unique to the personal menu's own Escape handling —
  // NotificationBell's dropdown registers no keyboard listener at all, so
  // any 'keydown' registration observed here can only come from Topbar's
  // own fix, isolating it from NotificationBell's pre-existing 'mousedown'
  // listener (which already added/removed cleanly before this change and
  // so can't discriminate on its own).
  it('adds its own Escape ("keydown") listener on mount and removes it on unmount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const view = renderTopbar()

    const keydownAdd = addSpy.mock.calls.find(([type]) => type === 'keydown')
    expect(keydownAdd).toBeTruthy()
    const keydownHandler = keydownAdd?.[1]

    view.unmount()

    expect(removeSpy).toHaveBeenCalledWith('keydown', keydownHandler)
  })
})
