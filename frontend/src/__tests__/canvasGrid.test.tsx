/**
 * components/CanvasGrid.tsx — umbrella dmfdeploy/dmfdeploy#498.
 *
 * Two things are pinned here. First: under REAL jsdom (no stubbing, no
 * mocking), CanvasGrid degrades to zero ghosts — this is the exact
 * contract every pre-existing MediaWorkloads/Facility render test already
 * relies on without knowing it (none of them needed a single change when
 * this component was introduced). Second: given a MOCKED but real-shaped
 * layout (computed style + `getBoundingClientRect`), the wiring end-to-end
 * produces the right ghost count and every ghost is structurally inert —
 * proving the DOM-measuring glue calls lib/canvasGhostGrid.ts's pure math
 * correctly, which is the one thing canvasGhostGrid.test.ts's own
 * pure-number tests can't reach on their own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import CanvasGrid from '../components/CanvasGrid'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CanvasGrid — under real jsdom (no layout engine)', () => {
  it('renders children and zero ghosts — grid-template-columns cannot resolve to real pixels here', () => {
    render(
      <CanvasGrid itemCount={2}>
        <div data-testid="tile-1" />
        <div data-testid="tile-2" />
      </CanvasGrid>,
    )
    expect(screen.getByTestId('tile-1')).toBeTruthy()
    expect(screen.getByTestId('tile-2')).toBeTruthy()
    expect(screen.queryAllByTestId('canvas-grid-ghost')).toHaveLength(0)
  })
})

/**
 * Stubs `getComputedStyle` for exactly the three elements CanvasGrid reads
 * from in this test tree (identified by testid/class, not by call order),
 * falling through to the real implementation for anything else so nothing
 * unrelated (React, testing-library) breaks.
 */
function stubGetComputedStyle() {
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudoElt?: string | null) => {
    if (el instanceof HTMLElement) {
      if (el.dataset.testid === 'flex-wrapper') {
        return { display: 'flex' } as unknown as CSSStyleDeclaration
      }
      if (el.dataset.testid === 'scroll-parent') {
        return { overflowY: 'auto' } as unknown as CSSStyleDeclaration
      }
      // CanvasGrid's own root div — identified by its own exported class,
      // not a testid, since the component owns that class and nothing else
      // in this tree carries it.
      if (el.classList.contains('mt-4') && el.classList.contains('grid')) {
        return {
          gridTemplateColumns: '100px 100px',
          rowGap: '20px',
          gap: '20px 20px',
        } as unknown as CSSStyleDeclaration
      }
    }
    return real(el, pseudoElt)
  })
}

/**
 * `getBoundingClientRect()` is what actually drives the measurement
 * (see lib/canvasGhostGrid.ts's own docstring on `availableHeight` for why
 * — jsdom's default, an all-zero rect, is not useful here). Overridden
 * directly on the instance, the simplest way to fake real layout geometry
 * without a real browser.
 */
function stubRect(el: Element, rect: Partial<DOMRect>) {
  el.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {}, ...rect }) as DOMRect
}

describe('CanvasGrid — with a real, measurable layout (mocked getComputedStyle + getBoundingClientRect)', () => {
  it('computes fillLast + fullRows from the measured available height, and every ghost is structurally inert', async () => {
    stubGetComputedStyle()

    render(
      <div data-testid="flex-wrapper">
        <div data-testid="scroll-parent">
          <CanvasGrid itemCount={1}>
            <div data-testid="real-tile" />
          </CanvasGrid>
        </div>
      </div>,
    )

    const scrollParent = screen.getByTestId('scroll-parent')
    const grid = scrollParent.querySelector('.mt-4.grid') as HTMLElement
    // Scroll ancestor's own bottom edge (its bounded, viewport-derived
    // height) at 480, grid's own top edge at 20 -> 460px of available
    // height. 2 columns @ 100px + 20px gap => rowStep 120. itemCount=1
    // leaves the last row 1 short (fillLast=1). 1 real row costs 120px,
    // leaving 340px -> exactly 2 more full rows (fullRows=2) -> total
    // ghosts = 1 + 2*2 = 5.
    stubRect(scrollParent, { bottom: 480 })
    stubRect(grid, { top: 20 })

    // Re-triggers CanvasGrid's `resize` listener, which re-measures against
    // the rects just stubbed above (the very first, synchronous measurement
    // ran before they were set, against jsdom's default all-zero rects).
    await act(async () => {
      fireEvent(window, new Event('resize'))
    })

    expect(screen.getByTestId('real-tile')).toBeTruthy()
    const ghosts = screen.getAllByTestId('canvas-grid-ghost')
    expect(ghosts).toHaveLength(5)
    for (const ghost of ghosts) {
      // Acceptance criteria 5/6 (#498): absent from the a11y tree, not
      // focusable, no role — a plain inert <div>, nothing more.
      expect(ghost.getAttribute('aria-hidden')).toBe('true')
      expect(ghost.getAttribute('tabindex')).toBeNull()
      expect(ghost.getAttribute('role')).toBeNull()
      expect(ghost.tagName).toBe('DIV')
    }
  })

  it('renders zero ghosts (only the real tiles) once the available height is fully consumed', async () => {
    stubGetComputedStyle()

    render(
      <div data-testid="flex-wrapper">
        <div data-testid="scroll-parent">
          <CanvasGrid itemCount={2}>
            <div data-testid="tile-a" />
            <div data-testid="tile-b" />
          </CanvasGrid>
        </div>
      </div>,
    )

    const scrollParent = screen.getByTestId('scroll-parent')
    const grid = scrollParent.querySelector('.mt-4.grid') as HTMLElement
    // 2 columns, 2 real items -> the last row is already full (fillLast=0).
    // Exactly 120px available for the one real row -> zero slack -> fullRows=0.
    stubRect(scrollParent, { bottom: 120 })
    stubRect(grid, { top: 0 })

    await act(async () => {
      fireEvent(window, new Event('resize'))
    })

    expect(screen.getByTestId('tile-a')).toBeTruthy()
    expect(screen.getByTestId('tile-b')).toBeTruthy()
    expect(screen.queryAllByTestId('canvas-grid-ghost')).toHaveLength(0)
  })

  it('does not clip or bound real tiles on a long list — zero full rows when content already exceeds the available height', async () => {
    stubGetComputedStyle()

    render(
      <div data-testid="flex-wrapper">
        <div data-testid="scroll-parent">
          <CanvasGrid itemCount={6}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} data-testid={`tile-${i}`} />
            ))}
          </CanvasGrid>
        </div>
      </div>,
    )

    const scrollParent = screen.getByTestId('scroll-parent')
    const grid = scrollParent.querySelector('.mt-4.grid') as HTMLElement
    // 2 columns, 6 items -> 3 full rows already (360px @ rowStep 120) — far
    // more than the 200px of available height a small viewport leaves.
    stubRect(scrollParent, { bottom: 200 })
    stubRect(grid, { top: 0 })

    await act(async () => {
      fireEvent(window, new Event('resize'))
    })

    for (let i = 0; i < 6; i++) {
      expect(screen.getByTestId(`tile-${i}`)).toBeTruthy()
    }
    expect(screen.queryAllByTestId('canvas-grid-ghost')).toHaveLength(0)
  })
})
