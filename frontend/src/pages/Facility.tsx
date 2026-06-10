import { useFacilitySummary, useFacilityDevices } from '@/api/hooks'
import { Building2, Server, MapPin } from 'lucide-react'

export default function Facility() {
  const summary = useFacilitySummary()
  const devices = useFacilityDevices()

  const isLoading = summary.isLoading || devices.isLoading

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <div className="hero-copy">
          <p className="kicker">Infrastructure</p>
          <h1>Facility</h1>
          <p>Physical infrastructure inventory from NetBox.</p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="panel p-4">
          <div className="flex items-start justify-between mb-3">
            <h3 className="text-sm font-semibold text-muted">Sites</h3>
            <Building2 className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-3xl font-bold">{isLoading ? '-' : summary.data?.site_count ?? 0}</div>
          <p className="text-xs text-muted mt-2">Datacenters</p>
        </div>
        <div className="panel p-4">
          <div className="flex items-start justify-between mb-3">
            <h3 className="text-sm font-semibold text-muted">Devices</h3>
            <Server className="w-4 h-4 text-green-500" />
          </div>
          <div className="text-3xl font-bold">{isLoading ? '-' : summary.data?.device_count ?? 0}</div>
          <p className="text-xs text-muted mt-2">Physical servers & infrastructure</p>
        </div>
        <div className="panel p-4">
          <div className="flex items-start justify-between mb-3">
            <h3 className="text-sm font-semibold text-muted">Status</h3>
            <MapPin className="w-4 h-4 text-purple-500" />
          </div>
          <div className="text-3xl font-bold">✓</div>
          <p className="text-xs text-muted mt-2">NetBox connected</p>
        </div>
      </div>

      {/* Sites Breakdown */}
      {summary.data?.sites && summary.data.sites.length > 0 && (
        <div className="panel mb-6">
          <div className="px-6 py-4 border-b border-panel">
            <h2 className="text-lg font-semibold">Sites Overview</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-6">
            {summary.data.sites.map((site: typeof summary.data.sites[0], i: number) => (
              <div key={i} className="border border-panel rounded p-4 hover:bg-panel/30 transition">
                <h3 className="font-semibold text-sm mb-2">{site.name}</h3>
                <div className="space-y-1 text-xs text-muted">
                  <p>Devices: <span className="font-mono text-text">{site.device_count}</span></p>
                  <p>Status: <span className={`font-mono ${site.status === 'active' ? 'text-green-400' : 'text-amber-400'}`}>
                    {site.status}
                  </span></p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Devices Table */}
      <div className="panel">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold">Physical Devices</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-panel bg-panel/30">
              <tr>
                <th className="px-6 py-3 text-left font-semibold text-muted">Name</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Type</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Site</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Status</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">IP Address</th>
                <th className="px-6 py-3 text-left font-semibold text-muted">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-panel">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-muted text-sm">Loading devices...</td>
                </tr>
              ) : devices.data?.devices?.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-muted text-sm">No devices available</td>
                </tr>
              ) : (
                devices.data?.devices?.map((device: typeof devices.data.devices[0], i: number) => (
                  <tr key={i} className="hover:bg-panel/30 transition">
                    <td className="px-6 py-3 font-semibold text-sm">{device.name}</td>
                    <td className="px-6 py-3 text-xs text-muted">{device.type || '-'}</td>
                    <td className="px-6 py-3 text-xs text-muted">{device.site || '-'}</td>
                    <td className="px-6 py-3">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${
                        device.status === 'active' ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'
                      }`}>
                        {device.status || 'unknown'}
                      </span>
                    </td>
                    <td className="px-6 py-3 font-mono text-xs text-muted">{device.ip || '-'}</td>
                    <td className="px-6 py-3 text-xs text-muted">{device.role || '-'}</td>
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
