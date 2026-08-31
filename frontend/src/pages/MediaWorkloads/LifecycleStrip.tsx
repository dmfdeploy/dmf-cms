import { useId } from 'react'
import type { CSSProperties } from 'react'
import {
  FLOW_STEPS,
  type FlowStepId,
  type FlowStepState,
} from '../../lib/workloadFlow'
import { STAGE_ICON } from '../../lib/stageIcons'
import { RAIL_EDGE_HOVER, RAIL_FILL, RAIL_HOVER_INK, RAIL_INK, RAIL_SELECTED_FACE, RAIL_SELECTED_INK } from '../../lib/stagePalette'

/**
 * The wizard rail (umbrella #347 WO-D1, operator direction 2026-08-02).
 * Instead of a read-only chip row plus a separate numbered-step list below
 * it, the five orchestration chips ARE the wizard's step selector —
 * clicking one selects it, exactly one is mounted below (FlowStep.tsx).
 *
 * ARC 4 WP-3: LIVES IN THE HEADER SLOT, A SINGLE NON-WRAPPING ROW (umbrella
 * #347). See store/headerSlot.ts for how WorkloadSetup/WorkloadHome register
 * the rail model this component renders.
 *
 * DMFDEPLOY#414 — OPERATE REMOVED FROM THE RAIL ENTIRELY. See git history
 * for the full account; the rail is exactly the five EBU orchestration
 * keys below — no Control group, no Operate link.
 *
 * PASS 1 — CROSSPOINT BUS REDESIGN (dmf-cms#391) and PASS 2 — COMPLETENESS
 * GRAMMAR / EQUAL COLUMNS / REACHABLE LOCKED KEYS (dmfdeploy#449) and SHELL
 * ROUND 2 (dmfdeploy#481/#482/#483 — own band, icons, chevron form) shipped
 * the foundations below. See git history for those accounts.
 *
 * SHELL ROUND 2 REDESIGN, TWO OPERATOR-DIRECTED SIMPLIFICATIONS ON TOP OF
 * THAT FOUNDATION — both large net deletions, both decided BY EVIDENCE this
 * round produced rather than by restyling:
 *
 *   A. HUE REMOVED FROM THE RAIL ENTIRELY (not just off the fill — this
 *      round first moved it to a bottom-edge line, then measured it there
 *      and removed it outright). The measurement that decided it: on a 3px
 *      line, dE2000 between plan/provision drops to 0.85 (protanopia) and
 *      1.17 (deuteranopia) — imperceptible, below the ~1.0 threshold
 *      generally cited as the floor of human colour discrimination, for
 *      roughly 1 in 12 males. A cue that fails for that many viewers isn't
 *      an identity channel, so the operator judged it not worth the
 *      tokens, the CVD surface, or the doc surface it was costing. Every
 *      key now shares ONE neutral fill and ONE ink (RAIL_FILL/RAIL_INK
 *      below) — icon shape and the EBU label are the sole identity
 *      carriers, and were always independently sufficient (Art. 11 —
 *      "everything except hue survives greyscale"). See git history for
 *      the full fill-then-line-then-removed arc and the measurements at
 *      each stage; none of those figures are reproduced here — the
 *      surface they described no longer exists.
 *   B. THE POSITION TALLY REMOVED ENTIRELY (not restyled — a structural
 *      finding, not a visual one). Verified against the backend
 *      (`_derive_workload_lifecycle`, src/dmf_cms/media_workloads.py):
 *      the backend-derived position can only ever be `provision`,
 *      `configure`, `operate`, or `unknown` — Design, Plan and Finalise &
 *      Review are NEVER derived (ADR-0046 is explicit that finalise is
 *      never inferred from absence), and dmfdeploy#414 already removed
 *      Operate as a rail entry. So on this five-key rail, a position
 *      marker could only ever land on two of five keys — a coarse
 *      aggregate that collapses exactly the per-member divergence an
 *      operator would actually care about. `aria-current="step"` went
 *      with it: it announces a step in a gated sequence, which directly
 *      contradicts the IA doc's #493 amendment that a lifecycle stage is
 *      a PEER VIEW, not a step in a gated sequence — restyling a marker
 *      whose own semantics contradict the current model would have kept
 *      the contradiction, not fixed it. SELECTION IS NOW THE RAIL'S ONLY
 *      STATE. The per-stage actionable/uncommitted question is the badge
 *      slot below, reserved and empty until dmfdeploy#495/ADR-0046 lands.
 *   C. THE CHEVRON IS NOW DRAWN WITH `clip-path: shape()`, not
 *      `polygon()` (fix round, operator direction 2026-08-31: "rethink how
 *      this shape could be constructed"). The shipped polygon had grown to
 *      56 hand-tuned vertices — unreadable as source, and a polyline
 *      approximation of a curve rather than an exact one. `shape()` draws
 *      real curves directly, at any element width (percentages and
 *      `calc()` are first-class arguments to it — unlike `path()`,
 *      absolute coordinates only, or SVG's `objectBoundingBox`, which
 *      turns a uniform pixel radius into an ellipse on a non-square box,
 *      both rejected for the same reason in an earlier round). The
 *      construction itself is a GENERIC corner-rounding pass over a
 *      vertex list (`roundedVertex`/`roundedShape` below) — one function,
 *      driven entirely by data (`FIRST_VERTICES`/`MIDDLE_VERTICES`/
 *      `LAST_VERTICES`), rather than three hand-derived paths. Each vertex
 *      names its own rounding radius; the pass cuts a quadratic Bézier
 *      corner at every one of them (`curve to … with …`, the control point
 *      is the original sharp vertex) — no hand-written coordinate, no
 *      per-corner sweep-direction reasoning to get wrong.
 *
 *      FIVE RADII, not two — the operator's final read on a rendered
 *      variant board, correcting an earlier round's "8px box / 16px+6px
 *      arrow" split that over-rounded the tip into a blob and under-
 *      differentiated the two joints:
 *        - BOX_RADIUS (6px) — the outer terminal corners (Design's left
 *          end, Finalise & Review's right end). Deliberately NOT
 *          Sidebar.tsx's 8px `rounded-lg` any more: standard practice
 *          scales radius by element size bucket, and this 28px control
 *          and that sidebar tile's 40px are different buckets.
 *        - TIP_RADIUS (5px) — the protruding tip AND the concave notch
 *          apex (the SAME radius, both ends of the arrow). Small on
 *          purpose, on a 14px half-height: the operator's own reference
 *          keeps its tips crisply pointed, and 7px+ measured as a blob
 *          that lost the directional read.
 *        - JOINT_TIP_RADIUS (6px) / JOINT_NOTCH_RADIUS (8px) — the two
 *          corners where a flat top/bottom edge meets the arrow's diagonal
 *          edge, DELIBERATELY UNEQUAL. The tip-side joint's interior angle
 *          is obtuse (~120°); the notch-side joint's is acute (~77°) — at
 *          an equal radius the acute one reads sharper, because perceived
 *          softness tracks the included angle, not the radius alone (the
 *          operator circled exactly that corner twice as still too sharp
 *          before this was split). 6px and 8px read as equally soft.
 *      See NOTCH_DEPTH/TIP_RADIUS/BOX_RADIUS/JOINT_TIP_RADIUS/
 *      JOINT_NOTCH_RADIUS below for the exact values and the vertex lists
 *      for where each one applies.
 *
 *      Firefox is the wrinkle: MDN's own Baseline table calls `shape()`
 *      "newly available" since February 2026 across Chromium, Firefox and
 *      Safari, but an empirical support probe run against a real Firefox
 *      found its `curve` command specifically unsupported regardless of
 *      what that table claims — SUPPORTS_SHAPE_CURVE below is a runtime
 *      `CSS.supports` feature query, not an assumption from a compat
 *      table, and it probes `curve` specifically (this file emits no
 *      `arc` command) rather than stopping at "does shape() parse at
 *      all." Operator ruling on the gap: "just using regular rectangular
 *      in that case is fine" — where `curve` is unsupported, every key
 *      falls back to a plain `border-radius` rectangle, no chevron,
 *      rather than keeping the old 56-vertex polygon alive as a second
 *      geometry only that fallback would use.
 *
 * WHAT SURVIVES UNCHANGED: equal columns, per-key icons unconditionally
 * (dmfdeploy#482), no padlock (IA doc #493 amendment), no indicators in the
 * row (dmfdeploy#481/#499), the badge slot (reserved, empty), locked keys
 * reachable and visually identical to open ones of the same stage, and the
 * two-tone focus ring (re-verified and its own justification RESTATED
 * below for the now-simpler, hue-free state space — see that section).
 *
 * SELECTION IS THE RAIL'S ONLY STATE, now that the tally is gone.
 * `aria-pressed` marks it on the interactive `<button>` variant; a job-in-
 * flight key is not a button and carries a visually-hidden "Selected" text
 * node instead (WAI-ARIA 1.2 defines `aria-pressed` only for
 * `role="button"`).
 *
 * SELECTION — REBUILT, VISUAL PARITY FIX ROUND (dmfdeploy/dmfdeploy#512,
 * operator ruling off two separate rendered comparison boards — see
 * stagePalette.ts's own docstring for the full derivation, including the
 * retired achromatic invert AND the retired alpha-tint attempt this
 * superseded). Selection is a plain two-state class swap on `key-fill`
 * (RAIL_FILL <-> RAIL_SELECTED_FACE) plus a matching ink swap (RAIL_INK
 * <-> RAIL_SELECTED_INK) — no added layer. `key-edge` ALSO varies (see the
 * "EDGE CONTRAST WITHOUT A BORDER" section below, and stagePalette.ts
 * point (4)), but by its OWN state machine (resting/hover/selected), not
 * by selection alone. `RAIL_SELECTED_FACE` is the SAME literal
 * (`--color-selected-face`) Sidebar.tsx's own selected tile paints — a
 * shared opaque token, not merely "the same idea" — so the two surfaces
 * cannot drift apart the way two independently-tuned alpha tints once did.
 *
 *   - jsdom-provable (pinned in lifecycleStrip.test.tsx): a selected key's
 *     `key-fill` carries a DIFFERENT class (RAIL_SELECTED_FACE) than an
 *     unselected key's (RAIL_FILL), and its ink class differs
 *     (RAIL_SELECTED_INK vs RAIL_INK) — structural, not a contrast claim.
 *   - Render-measured, NOT jsdom-provable (recorded here and in the PR
 *     description): the RAIL_SELECTED_FACE/RAIL_FILL fill-vs-fill contrast
 *     and the RAIL_SELECTED_INK label-text contrast — see stagePalette.ts.
 *     jsdom computes no pixels; those numbers are the actual guarantee, the
 *     tests here only prove the mechanism producing them is intact.
 *
 * FOCUS RING — RE-VERIFIED against the new geometry AND the final ink/edge
 * tokens (the ring's OWN mechanism is unchanged across every pass of this
 * fix round — `outline-current` plus a fixed two-tone `box-shadow`
 * sandwich, on the unclipped `<button>` rather than the clipped fill
 * `<span>`, #483 caution 1 — only what it composites against moved, and
 * moved more than once):
 *   - `outline-current` reuses RAIL_INK (unselected/resting,
 *     `--color-resting-ink`, #b4b4b8) or RAIL_SELECTED_INK (selected,
 *     `text-bg`, dark). Unselected clears the page background comfortably
 *     alone (~9.6:1). SELECTED DOES NOT — dark-on-near-black is close to
 *     1:1 there, which is exactly the case the box-shadow sandwich below
 *     exists for; an EARLIER draft of this comment (written when
 *     RAIL_SELECTED_INK was briefly `text-accent`, a bright colour)
 *     claimed the sandwich was no longer load-bearing — that stopped
 *     being true the moment selected ink reverted to dark, and is
 *     corrected here rather than left for a future reader to trust the
 *     stale version.
 *   - The `box-shadow` two-tone sandwich (`--color-bg` inner, `--color-
 *     text` outer) is unconditional, and — per the correction just above —
 *     IS load-bearing again for the selected-and-focused case: `--color-
 *     bg` (inner stroke) clears 3:1 against `--color-rail-fill`/
 *     `--color-selected-face` (both faces a selected+focused key's ring
 *     might sit near); `--color-text` (outer stroke) clears 16.17:1
 *     against the page background regardless of what fill is behind it.
 *     Between the two, the ring stays visible regardless of ink state.
 *   - HOVER AND FOCUS DO NOT COLLIDE, verified on a real render with real
 *     pointer + Tab automation (not `element.focus()`, which does not
 *     reliably produce `:focus-visible`), hover alone / focus alone / both
 *     at once. They differ in POSITION as well as colour: hover
 *     (`key-edge`, `RAIL_EDGE_HOVER`) follows the clipped chevron's own
 *     silhouette, INSIDE the button's rectangular box; focus (this ring)
 *     sits OUTSIDE that same box, in the inter-key gap. A hovered-but-
 *     unfocused key never reads as focused in either combination checked.
 *   - GEOMETRY: total outward reach is governed by `outline-2`
 *     (2px, offset 0) and the box-shadow's own 2px second ring — both
 *     unaffected by the H/notch rescale above (the 3px inter-key gap is a
 *     `<ol>` layout constant, never derived from H), so the ring still
 *     fits inside the gap without touching a neighbouring key, unchanged
 *     from before this round.
 *
 * EDGE CONTRAST WITHOUT A BORDER (#483 caution 2) — RE-RESOLVED TWICE this
 * fix round, final shape below (see stagePalette.ts's own docstring, point
 * (4), for the two-pass account). A clipped shape still cannot carry a
 * normal border, and a single fill can no longer both clear 3:1 against
 * the page AND read as the darker, subtler face the operator asked for —
 * those two constraints conflict on ONE layer. The FIRST pass resolved
 * that with a "two-tone sandwich," a separate `key-edge` layer holding a
 * lighter neutral (#616161) permanently visible as a ring around the
 * darker `key-fill`; the SECOND pass, after a live-environment complaint
 * that the shipped selected face read "too bright," went further and
 * dropped the ring at rest too, not just when selected — `key-edge` now
 * repaints `key-fill`'s OWN colour at rest (no ring, expressed as same-
 * colour rather than transparency, so the painted region's size never
 * changes between states) and only shows a real ring — `--color-selected-
 * face`, previewing selection — on hover. The `border-radius` fallback (no
 * `shape()` support) carries the same two-layer construction the same
 * way regardless of which colour either layer currently holds — the
 * inner rectangle is just 2px smaller than the outer one, radius is the
 * only difference from the clipped case. See stagePalette.ts's own
 * docstring for why a boundary with no independent 3:1 guarantee at rest
 * is still WCAG 1.4.11-conformant here (the visible label text does that
 * job instead).
 *
 * NARROW-WIDTH FIX ROUND (dmf-cms#128). lkirc's review correctly called the
 * `justify-center` change above a narrow-width regression, but predicted the
 * wrong MECHANISM — negative inline-start overflow pushing the leading keys
 * out of the scroll container's reach. Measured on the real render at
 * 900/600/400px instead: that never happens, the first key sits at +1.0px
 * in every case, because something worse does — the `<ol>` SHRINKS rather
 * than overflowing (400px container -> 400px `<ol>`, not its 843px
 * max-content width; every key 166px -> 78px; "Finalise & Review"'s 142px
 * label then overflows its own 78px key and spills across its neighbours).
 * The `<ol>`'s own "`w-max` is load-bearing" comment was aspirational, not
 * actual: `w-max` sets a flex item's PREFERRED width, and a flex item's
 * default `flex-shrink: 1` overrides that regardless. Two-tier fix,
 * operator-approved:
 *   1. `shrink-0` on the `<ol>` makes `w-max` actually hold, restoring
 *      scroll-not-wrap — Topbar.tsx's `overflow-x-auto` wrapper scrolls,
 *      which is what it's for. `justify-center` on the `<nav>` becomes
 *      `justify-center-safe` in the same round: with the `<ol>` no longer
 *      shrinking, it genuinely CAN overflow the `<nav>` now, and safe
 *      centring is what forecloses lkirc's originally predicted failure
 *      mode for good, rather than that failure mode simply having had
 *      nothing to trigger it yet.
 *   2. Below ~390px the rail abandons the horizontal chevron entirely and
 *      stacks vertically instead — from the approved design artifact,
 *      verbatim: "It survives rotation - the notch is dropped and sequence
 *      is carried by vertical order, which is the stronger cue on a phone
 *      anyway. Full labels fit at 390px, so Finalise & Review never needs
 *      abbreviating." Icons-only was considered and rejected: hue is gone
 *      from this rail entirely (point A above), so identity already rests
 *      on icon PLUS label alone — dropping labels at exactly the width
 *      where space is tightest would leave a single carrier for the one
 *      channel this round already spent its whole CVD budget protecting.
 * The stacked layout is `max-[390px]:grid-cols-1`/`max-[390px]:w-full` on
 * the `<ol>` (see that element's own comment above). The notch drop is
 * `.lifecycle-rail-chevron`/`.lifecycle-rail-content` in index.css,
 * `!important`-overriding chevronStyle()/contentOffsetStyle()'s INLINE
 * styles below at that width — the one place in this rail a stylesheet rule
 * has to out-rank an inline one, because those two functions compute a
 * per-key value no CSS selector can see.
 */

