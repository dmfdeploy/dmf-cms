import { useState, useEffect, useRef } from 'react'
import { Bell, CheckCircle, AlertTriangle, AlertCircle, Info } from 'lucide-react'
import { useMonitoringAlerts } from '@/api/hooks'
import type { MonitoringAlert } from '@/api/types'

const severityIcon: Record<string, typeof AlertTriangle> = {
  critical: AlertCircle,
  warning: AlertTriangle,
  info: Info,
}

const severityColor: Record<string, string> = {
  critical: 'text-red-500',
  warning: 'text-yellow-500',
  info: 'text-blue-500',
}

export default function NotificationBell() {
  const { data, isLoading } = useMonitoringAlerts()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const activeAlerts = (data?.alerts ?? []).filter((a) => a.state === 'firing')
  const hasCriticalAlerts = activeAlerts.some((a) => a.severity === 'critical')

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
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {activeAlerts.length > 0 && (
          <span
            className={`absolute -top-1 -right-1 w-4 h-4 rounded-full text-xs font-bold flex items-center justify-center ${
              hasCriticalAlerts ? 'bg-red-500 text-white' : 'bg-accent text-bg'
            }`}
          >
            {activeAlerts.length}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {dropdownOpen && (
        <div className="absolute right-0 mt-2 w-96 bg-panel border border-muted/20 rounded-lg shadow-xl overflow-hidden z-50">
          {/* Header */}
          <div className="px-4 py-3 border-b border-muted/20">
            <h3 className="text-sm font-semibold text-text">Active Alerts</h3>
            <p className="text-xs text-muted mt-1">
              {activeAlerts.length} firing{activeAlerts.length === 0 ? ' — all systems nominal' : ''}
            </p>
          </div>

          {/* Alert list */}
          <div className="max-h-96 overflow-y-auto">
            {isLoading ? (
              <div className="px-4 py-6 text-center text-muted text-sm">Loading alerts...</div>
            ) : activeAlerts.length === 0 ? (
              <div className="px-4 py-6 text-center text-muted text-sm">
                <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-500" />
                No active alerts
              </div>
            ) : (
              <AlertList alerts={activeAlerts} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function AlertList({ alerts }: { alerts: MonitoringAlert[] }) {
  return (
    <div className="divide-y divide-muted/20">
      {alerts.map((alert, i) => {
        const Icon = severityIcon[alert.severity ?? 'info'] ?? Info
        const color = severityColor[alert.severity ?? 'info'] ?? 'text-muted'

        return (
          <div key={`${alert.name}-${i}`} className="px-4 py-3 hover:bg-bg/50 transition-colors">
            <div className="flex items-start gap-3">
              <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${color}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text truncate">{alert.name}</p>
                {alert.summary && <p className="text-xs text-muted mt-0.5">{alert.summary}</p>}
                {alert.activeAt && (
                  <p className="text-xs text-muted/50 mt-1">
                    Active: {new Date(alert.activeAt).toLocaleString()}
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
