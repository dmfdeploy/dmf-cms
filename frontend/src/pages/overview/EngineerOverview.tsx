export default function EngineerOverview() {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Build & Troubleshoot</p>
        <h1>Infrastructure</h1>
        <p>Facility topology, drift detection, and compliance monitoring.</p>
      </div>
      <div className="panel text-center py-12">
        <p className="text-muted text-sm">Infrastructure Topology and Drift/Compliance will appear here.</p>
        <p className="text-xs text-muted mt-2">Wired from NetBox inventory in Release 1.</p>
      </div>
    </div>
  )
}
