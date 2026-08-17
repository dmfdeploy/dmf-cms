import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useCurrentUser } from './api/hooks'
import { useAuthStore } from './store/auth'
import Shell from './components/Shell'
import ProtectedRoute from './components/ProtectedRoute'
import Workspace from './pages/Workspace'
import Facility from './pages/Facility'
import FacilityDetail from './pages/Facility/Detail'
import WorkloadDetail from './pages/MediaWorkloads/WorkloadDetail'
import WorkloadOperate from './pages/MediaWorkloads/Operate'
import CreateWorkload from './pages/MediaWorkloads/CreateWorkload'
import Activity from './pages/Activity'
import Monitoring from './pages/Monitoring'
import MediaWorkloads from './pages/MediaWorkloads'
import Catalog from './pages/Catalog'
import Admin from './pages/Admin'
import Settings from './pages/Settings'
import { isDevHarnessRoute } from './pages/Dev/devHarnessRoute'
import LifecycleRailHarness from './pages/Dev/LifecycleRailHarness'

export default function App() {
  // dmf-cms#391: checked ahead of every auth-derived branch below,
  // including the redirect effect — see devHarnessRoute.ts's own docstring
  // for why this must be a bypass, not just another <Route> inside the
  // (auth-gated) production route table below.
  const location = useLocation()
  const devHarness = isDevHarnessRoute(location.pathname)

  // FIX ROUND (dmf-cms#391, codex gate — D): `enabled: !devHarness` makes
  // the dev-harness route genuinely fire zero network calls, rather than
  // firing an unstubbed /api/me it never reads the result of and merely
  // hoping that's harmless. See useCurrentUser's own docstring for why this
  // is safe to add (additive, defaults to enabled, and this is the only
  // mounted instance on this particular route).
  const { data: user, isLoading: userLoading, isError } = useCurrentUser(!devHarness)
  const { setUser, setLoading } = useAuthStore()

  useEffect(() => {
    if (devHarness) return
    if (userLoading) {
      setLoading(true)
    } else if (user) {
      setUser(user)
    } else if (isError) {
      // Not authenticated, redirect to login
      window.location.href = '/auth/login'
    }
  }, [devHarness, user, userLoading, isError, setUser, setLoading])

  if (devHarness) {
    return <LifecycleRailHarness />
  }

  if (userLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-accent mb-2">DMF Console</h1>
          <p className="text-muted">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-accent mb-2">DMF Console</h1>
          <p className="text-muted">Redirecting to login...</p>
        </div>
      </div>
    )
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<ProtectedRoute><Workspace /></ProtectedRoute>} />
        {/* IA §9 (#174 WP1): Facilities rail; permanent redirect keeps old
            /facility bookmarks working. */}
        <Route path="/facilities" element={<ProtectedRoute><Facility /></ProtectedRoute>} />
        {/* S1 (#285): the list is one entry for the current facility; the
            detail page is where node/service/capacity truth now lives. */}
        <Route path="/facilities/:site" element={<ProtectedRoute><FacilityDetail /></ProtectedRoute>} />
        <Route path="/facility" element={<Navigate to="/facilities" replace />} />
        {/* WP3 (#174): Workflows + Changes merged into Activity, two lanes. */}
        <Route path="/activity/:lane?" element={<ProtectedRoute><Activity /></ProtectedRoute>} />
        <Route path="/workflows" element={<Navigate to="/activity/jobs" replace />} />
        <Route path="/changes" element={<Navigate to="/activity/history" replace />} />
        <Route path="/catalog" element={<ProtectedRoute><Catalog /></ProtectedRoute>} />
        <Route path="/monitoring" element={<ProtectedRoute><Monitoring /></ProtectedRoute>} />
        {/* WP4 (#173): MXL Flows retired into the Media Workloads live-view panel. */}
        <Route path="/mxl-flows" element={<Navigate to="/media-workloads" replace />} />
        <Route path="/media-workloads" element={<ProtectedRoute><MediaWorkloads /></ProtectedRoute>} />
        {/* Arc B (#285): creating a workload. Declared before the :slug route
            for readability only — react-router v6 ranks a static segment above
            a dynamic one regardless of order, so "new" can never be swallowed
            as a slug. */}
        <Route path="/media-workloads/new" element={<ProtectedRoute><CreateWorkload /></ProtectedRoute>} />
        {/* Arc B (#285): the workload surface is the guided sequential flow —
            the five orchestration stages, gated, under the regrouped
            vocabulary strip (five flow stages + Operate under its Control
            label). Catalog and Activity content relocated here in S1. */}
        <Route path="/media-workloads/:slug" element={<ProtectedRoute><WorkloadDetail /></ProtectedRoute>} />
        {/* Arc B (#285): Operate left the flow page entirely (operator
            direction 2026-08-01). It sits in the Control vertical (operator
            ruling 2026-08-02), not the orchestration flow; its surface is
            monitoring, so it gets its own route rather than a step. */}
        <Route path="/media-workloads/:slug/operate" element={<ProtectedRoute><WorkloadOperate /></ProtectedRoute>} />
        <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
