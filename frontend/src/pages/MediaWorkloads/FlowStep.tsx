import { useId, useState, type ReactNode } from 'react'
import type { FlowStepState } from '../../lib/workloadFlow'
import { isStepOpenable } from '../../lib/workloadFlow'

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
 *   current  — the operator's work right now. Open, and not collapsible:
 *              collapsing the thing you are being asked to do is a way to
 *              lose it.
 *   complete } reviewable. Collapsed by default so the flow reads as a
 *   open     } path rather than a wall, and expandable because the operator
 *              direction is explicit that completed stages remain
 *              reviewable. `open` additionally carries a live action, so it
 *              advertises that in its summary rather than hiding it behind
 *              a fold the operator has no reason to suspect.
 *
 * The step NUMBER is passed in rather than derived here so this component
 * never has an opinion about flow order — lib/workloadFlow.ts owns that.
 */

const STATE_LABEL: Record<FlowStepState, string> = {
  current: 'Now',
  open: 'Ready',
  complete: 'Done',
  locked: 'Locked',
}

const STATE_BADGE_CLASS: Record<FlowStepState, string> = {
  current: 'bg-accent/20 text-accent',
  open: 'bg-green-900/30 text-green-300',
  complete: 'bg-white/10 text-muted',
  locked: 'bg-white/5 text-muted',
}

const STATE_PANEL_CLASS: Record<FlowStepState, string> = {
  current: 'border-accent/50',
  open: 'border-green-500/30',
  complete: 'border-white/10',
  locked: 'border-dashed border-white/10',
}

export default function FlowStep({
  number,
  label,
  state,
  lockedReason,
  summary,
  children,
}: {
  /** 1-based position in the flow, for the operator's sense of place. */
  number: number
  /** Verbatim EBU stage name — never abbreviated or re-worded. */
  label: string
  state: FlowStepState
  /**
   * Why this step cannot be worked yet. Required for locked steps: a lock
   * with no stated reason is the silent version of a disabled button
   * (Art. 8 — errors and refusals are content, not absences).
   */
  lockedReason?: string
  /** One line the operator can read without expanding the step. */
  summary?: ReactNode
  children: ReactNode
}) {
  const openable = isStepOpenable(state)
  // The current step is open and stays open; everything else the operator
  // may open starts folded so the page reads as a path.
  const [expanded, setExpanded] = useState(state === 'current')
  const bodyId = useId()

  // `current` is deliberately not collapsible — see the file docstring.
  const collapsible = openable && state !== 'current'
  const showBody = openable && (state === 'current' || expanded)

  return (
    <section
      className={`panel border ${STATE_PANEL_CLASS[state]}`}
      aria-label={`Step ${number}: ${label}`}
      data-step-state={state}
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
          {children}
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
