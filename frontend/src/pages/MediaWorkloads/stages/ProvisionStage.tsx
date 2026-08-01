import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  isOperation,
  useCatalog,
  useCurrentUser,
  useDeployCatalog,
} from '../../../api/hooks'
import { useActivityStore } from '../../../store/activity'
import ReasonConfirm from '../../../components/ReasonConfirm'
import { isValidWorkloadSlug } from '../../../lib/workloadSlug'
import type { CatalogEntry, MediaWorkload , ClearForDeploymentResult} from '../../../api/types'
import type { StageActionId, StageState } from '../../../lib/workloadLifecycle'
import ClearForDeployment from '../ClearForDeployment'
import StageCard from './StageCard'
import { JobStatusLine, OperationStatusLine } from './JobProgress'

/**
 * Provision — the deploy action, relocated from pages/Catalog/index.tsx
 * (useDeployCatalog, the ReasonConfirm arming pattern, the workload slug
 * field) PLUS its launch job progress/outcome (JobStatusLine /
 * OperationStatusLine, also relocated). This is the hard precondition for
 * hiding Activity from the sidebar: the deploy feedback loop must land
 * here or it goes dark.
 *
 * One catalog entry can carry its own in-flight job at a time; `busy`
 * aggregates across every entry this workload owns and is reported up so
 * the rail's `launching` overlay — and therefore every OTHER stage's
 * suppression of its own actions — reflects reality the instant a job
 * starts, not just once this component's local state has settled.
 */
interface EntryTrack {
  jobId: number | null
  opId: string | null
}

const EMPTY_TRACK: EntryTrack = { jobId: null, opId: null }

export default function ProvisionStage({
  workload,
  state,
  actions,
  onBusyChange,
}: {
  workload: MediaWorkload
  state: StageState
  actions: StageActionId[]
  onBusyChange: (busy: boolean) => void
}) {
  const { data: catalogData, isLoading: catalogLoading } = useCatalog()
  const { data: user } = useCurrentUser()
  const deployMutation = useDeployCatalog()
  const recordAwxWrite = useActivityStore((s) => s.recordAwxWrite)
  const queryClient = useQueryClient()

  const [track, setTrack] = useState<Record<string, EntryTrack>>({})

  // GATE-S1-RV P1: clear is a write like any other, so its pending state
  // joins the SAME channel. Keyed per instance because sibling clears must
  // suppress each other too, not just themselves.
  const [clearPending, setClearPending] = useState<Record<string, boolean>>({})
  const busy =
    deployMutation.isPending ||
    Object.values(track).some((t) => t.jobId !== null || t.opId !== null) ||
    Object.values(clearPending).some(Boolean)
  useEffect(() => onBusyChange(busy), [busy, onBusyChange])

  const functionKeys = workload.functions.map((f) => f.function_key)
  const entries = (catalogData?.entries ?? []).filter((e) => functionKeys.includes(e.key))

  const allowed = actions.includes('deploy')
  // GATE-S1 P1: clear-for-deployment is a PROVISION-time action and now flows
  // through the rail like every other write. It used to render on Finalise
  // outside the model entirely — firing during another stage's job, and even
  // while Finalise itself was not-applicable.
  const mayClear = actions.includes('clear-for-deployment')
  const [lastClearResult, setLastClearResult] = useState<ClearForDeploymentResult | null>(null)
  const needsClearing = [...workload.instances]
    .filter((i) => !i.reconcile_pending && i.requested_state === 'bootstrapped')
    .sort((a, b) => a.instance.localeCompare(b.instance))

  const handleDeploy = async (entry: CatalogEntry, reason: string, workloadSlug: string) => {
    try {
      const result = await deployMutation.mutateAsync({ key: entry.key, reason, workload: workloadSlug || undefined })
      recordAwxWrite({
        request_id: result.request_id ?? '',
        action: 'deploy',
        target: entry.key,
        reason,
        actor: user?.subject ?? 'unknown',
        role: user?.role ?? 'unknown',
        outcome: isOperation(result) ? 'dispatched' : result.status,
      })
      setTrack((prev) => ({
        ...prev,
        [entry.key]: isOperation(result)
          ? { jobId: null, opId: result.operation_id }
          : { jobId: result.job_id, opId: null },
      }))
    } catch (e) {
      console.error('Deploy failed:', e)
    }
  }

  const handleJobComplete = (key: string) => {
    setTrack((prev) => ({ ...prev, [key]: EMPTY_TRACK }))
    void queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })
    void queryClient.invalidateQueries({ queryKey: ['catalog'] })
  }

  if (state === 'not-applicable') {
    return (
      <StageCard label="Provision" state={state}>
        <p className="text-muted">
          The workload&apos;s stage couldn&apos;t be determined, so Provision has nothing
          honest to show yet.
        </p>
      </StageCard>
    )
  }

  return (
    <StageCard label="Provision" state={state}>
      {entries.length === 0 ? (
        <p className="text-muted">
          {catalogLoading
            ? 'Loading template information…'
            : "No catalog templates matched this workload's functions."}
        </p>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <ProvisionEntry
              key={entry.key}
              entry={entry}
              workloadSlug={workload.slug}
              // Rail-wide: ANY write in flight on this stage — a deploy, a
              // clear, a sibling's clear — withdraws every other write,
              // not just the one that owns its own job track.
              allowed={allowed && !busy}
              track={track[entry.key] ?? EMPTY_TRACK}
              isDeploying={deployMutation.isPending && deployMutation.variables?.key === entry.key}
              deployError={deployMutation.variables?.key === entry.key ? deployMutation.error : null}
              onDeploy={(reason, ws) => handleDeploy(entry, reason, ws)}
              onOpLaunched={(jobId) => setTrack((prev) => ({ ...prev, [entry.key]: { jobId, opId: null } }))}
              onOpError={() => setTrack((prev) => ({ ...prev, [entry.key]: EMPTY_TRACK }))}
              onJobComplete={() => handleJobComplete(entry.key)}
            />
          ))}
        </div>
      )}
      {mayClear && !busy && needsClearing.length > 0 && (
        <div className="mt-4 border-t border-white/5 pt-3">
          <h3 className="text-xs uppercase tracking-wide text-muted">Desired state</h3>
          <div className="mt-2 space-y-2">
            {needsClearing.map((inst) => (
              <div key={inst.instance} className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs text-muted">{inst.instance}</span>
                <ClearForDeployment
                  instance={inst.instance}
                  onCleared={(result) => setLastClearResult(result)}
                  onPendingChange={(pending) =>
                    setClearPending((prev) =>
                      prev[inst.instance] === pending
                        ? prev
                        : { ...prev, [inst.instance]: pending },
                    )
                  }
                />
              </div>
            ))}
          </div>
          {lastClearResult && (
            <p className="mt-2 text-xs text-green-300">
              {lastClearResult.instance}: requested state is now {lastClearResult.requested_state} (was{' '}
              {lastClearResult.previous_state}).
            </p>
          )}
        </div>
      )}
    </StageCard>
  )
}

