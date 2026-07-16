import { Link } from 'react-router-dom'
import { useChangesJobs } from '../../api/hooks'
import { describeJob, jobOutcome } from '../../lib/labels'

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

// Pinned "what just changed" widget (IA §4.1, #174 WP2): a read of the
// same server-side history the Activity → History lane shows, so the
// Workspace answers the third North-Star question without a hunt.
export default function RecentChanges() {
  const jobs = useChangesJobs()
  const recent = (jobs.data?.jobs ?? []).slice(0, 5)

  return (
    <div className="panel mb-6">
      <div className="px-6 py-4 border-b border-panel flex items-center justify-between">
        <h2 className="text-lg font-semibold">Recent changes</h2>
        <Link to="/activity/history" className="text-xs text-accent-blue hover:underline">
          Open Activity → History
        </Link>
      </div>
      <div className="divide-y divide-panel">
        {jobs.isLoading ? (
          <div className="px-6 py-6 text-center text-muted text-sm">Loading recent changes…</div>
        ) : jobs.isError ? (
          <div className="px-6 py-6 text-center text-muted text-sm">
            Recent changes are temporarily unavailable. Retrying automatically.
          </div>
        ) : recent.length === 0 ? (
          <div className="px-6 py-6 text-center text-muted text-sm">No recent changes recorded</div>
        ) : (
          recent.map((job) => (
            <div key={job.id} className="px-6 py-3 flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                {/* Operator language at default (Art. 3/8): "what changed" +
                    plain outcome. The raw AWX template name is system jargon —
                    demoted to a muted secondary line, not the headline. */}
                <p className="text-sm font-medium truncate">{describeJob(job.name)}</p>
                <p className="text-xs text-muted/70 truncate">{job.name}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0 text-xs text-muted">
                <span className={`badge text-xs ${statusColor[job.status] || 'badge-status-pending'}`}>
                  {jobOutcome(job.status)}
                </span>
                {job.started && <span>{new Date(job.started).toLocaleString()}</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
