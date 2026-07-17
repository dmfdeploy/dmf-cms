import { useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CatalogEntry } from '../../api/types'
import ReasonConfirm from '../../components/ReasonConfirm'
import { isValidWorkloadSlug } from '../../lib/workloadSlug'
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
  const { data: catalogData, isLoading, error } = useCatalog()
  const { data: user } = useCurrentUser()
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

  const handleDeploy = async (entry: CatalogEntry, reason: string, workload?: string) => {
    try {
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
    } catch (e) {
      console.error('Deploy failed:', e)
    }
  }

  const handleTeardown = async (entry: CatalogEntry, reason: string) => {
    try {
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
    } catch (e) {
      console.error('Teardown failed:', e)
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

  if (error) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="panel text-center py-12">
          <p className="text-red-400">Failed to load catalog: {String(error)}</p>
        </div>
      </div>
    )
  }

  const entries = catalogData?.entries ?? []

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Service Catalog</p>
        <h1>Media Functions</h1>
        <p>
          Registered catalog entries with deployment status. Deploy and teardown entries via
          AWX job templates.
        </p>
      </div>

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
  onDeploy: (entry: CatalogEntry, reason: string, workload?: string) => void
  onTeardown: (entry: CatalogEntry, reason: string) => void
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
              onDeploy(entry, reason, workload.trim() || undefined)
              setArming(null)
              setWorkload('')
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
            onConfirm={(reason) => { onTeardown(entry, reason); setArming(null) }}
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
  const { data: operation } = useOperationStatus(operationId)

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
        <span>Querying operation status…</span>
      </div>
    )
  }

  const stateLabel = {
    waking: 'Waking AWX',
    launching: 'Launching job',
    launched: 'Launched',
    error: 'Error',
  }[operation.state]

  const stateClass = {
    waking: 'text-yellow-300',
    launching: 'text-blue-300',
    launched: 'text-green-400',
    error: 'text-red-400',
  }[operation.state]

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
  const { data: jobStatus } = useCatalogJobStatus(entryKey, jobId)

  useEffect(() => {
    if (!jobStatus?.is_done) return
    
    const timer = setTimeout(() => onComplete(entryKey, kind), 2000)
    return () => clearTimeout(timer)
  }, [jobStatus?.is_done, onComplete, entryKey, kind])

  if (!jobStatus) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>Querying job status…</span>
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
    </div>
  )
}
