import { useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CatalogEntry } from '../../api/types'
import {
  useCatalog,
  useDeployCatalog,
  useTeardownCatalog,
  useCatalogJobStatus,
  useOperationStatus,
  isOperation,
} from '../../api/hooks'

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
  const deployMutation = useDeployCatalog()
  const teardownMutation = useTeardownCatalog()
  const [entryActions, setEntryActions] = useState<Record<string, EntryActionState>>({})

  const handleDeploy = async (entry: CatalogEntry) => {
    try {
      const result = await deployMutation.mutateAsync(entry.key)
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

  const handleTeardown = async (entry: CatalogEntry) => {
    try {
      const result = await teardownMutation.mutateAsync(entry.key)
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
          Registered catalog entries with lifecycle status. Deploy and teardown entries via
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
              isDeploying={deployMutation.isPending && deployMutation.variables === entry.key}
              isTearingDown={teardownMutation.isPending && teardownMutation.variables === entry.key}
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
  onJobComplete,
  setEntryActions,
}: {
  entry: CatalogEntry
  actionState: EntryActionState
  onDeploy: (entry: CatalogEntry) => void
  onTeardown: (entry: CatalogEntry) => void
  isDeploying: boolean
  isTearingDown: boolean
  onJobComplete: (key: string, kind: 'deploy' | 'teardown') => void
  setEntryActions: React.Dispatch<React.SetStateAction<Record<string, EntryActionState>>>
}) {
  const deployBadge = lifecycleBadge[entry.lifecycle] ?? 'bg-gray-900/30 text-gray-400'

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
          {(entry.ebu_layer || entry.ebu_vertical || entry.ebu_lifecycle_owner) && (
            <p className="text-xs text-muted mt-1">
              {entry.ebu_layer ? `Layer ${entry.ebu_layer}` : ''}
              {entry.ebu_layer && entry.ebu_vertical ? ' · ' : ''}
              {entry.ebu_vertical ? <span className="capitalize">{entry.ebu_vertical}</span> : ''}
              {(entry.ebu_layer || entry.ebu_vertical) && entry.ebu_lifecycle_owner ? ' · ' : ''}
              {entry.ebu_lifecycle_owner ? <span className="capitalize">{entry.ebu_lifecycle_owner}</span> : ''}
            </p>
          )}
        </div>

        <div className="flex gap-2 ml-4">
          <button
            onClick={() => onDeploy(entry)}
            disabled={deployDisabled}
            className="btn btn-primary btn-sm"
          >
            {isDeploying ? '⏳ Launching…' : actionState.deployOpId ? '⏳ Waking…' : deployInFlight ? '⏳ Deploying…' : '▶ Deploy'}
          </button>
          <button
            onClick={() => onTeardown(entry)}
            disabled={teardownDisabled}
            className="btn btn-secondary btn-sm"
          >
            {isTearingDown ? '⏳ Tearing down…' : actionState.teardownOpId ? '⏳ Waking…' : teardownInFlight ? '⏳ Tearing down…' : '⏏ Teardown'}
          </button>
        </div>
      </div>

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
