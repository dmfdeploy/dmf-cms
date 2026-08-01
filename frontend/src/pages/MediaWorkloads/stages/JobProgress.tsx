import { useEffect } from 'react'
import { useCatalogJobStatus, useOperationStatus } from '../../../api/hooks'

/**
 * Launch-job progress/outcome, relocated verbatim (behaviour-for-behaviour)
 * from pages/Catalog/index.tsx's OperationStatusLine + JobStatusLine (WP-E).
 * This is the hard precondition the S1 spec calls out by name: hiding the
 * Activity nav item must never darken the deploy/teardown feedback loop, so
 * these two poll-driven status lines move onto the Provision and
 * Finalise & Review stages unchanged, not reinvented.
 */

const OPERATION_LABEL: Record<string, string> = {
  waking: 'Waking automation',
  launching: 'Launching job',
  launched: 'Launched',
  error: 'Error',
}

const OPERATION_CLASS: Record<string, string> = {
  waking: 'text-yellow-300',
  launching: 'text-blue-300',
  launched: 'text-green-400',
  error: 'text-red-400',
}

export function OperationStatusLine({
  operationId,
  onLaunched,
  onError,
}: {
  operationId: string
  onLaunched: (jobId: number) => void
  onError: () => void
}) {
  const { data: operation } = useOperationStatus(operationId)

  useEffect(() => {
    if (!operation) return
    let timer: ReturnType<typeof setTimeout> | undefined
    if (operation.state === 'launched' && operation.job_id) {
      timer = setTimeout(() => onLaunched(operation.job_id!), 1000)
    } else if (operation.state === 'error') {
      timer = setTimeout(() => onError(), 3000)
    }
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [operation, onLaunched, onError])

  if (!operation) {
    return <div className="text-xs text-muted">Querying operation status…</div>
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
}: {
  entryKey: string
  jobId: number
  onComplete: (key: string) => void
  onStatusChange?: (status: string) => void
}) {
  const { data: jobStatus } = useCatalogJobStatus(entryKey, jobId)

  useEffect(() => {
    if (jobStatus?.status) onStatusChange?.(jobStatus.status)
  }, [jobStatus?.status, onStatusChange])

  useEffect(() => {
    if (!jobStatus?.is_done) return
    const timer = setTimeout(() => onComplete(entryKey), 2000)
    return () => clearTimeout(timer)
  }, [jobStatus?.is_done, onComplete, entryKey])

  if (!jobStatus) {
    return <div className="text-xs text-muted">Querying job status…</div>
  }

  const label = jobStatus.status.charAt(0).toUpperCase() + jobStatus.status.slice(1)
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono">job #{jobId}</span>
      <span className={`font-medium ${JOB_CLASS[jobStatus.status] ?? 'text-muted'}`}>
        {jobStatus.status === 'running' ? '⟳ ' : ''}
        {label}
      </span>
    </div>
  )
}
