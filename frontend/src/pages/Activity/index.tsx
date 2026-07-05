import { Navigate, NavLink, useParams } from 'react-router-dom'
import { useCurrentUser } from '../../api/hooks'
import JobsLane from './JobsLane'
import HistoryLane from './HistoryLane'

// Activity — one rail, two distinct lanes (IA 2026-06-23 §5, #174 WP3).
// The merge condition is binding: Jobs ("what is running / launchable")
// and History ("what just changed") stay separate subviews; a single
// undifferentiated stream is not acceptable. Viewer gets History only
// (IA §7 matrix) — cosmetic here, the backend gates every action.
export default function Activity() {
  const { lane } = useParams()
  const { data: user } = useCurrentUser()
  const role = user?.role ?? 'viewer'
  const canUseJobs = role !== 'viewer'

  if (!lane) {
    return <Navigate to={canUseJobs ? '/activity/jobs' : '/activity/history'} replace />
  }
  if (lane !== 'jobs' && lane !== 'history') {
    return <Navigate to="/activity" replace />
  }
  if (lane === 'jobs' && !canUseJobs) {
    return <Navigate to="/activity/history" replace />
  }

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 rounded text-sm font-medium transition-colors ${
      isActive ? 'bg-accent/20 text-accent' : 'text-muted hover:text-text hover:bg-panel/50'
    }`

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <div className="hero-copy">
          <p className="kicker">Operations</p>
          <h1>Activity</h1>
          <p>What is running or launchable, and what just changed.</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-6">
        {canUseJobs && (
          <NavLink to="/activity/jobs" className={tabClass}>
            Jobs
          </NavLink>
        )}
        <NavLink to="/activity/history" className={tabClass}>
          History
        </NavLink>
      </div>

      {lane === 'jobs' ? <JobsLane /> : <HistoryLane />}
    </div>
  )
}
