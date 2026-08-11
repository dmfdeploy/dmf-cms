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
 * ARC 4 WP-3: LIVES IN THE HEADER SLOT NOW, A SINGLE NON-WRAPPING ROW
 * (umbrella #347). This is a real information-architecture change, not a
 * recolour — the previous version stacked a state word, and conditionally
 * a "Current position" caption, a "Selected" caption, a locked-reason
 * sentence, or a job-in-flight sentence, underneath every chip. None of
 * that fits a single line, so:
 *   - every chip is one line: icon + label + state word, inline;
 *   - the "Selected" caption is GONE — redundant now that exactly one
 *     step's content is mounted below (FlowStep.tsx): what's selected is
 *     self-evident from the page, not from the rail;
 *   - the workload's actual POSITION still gets a same-line marker
 *     (PositionGlyph + "Position", appended to whichever chip it is) even
 *     when a DIFFERENT step is selected — dropping this would lose real
 *     information in exactly the case it matters (reviewing Design while
 *     the workload sits at Configure), which the old stacked caption
 *     always showed regardless of selection;
 *   - a locked step's reason moves behind a small, keyboard/tap-operable
 *     disclosure (LockedReasonToggle below) instead of a permanent
 *     caption — the same "tappable info affordance, not hover-only"
 *     pattern already used for System details elsewhere in this codebase;
 *   - job-in-flight state collapses from one repeated sentence under every
 *     non-locked chip to ONE shared note in the row.
 *
 * ARC 4 WP-2/rail-treatment ruling (umbrella #347, operator decision
 * 2026-08-11, issue #347 comment "Arc 4 — rail treatment ruling"):
 * COLOUR NOW TRACKS SELECTION, NOT STAGE IDENTITY. The six EBU stage hues
 * (lib/stagePalette.ts) are retired as chip fills on the demo path — the
 * Constitution already adopts ISA-101 (§5, Art. 4: grayscale-normal,
 * colour = abnormal), and six saturated hues on the NORMAL path spent the
 * whole colour budget for no work the stage names weren't already doing
 * (measured: stage hues sit within ~1.1:1 of the semantic status colours
 * in greyscale). This softens the 2026-08-02 "EBU-coloured rail" direction
 * further than the earlier Arc 4 ruling did — stated here per that
 * ruling's own requirement, not left to read as drift.
 *   - inactive chip: muted text, no fill (7.08:1)
 *   - the SELECTED chip: inverted — dark text on bright neutral `#e8e8ea`
 *     (16.17:1), i.e. `bg-text text-bg`
 *   - cyan is NOT used here — it is the action accent, and the promoted
 *     primary action sits in this same row; cyan meaning both "where you
 *     are" and "the thing to click" would make the action ambiguous
 *     exactly where it matters most on camera
 * The six tokens stay defined in index.css/lib/stagePalette.ts — unused by
 * this file now, on purpose (reversibility: restoring stage colour is one
 * class string, not a re-plumb). Do not delete them.
 *
 * SELECTION AND POSITION ARE TWO DIFFERENT FACTS, deliberately never
 * conflated onto one signal. On the five orchestration chips: `aria-pressed`
 * marks SELECTED on the interactive `<button>` variant (mounted below). A
 * job-in-flight chip is not a button (busy is not the same fact as locked,
 * and a busy chip CAN still be the selected one) — round P3-6 first tried
 * putting `aria-pressed` on that chip's own inert `<div>` too, but WAI-ARIA
 * 1.2 defines `aria-pressed` only for the element that itself carries
 * `role="button"` — this div neither carries that role nor inherits the
 * permission from being near one, so a user agent is not required to
 * expose it there; corrected (P3 round 3) to a visually-hidden "Selected"
 * text node instead, reachable text rather than a state attribute with
 * nothing to attach it to. That div still
 * deliberately carries no role="button", both because it genuinely isn't
 * one and because this suite's own "job in flight -> no button reachable"
 * tests rely on that absence. `aria-current="step"` marks the backend-derived
 * POSITION, and the same-line Position marker (icon + text, described
 * above) restates it visibly. On the Operate LINK specifically (fix round
 * P3-6): it carries no aria-pressed at all — a nav Link isn't a toggle — so
 * its own `aria-current` is repurposed to carry SELECTION
 * (`activeChip === 'operate'`) instead of position, matching the inverted
 * fill it renders on exactly that condition; POSITION there is still the
 * separate, unconditional "Position" badge, never aria-current. A workload
 * can sit at Configure while the operator reviews Design, and the rail says
 * both without one overloading the other.
 */

const STEP_LABEL: Record<FlowStepId, string> = {
  design: 'Design',
  plan: 'Plan',
  provision: 'Provision',
  configure: 'Configure',
  finalise: 'Finalise & Review',
}

const STATE_TEXT: Record<FlowStepState, string> = {
  current: 'Now',
  open: 'Ready',
  complete: 'Done',
  record: 'Record',
  locked: 'Locked',
}

function StateGlyph({ state }: { state: FlowStepState }) {
  switch (state) {
    case 'complete':
      return (
        <path
          d="M20 6 9 17l-5-5"
          stroke="currentColor"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
    case 'locked':
      return (
        <path
          d="M6 10V7a6 6 0 1112 0v3M5 10h14v10H5V10z"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
    case 'record':
      return (
        <path
          d="M4 6h16M4 12h16M4 18h10"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      )
    case 'current':
      return (
        <path
          d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4l-6.4 4.6L8 13.8l-6-4.6h7.6z"
          fill="currentColor"
        />
      )
    case 'open':
    default:
      return <circle cx="12" cy="12" r="6" fill="currentColor" />
  }
}

/** The same "current position" glyph used inline, next to the Position word. */
function PositionGlyph() {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4l-6.4 4.6L8 13.8l-6-4.6h7.6z"
        fill="currentColor"
      />
    </svg>
  )
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

export default function LifecycleStrip({
  steps,
  activeChip,
  current,
  offFlow,
  lockedReasons,
  jobOwnerLabel,
  jobInFlight,
  onSelect,
  slug,
}: {
  steps: Record<FlowStepId, FlowStepState>
  /** Which chip reads as selected — one of the five steps, `'operate'`, or
   *  none. Always drives the inverted fill. The accessible signal on top of
   *  that varies by branch (P3 round 3): `aria-pressed` on the interactive
   *  `<button>` variant, a visually-hidden "Selected" text node on a
   *  job-in-flight chip's inert `<div>` (aria-pressed is not valid there —
   *  see the busy-branch comment below), and `aria-current` on the Operate
   *  `<Link>` (not a toggle, so no aria-pressed at all). */
  activeChip: FlowStepId | 'operate' | null
  /** The workload's backend-derived position, or null. */
  current: FlowStepId | null
  /** The workload's position is Operate — the Control chip carries it instead. */
  offFlow: boolean
  lockedReasons: Record<FlowStepId, string>
  /** Verbatim stage label of the step that owns the in-flight job, if any. */
  jobOwnerLabel: string | null
  jobInFlight: boolean
  onSelect: (step: FlowStepId) => void
  slug: string
}) {
  const jobReason = jobOwnerLabel
    ? `A ${jobOwnerLabel} job is in progress — wait for its outcome.`
    : ''

  return (
    <nav aria-label="Media workload lifecycle" className="flex flex-nowrap items-center gap-2">
      <ol className="flex flex-nowrap items-center gap-2">
        {FLOW_STEPS.map((id) => {
          const state = steps[id]
          const locked = state === 'locked'
          const isPosition = id === current
          const isSelected = id === activeChip
          const interactive = !jobInFlight && !locked

          // FIX ROUND (WP-3 spec B gate, P2-5, then P3 round 3): the locked
          // chip's own opacity-70 used to sit on top of the inner
          // state-word span's own opacity-70 — two multipliers compounding
          // to ~2.50:1. Round 2 removed the CHIP-level one, leaving the
          // state word alone at its own single opacity-70 — which composites
          // muted-on-bg's 7.08:1 down to ~3.95:1 on its own, still under the
          // 4.5:1 AA floor for text. That was found and mis-cleared: a test
          // asserted only the chip-level class was gone and its own comment
          // claimed the state word's opacity "was never the compounding
          // half", true of round 2's specific defect but not a real AA
          // pass — the state word's own single multiplier was never checked
          // against the floor at all. The state word below now carries no
          // opacity class either; every chip, locked or not, reads its text
          // at plain muted-on-bg. The dashed border + lock glyph + "Locked"
          // state word remain the designed non-colour cue (Art. 11).
          const chipClass = [
            'flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 transition-shadow',
            isSelected ? 'bg-text text-bg' : 'text-muted',
            locked ? 'border-dashed border-white/30' : 'border-transparent',
            isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-bg' : '',
          ].join(' ')

          const inner = (
            <>
              <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <StateGlyph state={state} />
              </svg>
              <span className="text-xs font-semibold">
                {STEP_LABEL[id]}
                <span className="ml-1 font-normal">
                  · {jobInFlight ? 'Waiting' : STATE_TEXT[state]}
                </span>
              </span>
              {isPosition && (
                <span className="ml-0.5 flex items-center gap-0.5 opacity-80">
                  <PositionGlyph />
                  <span className="text-2xs">Position</span>
                </span>
              )}
            </>
          )

          return (
            <li key={id} className="flex shrink-0 items-center gap-1">
              {interactive ? (
                <button
                  type="button"
                  className={chipClass}
                  // Explicit accessible name — the visible chip also carries
                  // a state word (Ready/Done/…) that shouldn't be part of
                  // what a step selector is called.
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
                  {/* FIX ROUND (WP-3 spec B gate, P3-6; corrected P3 round
                      3): a job-in-flight chip can still be the SELECTED one
                      (the operator is looking at Provision when Provision's
                      own job starts), and nothing besides the fill colour
                      said so before this — every non-locked chip's text
                      collapses to the identical "· Waiting" during a job, so
                      a colour-blind or screen-reader operator had no way to
                      tell the chip they're actually on apart from a
                      merely-suppressed sibling (Art. 11: colour is never the
                      only signal). The first fix put aria-pressed on this
                      div — WAI-ARIA 1.2 defines aria-pressed only for the
                      element that itself carries role="button"; this div
                      neither carries that role nor inherits the permission
                      from being near one, so a user agent is not required
                      to expose it here at all — the test that "proved" it
                      only checked DOM spelling, not an exposed accessibility
                      property. Reachable text
                      is the actual fix — a visually-hidden "Selected" node,
                      same pattern as any other sr-only label in this
                      codebase, with no role/state attribute riding on an
                      element that was never a widget. Still deliberately NO
                      role="button": this branch only exists because
                      `interactive = !jobInFlight && !locked`, and every
                      OTHER test in this suite that proves a job-in-flight
                      chip is inert does so by asserting no button role is
                      reachable here (queryByRole('button', ...) === null) —
                      adding role="button" would break that much wider
                      invariant for the same reason it would have before. A
                      locked step is never selected (isStepOpenable excludes
                      it), so this never fires for the locked case. */}
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
          the ordered list entirely. */}
      <div role="group" aria-label="Control" className="flex shrink-0 items-center gap-1.5 border-l border-white/10 pl-2">
        <span className="text-2xs uppercase tracking-wide text-muted">Control</span>
        {!jobInFlight ? (
          <Link
            to={`/media-workloads/${encodeURIComponent(slug)}/operate`}
            className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
              activeChip === 'operate' ? 'bg-text text-bg ring-2 ring-white ring-offset-2 ring-offset-bg' : 'text-muted'
            }`}
            // FIX ROUND (WP-3 spec B gate, P3-6): keyed to SELECTION
            // (activeChip — is the operator looking at Operate right now),
            // not to POSITION (offFlow). Those are the same two axes the
            // five orchestration chips' INTERACTIVE (button) variant keeps
            // apart via aria-pressed (selection) vs. aria-current="step"
            // (position) — the busy variant instead uses a visually-hidden
            // "Selected" text node (see that branch's own comment above),
            // so this is no longer true of all five chips universally, only
            // of the button case. This link has no aria-pressed (a nav Link
            // isn't a toggle), so aria-current is the one signal it has,
            // and it needs to carry
            // SELECTION to match the inverted fill it already renders on
            // /operate. Before this fix, visiting /operate directly for a
            // workload not actually AT Operate (offFlow false, activeChip
            // 'operate') left this link visually inverted with NO
            // aria-current at all — the POSITION fact still renders
            // separately below (the "Position" badge), unconditionally on
            // offFlow, so nothing is lost by no longer overloading this
            // attribute with it.
            aria-current={activeChip === 'operate' ? 'page' : undefined}
          >
            Operate
          </Link>
        ) : (
          <div className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold ${activeChip === 'operate' ? 'bg-text text-bg' : 'text-muted'}`}>
            Operate
          </div>
        )}
        {offFlow && (
          <span className="flex items-center gap-0.5 whitespace-nowrap text-2xs text-muted opacity-80">
            <PositionGlyph />
            Position
          </span>
        )}
      </div>
    </nav>
  )
}
