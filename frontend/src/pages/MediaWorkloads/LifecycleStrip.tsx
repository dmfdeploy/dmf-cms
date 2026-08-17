import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { FLOW_STEPS, type FlowStepId, type FlowStepState } from '../../lib/workloadFlow'

/**
 * The wizard rail (umbrella #347 WO-D1, operator direction 2026-08-02).
 * Instead of a read-only chip row plus a separate numbered-step list below
 * it, the five orchestration chips ARE the wizard's step selector —
 * clicking one selects it, exactly one is mounted below (FlowStep.tsx).
 *
 * Per the operator's 2026-08-02 ruling on the EBU Facility Orchestration
 * Model graphic, Operate is still not a sixth step of the orchestration
 * flow — it sits in the Control vertical, set apart under its own group
 * label and rendered as a real route link, never a wizard step.
 *
 * ARC 4 WP-3: LIVES IN THE HEADER SLOT, A SINGLE NON-WRAPPING ROW (umbrella
 * #347). See store/headerSlot.ts for how WorkloadDetail/Operate register
 * the rail model this component renders.
 *
 * PASS 1 — CROSSPOINT BUS REDESIGN (dmf-cms#391, operator-approved design,
 * 2026-08-17). NOTHING ABOUT WHAT IS CLICKABLE changed this pass — every
 * interactive/inert BRANCH below (which elements are a <button> vs an inert
 * <div>, when a key is locked vs openable, the whole selection/job-in-flight
 * decision ladder) is byte-for-byte the same DECISION LOGIC the wizard
 * already had.
 *
 * FIX ROUND (codex gate — P3): this docstring used to extend that same
 * "byte-for-byte unchanged" claim to "every accessibility carrier on it" —
 * false, and corrected here rather than left standing, since it was a claim
 * about a security-relevant surface (this rail sits behind
 * devHarnessRoute.ts's auth-bypass gate) repeated in more than one place.
 * `aria-pressed`, the five keys' `aria-current="step"`, the job-in-flight
 * sr-only "Selected" node, and LockedReasonToggle are all genuinely
 * unchanged carriers. But the visible "Position" badge that used to give
 * Operate's position fact a sighted-only presence was REMOVED, and a NEW
 * carrier was ADDED in its place — `aria-describedby` on the Operate
 * link/div plus a sr-only "This workload is currently at Operate." span —
 * because without it, removing the visible badge would have made that fact
 * silently unreachable for a screen-reader operator (see this file's own
 * "SELECTION AND POSITION ARE TWO DIFFERENT FACTS" section below for the
 * full account, and the render-rule tests in lifecycleStrip.test.tsx). That
 * is a genuinely new accessibility carrier this pass added, not a pixel
 * change wearing the same logic. The rail now reads as a crosspoint bus:
 * SELECTION is an illuminated key (bg-text/text-bg, unchanged from before),
 * POSITION is a thin tally bar across a key's top edge, and per-step state
 * words (Now/Ready/Done/Record/Locked) plus their icons are gone entirely —
 * the six EBU labels plus the two signals above are the whole vocabulary
 * now. Removed along with the state words: the StateGlyph icon set, the
 * PositionGlyph star + literal "Position" caption, the visible "Control"
 * text label (the group's `role="group" aria-label="Control"` stays — see
 * lifecycleStrip.test.tsx's own aria-label pin), and the selection ring
 * (the inverted key fill alone now carries "this is selected" visually,
 * same as it always could have).
 *
 * A run-count readout was added at the row's end — "N OF M RUNNING" derived
 * from workload.instances (FIX ROUND, codex gate — P3: this used to point at
 * store/headerSlot.ts's RailModelExtras for that derivation; RailModelExtras
 * no longer carries it at all — see that file's HeaderSlotRailModel /
 * buildHeaderSlotRail instead, which derive it internally from a real
 * instances array now required by classifyWorkloadForHeaderSlot) — so
 * the information the old per-chip state words used to carry in aggregate
 * ("how much of this workload is actually running") has a home again, in
 * one place instead of five. Art. 1: when the underlying member-state read
 * is not trustworthy (lib/workloadLifecycle.ts's own
 * isGroupedReadTrustworthy — reused via WorkloadLifecycleInput's
 * `membersDataTrustworthy`, not re-derived here), the readout says so rather
 * than printing a stale or half-true count.
 *
 * LockedReasonToggle (the "i" disclosure) is UNCHANGED and stays load-bearing
 * this pass: locked keys are still non-interactive, so it remains the only
 * way a locked step's reason is reachable at all. Pass 2 is where the key
 * itself becomes the disclosure and this toggle can retire.
 *
 * SELECTION AND POSITION ARE TWO DIFFERENT FACTS, deliberately never
 * conflated onto one signal — this predates Pass 1 and still holds exactly
 * as before. On the five orchestration keys: `aria-pressed` marks SELECTED
 * on the interactive `<button>` variant. A job-in-flight key is not a button
 * (busy is not the same fact as locked, and a busy key CAN still be the
 * selected one) — WAI-ARIA 1.2 defines `aria-pressed` only for the element
 * that itself carries `role="button"`, so that branch instead carries a
 * visually-hidden "Selected" text node. That div still deliberately carries
 * no role="button", both because it genuinely isn't one and because this
 * suite's own "job in flight -> no button reachable" tests rely on that
 * absence. `aria-current="step"` marks the backend-derived POSITION on the
 * five keys, unconditionally on `isPosition` — independent of whether the
 * tally bar itself renders (the bar is suppressed when position and
 * selection coincide, per the operator's Pass 1 ruling below, but the ARIA
 * carrier is not, because a sighted operator reading the illuminated key as
 * "this is both" is not the same guarantee for a screen-reader user, who
 * needs the position fact stated regardless of what the fill alone implies).
 *
 * On the Operate LINK specifically: it carries no aria-pressed at all — a
 * nav Link isn't a toggle — so its own `aria-current` is repurposed to carry
 * SELECTION (`activeChip === 'operate'`) instead of position, matching the
 * inverted fill it renders on exactly that condition. That repurposing
 * means `aria-current` alone cannot ALSO carry POSITION for Operate the way
 * it does for the five keys — a second, separate carrier is needed there,
 * or the fact goes missing for assistive tech entirely.
 *
 * FIX ROUND (dmf-cms#391 Pass 1, codex gate — P3): rewritten as history,
 * not a live claim — this paragraph used to say POSITION there "has no ARIA
 * carrier of its own" in the present tense, immediately followed by a
 * sentence describing the carrier that in fact exists; self-contradictory
 * as originally written, not a stale-vs-current gap. The actual sequence:
 * BEFORE Pass 1, the visible "Position" badge was POSITION's only
 * carrier — sighted-only, nothing for assistive tech. Pass 1 removes that
 * badge and, in its place, adds a genuine ARIA carrier that did not exist
 * before: `aria-describedby` on the Operate link/div, pointing at an
 * sr-only span (`operatePositionId` below) — rendered under the identical
 * condition the tally bar itself uses (`offFlow && activeChip !==
 * 'operate'`), so position never silently vanishes for a screen-reader
 * operator just because sighted operators can already read it off the
 * illuminated key.
 *
 * TALLY BAR RENDER RULE (operator's Pass 1 ruling, pinned by
 * lifecycleStrip.test.tsx): renders ONLY when position and selection
 * DIVERGE — `isPosition && !isSelected` for the five keys, `offFlow &&
 * activeChip !== 'operate'` for Operate. When the illuminated key already
 * IS the position, the bar is withheld — the illumination already says so,
 * and a redundant bar under it would say nothing new. The bar itself is
 * neutral (`--color-text`), never red or green: position is not a health
 * claim (that is what the run-count readout is for), and this rail already
 * spends its one "on air" register (red) nowhere else, so introducing it
 * here for an unrelated fact would misstate what red means everywhere else
 * in this console.
 *
 * COLOUR TRACKS SELECTION, NOT STAGE IDENTITY (ARC 4 WP-2 ruling, unchanged
 * by Pass 1). The six EBU stage hues (lib/stagePalette.ts) stay retired as
 * key fills — the Constitution already adopts ISA-101 (§5, Art. 4:
 * grayscale-normal, colour = abnormal). Three brightness levels replace the
 * old binary (selected/not):
 *   - lit (selected): inverted, dark text on bright neutral `#e8e8ea`
 *     (16.17:1) — `bg-text text-bg`, unchanged from before Pass 1.
 *   - normal (open/available): muted text (7.08:1) on a faint neutral face,
 *     1px solid border.
 *   - dark (locked): the SAME muted text token, unopacified — this suite's
 *     own fix-round history (see the removed StateGlyph-era comments in git
 *     blame) found and re-found that opacifying this exact text composites
 *     under the 4.5:1 AA floor; there is no second, dimmer-but-still-AA-safe
 *     text token defined in index.css to opacify toward instead, so "dark"
 *     is expressed entirely through a darker/emptier key face plus a dashed
 *     border (the pre-Pass-1 locked shape cue, kept — Art. 11, colour is
 *     never the only signal, and a locked key now carries no icon or word of
 *     its own to say so any other way).
 * Cyan (`--color-accent`) is NOT used here — it is the action accent, and
 * the promoted primary action sits in this same row; cyan meaning both
 * "where you are" and "the thing to click" would make the action ambiguous
 * exactly where it matters most on camera. The six stage tokens stay defined
 * in index.css/lib/stagePalette.ts, unused by this file — reversibility.
 */

