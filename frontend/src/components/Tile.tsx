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
 * CLICK-SURFACE PARITY (lkirc round-4 finding, and the reason for the split
 * below — read this before changing which element carries which class).
 * Round-4's FIRST attempt at this component put ALL of `card`'s styling
 * (background/border/rounded corners/padding/hover) on the OUTER container,
 * reasoning that the container is what a reader perceives as "the tile".
 * That was wrong: `card` (index.css) bundles `p-4` (1rem) AND a 1px border,
 * and the Link — the only element that is actually clickable/keyboard-
 * focusable — had no compensating padding, margin, or border of its own. The
 * card's background/border/hover/rounded-corner styling still visually
 * spanned the FULL padded+bordered box (the outer div's own box), but that
 * ~17px ring around every tile LOOKED like part of the tile while not being
 * part of the anchor at all — a real, silent shrink of the click/tap target
 * versus the pre-refactor single-`<Link>` shape, caught by lkirc's review
 * (a rendered-layout defect neither codex's review method nor this file's
 * own render-based tests could catch, since jsdom has no real layout engine
 * to observe box geometry with — see tile.test.tsx for what IS and isn't
 * testable here). A `-m-4 p-4` compensating margin on the Link closed the
 * padding portion of the gap but — verified with a real browser
 * (getBoundingClientRect against the actual compiled CSS, not reasoned about
 * in the abstract) — left a 1px-per-side residual from the border, which
 * still lived on the outer div only.
 *
 * The fix that actually closes the WHOLE gap, verified the same way: put
 * `card` (background/border/padding/rounded corners) AND the hover treatment
 * back on the Link directly — exactly where they lived pre-refactor — rather
 * than compensating for their absence with margin arithmetic. The outer
 * container keeps only what it structurally needs: `aspect-square flex
 * flex-col` (so the Link, as a `flex-1` child, is stretched to exactly fill
 * a square derived from the grid cell's width — the SAME sizing pathway the
 * pre-refactor top-level `<Link aspect-square>` used, just one layer
 * removed) and `relative group` (the positioning context for `actions`, and
 * the hook a future hover-reveal treatment on `actions` would need —
 * `group-hover:` only reaches DESCENDANTS of `.group`, and `actions` is a
 * SIBLING of the Link, not a descendant of it, so `group` has to live on
 * their common ancestor for that pattern to ever be reachable; see
 * Sidebar.tsx's tooltips for the existing `group-hover:` convention this
 * mirrors). With `card`'s own border/padding back on the Link, the Link's
 * border-box IS the outer div's border-box — no negative-margin arithmetic
 * needed at all, and no residual gap of any width, because there's no
 * second element's box model to reconcile against in the first place.
 *
 * CONTRACT (codex P2-1, dmfdeploy/dmfdeploy#347 WP-4, rounds 1-3): `children`
 * is the tile's non-interactive visible face — it renders INSIDE the primary
 * Link, so it must never itself contain an interactive element. Anything
 * that needs to be its OWN click/keyboard target belongs in `actions`, which
 * is a true sibling of the Link, never a descendant of it. TypeScript cannot
 * enforce this — `children: React.ReactNode` structurally accepts anything —
 * so the boundary is enforced by test coverage against the two real call
 * sites instead (mediaWorkloadsGrid.test.tsx, facility.test.tsx): both
 * assert their rendered tile's primary link contains no interactive
 * descendant, so a future edit to either call site that violates this
 * contract fails CI rather than only failing an isolated Tile.tsx fixture
 * test (tile.test.tsx's own populated-actions case proves the SLOT is safe;
 * it does not and cannot prove a caller keeps `children` clean).
 *
 * "Interactive element" here means EXACTLY testUtils/domAssertions.ts's
 * `assertNoInteractiveDescendant` set — that file is the operative
 * definition, not a stand-in for an unbounded one. Rounds 1-2 stated this
 * contract in unbounded language ("anything with an interactive role") while
 * the enforcement was necessarily bounded, which is what kept generating new
 * rounds of "but this narrower case slips through" findings against a moving
 * target. The set is deliberately bounded (documented with its own
 * rationale, including what's excluded and why, in domAssertions.ts) rather
 * than an attempt at exhaustive ARIA/HTML coverage; extending it is a
 * one-line, reviewable change in that one file, not a reason to keep this
 * comment's wording ahead of what's actually checked.
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
   *  be non-interactive per testUtils/domAssertions.ts's bounded set (see
   *  the CONTRACT note above). Give anything that needs its own interactive
   *  target to `actions` instead. */
  children: React.ReactNode
  /** Optional actions slot, rendered as a SIBLING of the Link, never nested
   *  inside it. Omit (or leave undefined) to render nothing — the "introduce
   *  it empty" state this package ships. */
  actions?: React.ReactNode
}) {
  return (
    <div className="group relative flex aspect-square flex-col">
      <Link
        to={to}
        aria-label={ariaLabel}
        className="card flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl transition hover:border-accent/40 hover:bg-white/5"
      >
        {children}
      </Link>
      {actions && <div className="absolute right-2 top-2 z-10">{actions}</div>}
    </div>
  )
}
