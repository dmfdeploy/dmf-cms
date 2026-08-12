import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  isOperation,
  useCatalog,
  useCurrentUser,
  useDeployCatalog,
  useClearForDeployment,
} from '../../../api/hooks'
import { useActivityStore } from '../../../store/activity'
import ReasonConfirm from '../../../components/ReasonConfirm'
import PromotedAction from '../../../components/PromotedAction'
import { useHeaderActionSlotNode } from '../../../store/headerActionSlot'
import { isValidWorkloadSlug } from '../../../lib/workloadSlug'
import type { CatalogEntry, ClearForDeploymentResult, MediaWorkload } from '../../../api/types'
import type { StageActionId, StageState } from '../../../lib/workloadLifecycle'
import ClearForDeployment from '../ClearForDeployment'
import StageCard from './StageCard'
import { JobStatusLine, OperationStatusLine } from './JobProgress'
import { settleQuery } from '../../../lib/queryState'

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
  onJobStart,
}: {
  workload: MediaWorkload
  state: StageState
  actions: StageActionId[]
  onBusyChange: (busy: boolean) => void
  /**
   * Called synchronously in the same event that fires a deploy or clear
   * mutation — see ConfigureStage's identical note (umbrella #347 WO-D1
   * spec A).
   */
  onJobStart: () => void
}) {
  // fix-round 5 (PR #81, codex sibling sweep): `catalogFailed` is threaded
  // into the absence claim below — a failed catalog read left `entries`
  // empty exactly like a genuinely-empty catalog would, so the stage
  // announced a confident "no templates matched" manufactured out of an
  // unhandled error path (verbatim the failure mode PlanStage.tsx's own
  // docstring names, already fixed there and in CreateWorkload.tsx).
  // fix-round 6 (PR #81, umbrella #385): retrofitted onto settleQuery.
  const { data: catalogData, loading: catalogLoading, failed: catalogFailed } = settleQuery(useCatalog())
  const { data: user } = useCurrentUser()
  const deployMutation = useDeployCatalog()
  const recordAwxWrite = useActivityStore((s) => s.recordAwxWrite)
  const queryClient = useQueryClient()

  const [track, setTrack] = useState<Record<string, EntryTrack>>({})

  // GATE-S1-RV2 P1: the STAGE owns the clear mutation. It used to live in
  // ClearForDeployment, inside the subtree this stage hides while busy — so
  // firing a clear unmounted its own mutation owner, the pending flag could
  // never fall, and the rail stuck busy forever. Ownership must sit above
  // the gate it raises.
  const clearMutation = useClearForDeployment()
  const [lastClearResult, setLastClearResult] = useState<ClearForDeploymentResult | null>(null)
  const onClearConfirm = (instance: string, reason: string) => {
    onJobStart()
    clearMutation.mutate(
      { instance, reason },
      {
        onSuccess: (result) => {
          // C5: the console-local record also lands in Activity -> History.
          useActivityStore.getState().recordClear(result)
          setLastClearResult(result)
        },
      },
    )
  }

  const functionKeys = workload.functions.map((f) => f.function_key)
  // #344: aggregated through the workload's CURRENT function keys, not
  // Object.values(track) — a function that leaves the workload takes its
  // entry out of this iteration, so a stale in-flight flag under a departed
  // key can never wedge `busy` true forever (ProvisionStage.tsx:78-82
  // pre-fix). No pruning effect needed: a departed key's track value is
  // simply never read again.
  const activeTrack = (t: EntryTrack | undefined) => t != null && (t.jobId !== null || t.opId !== null)
  const busy =
    deployMutation.isPending ||
    functionKeys.some((key) => activeTrack(track[key])) ||
    clearMutation.isPending
  useEffect(() => onBusyChange(busy), [busy, onBusyChange])

  const entries = (catalogData?.entries ?? []).filter((e) => functionKeys.includes(e.key))

  const allowed = actions.includes('deploy')

  // WP-3 spec B: the runtime action model for PROMOTION, not just for
  // rendering. "One btn-primary in source" proves nothing — this stage maps
  // one ProvisionEntry per eligible catalog entry, so two eligible entries
  // means two live Deploy buttons at once. Mirrors, field for field, the
  // EXACT condition that gates a single entry's own inline button below
  // (allowed && !inFlight && lifecycle !== 'active') — computed once here
  // over every entry, not re-derived per entry, so the two can never
  // disagree. `arming` (per-entry, local UI state) is deliberately NOT part
  // of this: promotion answers "which entries currently OFFER a deploy",
  // armed or not, so the promoted entry's identity stays stable across its
  // own arm → confirm → pending → outcome lifecycle instead of reassigning
  // mid-interaction.
  //
  // Deploy is the only TOP-LEVEL OFFERED primary action anywhere in this
  // flow — the FIRST control a stage offers, before anything is armed:
  // Configure's "Switch source" and Finalise's "Teardown" are btn-secondary,
  // "Delete permanently" is btn-danger, a deliberately lower weight than the
  // cyan primary accent the rail-treatment ruling reserves for "the thing to
  // click" (LifecycleStrip.tsx's own docstring). Clear-for-deployment below
  // is btn-secondary for the same reason and is never a promotion candidate
  // either. (NOT "Deploy is the only btn-primary in this flow" — that claim
  // is false: ReasonConfirm's own Confirm button is btn-primary for every
  // non-danger variant, so once ANY of these is armed, its Confirm button
  // is primary-styled too. That is a uniform property of ReasonConfirm
  // itself, not something Deploy is unique in.) "The current step's primary
  // action" is therefore simply ABSENT, at top level, on Configure/Finalise
  // — their actions stay in the body unconditionally, which is the rule
  // applied vacuously, not an oversight.
  const eligibleDeployEntries = allowed && !busy
    ? entries.filter((e) => e.lifecycle !== 'active' && !activeTrack(track[e.key]))
    : []
  const computedPromotedKey = eligibleDeployEntries.length === 1 ? eligibleDeployEntries[0].key : null

  // FIX ROUND P1b, extended P3 round 3 (P2-3, two independent reviewers,
  // same lines): LATCH the promoted identity through its own arm -> confirm
  // -> pending -> SETTLE lifecycle, not just through pending. `busy`
  // intentionally goes true the instant Confirm fires (onJobStart,
  // synchronously, in the same event) — that's what correctly withdraws
  // every OTHER entry's offer — but it also zeroed `eligibleDeployEntries`
  // for the very same render, which dropped the promoted entry back to
  // inline mid-flight: the operator saw "Launching…" jump out of the header
  // and into the page body the instant they clicked Confirm. Written
  // directly during render, not an effect — an effect lands one render
  // after `busy` flips true, which is exactly the gap that let the panel
  // flash into the body before latching.
  //
  // P1b only covered the PENDING half of that lifecycle: the fallback was
  // keyed to `deployMutation.isPending` alone. On REJECTION, isPending flips
  // false in THIS stage's own render before the PARENT (WorkloadDetail) has
  // re-derived its `actions` prop to include 'deploy' again — that only
  // happens once this component's own passive onBusyChange effect below
  // fires and the parent re-renders, one commit later. In the render
  // between those two things, `allowed` (from the still-stale `actions`
  // prop) is false, `busy` (from THIS component's own already-settled
  // state) is now also false, and the P1b-only latch condition
  // (isPending) is false too — so `promotedEntryKey` computed to null for
  // exactly that one committed render, and the still-armed, now-erroring
  // ReasonConfirm panel fell back to the page body before snapping back a
  // tick later once the parent caught up. A flicker on the exact failure
  // path spec B calls the signature case.
  //
  // `lastEligibleKeyRef` remembers the last entry that was cleanly eligible
  // (nothing busy) — i.e. the identity as of the moment BEFORE arming.
  // `promotedEntryKey` falls back to that latch while the deploy mutation
  // CURRENTLY TRACKED is this SAME entry's own AND has not yet reached a
  // resting state the operator has dismissed — pending OR a settled error
  // still on screen. A different entry's or clear-for-deployment's write
  // firing must still correctly withdraw promotion (busy for an unrelated
  // reason is not "this entry's own unsettled attempt"), which is why this
  // still checks `deployMutation.variables?.key === latchedKey` before
  // trusting `isPending`/`isError` at all.
  const lastEligibleKeyRef = useRef<string | null>(null)
  if (computedPromotedKey !== null) lastEligibleKeyRef.current = computedPromotedKey
  const latchedKey = lastEligibleKeyRef.current
  const latchedEntryOwnAttemptUnsettled =
    latchedKey !== null &&
    deployMutation.variables?.key === latchedKey &&
    (deployMutation.isPending || deployMutation.isError)
  const promotedEntryKey = computedPromotedKey ?? (latchedEntryOwnAttemptUnsettled ? latchedKey : null)

  // GATE-S1 P1: clear-for-deployment is a PROVISION-time action and now flows
  // through the rail like every other write. It used to render on Finalise
  // outside the model entirely — firing during another stage's job, and even
  // while Finalise itself was not-applicable.
  const mayClear = actions.includes('clear-for-deployment')
  const needsClearing = [...workload.instances]
    .filter((i) => !i.reconcile_pending && i.requested_state === 'bootstrapped')
    .sort((a, b) => a.instance.localeCompare(b.instance))

  // umbrella #386 / WP-3 spec B2: THROWS on failure now, deliberately — it
  // used to swallow the rejection here (console.error and nothing else),
  // which is what let ProvisionEntry's onConfirm close the arm panel
  // unconditionally on every confirm, success or not. The panel contained
  // the ONLY element rendering the failure, so a failed deploy vanished
  // with it (GATE-B P1: "success may close the panel; failure must not").
  // Letting the rejection propagate is what lets the caller decide to keep
  // the panel open instead — see ProvisionEntry's onConfirm.
  const handleDeploy = async (entry: CatalogEntry, reason: string, workloadSlug: string) => {
    onJobStart()
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
        <p className={catalogFailed ? 'text-amber-200/80' : 'text-muted'}>
          {catalogLoading
            ? 'Loading template information…'
            : catalogFailed
              ? // "Retrying automatically" is false for useCatalog specifically
                // (no refetchInterval, retry exhausted) — see
                // CreateWorkload.tsx's TemplatePicker for the identical
                // correction and why it matters here too.
                "The catalog couldn't be read right now, so this workload's templates can't be listed. Reload the page to try the read again."
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
              promoted={entry.key === promotedEntryKey}
              track={track[entry.key] ?? EMPTY_TRACK}
              isDeploying={deployMutation.isPending && deployMutation.variables?.key === entry.key}
              deployError={deployMutation.variables?.key === entry.key ? deployMutation.error : null}
              onDeploy={(reason, ws) => handleDeploy(entry, reason, ws)}
              // FIX ROUND (P2-3): explicit Cancel out of a FAILED attempt
              // must not leave `latchedEntryOwnAttemptUnsettled` true
              // forever — deployMutation.isError otherwise persists until
              // some entry's NEXT mutate() call overwrites it, which could
              // be a long time (or never) if the operator just walks away.
              // Scoped to `deployMutation.variables?.key === entry.key` so
              // cancelling THIS entry's panel can never reset a DIFFERENT
              // entry's still-pending mutation out from under it — reset()
              // clears the hook's displayed status, not the in-flight
              // network call, so doing that to someone else's write would
              // make an active deploy look like it never started.
              onDismissError={() => {
                if (deployMutation.variables?.key === entry.key && !deployMutation.isPending) {
                  deployMutation.reset()
                }
              }}
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
                  onConfirm={onClearConfirm}
                  pending={clearMutation.isPending}
                  failed={clearMutation.isError}
                />
              </div>
            ))}
          </div>
          {/* Failure is rendered by the STAGE, so it stays visible after the
              confirm panel closes. Inside the armed branch it vanished with
              the panel, which meant a failed write looked like nothing had
              happened at all (GATE-S1-RV3 P2, item 16). */}
          {clearMutation.isError && (
            <p className="mt-2 text-xs text-red-300">
              The desired state was not recorded — nothing changed. Check your
              access, then retry.
            </p>
          )}
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
  promoted,
  track,
  isDeploying,
  deployError,
  onDeploy,
  onDismissError,
  onOpLaunched,
  onOpError,
  onJobComplete,
}: {
  entry: CatalogEntry
  workloadSlug: string
  allowed: boolean
  /**
   * True when this is the stage's ONE eligible deploy entry (WP-3 spec B —
   * see ProvisionStage's eligibleDeployEntries) — its button and arming
   * panel render in the header's promoted-action slot instead of here.
   * Nothing else about this entry changes: same state, same mutation, same
   * ReasonConfirm, just a different mount point (PromotedAction).
   */
  promoted: boolean
  track: EntryTrack
  isDeploying: boolean
  deployError: unknown
  onDeploy: (reason: string, workloadSlug: string) => Promise<void>
  /** FIX ROUND (P2-3): called on Cancel, so an explicitly-dismissed error
   *  doesn't keep the promotion latch (see ProvisionStage's
   *  latchedEntryOwnAttemptUnsettled) unsettled indefinitely. */
  onDismissError: () => void
  onOpLaunched: (jobId: number) => void
  onOpError: () => void
  onJobComplete: () => void
}) {
  const [arming, setArming] = useState(false)
  const [workload, setWorkload] = useState(workloadSlug)
  const workloadInvalid = workload.trim() !== '' && !isValidWorkloadSlug(workload.trim())
  const inFlight = track.jobId !== null || track.opId !== null
  const offered = allowed && !inFlight && entry.lifecycle !== 'active'
  // `promoted` alone only says this entry is ELIGIBLE for promotion — it is
  // computed from the stage's own runtime action model, not from whether a
  // header row exists to receive it (a bare stage render in a test, or any
  // route without Topbar's header slot mounted, is eligible too). Called
  // unconditionally (Rules of Hooks) and combined below — gating the
  // "moved" copy on the mount point ACTUALLY being there avoids claiming a
  // move that PromotedAction's own fallback didn't make: it renders inline
  // right where this text would otherwise contradict it.
  const actionSlotNode = useHeaderActionSlotNode()
  const promotable = promoted && actionSlotNode !== null

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
            prose below instead. Routed through PromotedAction: identical
            button, identical click handler — only WHERE it mounts differs
            (WP-3 spec B). */}
        {offered && !arming && (
          <PromotedAction promote={promoted}>
            <button className="btn btn-primary btn-sm shrink-0" onClick={() => setArming(true)}>
              ▶ Deploy
            </button>
          </PromotedAction>
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
      {/* The button itself just portalled away (above) — say where it went,
          rather than leaving what looks like a silently withdrawn action.
          Gated on `promotable`, not `promoted`: a route/test with no header
          slot mounted falls back to rendering the button right here (see
          PromotedAction), and this copy must not contradict that. */}
      {offered && promotable && !arming && (
        <p className="mt-1 text-xs text-muted">Deploy is available from the header above.</p>
      )}

      {arming && (
        <PromotedAction promote={promoted}>
          {/* FIX ROUND P1a: right-4, anchored to header-slot-row (Topbar.tsx
              is `relative` there now, not on this control's own mount span,
              whose box collapses to ~0 width the instant its only child is
              this out-of-flow panel). max-w keeps it inside the viewport on
              narrow widths instead of overflowing past it in the other
              direction. */}
          <div
            className={
              promotable
                ? 'absolute right-4 top-full z-20 mt-2 w-80 max-w-[calc(100vw-2rem)]'
                : 'mt-2'
            }
          >
            <ReasonConfirm
              title={`Deploy ${entry.display_name}?`}
              description="Provisions this media function via its AWX job template. The action is operator-gated and recorded in the audit trail with your reason."
              confirmLabel="Confirm deploy"
              pendingLabel="Launching…"
              pending={isDeploying}
              error={deployError}
              onConfirm={(reason) => {
                // umbrella #386 / WP-3 spec B2: close ONLY on success.
                // Closing unconditionally (the old shape) unmounted this
                // panel — the only element rendering `error` above — the
                // instant Confirm was clicked, so a failed deploy vanished
                // with no trace. Staying armed on rejection keeps
                // ReasonConfirm's own error paragraph on screen for as long
                // as the operator is looking at it, well past the topbar's
                // 6s transient echo.
                //
                // THE WHOLE LOOP MOVES WITH THE ACTION (WP-3 spec B):
                // arming, this pending/error display, and — because staying
                // mounted is all "persistent" means here — the failure too,
                // whether this panel is inline or promoted into the header.
                void (async () => {
                  try {
                    await onDeploy(reason, workload.trim())
                    setArming(false)
                  } catch {
                    // Stay armed — deployError (threaded from the stage's
                    // mutation state) renders the failure right here.
                  }
                })()
              }}
              onCancel={() => {
                setArming(false)
                onDismissError()
              }}
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
        </PromotedAction>
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