const STEP_LABEL: Record<FlowStepId, string> = {
  design: 'Design',
  plan: 'Plan',
  provision: 'Provision',
  configure: 'Configure',
  finalise: 'Finalise & Review',
}

/**
 * A locked chip's reason, behind a small keyboard/tap-operable toggle — not
 * a `title=` tooltip (hover-only, fails Art. 11), and not a permanent
 * caption (does not fit a single-line row). Own local state, since
 * LifecycleStrip itself has none: each locked chip's disclosure is
 * independent.
 *
 * FIX ROUND (WP-3 spec B gate, P2-2): this chip's own `<nav>` lives inside
 * Topbar's overflow-x-auto rail wrapper (the same scrolling ancestor
 * PromotedAction.tsx's own popover had to escape for the identical reason —
 * see Topbar.tsx's "FIX ROUND P1a" comment). `position: absolute` here
 * stayed a descendant of that ancestor regardless of z-index, so its lower
 * half was silently clipped exactly like the promoted panel was — CSS
 * forces overflow-y to auto wherever overflow-x is auto, and an ancestor's
 * overflow clips ANY descendant, absolutely-positioned or not, that is not
 * itself escaped via `position: fixed` or a portal outside that ancestor's
 * DOM subtree. Fixed here the same way: `position: fixed`, measured against
 * the trigger button's own real bounding box, portaled to `document.body` —
 * outside the rail's DOM subtree entirely, so the scrolling ancestor's
 * overflow has nothing of this popover left to clip.
 *
 * FIX ROUND (P3 round 3, P2-4): escaping the clipping ancestor fixed WHERE
 * the popover could render, not WHETHER it stayed on screen once there —
 * `left: rect.left` with no clamp put most of its fixed 192px (w-48) width
 * past the right edge for any chip near it, same failure shape as P1a's
 * panel before that one got a containing-block fix. Closing on scroll/resize
 * only handles the popover moving OUT of place after it opens; it does
 * nothing for a bad INITIAL placement. Clamped against the real viewport
 * width at measurement time instead.
 */
