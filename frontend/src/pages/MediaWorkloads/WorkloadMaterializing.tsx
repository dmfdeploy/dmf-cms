import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { JobStatusLine, OperationStatusLine } from './stages/JobProgress'

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
 * surface must say so and stop implying something is coming — otherwise the
 * operator sits watching a spinner for a workload that will never arrive.
 * The failure is terminal content here, with a way back, not a transient
 * line that scrolls away.
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
export interface WorkloadLaunchState {
  /** Catalog entry that was deployed — needed to read job status. */
  entryKey: string
  /** Async autoscale path: an operation that will yield a job id. */
  operationId?: string
  /** Sync path: the AWX job id itself. */
  jobId?: number
}

/** Narrow unknown router state to a launch handoff, or null. */
export function readLaunchState(state: unknown): WorkloadLaunchState | null {
  if (typeof state !== 'object' || state === null) return null
  const launch = (state as { launch?: unknown }).launch
  if (typeof launch !== 'object' || launch === null) return null
  const { entryKey, operationId, jobId } = launch as Record<string, unknown>
  if (typeof entryKey !== 'string' || entryKey === '') return null
  return {
    entryKey,
    operationId: typeof operationId === 'string' ? operationId : undefined,
    jobId: typeof jobId === 'number' ? jobId : undefined,
  }
}

/** Terminal AWX job states that mean the workload is not coming. */
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
      <div className="hero">
        <p className="kicker">Media Workloads</p>
        <h1 className="capitalize">{slug}</h1>
        <p>{failed ? 'Launch failed' : 'Provisioning'}</p>
      </div>

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
            <p className="text-muted">
              {operationFailed
                ? 'The automation platform did not start the job.'
                : `The job finished as "${jobStatus}".`}{' '}
              Nothing is recorded under the identity{' '}
              <span className="font-mono">workload:{slug}</span> unless a previous
              deploy already created it — this page is not the place that would know,
              so check the Media Workloads list rather than assuming either way.
            </p>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-text">Deploy accepted.</p>
            <p className="text-muted">
              This workload appears here once the launcher records it against the
              identity <span className="font-mono">workload:{slug}</span> in the
              facility source of truth. That happens after the job below finishes,
              not when the deploy was accepted — so an empty inventory right now is
              expected, not a missing workload.
            </p>
            {jobSucceeded && (
              <p className="text-muted">
                The job has finished. Waiting for the record to appear in the
                inventory — this page will become the workload&apos;s flow as soon as
                it does.
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
            />
          ) : jobId !== null ? (
            <JobStatusLine
              entryKey={launch.entryKey}
              jobId={jobId}
              onComplete={handleJobComplete}
              onStatusChange={handleStatusChange}
            />
          ) : (
            <div className="text-xs text-muted">
              No job reference came back with the deploy, so its progress cannot be
              followed here.
            </div>
          )}
        </div>
      </div>

      <Link to="/media-workloads" className="mt-4 inline-block text-sm text-accent hover:underline">
        ← Back to Media Workloads
      </Link>
    </div>
  )
}
