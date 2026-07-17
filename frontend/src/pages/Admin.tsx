import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useAdminUsers, useAdminGroups, useAdminHealth, useCreatePasskeyInvitation } from '@/api/hooks'
import { Users, Bot, Activity } from 'lucide-react'
import type { AdminUser, PasskeyInvitationResponse } from '@/api/types'

// A single Users table body. The People / Machine-identities split (ADR-0028
// C4/D8) renders two of these over the human vs machine partitions rather than
// one flat roster, so human and non-human principals never blur together.
function UsersTable({ users, isLoading, emptyLabel }: {
  users: AdminUser[]
  isLoading: boolean
  emptyLabel: string
}) {
  return (
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
          ) : users.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-6 py-8 text-center text-muted text-sm">{emptyLabel}</td>
            </tr>
          ) : (
            users.map((user) => (
              <tr key={user.username} className="hover:bg-panel/30 transition">
                <td className="px-6 py-3 font-mono text-xs">
                  <span className="flex items-center gap-2">
                    {user.username}
                    {user.is_break_glass && (
                      <span
                        className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/40"
                        title="Sanctioned emergency identity (ADR-0028 C4) — audited, not for routine use."
                      >
                        Break-glass
                      </span>
                    )}
                  </span>
                </td>
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
  )
}

export default function Admin() {
  const users = useAdminUsers()
  const groups = useAdminGroups()
  const health = useAdminHealth()
  const inviteMutation = useCreatePasskeyInvitation()
  const [showQR, setShowQR] = useState(false)
  const [inviteResult, setInviteResult] = useState<PasskeyInvitationResponse | null>(null)

  const isLoading = users.isLoading || groups.isLoading || health.isLoading

  const allUsers: AdminUser[] = users.data?.users ?? []
  const humanUsers = allUsers.filter((u) => u.user_type === 'human')
  const machineUsers = allUsers.filter((u) => u.user_type === 'machine')

  const handleInviteClick = async () => {
    try {
      const result = await inviteMutation.mutateAsync()
      setInviteResult(result)
      setShowQR(true)
    } catch (error) {
      console.error('Failed to create invitation:', error)
    }
  }

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

      {/* People — human identities (ADR-0028 C4/D8 human/machine split).
          Invite affordance lives here (not on Machine identities): People is
          the human roster, and invitations mint human enrollment links. */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-500" />
            People
          </h2>
          <button
            onClick={handleInviteClick}
            disabled={inviteMutation.isPending}
            className="btn btn-primary btn-sm"
          >
            {inviteMutation.isPending ? '...' : '+ Invite new user'}
          </button>
        </div>

        {showQR && inviteResult && (
          <div className="bg-panel/30 border-b border-panel p-4">
            <div className="flex justify-center p-4 bg-panel border border-panel rounded inline-block">
              <QRCodeSVG value={inviteResult.enrollment_url} size={180} level="M" />
            </div>
            <div className="mt-4">
              <p className="text-sm text-muted mb-2">Or copy the enrollment URL:</p>
              <input
                type="text"
                value={inviteResult.enrollment_url}
                readOnly
                className="w-full bg-panel border border-panel rounded px-3 py-2 text-sm font-mono"
              />
              <p className="text-xs text-muted mt-2">
                Expires: {new Date(inviteResult.expires).toLocaleString()}
              </p>
            </div>
            <button
              onClick={() => setShowQR(false)}
              className="btn btn-secondary btn-sm mt-4"
            >
              Close
            </button>
          </div>
        )}

        <UsersTable users={humanUsers} isLoading={isLoading} emptyLabel="No people" />
      </div>

      {/* Machine identities — service / automation principals, kept distinct
          from People so a non-human login never reads as a person. */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Bot className="w-5 h-5 text-cyan-500" />
            Machine identities
          </h2>
        </div>
        <UsersTable users={machineUsers} isLoading={isLoading} emptyLabel="No machine identities" />
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
