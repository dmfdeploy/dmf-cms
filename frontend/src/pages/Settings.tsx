import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useCurrentUser, useCreatePasskeyInvitation, useCreateSetupRequestReceipt } from '../api/hooks'
import { APIError } from '../api/client'
import { settleQuery } from '../lib/queryState'
import PageHeading from '../components/PageHeading'
import { usePageTitle } from '../hooks/usePageTitle'

const roleBadgeStyles: Record<string, string> = {
  viewer: 'bg-blue-900/40 text-blue-300',
  operator: 'bg-green-900/40 text-green-300',
  engineer: 'bg-purple-900/40 text-purple-300',
  admin: 'bg-indigo-900/40 text-indigo-300',
}

export default function Settings() {
  usePageTitle('Settings')
  // (umbrella #385) `!user` alone used to
  // be the WHOLE gate for "Not authenticated" below — that read as true for
  // a genuine 401 (real) AND for any OTHER failed read (a transient 500 or
  // network error, mislabelled as the same claim), AND a settled failed
  // BACKGROUND refetch that retained `user` from an earlier successful
  // mount rendered the whole stale profile/authentik_configured section
  // with no notice at all that the current read had failed. (In practice
  // the reachable case is the last one: App.tsx's own useCurrentUser() gate
  // means this component never mounts with `user` undefined on a fresh
  // load — `isError` here only ever fires on a LATER refetch — but the
  // dead branches stay correct rather than latently wrong.)
  const userQuery = useCurrentUser()
  const { data: user, loading: isLoading, failed: isError } = settleQuery(userQuery)
  // /api/me answers 401 specifically for "no session" (main.py's
  // api_current_user) — any OTHER failure (500, network, a timeout) is a
  // read failure, not evidence the operator isn't signed in, and must not
  // share that claim's copy (Art. 1).
  const unauthorized = userQuery.error instanceof APIError && userQuery.error.status === 401
  const invitationMutation = useCreatePasskeyInvitation()
  const setupRequestMutation = useCreateSetupRequestReceipt()
  const [enrollmentUrl, setEnrollmentUrl] = useState('')
  const [expires, setExpires] = useState('')
  const [error, setError] = useState('')
  const [setupReason, setSetupReason] = useState('')
  const [setupRequestId, setSetupRequestId] = useState('')
  const [setupRequestExpiry, setSetupRequestExpiry] = useState('')
  const [setupRequestError, setSetupRequestError] = useState('')

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

  const handleCreateSetupRequest = async () => {
    setSetupRequestError('')
    setSetupRequestId('')
    try {
      const result = await setupRequestMutation.mutateAsync(setupReason)
      setSetupRequestId(result.request_id)
      setSetupRequestExpiry(new Date(result.expires_at * 1000).toLocaleString())
      setSetupReason('')
    } catch (err: unknown) {
      setSetupRequestError(err instanceof Error ? err.message : 'The request could not be recorded.')
    }
  }

  const handleCopySetupRequestId = async () => {
    try {
      await navigator.clipboard.writeText(setupRequestId)
    } catch {
      setSetupRequestError('Could not copy the request id. Select and copy it from the field.')
    }
  }

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <PageHeading>Settings</PageHeading>
        <div className="animate-pulse text-muted">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <PageHeading>Settings</PageHeading>
        <p className="text-muted">
          {unauthorized
            ? 'Not authenticated'
            : 'Your account could not be read right now. Reload the page to try again.'}
        </p>
      </div>
    )
  }

  const role = user.role || 'viewer'
  const roleRank = { viewer: 0, operator: 1, engineer: 2, admin: 3 }[role] ?? -1
  const canRequestBornInventorySetup =
    roleRank >= 1 && user.subject !== 'akadmin' && !user.groups.includes('break-glass')

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeading>Settings</PageHeading>
      <div className="max-w-3xl">
        {/* A settled failed refetch retains `user` from the earlier
            successful read (Art. 5 — the screen stays still) but the CURRENT
            read did not confirm it; useCurrentUser has no refetchInterval,
            so "Reload the page" (not "Retrying automatically") is the true
            next step, same convention as CreateWorkload.tsx's
            TemplatePicker. */}
        {isError && (
          <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Could not be refreshed just now — showing the last successful read. Reload the page to try again.
          </div>
        )}

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

        {canRequestBornInventorySetup && (
          <div className="bg-panel border border-border rounded-lg mt-6">
            <div className="p-4 border-b border-border">
              <h2 className="font-bold text-sm text-text">Bootstrap inventory setup</h2>
            </div>
            <div className="p-4">
              <p className="text-sm text-muted mb-4">
                Create a one-use authorization receipt for the 694 inventory setup step. It expires in 15 minutes. Return to dmf-init and enter the id to continue bootstrap.
              </p>
              <label htmlFor="setup-request-reason" className="block text-xs text-muted mb-1">
                Reason
              </label>
              <textarea
                id="setup-request-reason"
                value={setupReason}
                onChange={(event) => setSetupReason(event.target.value)}
                maxLength={240}
                rows={3}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text"
                placeholder="Why are you running the initial inventory setup?"
              />
              <button
                type="button"
                onClick={handleCreateSetupRequest}
                disabled={setupRequestMutation.isPending || !setupReason.trim()}
                className="mt-3 px-3 py-2 rounded-lg font-medium transition-colors bg-accent-blue text-bg hover:bg-accent-blue/90 text-sm disabled:opacity-60"
              >
                {setupRequestMutation.isPending ? 'Recording…' : 'Create setup receipt'}
              </button>
              {setupRequestError && (
                <p role="alert" className="mt-3 text-sm text-red-300">{setupRequestError}</p>
              )}
              {setupRequestId && (
                <div className="mt-4 rounded-lg border border-border bg-bg p-3">
                  <p className="text-sm text-text">Request id — paste into the waiting dmf-init setup gate</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="break-all font-mono text-sm text-text">{setupRequestId}</code>
                    <button
                      type="button"
                      onClick={handleCopySetupRequestId}
                      className="text-xs text-accent-blue hover:text-accent-blue/80"
                    >
                      Copy id
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-muted">Expires: {setupRequestExpiry}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
