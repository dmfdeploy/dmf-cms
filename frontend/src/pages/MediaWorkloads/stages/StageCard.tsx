import { useContext, type ReactNode } from 'react'
import type { StageState } from '../../../lib/workloadLifecycle'
import { InsideFlowStep } from '../FlowStep'

/**
 * Shared chrome for a lifecycle stage panel (umbrella #285 S1). Every stage
 * renders through this so the four StageState values get ONE consistent,
 * designed treatment across Design/Plan/Provision/Configure/Finalise —
 * never a bespoke look per stage.
 *
 * 'not-applicable' gets its own visibly quieter treatment (dashed border,
 * reduced emphasis) so it reads as "nothing to do here yet", never as a
 * disabled control — the content inside is always prose, never a greyed
 * button (hard gate: no disabled buttons anywhere).
 *
 * ARC B: WHEN NESTED IN A FLOW STEP, THIS RENDERS NO CHROME AT ALL.
 * The guided flow (umbrella #285, operator direction 2026-08-01) wraps each
 * stage in FlowStep, which already carries the number, the verbatim stage
 * name, the state badge and the disclosure control. Rendering this card's
 * header inside that would give every step two headers and two state
 * badges — and the two would be answering slightly different questions
 * (flow-step state vs stage state), which is precisely the kind of
 * near-duplicate the operator called "confused" about the S1 rail.
 *
 * The alternative was stripping StageCard out of all five stage components.
 * A context flag was chosen instead so those five files stay untouched by
 * this arc — one wrapper deciding its own chrome is a smaller, more
 * reviewable change than five components each losing their outer element,
 * and it leaves the panels renderable with full chrome if anything ever
 * mounts them outside a flow step. (Nothing does today: WorkloadSetup is
 * the only caller. CreateWorkload deliberately does NOT reuse them — a
 * draft has no MediaWorkload to hand them — it renders its own draft
 * equivalents and only references these files in comments.)
 */
const STATE_LABEL: Record<StageState, string> = {
  active: 'You are here',
  available: 'Ready',
  informational: 'Record',
  'not-applicable': 'Not yet',
}

const STATE_BADGE_CLASS: Record<StageState, string> = {
  active: 'bg-accent/20 text-accent',
  available: 'bg-green-900/30 text-green-300',
  informational: 'bg-white/10 text-muted',
  'not-applicable': 'bg-white/5 text-muted',
}

const STATE_PANEL_CLASS: Record<StageState, string> = {
  active: 'border-accent/50',
  available: 'border-green-500/30',
  informational: 'border-white/10',
  'not-applicable': 'border-dashed border-white/10 opacity-90',
}

export default function StageCard({
  label,
  state,
  children,
}: {
  label: string
  state: StageState
  children: ReactNode
}) {
  // Nested in the guided flow: the step owns the chrome, so contribute
  // content only. See the file docstring for why this is a context flag
  // rather than a prop threaded through five call sites.
  if (useContext(InsideFlowStep)) return <>{children}</>

  return (
    <section
      className={`panel border ${STATE_PANEL_CLASS[state]}`}
      aria-label={label}
      data-stage-state={state}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <h2 className="text-base font-semibold">{label}</h2>
        <span className={`badge text-xs ${STATE_BADGE_CLASS[state]}`}>{STATE_LABEL[state]}</span>
      </div>
      <div className="p-4 text-sm">{children}</div>
    </section>
  )
}
