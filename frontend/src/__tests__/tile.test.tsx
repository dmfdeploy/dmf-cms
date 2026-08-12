/**
 * Shared Tile component (umbrella dmfdeploy/dmfdeploy#347 Arc 4 WP-4).
 *
 * The whole point of the refactor: the primary Link and the actions slot are
 * SIBLINGS, never one nested in the other, so a future menu button dropped
 * into `actions` can never become an interactive descendant of the anchor
 * (invalid HTML, unpredictable across browsers/AT). This file proves that
 * structurally, with a real interactive fixture in the slot — not just by
 * reading the source.
 *
 * WHAT THIS FILE CANNOT PROVE (lkirc round-4 finding): jsdom has no real
 * layout engine, so no test here can observe rendered box geometry — the
 * click-surface parity claim in Tile.tsx's own comments (the Link's
 * clickable box exactly matches the container's, no residual gap) was
 * verified with a real browser against the actual compiled CSS
 * (getBoundingClientRect, not jsdom), not by anything in this suite. The
 * tests below that touch `card`/class placement are class-list tripwires —
 * they catch a future edit that silently moves `card` back onto the wrong
 * element, they do not themselves prove the pixels are right.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Tile from '../components/Tile'

afterEach(() => cleanup())

function renderTile(actions?: React.ReactNode) {
  return render(
    <MemoryRouter>
      <Tile to="/somewhere" ariaLabel="Open Somewhere detail" actions={actions}>
        <p>tile face content</p>
      </Tile>
    </MemoryRouter>,
  )
}

describe('Tile', () => {
  it('renders the primary link with its accessible name and destination', () => {
    renderTile()
    const link = screen.getByRole('link', { name: 'Open Somewhere detail' })
    expect(link.getAttribute('href')).toBe('/somewhere')
    expect(screen.getByText('tile face content')).toBeTruthy()
  })

  it('renders nothing extra when actions is omitted — the "introduce it empty" state', () => {
    const { container } = renderTile()
    expect(screen.queryByRole('button')).toBeNull()
    // No stray empty wrapper left behind either.
    expect(container.querySelectorAll('a').length).toBe(1)
  })

  // The discriminating case: even with a REAL interactive element populating
  // the actions slot, it must never land inside the anchor. A regression
  // that put `actions` back inside the Link (e.g. reverting to the
  // pre-refactor single-<Link> shape) would fail this immediately.
  it('never nests an actions-slot interactive element inside the primary link', () => {
    const { container } = renderTile(<button type="button">Menu</button>)
    const link = container.querySelector('a')
    expect(link).toBeTruthy()
    expect(link?.querySelector('button')).toBeNull()

    // The button is still on the page — as a SIBLING, findable independently
    // of the link.
    const button = screen.getByRole('button', { name: 'Menu' })
    expect(button).toBeTruthy()
    expect(button.closest('a')).toBeNull()
  })

  it('the actions slot lives inside the same non-interactive container as the link, not inside the link itself', () => {
    renderTile(<button type="button">Menu</button>)
    const link = screen.getByRole('link', { name: 'Open Somewhere detail' })
    const button = screen.getByRole('button', { name: 'Menu' })
    // The container is a bare sizing/positioning shell (no `card` of its own
    // — see the next test), so it's found by DOM position, not by class.
    const outerContainer = link.parentElement
    expect(outerContainer).toBeTruthy()
    // Both reachable from the same non-interactive container...
    expect(outerContainer?.contains(button)).toBe(true)
    // ...but neither contains the other — true siblings, not nested.
    expect(link.contains(button)).toBe(false)
    expect(button.contains(link)).toBe(false)
  })

  // lkirc round-4 finding: an earlier version of Tile.tsx put `card`
  // (index.css — background/border/rounded corners/`p-4` padding) on the
  // OUTER container, reasoning it was "what a reader perceives as the
  // tile". That silently shrank the real clickable/tappable target, because
  // the Link — the only actually-clickable element — had no compensating
  // padding/border of its own, so it only filled the container's inner
  // content box while the card's visible chrome spanned the full padded+
  // bordered box. A `-m-4 p-4` compensating margin closed the padding
  // portion but, verified with a real browser (getBoundingClientRect
  // against the compiled CSS — jsdom can't observe this), left a 1px-per-
  // side residual from the border, which still lived on the container only.
  // The fix that actually closes the WHOLE gap, verified the same way: put
  // `card` back on the Link directly, exactly where it lived pre-refactor —
  // no second box model to reconcile against, so no residual of any width.
  it("the link's className carries card directly — the container is a bare shell, not a second visual box", () => {
    renderTile()
    const link = screen.getByRole('link', { name: 'Open Somewhere detail' })
    const linkClass = link.getAttribute('class') ?? ''
    expect(linkClass).toContain('card')

    // The container must NOT also carry `card`, or the click-surface gap
    // this test exists to guard against would reopen — two elements both
    // claiming the visual footprint, only one of them actually clickable.
    const outerContainer = link.parentElement
    const outerClass = outerContainer?.getAttribute('class') ?? ''
    expect(outerClass).not.toContain('card')
    // The container still needs to size the square the Link fills —
    // `aspect-square` stays there, it's `card` specifically that moved.
    expect(outerClass).toContain('aspect-square')
  })
})
