export default function ViewerOverview() {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Facility Status</p>
        <h1>Overview</h1>
        <p>Read-only view of facility health and operational status.</p>
      </div>
      <div className="panel text-center py-12">
        <p className="text-muted text-sm">System health and status summary will appear here.</p>
        <p className="text-xs text-muted mt-2">Available in Release 1.</p>
      </div>
    </div>
  )
}
