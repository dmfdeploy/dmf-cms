import { useState } from 'react'
import { useWorkflows, useLaunchWorkflow, useWorkflowJobStatus, useCurrentUser } from '../api/hooks'

interface ActiveJob {
  workflowName: string
  jobId: number
}

export default function Workflows() {
  const { data: user } = useCurrentUser()
  const { data: workflowsData, isLoading } = useWorkflows()
  const launchMutation = useLaunchWorkflow()
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([])

  const handleLaunch = async (workflowName: string) => {
    try {
      const result = await launchMutation.mutateAsync(workflowName)
      setActiveJobs([...activeJobs, { workflowName, jobId: result.job_id }])
    } catch (error) {
      console.error('Failed to launch workflow:', error)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Hero */}
      <div className="hero">
        <div className="hero-copy">
          <p className="kicker">Workflow</p>
          <h1>Workflows</h1>
          <p>
            {user?.awx_configured
              ? 'Launch and monitor approved AWX workflows'
              : 'AWX integration not configured in this environment'}
          </p>
        </div>
      </div>

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
                onLaunch={() => handleLaunch(template.name)}
                isLaunching={launchMutation.isPending}
                activeJob={activeJobs.find((j) => j.workflowName === template.name)}
                onJobComplete={(jobId) => {
                  setActiveJobs(activeJobs.filter((j) => j.jobId !== jobId))
                }}
              />
            ))}
          </div>

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
    setActiveJobs(activeJobs.filter((j) => j.jobId !== jobId))
  }
}

function WorkflowCard({
  template,
  onLaunch,
  isLaunching,
  activeJob,
  onJobComplete,
}: {
  template: any
  onLaunch: () => void
  isLaunching: boolean
  activeJob?: { workflowName: string; jobId: number }
  onJobComplete: (jobId: number) => void
}) {
  return (
    <div className="panel flex items-start justify-between">
      <div className="flex-1">
        <h3 className="text-lg font-semibold mb-1">{template.name}</h3>
        <p className="text-sm text-muted">{template.description}</p>
        {activeJob && (
          <JobStatus jobId={activeJob.jobId} onComplete={() => onJobComplete(activeJob.jobId)} />
        )}
      </div>
      <button
        onClick={onLaunch}
        disabled={isLaunching || !!activeJob}
        className="btn btn-primary btn-sm ml-4"
      >
        {activeJob ? '⏳ Running...' : '▶ Launch'}
      </button>
    </div>
  )
}

function JobStatus({ jobId, onComplete }: { jobId: number; onComplete: () => void }) {
  const { data: jobStatus } = useWorkflowJobStatus(jobId)

  if (!jobStatus) return null

  const isTerminal = ['successful', 'failed', 'error', 'canceled'].includes(jobStatus.status)

  if (isTerminal) {
    setTimeout(() => onComplete(), 2000)
  }

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

  if (!jobStatus) return null

  const isTerminal = ['successful', 'failed', 'error', 'canceled'].includes(jobStatus.status)

  if (isTerminal) {
    setTimeout(() => onComplete(), 2000)
  }

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
