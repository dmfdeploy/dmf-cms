import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  isOperation,
  useCatalog,
  useOperationStatus,
  usePurgeWorkload,
  useTeardownCatalog,
} from '../../../api/hooks'
import { useActivityStore } from '../../../store/activity'
import ReasonConfirm from '../../../components/ReasonConfirm'
import type { CatalogEntry, MediaWorkload, Operation, SwitchSourceResult, UserIdentity } from '../../../api/types'
import type { StageActionId, StageState } from '../../../lib/workloadLifecycle'
import StageCard from './StageCard'
import { JobStatusLine, OperationStatusLine } from './JobProgress'
import { settleQuery } from '../../../lib/queryState'

/**
 * Finalise & Review — the teardown action, relocated from
 * pages/Catalog/index.tsx (useTeardownCatalog, the same ReasonConfirm
 * arming pattern) PLUS the review: the last teardown job's outcome, and
 * the last switch's structured DMF_L3_SWITCH_OUTCOME marker (surfaced
 * already, by the backend, as SwitchSourceResult.outcome/outcome_message —
 * dmf-runbooks 0.4.4 contract). No generated stats report — that's S4.
 *
 * Clear-for-deployment used to render here, outside the rail's action model
 * entirely — which meant it could fire during another stage's in-flight job,
 * and even while Finalise itself was not-applicable (GATE-S1 P1). It is a
 * PROVISION-time action: it moves a workload from "members exist, no active
 * intent" to an active intent. It now lives on Provision and flows through
 * stageActions() like every other write.
 *
 * Delete permanently (umbrella #347, operator ruling 2026-08-02) is a
 * SECOND, workload-level write alongside per-entry teardown — not another
 * FinaliseEntry, since it purges the whole workload's residue in one shot,
 * keyed by slug rather than catalog key. It tracks its own operation
 * independently of `track` (the per-entry teardown map): unlike teardown's
 * hand-off to raw job-id polling (JobStatusLine, catalog-key-scoped and
 * inapplicable to a workload-slug-keyed launch), the finalise-purge job
 * template is shared and this component watches the OPERATION itself all
 * the way to a real terminal state (useOperationStatus, umbrella #347's
 * widened stop condition) — job-success alone is never the completion
 * signal (Console Constitution Art. 1: the backend's own post-job source
 * re-read is the sole absence authority, and `purge_verified_at` on the
 * terminal Operation is that confirmation's timestamp).
 */
interface EntryTrack {
  jobId: number | null
  opId: string | null
}

const EMPTY_TRACK: EntryTrack = { jobId: null, opId: null }

// umbrella #347: the SAME "watched terminal" set useOperationStatus itself
// polls to (see that hook's own note) — repeated here only to know WHEN to
// stop tracking a purge locally, not to re-derive polling behavior.
const PURGE_TERMINAL_STATES: Operation['state'][] = [
  'run_complete', 'run_failed', 'run_status_unknown', 'error',
]

