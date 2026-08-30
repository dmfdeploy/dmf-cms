/**
 * The ghost-grid row/column math for umbrella dmfdeploy/dmfdeploy#498 (Media
 * Workloads + Facilities: a subtle background grid showing where tiles
 * land, in preparation for a future drag-to-canvas mechanic).
 *
 * Pulled out of components/CanvasGrid.tsx as a PURE function deliberately —
 * jsdom computes no pixels (no real layout engine), so nothing rendered
 * through an actual DOM can prove this arithmetic is right; see
 * components/Tile.tsx's own docstring for the same lesson learned the hard
 * way on this codebase's other "aspect-square in a responsive grid"
 * component. What CAN be proven without a browser is that, GIVEN a set of
 * measurements, the row/column counts this produces are correct — so the
 * measuring (getComputedStyle, getBoundingClientRect) lives in the
 * component, and the decision of how many ghosts that implies lives here,
 * testable with plain numbers.
 *
 * THE ACTUAL DESIGN PROBLEM (#498's own framing): ghost cells are REAL grid
 * items in the SAME grid container as the real tiles, so alignment can
 * never drift from the responsive column count — but real items add height,
 * and the extent is "fill the viewport". Two things have to both hold:
 *   - a short list (few tiles) must not grow a scrollbar made of decoration
 *   - a long list must still scroll normally, every real tile unclipped
 *
 * THE APPROACH: split "ghosts" into two independent kinds, because they
 * have two independent safety properties —
 *
 *   `fillLast` completes the real content's OWN last row up to full column
 *   width. This costs NO extra height: CSS Grid sizes a row to its tallest
 *   item, and every item here (real or ghost) is aspect-square off the same
 *   column width, so an incomplete row is already exactly as tall as a full
 *   one. It is therefore always safe to add, regardless of how much (or how
 *   little) room is left on the page — including on a long list, where it
 *   still tidies the visual edge without consuming any of the scroll
 *   budget.
 *
 *   `fullRows` are additional whole ghost rows appended below the real
 *   content, and THESE do cost height — one tile-height-plus-gap each. They
 *   are bounded by `availableHeight` (see that field's own docstring below
 *   for why it is measured the way it is, and specifically why it is NOT
 *   `scrollHeight`/`clientHeight`) — how much room is left between the
 *   grid's own top edge and the bottom of the real scrolling viewport. If
 *   there is no room (the long-list case), fullRows is zero and the real
 *   tiles are never touched — nothing here ever bounds or clips content,
 *   only decoration.
 */

export interface GhostGridMeasurement {
  /** How many REAL grid items are already in this grid. */
  itemCount: number
  /** The grid's current column count (1, 2, or 3 at this codebase's three
   *  breakpoints) — read from the LIVE computed style, never hardcoded, so
   *  this can never drift from whatever `grid-cols-*` classes actually say. */
  columnCount: number
  /** The pixel cost of ONE additional full ghost row: a tile's rendered
   *  height (== its column's resolved width, since every tile here is
   *  aspect-square) plus the grid's own row gap. Simplification, stated
   *  once rather than re-derived per caller: this assumes a gap exists
   *  above every row counted against it, including the FIRST — not quite
   *  true (the first row has no row above it to gap against), which
   *  over-charges the total budget by one gap's worth. That only ever
   *  makes the result come out one row LOW, never high — the safe
   *  direction of error (under-fill, never overflow). */
  rowStep: number
  /** The vertical space available to the grid, from the grid's OWN top
   *  edge to the bottom of the real scrolling viewport —
   *  `scrollAncestor.getBoundingClientRect().bottom -
   *  grid.getBoundingClientRect().top`, computed by the caller.
   *
   *  Deliberately NOT `scrollHeight`/`clientHeight` — an earlier version of
   *  this function used exactly that pair, and it was WRONG in a way that
   *  defeated the whole feature: `Element.scrollHeight` is defined to never
   *  read BELOW `clientHeight` (a box that isn't overflowing reports its
   *  OWN bound as `scrollHeight`, not its shorter content's real height).
   *  Every scenario this component exists for — a short list that should
   *  read as an open canvas — has content SHORTER than the visible area,
   *  which is exactly the case that clamp hides: `scrollHeight -
   *  clientHeight` came out to zero on every real render, no matter how
   *  much room was actually left on screen, so not one ghost row past
   *  `fillLast` could ever appear on the actual production pages (found via
   *  this file's own dev harness, dmfdeploy/dmfdeploy#498 — see
   *  components/CanvasGrid.tsx's git history for the full account).
   *  `getBoundingClientRect()` carries no such clamp: it always reports
   *  what is actually rendered, whether that is shorter or taller than any
   *  ancestor's own box. It is also STABLE across repeated measurements —
   *  the grid's own top edge does not move as ghosts are added below it —
   *  so, unlike the old scrollHeight approach, this needs no "subtract what
   *  I added last time" bookkeeping at all: the same inputs always produce
   *  the same answer, with nothing to converge toward across renders. */
  availableHeight: number
}

export interface GhostCounts {
  /** Ghosts that complete the real content's last row. Always safe. */
  fillLast: number
  /** Additional full ghost rows, bounded by `availableHeight`. */
  fullRows: number
}

/**
 * Computes how many ghost cells of each kind to render. Returns all zeros
 * when the measurement itself is unusable (a non-finite/non-positive column
 * count or row step) rather than guessing — this is exactly the branch
 * jsdom takes (no real layout engine to resolve `grid-template-columns` or
 * `row-gap` into pixels), which is also why every existing render test for
 * the two real pages this feeds needed no changes: under jsdom, this always
 * returns zero ghosts, so the DOM those tests already assert against is
 * unchanged.
 */
export function computeGhostCounts(m: GhostGridMeasurement): GhostCounts {
  if (
    !Number.isFinite(m.columnCount) ||
    m.columnCount <= 0 ||
    !Number.isFinite(m.rowStep) ||
    m.rowStep <= 0
  ) {
    return { fillLast: 0, fullRows: 0 }
  }

  const columnCount = Math.floor(m.columnCount)
  const itemCount = Math.max(0, Math.floor(m.itemCount))

  const currentRows = itemCount === 0 ? 0 : Math.ceil(itemCount / columnCount)
  const lastRowItems = itemCount === 0 ? 0 : itemCount - (currentRows - 1) * columnCount
  const fillLast = itemCount === 0 ? 0 : columnCount - lastRowItems

  // The height the real rows already occupy (fillLast ghosts share the
  // LAST of these rows, adding nothing beyond it — see the file docstring).
  // `heightOfRealRows` is never negative (currentRows and rowStep are both
  // >= 0 by this point), so `remaining` can never exceed `availableHeight`
  // itself — there is no separate ceiling to clamp against on top of this.
  const heightOfRealRows = currentRows * m.rowStep
  const remaining = m.availableHeight - heightOfRealRows
  const fullRows = remaining > 0 ? Math.floor(remaining / m.rowStep) : 0

  return { fillLast, fullRows }
}

/** The total number of ghost `<div>`s to render for a given `GhostCounts`. */
export function totalGhostCount(counts: GhostCounts, columnCount: number): number {
  return counts.fillLast + counts.fullRows * Math.max(0, Math.floor(columnCount))
}
