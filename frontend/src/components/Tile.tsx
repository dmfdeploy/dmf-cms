import { Link } from 'react-router-dom'

/**
 * Shared square control-surface tile (umbrella dmfdeploy/dmfdeploy#347 Arc 4
 * WP-4). Extracted from two call sites that were ALREADY the byte-identical
 * structure by deliberate cross-page commitment (Facility/index.tsx's own
 * comment, pre-refactor: "Same square control-surface tile structure Media
 * Workloads uses... so the streamdeck skin pass hangs one treatment on both
 * single-entry pages instead of two") — MediaWorkloads/index.tsx's
 * `WorkloadEntryTile` and Facility/index.tsx's site tile. Both used to be
 * themselves a `<Link>` wrapping everything on the card — heading, badges,
 * caption, the lot. That shape has no room for an actions affordance that
 * doesn't become an interactive descendant of an anchor (a `<button>` inside
 * an `<a>` — invalid HTML, and unpredictable across browsers/AT).
 *
 * The fix is structural, not cosmetic: this component is a NON-INTERACTIVE
 * container (`<div>`, no onClick/tabIndex of its own). Inside it, the primary
 * `<Link>` and the optional `actions` slot are SIBLINGS — never one nested in
 * the other — so a future menu button dropped into `actions` can never land
 * inside the anchor, no matter what it renders.
 *
 * `actions` is introduced EMPTY in this package, same precedent WP-2 set for
 * the route-scoped header slot (store/headerSlot.ts): nothing registers into
 * it yet. Unlike that slot, this one doesn't need a store — it's a plain
 * prop, scoped to one component instance, with no cross-tree registration to
 * guard.
 *
 * All sizing/hover/card styling lives on the outer container, not the Link —
 * `card`, `aspect-square`, the hover treatment — because the container is
 * what a reader perceives as "the tile"; the Link is just the click target
 * wrapping the same visible content each caller always wrapped (Media
 * Workloads: LivePreviewBox, heading, badge row, caption; Facility: an icon
 * box, heading, caption). facility.test.tsx pins the container's
 * `aspect-square` class (a pre-existing structural commitment, re-pinned
 * against the element that now actually carries it) — the rendered pixels
 * and the click/hover surface are identical to each caller's pre-refactor
 * single-`<Link>` shape either way.
 *
 * CONTRACT (codex P2-1, dmfdeploy/dmfdeploy#347 WP-4 round 1): `children` is
 * the tile's non-interactive visible face — it renders INSIDE the primary
 * Link, so it must never itself contain an interactive element (a
 * `<button>`, another `<a>`, anything with an interactive role). Anything
 * that needs to be its OWN click/keyboard target belongs in `actions`,
 * which is a true sibling of the Link, never a descendant of it. TypeScript
 * cannot enforce this — `children: React.ReactNode` structurally accepts
 * anything — so the boundary is enforced by test coverage against the two
 * real call sites instead (mediaWorkloadsGrid.test.tsx, facility.test.tsx):
 * both assert their rendered tile's primary link contains no interactive
 * descendant, so a future edit to either call site that violates this
 * contract fails CI rather than only failing an isolated Tile.tsx fixture
 * test (tile.test.tsx's own populated-actions case proves the SLOT is safe;
 * it does not and cannot prove a caller keeps `children` clean).
 */
export default function Tile({
  to,
  ariaLabel,
  children,
  actions,
}: {
  to: string
  ariaLabel: string
  /** The tile's visible face — rendered INSIDE the primary Link, so it must
   *  be non-interactive (no nested `<button>`/`<a>`/interactive role). Give
   *  anything that needs its own interactive target to `actions` instead. */
  children: React.ReactNode
  /** Optional actions slot, rendered as a SIBLING of the Link, never nested
   *  inside it. Omit (or leave undefined) to render nothing — the "introduce
   *  it empty" state this package ships. */
  actions?: React.ReactNode
}) {
  return (
    <div className="card group relative flex aspect-square flex-col gap-3 overflow-hidden rounded-xl transition hover:border-accent/40 hover:bg-white/5">
      <Link to={to} aria-label={ariaLabel} className="flex min-h-0 flex-1 flex-col gap-3">
        {children}
      </Link>
      {actions && <div className="absolute right-2 top-2 z-10">{actions}</div>}
    </div>
  )
}
