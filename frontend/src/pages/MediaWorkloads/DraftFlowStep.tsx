import { createContext, useId, useState, type ReactNode } from 'react'
import type { FlowStepState } from '../../lib/workloadFlow'
import { isStepOpenable } from '../../lib/workloadFlow'

/**
 * GATE-D1 P3.7: this file is a RENAME-ONLY copy of FlowStep.tsx as it stood
 * at v0.19.0 (b49174a), before umbrella #347 WO-D1 rewrote FlowStep.tsx
 * into the wizard's single-mounted-panel component. CreateWorkload.tsx's
 * own draft-flow accordion (template/facility seeding, umbrella #285
 * addendum) was never named in that arc's spec and needs the ORIGINAL
 * pinned/expand/collapse contract unchanged — everything below this note,
 * including the historical docstring, is that original content verbatim
 * (only the exported function's name changed, `FlowStep` ->
 * `DraftFlowStep`, so two same-named-but-different components don't sit
 * side by side in the same directory).
 */

/**
 * True for anything rendered inside a flow step. stages/StageCard.tsx reads
 * it and suppresses its own header/badge, so a stage panel contributes
 * content here and full chrome anywhere else — see StageCard's docstring
 * for why the flag lives in context rather than in a prop.
 */
export const InsideFlowStep = createContext(false)

/**
 * One step of the guided sequential flow (umbrella #285, operator direction
 * 2026-08-01). Replaces S1's StageCard, which rendered every stage as an
 * always-open card — the presentation the operator rejected ("all six
 * stages as stacked cards on one page is not the vision").
 *
 * The difference that matters is not decoration, it is DISCLOSURE. A step
 * is a numbered piece of work with three presentations:
 *
 *   locked   — the predecessor has not completed. The step states WHY, and
 *              renders none of its content. It is never a greyed-out
 *              control: a locked step provably bears no action at all
 *              (lib/workloadFlow.ts pins that as a property), so there is
 *              nothing here to disable.
 *   pinned   — the workload's POSITION. Open, and not collapsible:
 *              collapsing the thing you are being asked to do is a way to
 *              lose it.
 *   others   — reviewable, collapsed by default so the flow reads as a path
 *              rather than a wall, and expandable because the operator
 *              direction is explicit that completed stages remain
 *              reviewable. An `open` step additionally carries a live
 *              action, so it advertises that in its summary rather than
 *              hiding it behind a fold the operator has no reason to
 *              suspect.
 *
 * WHY `pinned` IS A PROP AND NOT INFERRED FROM `state`. The obvious version
 * of this component expanded whichever step read `current`. That is wrong,
 * and the existing S1 tests caught it: a workload sitting AT Configure has
 * a Configure step that bears switch-source, so the flow reports it `open`
 * rather than `current` — affordance outranks position in that ladder by
 * design. Keying disclosure off the state string therefore folded away the
 * exact control the operator had navigated there to use. Position and
 * affordance are different questions, and the caller — which has both
 * answers — passes the one that governs disclosure.
 *
 * The step NUMBER is likewise passed in rather than derived here, so this
 * component never has an opinion about flow order; lib/workloadFlow.ts owns
 * that.
 */

const STATE_LABEL: Record<FlowStepState, string> = {
  current: 'Now',
  open: 'Ready',
  complete: 'Done',
  record: 'Record',
  locked: 'Locked',
}

const STATE_BADGE_CLASS: Record<FlowStepState, string> = {
  current: 'bg-accent/20 text-accent',
  open: 'bg-green-900/30 text-green-300',
  complete: 'bg-white/10 text-muted',
  record: 'bg-white/10 text-muted',
  locked: 'bg-white/5 text-muted',
}

const STATE_PANEL_CLASS: Record<FlowStepState, string> = {
  current: 'border-accent/50',
  open: 'border-green-500/30',
  complete: 'border-white/10',
  record: 'border-white/10',
  locked: 'border-dashed border-white/10',
}

export default function DraftFlowStep({
  anchorId,
  number,
  label,
  state,
  pinned,
  lockedReason,
  summary,
  startExpanded,
  children,
}: {
  /**
   * DOM id, so the step is addressable as a fragment. The Operate page's
   * "request configuration change" link points at #configure, which is the
   * only reason this exists — a request to change configuration should land
   * the operator ON the Configure step, not at the top of the page for them
   * to find it again.
   */
  anchorId?: string
  /** 1-based position in the flow, for the operator's sense of place. */
  number: number
  /** Verbatim EBU stage name — never abbreviated or re-worded. */
  label: string
  state: FlowStepState
  /**
   * This step is the workload's position — the operator's work right now.
   * Open, and not collapsible. See the file docstring for why this is not
   * inferred from `state`.
   */
  pinned?: boolean
  /**
   * Why this step cannot be worked yet. Required for locked steps: a lock
   * with no stated reason is the silent version of a disabled button
   * (Art. 8 — errors and refusals are content, not absences).
   */
  lockedReason?: string
  /** One line the operator can read without expanding the step. */
  summary?: ReactNode
  /**
   * Start folded-open even though this is not the pinned step — set when
   * the operator arrived by a fragment link aimed at this step. It only
   * changes the INITIAL fold; a locked step still renders no content, so
   * this can never be used to reach a control the gate closed.
   */
  startExpanded?: boolean
  children: ReactNode
}) {
  const openable = isStepOpenable(state)
  // The pinned step is open and stays open; everything else the operator
  // may open starts folded so the page reads as a path.
  const [expanded, setExpanded] = useState(Boolean(pinned) || Boolean(startExpanded))
  const bodyId = useId()

  const collapsible = openable && !pinned
  const showBody = openable && (Boolean(pinned) || expanded)

  return (
    <section
      id={anchorId}
      className={`panel border ${STATE_PANEL_CLASS[state]}`}
      aria-label={`Step ${number}: ${label}`}
      data-step-state={state}
      // scroll-mt keeps the step header clear of the sticky page chrome
      // when the browser jumps to the fragment.
      style={{ scrollMarginTop: '1rem' }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 text-xs text-muted"
            aria-hidden="true"
          >
            {number}
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{label}</h2>
            {summary && <div className="truncate text-xs text-muted">{summary}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`badge text-xs ${STATE_BADGE_CLASS[state]}`}>
            {STATE_LABEL[state]}
          </span>
          {collapsible && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Hide' : 'Review'}
            </button>
          )}
        </div>
      </div>

      {showBody && (
        <div id={bodyId} className="p-4 text-sm">
          <InsideFlowStep.Provider value={true}>{children}</InsideFlowStep.Provider>
        </div>
      )}

      {!openable && (
        // A locked step renders prose only. Its content is not merely
        // hidden — it is not rendered at all, so no control inside it can
        // be reached by a keyboard or a screen reader while the step is
        // closed. That is the enforcement behind "no dead controls".
        <div className="p-4 text-sm text-muted">
          {lockedReason ?? 'This step opens once the step before it is complete.'}
        </div>
      )}
    </section>
  )
}