function ProvisionEntry({
  entry,
  workloadSlug,
  allowed,
  track,
  isDeploying,
  deployError,
  onDeploy,
  onOpLaunched,
  onOpError,
  onJobComplete,
}: {
  entry: CatalogEntry
  workloadSlug: string
  allowed: boolean
  track: EntryTrack
  isDeploying: boolean
  deployError: unknown
  onDeploy: (reason: string, workloadSlug: string) => void
  onOpLaunched: (jobId: number) => void
  onOpError: () => void
  onJobComplete: () => void
}) {
  const [arming, setArming] = useState(false)
  const [workload, setWorkload] = useState(workloadSlug)
  const workloadInvalid = workload.trim() !== '' && !isValidWorkloadSlug(workload.trim())
  const inFlight = track.jobId !== null || track.opId !== null

  return (
    <div className="border-t border-white/5 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium text-text">{entry.display_name}</div>
          <p className="text-xs text-muted">{entry.summary}</p>
        </div>
        {/* Never a disabled button: the deploy affordance is either offered
            (allowed, not already active, nothing in flight) or absent —
            "already deployed" and "not offered right now" both render as
            prose below instead. */}
        {allowed && !inFlight && entry.lifecycle !== 'active' && !arming && (
          <button className="btn btn-primary btn-sm shrink-0" onClick={() => setArming(true)}>
            ▶ Deploy
          </button>
        )}
      </div>

      {entry.lifecycle === 'active' && !inFlight && (
        <p className="mt-1 text-xs text-muted">Already deployed.</p>
      )}
      {entry.lifecycle !== 'active' && !allowed && !inFlight && (
        <p className="mt-1 text-xs text-muted">
          Provision isn&apos;t currently offering to deploy this template — see the rail
          state above.
        </p>
      )}

      {arming && (
        <div className="mt-2">
          <ReasonConfirm
            title={`Deploy ${entry.display_name}?`}
            description="Provisions this media function via its AWX job template. The action is operator-gated and recorded in the audit trail with your reason."
            confirmLabel="Confirm deploy"
            pendingLabel="Launching…"
            pending={isDeploying}
            error={deployError}
            onConfirm={(reason) => {
              onDeploy(reason, workload.trim())
              setArming(false)
            }}
            onCancel={() => setArming(false)}
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

      {track.opId != null && (
        <div className="mt-2">
          <OperationStatusLine operationId={track.opId} onLaunched={onOpLaunched} onError={onOpError} />
        </div>
      )}
      {track.jobId != null && (
        <div className="mt-2">
          <JobStatusLine entryKey={entry.key} jobId={track.jobId} onComplete={onJobComplete} />
        </div>
      )}
    </div>
  )
}
