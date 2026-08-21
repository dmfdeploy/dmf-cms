import { createContext, forwardRef, type ReactNode } from 'react'
import type { FlowStepState } from '../../lib/workloadFlow'

/**
 * True for anything rendered inside a flow step. stages/StageCard.tsx reads
 * it and suppresses its own header/badge, so a stage panel contributes
 * content here and full chrome anywhere else — see StageCard's docstring
 * for why the flag lives in context rather than in a prop.
 */
export const InsideFlowStep = createContext(false)

/**
 * The wizard's single mounted step (umbrella #347 WO-D1, operator direction
 * 2026-08-02: "one lifecycle step visible at a time, Next/Previous").
 *
 * Replaces the S1/Arc-B all-step accordion (every step rendered, folded
 * behind a per-step Review/Hide toggle): the wizard instead mounts EXACTLY
 * ONE step's body — whichever WorkloadSetup's selection logic has chosen —
 * and this component is that mount plus its Previous/Next controls. There is
 * no expand/collapse state here any more: WorkloadSetup never selects a
 * step this component would need to hide, because selection only ever lands
 * on an openable step (lib/workloadFlow.ts's `isStepOpenable`).
 *
 * THE LOCKED GUARD STAYS ANYWAY, defence in depth. Nothing in WorkloadSetup
 * should ever pass state="locked" here, but if a caller bug did, this still
 * refuses to mount `children` — the same property flowStep.test.tsx pinned
 * for the old accordion: a caller bug must not be able to reach a control
 * the gate closed.
 *
 * PREVIOUS/NEXT ARE NAVIGATION ONLY. They never complete, unlock, or mutate
 * a step — WorkloadSetup computes canPrev/canNext from the flow's own
 * adjacency + lock state and passes them straight through; this component
 * renders whatever it is told, as a button when enabled and as inert text
 * naming the reason when not (never a disabled button — umbrella #285's
 * "no dead controls" carries forward unchanged).
 *
 * umbrella #432 G1: this used to also take an `isCurrentPosition` prop and
 * render "The workload is here now" beside the header — boilerplate, since
 * the state badge to its right already reads "Now" whenever that is true.
 * Removed outright rather than replaced with different wording; the badge
 * alone carries the fact.
 *
 * umbrella #432 §D1: `nextPrimary` decides Next's colour, never its
 * function — Next is UNCONDITIONAL either way (the file docstring above,
 * carried forward: a locked step is still reachable by navigating to it).
 * The rule (governed by ProvisionStage.tsx's own ruling comment: Provision
 * is the only step with a top-level PROMOTED primary action): exactly one
 * cyan control per screen. Every caller must pass this explicitly — there
 * is no default — because a wrong default here would either silently
 * revert every step to the pre-§D "no primary control at all" defect, or
 * silently double up a second cyan control next to a step's own promoted
 * action, and either is a regression this component itself has no way to
 * catch: it is handed the answer, not the inputs the answer is judged
 * from.
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

const FlowStep = forwardRef<
  HTMLDivElement,
  {
    /** DOM id, so the mounted step is addressable as a fragment. */
    anchorId?: string
    /** 1-based position in the flow, for the operator's sense of place. */
    number: number
    /** Verbatim EBU stage name — never abbreviated or re-worded. */
    label: string
    state: FlowStepState
    /** Why this step cannot be worked yet — see the file docstring's guard. */
    lockedReason?: string
    canPrevious: boolean
    canNext: boolean
    onPrevious: () => void
    onNext: () => void
    /** umbrella #432 §D1: true when Next is this screen's ONE promoted
     *  (cyan) control — i.e. the mounted step offers no top-level promoted
     *  action of its own. False on Provision (both wizards: it renders its
     *  own primary Deploy/Provision-now offer). See this component's own
     *  file docstring for the full rule and why there is no default. */
    nextPrimary: boolean
    /** Stated reason when Previous/Next are refused (jobInFlight or no
     *  reachable neighbour) — inert text names it, never a disabled button. */
    previousReason: string
    nextReason: string
    children: ReactNode
  }
>(function FlowStep(
  {
    anchorId,
    number,
    label,
    state,
    lockedReason,
    canPrevious,
    canNext,
    onPrevious,
    onNext,
    nextPrimary,
    previousReason,
    nextReason,
    children,
  },
  ref,
) {
  const locked = state === 'locked'

  return (
    <div
      ref={ref}
      id={anchorId}
      tabIndex={-1}
      className={`panel mt-4 border ${STATE_PANEL_CLASS[state]}`}
      aria-label={`Step ${number}: ${label}`}
      data-step-state={state}
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
          </div>
        </div>
        <span className={`badge text-xs ${STATE_BADGE_CLASS[state]}`}>{STATE_LABEL[state]}</span>
      </div>

      {locked ? (
        // A locked step renders prose only, and never its children — no
        // control inside them can be reached by a keyboard or a screen
        // reader while the gate has this step closed.
        <div className="p-4 text-sm text-muted">
          {lockedReason ?? 'This step opens once the step before it is complete.'}
        </div>
      ) : (
        <div className="p-4 text-sm">
          <InsideFlowStep.Provider value={true}>{children}</InsideFlowStep.Provider>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-xs">
        {canPrevious ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onPrevious}>
            ← Previous
          </button>
        ) : (
          <span className="text-muted">{previousReason}</span>
        )}
        {canNext ? (
          <button
            type="button"
            className={`btn ${nextPrimary ? 'btn-primary' : 'btn-secondary'} btn-sm`}
            onClick={onNext}
          >
            Next →
          </button>
        ) : (
          <span className="text-muted">{nextReason}</span>
        )}
      </div>
    </div>
  )
})

export default FlowStep