const STEP_LABEL: Record<FlowStepId, string> = {
  design: 'Design',
  plan: 'Plan',
  provision: 'Provision',
  configure: 'Configure',
  finalise: 'Finalise & Review',
}

/** The button's own fixed content height, and half of it — every
 *  coordinate below is relative to the vertical centre (`50% ± Dpx`, see
 *  `fmt`), so this is only used to work out each vertex's own position,
 *  never emitted directly.
 *
 *  VISUAL PARITY FIX ROUND (dmfdeploy/dmfdeploy#512, operator finding
 *  against a live provision run): 28 -> 40, matching Sidebar.tsx:127's
 *  `h-10 w-10` selected tile exactly — the rail key and the nav tile are now
 *  the same control at the same size, not two different-sized buckets. This
 *  is no longer implicit in padding arithmetic (28px used to fall out of
 *  `py-1.5` plus the 14px icon/16px label line-height by coincidence, with
 *  nothing pinning it): the button/div elements below now also carry an
 *  explicit `h-10`, so H is an enforced fact about the box, not a value
 *  this file merely assumes the DOM will happen to produce. Every other
 *  geometry constant below is DERIVED from this one by the same scale
 *  factor (40/28 = 10/7 ≈ 1.43), then hand-judged on a real render — see
 *  each constant's own comment for the rounding and, where it changed the
 *  proportions rather than just scaling them, why. */
