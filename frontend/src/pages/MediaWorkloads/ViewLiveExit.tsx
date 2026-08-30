import { Link } from 'react-router-dom'
import { workloadHomePath } from '../../lib/routes'

/**
 * The workload's "View live" exit (dmfdeploy#414 point 3) — a
 * plainly-labelled control back to the workload's home, never a bare icon
 * (an icon whose meaning is discoverable only by hover is too opaque for
 * the audience this arc is for). Shared by every surface that can strand an
 * operator away from home: WorkloadSetup.tsx (rendered on every branch,
 * including every loading-safe state ahead of the wizard's own data) and
 * WorkloadMaterializing.tsx (rendered while a just-fired deploy is still
 * being polled, before the workload exists in the inventory at all).
 *
 * FIX ROUND (dmfdeploy#414 gate, round 1 — P1): this component used to live
 * only in WorkloadSetup.tsx, and WorkloadMaterializing.tsx's own exit was a
 * second, always-active implementation — reasoned as safe because leaving
 * does not cancel the launch job server-side. That reasoning missed the
 * DESTINATION: while the launch job is still in flight, the workload does
 * not exist in NetBox yet (the launcher stamps its identity mid-run), so
 * "View live" sent an operator who clicked through on their own
 * just-created workload straight into home's own not-found/unresolved
 * reading — this arc's own defect class (an affordance asserting a state
 * the backend has not established), pointed at the one surface that had
 * skipped it. A launch job is also, independently, a mutation genuinely in
 * flight — it is being polled right there by OperationStatusLine/
 * JobStatusLine — so "no job can be in flight before a workload record
 * resolves" was true of WorkloadSetup's own loading-safe callers
 * specifically, never a fact about this control in general. Extracted here
 * so both surfaces share ONE control, ONE behaviour, ONE place to change
 * it — the same reasoning WorkloadSetup.tsx already gives for sharing
 * JobStatusLine/OperationStatusLine themselves with Provision.
 *
 * DELIBERATELY NOT PROMOTED INTO THE HEADER ACTION SLOT
 * (store/headerActionSlot.ts) Provision's own control portals into. That
 * mount point exists only once the rail has registered — i.e. only once the
 * workload has resolved (Topbar.tsx's `showSlotRow`) — so anything reachable
 * exclusively through it would be absent for exactly the loading-safe/
 * materialising states this control must cover. Rendering it directly in
 * the page body instead means the promoted Provision control (when
 * eligible) and this exit occupy different DOM regions by construction —
 * neither can overwrite the other's pixels, and this one needs no header
 * row to exist first.
 *
 * JOB-LOCK AWARE (dmfdeploy#414: "must obey the existing job-navigation
 * lock… going inert and naming the reason rather than rendering a disabled
 * button"). `jobInFlight` is each caller's OWN honest answer to "is a
 * mutation genuinely in flight right now" — WorkloadSetup derives it from
 * its wizard's launching/switching/tearingDown flags; WorkloadMaterializing
 * derives it from the launch job's own poll state (not yet a terminal
 * status, including FAILED — a real failure is something to go and look
 * at, not a reason to keep the operator here). Once a job settles, the
 * exit is a real link again.
 *
 * `jobReasonText` IS ON DEMAND, NOT PAINTED (umbrella #499). It used to
 * render inline — "View live — Unavailable until the job finishes." next
 * to a screen that ALSO said a job was running via the rail band, the
 * top-right readout, and the stage card, all at once. A disabled control
 * explaining itself is legitimate (umbrella #499's own words); restating
 * "a job is running" a fourth time on the same screen is not. The reason
 * still exists — in `title` for a sighted hover/focus, and in a visually
 * hidden node so the accessible name carries it regardless of hover — it
 * is just no longer FORCED into view for an operator who already read it
 * somewhere else on this screen.
 */
export default function ViewLiveExit({
  slug,
  jobInFlight,
  jobReasonText,
}: {
  slug: string
  jobInFlight?: boolean
  jobReasonText?: string
}) {
  if (jobInFlight) {
    return (
      <span role="status" className="shrink-0 whitespace-nowrap text-sm text-muted" title={jobReasonText}>
        View live
        {jobReasonText && <span className="sr-only"> — {jobReasonText}</span>}
      </span>
    )
  }
  return (
    <Link to={workloadHomePath(slug)} className="btn btn-secondary btn-sm shrink-0">
      View live
    </Link>
  )
}
