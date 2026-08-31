import { useId } from 'react'
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
 *   C. ROUNDED CHEVRONS, now with genuine curves everywhere instead of a
 *      mix of arcs, flat chamfers, and untreated vertices (a follow-up fix
 *      round found that inconsistency was the actual "oddly sharp corners"
 *      complaint, not the radius). TWO deliberately different radii: the
 *      box terminal corners still match Sidebar.tsx's `rounded-lg` (8px,
 *      radius only, not its `bg-accent/20` tint — cyan is the action
 *      accent, never used here) and are unchanged by that follow-up round;
 *      the arrow (the point/notch tips and the four corners where a flat
 *      edge meets a diagonal one) gets its own, more generous curve. See
 *      `chevronClipPath` and the ROUNDING comment above it for the full
 *      derivation, including why the arrow itself needs two sizes, not
 *      one.
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
 *
 * EDGE CONTRAST WITHOUT A BORDER (#483 caution 2). A clipped shape cannot
 * carry a normal 1px border, so the key's edge IS its fill's contrast
 * against the page background — `--color-rail-fill` clears WCAG 3:1
 * non-text contrast against --color-bg (3.20, see index.css).
 */

const STEP_LABEL: Record<FlowStepId, string> = {
  design: 'Design',
  plan: 'Plan',
  provision: 'Provision',
  configure: 'Configure',
  finalise: 'Finalise & Review',
}

/**
 * The chevron notch depth. MEASURED against a real render of this exact
 * component in the dev harness (pages/Dev/LifecycleRailHarness.tsx) at the
 * 1920x1080 capture viewport, 100% zoom — NOT carried over from the
 * 141.4px/spread-1.000 figure #481 and #483 both flag as reported-not-
 * verified-in-the-tree with no recorded zoom. See the PR description for
 * the actual measurement run (viewport + zoom + the resulting "Finalise &
 * Review" usable-width check).
 *
 * Deliberately small — the operator's own 2026-08-21 ruling for this rail
 * was "no indicator dots or any fancy mechanics, just icons and slight
 * directive shapes" (#483's own quote), and #483's body underlines "slight"
 * explicitly: the reference image's chevrons are pronounced, but "a subtler
 * notch is likely better in a band that has to coexist with a message bus
 * above it."
 */
const NOTCH_PX = 8

/**
 * The corner rounding radius, matching Sidebar.tsx:127's `rounded-lg`
 * (0.5rem = 8px) on the sidebar nav rail's own active tile — the operator's
 * concrete reference for "rounded chevrons". Only the RADIUS is reused;
 * that tile's `bg-accent/20` tint is deliberately not — cyan is the action
 * accent, and this rail never uses it.
 */
const RADIUS_PX = 8

/**
 * Replacement points for a true 90-degree corner (the flat terminal corners
 * — Design's left edge, Finalise & Review's right edge) rounded to
 * RADIUS_PX, computed from the standard circle-tangent construction (arc
 * centred at (R,R) from the vertex, quarter-circle from one tangent point
 * to the other). Exact values, not eyeballed — see the PR description for
 * the derivation script. `ARC_OFFSET` is the arc's own 45-degree midpoint
 * offset from each edge (R - R/sqrt(2)).
 */
const ARC_OFFSET = (RADIUS_PX - RADIUS_PX * Math.SQRT1_2).toFixed(3) // 2.343

/**
 * ROUNDING, FIX ROUND — TWO DELIBERATELY DIFFERENT RADII, per the operator's
 * final word on this (two earlier readings of a visual mockup over- and
 * under-shot it; see git history for the full back-and-forth, not repeated
 * here since neither earlier reading is the target any more). The BOX
 * corners (RADIUS_PX/ARC_OFFSET above — Design's left edge, Finalise &
 * Review's right edge) are UNCHANGED by this pass, still Sidebar.tsx:127's
 * rounded-lg. What changes is the ARROW: the chevron point's tip, the
 * receiving notch's tip, and the four corners where a flat top/bottom edge
 * meets a notch/point's diagonal edge (previously raw, untreated vertices —
 * the prior round's own "OUT OF SCOPE, DELIBERATELY" note, now addressed)
 * are treated as one unit — "part of the arrow, softened with it" — and get
 * a distinctly softer curve than the box.
 *
 * WHY TWO ARROW RADII, NOT ONE (found while building this, not guessed):
 * the tip corners (ARROW_TIP_RADIUS) and the four transition corners
 * (ARROW_TRANS_RADIUS) are NOT the same size, because a uniform enlarged
 * radius does not fit. Each diagonal edge (flat-edge corner to tip apex)
 * has to host BOTH that corner's own fillet and the tip's, and the tangent
 * distance a fillet consumes along its edge is `R / tan(interior-angle /
 * 2)` — small for an obtuse angle, large for an acute one. The receiving
 * notch's own diagonal edge is short (~14.35px — NOTCH_APEX_DEPTH below is
 * an EXISTING, unchanged dimension this round preserves rather than
 * redesigns, not something this pass gets to make deeper) and its
 * transition corner's interior angle (~77°, far more acute than the
 * point-side's ~120°) eats disproportionate edge length per radius pixel.
 * A single uniform radius applied to both the notch's tip and its
 * transition corner overflows that 14.35px budget once R passes roughly
 * 8.7px — indistinguishable from the box's own 8px, not "noticeably
 * softer" as asked for. Splitting the radius resolves it: the tip gets the
 * generous curve (it is, in the operator's own words, "the most looked-at
 * point"), the transition corners get a smaller but still real one — going
 * from zero rounding to any genuine curve is already the fix for "oddly
 * sharp corners" there. Verified by direct tangent-distance-vs-edge-length
 * computation for every corner at the chosen radii (positive margin, >3px,
 * on both the point's 16.12px edge and the notch's 14.35px one) — see the
 * PR description for the scratch script and its output, not eyeballed.
 */
const ARROW_TIP_RADIUS = 16
const ARROW_TRANS_RADIUS = 6

/**
 * The receiving notch's own apex depth — how far its concave cut actually
 * reaches in from the left edge, in px. NOT a fresh design choice: this is
 * the EXISTING, shipped notch depth, reconstructed (not re-derived from
 * scratch) by intersecting the two diagonal edges of the prior round's own
 * chamfer construction and solving for where they'd meet at a single sharp
 * vertex — confirmed against the live-rendered `getComputedStyle().clipPath`
 * of a real 'middle' key, not just the source constants. It is asymmetric
 * with the point's own protrusion (which reaches fully to the opposite
 * edge, depth 0) — an existing asymmetry, not something this rounding pass
 * introduces or corrects. Preserved exactly so this round changes ONLY how
 * corners are rounded, not the silhouette's underlying proportions.
 */
const NOTCH_APEX_DEPTH = 3.165

/**
 * Segments per rounded arc. Sagitta (max deviation from a true circle) for
 * N segments over sweep angle θ is `R * (1 - cos(θ / (2N)))` — worst case
 * here is the tip fillet's ~59.5° sweep at the larger ARROW_TIP_RADIUS
 * (16px): at N=8 that is 16 * (1 - cos(3.72°)) ≈ 0.03px, imperceptible even
 * magnified (the operator's own explicit "judge it magnified" bar). Kept
 * as one shared constant rather than tuned per-arc — every other arc here
 * is smaller-radius and/or narrower-sweep, so N=8 has strictly more margin
 * there, not less.
 */
const ARC_SEGMENTS = 8

/** A 2D point in one key's own local px frame: `u` is the distance INTO
 *  the shape from whichever edge the arrow-point in question is anchored
 *  to (0 at the edge, growing inward) — NOT an absolute x. `y` is measured
 *  from the top (0 to the button's fixed 28px height H, below). This one
 *  local frame is shared by both the point (anchored to the right edge,
 *  protruding fully out to it — apex at u=0) and the notch (anchored to
 *  the left edge, apex at u=NOTCH_APEX_DEPTH) — see `pointU`/`notchU`
 *  below for the only place that distinction is made. */
interface LocalPoint {
  u: number
  y: number
}

const H = 28 // the button's own fixed height — see NOTCH_PX's docstring above for how this was measured.

/**
 * Standard circle-tangent fillet construction: replaces a sharp vertex `v`
 * with an `segments`-segment arc of radius `r`, given the two OUTGOING unit
 * edge directions from it (`dirA`/`dirB`, each pointing from `v` toward one
 * of its two neighbours). Tangent points sit `r / tan(θ/2)` back from `v`
 * along each edge (θ = the interior angle between `dirA`/`dirB`, via their
 * dot product); the arc's own centre sits `r / sin(θ/2)` from `v` along the
 * bisector of `dirA`/`dirB`. Returns `segments + 1` points, ordered from
 * the tangent point on edge A to the tangent point on edge B — callers
 * splice this directly into a boundary point list, no separate "is this a
 * point's convex bulge or a notch's concave one" branch needed, because
 * both corners rounded this round are convex from the polygon's OWN
 * interior (verified directly, not assumed — see NOTCH_APEX_DEPTH's own
 * derivation: the notch's apex interior angle came out ~154.5°, obtuse but
 * still convex, not the reflex angle "concave" would imply). Pure
 * geometry, no dependency on props/state — every call site below is
 * evaluated once at module load, not per render.
 */
function filletArc(v: LocalPoint, dirA: LocalPoint, dirB: LocalPoint, r: number, segments: number): LocalPoint[] {
  const dot = Math.max(-1, Math.min(1, dirA.u * dirB.u + dirA.y * dirB.y))
  const theta = Math.acos(dot)
  const d = r / Math.tan(theta / 2)
  const tA: LocalPoint = { u: v.u + d * dirA.u, y: v.y + d * dirA.y }
  const tB: LocalPoint = { u: v.u + d * dirB.u, y: v.y + d * dirB.y }
  const bisRaw = { u: dirA.u + dirB.u, y: dirA.y + dirB.y }
  const bisLen = Math.hypot(bisRaw.u, bisRaw.y)
  const bisector = { u: bisRaw.u / bisLen, y: bisRaw.y / bisLen }
  const centreDist = r / Math.sin(theta / 2)
  const centre: LocalPoint = { u: v.u + centreDist * bisector.u, y: v.y + centreDist * bisector.y }
  const startAngle = Math.atan2(tA.y - centre.y, tA.u - centre.u)
  const endAngle = Math.atan2(tB.y - centre.y, tB.u - centre.u)
  let delta = endAngle - startAngle
  while (delta > Math.PI) delta -= 2 * Math.PI
  while (delta < -Math.PI) delta += 2 * Math.PI
  const points: LocalPoint[] = []
  for (let i = 0; i <= segments; i++) {
    const a = startAngle + (delta * i) / segments
    points.push({ u: centre.u + r * Math.cos(a), y: centre.y + r * Math.sin(a) })
  }
  return points
}

function normalize(p: LocalPoint): LocalPoint {
  const m = Math.hypot(p.u, p.y)
  return { u: p.u / m, y: p.y / m }
}

/**
 * Builds one arrow-bump's full set of rounded points (both transition
 * corners plus the tip), in the shared local (u, y) frame — `apexU` is the
 * only thing that differs between the point (0) and the notch
 * (NOTCH_APEX_DEPTH), so this one function produces both. `flatBack` is the
 * direction, in u, of "back along the flat edge, away from the transition
 * vertex" — always +1 in this frame (the flat edge always runs toward
 * larger u on both sides; see the point/notch call sites for why this does
 * not need to differ between them either).
 */
function buildArrowBump(apexU: number) {
  const flatTopEnd: LocalPoint = { u: NOTCH_PX, y: 0 }
  const flatBotEnd: LocalPoint = { u: NOTCH_PX, y: H }
  const apex: LocalPoint = { u: apexU, y: H / 2 }

  const transTop = filletArc(
    flatTopEnd,
    { u: 1, y: 0 },
    normalize({ u: apex.u - flatTopEnd.u, y: apex.y - flatTopEnd.y }),
    ARROW_TRANS_RADIUS,
    ARC_SEGMENTS,
  )
  const transBot = filletArc(
    flatBotEnd,
    { u: 1, y: 0 },
    normalize({ u: apex.u - flatBotEnd.u, y: apex.y - flatBotEnd.y }),
    ARROW_TRANS_RADIUS,
    ARC_SEGMENTS,
  )
  const tip = filletArc(
    apex,
    normalize({ u: flatTopEnd.u - apex.u, y: flatTopEnd.y - apex.y }),
    normalize({ u: flatBotEnd.u - apex.u, y: flatBotEnd.y - apex.y }),
    ARROW_TIP_RADIUS,
    ARC_SEGMENTS,
  )
  return { transTop, tip, transBot }
}

const POINT_BUMP = buildArrowBump(0) // protrudes fully to the edge — apex depth 0
const NOTCH_BUMP = buildArrowBump(NOTCH_APEX_DEPTH)

/** Formats a local point as a clip-path coordinate pair. `anchor` picks
 *  which edge `u` is measured from: `'right'` emits `calc(100% - Upx)`
 *  (the point, protruding out toward 100%), `'left'` emits `Upx` directly
 *  (the notch, receding in from 0). `y` is always emitted relative to the
 *  vertical centre (`50% ± Δpx`), matching the rest of this file's
 *  existing coordinates, including the box-terminal ones above. */
function fmt(p: LocalPoint, anchor: 'left' | 'right'): string {
  const x = anchor === 'right' ? `calc(100% - ${p.u.toFixed(3)}px)` : `${p.u.toFixed(3)}px`
  const dy = p.y - H / 2
  const y = Math.abs(dy) < 1e-6 ? '50%' : dy > 0 ? `calc(50% + ${dy.toFixed(3)}px)` : `calc(50% - ${(-dy).toFixed(3)}px)`
  return `${x} ${y}`
}

function bumpPath(bump: ReturnType<typeof buildArrowBump>, anchor: 'left' | 'right'): string {
  return [...bump.transTop, ...bump.tip, ...bump.transBot].map((p) => fmt(p, anchor)).join(', ')
}

const POINT_PATH = bumpPath(POINT_BUMP, 'right')
const NOTCH_PATH = bumpPath(NOTCH_BUMP, 'left')

/**
 * The clip-path polygon for one rail key, by its position in the row.
 * `first`/`last` carry FLAT terminals (#483: "a lifecycle is a bounded
 * process; pointed terminals read as 'continues off-screen'") — Design's
 * left edge and Finalise & Review's right edge are plain vertical cuts
 * (rounded, RADIUS_PX, the box treatment, unchanged this round). Every
 * other edge either points OUT (the right side of every key but the last —
 * POINT_PATH, rounded per the ARROW_TIP_RADIUS/ARROW_TRANS_RADIUS
 * derivation above) or is notched IN (the left side of every key but the
 * first — NOTCH_PATH, same treatment) — adjacent keys' point/notch pairs
 * read as one interlocking ribbon, separated only by the `<ol>`'s own thin
 * (3px) gap.
 */
function chevronClipPath(position: 'first' | 'middle' | 'last'): string {
  const r = `${RADIUS_PX}px`
  const arc = `${ARC_OFFSET}px`
  if (position === 'first') {
    return `polygon(
      0 ${r}, ${arc} ${arc}, ${r} 0,
      ${POINT_PATH}
    )`
  }
  if (position === 'last') {
    return `polygon(
      0 0,
      calc(100% - ${r}) 0,
      calc(100% - ${arc}) ${arc}, 100% ${r},
      100% calc(100% - ${r}), calc(100% - ${arc}) calc(100% - ${arc}),
      calc(100% - ${r}) 100%,
      0 100%,
      ${NOTCH_PATH}
    )`
  }
  return `polygon(
    0 0,
    ${POINT_PATH},
    0 100%,
    ${NOTCH_PATH}
  )`
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
                  <span aria-hidden="true" data-testid="key-fill" className={`absolute inset-0 ${fillClass}`} style={{ clipPath: chevronClipPath(position) }} />
                  <span className="relative z-10 flex items-center justify-center gap-1.5">{inner}</span>
                </button>
              ) : (
                <div
                  className={`relative flex w-full items-center justify-center gap-1.5 whitespace-nowrap px-3 py-1.5 ${inkClass}`}
                  aria-label={STEP_LABEL[id]}
                  aria-describedby={locked ? descriptionId : undefined}
                >
                  <span aria-hidden="true" data-testid="key-fill" className={`absolute inset-0 ${fillClass}`} style={{ clipPath: chevronClipPath(position) }} />
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
