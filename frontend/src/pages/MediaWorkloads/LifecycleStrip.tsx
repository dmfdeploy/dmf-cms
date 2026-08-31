import { useId } from 'react'
import {
  FLOW_STEPS,
  type FlowStepId,
  type FlowStepState,
} from '../../lib/workloadFlow'
import { STAGE_ICON } from '../../lib/stageIcons'
import { RAIL_FILL, RAIL_INK, RAIL_LINE } from '../../lib/stagePalette'

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
 * SHELL ROUND 2 REDESIGN (operator direction, following two fix rounds that
 * fought the same structural conflict): HUE COMES OFF THE FILL ENTIRELY.
 *
 *   1. ONE NEUTRAL FILL for all five keys (RAIL_FILL/RAIL_INK below, single
 *      tokens now, not per-stage). The prior per-stage-hue fill could not
 *      simultaneously clear 4.5:1 against one ink AND 3:1 against the
 *      achromatic selected fill for the light-zone stages — a corridor
 *      analysis proved this was structural, not a tuning gap (see the PR
 *      description for the derivation). With one shared fill, that conflict
 *      cannot recur: there is nothing left to be "light-zone".
 *   2. HUE IS NOW A BOTTOM-EDGE LINE (HueLine below), tally-style. The
 *      position tally keeps the TOP edge, unchanged — two different facts
 *      (position, identity) do not share an edge. Small-area colour is the
 *      worst case for hue discrimination, and this line is genuinely small:
 *      measured dE2000 for the five line colours drops to 0.85-1.17
 *      (imperceptible) between plan/provision under the two common CVDs —
 *      see index.css's own token comment for the full table and pipeline.
 *      Hue is therefore a REINFORCING cue only, not an independent identity
 *      channel — stated plainly, not claimed as more than it is. Icon shape
 *      and the EBU label remain the actual CVD-proof, greyscale-proof
 *      identity carriers (Art. 11).
 *   3. SELECTION RETURNS TO A BARE FILL-INVERT, no ring. With one shared
 *      fill, fill-vs-fill selection contrast measures 5.06:1 on every key —
 *      uniform by construction, comfortably over WCAG 1.4.11's 3:1 floor —
 *      so the ring two prior fix rounds added specifically to cover the
 *      per-stage-hue defect is no longer needed, and the operator objected
 *      to its boxy look regardless. See the SELECTION section below for
 *      exactly which guarantee lives where (a jsdom-provable token-identity
 *      fact vs. the render-measured contrast number).
 *   4. ROUNDED CHEVRONS, matching Sidebar.tsx's `rounded-lg` (8px) — see
 *      `chevronClipPath` below for the geometry.
 *
 * WHAT SURVIVES UNCHANGED FROM PRIOR ROUNDS: equal columns, per-key icons
 * unconditionally (dmfdeploy#482), no padlock (IA doc #493 amendment), no
 * indicators in the row (dmfdeploy#481/#499), the badge slot (reserved,
 * empty), locked keys reachable and visually identical to open ones of the
 * same stage (Visual System doc §2's fill/edge-varies-on-identity-and-
 * selection-only ruling — now trivially true, since there is only one
 * fill), the position tally's own render rule, and the two-tone focus ring
 * (still cleared by codex; re-verified against the new rounded, neutral
 * geometry — see that section below).
 *
 * SELECTION AND POSITION ARE STILL TWO DIFFERENT FACTS, unchanged. `aria-
 * pressed` marks SELECTED on the interactive `<button>` variant; a job-in-
 * flight key is not a button and carries a visually-hidden "Selected" text
 * node instead (WAI-ARIA 1.2 defines `aria-pressed` only for
 * `role="button"`). `aria-current="step"` marks the backend-derived
 * POSITION on the five keys, unconditionally on `isPosition`.
 *
 * TALLY BAR RENDER RULE (unchanged, pinned by lifecycleStrip.test.tsx):
 * renders ONLY when position and selection DIVERGE — `isPosition &&
 * !isSelected`. Lives inside the clipped fill layer, cut to the same
 * chevron silhouette as the key.
 *
 * SELECTION — WHICH GUARANTEE LIVES WHERE. Two separate facts, deliberately
 * not conflated:
 *   - jsdom-provable (pinned in lifecycleStrip.test.tsx): a selected key's
 *     fill layer carries a DIFFERENT token (`bg-text`) than an unselected
 *     key's (`bg-rail-fill`) — structural, not a contrast claim.
 *   - Render-measured, NOT jsdom-provable (recorded here, in the PR
 *     description, and mutation-checked by hand during this fix round):
 *     `bg-rail-fill` (#616161, Y=0.1195) vs `bg-text`/--color-text
 *     (#E8E8EA, Y=0.8081) = 5.06:1 WCAG contrast — comfortably over the
 *     1.4.11 3:1 floor for a UI state change, and IDENTICAL on every key
 *     because both fills are now single shared tokens, not five
 *     independently-tuned ones. jsdom computes no pixels; this number is
 *     the actual guarantee, the test above only proves the mechanism that
 *     produces it hasn't been silently removed.
 *
 * FOCUS RING LIVES ON THE BUTTON, NOT THE CLIPPED LAYER (#483 caution 1).
 * `clip-path` clips whatever it is applied to, focus outline included — so
 * the chevron shape is painted by an absolutely-positioned, `aria-hidden`
 * inner `<span>` (clipped), while the `<button>` itself stays an ordinary,
 * unclipped rectangle. Two layers, deliberately: `outline-current` (reuses
 * RAIL_INK, always correct against the fill by construction, and survives
 * Windows forced-colors mode — the OS recolours `outline`, `box-shadow` is
 * simply dropped there) PLUS a `box-shadow` two-tone sandwich (`--color-bg`
 * inner stroke, `--color-text` outer stroke) that closes the gap
 * `outline-current` alone leaves against the page background specifically
 * (dark ink / text-bg are themselves near-identical to that background).
 * Re-verified this round against the new rounded silhouette and the now-
 * single neutral fill — the contrast math is actually SIMPLER now (one
 * fill state to check instead of five hues), and the geometry (2px total
 * outward reach, 1px clear of the 3px inter-key gap) is unchanged by
 * rounding the corners, which only affects the silhouette near the
 * terminal/notch/point vertices, not the button's own rectangular
 * bounding box the outline/shadow are drawn against.
 *
 * EDGE CONTRAST WITHOUT A BORDER (#483 caution 2). A clipped shape cannot
 * carry a normal 1px border, so the key's edge IS its fill's contrast
 * against the page background — `--color-rail-fill` clears WCAG 3:1
 * non-text contrast against --color-bg (see index.css's own token comment).
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
 * accent, and this rail never uses it (unchanged ruling from Pass 1).
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
 * Replacement points for the point/notch tip corners (interior angle
 * ~120.5 degrees, from the fixed button height 28px and NOTCH_PX — both
 * constants, so this angle does not depend on the button's variable
 * width). Chamfered with a straight line between the two tangent points
 * rather than a full arc: a chamfer needs no "which way does the arc
 * bulge" sign-handling (the point's convex vs the notch's concave case are
 * otherwise mirror images that bulge opposite ways), which matters because
 * getting that sign wrong is a real, easy-to-miss failure mode, and a
 * chamfer softens the tip visibly at RADIUS_PX without it. See the PR
 * description for the full trig derivation (interior angle, tangent
 * distance from the vertex along each edge).
 *
 * OUT OF SCOPE, DELIBERATELY (recorded so it isn't silently assumed done):
 * the four corners where a flat top/bottom edge meets a notch/point's
 * diagonal edge (e.g. the very start of the top edge on a 'middle' key)
 * are NOT rounded this round — a third distinct corner angle, and the
 * least visually prominent of the three (already an obtuse, gentle
 * transition, not a sharp corner). Flagged for the next round rather than
 * guessed at under time pressure.
 */
const CHAMFER_X = '2.268'
const CHAMFER_Y = '3.969'

/**
 * The clip-path polygon for one rail key, by its position in the row.
 * `first`/`last` carry FLAT terminals (#483: "a lifecycle is a bounded
 * process; pointed terminals read as 'continues off-screen'") — Design's
 * left edge and Finalise & Review's right edge are plain vertical cuts
 * (now rounded, RADIUS_PX), no point and no notch. Every other edge either
 * points OUT (the right side of every key but the last, a chamfered tip
 * near 100% 50%) or is notched IN (the left side of every key but the
 * first, a chamfered cut near NOTCH_PXpx 50%) — adjacent keys' point/notch
 * pairs read as one interlocking ribbon, separated only by the `<ol>`'s own
 * thin (3px) gap (#483: "nested with a thin gap," not true negative-margin
 * interlocking, which is what eats label width unpredictably per that
 * issue's own caution 3).
 */
function chevronClipPath(position: 'first' | 'middle' | 'last'): string {
  const n = `${NOTCH_PX}px`
  const r = `${RADIUS_PX}px`
  const arc = `${ARC_OFFSET}px`
  const cx = `${CHAMFER_X}px`
  const cy = `${CHAMFER_Y}px`
  if (position === 'first') {
    return `polygon(
      0 ${r}, ${arc} ${arc}, ${r} 0,
      calc(100% - ${n}) 0,
      calc(100% - ${cx}) calc(50% - ${cy}), calc(100% - ${cx}) calc(50% + ${cy}),
      calc(100% - ${n}) 100%,
      ${r} 100%, ${arc} calc(100% - ${arc}), 0 calc(100% - ${r})
    )`
  }
  if (position === 'last') {
    return `polygon(
      0 0,
      calc(100% - ${n}) 0,
      calc(100% - ${arc}) ${arc}, 100% ${r},
      100% calc(100% - ${r}), calc(100% - ${arc}) calc(100% - ${arc}),
      calc(100% - ${n}) 100%,
      0 100%,
      ${cx} calc(50% + ${cy}), ${cx} calc(50% - ${cy})
    )`
  }
  return `polygon(
    0 0,
    calc(100% - ${n}) 0,
    calc(100% - ${cx}) calc(50% - ${cy}), calc(100% - ${cx}) calc(50% + ${cy}),
    calc(100% - ${n}) 100%,
    0 100%,
    ${cx} calc(50% + ${cy}), ${cx} calc(50% - ${cy})
  )`
}

/**
 * The position tally — a thin illuminated bar across a key's TOP edge, in
 * `--color-text`, neutral. Never rendered by itself for a key that is also
 * selected (see the file docstring's "TALLY BAR RENDER RULE") — every call
 * site below already guards on that before mounting this. Lives inside the
 * clipped fill layer so it is cut to the same chevron silhouette as the key
 * around it. Unmoved by the redesign — see HueLine below for the identity
 * hue, which now owns the BOTTOM edge instead (operator ruling: two
 * different facts do not share an edge).
 */
function PositionTally() {
  return (
    <span
      aria-hidden="true"
      data-testid="position-tally"
      className="absolute inset-x-0 top-0 h-[3px] rounded-t-[2px] bg-text"
    />
  )
}

/**
 * The stage's identity hue, now a BOTTOM-edge line, tally-style (redesign
 * fix round — see the file docstring's point 2). Permanent per stage,
 * unconditional on state (locked/open/complete/current/record all show the
 * same stage's line identically — the same "identity and selection are the
 * only two axes fill/edge may vary on" rule the fill itself already
 * follows).
 *
 * HIDDEN WHEN SELECTED — matching the SAME contrast-driven logic that
 * already hides the tally when selected, not a new exception. No single
 * line colour clears 3:1 against BOTH the neutral unselected fill (Y=
 * 0.1195) and the achromatic selected fill (Y=0.8081) at once — proved in
 * the PR description the same way the original fill-hue conflict was
 * proved, and for the identical underlying reason (one axis, pulled two
 * directions). When selected, the bright fill-invert is already the
 * dominant, unmissable signal; icon and label carry full identity
 * regardless of whether the line is showing.
 */
function HueLine({ stage }: { stage: FlowStepId }) {
  return (
    <span
      aria-hidden="true"
      data-testid="hue-line"
      className={`absolute inset-x-0 bottom-0 h-[3px] rounded-b-[2px] ${RAIL_LINE[stage]}`}
    />
  )
}

export default function LifecycleStrip({
  steps,
  activeChip,
  current,
  lockedReasons,
  jobInFlight,
  onSelect,
}: {
  steps: Record<FlowStepId, FlowStepState>
  /** Which of the five keys reads as selected, or none. Always drives the
   *  inverted fill. The accessible signal on top of that varies by branch:
   *  `aria-pressed` on the interactive `<button>` variant, a visually-hidden
   *  "Selected" text node on a job-in-flight chip's inert `<div>`. */
  activeChip: FlowStepId | null
  /** The workload's backend-derived position, or null — including when the
   *  position is a real stage this rail does not render (Operate,
   *  dmfdeploy#414's `offFlow`): none of the five keys carries the tally
   *  then, and this component takes no `offFlow` prop to say so — see the
   *  file docstring's "SELECTION AND POSITION ARE STILL TWO DIFFERENT
   *  FACTS". */
  current: FlowStepId | null
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
    // right-pinned sibling left in this row to fight the centring (see the
    // file docstring's point 1 and 2). `w-full` so the centring has the
    // row's full width to work against; the scroll behaviour at narrow
    // widths is unchanged, still owned by Topbar's own
    // `overflow-x-auto` wrapper around this component.
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
          const isPosition = id === current
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
          // Operator's Pass 1 ruling (pinned below in lifecycleStrip.test.tsx):
          // the tally never renders on a key that is already illuminated —
          // the fill alone already says "this is where you are".
          const showTally = isPosition && !isSelected
          const descriptionId = `${railId}-${id}-state`
          const Icon = STAGE_ICON[id]
          const position = index === 0 ? 'first' : index === FLOW_STEPS.length - 1 ? 'last' : 'middle'

          // REDESIGN: ONE shared fill/ink for every key, every state — see
          // the file docstring's point 1 for why a per-stage fill could
          // not simultaneously satisfy every contrast constraint. Selection
          // is still the sole thing that varies fill/edge (achromatic
          // invert, unchanged mechanism).
          const fillClass = isSelected ? 'bg-text' : RAIL_FILL
          const inkClass = isSelected ? 'text-bg' : RAIL_INK

          const inner = (
            <>
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
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
                  addresses keys by it). Every other state says nothing extra
                  here: there is no completeness fact left for this rail to
                  announce (see the file docstring). */}
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
                  aria-current={isPosition ? 'step' : undefined}
                  onClick={() => onSelect(id)}
                >
                  <span aria-hidden="true" data-testid="key-fill" className={`absolute inset-0 ${fillClass}`} style={{ clipPath: chevronClipPath(position) }}>
                    {showTally && <PositionTally />}
                    {!isSelected && <HueLine stage={id} />}
                  </span>
                  <span className="relative z-10 flex items-center justify-center gap-1.5">{inner}</span>
                </button>
              ) : (
                <div
                  className={`relative flex w-full items-center justify-center gap-1.5 whitespace-nowrap px-3 py-1.5 ${inkClass}`}
                  aria-label={STEP_LABEL[id]}
                  aria-describedby={locked ? descriptionId : undefined}
                  aria-current={isPosition ? 'step' : undefined}
                >
                  <span aria-hidden="true" data-testid="key-fill" className={`absolute inset-0 ${fillClass}`} style={{ clipPath: chevronClipPath(position) }}>
                    {showTally && <PositionTally />}
                    {!isSelected && <HueLine stage={id} />}
                  </span>
                  <span className="relative z-10 flex items-center justify-center gap-1.5">
                    {inner}
                    {/* A job-in-flight chip can still be the SELECTED one — see
                        the file docstring's "SELECTION AND POSITION ARE STILL
                        TWO DIFFERENT FACTS" section for why this is a reachable
                        text node rather than aria-pressed on a non-button. */}
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
          the Operate link — is deleted outright, not merely hidden. See the
          file docstring's "OPERATE REMOVED FROM THE RAIL ENTIRELY" section:
          the rail is exactly the five keys above, with nothing adjacent
          that can be read as a sixth.

          SHELL ROUND 2 (#481): the row-end run-count readout that used to
          sit here (RunningReadout) is deleted outright too, along with the
          shared job-in-progress note that used to follow the <ol> — see the
          file docstring's point 1. There is nothing left in this row but
          the five keys. */}
    </nav>
  )
}
