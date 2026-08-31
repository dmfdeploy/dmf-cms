import { useId } from 'react'
import type { CSSProperties } from 'react'
import {
  FLOW_STEPS,
  type FlowStepId,
  type FlowStepState,
} from '../../lib/workloadFlow'
import { STAGE_ICON } from '../../lib/stageIcons'
import { RAIL_FILL, RAIL_INK } from '../../lib/stagePalette'

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
 * SELECTION — WHICH GUARANTEE LIVES WHERE. Two separate facts, deliberately
 * not conflated:
 *   - jsdom-provable (pinned in lifecycleStrip.test.tsx): a selected key's
 *     fill layer carries a DIFFERENT token (`bg-text`) than an unselected
 *     key's (`bg-rail-fill`) — structural, not a contrast claim.
 *   - Render-measured, NOT jsdom-provable (recorded here and in the PR
 *     description; mutation-checked by hand each fix round): `bg-rail-fill`
 *     (#616161, Y=0.1195) vs `bg-text`/--color-text (#E8E8EA, Y=0.8081) =
 *     5.06:1 WCAG contrast — comfortably over the 1.4.11 3:1 floor for a UI
 *     state change, and identical on every key since both fills are single
 *     shared tokens. jsdom computes no pixels; this number is the actual
 *     guarantee, the test only proves the mechanism producing it is intact.
 *
 * FOCUS RING — JUSTIFICATION RESTATED for the hue-free state space (fix
 * round; the PRIOR version of this comment justified the inner stroke by
 * "every identity hue clears 3:1 against bg" — that reasoning no longer
 * applies now that hue is gone, and restyling the comment without
 * re-deriving it would have been exactly the unchecked-claim failure this
 * whole round kept finding). Two layers, on the unclipped `<button>` (the
 * clipped inner `<span>` paints the chevron fill; `clip-path` would clip
 * an outline/shadow placed on it instead, #483 caution 1):
 *   - `outline-current` reuses RAIL_INK (unselected) or the selected ink
 *     (`text-bg`). For the UNSELECTED case specifically, RAIL_INK is
 *     `--color-text` (light) — which now clears BOTH "vs the neutral fill"
 *     (5.06:1) AND "vs the page background" (16.17:1) on its own, since
 *     there is only one fill state to check any more, not five hues that
 *     needed splitting into light/dark ink zones. `outline` is also what
 *     survives Windows forced-colors mode (the OS recolours it; `box-
 *     shadow` is simply dropped there).
 *   - The `box-shadow` two-tone sandwich (`--color-bg` inner, `--color-
 *     text` outer) is still needed, but now for exactly ONE case: SELECTED
 *     AND focused, where ink flips to `text-bg` (`--color-bg`) — which
 *     matches the page background at 1:1 and would otherwise be invisible
 *     on the ring's outward-facing stroke. `--color-bg` (inner stroke) vs
 *     the neutral fill clears 3:1 (3.20, same number constraint 1 already
 *     established) and vs the selected fill clears 16.17:1; `--color-text`
 *     (outer stroke) vs page bg clears 16.17:1 — between the two, the ring
 *     is visible regardless of which of the two fill states it sits over.
 *     Unaffected by the polygon-to-shape() change below: the ring lives on
 *     the unclipped `<button>`, never the clipped fill `<span>`, in either
 *     mechanism.
 *
 * EDGE CONTRAST WITHOUT A BORDER (#483 caution 2). A clipped shape cannot
 * carry a normal 1px border, so the key's edge IS its fill's contrast
 * against the page background — `--color-rail-fill` clears WCAG 3:1
 * non-text contrast against --color-bg (3.20, see index.css). The
 * `border-radius` fallback (no `shape()` support) carries the same
 * constraint the same way — its edge is still just the fill colour, radius
 * is the only difference from the clipped case.
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
 *  never emitted directly. */
const H = 28
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
 */
const NOTCH_DEPTH = 12

/**
 * The tip radius — the protruding point's own apex AND the concave
 * notch's own apex, the SAME radius for both. Small deliberately: on a
 * 14px half-height (M above), the operator's own reference image keeps
 * its tips crisply pointed with restrained rounding, and a rendered
 * variant board found 7px+ turns the tip into a blob and loses the
 * directional read entirely.
 */
const TIP_RADIUS = 5

/**
 * The outer box terminal corner radius — Design's left end, Finalise &
 * Review's right end. Deliberately NOT Sidebar.tsx:127's 8px `rounded-lg`
 * any more (an earlier round's reference, which this round's variant
 * board superseded): standard practice scales corner radius by element
 * size bucket, and this rail's 28px key and that sidebar's 40px active
 * tile are different buckets — 6px is the size-correct value here, not a
 * copy of the tile's own.
 */
const BOX_RADIUS = 6

/**
 * TWO DELIBERATELY UNEQUAL JOINT RADII — the corners where a flat top/
 * bottom edge meets the arrow's diagonal edge. Not the same size, because
 * the two joints' interior angles are not the same: the tip-side joint
 * (JOINT_TIP_RADIUS) is obtuse, ~120°; the notch-side joint
 * (JOINT_NOTCH_RADIUS) is acute, ~77° — and at an EQUAL radius the acute
 * corner reads visibly sharper than the obtuse one, because perceived
 * softness depends on the included angle, not the radius alone. This is
 * not a guess: the operator circled exactly the notch-side joints twice,
 * on two different equal-radius attempts, as still too sharp. 6px and 8px
 * read as equally soft — the fix was splitting the radius, not raising
 * it everywhere (raising a shared radius enough to soften the acute
 * corner would have over-rounded the obtuse one into the same "blob"
 * territory TIP_RADIUS above was kept small to avoid).
 */
const JOINT_TIP_RADIUS = 6
const JOINT_NOTCH_RADIUS = 8

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
    // so the centring has the row's full width to work against; the
    // scroll behaviour at narrow widths is unchanged, still owned by
    // Topbar's own `overflow-x-auto` wrapper around this component.
    <nav aria-label="Media workload lifecycle" className="flex w-full flex-nowrap items-center justify-center">
      {/*
        EQUAL COLUMNS (dmfdeploy#449, plan §3.3, unchanged by this redesign).
        `w-max` is load-bearing, not decoration. Tailwind's `grid-cols-5` is
        `repeat(5, minmax(0, 1fr))` — a 0 minimum, not `auto` — so under the
        horizontal-scroll ancestor this row lives in (Topbar's
        overflow-x-auto wrapper) the tracks would happily shrink below their
        content and wrap the labels rather than overflow. Pinning the grid to
        its max-content width makes the tracks resolve to the widest key and
        lets the ancestor scroll, which is what that ancestor is for. The
        gap is 3px (#483: "a 2-3px band-coloured gap cut into the shape so
        keys nest without visually touching").
      */}
      <ol className="grid w-max grid-cols-5 items-center gap-[3px]">
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

          // ONE shared fill/ink for every key, every state — see the file
          // docstring's point A for why a per-stage hue could not survive
          // its own CVD measurement. Selection is the sole thing that
          // varies fill/edge (achromatic invert, unchanged mechanism).
          const fillClass = isSelected ? 'bg-text' : RAIL_FILL
          const inkClass = isSelected ? 'text-bg' : RAIL_INK

          const inner = (
            <>
              {/* FIX ROUND (operator ruling 2026-08-31): these five icons
                  are inline filled SVG now, not `lucide-react` — see
                  stageIcons.tsx's own docstring for the full provenance.
                  `strokeWidth` no longer applies to a filled silhouette,
                  so it is dropped here rather than passed and ignored. */}
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
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

          return (
            <li key={id} className="flex items-center">
              {interactive ? (
                <button
                  type="button"
                  className={`relative flex w-full items-center justify-center gap-1.5 whitespace-nowrap px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-current focus-visible:shadow-[0_0_0_1px_var(--color-bg),0_0_0_2px_var(--color-text)] ${inkClass}`}
                  // Explicit accessible name — the key's own label is all
                  // there is now (no trailing state word to exclude), but an
                  // explicit aria-label keeps this independent of whatever
                  // else ends up inside the button in a later pass.
                  aria-label={STEP_LABEL[id]}
                  aria-describedby={locked ? descriptionId : undefined}
                  aria-pressed={isSelected}
                  onClick={() => onSelect(id)}
                >
                  <span aria-hidden="true" data-testid="key-fill" className={`absolute inset-0 ${fillClass}`} style={chevronStyle(position)} />
                  <span className="relative z-10 flex items-center justify-center gap-1.5">{inner}</span>
                </button>
              ) : (
                <div
                  className={`relative flex w-full items-center justify-center gap-1.5 whitespace-nowrap px-3 py-1.5 ${inkClass}`}
                  aria-label={STEP_LABEL[id]}
                  aria-describedby={locked ? descriptionId : undefined}
                >
                  <span aria-hidden="true" data-testid="key-fill" className={`absolute inset-0 ${fillClass}`} style={chevronStyle(position)} />
                  <span className="relative z-10 flex items-center justify-center gap-1.5">
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
