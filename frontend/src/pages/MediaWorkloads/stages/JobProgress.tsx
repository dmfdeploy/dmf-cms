import { useEffect, useRef } from 'react'
import { useCatalogJobStatus, useOperationStatus } from '../../../api/hooks'
import { settleQuery } from '../../../lib/queryState'
import type { Operation, OperationState } from '../../../api/types'

/**
 * Launch-job progress/outcome, relocated verbatim (behaviour-for-behaviour)
 * from pages/Catalog/index.tsx's OperationStatusLine + JobStatusLine (WP-E).
 * This is the hard precondition the S1 spec calls out by name: hiding the
 * Activity nav item must never darken the deploy/teardown feedback loop, so
 * these two poll-driven status lines move onto the Provision and
 * Finalise & Review stages unchanged, not reinvented.
 */

// Exported (umbrella #499): the delete-permanently panel below FinaliseStage
// reuses this SAME table for its own operator-language state text, rather
// than hand-writing a second translation of `Operation['state']` — the
// raw enum value it used to render at default level is exactly the Art. 3
// leak that issue is about, and a second copy here would just be a second
// place for the two tables to drift apart.
//
// PR #127 review fix: typed `Record<string, string>`, this table could be
// missing a key and TypeScript would never notice — which is exactly how
// `running` shipped with no entry (FinaliseStage's delete-permanently panel
// observing a purge mid-flight rendered a blank status line). Retyped
// `Record<OperationState, string>` so the object literal itself is a
// compile-time exhaustiveness check: add a state to OPERATION_STATES
// without a matching entry here, or vice versa, and `tsc` refuses to build.
// jobProgressHonesty.test.tsx also asserts this at runtime, independent of
// whether a given test run happens to invoke tsc.
export const OPERATION_LABEL: Record<OperationState, string> = {
  waking: 'Waking automation',
  launching: 'Launching job',
  launched: 'Launched',
  running: 'Running',
  error: 'Error',
  // umbrella #403: the REAL terminal states a watched action (deploy/
  // teardown/rollback/finalise-purge — see useOperationStatus's own
  // _WATCHED_TERMINAL_STATES) settles at, past `launched`. Without these,
  // an operation observed at one of these states rendered an empty label
  // here — the operation id followed by blank space — for as long as the
  // line stayed mounted. A real, visible symptom on its own, independent of
  // the stuck-busy defect these are fixed alongside.
  run_complete: 'Complete',
  run_failed: 'Failed',
  failed_rollback_required: 'Rollback required',
  rollback_incomplete: 'Rollback incomplete',
  run_status_unknown: 'Status unknown',
}

// PR #127 review fix: same shape, same gap, same fix as OPERATION_LABEL
// above — `running` had no class either, so the span rendered with
// `undefined` appended to its className (no visible color, reading as calm/
// neutral rather than "in progress"). `running` gets the SAME blue as
// `launching` (still mid-flight, nothing wrong yet); the two states that
// genuinely need attention — rollback_incomplete/run_status_unknown — were
// already differentiated (red/amber, never green) by umbrella #403 and stay
// that way.
export const OPERATION_CLASS: Record<OperationState, string> = {
  waking: 'text-yellow-300',
  launching: 'text-blue-300',
  launched: 'text-green-400',
  running: 'text-blue-300',
  error: 'text-red-400',
  run_complete: 'text-green-400',
  run_failed: 'text-red-400',
  failed_rollback_required: 'text-red-400',
  rollback_incomplete: 'text-red-400',
  run_status_unknown: 'text-amber-300',
}

// umbrella #403: the same real-terminal set, as an array for the membership
// check below. `launched` is deliberately absent — it is the transient
// mid-flight state the pre-existing onLaunched hand-off already owns, and
// the exact state a client can miss (a watched action keeps running right
// past it toward one of these regardless of whether anyone observed it).
// `error` is also absent — it already has its own dedicated callback.
const OPERATION_TERMINAL_STATES: Operation['state'][] = [
  'run_complete', 'run_failed', 'failed_rollback_required', 'rollback_incomplete', 'run_status_unknown',
]

