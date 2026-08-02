import { useState, type ReactNode } from 'react'
import type { FlowStepState } from '../../lib/workloadFlow'
import { isStepOpenable } from '../../lib/workloadFlow'

/**
 * One step of the DRAFT flow (CreateWorkload.tsx) — a workload that does not
 * exist yet, gated by lib/workloadFlow.ts's classifyDraftFlow() rather than
 * the real backend-derived position.
 *
 * THIS IS A SEPARATE COMPONENT FROM THE WIZARD'S FlowStep.tsx, deliberately.
 * Umbrella #347 WO-D1 turned the deployed workload's detail page into a
 * single-step-at-a-time wizard, but that change is scoped to WorkloadDetail
 * — the draft leg (template/facility seeding, umbrella #285 addendum) was
 * never named in that spec and keeps its S1/Arc-B accordion presentation
 * unchanged: every step mounted, the workload's current draft position
 * pinned open, everything else folded behind a Review/Hide toggle. Folding
 * this into the wizard's single-mount FlowStep would change a page this
 * arc's spec never touched.
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
  number,
  label,
  state,
  pinned,
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
   * This step is the draft's current position. Open, and not collapsible.
   * Passed explicitly rather than inferred from `state`, matching the
   * deployed flow's identical rule (see the wizard's FlowStep.tsx docstring
   * history for why: affordance and position are different questions).
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
  children: ReactNode
}) {
  const openable = isStepOpenable(state)
  const [expanded, setExpanded] = useState(Boolean(pinned))

  const collapsible = openable && !pinned
  const showBody = openable && (Boolean(pinned) || expanded)

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
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Hide' : 'Review'}
            </button>
          )}
        </div>
      </div>

      {showBody && <div className="p-4 text-sm">{children}</div>}

      {!openable && (
        // A locked step renders prose only — never a greyed-out control.
        <div className="p-4 text-sm text-muted">
          {lockedReason ?? 'This step opens once the step before it is complete.'}
        </div>
      )}
    </section>
  )
}
