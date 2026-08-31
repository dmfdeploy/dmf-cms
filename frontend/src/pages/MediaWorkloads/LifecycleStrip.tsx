import { useId } from 'react'
import {
  FLOW_STEPS,
  type FlowStepId,
  type FlowStepState,
} from '../../lib/workloadFlow'
import { STAGE_ICON } from '../../lib/stageIcons'
import { RAIL_FILL } from '../../lib/stagePalette'

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
 * GRAMMAR / EQUAL COLUMNS / REACHABLE LOCKED KEYS (dmfdeploy#449 folding in
 * dmfdeploy#405) shipped equal-width keys, per-stage marks and reachable
 * locked keys. See git history for that account — SHELL ROUND 2 (below)
 * retires the per-stage completeness mark this pass introduced; the equal
 * columns and reachable-locked-key invariants survive unchanged.
 *
 * SHELL ROUND 2 — OWN BAND, ICONS, CHEVRON FORM (dmfdeploy#481/#482/#483,
 * design record: docs/design/DMF Console Lifecycle Rail Visual System.md;
 * layout seam: docs/plans/DMF Console Shell Round Plan 2026-08-30.md; the
 * peer-view model this paints: docs/design/DMF Console Information
 * Architecture 2026-06-23.md's 2026-08-30 #493 amendment). Four things
 * changed at once — the design doc governs all three issues together and
 * says explicitly not to ship them independently:
 *
 *   1. NO INDICATORS IN THE ROW (#481). The row-end "N of M running"
 *      readout (RunningReadout, formerly here) and the shared "A <stage>
 *      job is in progress." note are BOTH GONE, not relocated beside this
 *      component — dmfdeploy#499's acceptance criteria (quoted onto #481)
 *      require the band to carry zero status text, and the readout's one
 *      sanctioned destination is the message bus (dmfdeploy#480), which
 *      does not exist yet. `jobOwnerLabel` is therefore no longer a prop
 *      here — nothing in this file has a use for it once neither consumer
 *      of it remains. `jobInFlight` stays: it still gates interactivity
 *      (a busy row is genuinely un-actionable) and still drives the
 *      sr-only "Selected" node below — a SELECTION fact, not a status
 *      announcement, and #481/#499 never asked for that to move.
 *      WorkloadSetup.tsx's own Previous/Next/View-live copy already assumed
 *      nothing else states which job is running — see that file's own
 *      updated comment; the actual "a job is running, here's what and how
 *      long" signal now lives solely at the point of action
 *      (AutomationInProgressNotice, dmfdeploy#390), which is where
 *      Constitution Art. 2 says a job's own status belongs regardless.
 *   2. HORIZONTALLY CENTRED (#481). `justify-center` on the `<nav>`, now
 *      that there is no right-pinned sibling left to fight it — see point 1.
 *      Topbar.tsx's header-slot-row wrapper is otherwise unchanged; #481's
 *      acceptance criteria are about the key group's own centring inside
 *      this component's row, not about relocating the row out of Topbar's
 *      existing second-row band (which already renders as a bordered band
 *      below the top bar's first row today).
 *   3. PER-KEY IDENTITY ICONS, UNCONDITIONALLY (#482). Every key — locked,
 *      open, complete, record, current, busy, whatever — renders its own
 *      STAGE_ICON (lib/stageIcons.ts), `aria-hidden` beside the still-bare
 *      EBU label. No padlock: reserved for a future authorization-denied
 *      state that does not exist in the code yet (IA doc's #493 amendment;
 *      Visual System doc §2a). The old padlock-on-locked-key branch is
 *      gone with it, not merely hidden.
 *   4. DIRECTIONAL CHEVRON FORM (#483). Keys are nested, interlocking
 *      chevron/pill segments with a thin (3px) gap, not rounded rectangles
 *      — see `chevronClipPath` below for the geometry and NOTCH_PX's own
 *      comment for how its value was actually measured (not carried over
 *      from the unverified 141.4px figure #481/#483 both flag).
 *
 * WHAT THIS PASS DELIBERATELY DROPS: PASS 2's completeness mark (StageMark
 * — filled/outline/no dot) and the locked key's dashed-border treatment.
 * The Visual System doc §2 REJECTS folding stage-STATE (locked vs open vs
 * complete) into fill/edge at all — fill/edge now varies on exactly two
 * axes, stage IDENTITY (the hue, permanent, RAIL_FILL below) and SELECTION
 * (the achromatic bg-text/text-bg inversion, unchanged) — "that is six
 * treatments that must all survive greyscale, and Art. 11 was only ever
 * verified for the dot the previous round shipped." Concretely: a locked
 * key now looks EXACTLY like an open one of the same stage. This is not an
 * oversight — the IA doc's #493 amendment says the "nothing to do here yet,
 * because X" fact a lock used to carry is "conveyed in words, on the stage
 * page itself... never as a lock glyph on the rail," and the rail's own
 * `aria-describedby` (below) already carries that same fact in words for a
 * key that is not yet selected. What replaces the mark's old "actionable
 * progress" job is the Badge slot — reserved geometry, rendered empty until
 * the ADR-0046 derivation (dmfdeploy#495) exists to fill it (Visual System
 * doc §5, §6) — never a repaint of the retired dot.
 *
 * SELECTION AND POSITION ARE STILL TWO DIFFERENT FACTS, unchanged by this
 * round. `aria-pressed` marks SELECTED on the interactive `<button>`
 * variant; a job-in-flight key is not a button and carries a visually-
 * hidden "Selected" text node instead (WAI-ARIA 1.2 defines `aria-pressed`
 * only for `role="button"`). `aria-current="step"` marks the backend-
 * derived POSITION on the five keys, unconditionally on `isPosition`.
 *
 * TALLY BAR RENDER RULE (unchanged, pinned by lifecycleStrip.test.tsx):
 * renders ONLY when position and selection DIVERGE — `isPosition &&
 * !isSelected`. It now lives INSIDE the clipped fill layer (see
 * `chevronClipPath`'s call site) rather than directly on the button, so it
 * is cut to the same chevron silhouette as the key itself instead of
 * overhanging into the inter-key gap as a rectangular strip would.
 *
 * FOCUS RING LIVES ON THE BUTTON, NOT THE CLIPPED LAYER (#483 caution 1).
 * `clip-path` clips whatever it is applied to, focus outline included — so
 * the chevron shape is painted by an absolutely-positioned, `aria-hidden`
 * inner `<span>` (clipped), while the `<button>` itself stays an ordinary,
 * unclipped rectangle carrying `outline`-based `:focus-visible` styling.
 * `outline` (not `box-shadow`/`filter: drop-shadow()`) is deliberate:
 * `drop-shadow` follows a clipped silhouette well but is dropped entirely
 * under Windows forced-colors mode, and an `outline` is exactly the
 * mechanism browsers already special-case there.
 *
 * EDGE CONTRAST WITHOUT A BORDER (#483 caution 2). A clipped shape cannot
 * carry a normal 1px border, so each key's edge IS its fill's contrast
 * against the page background — RAIL_FILL's five hues are chosen to each
 * individually clear WCAG 3:1 non-text contrast against --color-bg (see
 * index.css's own token comment for the verification).
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
 * The clip-path polygon for one rail key, by its position in the row.
 * `first`/`last` carry FLAT terminals (#483: "a lifecycle is a bounded
 * process; pointed terminals read as 'continues off-screen'") — Design's
 * left edge and Finalise & Review's right edge are plain vertical cuts, no
 * point and no notch. Every other edge either points OUT (the right side of
 * every key but the last, a convex tip at 100% 50%) or is notched IN (the
 * left side of every key but the first, a concave cut to `NOTCH_PXpx 50%`)
 * — adjacent keys' point/notch pairs read as one interlocking ribbon,
 * separated only by the `<ol>`'s own thin (3px) gap (#483: "nested with a
 * thin gap," not true negative-margin interlocking, which is what eats
 * label width unpredictably per that issue's own caution 3).
 */
function chevronClipPath(position: 'first' | 'middle' | 'last'): string {
  const notch = `${NOTCH_PX}px`
  if (position === 'first') {
    return `polygon(0 0, calc(100% - ${notch}) 0, 100% 50%, calc(100% - ${notch}) 100%, 0 100%)`
  }
  if (position === 'last') {
    return `polygon(0 0, 100% 0, 100% 100%, 0 100%, ${notch} 50%)`
  }
  return `polygon(0 0, calc(100% - ${notch}) 0, 100% 50%, calc(100% - ${notch}) 100%, 0 100%, ${notch} 50%)`
}

/**
 * The position tally — a thin illuminated bar across a key's top edge, in
 * `--color-text`, neutral. Never rendered by itself for a key that is also
 * selected (see the file docstring's "TALLY BAR RENDER RULE") — every call
 * site below already guards on that before mounting this. Lives inside the
 * clipped fill layer (see this file's own "FOCUS RING" docstring section)
 * so it is cut to the same chevron silhouette as the key around it.
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
        EQUAL COLUMNS (dmfdeploy#449, plan §3.3, unchanged by Shell Round 2).
        `w-max` is load-bearing, not decoration. Tailwind's `grid-cols-5` is
        `repeat(5, minmax(0, 1fr))` — a 0 minimum, not `auto` — so under the
        horizontal-scroll ancestor this row lives in (Topbar's
        overflow-x-auto wrapper) the tracks would happily shrink below their
        content and wrap the labels rather than overflow. Pinning the grid to
        its max-content width makes the tracks resolve to the widest key and
        lets the ancestor scroll, which is what that ancestor is for. The
        gap is 3px (#483: "a 2-3px band-coloured gap cut into the shape so
        keys nest without visually touching"), down from Pass 1's 8px —
        the interlocking chevron notch/point pair reads as one ribbon at
        this gap; the old wider gap would have read as a literal gap between
        two disconnected shapes instead of one nested run.
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

          // SHELL ROUND 2 (#482 constraints; Visual System doc §2 REJECTED):
          // fill/edge varies on stage IDENTITY (permanent hue) and SELECTION
          // (achromatic invert) only — never on stage STATE. A locked key's
          // fill is byte-for-byte the same as an open key's fill for the
          // same stage; see the file docstring's own "WHAT THIS PASS
          // DELIBERATELY DROPS" section for why.
          const fill = RAIL_FILL[id]
          const fillClass = isSelected ? 'bg-text' : fill.bg
          const inkClass = isSelected ? 'text-bg' : fill.fg
          // SHELL ROUND 2 FIX ROUND (orchestrator/codex gate — selection
          // invisibility, dmfdeploy#481). The achromatic fill-invert alone is
          // invisible on provision/configure/finalise (2.82:1 / 2.04:1 /
          // 1.49:1 fill-vs-fill, all under WCAG 1.4.11's 3:1 floor for a UI
          // state change) — a corridor analysis proved no retuned palette can
          // fix this: the identity-fill luminance range and the selected-fill
          // luminance are structurally incompatible on one axis (see the PR
          // description for the full derivation). Selection now gets its OWN
          // ring, independent of the key's hue, layered ON TOP of the
          // unchanged fill-invert (which stays because it still genuinely
          // helps on design/plan). `outline-current` on this ring reuses
          // `inkClass` — already guaranteed >=4.5:1 against whatever fill is
          // currently showing, by the exact same derivation that picked
          // `inkClass` in the first place — rather than inventing a second
          // colour that would reopen the same class of defect one level out.
          const selectedRingClass = isSelected ? 'outline outline-2 outline-current' : ''

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
                  // FIX ROUND: two layers, deliberately, not one.
                  //
                  // `outline-current` (unchanged property from before)
                  // reuses inkClass — already proven >=4.5:1 against
                  // whatever fill is CURRENTLY showing — so it is always
                  // correct against the fill, and it is what survives
                  // Windows forced-colors mode (the OS recolours `outline`
                  // to a guaranteed-visible system colour; `box-shadow` is
                  // simply dropped there, per the CSS Forced Colors spec —
                  // this is the exact reason #483 named for choosing
                  // `outline` over `drop-shadow` in the first place).
                  //
                  // But `outline-current` alone leaves a REAL gap this fix
                  // round found and measured, not merely a corner artifact:
                  // for provision/configure/finalise (dark ink) and any
                  // SELECTED key (ink = text-bg = --color-bg), the ring's
                  // OUTWARD-facing 2px band sits over the page background
                  // (--color-bg) — and dark ink / text-bg are themselves
                  // near-identical to that same background (1.10:1 / 1.00:1
                  // measured), so the ring is invisible there, uniformly
                  // around the whole outward stroke, not just at the notch
                  // corners. No single ink clears both "vs its own fill"
                  // and "vs page bg" at once for those three stages — the
                  // same structural shape as the selection-fill defect this
                  // round started from (see the PR description for the
                  // per-stage proof).
                  //
                  // The second layer — a two-tone sandwich, dark inner
                  // stroke then light outer stroke — closes that gap
                  // properly in ordinary rendering: `--color-bg` already
                  // clears 3:1 against every one of the five identity fills
                  // AND the selected fill (that is constraint 1, reused for
                  // free), and `--color-text` clears 3:1 against `--color-bg`
                  // itself (16.17:1) — between the two, at least one stroke
                  // has real contrast against whatever this ring sits over,
                  // regardless of state. `box-shadow` is a DIFFERENT CSS
                  // property from `outline`, so the two compose without
                  // clobbering each other — under forced-colors this layer
                  // drops out and the outline above carries the guarantee
                  // alone, exactly as intended.
                  //
                  // Total outward reach kept at 2px on both layers (offset-0
                  // outline, 1px/2px shadow spreads) — inside the 3px
                  // inter-key gap (measured on a real render) with a 1px
                  // margin, so a focused key's ring never touches its
                  // neighbour.
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
                  </span>
                  {/* Selection ring: a SEPARATE element/property from the
                      focus ring above (outline on THIS span, not the
                      button), so both can render at once without one
                      clobbering the other's `outline` — see the
                      selectedRingClass comment for the contrast derivation.
                      offset-0 on this span's own (small) box keeps its
                      total reach within the tightest content margin across
                      all five keys (Finalise & Review's, measured), clear
                      of the chevron notch with room to spare. */}
                  <span data-testid="selection-ring" className={`relative z-10 flex items-center justify-center gap-1.5 ${selectedRingClass}`}>{inner}</span>
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
                  </span>
                  <span data-testid="selection-ring" className={`relative z-10 flex items-center justify-center gap-1.5 ${selectedRingClass}`}>
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
