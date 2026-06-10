export default function OperatorOverview() {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Live Operations</p>
        <h1>Signal Overview</h1>
        <p>Real-time view of active Media Flows, signal status, and operational alerts.</p>
      </div>
      <div className="panel text-center py-12">
        <p className="text-muted text-sm">Active Flows and Signal Status will appear here.</p>
        <p className="text-xs text-muted mt-2">Wired from NMOS IS-04/05 in Release 1.</p>
      </div>
    </div>
  )
}
