import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { useWorkspaceHealth } from '../../api/hooks'
import type { WorkspaceAlert } from '../../api/types'
import { humanizeAlertName, humanizeContext } from '../../lib/labels'
import { classifyWorkspaceHealth } from '../../lib/workspaceHealth'

// The pinned, non-removable "are we OK?" core (IA §4.1/§6.1, #174 WP2).
// Every state is designed (Art. 9): loading, dark (not configured),
// degraded (unreachable — last-known with age, or unknown), verified
// green (zero alerts + Watchdog alive), unverified quiet (zero alerts,
// no Watchdog), and firing (tiles + Current Problems). No Ack in v1 —
// rows carry non-mutating Investigate links only (plan OQ-2 resolution).
export default function HealthCore() {
  const health = useWorkspaceHealth()
  // Shared "are we OK?" classifier — same source of truth as the shell bell
  // (Art. 1: the two must never disagree).
  const state = classifyWorkspaceHealth(health)

  if (state.phase === 'loading') {
    return (
      <div className="panel text-center py-8 mb-6">
        <p className="text-muted text-sm">Checking facility health…</p>
      </div>
    )
  }

  if (state.phase === 'not-configured') {
    return (
      <div className="panel py-6 px-6 mb-6">
        <h2 className="font-bold text-text mb-1">Facility health</h2>
        <p className="text-sm text-muted">
          Monitoring is not configured in this environment, so facility
          health cannot be assessed from here.
        </p>
      </div>
    )
  }

  const stale = state.stale
  const staleAgeSeconds =
    stale && health.dataUpdatedAt
      ? Math.max(0, Math.round((Date.now() - health.dataUpdatedAt) / 1000))
      : null

  if (state.phase === 'unknown') {
    return (
      <div className="panel py-6 px-6 mb-6 border-warn/40">
        <h2 className="font-bold text-text mb-1">Facility health — unknown</h2>
        <p className="text-sm text-warn">
          Monitoring is unreachable and no earlier state is available.
          Retrying automatically.
        </p>
      </div>
    )
  }

  // The core carries classified problems only — the backend applies the
  // severity floor (info/advisory → expert Monitoring lane, not a "problem";
  // Art. 4). So the tiles classify Critical vs everything-else-that-is-a-
  // problem (Warning); there is no Info tile (an info count here would imply
  // info-level problems exist, which contradicts the floor).
  const alerts = state.alerts
  const counts = {
    critical: alerts.filter((a) => a.severity === 'critical').length,
    warning: alerts.filter((a) => a.severity !== 'critical').length,
  }
  const allQuiet = !state.hasProblems
  const verified = state.verified

  return (
    <div className="mb-6">
      {stale && (
        <div className="panel py-3 px-6 mb-4 border-warn/40">
          <p className="text-sm text-warn">
            Monitoring is unreachable — showing last-known state
            {staleAgeSeconds !== null ? ` from ${staleAgeSeconds}s ago` : ''}.
            Retrying automatically.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-4">
        <SeverityTile label="Critical" count={counts.critical} tone="critical" />
        <SeverityTile label="Warning" count={counts.warning} tone="warning" />
      </div>

      <div className="panel">
        <div className="px-6 py-4 border-b border-panel flex items-center justify-between">
          <h2 className="text-lg font-semibold">Current problems</h2>
          {!stale && (
            <span className="text-xs text-muted">
              live · updates in place every 30s
            </span>
          )}
        </div>
        {allQuiet ? (
          verified ? (
            <div className="px-6 py-8 text-center">
              <p className="text-sm font-semibold text-ok">
                ✓ No problems — facility monitoring reports all quiet.
              </p>
              <p className="text-xs text-muted mt-1">
                Verified: the alert pipeline&apos;s always-on Watchdog signal is
                arriving, so silence means healthy, not broken.
              </p>
            </div>
          ) : (
            <div className="px-6 py-8 text-center">
              <p className="text-sm font-semibold text-text">
                No alerts firing — but this cannot be verified as healthy.
              </p>
              <p className="text-xs text-warn mt-1">
                The alert pipeline&apos;s Watchdog signal is absent; alert rules
                may not be loaded. Treat this as unknown, not green.
              </p>
            </div>
          )
        ) : (
          <div className="divide-y divide-panel">
            {alerts.map((alert) => (
              <ProblemRow key={alert.id} alert={alert} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const tileTone: Record<string, { active: string; quiet: string }> = {
  critical: { active: 'text-fault border-fault/40', quiet: 'text-muted' },
  warning: { active: 'text-warn border-warn/40', quiet: 'text-muted' },
  info: { active: 'text-accent-blue border-accent-blue/40', quiet: 'text-muted' },
}

function SeverityTile({ label, count, tone }: { label: string; count: number; tone: string }) {
  const style = count > 0 ? tileTone[tone].active : tileTone[tone].quiet
  return (
    <div className={`panel p-4 text-center ${count > 0 ? style : ''}`}>
      <div className={`text-3xl font-bold ${style}`}>{count}</div>
      <div className="text-xs text-muted mt-1">{label}</div>
    </div>
  )
}

const severityBadge: Record<string, string> = {
  critical: 'bg-red-900/40 text-red-300',
  warning: 'bg-amber-900/40 text-amber-300',
  info: 'bg-blue-900/40 text-blue-300',
}

function ProblemRow({ alert }: { alert: WorkspaceAlert }) {
  const [showDetails, setShowDetails] = useState(false)
  // Default level speaks the operator's language (Art. 3): a readable title
  // and a readable scope line. The raw rule name + key=value label blob are
  // system jargon — demoted behind an expert "Details" affordance, never
  // shown at default (and never destroyed).
  const title = humanizeAlertName(alert.name)
  const scope = humanizeContext(alert.context)
  return (
    <div className="px-6 py-4 hover:bg-panel/30 transition">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-xs badge px-2 py-0.5 rounded font-semibold ${
                severityBadge[alert.severity] || severityBadge.warning
              }`}
            >
              {alert.severity || 'unclassified'}
            </span>
            <h3 className="font-semibold text-sm">{title}</h3>
            {alert.instance && <span className="text-xs text-muted">{alert.instance}</span>}
          </div>
          {scope && <p className="text-xs text-muted mt-1">{scope}</p>}
          {(alert.summary || alert.description) && (
            <p className="text-xs text-muted mt-1">{alert.summary || alert.description}</p>
          )}
          {(alert.name || alert.context) && (
            <>
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                className="text-xs text-muted/70 hover:text-muted mt-1 cursor-pointer"
                aria-expanded={showDetails}
              >
                {showDetails ? 'Hide details' : 'Details'}
              </button>
              {showDetails && (
                <p className="text-xs text-muted/70 mt-1 font-mono break-all">
                  {alert.name}
                  {alert.context ? ` · ${alert.context}` : ''}
                </p>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0 text-xs">
          {/* Non-mutating actions only (no Ack until the Alarm Philosophy
              lifecycle exists — plan OQ-2). */}
          <Link to="/monitoring" className="text-accent-blue hover:underline">
            Investigate
          </Link>
          {alert.runbook_url && (
            <a
              href={alert.runbook_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-blue hover:underline flex items-center gap-1"
            >
              Runbook <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
