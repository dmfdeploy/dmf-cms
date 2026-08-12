import { useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CatalogEntry } from '../../api/types'
import ReasonConfirm from '../../components/ReasonConfirm'
import { isValidWorkloadSlug } from '../../lib/workloadSlug'
import { settleQuery } from '../../lib/queryState'
import {
  useCatalog,
  useCurrentUser,
  useDeployCatalog,
  useTeardownCatalog,
  useCatalogJobStatus,
  useOperationStatus,
  isOperation,
} from '../../api/hooks'
import { useActivityStore } from '../../store/activity'

const lifecycleBadge: Record<string, string> = {
  bootstrapped: 'bg-muted/20 text-muted',
  active: 'bg-green-900/30 text-green-400',
  unknown: 'bg-gray-900/30 text-gray-400',
  error: 'bg-red-900/30 text-red-400',
}

interface EntryActionState {
  deployJobId: number | null
  teardownJobId: number | null
  deployOpId: string | null
  teardownOpId: string | null
}

export default function Catalog() {
  const queryClient = useQueryClient()
  // fix-round 7 (PR #81, umbrella #385, codex call-site sweep): retrofitted
  // onto settleQuery. This page's OWN bug, distinct from the isError-gating
  // shape the rest of this arc chases: `if (error)` below used to replace
  // the ENTIRE page with the error panel on ANY failed read, even a settled
  // refetch that retained a perfectly good `catalogData` — discarding real,
  // still-current entries (and the ability to deploy/tear them down) rather
  // than keeping the screen still with a notice (Art. 5), the opposite
  // direction from every other fix in this arc but the same root cause:
  // the CURRENT read's failure was never distinguished from "nothing to
  // show at all".
  const { data: catalogData, loading: isLoading, failed: isError } = settleQuery(useCatalog())
  const { data: user } = settleQuery(useCurrentUser())
  const deployMutation = useDeployCatalog()
  const teardownMutation = useTeardownCatalog()
  const recordAwxWrite = useActivityStore((s) => s.recordAwxWrite)
  const [entryActions, setEntryActions] = useState<Record<string, EntryActionState>>({})

  // Console-local Activity record for a consequential write (plan §4a: AWX
  // writes land in the Activity record "like clear does"). request_id + reason
  // come from the write; actor/role from the effective user (#185 WP-E P2-3).
  const record = (
    action: 'deploy' | 'teardown',
    key: string,
    reason: string,
    result: { request_id?: string; status?: string },
    outcome: string,
  ) =>
    recordAwxWrite({
      request_id: result.request_id ?? '',
      action,
      target: key,
      reason,
      actor: user?.subject ?? 'unknown',
      role: user?.role ?? 'unknown',
      outcome,
    })

  // umbrella #386 / WP-3 spec B2: THROW on failure, deliberately — see
  // ProvisionStage.tsx's handleDeploy for the full rationale. This page's
  // EntryCard had the identical onConfirm-then-close shape, found by the
  // sweep the umbrella issue calls for.
  const handleDeploy = async (entry: CatalogEntry, reason: string, workload?: string) => {
    const result = await deployMutation.mutateAsync({ key: entry.key, reason, workload })
    record('deploy', entry.key, reason, result, isOperation(result) ? 'dispatched' : result.status)
    if (isOperation(result)) {
      // Async flow (202): track the operation
      setEntryActions((prev) => ({
        ...prev,
        [entry.key]: { ...prev[entry.key], deployOpId: result.operation_id, deployJobId: null },
      }))
    } else {
      // Sync flow (200): immediate job_id
      setEntryActions((prev) => ({
        ...prev,
        [entry.key]: { ...prev[entry.key], deployJobId: result.job_id, deployOpId: null },
      }))
    }
  }

  const handleTeardown = async (entry: CatalogEntry, reason: string) => {
    const result = await teardownMutation.mutateAsync({ key: entry.key, reason })
    record('teardown', entry.key, reason, result, isOperation(result) ? 'dispatched' : result.status)
    if (isOperation(result)) {
      // Async flow (202): track the operation
      setEntryActions((prev) => ({
        ...prev,
        [entry.key]: { ...prev[entry.key], teardownOpId: result.operation_id, teardownJobId: null },
      }))
    } else {
      // Sync flow (200): immediate job_id
      setEntryActions((prev) => ({
        ...prev,
        [entry.key]: { ...prev[entry.key], teardownJobId: result.job_id, teardownOpId: null },
      }))
    }
  }

  const handleJobComplete = (key: string, kind: 'deploy' | 'teardown') => {
    setEntryActions((prev) => {
      const current = prev[key] ?? {}
      return {
        ...prev,
        [key]: {
          ...current,
          [kind === 'deploy' ? 'deployJobId' : 'teardownJobId']: null,
          [kind === 'deploy' ? 'deployOpId' : 'teardownOpId']: null,
        },
      }
    })
    void queryClient.invalidateQueries({ queryKey: ['catalog'] })
  }

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="panel text-center py-12">
          <p className="text-muted">Loading catalog…</p>
        </div>
      </div>
    )
  }

  if (isError && !catalogData) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="panel text-center py-12">
          {/* Art. 8: no stringified exception on an operator surface. This
              page is hidden from the sidebar but still reachable by URL, so
              "hidden" is not an exemption (GATE-S1-RV). No refetchInterval
              on useCatalog, so "Reload the page" is the true next step —
              same convention as ProvisionStage/FinaliseStage's own catalog-
              read-failure copy. */}
          <p className="text-red-400">
            The catalog could not be loaded right now. Reload the page to try again.
          </p>
        </div>
      </div>
    )
  }

  const entries = catalogData?.entries ?? []

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* A settled failed refetch retains `catalogData` from the earlier
          successful read (Art. 5 — the screen stays still, entries remain
          deployable/tearable-down) — but the CURRENT read did not confirm
          it, which must be visible too, not silently absent. */}
      {isError && (
        <div className="panel mb-4 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          The catalog could not be refreshed just now — showing the last successful read. Reload the page to try again.
        </div>
      )}
      {entries.length === 0 ? (
        <div className="panel text-center py-12">
          <p className="text-muted">No catalog entries found. Add YAML manifests to /etc/dmf-cms/catalog/.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 mt-6">
          {entries.map((entry) => (
            <EntryCard
              key={entry.key}
              entry={entry}
              actionState={entryActions[entry.key] ?? { deployJobId: null, teardownJobId: null, deployOpId: null, teardownOpId: null }}
              onDeploy={handleDeploy}
              onTeardown={handleTeardown}
              isDeploying={deployMutation.isPending && deployMutation.variables?.key === entry.key}
              isTearingDown={teardownMutation.isPending && teardownMutation.variables?.key === entry.key}
              deployError={deployMutation.variables?.key === entry.key ? deployMutation.error : null}
              teardownError={teardownMutation.variables?.key === entry.key ? teardownMutation.error : null}
              onJobComplete={handleJobComplete}
              setEntryActions={setEntryActions}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── per-entry card ─── */

function EntryCard({
  entry,
  actionState,
  onDeploy,
  onTeardown,
  isDeploying,
  isTearingDown,
  deployError,
  teardownError,
  onJobComplete,
  setEntryActions,
}: {
  entry: CatalogEntry
  actionState: EntryActionState
  onDeploy: (entry: CatalogEntry, reason: string, workload?: string) => Promise<void>
  onTeardown: (entry: CatalogEntry, reason: string) => Promise<void>
  isDeploying: boolean
  isTearingDown: boolean
  deployError: unknown
  teardownError: unknown
  onJobComplete: (key: string, kind: 'deploy' | 'teardown') => void
  setEntryActions: React.Dispatch<React.SetStateAction<Record<string, EntryActionState>>>
}) {
  const deployBadge = lifecycleBadge[entry.lifecycle] ?? 'bg-gray-900/30 text-gray-400'
  // Graduated friction (hard gate 3): the Deploy/Teardown buttons arm a
  // reason panel; the write fires only on Confirm with a non-empty reason.
  const [arming, setArming] = useState<'deploy' | 'teardown' | null>(null)
  // #239: optional workload tag, deploy-only (not teardown/launch). Empty is
  // valid (omitted from the request); a non-empty value must match the slug
  // rule or Confirm stays disabled.
  const [workload, setWorkload] = useState('')
  const workloadInvalid = workload.trim() !== '' && !isValidWorkloadSlug(workload.trim())

  // A job or operation is in-flight while its id is set (launch → cleared on completion).
  // Gate the buttons on this, not just the sub-second launch mutation
  // (isDeploying/isTearingDown), so they don't re-enable mid-job and invite a
  // double-click. The backend idempotency guard is the real defence; this is UX.
  const deployInFlight = actionState.deployJobId !== null || actionState.deployOpId !== null
  const teardownInFlight = actionState.teardownJobId !== null || actionState.teardownOpId !== null
  const deployDisabled =
    entry.lifecycle === 'active' || !entry.configure_awx_job_template || isDeploying || deployInFlight
  const teardownDisabled =
    entry.lifecycle === 'bootstrapped' || !entry.finalise_awx_job_template || isTearingDown || teardownInFlight

  return (
    <div className="panel">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h3 className="text-lg font-semibold">{entry.display_name}</h3>
            <span className={`badge text-xs ${deployBadge}`}>{entry.lifecycle}</span>
          </div>
          <p className="text-sm text-muted">{entry.summary}</p>
          {/* EBU layer/vertical/type ontology is expert-tier vocabulary (UX
              Constitution Art. 3) — collapsed behind an explicit affordance,
              never a default-level line. */}
          {(entry.ebu_layer || entry.ebu_vertical || entry.ebu_media_function_type || entry.ebu_lifecycle_owner) && (
            <details className="mt-1 text-xs text-muted">
              <summary className="cursor-pointer select-none opacity-80 hover:opacity-100">
                System details
              </summary>
              <p className="mt-1 pl-4">
                {entry.ebu_layer ? `EBU layer ${entry.ebu_layer}` : ''}
                {entry.ebu_layer && (entry.ebu_vertical || entry.ebu_media_function_type) ? ' · ' : ''}
                {entry.ebu_vertical ? <span className="capitalize">{entry.ebu_vertical}</span> : ''}
                {entry.ebu_media_function_type ? <span className="capitalize">{entry.ebu_media_function_type}</span> : ''}
                {(entry.ebu_layer || entry.ebu_vertical || entry.ebu_media_function_type) && entry.ebu_lifecycle_owner ? ' · ' : ''}
                {entry.ebu_lifecycle_owner ? <span className="capitalize">{entry.ebu_lifecycle_owner}</span> : ''}
              </p>
            </details>
          )}
        </div>

        <div className="flex gap-2 ml-4">
          {entry.lifecycle === 'active' && entry.ingress_url && (
            <a
              href={entry.ingress_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary btn-sm"
            >
              ↗ Open
            </a>
          )}
          <button
            onClick={() => setArming('deploy')}
            disabled={deployDisabled || arming !== null}
            className="btn btn-primary btn-sm"
          >
            {isDeploying ? '⏳ Launching…' : actionState.deployOpId ? '⏳ Waking…' : deployInFlight ? '⏳ Deploying…' : '▶ Deploy'}
          </button>
          <button
            onClick={() => setArming('teardown')}
            disabled={teardownDisabled || arming !== null}
            className="btn btn-secondary btn-sm"
          >
            {isTearingDown ? '⏳ Tearing down…' : actionState.teardownOpId ? '⏳ Waking…' : teardownInFlight ? '⏳ Tearing down…' : '⏏ Teardown'}
          </button>
        </div>
      </div>

      {arming === 'deploy' && (
        <div className="mt-3">
          <ReasonConfirm
            title={`Deploy ${entry.display_name}?`}
            description="Provisions this media function via its AWX job template. The action is operator-gated and recorded in the audit trail with your reason."
            confirmLabel="Confirm deploy"
            pendingLabel="Launching…"
            pending={isDeploying}
            error={deployError}
            onConfirm={(reason) => {
              // umbrella #386 / WP-3 spec B2: close ONLY on success — see
              // ProvisionStage.tsx's ProvisionEntry for the full rationale.
              // The typed workload value is kept on failure too, so a retry
              // doesn't make the operator retype it.
              void (async () => {
                try {
                  await onDeploy(entry, reason, workload.trim() || undefined)
                  setArming(null)
                  setWorkload('')
                } catch {
                  // Stay armed — deployError renders the failure here.
                }
              })()
            }}
            onCancel={() => { setArming(null); setWorkload('') }}
            extraField={{
              label: 'Workload (optional)',
              placeholder: 'e.g. studio-a',
              helperText: 'Groups this deploy under a named workload in Media Workloads',
              value: workload,
              onChange: setWorkload,
              invalid: workloadInvalid,
              invalidHint: 'Lowercase letters, numbers, and hyphens only (not at the ends), max 40 characters',
            }}
          />
        </div>
      )}
      {arming === 'teardown' && (
        <div className="mt-3">
          <ReasonConfirm
            title={`Teardown ${entry.display_name}?`}
            description="Finalises this media function via its AWX teardown template. The action is operator-gated and recorded in the audit trail with your reason."
            confirmLabel="Confirm teardown"
            pendingLabel="Tearing down…"
            pending={isTearingDown}
            error={teardownError}
            onConfirm={(reason) => {
              // umbrella #386 / WP-3 spec B2: close ONLY on success.
              void (async () => {
                try {
                  await onTeardown(entry, reason)
                  setArming(null)
                } catch {
                  // Stay armed — teardownError renders the failure here.
                }
              })()
            }}
            onCancel={() => setArming(null)}
          />
        </div>
      )}

      {entry.dependencies && entry.dependencies.length > 0 && (
        <div className="mt-3 pt-3 border-t border-muted/10">
          <span className="text-xs text-muted">Dependencies: </span>
          <span className="text-xs font-mono text-accent">{entry.dependencies.join(', ')}</span>
        </div>
      )}

      {/* Deploy operation status */}
      {actionState.deployOpId != null && (
        <div className="mt-3 pt-3 border-t border-muted/10">
          <OperationStatusLine
            key={`deploy-op-${actionState.deployOpId}`}
            entryKey={entry.key}
            operationId={actionState.deployOpId}
            kind="deploy"
            onLaunched={(jobId) => {
              setEntryActions((prev) => ({
                ...prev,
                [entry.key]: { ...prev[entry.key], deployOpId: null, deployJobId: jobId },
              }))
            }}
            onError={() => {
              setEntryActions((prev) => ({
                ...prev,
                [entry.key]: { ...prev[entry.key], deployOpId: null },
              }))
            }}
          />
        </div>
      )}

      {/* Teardown operation status */}
      {actionState.teardownOpId != null && (
        <div className="mt-3 pt-3 border-t border-muted/10">
          <OperationStatusLine
            key={`teardown-op-${actionState.teardownOpId}`}
            entryKey={entry.key}
            operationId={actionState.teardownOpId}
            kind="teardown"
            onLaunched={(jobId) => {
              setEntryActions((prev) => ({
                ...prev,
                [entry.key]: { ...prev[entry.key], teardownOpId: null, teardownJobId: jobId },
              }))
            }}
            onError={() => {
              setEntryActions((prev) => ({
                ...prev,
                [entry.key]: { ...prev[entry.key], teardownOpId: null },
              }))
            }}
          />
        </div>
      )}

      {/* Deploy job status */}
      {actionState.deployJobId != null && (
        <div className="mt-3 pt-3 border-t border-muted/10">
          <JobStatusLine
            key={`deploy-${actionState.deployJobId}`}
            entryKey={entry.key}
            jobId={actionState.deployJobId}
            kind="deploy"
            onComplete={onJobComplete}
          />
        </div>
      )}

      {/* Teardown job status */}
      {actionState.teardownJobId != null && (
        <div className="mt-3 pt-3 border-t border-muted/10">
          <JobStatusLine
            key={`teardown-${actionState.teardownJobId}`}
            entryKey={entry.key}
            jobId={actionState.teardownJobId}
            kind="teardown"
            onComplete={onJobComplete}
          />
        </div>
      )}
    </div>
  )
}

/* ─── operation status line (polls via hook) ─── */

function OperationStatusLine({
  operationId,
  onLaunched,
  onError,
}: {
  // entryKey + kind are part of the call-site contract (passed by every caller)
  // but the status line keys off operationId / operation.state; accept them in
  // the type, don't bind them here.
  entryKey: string
  operationId: string
  kind: 'deploy' | 'teardown'
  onLaunched: (jobId: number) => void
  onError: () => void
}) {
  // fix-round 6 (PR #81, umbrella #385 codex sweep): a settled failed
  // refetch retained the last-good `operation` with no notice at all —
  // `failed` distinguishes that from a genuinely fresh read.
  const { data: operation, failed } = settleQuery(useOperationStatus(operationId))

  useEffect(() => {
    if (!operation) return

    let timer: ReturnType<typeof setTimeout> | undefined

    if (operation.state === 'launched' && operation.job_id) {
      timer = setTimeout(() => onLaunched(operation.job_id!), 1000)
    } else if (operation.state === 'error') {
      console.error('Operation failed:', operation.error)
      timer = setTimeout(() => onError(), 3000)
    }

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [operation, onLaunched, onError])

  if (!operation) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>{failed ? 'Could not query operation status — retrying automatically' : 'Querying operation status…'}</span>
      </div>
    )
  }

  // umbrella #347: Record<string, string> (not an inferred 4-key literal) —
  // Operation.state now spans the full #202 WP2 watched-action vocabulary
  // (run_complete/run_failed/…), which this pre-existing widget never
  // switched over to observing; the fallback below keeps it honest about an
  // unrecognized value instead of rendering `undefined`.
  const STATE_LABEL: Record<string, string> = {
    waking: 'Waking AWX',
    launching: 'Launching job',
    launched: 'Launched',
    error: 'Error',
  }
  const stateLabel = STATE_LABEL[operation.state] ?? operation.state

  const STATE_CLASS: Record<string, string> = {
    waking: 'text-yellow-300',
    launching: 'text-blue-300',
    launched: 'text-green-400',
    error: 'text-red-400',
  }
  const stateClass = STATE_CLASS[operation.state] ?? 'text-muted'

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono">op {operationId.slice(0, 8)}...</span>
      <span className={`font-medium ${stateClass}`}>
        {operation.state === 'waking' && '🔄 '}
        {operation.state === 'launching' && '⟳ '}
        {stateLabel}
      </span>
      {operation.error && (
        <span className="text-red-400">{operation.error}</span>
      )}
      {failed && (
        <span className="text-amber-300">Could not confirm — showing the last read, retrying</span>
      )}
    </div>
  )
}

/* ─── job status line (polls via hook) ─── */

function JobStatusLine({
  entryKey,
  jobId,
  kind,
  onComplete,
}: {
  entryKey: string
  jobId: number
  kind: 'deploy' | 'teardown'
  onComplete: (key: string, kind: 'deploy' | 'teardown') => void
}) {
  // fix-round 6: same shape as OperationStatusLine above.
  const { data: jobStatus, failed } = settleQuery(useCatalogJobStatus(entryKey, jobId))

  useEffect(() => {
    if (!jobStatus?.is_done) return

    const timer = setTimeout(() => onComplete(entryKey, kind), 2000)
    return () => clearTimeout(timer)
  }, [jobStatus?.is_done, onComplete, entryKey, kind])

  if (!jobStatus) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>{failed ? 'Could not query job status — retrying automatically' : 'Querying job status…'}</span>
      </div>
    )
  }

  const statusLabel = jobStatus.status.charAt(0).toUpperCase() + jobStatus.status.slice(1)
  const statusClass =
    {
      new: 'text-blue-300',
      pending: 'text-yellow-300',
      waiting: 'text-yellow-300',
      running: 'text-blue-300',
      successful: 'text-green-400',
      failed: 'text-red-400',
      error: 'text-red-400',
      canceled: 'text-gray-400',
    }[jobStatus.status] ?? 'text-muted'

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono">job #{jobId}</span>
      <span className={`font-medium ${statusClass}`}>
        {jobStatus.status === 'running' ? '⟳ ' : ''}
        {statusLabel}
      </span>
      {failed && (
        <span className="text-amber-300">Could not confirm — showing the last read, retrying</span>
      )}
    </div>
  )
}