const H = 40
const M = H / 2

/**
 * The arrow's horizontal inset — how far in from its own edge the
 * protruding tip's transition joints sit, AND how far in from the left
 * edge the receiving notch's own apex reaches. The SAME constant, both
 * ends of the arrow (operator: "the arrow's horizontal inset, tip and
 * tail alike") — this round's proportions read clearly as directional
 * sequence on a key this wide without being aggressive, which matters
 * because these stages are peer views, not a gated flow; an overstated
 * arrow would misstate that model.
 *
 * VISUAL PARITY FIX ROUND (#512): 12 -> 17 (12 * 40/28 = 17.14, rounded).
 * Scaling this one linearly with H, rather than judging it fresh, is
 * deliberate: the notch's horizontal reach is what makes the interlock
 * read as an ARROW rather than a bar with a bite taken out, and that
 * proportion (notch depth : key height) is exactly what a real render at
 * 40px confirmed still reads correctly unscaled — nothing about a taller
 * key changes what fraction of it should be "the arrow."
 */
const NOTCH_DEPTH = 17

/**
 * The tip radius — the protruding point's own apex AND the concave
 * notch's own apex, the SAME radius for both. Small deliberately: on a
 * 20px half-height (M above), the operator's own reference image keeps
 * its tips crisply pointed with restrained rounding, and a rendered
 * variant board found 7px+ turns the tip into a blob and loses the
 * directional read entirely.
 *
 * VISUAL PARITY FIX ROUND (#512): 5 -> 7 (5 * 40/28 = 7.14, rounded) — the
 * plain linear scale, confirmed still crisp (not blob-y) on a real render
 * at the new size, so no separate hand-tuning was needed here.
 */
