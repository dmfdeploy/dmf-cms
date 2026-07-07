import { Fragment, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import ReasonConfirm from '../../components/ReasonConfirm'
import { useActivityStore } from '../../store/activity'
import {
  useAppContract,
  useCurrentUser,
  useAdminHealth,
  useAdminUsers,
  useAdminJobs,
  useWorkflows,
  useLaunchWorkflow,
  useCreatePasskeyInvitation,
  isOperation,
} from '../../api/hooks'
import type { AdminUser } from '../../api/types'

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const statusColor: Record<string, string> = {
  new: 'badge-status-new',
  pending: 'badge-status-pending',
  waiting: 'badge-status-pending',
  running: 'badge-status-running',
  successful: 'badge-status-successful',
  failed: 'badge-status-failed',
  error: 'badge-status-error',
  canceled: 'badge-status-canceled',
}

const roleBadgeStyles: Record<string, string> = {
  viewer: 'bg-blue-900/40 text-blue-300',
  operator: 'bg-green-900/40 text-green-300',
  engineer: 'bg-purple-900/40 text-purple-300',
  admin: 'bg-indigo-900/40 text-indigo-300',
}

// Admin default panels on the Workspace home (IA §4.1 role-varied content;
// moved from the retired pages/overview/AdminOverview.tsx, #174 WP4). The
// Workspace page owns the hero and the scroll container.
export default function AdminPanels() {
  const { data: user } = useCurrentUser()
  const { data: contract } = useAppContract()
  const { data: healthData, isLoading: healthLoading } = useAdminHealth()
  const { data: usersData, isLoading: usersLoading } = useAdminUsers()
  const { data: jobsData, isLoading: jobsLoading } = useAdminJobs()
  const { data: workflowsData } = useWorkflows()
  const launchMutation = useLaunchWorkflow()
  const inviteMutation = useCreatePasskeyInvitation()
  const recordAwxWrite = useActivityStore((s) => s.recordAwxWrite)
  const [showQR, setShowQR] = useState(false)
  const [inviteResult, setInviteResult] = useState<any>(null)
  const [activeJobs, setActiveJobs] = useState<{ workflowName: string; jobId: number }[]>([])
  // Which template's Launch is armed (reason panel open). AWX launch is
  // operator-gated + reason-required (#185 WP-E), so the quick-launch arms too.
  const [launchArming, setLaunchArming] = useState<string | null>(null)

  if (!contract || !user) {
    return <div className="animate-pulse text-muted">Loading...</div>
  }

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
        outcome: isOperation(result) ? 'dispatched' : (result.status ?? 'launched'),
      })
      // result is WorkflowLaunchResponse | Operation; the async (202/waking)
      // path has a null job_id until the job is actually launched. Only track
      // it here once it has a real id (the Workflows page owns the full
      // operation-status UX).
      if (result.job_id != null) {
        setActiveJobs([...activeJobs, { workflowName, jobId: result.job_id }])
      }
    } catch (error) {
      console.error('Failed to launch workflow:', error)
    }
  }

  const handleInviteClick = async () => {
    try {
      const result = await inviteMutation.mutateAsync()
      setInviteResult(result)
      setShowQR(true)
    } catch (error) {
      console.error('Failed to create invitation:', error)
    }
  }

  return (
    <div>
      {/* Integration Status Panel */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-text mb-4">Integration Status</h2>
        {healthLoading ? (
          <div className="panel p-4">
            <div className="animate-pulse text-muted">Loading integration status...</div>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-4">
            {healthData && (
              <>
                <IntegrationStatusCard
                  name="Authentik"
                  status={healthData.authentik}
                />
                <IntegrationStatusCard
                  name="AWX"
                  status={healthData.awx}
                />
                <IntegrationStatusCard
                  name="NetBox"
                  status={healthData.netbox}
                />
                <IntegrationStatusCard
                  name="Prometheus"
                  status={healthData.prometheus}
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* User Management Panel */}
      <div className="mb-8">
        <div className="panel">
          <div className="panel-header justify-between">
            <div>
              <h2 className="font-bold text-text">Users</h2>
              <p className="panel-subtitle mt-1">Manage DMF Console access and roles</p>
            </div>
            <button
              onClick={handleInviteClick}
              disabled={inviteMutation.isPending}
              className="btn btn-primary btn-sm"
            >
              {inviteMutation.isPending ? '...' : '+ Invite new user'}
            </button>
          </div>

          {showQR && inviteResult && (
            <div className="bg-bg/50 border-b border-border p-4">
              <div className="flex justify-center p-4 bg-panel border border-border rounded inline-block">
                <QRCodeSVG value={inviteResult.enrollment_url} size={180} level="M" />
              </div>
              <div className="mt-4">
                <p className="text-sm text-muted mb-2">Or copy the enrollment URL:</p>
                <input
                  type="text"
                  value={inviteResult.enrollment_url}
                  readOnly
                  className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text font-mono"
                />
                <p className="text-xs text-muted mt-2">
                  Expires: {new Date(inviteResult.expires).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => setShowQR(false)}
                className="btn btn-secondary btn-sm mt-4"
              >
                Close
              </button>
            </div>
          )}

          {usersLoading ? (
            <div className="p-4">
              <div className="animate-pulse text-muted">Loading users...</div>
            </div>
          ) : !usersData?.users || usersData.users.length === 0 ? (
            <div className="p-4 text-center text-muted text-sm">
              No users found — Authentik not configured
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Email</th>
                    <th>Last Login</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {usersData.users.map((u: AdminUser) => (
                    <tr key={u.username}>
                      <td className="font-medium text-text">{u.display_name}</td>
                      <td>
                        <span
                          className={`text-xs badge px-2 py-1 rounded ${
                            roleBadgeStyles[u.role] || 'bg-gray-900/40 text-gray-300'
                          }`}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="text-sm text-muted">{u.email}</td>
                      <td className="text-sm text-muted">{relativeTime(u.last_login)}</td>
                      <td>
                        <span
                          className={`text-xs ${
                            u.is_active ? 'text-accent-green' : 'text-fault'
                          }`}
                        >
                          {u.is_active ? '✓ Active' : '— Inactive'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Workflows Panel */}
      <div className="mb-8">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2 className="font-bold text-text">Workflows</h2>
              <p className="panel-subtitle mt-1">Available templates and recent job history</p>
            </div>
          </div>

          {!user.awx_configured ? (
            <div className="p-4 text-center text-muted text-sm">
              AWX API not configured
            </div>
          ) : (
            <>
              {/* Available Workflows */}
              <div className="border-b border-border">
                <div className="px-4 py-3 bg-bg/30">
                  <h3 className="text-sm font-semibold text-text">Available Templates</h3>
                </div>
                {!workflowsData?.templates || workflowsData.templates.length === 0 ? (
                  <div className="p-4 text-center text-muted text-sm">
                    No workflows available
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="data-table w-full">
                      <thead>
                        <tr>
                          <th>Template</th>
                          <th>Description</th>
                          <th className="text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workflowsData.templates.map((template: any) => (
                          <Fragment key={template.id}>
                            <tr>
                              <td className="font-medium text-text">{template.name}</td>
                              <td className="text-sm text-muted">{template.description}</td>
                              <td className="text-right">
                                <button
                                  onClick={() => setLaunchArming(template.name)}
                                  disabled={launchMutation.isPending || launchArming !== null || activeJobs.some(j => j.workflowName === template.name)}
                                  className="btn btn-primary btn-sm"
                                >
                                  {activeJobs.some(j => j.workflowName === template.name)
                                    ? '⟳ Running'
                                    : '▶ Launch'}
                                </button>
                              </td>
                            </tr>
                            {launchArming === template.name && (
                              <tr>
                                <td colSpan={3} className="py-2">
                                  <ReasonConfirm
                                    title={`Launch ${template.name}?`}
                                    description="Runs this AWX workflow. The action is operator-gated and recorded in the audit trail with your reason."
                                    confirmLabel="Confirm launch"
                                    pendingLabel="Launching…"
                                    pending={launchMutation.isPending && launchMutation.variables?.workflowName === template.name}
                                    error={launchMutation.variables?.workflowName === template.name ? launchMutation.error : null}
                                    onConfirm={(reason) => { void handleLaunch(template.name, reason); setLaunchArming(null) }}
                                    onCancel={() => setLaunchArming(null)}
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Recent Jobs */}
              <div>
                <div className="px-4 py-3 bg-bg/30">
                  <h3 className="text-sm font-semibold text-text">Recent Jobs</h3>
                </div>
                {jobsLoading ? (
                  <div className="p-4">
                    <div className="animate-pulse text-muted text-sm">Loading jobs...</div>
                  </div>
                ) : !jobsData?.jobs || jobsData.jobs.length === 0 ? (
                  <div className="p-4 text-center text-muted text-sm">
                    No jobs have run yet
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="data-table w-full">
                      <thead>
                        <tr>
                          <th>Job</th>
                          <th>Status</th>
                          <th>Started</th>
                          <th className="text-right">Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobsData.jobs.map((job: any) => (
                          <tr key={job.id}>
                            <td className="font-medium text-text">{job.name}</td>
                            <td>
                              <span className={`badge text-xs ${statusColor[job.status] || 'badge-status-pending'}`}>
                                {job.status === 'running' && '⟳ '}
                                {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                              </span>
                            </td>
                            <td className="text-sm text-muted">{relativeTime(job.started)}</td>
                            <td className="text-right text-sm text-muted">{job.elapsed.toFixed(1)}s</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Infrastructure Services */}
      <div className="mb-8">
        <div className="panel">
          <div className="p-4 border-b border-border">
            <h2 className="font-bold text-text mb-1">Infrastructure Services</h2>
            <p className="text-xs text-muted mt-1">
              These platform services underpin DMF Console. Media Workloads and Functions will be managed via NetBox and AWX in Release 1.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Lane</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {contract.apps.map((app) => (
                  <tr key={app.key}>
                    <td className="font-medium text-text">{app.display_name}</td>
                    <td>
                      <span
                        className={`text-xs badge ${
                          app.lane === 'public' ? 'bg-accent/20 text-accent' : 'bg-warning/20 text-warning'
                        }`}
                      >
                        {app.lane}
                      </span>
                    </td>
                    <td>
                      {app.links.length > 0 ? (
                        <a
                          href={app.links[0].url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-accent-blue hover:underline"
                        >
                          Open →
                        </a>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function IntegrationStatusCard({
  name,
  status,
}: {
  name: string
  status: any
}) {
  const statusDot = status.connected ? 'status-dot-ok' : status.note ? 'status-dot-warn' : 'status-dot-fault'

  return (
    <div className="card flex flex-col">
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold text-text text-sm">{name}</h3>
        <span className={`status-dot ${statusDot}`}></span>
      </div>
      {status.connected ? (
        <>
          <p className="text-xs text-muted flex-1">Connected</p>
          {status.latency_ms !== undefined && (
            <p className="text-xs text-accent-green mt-2">{status.latency_ms}ms</p>
          )}
          {status.user_count !== undefined && (
            <p className="text-xs text-accent-green mt-2">{status.user_count} users</p>
          )}
          {status.template_count !== undefined && (
            <p className="text-xs text-accent-green mt-2">{status.template_count} templates</p>
          )}
        </>
      ) : (
        <>
          <p className="text-xs flex-1">
            {status.note ? (
              <span className="text-warning">{status.note}</span>
            ) : (
              <span className="text-fault">{status.error || 'Disconnected'}</span>
            )}
          </p>
        </>
      )}
    </div>
  )
}
