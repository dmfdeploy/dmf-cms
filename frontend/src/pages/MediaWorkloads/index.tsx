import { useMemo, useState } from 'react'
import { useClearForDeployment, useMediaWorkloads } from '../../api/hooks'
import MxlDetailPanel from './MxlDetailPanel'
import type { ClearForDeploymentResult, MediaWorkloadInstance } from '../../api/types'

/**
 * Media Workloads (ADR-0037): Media Function instance inventory from NetBox
 * with live status overlaid. MVP: count + placement, filter by function.
 * No flow graph, no composition canvas (ADR-0037 §8 deferrals).
 *
 * Hard gate 5: rows are keyed by stable instance identity and sorted
 * deterministically, so a poll that changes nothing semantic never reflows
 * the list. Desired (requested_state) and observed (observed_state) are
 * rendered as SEPARATE facts — intent is never shown as running.
 */

const requestedBadge: Record<string, string> = {
  active: 'bg-sky-900/30 text-sky-300',
  bootstrapped: 'bg-gray-900/30 text-gray-300',
  unknown: 'bg-gray-900/30 text-gray-400',
}

const observedBadge: Record<string, string> = {
  running: 'bg-green-900/30 text-green-300',
  failing: 'bg-red-900/30 text-red-300',
  unknown: 'bg-gray-900/30 text-gray-400',
}