const LOCKED_REASON_POPOVER_WIDTH_PX = 192 // w-48
const LOCKED_REASON_POPOVER_MARGIN_PX = 8

function LockedReasonToggle({ label, reason }: { label: string; reason: string }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      const maxLeft = window.innerWidth - LOCKED_REASON_POPOVER_WIDTH_PX - LOCKED_REASON_POPOVER_MARGIN_PX
      const left = Math.max(LOCKED_REASON_POPOVER_MARGIN_PX, Math.min(rect.left, maxLeft))
      setCoords({ top: rect.bottom + 4, left })
    }

    // The rail scrolls horizontally under this button (Topbar.tsx's
    // overflow-x-auto wrapper) — a scroll moves the button without moving
    // this fixed-position, one-shot-measured popover, so it closes rather
    // than visibly detach from its trigger. `true` (capture phase) is
    // required: a scroll on the rail's own scrolling element does not
    // bubble to window in the normal phase, only capture.
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <span className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/20 text-2xs text-muted"
        aria-expanded={open}
        aria-label={`Why ${label} is locked`}
        onClick={() => setOpen((v) => !v)}
      >
        i
      </button>
      {open &&
        coords &&
        createPortal(
          <span
            role="note"
            style={{ position: 'fixed', top: coords.top, left: coords.left }}
            className="z-30 block w-48 rounded-lg border border-border bg-panel p-2 text-left text-2xs text-muted shadow-lg"
          >
            {reason}
          </span>,
          document.body,
        )}
    </span>
  )
}

