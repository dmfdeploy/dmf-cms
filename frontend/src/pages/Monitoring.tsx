import { useMonitoringMetrics, useMonitoringAlerts, useMonitoringTargets } from '@/api/hooks'
import { AlertCircle, Activity, Zap, HardDrive } from 'lucide-react'

export default function Monitoring() {
  const metrics = useMonitoringMetrics()
  const alerts = useMonitoringAlerts()
  const targets = useMonitoringTargets()

  const isLoading = metrics.isLoading || alerts.isLoading || targets.isLoading

  const metricCards = [
    { label: 'CPU Usage', value: metrics.data?.cpu_percent ?? 0, unit: '%', icon: Zap, color: 'text-amber-500' },
    { label: 'Memory Usage', value: metrics.data?.memory_percent ?? 0, unit: '%', icon: Activity, color: 'text-blue-500' },
    { label: 'Pod Restarts (24h)', value: metrics.data?.pod_restarts_24h ?? 0, unit: '', icon: AlertCircle, color: 'text-red-500' },
    { label: 'PVC Usage', value: metrics.data?.pvc_usage_percent ?? 0, unit: '%', icon: HardDrive, color: 'text-green-500' },
  ]

  const activeAlerts = (alerts.data?.alerts ?? []).filter((a: any) => a.state === 'firing')

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <div className="hero-copy">
          <p className="kicker">Observability</p>
          <h1>Monitoring</h1>
          <p>Real-time metrics and alerts from Prometheus.</p>
        </div>
      </div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {metricCards.map((card: typeof metricCards[0]) => {
          const Icon = card.icon
          return (
            <div key={card.label} className="panel p-4">
              <div className="flex items-start justify-between mb-3">
                <h3 className="text-sm font-semibold text-muted">{card.label}</h3>
                <Icon className={`w-4 h-4 ${card.color}`} />
              </div>
              <div className="text-3xl font-bold">
                {isLoading ? '-' : `${Math.round(card.value * 10) / 10}${card.unit}`}
              </div>
              <div className={`text-xs mt-2 ${card.value > 80 ? 'text-red-400' : card.value > 60 ? 'text-amber-400' : 'text-green-400'}`}>
                {card.value > 80 ? '⚠️ High' : card.value > 60 ? '⚡ Elevated' : '✓ Healthy'}
              </div>
            </div>
          )
        })}
      </div>

      {/* Alerts Section */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-500" />
            Active Alerts {activeAlerts.length > 0 && `(${activeAlerts.length})`}
          </h2>
        </div>
        <div className="divide-y divide-panel">
          {isLoading ? (
            <div className="px-6 py-8 text-center text-muted text-sm">Loading alerts...</div>
          ) : activeAlerts.length === 0 ? (
            <div className="px-6 py-8 text-center text-muted text-sm">✓ No active alerts</div>
          ) : (
            activeAlerts.map((alert: typeof activeAlerts[0], i: number) => (
              <div key={i} className="px-6 py-4 hover:bg-panel/50 transition">
                <div className="font-semibold text-sm flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500"></span>
                  {alert.name}
                </div>
                {alert.summary && <p className="text-xs text-muted mt-1">{alert.summary}</p>}
                {alert.activeAt && <p className="text-xs text-muted/50 mt-1">Active: {new Date(alert.activeAt).toLocaleString()}</p>}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Scrape Targets Section */}
      <div className="panel">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold">Scrape Targets</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-panel bg-panel/30">
              <tr>
                <th className="px-6 py-3 text-left font-semibold text-muted">Job</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Instance</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Health</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Last Scrape</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-panel">
              {isLoading ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted text-sm">Loading targets...</td>
                </tr>
              ) : targets.data?.targets?.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted text-sm">No scrape targets available</td>
                </tr>
              ) : (
                targets.data?.targets?.map((target: typeof targets.data.targets[0], i: number) => (
                  <tr key={i} className="hover:bg-panel/30 transition">
                    <td className="px-6 py-3 font-mono text-xs">{target.job}</td>
                    <td className="px-6 py-3 font-mono text-xs text-muted">{target.instance}</td>
                    <td className="px-6 py-3">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${
                        target.health === 'up' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                      }`}>
                        {target.health === 'up' ? '✓ Up' : '✗ Down'}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-muted text-xs">{target.lastScrape ? new Date(target.lastScrape).toLocaleString() : 'Never'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