export default function MediaWorkloads() {
  const { data, isLoading, error, refetch } = useMediaWorkloads()
  const [functionFilter, setFunctionFilter] = useState<string>('')
  // Graduated friction for the one consequential action (hard gate 3):
  // click arms a per-row confirm panel with an impact preview and a
  // mandatory reason (C5); nothing fires on the first click.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [lastResult, setLastResult] = useState<ClearForDeploymentResult | null>(null)
  // WP4: the retired MXL Flows page lives on as a per-instance live view.
  const [expanded, setExpanded] = useState<string | null>(null)
  const clearMutation = useClearForDeployment()

  const submitClear = (instance: string) => {
    clearMutation.mutate(
      { instance, reason: reason.trim() },
      {
        onSuccess: (result) => {
          setLastResult(result)
          setConfirming(null)
          setReason('')
          refetch()
        },
      },
    )
  }

  const instances = useMemo(() => {
    const rows = (data?.instances ?? []).filter(
      (i) => !functionFilter || i.function_key === functionFilter,
    )
    // Deterministic order by stable identity: unchanged data -> unchanged DOM.
    return [...rows].sort((a, b) => a.instance.localeCompare(b.instance))
  }, [data?.instances, functionFilter])

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Media Functions in operation</p>
        <h1>Media Workloads</h1>
        <p>
          Deployed Media Function instances — what is requested, how many, and where.
          Placement and requested state come from the facility source of truth; the
          running state is proven separately by live monitoring.
        </p>
      </div>

      {!isLoading && error != null && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Media Workloads could not be loaded: {String(error)}
        </div>
      )}

      {!isLoading && data && !data.configured && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Media Workloads is not configured for this environment (tenancy posture
          undeclared — set <span className="font-mono">DMF_CONSOLE_MEDIA_TENANCY</span>).
        </div>
      )}

      {!isLoading && data?.configured && data.degraded && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Inventory is degraded ({data.reason ?? 'unknown reason'}) — the facility
          source of truth is unreachable. Showing nothing rather than stale guesses.
        </div>
      )}

      {lastResult && (
        <div className="panel mt-6 border border-green-500/20 bg-green-500/10 px-4 py-3 text-sm text-green-200">
          <div className="font-semibold">
            {lastResult.instance}: requested state is now {lastResult.requested_state}
            {' '}(was {lastResult.previous_state})
          </div>
          <p className="mt-1 text-green-200/80">{lastResult.reconcile.expectation}</p>
          <p className="mt-1 text-xs text-green-200/60">
            Recorded: {lastResult.actor} ({lastResult.role}) · reason: “{lastResult.reason}” ·
            ref {lastResult.request_id}
          </p>
        </div>
      )}

      {data?.configured && !data.degraded && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <label className="text-sm text-muted" htmlFor="function-filter">
              Function
            </label>
            <select
              id="function-filter"
              className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm"
              value={functionFilter}
              onChange={(e) => setFunctionFilter(e.target.value)}
            >
              <option value="">All functions</option>
              {(data.functions ?? []).map((f) => (
                <option key={f.function_key} value={f.function_key}>
                  {f.function_key} ({f.running}/{f.count} running)
                </option>
              ))}
            </select>
            {Array.isArray(data.scope) && (
              <span className="text-xs text-muted">
                Scope: {data.scope.length > 0 ? data.scope.join(', ') : 'none'}
              </span>
            )}
          </div>

          {instances.length === 0 ? (
            <div className="panel mt-4 py-10 text-center text-sm text-muted">
              No Media Function instances
              {functionFilter ? ` for ${functionFilter}` : ''} in your scope.
            </div>
          ) : (
            <div className="panel mt-4 overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-3">Instance</th>
                    <th className="px-4 py-3">Function</th>
                    <th className="px-4 py-3">Node</th>
                    <th className="px-4 py-3">Requested</th>
                    <th className="px-4 py-3">Observed</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {instances.map((inst: MediaWorkloadInstance) => (
                    <tr key={inst.instance} className="border-b border-white/5">
                      <td className="px-4 py-3 font-mono text-xs">{inst.instance}</td>
                      <td className="px-4 py-3">
                        {inst.function_key ?? '—'}
                        {inst.function_key?.startsWith('mxl') && (
                          <button
                            className="btn btn-secondary btn-sm ml-2"
                            onClick={() =>
                              setExpanded(expanded === inst.instance ? null : inst.instance)
                            }
                          >
                            {expanded === inst.instance ? 'Hide live view' : 'Live view'}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3">{inst.placement.node ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`badge text-xs ${requestedBadge[inst.requested_state] ?? requestedBadge.unknown}`}
                          title="Requested state — intent recorded in the facility source of truth, not proof of running"
                        >
                          {inst.requested_state}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`badge text-xs ${observedBadge[inst.observed_state]}`}
                          title="Observed state — proven by live monitoring probes"
                        >
                          {inst.observed_state}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {inst.reconcile_pending ? (
                          'Waiting to converge'
                        ) : inst.requested_state === 'bootstrapped' ? (
                          confirming === inst.instance ? (
                            <div className="min-w-64 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100">
                              <div className="text-xs font-semibold">
                                Clear {inst.instance} for deployment?
                              </div>
                              <p className="mt-1 text-xs text-amber-200/80">
                                This records the intent to run in the facility source of
                                truth; the platform's automation lane will deploy it. The
                                console does not start anything directly.
                              </p>
                              <textarea
                                className="mt-2 w-full rounded border border-white/10 bg-black/20 p-1 text-xs text-text"
                                placeholder="Reason (required, recorded in the audit trail)"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                rows={2}
                              />
                              {clearMutation.isError && (
                                <p className="mt-1 text-xs text-red-300">
                                  {String(clearMutation.error)}
                                </p>
                              )}
                              <div className="mt-2 flex gap-2">
                                <button
                                  className="btn btn-primary btn-sm"
                                  disabled={!reason.trim() || clearMutation.isPending}
                                  onClick={() => submitClear(inst.instance)}
                                >
                                  {clearMutation.isPending ? 'Recording…' : 'Confirm'}
                                </button>
                                <button
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => {
                                    setConfirming(null)
                                    setReason('')
                                    clearMutation.reset()
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => {
                                setConfirming(inst.instance)
                                setLastResult(null)
                                clearMutation.reset()
                              }}
                            >
                              Clear for deployment
                            </button>
                          )
                        ) : (
                          ''
                        )}
                      </td>
                    </tr>
                  ))}
                  {expanded != null && (
                    <tr key="__mxl-live-view" className="border-b border-white/5">
                      <td colSpan={6} className="px-4 py-3">
                        <MxlDetailPanel />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