const TIP_RADIUS = 7

/**
 * The outer box terminal corner radius — Design's left end, Finalise &
 * Review's right end.
 *
 * VISUAL PARITY FIX ROUND (#512): 6 -> 8. This is NOT just the linear
 * scale (6 * 40/28 = 8.57, which would round to 9) — it is Sidebar.tsx:127's
 * own `h-10 w-10 rounded-lg` value (`rounded-lg` = 8px), taken deliberately
 * exact rather than independently rounded. The PRIOR round of this comment
 * argued 6px specifically BECAUSE the rail's 28px key and the sidebar's
 * 40px tile were different size buckets, and standard practice scales
 * corner radius by bucket — that reasoning is why this round does NOT
 * independently re-derive a rail-specific radius any more: the rail key IS
 * now the sidebar tile's bucket (both 40px, per H above), so the same
 * radius is the size-correct value, not a coincidence to round away.
 */
const BOX_RADIUS = 8

/**
 * TWO DELIBERATELY UNEQUAL JOINT RADII — the corners where a flat top/
 * bottom edge meets the arrow's diagonal edge. Not the same size, because
 * the two joints' interior angles are not the same: the tip-side joint
 * (JOINT_TIP_RADIUS) is obtuse, ~120°; the notch-side joint
 * (JOINT_NOTCH_RADIUS) is acute, ~77° — and at an EQUAL radius the acute
 * corner reads visibly sharper than the obtuse one, because perceived
 * softness depends on the included angle, not the radius alone. This is
 * not a guess: the operator circled exactly the notch-side joints twice,
 * on two different equal-radius attempts, as still too sharp.
 *
 * VISUAL PARITY FIX ROUND (#512): 6/8 -> 9/12 — the linear scale is
 * 8.57/11.43; rounded independently that lands on 9/11, which would quietly
 * shift the ratio between the two (0.818, vs the original 0.75) and reopen
 * exactly the "acute corner reads sharper" gap the split radius exists to
 * close. 9/12 keeps the ratio EXACTLY 0.75 — both joints stay equally soft
 * by construction, not by accident of rounding — and reads correctly on a
 * real render at the new size.
 */
const JOINT_TIP_RADIUS = 9
const JOINT_NOTCH_RADIUS = 12

/** A 2D point in one key's own local px frame: `u` is the distance INTO
 *  the shape from whichever edge the feature is anchored to (0 at the
 *  edge, growing inward), `y` is measured from the top (0 to H). */
interface LocalPoint {
  u: number
  y: number
}

/** Which edge a point's `u` is measured from: `'right'` emits
 *  `calc(100% - Upx)` (point-side vertices, protruding out toward 100%),
 *  `'left'` emits `Upx` directly (notch-side vertices, receding in from
 *  0). This is the one place the shape-vs-mirror-image distinction is
 *  made — every vertex below names which edge it belongs to. */
type Anchor = 'left' | 'right'
interface TaggedPoint extends LocalPoint {
  anchor: Anchor
}
const at = (u: number, y: number, anchor: Anchor): TaggedPoint => ({ u, y, anchor })

/** One corner of the RAW (unrounded) polygon this rail's silhouette would
 *  be without any rounding at all: a position plus the radius its own
 *  corner gets cut to. `FIRST_VERTICES`/`MIDDLE_VERTICES`/`LAST_VERTICES`
 *  below are the only design-specific data in this file — `roundedShape`
 *  turns any such list into a real `shape()` path, unchanged by which
 *  list it's given. */
interface Vertex extends TaggedPoint {
  r: number
}
const vertex = (u: number, y: number, anchor: Anchor, r: number): Vertex => ({ ...at(u, y, anchor), r })

/** Formats one point as a `shape()` coordinate pair — see `Anchor` above
 *  for the `u` convention. `y` is always relative to the vertical centre
 *  (`50% ± Dpx`). */
function fmt(p: TaggedPoint): string {
  const u = Number(p.u.toFixed(3))
  const x = p.anchor === 'right' ? (u === 0 ? '100%' : `calc(100% - ${u}px)`) : u === 0 ? '0%' : `${u}px`
  const dy = Number((p.y - M).toFixed(3))
  const y = Math.abs(dy) < 1e-6 ? '50%' : dy > 0 ? `calc(50% + ${dy}px)` : `calc(50% - ${-dy}px)`
  return `${x} ${y}`
}

/** The unit direction and length from `cur` toward `neighbour`, in `cur`'s
 *  OWN local frame. Same anchor on both ends (e.g. the notch's own two
 *  diagonal edges, or a box corner's straight vertical edge): computed
 *  exactly via ordinary vector subtraction, both points already share a
 *  comparable `u`. DIFFERENT anchors (only ever the long flat top/bottom
 *  edge, connecting the notch-side cluster of vertices to the point/box-
 *  side cluster): its direction from `cur` is always +u — "away from
 *  cur's own anchor edge, toward the interior" is what +u MEANS, and the
 *  flat edge always runs toward the interior from both ends by
 *  construction — and its real length is runtime/content-driven, not
 *  knowable here, but always far larger than twice the biggest radius
 *  this file uses (the shortest EBU label alone forces a key over 100px
 *  wide; every radius below is 8px or under), so the `d = min(r, len/2)`
 *  clamp below never actually engages for it — represented as `Infinity`
 *  rather than computed. */