export function OperationStatusLine({
  operationId,
  onLaunched,
  onError,
  onTerminal,
  onDoneChange,
}: {
  operationId: string
  onLaunched: (jobId: number) => void
  onError: () => void
  /**
   * umbrella #403: fires ONCE per operation id, the moment the operation is
   * observed in any of OPERATION_TERMINAL_STATES. The only reliable signal
   * for a watched action — `launched` (what onLaunched depends on) is
   * transient, and a watched action keeps running right past it toward a
   * real terminal state whether or not any poll happened to land during
   * that window (a missed tick, a backgrounded tab — refetchInterval does
   * not run there). Optional: existing callers, and
   * jobProgressHonesty.test.tsx, only ever needed onLaunched/onError.
   */
  onTerminal?: (operation: Operation) => void
  /**
   * dmfdeploy#414 gate, round 2 (P1): the raw "has this operation reached
   * error or any OPERATION_TERMINAL_STATES" fact, reported the instant it is
   * known — the operation-level twin of JobStatusLine's own `onDoneChange`
   * below, and for the identical reason. onError/onTerminal above are
   * deliberately PACED (1-3s: "long enough to actually read before the line
   * clears", per the comment on that timer) so a human watching THIS line
   * has time to read "Error"/"Rollback required"/… before whatever consumes
   * the callback reacts to it. Round 1 fixed the JOB half of this arc's own
   * defect class (a job-navigation lock reading a display-paced signal) but
   * left the OPERATION half of the same lock reading onError/onTerminal
   * directly — so a genuinely-terminal operation left the lock engaged
   * (claiming a launch was still in flight) for up to 3 more seconds after
   * the label right next to it had already switched to "Error" or "Failed".
   * Same fix shape as onDoneChange: a separate effect, no setTimeout, so it
   * cannot perturb the pacing above in either direction. Optional: existing
   * callers (Provision's own OperationStatusLine usage) never needed it.
   */
  onDoneChange?: (done: boolean) => void
}) {
  // fix-round 6 (PR #81, umbrella #385 codex sweep): this polls every 3s
  // while non-terminal, and `data` was the only thing read — a settled
  // failed refetch retained the last-good `operation` with no notice, so a
  // stuck/failing poll silently kept showing e.g. "Launching job" as
  // current. `settleQuery` surfaces `failed` alongside the retained data
  // (Art. 5 — the line stays put) so the caption can say so (Art. 1).
  const { data: operation, failed } = settleQuery(useOperationStatus(operationId))

  // umbrella #403: which operation id onTerminal has already fired for. Set
  // INSIDE the timeout callback, only once it actually runs — never at
  // schedule time — so a re-render that swaps in a new (but still-terminal)
  // `operation` object before the timer elapses correctly reschedules it
  // instead of permanently skipping the call. The guard below only ever
  // suppresses scheduling a SECOND timer once the first one has truly fired
  // for this id.
  const firedTerminalFor = useRef<string | null>(null)

  useEffect(() => {
    if (!operation) return
    let timer: ReturnType<typeof setTimeout> | undefined
    if (operation.state === 'launched' && operation.job_id) {
      timer = setTimeout(() => onLaunched(operation.job_id!), 1000)
    } else if (operation.state === 'error') {
      timer = setTimeout(() => onError(), 3000)
    } else if (
      onTerminal &&
      OPERATION_TERMINAL_STATES.includes(operation.state) &&
      firedTerminalFor.current !== operationId
    ) {
      const settledOperation = operation
      // Same good-news/bad-news pacing as the two branches above: a clean
      // run_complete hands off promptly, anything else lingers long enough
      // to actually read before the line (and whatever it's part of) clears.
      const delay = operation.state === 'run_complete' ? 1000 : 3000
      timer = setTimeout(() => {
        firedTerminalFor.current = operationId
        onTerminal(settledOperation)
      }, delay)
    }
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [operation, operationId, onLaunched, onError, onTerminal])

  // dmfdeploy#414 gate, round 2 (P1): see onDoneChange's own docstring above.
  // Deliberately its own effect, not folded into the one above — that one
  // schedules the display's PACED handoff and must keep doing exactly that,
  // unchanged; this one reports the unpaced fact as soon as `operation`
  // itself changes. Recomputed fresh on every `operation` change rather than
  // read off the timer, so it is never even indirectly gated by a delay.
  useEffect(() => {
    onDoneChange?.(operation != null && (operation.state === 'error' || OPERATION_TERMINAL_STATES.includes(operation.state)))
  }, [operation, onDoneChange])

  if (!operation) {
    return (
      <div className="text-xs text-muted">
        {failed ? 'Could not query operation status — retrying automatically' : 'Querying operation status…'}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono">op {operationId.slice(0, 8)}...</span>
      <span className={`font-medium ${OPERATION_CLASS[operation.state]}`}>
        {OPERATION_LABEL[operation.state]}
      </span>
      {operation.error && (
        <span className="text-red-400">
          Launch did not start — {operation.error}
        </span>
      )}
      {failed && (
        <span className="text-amber-300">Could not confirm — showing the last read, retrying</span>
      )}
    </div>
  )
}

const JOB_CLASS: Record<string, string> = {
  new: 'text-blue-300',
  pending: 'text-yellow-300',
  waiting: 'text-yellow-300',
  running: 'text-blue-300',
  successful: 'text-green-400',
  failed: 'text-red-400',
  error: 'text-red-400',
  canceled: 'text-gray-400',
}

export function JobStatusLine({
  entryKey,
  jobId,
  onComplete,
  // Additive over the Catalog original: Finalise & Review needs to keep
  // showing the LAST job's outcome as its "review" after the in-flight
  // tracker clears (onComplete), which the original never needed since
  // Catalog just lets the line disappear. Optional so Provision (which has
  // no review copy to keep) is unaffected.
  onStatusChange,
  // dmfdeploy#414 gate, round 1 (P1): the raw `is_done` fact, reported the
  // instant it changes — deliberately NOT the same signal as `onComplete`
  // below, which fires only after a 2s deliberate read-the-outcome pacing
  // delay. A caller gating a job-navigation LOCK (WorkloadMaterializing's
  // ViewLiveExit) needs the honest "is a mutation still in flight" fact as
  // soon as it is known, not paced for readability the way the query-
  // invalidation trigger is. Optional: existing callers (Provision,
  // Finalise & Review) only ever needed onComplete/onStatusChange.
  onDoneChange,
}: {
  entryKey: string
  jobId: number
  onComplete: (key: string) => void
  onStatusChange?: (status: string) => void
  onDoneChange?: (done: boolean) => void
}) {
  // fix-round 6 (PR #81, umbrella #385 codex sweep): same shape as
  // OperationStatusLine above — a settled failed refetch (this polls every
  // 2s) used to keep showing the last-good status with no notice.
  const { data: jobStatus, failed } = settleQuery(useCatalogJobStatus(entryKey, jobId))

  useEffect(() => {
    if (jobStatus?.status) onStatusChange?.(jobStatus.status)
  }, [jobStatus?.status, onStatusChange])

  useEffect(() => {
    onDoneChange?.(Boolean(jobStatus?.is_done))
  }, [jobStatus?.is_done, onDoneChange])

  useEffect(() => {
    if (!jobStatus?.is_done) return
    const timer = setTimeout(() => onComplete(entryKey), 2000)
    return () => clearTimeout(timer)
  }, [jobStatus?.is_done, onComplete, entryKey])

  if (!jobStatus) {
    return (
      <div className="text-xs text-muted">
        {failed ? 'Could not query job status — retrying automatically' : 'Querying job status…'}
      </div>
    )
  }

  const label = jobStatus.status.charAt(0).toUpperCase() + jobStatus.status.slice(1)
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono">job #{jobId}</span>
      <span className={`font-medium ${JOB_CLASS[jobStatus.status] ?? 'text-muted'}`}>
        {jobStatus.status === 'running' ? '⟳ ' : ''}
        {label}
      </span>
      {failed && (
        <span className="text-amber-300">Could not confirm — showing the last read, retrying</span>
      )}
    </div>
  )
}
