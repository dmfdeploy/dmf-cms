import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { JobStatusLine, OperationStatusLine } from './stages/JobProgress'
import type { Operation } from '../../api/types'

/**
 * The gap between "the deploy was accepted" and "the workload exists"
 * (umbrella #285, GATE-B P1).
 *
 * THE BUG THIS EXISTS TO FIX. Create used to navigate to
 * /media-workloads/<slug> the instant the deploy POST resolved, on the
 * premise that "the deploy call is the moment the workload starts
 * existing". That premise is false. A deploy is ACCEPTED by AWX; the
 * workload's identity only comes into being later, when the launcher
 * stamps the workload:<slug> tag in NetBox and the grouped inventory picks
 * it up. Navigating on acceptance therefore landed the operator on
 * "Workload not found" for the workload they had just created — the console
 * flatly denying the existence of a thing it had itself just launched.
 * That is an Art. 1 failure at the worst possible moment, right after the
 * one write the operator most needs confirmed.
 *
 * WHAT THIS RENDERS INSTEAD. A designed materializing state that tells the
 * truth about all three things it knows separately:
 *   - the deploy was accepted (a fact, already established);
 *   - the launch job is running / succeeded / FAILED (polled, never assumed);
 *   - the workload has not appeared in the inventory YET (an absence, and
 *     an expected one — not a not-found).
 *
 * It never claims the workload exists. It never claims it does not. It says
 * what was accepted, what the job is doing, and what has to happen next.
 *
 * A FAILED JOB IS THE POINT, not an afterthought. If the launch fails, this
 * surface must say so and stop implying a workload is on its way — otherwise
 * the operator sits watching a spinner. The failure is standing content here,
 * with a way back, not a transient line that scrolls away.
 *
 * BUT A FAILED JOB DOES NOT MEAN NOTHING WAS RECORDED, and this surface must
 * not say that it does. The launcher writes the tagged NetBox record PART-WAY
 * through the run (dmf-runbooks roles/mxl provision stage), and the fault
 * boundary sits AFTER that first mutation — so a job that fails later has
 * already created the record. What happens to that record next is the
 * console's job, and it ATTEMPTS cleanup rather than guaranteeing it: the run
 * guard's own rescue only MARKS the snapshot failed_rollback_required (it
 * rolls nothing back itself), and dmf-cms watches for that transition and
 * auto-DISPATCHES a rollback — main.py's _maybe_auto_trigger_rollback, gated
 * by settings.l3.auto_rollback, default True.
 *
 * Dispatching is not cleaning up, and the distinction is load-bearing here.
 * A dispatched rollback reaches RUN_COMPLETE only on a successful job AND the
 * exact rollback_complete marker; every other combination fails closed to
 * ROLLBACK_INCOMPLETE — a failed rollback job, or a successful-but-silent one
 * whose marker never arrived. So the default path attempts cleanup, and may
 * leave the record standing anyway.
 *
 * Two cases fall outside that default, and only ONE of them needs a human:
 *   - identity-unknown (the failed op carries no run_id) and disabled
 *     (auto_rollback off): no dispatch happens, so an explicit rollback is
 *     the fallback;
 *   - already-in-progress: a rollback for that run is already running, so the
 *     console reattaches to it and returns. Nothing further is required —
 *     grouping this with the two above would invent operator work that does
 *     not exist.
 *
 * This page can see none of that, which is exactly why the rendered copy
 * below stays neutral about who runs the rollback and whether it succeeds,
 * and only says the record stands until one is run.
 *
 * So the failure copy states an uncertainty rather than resolving it, and the
 * page stays live underneath: if the inventory does report the workload, the
 * parent swaps this view for the real flow exactly as it would have on a
 * clean launch. "Failed" here bounds what the console knows, not what the
 * facility contains.
 *
 * The caller unmounts this the moment the workload appears in the grouped
 * inventory, so the happy path ends by simply becoming the real flow page.
 */