function edgeVector(cur: Vertex, neighbour: Vertex): { dir: LocalPoint; len: number } {
  if (cur.anchor === neighbour.anchor) {
    const du = neighbour.u - cur.u
    const dy = neighbour.y - cur.y
    const len = Math.hypot(du, dy)
    return { dir: { u: du / len, y: dy / len }, len }
  }
  return { dir: { u: 1, y: 0 }, len: Infinity }
}

/** GENERIC CORNER ROUNDING: replaces the sharp vertex `cur` with a
 *  quadratic Bézier cut, using `cur` itself as the curve's control point —
 *  the standard "pull both edge endpoints back by `d`, curve through the
 *  original corner" construction, `d` clamped to half of whichever
 *  adjacent edge is shorter so a large radius on a short edge can never
 *  overrun it. Pure function of `cur`'s own two neighbours in the vertex
 *  list; nothing here is specific to any one of the three key shapes. */
function roundedVertex(prev: Vertex, cur: Vertex, next: Vertex) {
  const toPrev = edgeVector(cur, prev)
  const toNext = edgeVector(cur, next)
  const d = Math.min(cur.r, toPrev.len / 2, toNext.len / 2)
  const entry = at(cur.u + d * toPrev.dir.u, cur.y + d * toPrev.dir.y, cur.anchor)
  const exit = at(cur.u + d * toNext.dir.u, cur.y + d * toNext.dir.y, cur.anchor)
  const control = at(cur.u, cur.y, cur.anchor)
  return { entry, exit, control, d }
}

/** Turns a closed, ordered vertex list into a `shape()` path: walk the
 *  list, cut every corner via `roundedVertex`, and connect corner N's
 *  exit point to corner N+1's entry point with a straight `line to` (the
 *  short leftover span of whatever edge the rounding didn't consume — see
 *  `edgeVector`). `d <= 0.01` skips the curve for a degenerate corner
 *  (this file's own radii never produce one, but the fallback keeps the
 *  function correct for any vertex list, not just these three). */
function roundedShape(vertices: Vertex[]): string {
  const n = vertices.length
  const corners = vertices.map((v, i) => roundedVertex(vertices[(i - 1 + n) % n], v, vertices[(i + 1) % n]))
  const commands = [`from ${fmt(corners[0].entry)}`]
  corners.forEach((corner, i) => {
    commands.push(corner.d > 0.01 ? `curve to ${fmt(corner.exit)} with ${fmt(corner.control)}` : `line to ${fmt(corner.exit)}`)
    if (i < n - 1) commands.push(`line to ${fmt(corners[i + 1].entry)}`)
  })
  commands.push('close')
  return `shape(${commands.join(', ')})`
}

/**
 * The three vertex lists — the ONLY place this file's actual silhouette
 * is specified. Each is the RAW (unrounded) polygon's corners in walk
 * order, `(u, y, anchor, radius)`; `roundedShape` does the rest. `M` is
 * the vertical centre (both the tip and notch apexes sit there); every
 * other vertex sits on the top (`0`) or bottom (`H`) edge.
 *
 * THE INTERLOCK: the receiving notch's own apex sits at `u = NOTCH_DEPTH`
 * FROM THE LEFT EDGE (i.e. pushed INTO the key), congruent with the
 * previous key's tip (which protrudes OUT to `u = 0` from the right
 * edge) — the two nest. Putting the notch apex at `u = 0` instead would
 * make it a second point facing the same way as the first (a symmetric
 * hexagon, not a chevron) and the two keys could never interlock.
 */
const FIRST_VERTICES: Vertex[] = [
  vertex(0, 0, 'left', BOX_RADIUS),
  vertex(NOTCH_DEPTH, 0, 'right', JOINT_TIP_RADIUS),
  vertex(0, M, 'right', TIP_RADIUS),
  vertex(NOTCH_DEPTH, H, 'right', JOINT_TIP_RADIUS),
  vertex(0, H, 'left', BOX_RADIUS),
]

const MIDDLE_VERTICES: Vertex[] = [
  vertex(0, 0, 'left', JOINT_NOTCH_RADIUS),
  vertex(NOTCH_DEPTH, 0, 'right', JOINT_TIP_RADIUS),
  vertex(0, M, 'right', TIP_RADIUS),
  vertex(NOTCH_DEPTH, H, 'right', JOINT_TIP_RADIUS),
  vertex(0, H, 'left', JOINT_NOTCH_RADIUS),
  vertex(NOTCH_DEPTH, M, 'left', TIP_RADIUS),
]

const LAST_VERTICES: Vertex[] = [
  vertex(0, 0, 'left', JOINT_NOTCH_RADIUS),
  vertex(0, 0, 'right', BOX_RADIUS),
  vertex(0, H, 'right', BOX_RADIUS),
  vertex(0, H, 'left', JOINT_NOTCH_RADIUS),
  vertex(NOTCH_DEPTH, M, 'left', TIP_RADIUS),
]

const FIRST_SHAPE = roundedShape(FIRST_VERTICES)
const MIDDLE_SHAPE = roundedShape(MIDDLE_VERTICES)
const LAST_SHAPE = roundedShape(LAST_VERTICES)

/**
 * FEATURE QUERY — probes the `curve` command specifically (the only
 * `shape()` command this file emits), not just `shape()` itself: a
 * browser can parse the function and still reject one of its commands, so
 * "supports `shape()`" is not the same claim as "supports what this rail
 * actually draws with it." The probe string mirrors real usage (a
 * `curve` argument mixing `calc()`/`%`) rather than the shortest string
 * that would pass.
 *
 * NOT taken from a compat table: MDN's own Baseline entry for `shape()`
 * calls it "newly available" since February 2026 across Chromium, Firefox
 * and Safari, but an empirical support probe run against a real Firefox
 * found `curve` specifically unsupported there regardless of what that
 * table claims — this is a runtime `CSS.supports` call, not an
 * assumption. `CSS` is undefined in jsdom (this repo's test environment
 * has no such global), which resolves this to `false` there too — the
 * fallback rectangle below is exactly what the test suite exercises,
 * which is fine per lifecycleStrip.test.tsx's own "jsdom computes no
 * pixels" rule; the chevron geometry is a real-browser concern, same as
 * before this round.
 */
