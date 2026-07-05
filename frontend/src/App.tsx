import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useCurrentUser } from './api/hooks'
import { useAuthStore } from './store/auth'
import Shell from './components/Shell'
import ProtectedRoute from './components/ProtectedRoute'
import Workspace from './pages/Workspace'
import Facility from './pages/Facility'
import Activity from './pages/Activity'
import Monitoring from './pages/Monitoring'
import MediaWorkloads from './pages/MediaWorkloads'
import Catalog from './pages/Catalog'
import Admin from './pages/Admin'
import Settings from './pages/Settings'

export default function App() {
  const { data: user, isLoading: userLoading, isError } = useCurrentUser()
  const { setUser, setLoading } = useAuthStore()

  useEffect(() => {
    if (userLoading) {
      setLoading(true)
    } else if (user) {
      setUser(user)
    } else if (isError) {
      // Not authenticated, redirect to login
      window.location.href = '/auth/login'
    }
  }, [user, userLoading, isError, setUser, setLoading])

  if (userLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-accent mb-2">dmfdeploy</h1>
          <p className="text-muted">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-accent mb-2">dmfdeploy</h1>
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
        <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
