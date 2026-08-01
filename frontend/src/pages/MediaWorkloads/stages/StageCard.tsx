import type { ReactNode } from 'react'
import type { StageState } from '../../../lib/workloadLifecycle'

/**
 * Shared chrome for a lifecycle-rail stage panel (umbrella #285 S1). Every
 * stage renders through this so the four StageState values get ONE
 * consistent, designed treatment across Design/Plan/Provision/Configure/
 * Operate/Finalise — never a bespoke look per stage that would make the
 * rail's states feel like six different UIs.
 *
 * 'not-applicable' gets its own visibly quieter treatment (dashed border,
 * reduced emphasis) so it reads as "nothing to do here yet", never as a
 * disabled control — the content inside is always prose, never a greyed
 * button (hard gate: no disabled buttons anywhere).
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
