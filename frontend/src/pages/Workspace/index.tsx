import { useCurrentUser } from '../../api/hooks'
import AdminPanels from './AdminPanels'
import HealthCore from './HealthCore'
import RecentChanges from './RecentChanges'

// Workspace — the single role-aware home (IA 2026-06-23 §4.1). The pinned
// core (HealthCore + RecentChanges) is non-removable and identical for
// every role: "is the facility healthy, what just changed, what do I need
// to do" is always answered first. Role varies only the content below it;
// there is no per-role page fork.
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
      <HealthCore />
      <RecentChanges />
      {role === 'admin' && <AdminPanels />}
    </div>
  )
}
