import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  isOperation,
  useCatalog,
  useCurrentUser,
  useTeardownCatalog,
} from '../../../api/hooks'
import { useActivityStore } from '../../../store/activity'
import ReasonConfirm from '../../../components/ReasonConfirm'
import ClearForDeployment from '../ClearForDeployment'
import type { CatalogEntry, ClearForDeploymentResult, MediaWorkload, SwitchSourceResult } from '../../../api/types'
import type { StageActionId, StageState } from '../../../lib/workloadLifecycle'
import StageCard from './StageCard'
import { JobStatusLine, OperationStatusLine } from './JobProgress'

/**
 * Finalise & Review — the teardown action, relocated from
 * pages/Catalog/index.tsx (useTeardownCatalog, the same ReasonConfirm
 * arming pattern) PLUS the review: the last teardown job's outcome, and
 * the last switch's structured DMF_L3_SWITCH_OUTCOME marker (surfaced
 * already, by the backend, as SwitchSourceResult.outcome/outcome_message —
 * dmf-runbooks 0.4.4 contract). No generated stats report — that's S4.
 *
 * ClearForDeployment (unmodified, imported from the sibling file) is "the
 * related NetBox desired-state control" the spec names alongside teardown:
 * a different write seam (flips NetBox intent, not an AWX job) that
 * belongs in the same neighbourhood because both stages here govern this
 * workload's desired-state record, not its running processes.
 */
interface EntryTrack {
  jobId: number | null
  opId: string | null
}

const EMPTY_TRACK: EntryTrack = { jobId: null, opId: null }