const SUPPORTS_SHAPE_CURVE =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('clip-path', 'shape(from 0 0, curve to calc(100% - 5px) 50% with 5px 5px, close)')

/**
 * The chevron fill layer's style for one key's position. Native `shape()`
 * where `curve` is supported; a plain rounded rectangle everywhere else —
 * operator ruling 2026-08-31, on being shown the Firefox gap above: "just
 * using regular rectangular in that case is fine." No `position`
 * branching in the fallback (first/middle/last all render identically) —
 * a browser that cannot draw the chevron gets one consistent plain shape,
 * not a partial imitation of it. Uses BOX_RADIUS, the same radius the
 * shape()'d silhouette uses for its own outer terminal corners.
 */
function chevronStyle(position: 'first' | 'middle' | 'last'): CSSProperties {
  if (!SUPPORTS_SHAPE_CURVE) return { borderRadius: `${BOX_RADIUS}px` }
  return { clipPath: position === 'first' ? FIRST_SHAPE : position === 'last' ? LAST_SHAPE : MIDDLE_SHAPE }
}

/**
 * FIX ROUND — CONTENT RE-CENTRING. The icon+label group is centred by the
 * flex `<button>`'s own `justify-center` against the BOX, but a notched
 * key's PAINTED shape isn't the box — the notch removes NOTCH_DEPTH px of
 * material from the left side only (see MIDDLE_VERTICES/LAST_VERTICES),
 * which moves the shape's own optical centre right by half that. Measured
 * on a real render (operator finding against a90bfd2's own harness): the
 * content group sat exactly NOTCH_DEPTH / 2 = 6px left of the painted
 * centre on every notched key (Plan, Provision, Configure, Finalise &
 * Review) — visible first on Finalise & Review, the longest label with
 * the least slack, but present on all four. Design was the one key
 * already correct: no notch, flat left edge, box centre and painted
 * centre already coincide.
 *
 * Derived from NOTCH_DEPTH rather than hardcoded so a future retune of
 * the notch depth stays correct here too. Exported so
 * lifecycleStrip.test.tsx can pin the exact figure rather than
 * re-deriving or hardcoding its own copy.
 *
 * VISUAL PARITY FIX ROUND (#512): NOTCH_DEPTH's own rescale (12 -> 17)
 * carries straight through — 8.5px now, not 6px. Left as a genuine half-
 * integer rather than rounded to keep it exact for a browser that will
 * itself render the resulting `calc()`/`translateX()` at sub-pixel
 * precision; rounding here would reintroduce a fraction-of-a-pixel drift
 * this formula exists specifically to avoid.
 */
export const CONTENT_OFFSET_PX = NOTCH_DEPTH / 2

/**
 * The content group's own style for one key's position. `shapeIsPainted`
 * is threaded in explicitly (SUPPORTS_SHAPE_CURVE at the one real call
 * site below) rather than read off the module-level constant directly —
 * this is the one function in this file a test needs to exercise both
 * branches of, and SUPPORTS_SHAPE_CURVE itself is fixed for the whole
 * module's lifetime (jsdom has no `CSS` global, so it is always `false`
 * under the test suite — see SUPPORTS_SHAPE_CURVE's own comment). An
 * explicit parameter is what makes both branches reachable from a test
 * without mocking `CSS.supports`.
 *
 * Two conditions, both required, for the offset to apply:
 *   - `position !== 'first'` — a first key has no notch (flat left edge),
 *     so its box centre and painted centre already coincide; a blanket
 *     offset would push it OFF centre instead of fixing anything.
 *   - `shapeIsPainted` — the border-radius fallback (no `shape()`
 *     support) is a plain, un-notched rectangle on every position, so its
 *     painted centre already coincides with the box centre everywhere;
 *     applying this offset there would introduce the exact off-centre
 *     defect it exists to fix, on a shape that never had it.
 * `middle` AND `last` both get the shift, not just `middle` — `last`
 * carries the same LEFT notch as `middle` (its box-corner treatment is on
 * its RIGHT edge only, see LAST_VERTICES), so it needs the identical
 * correction, not the mirror-image one.
 */
export function contentOffsetStyle(position: 'first' | 'middle' | 'last', shapeIsPainted: boolean): CSSProperties {
  if (!shapeIsPainted || position === 'first') return {}
  return { transform: `translateX(${CONTENT_OFFSET_PX}px)` }
}

