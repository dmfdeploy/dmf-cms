import { useState, useEffect } from 'react'
import { useWorkflows, useLaunchWorkflow, useWorkflowJobStatus, useCurrentUser, useOperationStatus, isOperation } from '../../api/hooks'
import ReasonConfirm from '../../components/ReasonConfirm'
import { useActivityStore } from '../../store/activity'

interface ActiveJob {
  workflowName: string
  jobId: number
}

interface PendingOperation {
  workflowName: string
  operationId: string
}

// Jobs lane — "what is running / launchable" (IA §5). The former
// /workflows page body; the Activity shell owns the hero and scroll
// container. Launch outcomes stay anchored on the card (hard gate 2).
export default function JobsLane() {
  const { data: user } = useCurrentUser()
  const { data: workflowsData, isLoading } = useWorkflows()
  const launchMutation = useLaunchWorkflow()
  const recordAwxWrite = useActivityStore((s) => s.recordAwxWrite)
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([])
  const [pendingOps, setPendingOps] = useState<PendingOperation[]>([])

  const handleLaunch = async (workflowName: string, reason: string) => {
    try {
      const result = await launchMutation.mutateAsync({ workflowName, reason })
      // Console-local Activity record (plan §4a, #185 WP-E P2-3).
      recordAwxWrite({
        request_id: result.request_id ?? '',
        action: 'launch',
        target: workflowName,
        reason,
        actor: user?.subject ?? 'unknown',
        role: user?.role ?? 'unknown',
        outcome: isOperation(result) ? 'dispatched' : result.status,
      })
      if (isOperation(result)) {
        // Async flow (202): track the operation
        setPendingOps(prev => [...prev, { workflowName, operationId: result.operation_id }])
      } else {
        // Sync flow (200): immediate job_id
        setActiveJobs(prev => [...prev, { workflowName, jobId: result.job_id }])
      }
    } catch (error) {
      console.error('Failed to launch workflow:', error)
    }
  }

  return (
    <div>
      {!user?.awx_configured ? (
        <div className="panel text-center py-12">
          <p className="text-muted">AWX API not configured. Release 2 will expose approved AWX jobs from this surface.</p>
        </div>
      ) : isLoading ? (
        <div className="panel text-center py-12">
          <p className="text-muted">Loading workflows...</p>
        </div>
      ) : !workflowsData?.templates || workflowsData.templates.length === 0 ? (
        <div className="panel text-center py-12">
          <p className="text-muted">No workflows available</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 mb-8">
            {workflowsData.templates.map((template) => (
              <WorkflowCard
                key={template.id}
                template={template}
                onLaunch={(reason) => handleLaunch(template.name, reason)}
                isLaunching={launchMutation.isPending && launchMutation.variables?.workflowName === template.name}
                launchError={launchMutation.variables?.workflowName === template.name ? launchMutation.error : null}
                activeJob={activeJobs.find((j) => j.workflowName === template.name)}
                pendingOp={pendingOps.find((op) => op.workflowName === template.name)}
                onJobComplete={(jobId) => {
                  setActiveJobs(prev => prev.filter((j) => j.jobId !== jobId))
                }}
                onOpComplete={(operationId) => {
                  setPendingOps(prev => prev.filter((op) => op.operationId !== operationId))
                }}
              />
            ))}
          </div>

          {pendingOps.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <h3 className="text-lg font-bold">Waking AWX</h3>
                <span className="panel-subtitle">{pendingOps.length} pending</span>
              </div>
              <div className="space-y-3">
                {pendingOps.map((op) => (
                  <OperationMonitor
                    key={op.operationId}
                    workflowName={op.workflowName}
                    operationId={op.operationId}
                    onLaunched={(jobId) => {
                      setActiveJobs(prev => [...prev, { workflowName: op.workflowName, jobId }])
                      setPendingOps(prev => prev.filter((p) => p.operationId !== op.operationId))
                    }}
                    onError={() => {
                      setPendingOps(prev => prev.filter((p) => p.operationId !== op.operationId))
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {activeJobs.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <h3 className="text-lg font-bold">Active Jobs</h3>
                <span className="panel-subtitle">{activeJobs.length} running</span>
              </div>
              <div className="space-y-3">
                {activeJobs.map((job) => (
                  <JobMonitor
                    key={`${job.workflowName}-${job.jobId}`}
                    workflowName={job.workflowName}
                    jobId={job.jobId}
                    onComplete={() => {
                      job.jobId && handleJobComplete(job.jobId)
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )

  function handleJobComplete(jobId: number) {
    setActiveJobs(prev => prev.filter((j) => j.jobId !== jobId))
  }
}

function WorkflowCard({
  template,
  onLaunch,
  isLaunching,
  launchError,
  activeJob,
  pendingOp,
  onJobComplete,
}: {
  template: any
  onLaunch: (reason: string) => void
  isLaunching: boolean
  launchError: unknown
  activeJob?: { workflowName: string; jobId: number }
  pendingOp?: { workflowName: string; operationId: string }
  onJobComplete: (jobId: number) => void
  // onOpComplete is part of the call-site contract but op completion is owned
  // by the parent's pending-operations panel, not the card; accept, don't bind.
  onOpComplete: (operationId: string) => void
}) {
  // Graduated friction (hard gate 3): Launch arms a reason panel; the
  // operator-gated launch fires only on Confirm with a non-empty reason.
  const [arming, setArming] = useState(false)

  return (
    <div className="panel">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h3 className="text-lg font-semibold mb-1">{template.name}</h3>
          <p className="text-sm text-muted">{template.description}</p>
          {activeJob && !pendingOp && (
            <JobStatus jobId={activeJob.jobId} onComplete={() => onJobComplete(activeJob.jobId)} />
          )}
        </div>
        <button
          onClick={() => setArming(true)}
          disabled={isLaunching || !!activeJob || !!pendingOp || arming}
          className="btn btn-primary btn-sm ml-4"
        >
          {pendingOp ? '⏳ Waking...' : activeJob ? '⏳ Running...' : '▶ Launch'}
        </button>
      </div>
      {arming && (
        <div className="mt-3">
          <ReasonConfirm
            title={`Launch ${template.name}?`}
            description="Runs this AWX workflow. The action is operator-gated and recorded in the audit trail with your reason."
            confirmLabel="Confirm launch"
            pendingLabel="Launching…"
            pending={isLaunching}
            error={launchError}
            onConfirm={(reason) => { onLaunch(reason); setArming(false) }}
            onCancel={() => setArming(false)}
          />
        </div>
      )}
    </div>
  )
}

function OperationMonitor({
  workflowName,
  operationId,
  onLaunched,
  onError,
}: {
  workflowName: string
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
      console.error('Operation failed:', operation.error)
      timer = setTimeout(() => onError(), 3000)
    }
    
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [operation, onLaunched, onError])

  if (!operation) return null

  const stateLabel = {
    waking: '🔄 Waking AWX...',
    launching: '🚀 Launching job...',
    launched: '✓ Launched',
    error: '✗ Error',
  }[operation.state]

  const stateColor = {
    waking: 'badge-status-pending',
    launching: 'badge-status-running',
    launched: 'badge-status-successful',
    error: 'badge-status-failed',
  }[operation.state]

  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="font-semibold">{workflowName}</div>
        <div className="text-sm text-muted">operation {operationId.slice(0, 8)}...</div>
      </div>
      <div className="flex items-center gap-3">
        <span className={`badge text-xs ${stateColor}`}>{stateLabel}</span>
        {operation.error && (
          <span className="text-xs text-red-500">{operation.error}</span>
        )}
      </div>
    </div>
  )
}

function JobStatus({ jobId, onComplete }: { jobId: number; onComplete: () => void }) {
  const { data: jobStatus } = useWorkflowJobStatus(jobId)

  const isTerminal = jobStatus ? ['successful', 'failed', 'error', 'canceled'].includes(jobStatus.status) : false

  useEffect(() => {
    if (!isTerminal) return
    
    const timer = setTimeout(() => onComplete(), 2000)
    return () => clearTimeout(timer)
  }, [isTerminal, onComplete])

  if (!jobStatus) return null

  const statusColor = {
    new: 'badge-status-new',
    pending: 'badge-status-pending',
    waiting: 'badge-status-pending',
    running: 'badge-status-running',
    successful: 'badge-status-successful',
    failed: 'badge-status-failed',
    error: 'badge-status-error',
    canceled: 'badge-status-canceled',
  }[jobStatus.status]

  return (
    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-muted/10">
      <span className={`badge text-xs ${statusColor}`}>
        {jobStatus.status === 'running' && '⟳ '}
        {jobStatus.status.charAt(0).toUpperCase() + jobStatus.status.slice(1)}
      </span>
      <span className="text-xs text-muted">
        job #{jobStatus.job_id} • {jobStatus.elapsed.toFixed(1)}s
      </span>
    </div>
  )
}

function JobMonitor({ workflowName, jobId, onComplete }: { workflowName: string; jobId: number; onComplete: () => void }) {
  const { data: jobStatus } = useWorkflowJobStatus(jobId)

  const isTerminal = jobStatus ? ['successful', 'failed', 'error', 'canceled'].includes(jobStatus.status) : false

  useEffect(() => {
    if (!isTerminal) return
    
    const timer = setTimeout(() => onComplete(), 2000)
    return () => clearTimeout(timer)
  }, [isTerminal, onComplete])

  if (!jobStatus) return null

  const statusColor = {
    new: 'badge-status-new',
    pending: 'badge-status-pending',
    waiting: 'badge-status-pending',
    running: 'badge-status-running',
    successful: 'badge-status-successful',
    failed: 'badge-status-failed',
    error: 'badge-status-error',
    canceled: 'badge-status-canceled',
  }[jobStatus.status]

  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="font-semibold">{workflowName}</div>
        <div className="text-sm text-muted">job #{jobId}</div>
      </div>
      <div className="flex items-center gap-3">
        <span className={`badge text-xs ${statusColor}`}>
          {jobStatus.status === 'running' && '⟳ '}
          {jobStatus.status.charAt(0).toUpperCase() + jobStatus.status.slice(1)}
        </span>
        <span className="text-xs text-muted w-16 text-right">{jobStatus.elapsed.toFixed(1)}s</span>
      </div>
    </div>
  )
}
