import { useEffect, useLayoutEffect, useState } from 'react'
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
  onPromotedActionChange,
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
  /**
   * umbrella #432 §D1: reports whether THIS stage currently offers at
   * least one top-level primary control of its own (`eligibleDeployEntries`
   * below, non-empty) — so the parent (WorkloadSetup) can hold FlowStep's
   * own Next neutral exactly while Provision has its own cyan control on
   * screen, and let it go primary the moment Provision has nothing offered
   * (every entry deployed/blocked). RETIRED (umbrella #518): this prop used
   * to ALSO gate a promoted-action portal mount (`computedPromotedKey`,
   * deleted along with the portal itself — see this file's docstring above
   * `eligibleDeployEntries`) — the condition this prop reports is unchanged
   * by that retirement, only what it used to additionally drive. Optional
   * so any OTHER direct render of this component is unaffected — a caller
   * that never needs the signal simply never reads it.
   */
  onPromotedActionChange?: (hasPromotedAction: boolean) => void
}) {
  // fix-round 5 (PR #81, codex sibling sweep): `catalogFailed` is threaded
  // into the absence claim below — a failed catalog read left `entries`
  // empty exactly like a genuinely-empty catalog would, so the stage
  // announced a confident "no templates matched" manufactured out of an
  // unhandled error path (verbatim the failure mode PlanStage.tsx's own
  // docstring names, already fixed there and in CreateWorkload.tsx).
  // fix-round 6 (PR #81, umbrella #385): retrofitted onto settleQuery.
  const { data: catalogData, loading: catalogLoading, failed: catalogFailed } = settleQuery(useCatalog())
  // fix-round 7 (PR #81, umbrella #385, codex call-site sweep): retrofitted
  // onto settleQuery — behavior-preserving (user is only ever read via
  // `?? 'unknown'` audit-trail fallbacks below, which already degrade
  // honestly for ANY reason `user` is undefined, same reasoning as
  // WorkloadHome.tsx's catalogData — but the shared primitive is still the
  // shape a new consumer should copy).
  const { data: user } = settleQuery(useCurrentUser())
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

  // "One btn-primary in source" proves nothing — this stage maps one
  // ProvisionEntry per eligible catalog entry, so two eligible entries means
  // two live Deploy buttons at once, each mirroring the EXACT condition that
  // gates its own inline button below (allowed && !inFlight && lifecycle
  // !== 'active') — computed once here over every entry, not re-derived per
  // entry, so the two can never disagree.
  //
  // Deploy is styled as the only TOP-LEVEL btn-primary offer anywhere in
  // this flow — Configure's "Switch source" and Finalise's "Teardown" are
  // btn-secondary, "Delete permanently" is btn-danger, a deliberately lower
  // weight than the cyan primary accent the rail-treatment ruling reserves
  // for "the thing to click" (LifecycleStrip.tsx's own docstring).
  // Clear-for-deployment below is btn-secondary for the same reason. (NOT
  // "Deploy is the only btn-primary in this flow" — that claim is false:
  // ReasonConfirm's own Confirm button is btn-primary for every non-danger
  // variant, so once ANY of these is armed, its Confirm button is
  // primary-styled too. That is a uniform property of ReasonConfirm itself,
  // not something Deploy is unique in.)
  //
  // RETIRED (umbrella #518, operator ruling: "redeploy matches creation"):
  // this used to also drive PROMOTION — relocating Deploy's own button +
  // ReasonConfirm into Topbar's header row when exactly one entry qualified
  // (components/PromotedAction.tsx, store/headerActionSlot.ts, both
  // deleted). Deploy renders in the stage body unconditionally now, the same
  // way CreateWorkload.tsx's first-deploy "▶ Provision now" always has —
  // eligibleDeployEntries below exists ONLY to answer "does Provision
  // currently offer at least one top-level control of its own" for
  // WorkloadSetup's nextIsPrimary (umbrella #432 §D1, WorkloadSetup.tsx:762
  // — that plumbing is UNCHANGED by this retirement, see its own comment for
  // why removing it would be its own regression), not to pick which entry to
  // promote.
  const eligibleDeployEntries = allowed && !busy
    ? entries.filter((e) => e.lifecycle !== 'active' && !activeTrack(track[e.key]))
    : []

  // umbrella #432 §D1: whether THIS stage shows a top-level primary control
  // right now. `.length > 0`, not `=== 1`: with two-or-more eligible
  // entries, both still render their own inline `btn-primary` Deploy offer
  // (this file's own docstring above: "two eligible entries means two live
  // Deploy buttons at once") — the condition FlowStep's Next needs is "is
  // there at least one cyan control on this screen already", true either
  // way.
  //
  // useLayoutEffect, not useEffect — same reasoning store/headerSlot.ts's
  // useRegisterHeaderSlot already documents for an identical "a sibling
  // (Topbar/FlowStep) renders from a value THIS effect reports" shape: a
  // layout effect's setState cascades before the browser paints, so there
  // is no in-between frame where Next shows the wrong colour for one
  // frame while this reports up. jsdom+RTL cannot observe the frame this
  // prevents either way (act() flushes passive effects synchronously too),
  // so no test claims that timing guarantee — kept on the same engineering
  // merit headerSlot.ts's own comment states, not a test-enforced one.
  const hasPromotedAction = eligibleDeployEntries.length > 0
  useLayoutEffect(() => {
    onPromotedActionChange?.(hasPromotedAction)
  }, [hasPromotedAction, onPromotedActionChange])

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

  // umbrella #403: same shared-component fix as FinaliseStage's
  // handleOpTerminal — a deploy is a WATCHED action too (useOperationStatus's
  // own _WATCHED_TERMINAL_STATES), so it keeps running past `launched`
  // toward a real terminal state regardless of whether that transient
  // moment was ever observed. Without this, a missed `launched` tick left
  // `track[key].opId` set forever: `busy` never fell and Deploy never came
  // back for this entry. Provision has no persistent review area of its own
  // (this level of feedback — the status line's own text for a beat before
  // the entry clears — is the same one onOpError below already gives a
  // deploy that errors out from a normally-observed `error` state; this
  // isn't a new standard for the stage, just closing the same gap for the
  // states `error` alone didn't cover).
  const handleOpTerminal = (key: string) => {
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
              track={track[entry.key] ?? EMPTY_TRACK}
              isDeploying={deployMutation.isPending && deployMutation.variables?.key === entry.key}
              deployError={deployMutation.variables?.key === entry.key ? deployMutation.error : null}
              onDeploy={(reason, ws) => handleDeploy(entry, reason, ws)}
              // FIX ROUND (P2-3): explicit Cancel out of a FAILED attempt
              // must actually clear the error, not just visually dismiss it
              // — deployMutation.isError otherwise persists until some
              // entry's NEXT mutate() call overwrites it, which could be a
              // long time (or never) if the operator just walks away.
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
              onOpTerminal={() => handleOpTerminal(entry.key)}
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
  track,
  isDeploying,
  deployError,
  onDeploy,
  onDismissError,
  onOpLaunched,
  onOpError,
  onOpTerminal,
  onJobComplete,
}: {
  entry: CatalogEntry
  workloadSlug: string
  allowed: boolean
  track: EntryTrack
  isDeploying: boolean
  deployError: unknown
  onDeploy: (reason: string, workloadSlug: string) => Promise<void>
  /** Called on Cancel, so an explicitly-dismissed error doesn't leave
   *  `deployMutation`'s error state stuck until some OTHER entry's next
   *  mutate() call happens to overwrite it. */
  onDismissError: () => void
  onOpLaunched: (jobId: number) => void
  onOpError: () => void
  /** umbrella #403: see ProvisionStage's handleOpTerminal — this entry
   *  doesn't need the settled operation itself, only that one reached. */
  onOpTerminal: () => void
  onJobComplete: () => void
}) {
  const [arming, setArming] = useState(false)
  const [workload, setWorkload] = useState(workloadSlug)
  const workloadInvalid = workload.trim() !== '' && !isValidWorkloadSlug(workload.trim())
  const inFlight = track.jobId !== null || track.opId !== null
  const offered = allowed && !inFlight && entry.lifecycle !== 'active'

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
            prose below instead.
            RETIRED (umbrella #518, operator ruling: "redeploy matches
            creation"): this used to portal into Topbar's header row when
            promoted (components/PromotedAction.tsx, now deleted). Always
            inline now — the same button, the same click handler, just one
            mount point instead of two. */}
        {offered && !arming && (
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
              // umbrella #386 / WP-3 spec B2: close ONLY on success.
              // Closing unconditionally (the old shape) unmounted this
              // panel — the only element rendering `error` above — the
              // instant Confirm was clicked, so a failed deploy vanished
              // with no trace. Staying armed on rejection keeps
              // ReasonConfirm's own error paragraph on screen for as long
              // as the operator is looking at it, well past the topbar's
              // 6s transient echo.
              //
              // THE WHOLE LOOP STAYS PUT NOW (umbrella #518 retired the
              // header-promoted variant of this panel): arming, this
              // pending/error display, and the failure too are all
              // rendered right here, always.
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
      )}

      {track.opId != null && (
        <div className="mt-2">
          <OperationStatusLine
            operationId={track.opId}
            onLaunched={onOpLaunched}
            onError={onOpError}
            onTerminal={onOpTerminal}
          />
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