/**
 * What Create hands to the destination through router location state. The
 * deploy seam returns either a direct job (sync) or an operation that
 * resolves to one (async autoscale), so this carries whichever arrived —
 * the same union ProvisionStage already tracks, not a new model.
 */
export type WorkloadLaunchState = { entryKey: string } & (
  /** Async autoscale path: an operation that will yield a job id. */
  | { operationId: string; jobId?: number }
  /** Sync path: the AWX job id itself. */
  | { operationId?: string; jobId: number }
)

/** Narrow unknown router state to a launch handoff, or null. */
export function readLaunchState(state: unknown): WorkloadLaunchState | null {
  if (typeof state !== 'object' || state === null) return null
  const launch = (state as { launch?: unknown }).launch
  if (typeof launch !== 'object' || launch === null) return null
  const { entryKey, operationId, jobId } = launch as Record<string, unknown>
  if (typeof entryKey !== 'string' || entryKey === '') return null
  const op = typeof operationId === 'string' && operationId !== '' ? operationId : undefined
  const job = typeof jobId === 'number' ? jobId : undefined
  // A LAUNCH WITH NOTHING TO POLL IS MALFORMED, NOT A PARTIAL LAUNCH.
  // Dropping wrong-typed ids and keeping the entry key used to yield a launch
  // that could never resolve: the destination would render "Deploy accepted"
  // with no job to follow, forever, for a workload that may not be coming —
  // a permanent unpollable ghost, and a worse lie than the not-found it
  // replaced, because it asserts a launch instead of admitting an absence.
  // Without a pollable reference there is no launch to speak of, so the page
  // falls through to the ordinary not-found.
  if (job !== undefined) return { entryKey, operationId: op, jobId: job }
  if (op !== undefined) return { entryKey, operationId: op }
  return null
}

/**
 * Terminal AWX job states meaning the LAUNCH JOB did not succeed.
 *
 * Deliberately not "the workload is not coming": the launcher writes the
 * tagged record part-way through the run, so a job that fails after that
 * point has already created it and the workload can still appear. This set
 * classifies the JOB's outcome, and nothing more — the parent decides what
 * exists, from the inventory.
 */
const FAILED_JOB_STATES = new Set(['failed', 'error', 'canceled'])