export default function LifecycleStrip({
  steps,
  activeChip,
  lockedReasons,
  jobInFlight,
  onSelect,
}: {
  steps: Record<FlowStepId, FlowStepState>
  /** Which of the five keys reads as selected, or none. Drives the
   *  inverted fill — the rail's ONLY state now (position tally removed,
   *  see the file docstring's point B). The accessible signal on top of
   *  that varies by branch: `aria-pressed` on the interactive `<button>`
   *  variant, a visually-hidden "Selected" text node on a job-in-flight
   *  chip's inert `<div>`. */
  activeChip: FlowStepId | null
  lockedReasons: Record<FlowStepId, string>
  jobInFlight: boolean
  onSelect: (step: FlowStepId) => void
}) {
  // Unique per mounted rail — the dev harness renders several at once, and
  // duplicate ids would make aria-describedby resolve to the wrong key's
  // description.
  const railId = useId()

  return (
    // SHELL ROUND 2 (#481): centred, not left-hugging — there is no
    // right-pinned sibling left in this row to fight the centring. `w-full`
    // so the centring has the row's full width to work against.
    //
    // FIX ROUND (dmf-cms#128, lkirc's review + operator-measured
    // mechanism): plain `justify-center` here was HALF of the narrow-width
    // regression — `justify-center-safe` (`justify-content: safe center`)
    // is the fix, not a defensive extra. See the `<ol>` comment just below
    // for the other half (`shrink-0`, the actual defect) and this file's
    // own docstring ("NARROW-WIDTH FIX ROUND") for the full mechanism.
    <nav aria-label="Media workload lifecycle" className="flex w-full flex-nowrap items-center justify-center-safe">
      {/*
        EQUAL COLUMNS (dmfdeploy#449, plan §3.3, unchanged by this redesign).
        `w-max` sets the grid's PREFERRED width, not its floor — Tailwind's
        `grid-cols-5` is `repeat(5, minmax(0, 1fr))`, a 0 minimum, not
        `auto`, so under the horizontal-scroll ancestor this row lives in
        (Topbar's overflow-x-auto wrapper) the tracks would happily shrink
        below their content and wrap the labels rather than overflow.

        FIX ROUND (dmf-cms#128, lkirc's review + operator-measured
        mechanism): `shrink-0` is what actually stops that, and it was
        MISSING — this comment used to call `w-max` alone load-bearing, but
        this `<ol>` is itself a flex ITEM of the `<nav>` above (`display:
        flex`), and a flex item's default `flex-shrink: 1` shrinks it below
        its own preferred width regardless of what that width is set to.
        Measured on the real render at a 400px container: the `<ol>`
        computed to 400px, not its 843px max-content width, every key
        collapsed 166px -> 78px, and "Finalise & Review"'s 142px label then
        overflowed its own 78px key and spilled across its neighbours.
        `shrink-0` pins the grid to its max-content width for real, which is
        what lets the ancestor scroll — the thing that ancestor exists for —
        instead of the tracks collapsing. See the `<nav>` comment above for
        why `justify-center` became `justify-center-safe` in the same fix:
        once the `<ol>` can no longer shrink, it genuinely CAN overflow the
        `<nav>` at narrow widths, and plain `justify-center` centres an
        overflowing item symmetrically — including into negative
        inline-start overflow, which a scroll container cannot reach (the
        failure lkirc's review predicted, from the right cause-and-effect
        shape but the wrong trigger — it doesn't fire today because nothing
        has ever actually overflowed the nav until this fix makes the ol
        stop shrinking). `safe center` falls back to start-alignment exactly
        when that would happen, closing that door rather than merely not
        having opened it yet.

        The gap is 3px (#483: "a 2-3px band-coloured gap cut into the shape
        so keys nest without visually touching") — `max-[390px]:` below
        widens it to 8px, because the stacked, notch-dropped layout at that
        width no longer interlocks and reads better with normal breathing
        room between rows. `max-[390px]:grid-cols-1` / `max-[390px]:w-full`
        are the OTHER tier of this fix round — see this file's own
        docstring, "NARROW-WIDTH FIX ROUND", for why a rail this narrow
        stacks vertically instead of continuing to scroll.
      */}
      <ol className="grid w-max shrink-0 grid-cols-5 items-center gap-[3px] max-[390px]:w-full max-[390px]:grid-cols-1 max-[390px]:gap-2">
        {FLOW_STEPS.map((id, index) => {
          const state = steps[id]
          const locked = state === 'locked'
          const isSelected = id === activeChip
          // dmfdeploy#405: `locked` is NO LONGER a reason to refuse the
          // click. A locked key selects and mounts its own stated reason,
          // exactly as the draft wizard's Previous/Next already walk into
          // locked steps. The safety property is unchanged and still lives
          // where it always did — FlowStep.tsx renders a locked step's REASON
          // PROSE AND NEVER ITS CHILDREN — so making the key reachable
          // exposes an explanation, never a stage control. A job in flight
          // still demotes every key to inert: that is a different fact from
          // locked, and the whole row is genuinely un-actionable while a job
          // runs.
          const interactive = !jobInFlight
          const descriptionId = `${railId}-${id}-state`
          const Icon = STAGE_ICON[id]
          const position = index === 0 ? 'first' : index === FLOW_STEPS.length - 1 ? 'last' : 'middle'
          // Computed once per key, shared by both fill layers below — the
          // edge/fill spans are two different ELEMENTS painting the SAME
          // silhouette, not two different shapes.
          const shapeStyle = chevronStyle(position)

          // VISUAL PARITY FIX ROUND (#512, operator ruling off a rendered
          // A/B/C comparison — see stagePalette.ts's own docstring for the
          // full derivation, including the interim alpha-tint attempt this
          // superseded, and point (4) for the edge's own separate ruling).
          // RAIL_FILL/RAIL_SELECTED_FACE and RAIL_INK/RAIL_SELECTED_INK are
          // a plain two-state swap, the SAME shape this rail used before
          // the alpha-tint detour (just different token values, and now
          // shared byte-for-byte with Sidebar.tsx's own selected tile).
          const fillClass = isSelected ? RAIL_SELECTED_FACE : RAIL_FILL
          // Hover is a NEW state for this rail (it never had one before this
          // fix round) — added as a consequence of the resting-ink ruling,
          // not an independent decision: RAIL_INK moved off `--color-text`
          // to leave hover somewhere to brighten TO, so the rail needed an
          // actual hover rule to spend that headroom on, matching
          // Sidebar.tsx's own resting/hover pair. Gated to the unselected
          // case only, same as Sidebar.tsx's own `hover:` — a selected
          // key's ink (RAIL_SELECTED_INK, dark-on-bright) has no matching
          // hover concept.
          const inkClass = isSelected ? RAIL_SELECTED_INK : `${RAIL_INK} ${RAIL_HOVER_INK}`
          // The EDGE, point (4)'s own FINAL ruling (a first pass kept
          // RAIL_EDGE #616161 visible at rest; superseded — see
          // stagePalette.ts). No ring at rest OR selected, a hover-only
          // preview-of-selection ring: resting is RAIL_FILL — THE SAME
          // TOKEN AS THE FACE, a colour choice, not a transparent edge
          // (transparent would let the band show through and change the
          // painted region's size between states, moving whatever
          // `contentOffsetStyle()` centres on). `RAIL_EDGE_HOVER`
          // (`group-hover:bg-selected-face`) is a SECOND hover carrier
          // alongside the ink, not an independent choice — deliberately
          // the SELECTED face colour (a preview of selection), which also
          // happens to keep hover and focus visually apart: this rail's
          // OWN focus ring was never accent-coloured to begin with (see
          // the "FOCUS RING" section below — it uses ink/neutral tokens,
          // not `--color-accent`), so hover and focus differ in position
          // (inside the shape vs outside it) as well as colour either way.
          // Selected stays RAIL_SELECTED_FACE
          // unconditionally, unaffected by hover.
          const edgeClass = isSelected ? RAIL_SELECTED_FACE : `${RAIL_FILL} ${RAIL_EDGE_HOVER}`

          const inner = (
            <>
              {/* FIX ROUND (operator ruling 2026-08-31): these five icons
                  are inline filled SVG now, not `lucide-react` — see
                  stageIcons.tsx's own docstring for the full provenance.
                  `strokeWidth` no longer applies to a filled silhouette,
                  so it is dropped here rather than passed and ignored.
                  VISUAL PARITY FIX ROUND (#512): h-3.5/w-3.5 (14px) ->
                  h-5/w-5 (20px) — both are 50% of their container (28px
                  key, 40px key respectively, matching Sidebar.tsx:131's
                  `w-5 h-5` icon in its own 40px tile), so this falls
                  straight out of the H rescale above rather than being an
                  independent choice. */}
              <Icon aria-hidden="true" className="h-5 w-5 shrink-0" />
              <span className="text-xs font-semibold">{STEP_LABEL[id]}</span>
              {/* Badge slot (Visual System doc §5): reserved geometry and
                  width budget for a future actionable-item count
                  (dmfdeploy#495, ADR-0046) — rendered EMPTY this round.
                  "Nothing painted twice, nothing claiming a number the
                  console cannot yet verify." Fixed-width so a later count
                  does not shift every key's width out from under equal
                  columns. */}
              <span aria-hidden="true" data-testid="badge-slot" className="w-3.5 shrink-0" />
              {/* Locked is the one remaining per-key fact worth stating in
                  words (IA doc's #493 amendment: "conveyed in words... never
                  as a lock glyph on the rail") — carried as a DESCRIPTION
                  rather than folded into the key's accessible NAME, which
                  stays exactly the EBU label (every test in this suite
                  addresses keys by it). */}
              {locked && (
                <span id={descriptionId} className="sr-only">
                  {`Locked. ${lockedReasons[id]}`}
                </span>
              )}
            </>
          )

          // VISUAL PARITY FIX ROUND (#512): TWO stacked clipped layers,
          // painting the same silhouette — see stagePalette.ts's own
          // docstring for the full contrast derivation. Outer to inner:
          //   - key-edge (`inset-0`): STATE-DEPENDENT (point (4)) — RAIL_FILL
          //     at rest (same token as the face: a colour choice expressing
          //     "no ring", not a transparent one — transparent would change
          //     the painted region's SIZE between rest and hover), the
          //     shared RAIL_SELECTED_FACE on `group-hover` (a preview of
          //     selection, not accent — see stagePalette.ts for why), and
          //     RAIL_SELECTED_FACE unconditionally once selected.
          //   - key-fill (`inset-[2px]`, i.e. inset 2px on every side):
          //     swaps between the darker RAIL_FILL (unselected) and the
          //     shared opaque RAIL_SELECTED_FACE (selected) — a plain
          //     two-state class swap, not an added layer.
          // `pointer-events-none` on BOTH — see the "HOVER TARGET BUG"
          // account in stagePalette.ts: these are purely decorative
          // (`aria-hidden`) clipped layers, and letting either one
          // intercept the pointer meant hovering the label or icon (which
          // `key-fill` visually covers) missed `key-edge`'s own `:hover`
          // entirely, since a bare `hover:` class only fires for pointer
          // positions over THAT element's own clipped hit-test region.
          // With pointer-events disabled here, the unclipped BUTTON below
          // is always the actual pointer target, and both layers now key
          // off ITS `group` hover state via `group-hover:`, not their own.
          // Both share `shapeStyle` (computed once above) and the
          // `lifecycle-rail-chevron` CSS hook class, so the narrow-width
          // notch-drop override below applies to both identically.
          const fillLayers = (
            <>
              <span aria-hidden="true" data-testid="key-edge" className={`pointer-events-none absolute inset-0 lifecycle-rail-chevron ${edgeClass}`} style={shapeStyle} />
              <span aria-hidden="true" data-testid="key-fill" className={`pointer-events-none absolute inset-[2px] lifecycle-rail-chevron ${fillClass}`} style={shapeStyle} />
            </>
          )

          return (
            <li key={id} className="flex items-center">
              {interactive ? (
                <button
                  type="button"
                  // `group`: see `fillLayers`'s own comment just above — the
                  // key-edge layer's `group-hover:` binding needs this on
                  // an ancestor, and the button is the correct one since it
                  // is the sole real pointer target now.
                  className={`group relative flex h-10 w-full items-center justify-center gap-1.5 whitespace-nowrap px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-current focus-visible:shadow-[0_0_0_1px_var(--color-bg),0_0_0_2px_var(--color-text)] ${inkClass}`}
                  // Explicit accessible name — the key's own label is all
                  // there is now (no trailing state word to exclude), but an
                  // explicit aria-label keeps this independent of whatever
                  // else ends up inside the button in a later pass.
                  aria-label={STEP_LABEL[id]}
                  aria-describedby={locked ? descriptionId : undefined}
                  aria-pressed={isSelected}
                  onClick={() => onSelect(id)}
                >
                  {fillLayers}
                  <span data-testid="key-content" className="relative z-10 flex items-center justify-center gap-1.5 lifecycle-rail-content" style={contentOffsetStyle(position, SUPPORTS_SHAPE_CURVE)}>
                    {inner}
                  </span>
                </button>
              ) : (
                <div
                  className={`relative flex h-10 w-full items-center justify-center gap-1.5 whitespace-nowrap px-3 py-1.5 ${inkClass}`}
                  aria-label={STEP_LABEL[id]}
                  aria-describedby={locked ? descriptionId : undefined}
                >
                  {fillLayers}
                  <span data-testid="key-content" className="relative z-10 flex items-center justify-center gap-1.5 lifecycle-rail-content" style={contentOffsetStyle(position, SUPPORTS_SHAPE_CURVE)}>
                    {inner}
                    {/* A job-in-flight chip can still be the SELECTED one —
                        see the file docstring's "SELECTION — WHICH
                        GUARANTEE LIVES WHERE" section for why this is a
                        reachable text node rather than aria-pressed on a
                        non-button. */}
                    {jobInFlight && isSelected && <span className="sr-only">Selected</span>}
                  </span>
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {/* dmfdeploy#414: the Control group that used to sit here — a
          sibling labelled group outside the orchestration <ol>, carrying
          the Operate link — is deleted outright, not merely hidden. The
          rail is exactly the five keys above, with nothing adjacent that
          can be read as a sixth.

          SHELL ROUND 2 (#481): the row-end run-count readout that used to
          sit here (RunningReadout) is deleted outright too, along with the
          shared job-in-progress note that used to follow the <ol>. There
          is nothing left in this row but the five keys. */}
    </nav>
  )
}
