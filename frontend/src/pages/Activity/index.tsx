import { Navigate, NavLink, useParams } from 'react-router-dom'
import { useCurrentUser } from '../../api/hooks'
import { settleQuery } from '../../lib/queryState'
import JobsLane from './JobsLane'
import HistoryLane from './HistoryLane'
import PageHeading from '../../components/PageHeading'
import { usePageTitle } from '../../hooks/usePageTitle'

const LANE_TITLE: Record<'jobs' | 'history', string> = {
  jobs: 'Activity — Jobs',
  history: 'Activity — History',
}

// Activity — one rail, two distinct lanes (IA 2026-06-23 §5, #174 WP3).
// The merge condition is binding: Jobs ("what is running / launchable")
// and History ("what just changed") stay separate subviews; a single
// undifferentiated stream is not acceptable. Viewer gets History only
// (IA §7 matrix) — cosmetic here, the backend gates every action.
export default function Activity() {
  const { lane } = useParams()
  // fix-round 6 (PR #81, umbrella #385 codex sweep): `user` was `undefined`
  // on the FIRST render of every direct load of /activity/jobs, not just on
  // a failed read — `canUseJobs` defaulted to false before the role was
  // ever confirmed, so the very first render below fired a REPLACE redirect
  // to /activity/history that a genuine non-viewer could not come back from
  // even once their role resolved a moment later. Decide nothing until the
  // read has settled.
  const { data: user, loading: userLoading, failed: userFailed } = settleQuery(useCurrentUser())
  const role = user?.role ?? 'viewer'
  const canUseJobs = !userLoading && role !== 'viewer'
  // Called ahead of every early return/redirect below (hooks are
  // unconditional): on the render that is about to redirect, `lane` is not
  // yet a valid lane, so this briefly falls back to the bare 'Activity'
  // title until the redirect lands and re-renders with a real lane.
  usePageTitle(lane === 'jobs' || lane === 'history' ? LANE_TITLE[lane] : 'Activity')

  if (userLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6 text-sm text-muted">
        {/* WP-4 stage 2 rebase audit (umbrella #385 finding 5): this branch
            had no h1 — same gap class fixed on this page's siblings. */}
        <PageHeading>{lane === 'jobs' || lane === 'history' ? LANE_TITLE[lane] : 'Activity'}</PageHeading>
        Loading…
      </div>
    )
  }

  if (!lane) {
    return <Navigate to={canUseJobs ? '/activity/jobs' : '/activity/history'} replace />
  }
  if (lane !== 'jobs' && lane !== 'history') {
    return <Navigate to="/activity" replace />
  }
  if (lane === 'jobs' && !canUseJobs) {
    // A settled read that genuinely failed with no role ever retained is
    // NOT the same as a confirmed viewer — say so and offer a way forward
    // (Art. 8) instead of silently bouncing a possible non-viewer away with
    // no explanation and no way back.
    if (userFailed && !user) {
      return (
        <div className="flex-1 overflow-y-auto p-6 text-sm text-muted">
          <PageHeading>{LANE_TITLE.jobs}</PageHeading>
          Could not confirm your role, so the Jobs lane can&apos;t be shown right now.{' '}
          <NavLink to="/activity/history" className="text-accent underline">
            Go to History
          </NavLink>{' '}
          or reload the page to try again.
        </div>
      )
    }
    return <Navigate to="/activity/history" replace />
  }

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 rounded text-sm font-medium transition-colors ${
      isActive ? 'bg-accent/20 text-accent' : 'text-muted hover:text-text hover:bg-panel/50'
    }`

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeading>{LANE_TITLE[lane]}</PageHeading>
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
