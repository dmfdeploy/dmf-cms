import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { useCurrentUser } from './api/hooks'
import { useAuthStore } from './store/auth'
import Shell from './components/Shell'
import ProtectedRoute from './components/ProtectedRoute'
import Workspace from './pages/Workspace'
import Facility from './pages/Facility'
import FacilityDetail from './pages/Facility/Detail'
import WorkloadHome from './pages/MediaWorkloads/WorkloadHome'
import WorkloadSetup from './pages/MediaWorkloads/WorkloadSetup'
import CreateWorkload from './pages/MediaWorkloads/CreateWorkload'
import { workloadHomePath } from './lib/routes'
import Activity from './pages/Activity'
import Monitoring from './pages/Monitoring'
import MediaWorkloads from './pages/MediaWorkloads'
import Catalog from './pages/Catalog'
import Admin from './pages/Admin'
import Settings from './pages/Settings'
import { isDevHarnessRoute, isGhostGridHarnessRoute } from './pages/Dev/devHarnessRoute'
import LifecycleRailHarness from './pages/Dev/LifecycleRailHarness'
import GhostGridHarness from './pages/Dev/GhostGridHarness'

export default function App() {
  // dmf-cms#391: checked ahead of every auth-derived branch below,
  // including the redirect effect — see devHarnessRoute.ts's own docstring
  // for why this must be a bypass, not just another <Route> inside the
  // (auth-gated) production route table below.
  const location = useLocation()
  const devHarness = isDevHarnessRoute(location.pathname)
  // dmfdeploy/dmfdeploy#498 — the ghost-grid harness, same bypass shape.
  const ghostGridHarness = isGhostGridHarnessRoute(location.pathname)
  const anyHarness = devHarness || ghostGridHarness

  // FIX ROUND (dmf-cms#391, codex gate — D): `enabled: !devHarness` makes
  // the dev-harness route genuinely fire zero network calls, rather than
  // firing an unstubbed /api/me it never reads the result of and merely
  // hoping that's harmless. See useCurrentUser's own docstring for why this
  // is safe to add (additive, defaults to enabled, and this is the only
  // mounted instance on this particular route). Widened to `!anyHarness`
  // for #498 — the SAME zero-network-call contract applies to the
  // ghost-grid harness, for the same reason (its own specimens stub
  // `window.fetch` themselves; App.tsx's own /api/me call must not race
  // ahead of that stub).
  const { data: user, isLoading: userLoading, isError } = useCurrentUser(!anyHarness)
  const { setUser, setLoading } = useAuthStore()

  useEffect(() => {
    if (anyHarness) return
    if (userLoading) {
      setLoading(true)
    } else if (user) {
      setUser(user)
    } else if (isError) {
      // Not authenticated, redirect to login
      window.location.href = '/auth/login'
    }
  }, [anyHarness, user, userLoading, isError, setUser, setLoading])

  if (devHarness) {
    return <LifecycleRailHarness />
  }

  if (ghostGridHarness) {
    return <GhostGridHarness />
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
        {/* dmfdeploy#414 — THE ROUTE CONTRACT (operator ruling: "the bare
            workload URL is the workload's home"). Supersedes the Arc B
            contract this block used to carry (bare slug = the guided flow;
            Operate on its own `/operate` route) — see
            `docs/design/DMF Console Glossary.md`'s wording-pass log and the
            Arc 4 plan's own superseded-record note for where that's
            recorded.
              /media-workloads/:slug          -> WorkloadHome (the live view)
              /media-workloads/:slug/setup    -> WorkloadSetup (the guided flow)
              /media-workloads/:slug/operate  -> compatibility redirect, below
            lib/routes.ts's workloadHomePath/workloadSetupPath are the ONLY
            sanctioned way to construct either path from a slug elsewhere in
            this app (dmfdeploy#414 H3) — a route pattern here is the one
            place a literal path STRING is allowed to exist at all. */}
        <Route path="/media-workloads/:slug" element={<ProtectedRoute><WorkloadHome /></ProtectedRoute>} />
        <Route path="/media-workloads/:slug/setup" element={<ProtectedRoute><WorkloadSetup /></ProtectedRoute>} />
        {/* dmfdeploy#414 H2/migration: the old `/operate` URL stays reachable
            so older bookmarks and runbook copies fail gracefully, but it
            must not remain a second live implementation — it is nothing but
            a redirect to home, `replace` so the alias never enters browser
            history (a back button press from home must not bounce the
            operator forward onto this URL again — see OperateRedirect's own
            docstring and the alias's history-behaviour test). */}
        <Route
          path="/media-workloads/:slug/operate"
          element={<ProtectedRoute><OperateRedirect /></ProtectedRoute>}
        />
        <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

/**
 * The compatibility alias for the retired `/operate` route (dmfdeploy#414).
 * A plain, unconditional redirect to home — it reads no workload state and
 * makes no decision, unlike WorkloadHome's own cold-entry classification,
 * because a URL-shape alias is not a place to guess at anything: the
 * destination route (WorkloadHome) is what decides live/setup-cold-entry/
 * unresolved, exactly as it would for any other visit to the bare slug.
 * `replace`, not a plain push: an alias that pushed a new history entry
 * would let the browser's own back button return the operator TO the alias
 * URL, which would immediately redirect them forward again — a bounce loop
 * the whole point of `replace` is to rule out (pinned in
 * railRouteContract.test.tsx's compatibility-alias history test).
 */
function OperateRedirect() {
  const { slug } = useParams<{ slug: string }>()
  return <Navigate to={workloadHomePath(slug ?? '')} replace />
}
