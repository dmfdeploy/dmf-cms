/**
 * StaticPatternCard (umbrella #452) — the inline-SVG illustration a
 * topology-spawned SOURCE tile shows in place of PlaceholderThumb when its
 * declared test pattern is one this component knows how to draw. Covers:
 * known patterns render the STATIC mark + the exact sr-only text; an
 * unknown pattern renders nothing at all (the caller's own fallback, not
 * this component's concern); no <img>/network surface exists here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import StaticPatternCard, { hasStaticPattern } from '../pages/MediaWorkloads/StaticPatternCard'

afterEach(cleanup)

describe('hasStaticPattern', () => {
  it('knows smpte and checkers-8', () => {
    expect(hasStaticPattern('smpte')).toBe(true)
    expect(hasStaticPattern('checkers-8')).toBe(true)
  })

  it('does not know an arbitrary/unrecognised pattern token', () => {
    // Mutation check: "ball" is a REAL sources[].pattern value elsewhere in
    // this codebase's own test fixtures (test_switch_source.py) — proving
    // this returns false for it (not just for garbage input) is what shows
    // the check actually discriminates known-vs-unknown rather than always
    // returning true.
    expect(hasStaticPattern('ball')).toBe(false)
    expect(hasStaticPattern('')).toBe(false)
  })
})

describe('StaticPatternCard: known patterns', () => {
  it('smpte renders seven vertical bars in SMPTE order over a plain dark lower third, the STATIC mark, and the sr-only text', () => {
    const { container } = render(<StaticPatternCard pattern="smpte" displayName="Source A" />)
    const rects = container.querySelectorAll('svg rect')
    // 7 colour bars + 1 lower-third rect.
    expect(rects.length).toBe(8)
    const fills = Array.from(rects).map((r) => r.getAttribute('fill'))
    expect(fills.slice(0, 7)).toEqual([
      '#FFFFFF',
      '#FFFF00',
      '#00FFFF',
      '#00FF00',
      '#FF00FF',
      '#FF0000',
      '#0000FF',
    ])
    // Mutation check: the bars occupy the TOP (y=0..320 of a 480-tall
    // viewBox), the plain dark band is the LOWER third (y=320..480) — a
    // fix that swapped the two would still pass a fill-order-only assertion.
    expect(rects[0].getAttribute('y')).toBe('0')
    const lower = rects[7]
    expect(Number(lower.getAttribute('y'))).toBeGreaterThan(Number(rects[0].getAttribute('height')) - 1)

    expect(screen.getByText('STATIC')).toBeTruthy()
    expect(
      screen.getByText(
        'Static illustration of the smpte test pattern this source emits — not a live picture.',
      ),
    ).toBeTruthy()
  })

  it('checkers-8 renders an 8×8 grid (64 cells) alternating fill, the STATIC mark, and the sr-only text', () => {
    const { container } = render(<StaticPatternCard pattern="checkers-8" displayName="Source B" />)
    const rects = container.querySelectorAll('svg rect')
    expect(rects.length).toBe(64)
    // Mutation check: the top-left cell (row0,col0) is WHITE — this is the
    // worst-case backdrop hasStaticPattern's own contrast note is computed
    // against; a fix that inverted the checkerboard's phase would flip this.
    const topLeft = Array.from(rects).find(
      (r) => r.getAttribute('x') === '0' && r.getAttribute('y') === '0',
    )
    expect(topLeft?.getAttribute('fill')).toBe('#FFFFFF')

    expect(screen.getByText('STATIC')).toBeTruthy()
    expect(
      screen.getByText(
        'Static illustration of the checkers-8 test pattern this source emits — not a live picture.',
      ),
    ).toBeTruthy()
  })

  it('renders no <img> and no url-bearing attribute — the illustration is drawn, never fetched', () => {
    const { container } = render(<StaticPatternCard pattern="smpte" displayName="Source A" />)
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('StaticPatternCard: unknown pattern', () => {
  it('returns null — nothing renders, the caller falls back to its own placeholder', () => {
    const { container } = render(<StaticPatternCard pattern="ball" displayName="Source A" />)
    expect(container.innerHTML).toBe('')
  })
})
