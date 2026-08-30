/**
 * umbrella dmfdeploy/dmfdeploy#498 — the ghost-grid row/column math, tested
 * as plain numbers. See lib/canvasGhostGrid.ts's own docstring for why this
 * split exists: jsdom computes no pixels, so nothing rendered through an
 * actual DOM can prove this arithmetic — GIVEN a measurement, is the ghost
 * count right — is provable without a browser at all.
 */
import { describe, expect, it } from 'vitest'
import { computeGhostCounts, totalGhostCount, type GhostGridMeasurement } from '../lib/canvasGhostGrid'

function measurement(overrides: Partial<GhostGridMeasurement> = {}): GhostGridMeasurement {
  return {
    itemCount: 1,
    columnCount: 3,
    rowStep: 120, // e.g. a 100px tile + a 20px gap
    availableHeight: 100,
    ...overrides,
  }
}

describe('computeGhostCounts — measurement bail-out', () => {
  it('renders no ghosts when columnCount is unusable — the jsdom branch (no real layout engine)', () => {
    expect(computeGhostCounts(measurement({ columnCount: 0 }))).toEqual({ fillLast: 0, fullRows: 0 })
    expect(computeGhostCounts(measurement({ columnCount: NaN }))).toEqual({ fillLast: 0, fullRows: 0 })
    expect(computeGhostCounts(measurement({ columnCount: -1 }))).toEqual({ fillLast: 0, fullRows: 0 })
  })

  it('renders no ghosts when rowStep is unusable', () => {
    expect(computeGhostCounts(measurement({ rowStep: 0 }))).toEqual({ fillLast: 0, fullRows: 0 })
    expect(computeGhostCounts(measurement({ rowStep: NaN }))).toEqual({ fillLast: 0, fullRows: 0 })
    expect(computeGhostCounts(measurement({ rowStep: -50 }))).toEqual({ fillLast: 0, fullRows: 0 })
  })
})

describe('computeGhostCounts — fillLast completes the real content\'s last row, for free', () => {
  it('completes a partial last row regardless of availableHeight — even deeply negative remaining room', () => {
    const counts = computeGhostCounts(measurement({ itemCount: 1, columnCount: 3, rowStep: 120, availableHeight: 10 }))
    expect(counts.fillLast).toBe(2) // 1 real item, 3 columns -> 2 to complete the row
    expect(counts.fullRows).toBe(0) // no room for a whole extra row (10 < the 120 the real row itself needs)
  })

  it('adds zero fillLast when the last row is already full', () => {
    const counts = computeGhostCounts(measurement({ itemCount: 6, columnCount: 3 }))
    expect(counts.fillLast).toBe(0)
  })

  it('adds zero fillLast at itemCount 0 — nothing to complete, that is fullRows\' job instead', () => {
    const counts = computeGhostCounts(measurement({ itemCount: 0, columnCount: 3 }))
    expect(counts.fillLast).toBe(0)
  })

  it('handles a last row of exactly one item across several row counts', () => {
    expect(computeGhostCounts(measurement({ itemCount: 4, columnCount: 3 })).fillLast).toBe(2) // row 2: [item] . .
    expect(computeGhostCounts(measurement({ itemCount: 7, columnCount: 3 })).fillLast).toBe(2) // row 3: [item] . .
  })
})

describe('computeGhostCounts — fullRows fills the measured available height, never overflows it', () => {
  it('adds exactly as many full rows as fit, using floor (never rounds up past the boundary)', () => {
    // 1 real row already costs 120px. 360px available total -> 240px left
    // over -> exactly 2 more rows, no partial third.
    const counts = computeGhostCounts(
      measurement({ itemCount: 1, columnCount: 2, rowStep: 120, availableHeight: 360 }),
    )
    expect(counts.fullRows).toBe(2)
  })

  it('never rounds a boundary UP — one pixel short of a whole row adds nothing extra', () => {
    const counts = computeGhostCounts(
      measurement({ itemCount: 1, columnCount: 2, rowStep: 120, availableHeight: 359 }),
    )
    // remaining = 359 - 120 = 239, floor(239/120) = 1, not 2.
    expect(counts.fullRows).toBe(1)
  })

  it('adds zero full rows once the real content already meets or exceeds the available height — the long-list case', () => {
    // The whole point of #498's acceptance criteria 3/4: real tiles are
    // NEVER bounded, and a long list must never be padded into scrolling
    // further than its own content already requires.
    const counts = computeGhostCounts(
      measurement({ itemCount: 30, columnCount: 3, rowStep: 120, availableHeight: 800 }), // 10 real rows already cost 1200px
    )
    expect(counts.fullRows).toBe(0)
  })

  it('fills a pure ghost canvas at itemCount 0 when there is ample available height', () => {
    const counts = computeGhostCounts(measurement({ itemCount: 0, columnCount: 3, rowStep: 100, availableHeight: 350 }))
    expect(counts.fillLast).toBe(0)
    expect(counts.fullRows).toBe(3) // floor(350/100)
  })

  it('is stable across repeated calls with the same measurement — no hidden growth', () => {
    // Unlike an approach keyed off a scroll container's own scrollHeight
    // (which reflects whatever is CURRENTLY rendered, including ghosts this
    // same function already added), `availableHeight` is measured from the
    // grid's own top edge to the scroll ancestor's own bottom edge — both
    // stable regardless of how many ghosts exist. Calling this twice with
    // the identical measurement must therefore give the identical answer,
    // not a growing one.
    const m = measurement({ itemCount: 1, columnCount: 2, rowStep: 120, availableHeight: 360 })
    expect(computeGhostCounts(m)).toEqual(computeGhostCounts(m))
  })

  it('reflects a smaller available height (e.g. after a window resize) with zero full rows, never negative', () => {
    const counts = computeGhostCounts(
      measurement({ itemCount: 1, columnCount: 2, rowStep: 120, availableHeight: 120 }), // exactly the real row, no more
    )
    expect(counts.fullRows).toBe(0)
  })
})

describe('totalGhostCount', () => {
  it('combines fillLast and fullRows*columnCount', () => {
    expect(totalGhostCount({ fillLast: 1, fullRows: 2 }, 2)).toBe(1 + 2 * 2)
    expect(totalGhostCount({ fillLast: 0, fullRows: 0 }, 3)).toBe(0)
  })

  it('never goes negative off a degenerate columnCount', () => {
    expect(totalGhostCount({ fillLast: 0, fullRows: 3 }, -1)).toBe(0)
  })
})
