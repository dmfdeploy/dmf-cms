import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { computeGhostCounts, totalGhostCount } from '../lib/canvasGhostGrid'

/**
 * The responsive grid Media Workloads and Facilities both mount
 * (MediaWorkloads/index.tsx, Facility/index.tsx) — one exported constant so
 * a future third page reuses the exact same breakpoints instead of retyping
 * them a third time, and so the ghost math below can never disagree with
 * what the CSS actually says: it reads `grid-template-columns` back off
 * THIS class, live, rather than hardcoding "1, 2 or 3".
 */
export const CANVAS_GRID_CLASSNAME = 'mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3'

/**
 * Walks up from `el` to find the nearest ancestor that is BOTH (a) set to
 * scroll (computed `overflow-y: auto|scroll`) AND (b) actually
 * height-bounded by its OWN parent's layout, rather than merely sized to
 * fit its own content.
 *
 * Condition (b) is not a hypothetical — it is required by this app's real
 * page shell (components/Shell.tsx). `<main className="flex-1
 * overflow-y-auto ...">` is a genuine flex ITEM (its parent IS
 * `display:flex`), so `main`'s height comes from that layout and its
 * overflow is what actually clips/scrolls the page. Each page's OWN root
 * div (`<div className="flex-1 overflow-y-auto p-6">`, MediaWorkloads'/
 * Facility's own top-level element) sits INSIDE `main` — which is a plain
 * block element with no `display:flex`/`grid` of its own — so that div's
 * `flex-1` class has no effect (flex sizing only applies to a child of a
 * flex/grid container) and it is really just a content-sized block whose
 * own `overflow-y-auto` never engages. A naive "first ancestor with
 * overflow-y:auto" walk stops AT that inert div: its `clientHeight` and
 * `scrollHeight` are, by construction, always equal (nothing external
 * bounds it, so it never overflows itself), which computeGhostCounts would
 * read as permanently zero slack — a silent dead end where not one ghost
 * row past `fillLast` could ever render, on the actual production DOM.
 * Requiring the candidate's own PARENT to be a flex/grid container is what
 * skips that inert div and finds `main` — the element that is genuinely
 * viewport-bounded — instead.
 *
 * Falls back to the document's own scrolling element if nothing qualifies.
 */
function findScrollAncestor(el: Element): Element {
  let node = el.parentElement
  while (node && node !== document.body) {
    const parent = node.parentElement
    const boundedByParent =
      parent !== null && /^(flex|inline-flex|grid|inline-grid)$/.test(getComputedStyle(parent).display)
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && boundedByParent) {
      return node
    }
    node = parent
  }
  return document.scrollingElement ?? document.documentElement
}

/**
 * The ghost-grid container for umbrella dmfdeploy/dmfdeploy#498. Renders
 * `children` (the real tiles) followed by however many decorative ghost
 * cells complete/extend the same grid — see lib/canvasGhostGrid.ts for the
 * row math and the reasoning behind it (that file is the one to read first;
 * this component is just the DOM measuring and wiring around it).
 *
 * `itemCount` is the number of REAL grid items among `children` — it drives
 * the ghost math but is never itself rendered or validated against
 * `children`'s actual length; callers own that correspondence the same way
 * `Tile`'s callers own keeping `children` free of interactive descendants
 * (see Tile.tsx's own CONTRACT note).
 *
 * A11y / interactivity (#498 acceptance criteria 5-6): every ghost cell is
 * `aria-hidden`, carries no `tabIndex`/role/handlers, and gets no hover,
 * cursor, or focus styling — a plain inert `<div>`, `pointer-events-none` on
 * top for a belt-and-braces guarantee. They are never added to the data
 * `children` is built from (each page's own `.map()` over its real items),
 * so nothing that counts real items — a caption, a future "N workloads"
 * summary — can ever count a ghost.
 */
export default function CanvasGrid({
  itemCount,
  children,
}: {
  itemCount: number
  children: ReactNode
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [ghostCount, setGhostCount] = useState(0)

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return

    const recompute = () => {
      const style = getComputedStyle(grid)
      // The LIVE resolved column tracks, not a hardcoded "1/2/3" — under a
      // real browser this is a list of used pixel widths (e.g. "398px
      // 398px 398px"); under jsdom (no real layout engine) it resolves to
      // nothing parseable, which is exactly the bail-to-zero branch below.
      const tracks = style.gridTemplateColumns.split(' ').filter(Boolean)
      const columnCount = tracks.length
      const columnWidth = parseFloat(tracks[0] ?? '')
      const gap = parseFloat(style.rowGap || style.gap || '0') || 0
      // Every tile — real or ghost — is aspect-square, so a column's own
      // resolved width IS that row's height. No separate height probe.
      const rowStep = columnWidth + gap

      const scrollAncestor = findScrollAncestor(grid)
      // getBoundingClientRect(), NOT scrollHeight/clientHeight — see
      // GhostGridMeasurement.availableHeight's own docstring
      // (lib/canvasGhostGrid.ts) for the real bug that distinction fixes.
      const availableHeight = scrollAncestor.getBoundingClientRect().bottom - grid.getBoundingClientRect().top
      const counts = computeGhostCounts({ itemCount, columnCount, rowStep, availableHeight })
      const next = totalGhostCount(counts, columnCount)
      setGhostCount((prev) => (prev === next ? prev : next))
    }

    recompute()

    // ResizeObserver is unavailable under jsdom (no test exercises this
    // branch) — feature-detected the same way liveView.ts guards
    // `matchMedia`, so this degrades to "measured once on mount" rather
    // than throwing.
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recompute)
      ro.observe(grid)
      ro.observe(findScrollAncestor(grid))
    }
    // Catches viewport/zoom changes that don't change the grid's OWN box
    // (e.g. the scroll ancestor's clientHeight shrinking without the grid's
    // width changing) as a second signal alongside the ResizeObserver above.
    window.addEventListener('resize', recompute)

    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', recompute)
    }
    // No dependency array: re-measures after EVERY commit, not only when
    // `itemCount` changes. `itemCount` alone would miss any OTHER content on
    // the same scrollable page changing size without it — a banner
    // appearing above the grid changes the grid's own top edge without
    // changing `itemCount` at all. This can't loop: `availableHeight` is
    // computed fresh each time from the grid's own (stable) top edge and
    // the scroll ancestor's own (stable) bottom edge — neither depends on
    // how many ghosts are currently rendered — so repeated recomputes
    // always produce the SAME answer for unchanged inputs; `recompute` only
    // calls `setGhostCount` when the computed total actually differs, so a
    // genuine change re-measures once more, gets the same (now-correct)
    // answer, and bails out without a further state change.
  })

  const ghosts = Array.from({ length: ghostCount }, (_, i) => (
    <div
      key={`ghost-${i}`}
      aria-hidden="true"
      data-testid="canvas-grid-ghost"
      className="pointer-events-none aspect-square rounded-xl border border-dashed border-white/10"
    />
  ))

  return (
    <div ref={gridRef} className={CANVAS_GRID_CLASSNAME}>
      {children}
      {ghosts}
    </div>
  )
}
