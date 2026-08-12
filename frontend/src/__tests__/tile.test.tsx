/**
 * Shared Tile component (umbrella dmfdeploy/dmfdeploy#347 Arc 4 WP-4).
 *
 * The whole point of the refactor: the primary Link and the actions slot are
 * SIBLINGS, never one nested in the other, so a future menu button dropped
 * into `actions` can never become an interactive descendant of the anchor
 * (invalid HTML, unpredictable across browsers/AT). This file proves that
 * structurally, with a real interactive fixture in the slot — not just by
 * reading the source.
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
    const outerContainer = link.closest('.card')
    expect(outerContainer).toBeTruthy()
    // Both reachable from the same non-interactive container...
    expect(outerContainer?.contains(button)).toBe(true)
    // ...but neither contains the other — true siblings, not nested.
    expect(link.contains(button)).toBe(false)
    expect(button.contains(link)).toBe(false)
  })
})
