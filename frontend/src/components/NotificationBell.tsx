import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Bell, CheckCircle, AlertTriangle, AlertCircle } from 'lucide-react'
import { useWorkspaceHealth } from '@/api/hooks'
import type { WorkspaceAlert } from '@/api/types'
import { humanizeAlertName, humanizeContext } from '@/lib/labels'
import { classifyWorkspaceHealth, isNominal, type WorkspaceHealthState } from '@/lib/workspaceHealth'

// The shell bell is a MONITORING affordance, not a classified-condition inbox
// (Constitution Art. 4 + §4 anti-pattern). It reads the SAME floored,
// operator-language workspace-health signal as "Current problems" (info/
// advisory dropped, Watchdog + pending dropped), via the shared classifier —
// so the bell and the Workspace can never disagree (Art. 1: an unreachable /
// not-configured / unverified state must NEVER render as a green "all systems
// nominal"). No ack/lifecycle machinery (Alarm Philosophy taxonomy is a stub).
// The raw, unfiltered alert set lives on the expert Monitoring page.

const severityIcon: Record<string, typeof AlertTriangle> = {
  critical: AlertCircle,
  warning: AlertTriangle,
}

const severityColor: Record<string, string> = {
  critical: 'text-red-500',
  warning: 'text-yellow-500',
}

// One-line summary that never lies about health (Art. 1).
function summaryText(state: WorkspaceHealthState): string {
  if (state.hasProblems) return `${state.alerts.length} firing`
  switch (state.phase) {
    case 'loading':
      return 'Checking…'
    case 'not-configured':
      return 'Monitoring not configured'
    case 'unknown':
      return 'Monitoring unreachable'
    case 'live':
      if (state.stale) return 'Monitoring unreachable — last-known'
      if (!state.verified) return 'Cannot be verified as healthy'
      return 'All systems nominal'
  }
}

export default function NotificationBell() {
  const health = useWorkspaceHealth()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const state = classifyWorkspaceHealth(health)
  const nominal = isNominal(state)
  // Degraded = we cannot confirm health AND there is no problem list to show:
  // not-configured / unreachable / stale / Watchdog-missing. Shown honestly,
  // never as green.
  const degraded = !nominal && !state.hasProblems && state.phase !== 'loading'
  const alerts = state.alerts
  const hasCriticalAlerts = alerts.some((a) => a.severity === 'critical')

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell icon */}
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="relative p-2 text-muted hover:text-text transition-colors cursor-pointer"
        aria-label="Monitoring alerts"
      >
        <Bell className="w-5 h-5" />
        {state.hasProblems ? (
          <span
            className={`absolute -top-1 -right-1 w-4 h-4 rounded-full text-xs font-bold flex items-center justify-center ${
              hasCriticalAlerts ? 'bg-red-500 text-white' : 'bg-accent text-bg'
            }`}
          >
            {alerts.length}
          </span>
        ) : degraded ? (
          // Not a count and NOT green: monitoring can't confirm health.
          <span
            className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-warn"
            aria-hidden="true"
          />
        ) : null}
      </button>

      {/* Dropdown */}
      {dropdownOpen && (
        <div className="absolute right-0 mt-2 w-96 bg-panel border border-muted/20 rounded-lg shadow-xl overflow-hidden z-50">
          {/* Header */}
          <div className="px-4 py-3 border-b border-muted/20 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-text">Monitoring alerts</h3>
              <p className="text-xs text-muted mt-1">{summaryText(state)}</p>
            </div>
            <Link
              to="/monitoring"
              onClick={() => setDropdownOpen(false)}
              className="text-xs text-accent-blue hover:underline shrink-0"
            >
              Open Monitoring
            </Link>
          </div>

          {/* Body */}
          <div className="max-h-96 overflow-y-auto">
            {state.phase === 'loading' ? (
              <div className="px-4 py-6 text-center text-muted text-sm">Loading alerts…</div>
            ) : state.hasProblems ? (
              <AlertList alerts={alerts} />
            ) : nominal ? (
              <div className="px-4 py-6 text-center text-muted text-sm">
                <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-500" />
                No active alerts
              </div>
            ) : (
              // Degraded / unknown — honest, never a green check (Art. 1/8).
              <div className="px-4 py-6 text-center text-warn text-sm">
                <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
                {state.phase === 'not-configured'
                  ? 'Monitoring is not configured in this environment, so alerts cannot be assessed.'
                  : state.phase === 'unknown'
                    ? 'Monitoring is unreachable — health cannot be confirmed right now.'
                    : state.stale
                      ? 'Monitoring is unreachable — showing last-known state, which may be out of date.'
                      : 'No alerts firing, but the Watchdog signal is absent — treat this as unknown, not healthy.'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function AlertList({ alerts }: { alerts: WorkspaceAlert[] }) {
  return (
    <div className="divide-y divide-muted/20">
      {alerts.map((alert) => {
        const Icon = severityIcon[alert.severity] ?? AlertTriangle
        const color = severityColor[alert.severity] ?? 'text-muted'
        const scope = humanizeContext(alert.context)

        return (
          <div key={alert.id} className="px-4 py-3 hover:bg-bg/50 transition-colors">
            <div className="flex items-start gap-3">
              <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${color}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text truncate">{humanizeAlertName(alert.name)}</p>
                {scope && <p className="text-xs text-muted mt-0.5 truncate">{scope}</p>}
                {alert.summary && <p className="text-xs text-muted mt-0.5">{alert.summary}</p>}
                {alert.active_at && (
                  <p className="text-xs text-muted/50 mt-1">
                    Active: {new Date(alert.active_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