/**
 * The position tally — a thin illuminated bar across a key's top edge, in
 * `--color-text`, neutral. Never rendered by itself for a key that is also
 * selected (see the file docstring's "TALLY BAR RENDER RULE") — every call
 * site below already guards on that before mounting this.
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

/** The run-count readout's LED + text, right-aligned at the row's end. */
function RunningReadout({
  runningReadout,
  jobInFlight,
  jobOwnerLabel,
}: {
  runningReadout: { running: number; total: number; trustworthy: boolean }
  jobInFlight: boolean
  jobOwnerLabel: string | null
}) {
  // Priority: a job this session started is a fact this component KNOWS
  // regardless of the grouped read's own freshness (it is local state, set
  // synchronously by the caller — see WorkloadDetail.tsx's startJob), so it
  // wins over the trustworthy check below rather than being gated by it.
  //
  // umbrella dmf-cms#391 fix round: the design called for "<job> ·
  // <elapsed>" here, but no elapsed-since-start fact exists anywhere in this
  // data model — WorkloadDetail's job overlay is a plain boolean plus an
  // owner label, no start timestamp, and lib/workloadLifecycle.ts's own
  // docstring is explicit that this module family adds "no new backend, no
  // network, no clock" (see that file's header). Inventing a client-side
  // start timestamp here would be exactly that new clock, for a number this
  // rail could not verify against anything. Renders the job label alone
  // instead of guessing a duration.
  if (jobInFlight) {
    return (
      <div data-testid="running-readout" className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        <span className="whitespace-nowrap font-mono text-2xs uppercase tracking-wide text-muted tabular-nums">
          {jobOwnerLabel ?? 'Job'} · running
        </span>
      </div>
    )
  }

  // ART. 1 HARD RULE: an untrustworthy member-state read must not print a
  // count — not a stale one, not a guessed one. `runningReadout.trustworthy`
  // ultimately traces back to WorkloadLifecycleInput.membersDataTrustworthy
  // (lib/workloadLifecycle.ts's isGroupedReadTrustworthy, called once
  // there) — but this component just receives it as a plain prop and does
  // not care how. FIX ROUND (codex gate, P1 residual): the actual
  // derivation is store/headerSlot.ts's buildHeaderSlotRail, reading a
  // module-private WeakMap keyed on the classified flow's own identity, NOT
  // a direct field pass-through — see that file's TRUST side table
  // docstring for the full account. This file adds no second freshness
  // formula of its own regardless of that mechanism's exact shape.
  if (!runningReadout.trustworthy) {
    return (
      <div data-testid="running-readout" className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />
        <span className="whitespace-nowrap font-mono text-2xs uppercase tracking-wide text-muted">
          Count unavailable
        </span>
      </div>
    )
  }

  const { running, total } = runningReadout
  return (
    <div data-testid="running-readout" className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${running > 0 ? 'bg-ok' : 'bg-muted'}`}
      />
      <span className="whitespace-nowrap font-mono text-2xs uppercase tracking-wide text-muted tabular-nums">
        {running} of {total} running
      </span>
    </div>
  )
}

export default function LifecycleStrip({
  steps,
  activeChip,
  current,
  offFlow,
  lockedReasons,
  jobOwnerLabel,
  jobInFlight,
  runningReadout,
  onSelect,
  slug,
}: {
  steps: Record<FlowStepId, FlowStepState>
  /** Which chip reads as selected — one of the five steps, `'operate'`, or
   *  none. Always drives the inverted fill. The accessible signal on top of
   *  that varies by branch: `aria-pressed` on the interactive `<button>`
   *  variant, a visually-hidden "Selected" text node on a job-in-flight
   *  chip's inert `<div>`, and `aria-current` on the Operate `<Link>`. */
  activeChip: FlowStepId | 'operate' | null
  /** The workload's backend-derived position, or null. */
  current: FlowStepId | null
  /** The workload's position is Operate — the Control chip carries it instead. */
  offFlow: boolean
  lockedReasons: Record<FlowStepId, string>
  /** Verbatim stage label of the step that owns the in-flight job, if any. */
  jobOwnerLabel: string | null
  jobInFlight: boolean
  /** umbrella dmf-cms#391: the row-end run-count readout's raw inputs —
   *  derived from workload.instances by the caller (WorkloadDetail.tsx /
   *  Operate.tsx via store/headerSlot.ts), never re-derived here. */
  runningReadout: { running: number; total: number; trustworthy: boolean }
  onSelect: (step: FlowStepId) => void
  slug: string
}) {
  const jobReason = jobOwnerLabel
    ? `A ${jobOwnerLabel} job is in progress — wait for its outcome.`
    : ''

  // umbrella dmf-cms#391: the sr-only carrier for Operate's POSITION fact
  // (see the file docstring) — scoped by slug so two mounted instances (not
  // reachable today; the header slot renders exactly one) could never share
  // an id.
  const operatePositionId = `lifecycle-operate-position-${slug}`
  const operateHasPositionOnly = offFlow && activeChip !== 'operate'

  return (
    <nav aria-label="Media workload lifecycle" className="flex flex-nowrap items-center gap-2">
      <ol className="flex flex-nowrap items-center gap-2">
        {FLOW_STEPS.map((id) => {
          const state = steps[id]
          const locked = state === 'locked'
          const isPosition = id === current
          const isSelected = id === activeChip
          const interactive = !jobInFlight && !locked
          // Operator's Pass 1 ruling (pinned below in lifecycleStrip.test.tsx):
          // the tally never renders on a key that is already illuminated —
          // the fill alone already says "this is where you are".
          const showTally = isPosition && !isSelected

          const keyToneClass = isSelected
            ? 'bg-text text-bg border-transparent'
            : locked
              ? 'bg-white/[0.03] text-muted border-dashed border-white/15'
              : 'bg-white/5 text-muted border-white/10'

          const chipClass = [
            'relative flex items-center gap-1.5 whitespace-nowrap rounded-[3px] border px-2.5 py-1.5 transition-shadow',
            keyToneClass,
          ].join(' ')

          const inner = (
            <>
              {showTally && <PositionTally />}
              <span className="text-xs font-semibold">{STEP_LABEL[id]}</span>
            </>
          )

          return (
            <li key={id} className="flex shrink-0 items-center gap-1">
              {interactive ? (
                <button
                  type="button"
                  className={chipClass}
                  // Explicit accessible name — the key's own label is all
                  // there is now (no trailing state word to exclude), but an
                  // explicit aria-label keeps this independent of whatever
                  // else ends up inside the button in a later pass.
                  aria-label={STEP_LABEL[id]}
                  aria-pressed={isSelected}
                  aria-current={isPosition ? 'step' : undefined}
                  onClick={() => onSelect(id)}
                >
                  {inner}
                </button>
              ) : (
                <div
                  className={chipClass}
                  aria-label={STEP_LABEL[id]}
                  aria-current={isPosition ? 'step' : undefined}
                >
                  {inner}
                  {/* A job-in-flight chip can still be the SELECTED one — see
                      the file docstring's "SELECTION AND POSITION ARE TWO
                      DIFFERENT FACTS" section for why this is a reachable
                      text node rather than aria-pressed on a non-button. */}
                  {jobInFlight && isSelected && <span className="sr-only">Selected</span>}
                </div>
              )}
              {locked && <LockedReasonToggle label={STEP_LABEL[id]} reason={lockedReasons[id]} />}
            </li>
          )
        })}
      </ol>

      {/* Job-in-flight: ONE shared note, not a sentence repeated under every
          chip — the old per-chip repetition said the identical thing N
          times. */}
      {jobInFlight && (
        <span role="status" className="shrink-0 whitespace-nowrap text-2xs text-muted">
          {jobReason}
        </span>
      )}

      {/* GATE-D1 P1.2: Control/Operate is NOT a sixth <li> in the
          orchestration <ol> above — an ordinal list item there would make it
          read as a sixth step of the SAME sequence, exactly the claim spec B
          and the operator's 2026-08-02 ruling rule out. It is a sibling
          labelled group instead, visually adjacent but structurally outside
          the ordered list entirely. The VISIBLE "Control" word is gone as of
          Pass 1 (dmf-cms#391) — the group's own accessible name
          (role="group" aria-label="Control") is the only thing that still
          says so, and lifecycleStrip.test.tsx pins that it stays. */}
      <div role="group" aria-label="Control" className="flex shrink-0 items-center gap-1.5 border-l border-white/10 pl-2">
        {!jobInFlight ? (
          <Link
            to={`/media-workloads/${encodeURIComponent(slug)}/operate`}
            className={`relative whitespace-nowrap rounded-[3px] border px-2.5 py-1.5 text-xs font-semibold ${
              activeChip === 'operate'
                ? 'bg-text text-bg border-transparent'
                : 'bg-white/5 text-muted border-white/10'
            }`}
            // Keyed to SELECTION (activeChip — is the operator looking at
            // Operate right now), not to POSITION (offFlow) — see the file
            // docstring's "SELECTION AND POSITION ARE TWO DIFFERENT FACTS".
            aria-current={activeChip === 'operate' ? 'page' : undefined}
            aria-describedby={operateHasPositionOnly ? operatePositionId : undefined}
          >
            {operateHasPositionOnly && <PositionTally />}
            Operate
          </Link>
        ) : (
          <div
            className={`relative whitespace-nowrap rounded-[3px] border px-2.5 py-1.5 text-xs font-semibold ${
              activeChip === 'operate'
                ? 'bg-text text-bg border-transparent'
                : 'bg-white/5 text-muted border-white/10'
            }`}
            aria-describedby={operateHasPositionOnly ? operatePositionId : undefined}
          >
            {operateHasPositionOnly && <PositionTally />}
            Operate
          </div>
        )}
        {/* umbrella dmf-cms#391: the sr-only equivalent of the removed
            visible "Position" badge — Operate's aria-current is spoken for
            by SELECTION (above), so without this a screen-reader operator
            loses the workload-is-at-Operate fact entirely the moment it
            isn't also the selected chip. Same render condition as the tally
            bar it replaces visually. */}
        {operateHasPositionOnly && (
          <span id={operatePositionId} className="sr-only">
            This workload is currently at Operate.
          </span>
        )}
      </div>

      <RunningReadout runningReadout={runningReadout} jobInFlight={jobInFlight} jobOwnerLabel={jobOwnerLabel} />
    </nav>
  )
}
