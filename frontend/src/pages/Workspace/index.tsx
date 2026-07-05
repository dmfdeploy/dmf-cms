import { useCurrentUser } from '../../api/hooks'
import AdminPanels from './AdminPanels'

// Workspace — the single role-aware home (IA 2026-06-23 §4.1). Content varies
// by role within this one page; there is no per-role page fork. The pinned
// "are we OK?" core (severity tiles + Current Problems) lands with #174 WP2
// and will sit above the role content on every variant.
export default function Workspace() {
  const { data: user } = useCurrentUser()
  const role = user?.role ?? 'viewer'

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Facility Operations</p>
        <h1>Workspace</h1>
        <p>Facility health, recent changes, and what needs attention.</p>
      </div>
      {role === 'admin' ? (
        <AdminPanels />
      ) : (
        <div className="panel text-center py-12">
          <p className="text-muted text-sm">
            The facility health summary is not available yet.
          </p>
          <p className="text-xs text-muted mt-2">
            Use Facilities, Media Workloads, and Monitoring in the sidebar for
            live status.
          </p>
        </div>
      )}
    </div>
  )
}
