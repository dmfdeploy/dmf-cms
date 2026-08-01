import { useEffect, useState } from 'react'
import { useMxlStatus } from '../../api/hooks'
import { useDocumentVisible, usePrefersReducedMotion } from './liveView'

/**
 * MXL live view — the per-instance detail panel that replaces the standalone
 * MXL Flows page (#173 WP4). Reuses the status-sidecar fan-out unchanged
 * (GET /api/mxl/status aggregating each node's :9000 sidecar, preview.jpg
 * proxy): endpoint config stays DMF_CONSOLE_MXL_ENDPOINTS, degradation
 * stays graceful — unconfigured/unreachable render as explicit states.
 * Mounted only while a row is expanded, so the fast poll (kept from the
 * original page so the grain counter visibly ticks) costs nothing otherwise.
 *
 * The SAME bounds as every other preview surface apply here (GATE-S1-RV P2):
 * a hidden tab pauses both the query and the cache-bust tick, and
 * prefers-reduced-motion stops the churn. This path used to honour neither,
 * which made "bounds are universal" false for exactly the fallback nobody
 * looks at.
 */
export default function MxlDetailPanel() {
  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const active = visible && !reducedMotion
  const { data, isLoading } = useMxlStatus({ active })

  // Cache-bust the preview ~5/s so the clock overlay visibly ticks.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => (t + 1) % 100000), 200)
    return () => clearInterval(id)
  }, [active])

  // Paused is its own state, and it must be checked BEFORE the
  // configured/unreachable branches. With the query disabled there is no
  // payload, and reading "no data" as "not configured" told the operator
  // something false about their environment (GATE-S1-RV2 P2). If we hold a
  // cached frame we keep showing it, honestly labelled; if we never had one,
  // we say we are paused — not that the feature is missing.
  if (!active && !data) {
    return (
      <p className="text-sm text-muted">
        Live view is paused — this tab is in the background, or reduced motion
        is enabled. It resumes automatically.
      </p>
    )
  }

  if (isLoading) {
    return <div className="p-4 text-sm text-muted">Loading live view…</div>
  }

  if (!data?.configured) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
        Live view endpoints are not configured for this environment
        (set <span className="font-mono">DMF_CONSOLE_MXL_ENDPOINTS</span>).
      </div>
    )
  }

  const nodes = data.nodes ?? []
  const flow = data.flow ?? {}
  const receiver = nodes.find((n) => n.role === 'receiver')
  const headIndex = flow.head_index != null ? Number(flow.head_index).toLocaleString() : '—'
  const latency =
    flow.latency_ms != null
      ? `${Number(flow.latency_ms).toFixed(1)} ms${flow.latency_grains != null ? ` / ${flow.latency_grains} grains` : ''}`
      : '—'

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-4">
      {!data.reachable && (
        <div className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          No live-status sidecar is reachable right now.
        </div>
      )}
      <div className="flex flex-wrap gap-4">
        <div className="min-w-56 flex-1">
          <div className="text-xs uppercase tracking-wide text-muted">Nodes</div>
          {nodes.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No nodes reporting.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {nodes.map((n) => (
                <li key={n.role} className="flex items-center gap-2">
                  <span className="capitalize">{n.role}</span>
                  <span className="text-xs text-muted">{n.provider}</span>
                  <span className="text-xs text-muted">
                    {n.mxl_version ? `mxl ${n.mxl_version}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 text-xs uppercase tracking-wide text-muted">Flow</div>
          <p className="mt-1 text-sm">
            head index <span className="font-mono">{headIndex}</span>
            <span className="text-muted"> · latency {latency}</span>
          </p>
        </div>
        {receiver && data.reachable && (
          <div>
            <div className="text-xs uppercase tracking-wide text-muted">Received output</div>
            <img
              src={`/api/mxl/preview/receiver?t=${tick}`}
              alt="Live preview of the received flow"
              className="mt-1 h-36 rounded-md border border-white/10"
            />
          </div>
        )}
      </div>
    </div>
  )
}