export default function FinaliseStage({
  workload,
  state,
  actions,
  onBusyChange,
  lastSwitchResult,
  onJobStart,
  user,
}: {
  workload: MediaWorkload
  state: StageState
  actions: StageActionId[]
  onBusyChange: (busy: boolean) => void
  lastSwitchResult: SwitchSourceResult | null
  /**
   * Called synchronously in the same event that fires the teardown mutation
   * — see ConfigureStage's identical note (umbrella #347 WO-D1 spec A).
   */
  onJobStart: () => void
  /**
   * Audit identity for the actor/role fields below — umbrella #378 fix
   * round 2: this used to be this component's OWN useCurrentUser() call,
   * but that made FinaliseStage a SECOND subscriber to the ['user'] query,
   * first mounting only when the operator navigates here — which, once
   * WorkloadWizard started gating the purge affordance on that query's own
   * isFetching (378b), meant simply arriving at this stage could trigger a
   * background identity refetch that withdrew the very control the operator
   * just navigated to use. WorkloadWizard already holds the identical read
   * for that gate; threaded through here instead of a second subscription,
   * same discipline as membersDataTrustworthy above it.
   */
  user: UserIdentity | undefined
}) {
  // fix-round 5 (PR #81, codex sibling sweep): `catalogFailed` threaded into
  // the absence claim below — see ProvisionStage.tsx's identical fix for
  // the full reasoning (same shared PlanStage/CreateWorkload precedent).
  //
  // fix-round 6 (PR #81, umbrella #385): retrofitted onto settleQuery.
  const { data: catalogData, loading: catalogLoading, failed: catalogFailed } = settleQuery(useCatalog())
  const teardownMutation = useTeardownCatalog()
  const purgeMutation = usePurgeWorkload()
  const recordAwxWrite = useActivityStore((s) => s.recordAwxWrite)
  const queryClient = useQueryClient()

  const [track, setTrack] = useState<Record<string, EntryTrack>>({})
  const [lastJob, setLastJob] = useState<{ entryKey: string; jobId: number; status: string } | null>(null)

  const [purgeArming, setPurgeArming] = useState(false)
  const [purgeConfirmText, setPurgeConfirmText] = useState('')
  const [purgeOpId, setPurgeOpId] = useState<string | null>(null)
  const [purgeReview, setPurgeReview] = useState<Operation | null>(null)
  // fix-round 6 (PR #81, umbrella #385 codex sweep): the third direct
  // (non-JobProgress) poller in this file — `data` alone used to drive the
  // inline "— {state}" text below with no notice when a settled failed
  // refetch retained the last-observed state.
  const { data: purgeOp, failed: purgeOpFailed } = settleQuery(useOperationStatus(purgeOpId))

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


  const functionKeys = workload.functions.map((f) => f.function_key)
  // #344: aggregated through the workload's CURRENT function keys, not
  // Object.values(track) — see ProvisionStage's identical note
  // (FinaliseStage.tsx:104-107 pre-fix). No pruning effect: a departed key's
  // track value is simply never read again.
  const activeTrack = (t: EntryTrack | undefined) => t != null && (t.jobId !== null || t.opId !== null)
  const busy =
    teardownMutation.isPending ||
    functionKeys.some((key) => activeTrack(track[key])) ||
    purgeMutation.isPending ||
    purgeOpId !== null
  useEffect(() => onBusyChange(busy), [busy, onBusyChange])

  // umbrella #347: once the tracked purge operation reaches a REAL terminal
  // state (never just "launched" — see useOperationStatus's own widened
  // stop condition), close the loop at the point of action (Art. 2): stop
  // tracking it, keep its final shape for the Review section below, and
  // invalidate the SAME two query keys teardown's own completion does. The
  // refreshed grouped read no longer listing this workload IS the absence
  // claim (Art. 1) — this effect only reacts to the operation's own
  // terminal state, it never asserts absence itself.
  useEffect(() => {
    if (!purgeOp || !PURGE_TERMINAL_STATES.includes(purgeOp.state)) return
    setPurgeReview(purgeOp)
    setPurgeOpId(null)
    void queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })
    void queryClient.invalidateQueries({ queryKey: ['catalog'] })
  }, [purgeOp, queryClient])

  const entries = (catalogData?.entries ?? []).filter((e) => functionKeys.includes(e.key))

  const allowed = actions.includes('tear-down')
  const purgeAllowed = actions.includes('delete-permanently')

  // umbrella #386 / WP-3 spec B2: THROWS on failure, deliberately — see
  // ProvisionStage.tsx's identical handleDeploy note. This is FinaliseEntry's
  // own copy of the exact same onConfirm-then-close shape ProvisionEntry had,
  // and the sweep the umbrella issue calls for found it here too.
  const handleTeardown = async (entry: CatalogEntry, reason: string) => {
    onJobStart()
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
  }

  const handleJobComplete = (key: string) => {
    setTrack((prev) => ({ ...prev, [key]: EMPTY_TRACK }))
    void queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })
    void queryClient.invalidateQueries({ queryKey: ['catalog'] })
  }

  const handlePurge = async (reason: string) => {
    onJobStart()
    try {
      const result = await purgeMutation.mutateAsync({ slug: workload.slug, confirm: purgeConfirmText, reason })
      recordAwxWrite({
        request_id: result.request_id ?? '',
        action: 'finalise-purge',
        target: workload.slug,
        reason,
        actor: user?.subject ?? 'unknown',
        role: user?.role ?? 'unknown',
        outcome: 'dispatched',
      })
      setPurgeOpId(result.operation_id)
      setPurgeArming(false)
      setPurgeConfirmText('')
    } catch (e) {
      console.error('Delete permanently failed:', e)
    }
  }

  return (
    <StageCard label="Finalise & Review" state={state}>
      <div className="space-y-4">
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted">Teardown</h3>
          {state === 'not-applicable' ? (
            <p className="mt-1 text-muted">Nothing is running yet, so there is nothing to tear down.</p>
          ) : entries.length === 0 ? (
            <p className={`mt-1 ${catalogFailed ? 'text-amber-200/80' : 'text-muted'}`}>
              {catalogLoading
                ? 'Loading template information…'
                : catalogFailed
                  ? "The catalog couldn't be read right now, so this workload's templates can't be listed. Reload the page to try the read again."
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

        <div className="border-t border-white/5 pt-3">
          <h3 className="text-xs uppercase tracking-wide text-muted">Delete permanently</h3>
          {purgeOpId != null ? (
            <div className="mt-2 text-xs">
              <p className="text-muted">
                Deleting <span className="font-mono">{workload.slug}</span> permanently…
              </p>
              <p className="mt-1 text-muted/70">
                op <span className="font-mono">{purgeOpId.slice(0, 8)}...</span>
                {purgeOp ? ` — ${purgeOp.state}` : purgeOpFailed ? ' — could not query status' : ' — querying status…'}
              </p>
              {purgeOpFailed && (
                <p className="mt-1 text-amber-300">
                  {purgeOp
                    ? 'Could not confirm the latest status — showing the last read, retrying automatically.'
                    : 'Could not query the delete status — retrying automatically.'}
                </p>
              )}
            </div>
          ) : purgeAllowed ? (
            purgeArming ? (
              <div className="mt-2">
                <ReasonConfirm
                  variant="danger"
                  title={`Delete ${workload.name} permanently?`}
                  description="Removes this workload's residual catalog records from the source of truth via the finalise-purge automation. The entry stops existing — there is no rollback."
                  confirmLabel="Delete permanently"
                  pendingLabel="Deleting…"
                  pending={purgeMutation.isPending}
                  error={purgeMutation.isError ? purgeMutation.error : undefined}
                  extraField={{
                    label: 'Type the workload slug to confirm',
                    placeholder: workload.slug,
                    value: purgeConfirmText,
                    onChange: setPurgeConfirmText,
                    invalid: purgeConfirmText !== workload.slug,
                    invalidHint: `Type "${workload.slug}" exactly to confirm — this cannot be undone.`,
                  }}
                  onConfirm={(reason) => handlePurge(reason)}
                  onCancel={() => {
                    setPurgeArming(false)
                    setPurgeConfirmText('')
                  }}
                />
              </div>
            ) : (
              <button className="btn btn-danger btn-sm mt-2" onClick={() => setPurgeArming(true)}>
                🗑 Delete permanently
              </button>
            )
          ) : (
            <p className="mt-1 text-muted">
              {state === 'not-applicable'
                ? 'Nothing is running yet, so there is nothing to finalise.'
                : "Delete permanently isn't currently offered — see the rail state above."}
            </p>
          )}
        </div>

        <div className="border-t border-white/5 pt-3">
          <h3 className="text-xs uppercase tracking-wide text-muted">Review</h3>
          {!lastJob && !lastSwitchResult && !purgeReview ? (
            <p className="mt-1 text-muted">No teardown, switch, or delete has run yet in this session.</p>
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
              {purgeReview && (
                <div className="text-xs">
                  {purgeReview.state === 'run_complete' ? (
                    <>
                      <p className="text-green-400">
                        Deleted permanently — confirmed absent by a fresh source read.
                      </p>
                      {purgeReview.purge_verified_at && (
                        <p className="mt-1 font-mono text-muted/70">
                          verified {purgeReview.purge_verified_at}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Art. 8, honestly: whatever the backend actually recorded —
                          never a fake success, never "retrying". */}
                      <p className="text-red-300">
                        Delete permanently did not complete —{' '}
                        {purgeReview.error ?? purgeReview.l3_outcome ?? purgeReview.state}
                      </p>
                      <p className="mt-1 font-mono text-muted/70">request {purgeReview.request_id}</p>
                    </>
                  )}
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
  onTeardown: (reason: string) => Promise<void>
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
              // umbrella #386 / WP-3 spec B2: close ONLY on success — see
              // ProvisionEntry's identical note. Staying armed on rejection
              // keeps ReasonConfirm's own error paragraph on screen.
              void (async () => {
                try {
                  await onTeardown(reason)
                  setArming(false)
                } catch {
                  // Stay armed — teardownError renders the failure here.
                }
              })()
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
