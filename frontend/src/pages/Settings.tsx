import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useCurrentUser, useCreatePasskeyInvitation } from '../api/hooks'

const roleBadgeStyles: Record<string, string> = {
  viewer: 'bg-blue-900/40 text-blue-300',
  operator: 'bg-green-900/40 text-green-300',
  engineer: 'bg-purple-900/40 text-purple-300',
  admin: 'bg-indigo-900/40 text-indigo-300',
}

export default function Settings() {
  const { data: user, isLoading } = useCurrentUser()
  const invitationMutation = useCreatePasskeyInvitation()
  const [enrollmentUrl, setEnrollmentUrl] = useState('')
  const [expires, setExpires] = useState('')
  const [error, setError] = useState('')

  const handleCreateInvitation = async () => {
    setError('')
    setEnrollmentUrl('')
    try {
      const data = await invitationMutation.mutateAsync()
      setEnrollmentUrl(data.enrollment_url)
      setExpires(new Date(data.expires).toLocaleString())
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create invitation')
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(enrollmentUrl)
  }

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="animate-pulse text-muted">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <p className="text-muted">Not authenticated</p>
      </div>
    )
  }

  const role = user.role || 'viewer'

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl">
        {/* Hero */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-text">User Settings</h1>
            <p className="text-muted text-sm mt-1">Manage your account and security preferences</p>
          </div>
        </div>

        {/* Profile */}
        <div className="bg-panel border border-border rounded-lg mb-6">
          <div className="p-4 border-b border-border">
            <h2 className="font-bold text-sm text-text">Profile</h2>
          </div>
          <div className="p-4">
            <dl className="space-y-4">
              <div className="flex items-start gap-4">
                <dt className="text-[11px] text-muted uppercase tracking-wider font-semibold w-32 shrink-0 pt-0.5">Display name</dt>
                <dd className="text-sm text-text">{user.display_name}</dd>
              </div>
              <div className="flex items-start gap-4">
                <dt className="text-[11px] text-muted uppercase tracking-wider font-semibold w-32 shrink-0 pt-0.5">Email</dt>
                <dd className="text-sm text-text">{user.email}</dd>
              </div>
              <div className="flex items-start gap-4">
                <dt className="text-[11px] text-muted uppercase tracking-wider font-semibold w-32 shrink-0 pt-0.5">Subject</dt>
                <dd className="text-sm text-text font-mono text-xs break-all">{user.subject}</dd>
              </div>
              <div className="flex items-start gap-4">
                <dt className="text-[11px] text-muted uppercase tracking-wider font-semibold w-32 shrink-0 pt-0.5">Role</dt>
                <dd>
                  <span className={`inline-block px-2 py-1 text-xs rounded-full font-semibold capitalize ${roleBadgeStyles[role]}`}>
                    {role}
                  </span>
                </dd>
              </div>
            </dl>
          </div>
        </div>

        {/* Passkey Enrollment */}
        <div className="bg-panel border border-border rounded-lg">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h2 className="font-bold text-sm text-text">Passkey Enrollment</h2>
            <span className="text-xs text-muted">Register a new device</span>
          </div>
          <div className="p-4">
            {user.authentik_configured ? (
              <>
                <p className="text-sm text-muted mb-4">
                  Creates a single-use enrollment link that expires after 24 hours.
                  Scan the QR code on your new device or copy the URL.
                </p>
                <button
                  onClick={handleCreateInvitation}
                  disabled={invitationMutation.isPending}
                  className="px-3 py-2 rounded-lg font-medium transition-colors bg-accent-blue text-bg hover:bg-accent-blue/90 text-sm disabled:opacity-60"
                >
                  {invitationMutation.isPending ? 'Creating…' : 'Create new device invitation'}
                </button>

                {error && (
                  <div className="mt-4 text-sm p-3 rounded-lg bg-red-900/30 text-red-300 border border-red-900/50">
                    {error}
                  </div>
                )}

                {enrollmentUrl && (
                  <div className="mt-4">
                    <div className="flex justify-center p-4 bg-bg rounded-xl border border-border">
                      <QRCodeSVG value={enrollmentUrl} size={180} level="M" />
                    </div>
                    <div className="flex items-center gap-2 mt-3 p-3 bg-bg rounded-lg border border-border">
                      <code className="flex-1 text-xs text-text truncate font-mono">{enrollmentUrl}</code>
                      <button
                        onClick={handleCopy}
                        className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors"
                      >
                        Copy
                      </button>
                    </div>
                    <div className="text-xs text-muted mt-2">
                      Expires: {expires}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-muted text-center py-12">
                The Authentik API is not configured for this environment.
                Passkey enrollment is unavailable until your admin connects the console to Authentik.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
