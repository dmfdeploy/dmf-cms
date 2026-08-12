import { useAppContract, useCurrentUser, useAdminHealth } from '../../api/hooks'

// Admin default panels on the Workspace home (IA §4.1 role-varied content;
// moved from the retired pages/overview/AdminOverview.tsx, #174 WP4). The
// Workspace page owns the scroll container (the per-page hero it used to
// also own was retired — umbrella #347 WO-D1 spec C).
//
// Users and Workflows are NOT Workspace widgets (IA 2026-06-23 §4.1/§5/§7):
// Users lives on the admin secondary rail (pages/Admin.tsx), Workflows on the
// Activity → Jobs lane (pages/Activity/JobsLane.tsx). This component's
// surviving content is Integration Status + Infrastructure Services only.
export default function AdminPanels() {
  // fix-round 5 (PR #81, codex sibling sweep): this component is currently
  // unreferenced (see pages/Workspace/index.tsx's own comment — re-wiring it
  // is four edits by that comment), so nothing here is operator-visible
  // today. Fixed alongside Admin.tsx anyway rather than left as a landmine
  // for a future re-wire: `!contract || !user` used to be the WHOLE gate on
  // "Loading..." — a settled failed useAppContract read (retry:false, no
  // refetchInterval) left this claiming "Loading..." forever, a freshness
  // claim that would never resolve. IntegrationStatusCard also rendered
  // Connected/Disconnected + latency/user/template counts from `healthData`
  // with no isError check at all — same shape as Admin.tsx's own
  // Integration Health panel.
  const { data: user, isError: userError } = useCurrentUser()
  const { data: contract, isError: contractError } = useAppContract()
  const { data: healthData, isLoading: healthLoading, isError: healthError } = useAdminHealth()

  if (!contract || !user) {
    if (contractError || userError) {
      return (
        <p className="text-sm text-warn">
          Could not be read right now. Reload the page to try again.
        </p>
      )
    }
    return <div className="animate-pulse text-muted">Loading...</div>
  }

  return (
    <div>
      {/* Integration Status Panel */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-text mb-4">Integration Status</h2>
        {healthError && (
          <div className="mb-4 text-xs text-warn bg-warning/10 rounded px-3 py-2">
            {healthData
              ? 'Could not be refreshed just now — showing the last successful read. Retrying automatically.'
              : 'Integration status could not be read right now. Retrying automatically.'}
          </div>
        )}
        {healthLoading ? (
          <div className="panel p-4">
            <div className="animate-pulse text-muted">Loading integration status...</div>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-4">
            {healthData && (
              <>
                <IntegrationStatusCard
                  name="Authentik"
                  status={healthData.authentik}
                />
                <IntegrationStatusCard
                  name="AWX"
                  status={healthData.awx}
                />
                <IntegrationStatusCard
                  name="NetBox"
                  status={healthData.netbox}
                />
                <IntegrationStatusCard
                  name="Prometheus"
                  status={healthData.prometheus}
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* Infrastructure Services */}
      <div className="mb-8">
        <div className="panel">
          <div className="p-4 border-b border-border">
            <h2 className="font-bold text-text mb-1">Infrastructure Services</h2>
            <p className="text-xs text-muted mt-1">
              These platform services underpin DMF Console. Media Workloads and Functions will be managed via NetBox and AWX in Release 1.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Lane</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {contract.apps.map((app) => (
                  <tr key={app.key}>
                    <td className="font-medium text-text">{app.display_name}</td>
                    <td>
                      <span
                        className={`text-xs badge ${
                          app.lane === 'public' ? 'bg-accent/20 text-accent' : 'bg-warning/20 text-warning'
                        }`}
                      >
                        {app.lane}
                      </span>
                    </td>
                    <td>
                      {app.links.length > 0 ? (
                        <a
                          href={app.links[0].url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-accent-blue hover:underline"
                        >
                          Open →
                        </a>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function IntegrationStatusCard({
  name,
  status,
}: {
  name: string
  status: any
}) {
  const statusDot = status.connected ? 'status-dot-ok' : status.note ? 'status-dot-warn' : 'status-dot-fault'

  return (
    <div className="card flex flex-col">
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold text-text text-sm">{name}</h3>
        <span className={`status-dot ${statusDot}`}></span>
      </div>
      {status.connected ? (
        <>
          <p className="text-xs text-muted flex-1">Connected</p>
          {status.latency_ms !== undefined && (
            <p className="text-xs text-accent-green mt-2">{status.latency_ms}ms</p>
          )}
          {status.user_count !== undefined && (
            <p className="text-xs text-accent-green mt-2">{status.user_count} users</p>
          )}
          {status.template_count !== undefined && (
            <p className="text-xs text-accent-green mt-2">{status.template_count} templates</p>
          )}
        </>
      ) : (
        <>
          <p className="text-xs flex-1">
            {status.note ? (
              <span className="text-warning">{status.note}</span>
            ) : (
              <span className="text-fault">{status.error || 'Disconnected'}</span>
            )}
          </p>
        </>
      )}
    </div>
  )
}