export default function FinaliseStage({
  workload,
  state,
  actions,
  onBusyChange,
  lastSwitchResult,
}: {
  workload: MediaWorkload
  state: StageState
  actions: StageActionId[]
  onBusyChange: (busy: boolean) => void
  lastSwitchResult: SwitchSourceResult | null
}) {
  const { data: catalogData, isLoading: catalogLoading } = useCatalog()
  const { data: user } = useCurrentUser()
  const teardownMutation = useTeardownCatalog()
  const recordAwxWrite = useActivityStore((s) => s.recordAwxWrite)
  const queryClient = useQueryClient()

  const [track, setTrack] = useState<Record<string, EntryTrack>>({})
  const [lastJob, setLastJob] = useState<{ entryKey: string; jobId: number; status: string } | null>(null)
  const [lastClearResult, setLastClearResult] = useState<ClearForDeploymentResult | null>(null)

  // Read at call time inside the stable callback below (see
  // statusCallbackFor), never captured at render time — track changes
  // independently of the poll tick that reports a status.
  const trackRef = useRef(track)
  trackRef.current = track

  // Bail out to the SAME object when nothing changed (load-bearing, not
  // cosmetic — see ConfigureStage's identical note): JobStatusLine's effect
  // depends on onStatusChange's identity, so an unconditional new object
  // here would re-render this component every poll tick even when the
  // status hasn't moved, recreating the callback and re-firing the effect
  // in a tight loop.
  const setLastJobIfChanged = useCallback(
    (next: { entryKey: string; jobId: number; status: string }) => {
      setLastJob((prev) =>
        prev && prev.entryKey === next.entryKey && prev.jobId === next.jobId && prev.status === next.status
          ? prev
          : next,
      )
    },
    [],
  )

  // A STABLE callback per catalog entry (cached across renders) — the same
  // infinite-loop defence as ConfigureStage's pendingCallbackFor, applied to
  // JobStatusLine's onStatusChange instead of the switch control's pending
  // flag.
  const statusCallbacks = useRef(new Map<string, (status: string) => void>())
  const statusCallbackFor = useCallback(
    (entryKey: string) => {
      let cb = statusCallbacks.current.get(entryKey)
      if (!cb) {
        cb = (status: string) => {
          const jobId = trackRef.current[entryKey]?.jobId
          if (jobId != null) setLastJobIfChanged({ entryKey, jobId, status })
        }
        statusCallbacks.current.set(entryKey, cb)
      }
      return cb
    },
    [setLastJobIfChanged],
  )

  const onCleared = (result: ClearForDeploymentResult) => {
    setLastClearResult(result)
    void queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })
  }

  const busy =
    teardownMutation.isPending ||
    Object.values(track).some((t) => t.jobId !== null || t.opId !== null)
  useEffect(() => onBusyChange(busy), [busy, onBusyChange])

  const functionKeys = workload.functions.map((f) => f.function_key)
  const entries = (catalogData?.entries ?? []).filter((e) => functionKeys.includes(e.key))

  const allowed = actions.includes('tear-down')

  const handleTeardown = async (entry: CatalogEntry, reason: string) => {
    try {
      const result = await teardownMutation.mutateAsync({ key: entry.key, reason })
      recordAwxWrite({
        request_id: result.request_id ?? '',
        action: 'teardown',
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
      console.error('Teardown failed:', e)
    }
  }

  const handleJobComplete = (key: string) => {
    setTrack((prev) => ({ ...prev, [key]: EMPTY_TRACK }))
    void queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })
    void queryClient.invalidateQueries({ queryKey: ['catalog'] })
  }

  return (
    <StageCard label="Finalise & Review" state={state}>
      <div className="space-y-4">
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted">Teardown</h3>
          {state === 'not-applicable' ? (
            <p className="mt-1 text-muted">Nothing is running yet, so there is nothing to tear down.</p>
          ) : entries.length === 0 ? (
            <p className="mt-1 text-muted">
              {catalogLoading
                ? 'Loading template information…'
                : "No catalog templates matched this workload's functions."}
            </p>
          ) : (
            <div className="mt-2 space-y-3">
              {entries.map((entry) => {
                const entryTrack = track[entry.key] ?? EMPTY_TRACK
                return (
                  <FinaliseEntry
                    key={entry.key}
                    entry={entry}
                    allowed={allowed}
                    track={entryTrack}
                    isTearingDown={teardownMutation.isPending && teardownMutation.variables?.key === entry.key}
                    teardownError={teardownMutation.variables?.key === entry.key ? teardownMutation.error : null}
                    onTeardown={(reason) => handleTeardown(entry, reason)}
                    onOpLaunched={(jobId) => setTrack((prev) => ({ ...prev, [entry.key]: { jobId, opId: null } }))}
                    onOpError={() => setTrack((prev) => ({ ...prev, [entry.key]: EMPTY_TRACK }))}
                    onStatusChange={statusCallbackFor(entry.key)}
                    onJobComplete={() => handleJobComplete(entry.key)}
                  />
                )
              })}
            </div>
          )}
        </div>

        {/* The related NetBox desired-state control (ClearForDeployment).
            Deliberately independent of the rail's `state`/`allowed` gate
            above: it is a different write seam the lifecycle module doesn't
            model at all (a raw NetBox intent flip, not an AWX job, and not
            one of the three StageActionIds), and it is MOST needed exactly
            when Finalise's own action is not-applicable — before anything
            has run. Renders only for instances that actually need it
            (bootstrapped, not reconciling), never a dead control for the
            common case where nothing needs clearing. */}
        {workload.instances.some((i) => !i.reconcile_pending && i.requested_state === 'bootstrapped') && (
          <div className="border-t border-white/5 pt-3">
            <h3 className="text-xs uppercase tracking-wide text-muted">Desired state</h3>
            <div className="mt-2 space-y-2">
              {[...workload.instances]
                .filter((i) => !i.reconcile_pending && i.requested_state === 'bootstrapped')
                .sort((a, b) => a.instance.localeCompare(b.instance))
                .map((inst) => (
                  <div key={inst.instance} className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs text-muted">{inst.instance}</span>
                    <ClearForDeployment instance={inst.instance} onCleared={onCleared} />
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

        <div className="border-t border-white/5 pt-3">
          <h3 className="text-xs uppercase tracking-wide text-muted">Review</h3>
          {!lastJob && !lastSwitchResult ? (
            <p className="mt-1 text-muted">No teardown or switch has run yet in this session.</p>
          ) : (
            <div className="mt-1 space-y-2">
              {lastJob && (
                <p className="text-xs text-muted">
                  Last job: <span className="font-mono">#{lastJob.jobId}</span> ({lastJob.entryKey}) —{' '}
                  {lastJob.status}
                </p>
              )}
              {lastSwitchResult && (
                <div className="text-xs">
                  <p className="text-muted">
                    Last switch outcome:{' '}
                    <span className={lastSwitchResult.status === 'active' ? 'text-green-400' : 'text-red-300'}>
                      {lastSwitchResult.outcome_message ?? lastSwitchResult.outcome ?? lastSwitchResult.status}
                    </span>
                  </p>
                  <p className="mt-1 font-mono text-muted/70">
                    request {lastSwitchResult.request_id}
                    {lastSwitchResult.outcome ? ` · ${lastSwitchResult.outcome}` : ''}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </StageCard>
  )
}

function FinaliseEntry({
  entry,
  allowed,
  track,
  isTearingDown,
  teardownError,
  onTeardown,
  onOpLaunched,
  onOpError,
  onStatusChange,
  onJobComplete,
}: {
  entry: CatalogEntry
  allowed: boolean
  track: EntryTrack
  isTearingDown: boolean
  teardownError: unknown
  onTeardown: (reason: string) => void
  onOpLaunched: (jobId: number) => void
  onOpError: () => void
  onStatusChange: (status: string) => void
  onJobComplete: () => void
}) {
  const [arming, setArming] = useState(false)
  const inFlight = track.jobId !== null || track.opId !== null

  return (
    <div className="border-t border-white/5 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium text-text">{entry.display_name}</div>
        </div>
        {/* Never a disabled button — see ProvisionStage's identical note. */}
        {allowed && !inFlight && entry.lifecycle === 'active' && !arming && (
          <button className="btn btn-secondary btn-sm shrink-0" onClick={() => setArming(true)}>
            ⏏ Teardown
          </button>
        )}
      </div>

      {entry.lifecycle !== 'active' && !inFlight && (
        <p className="mt-1 text-xs text-muted">Not currently deployed.</p>
      )}
      {entry.lifecycle === 'active' && !allowed && !inFlight && (
        <p className="mt-1 text-xs text-muted">
          Finalise &amp; Review isn&apos;t currently offering to tear this down — see the
          rail state above.
        </p>
      )}

      {arming && (
        <div className="mt-2">
          <ReasonConfirm
            title={`Teardown ${entry.display_name}?`}
            description="Finalises this media function via its AWX teardown template. The action is operator-gated and recorded in the audit trail with your reason."
            confirmLabel="Confirm teardown"
            pendingLabel="Tearing down…"
            pending={isTearingDown}
            error={teardownError}
            onConfirm={(reason) => {
              onTeardown(reason)
              setArming(false)
            }}
            onCancel={() => setArming(false)}
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
          <JobStatusLine
            entryKey={entry.key}
            jobId={track.jobId}
            onComplete={onJobComplete}
            onStatusChange={onStatusChange}
          />
        </div>
      )}
    </div>
  )
}