export default function WorkloadMaterializing({
  slug,
  launch,
}: {
  slug: string
  launch: WorkloadLaunchState
}) {
  const queryClient = useQueryClient()
  // Job id may arrive with the handoff (sync path) or later from the
  // operation (async path); both land here.
  const [jobId, setJobId] = useState<number | null>(launch.jobId ?? null)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [operationFailed, setOperationFailed] = useState(false)

  const handleLaunched = useCallback((id: number) => setJobId(id), [])
  const handleOperationError = useCallback(() => setOperationFailed(true), [])

  // umbrella #403: a deploy is a WATCHED action (useOperationStatus's own
  // _WATCHED_TERMINAL_STATES) — it keeps running right past the transient
  // `launched` state handleLaunched depends on, toward one of the real
  // terminal states below, whether or not `launched` itself was ever
  // observed. Without this, a missed poll tick left this page rendering
  // "Deploy accepted…" over a status line that had already stopped polling,
  // forever. A terminal operation still carrying a job id is handed to the
  // SAME jobId path handleLaunched already feeds — the launcher's own job
  // is the honest source for what actually happened (successful/failed/…,
  // the jobFailed/jobSucceeded copy below already covers it), not a second,
  // parallel notion of "done" invented here. Only the identity-unknown case
  // (no job id was ever assigned) falls back to the operation-failed copy —
  // the one case where there is no job to hand off to.
  const handleOperationTerminal = useCallback((operation: Operation) => {
    if (operation.job_id !== null) {
      setJobId(operation.job_id)
    } else {
      setOperationFailed(true)
    }
  }, [])

  // A finished job is the moment the record is most likely to exist, so ask
  // the inventory again rather than waiting out its poll interval. This
  // component keeps rendering either way — the parent swaps it out only
  // when the workload actually appears, never on the job's say-so.
  const handleJobComplete = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })
  }, [queryClient])

  const handleStatusChange = useCallback((status: string) => {
    setJobStatus(status)
    if (status === 'successful') return
  }, [])

  const jobFailed = jobStatus !== null && FAILED_JOB_STATES.has(jobStatus)
  const failed = operationFailed || jobFailed
  const jobSucceeded = jobStatus === 'successful'

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Not page chrome — an outcome heading (spec C's sanctioned survivor):
          the one fact this whole component exists to state honestly, before
          the workload's own identity even exists to put in a breadcrumb. */}
      <h1 className="text-lg font-semibold text-text">{failed ? 'Launch failed' : 'Provisioning'}</h1>

      <div
        className={`panel mt-6 border px-4 py-4 ${
          failed ? 'border-red-500/30 bg-red-500/5' : 'border-accent/30'
        }`}
        aria-label="Workload provisioning"
      >
        {failed ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-red-200">
              The launch job for this workload did not succeed.
            </p>
            {operationFailed ? (
              // The one branch where "nothing was recorded" IS earned: the
              // job never started, so no task ran and no mutation happened.
              <p className="text-muted">
                The automation platform did not start the job, so nothing ran and
                nothing was recorded under the identity{' '}
                <span className="font-mono">workload:{slug}</span>.
              </p>
            ) : (
              <p className="text-muted">
                The job finished as &quot;{jobStatus}&quot;. It may still have recorded
                the workload before it failed — the launcher writes the record
                part-way through the run, so a later failure leaves it behind. If it
                did, <span className="font-mono">workload:{slug}</span> will appear
                here or in the Media Workloads list, and it stays until a rollback is
                run for that job. This page cannot tell which happened; check the list
                rather than assuming either way.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-text">Deploy accepted.</p>
            <p className="text-muted">
              This workload appears here once the launcher records it against the
              identity <span className="font-mono">workload:{slug}</span> in the
              facility source of truth. The launcher does that PART-WAY through the
              job below — not when the deploy was accepted, and not only once the job
              ends — so it can show up here while the job is still running, and an
              empty inventory in the meantime is expected rather than a missing
              workload.
            </p>
            {jobSucceeded && (
              <p className="text-muted">
                The job has finished but the record still is not readable here. That is
                past the point where the launcher writes it, so this is a lag or a
                failed write rather than the ordinary wait — check the Media Workloads
                list if it does not resolve shortly.
              </p>
            )}
          </div>
        )}

        {/* The job's own loop, closed at the point of the action that started
            it (Art. 2). Same two status lines Provision uses — one
            implementation, so this page and that stage can never disagree
            about what a job is doing. */}
        <div className="mt-3 border-t border-white/10 pt-3">
          {launch.operationId && jobId === null && !operationFailed ? (
            <OperationStatusLine
              operationId={launch.operationId}
              onLaunched={handleLaunched}
              onError={handleOperationError}
              onTerminal={handleOperationTerminal}
            />
          ) : jobId !== null ? (
            <JobStatusLine
              entryKey={launch.entryKey}
              jobId={jobId}
              onComplete={handleJobComplete}
              onStatusChange={handleStatusChange}
            />
          ) : (
            // REACHABLE, on exactly one path: the operation errored before it
            // ever yielded a job id, so operationFailed suppresses the first
            // branch while jobId is still null. (A launch carrying NEITHER
            // reference cannot get here — readLaunchState refuses it, and the
            // WorkloadLaunchState union now encodes that so the compiler
            // agrees rather than a comment asserting it.)
            //
            // Rendering nothing is correct here rather than a gap: no job was
            // ever created, so there is no job status to show, and the panel
            // ABOVE has already stated the failure and that nothing ran. A
            // status line in this slot could only invent a job that does not
            // exist. Null is the terminal render for that path, not an
            // exhaustiveness placeholder.
            null
          )}
        </div>
      </div>

      <Link to="/media-workloads" className="mt-4 inline-block text-sm text-accent hover:underline">
        ← Back to Media Workloads
      </Link>
    </div>
  )
}
