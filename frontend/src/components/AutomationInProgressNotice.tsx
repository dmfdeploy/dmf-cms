import type { ReactNode } from 'react'

/**
 * The loud, friendly layer next to an in-flight AWX automation job —
 * umbrella #432 (operator feedback: "too much small text on those
 * provision / switch / teardown / delete action... if you must keep all
 * the small text just add large friendly message, i am quite sure the
 * users will ignore all the small text"). First built inline in
 * WorkloadMaterializing.tsx for the provision path; lifted here once the
 * SAME visual treatment was needed for teardown's in-flight state
 * (FinaliseStage.tsx) too.
 *
 * SHARES THE VISUAL TREATMENT ONLY — deliberately NOT the wording.
 * `lead`/`children` are both fully owned by the caller: provision and
 * teardown are not honestly interchangeable prose (different actions,
 * different typical durations — a real provision on this environment took
 * roughly five minutes, a teardown two to three — and different claims
 * about what actually shows up where and when). A shared DEFAULT sentence
 * would risk one path silently inheriting a claim that isn't true of it;
 * this component has no default to inherit, so that mistake isn't
 * reachable from here.
 */
export default function AutomationInProgressNotice({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-lg font-medium text-text">{lead}</p>
      <p className="mt-1 text-muted">{children}</p>
    </div>
  )
}
