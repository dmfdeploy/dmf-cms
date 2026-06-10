import { useAdminUsers, useAdminGroups, useAdminHealth } from '@/api/hooks'
import { Users, Activity } from 'lucide-react'

export default function Admin() {
  const users = useAdminUsers()
  const groups = useAdminGroups()
  const health = useAdminHealth()

  const isLoading = users.isLoading || groups.isLoading || health.isLoading

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <div className="hero-copy">
          <p className="kicker">Platform</p>
          <h1>Admin</h1>
          <p>User management and integration health status.</p>
        </div>
      </div>

      {/* Integration Health */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-500" />
            Integration Status
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-6">
          {isLoading ? (
            <div className="col-span-full text-center text-muted text-sm">Loading status...</div>
          ) : health.data ? (
            Object.entries(health.data).map(([service, status]: [string, any]) => (
              <div key={service} className="border border-panel rounded p-4">
                <h3 className="font-semibold text-sm mb-2 capitalize">{service}</h3>
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${status.connected ? 'bg-green-500' : 'bg-red-500'}`}></span>
                    <span className="text-muted">{status.connected ? 'Connected' : 'Disconnected'}</span>
                  </div>
                  {status.latency_ms && <p className="text-muted">Latency: {status.latency_ms}ms</p>}
                  {status.user_count !== undefined && <p className="text-muted">Users: {status.user_count}</p>}
                  {status.template_count !== undefined && <p className="text-muted">Templates: {status.template_count}</p>}
                  {status.error && <p className="text-red-400 text-xs">{status.error}</p>}
                </div>
              </div>
            ))
          ) : null}
        </div>
      </div>

      {/* User Management */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-500" />
            Users
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-panel bg-panel/30">
              <tr>
                <th className="px-6 py-3 text-left font-semibold text-muted">Username</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Name</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Email</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Role</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-panel">
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted text-sm">Loading users...</td>
                </tr>
              ) : users.data?.users?.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted text-sm">No users</td>
                </tr>
              ) : (
                users.data?.users?.map((user: typeof users.data.users[0], i: number) => (
                  <tr key={i} className="hover:bg-panel/30 transition">
                    <td className="px-6 py-3 font-mono text-xs">{user.username}</td>
                    <td className="px-6 py-3 text-sm">{user.display_name}</td>
                    <td className="px-6 py-3 text-xs text-muted">{user.email}</td>
                    <td className="px-6 py-3">
                      <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-blue-500/20 text-blue-400">
                        {user.role}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${
                        user.is_active ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                      }`}>
                        {user.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Groups Management */}
      <div className="panel">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Users className="w-5 h-5 text-green-500" />
            Groups
          </h2>
        </div>
        <div className="divide-y divide-panel">
          {isLoading ? (
            <div className="px-6 py-8 text-center text-muted text-sm">Loading groups...</div>
          ) : groups.data?.groups?.length === 0 ? (
            <div className="px-6 py-8 text-center text-muted text-sm">No groups</div>
          ) : (
            groups.data?.groups?.map((group: typeof groups.data.groups[0], i: number) => (
              <div key={i} className="px-6 py-4 hover:bg-panel/30 transition">
                <div className="flex items-start justify-between mb-3">
                  <h3 className="font-semibold text-sm">{group.name}</h3>
                  <span className="text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded">
                    {group.user_count} member{group.user_count !== 1 ? 's' : ''}
                  </span>
                </div>
                {group.users.length > 0 && (
                  <div className="text-xs text-muted space-y-1">
                    {group.users.map((user: typeof group.users[0], j: number) => (
                      <div key={j} className="flex gap-2">
                        <span className="text-muted">•</span>
                        <span>{user.display_name} (@{user.username})</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
