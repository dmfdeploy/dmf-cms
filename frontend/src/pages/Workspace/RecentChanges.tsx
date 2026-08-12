import { useChangesJobs } from '../../api/hooks'
import { describeJob, jobOutcome } from '../../lib/labels'
import { classifyChanges, changesEmptyCopy } from '../../lib/changesState'

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
//
// No "Open Activity → History" link (umbrella #339 item 3). The S1 cut took
// Activity out of the nav; a header link is that page advertising itself
// again, which is the inconsistency, not the fix. The route stays registered
// and URL-reachable — only the advertisement is gone.
export default function RecentChanges() {
  const jobs = useChangesJobs()
  // Shared classifier — the Activity → History jobs lane reads the same
  // states from the same tokens (Art. 1: the two must never disagree).
  const state = classifyChanges(jobs)
  const recent = state.jobs.slice(0, 5)

  return (
    <div className="panel mb-6">
      <div className="px-6 py-4 border-b border-panel">
        <h2 className="text-lg font-semibold">Recent changes</h2>
      </div>
      <div className="divide-y divide-panel">
        {state.phase === 'loading' ? (
          <div className="px-6 py-6 text-center text-muted text-sm">Loading recent changes…</div>
        ) : (
          <>
            {/* fix-round 4 (PR #81, codex sibling sweep): a settled failed
                refetch ('error' phase) retains TanStack Query's last-good
                `jobs` — the length===0 branch below never fires when rows
                are retained, so this pinned Workspace widget used to render
                them with no notice at all, presenting last-good data as
                current after the poll that would have confirmed it had
                failed. Same fix as the Activity → History Jobs panel this
                widget shares its classifier with (Art. 1: the two states
                must never disagree, so neither may drift on this either). */}
            {state.phase === 'error' && (
              <div className="px-6 py-2 text-xs text-amber-300 bg-amber-500/10">
                {changesEmptyCopy('error')}
              </div>
            )}
            {recent.length === 0 ? (
              // Every empty state is designed and names its own cause (Art. 8).
              // A not-running AWX is not a console fault and must not read as
              // one, and it must not read as "nothing happened" either.
              state.phase !== 'error' && (
                <div className="px-6 py-6 text-center text-muted text-sm">
                  {changesEmptyCopy(state.phase)}
                </div>
              )
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
          </>
        )}
      </div>
    </div>
  )
}
