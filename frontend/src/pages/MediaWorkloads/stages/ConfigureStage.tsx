import { useCallback, useEffect, useRef, useState } from 'react'
import { useInstanceTopology, useSwitchSource } from '../../../api/hooks'
import { useActivityStore } from '../../../store/activity'
import ReasonConfirm from '../../../components/ReasonConfirm'
import type { MediaWorkload, SwitchSourceResult } from '../../../api/types'
import type { StageActionId, StageState } from '../../../lib/workloadLifecycle'
import StageCard from './StageCard'
import { settleQuery } from '../../../lib/queryState'

/**
 * Configure — source selection and the switch, relocated from
 * InstanceLiveModal.tsx's SwitchSourceControl (useSwitchSource,
 * useInstanceTopology). Same fail-closed freshness rule as the original:
 * a switch target is only ever offered against an OBSERVED, recent flow
 * match — never a possibly-stale catalog default.
 *
 * COPY HONESTY (load-bearing, umbrella #285 S1): this is mechanically a
 * configure-time re-point of a receiver, never described as live flow
 * control or real-time video-path control — the description text below is
 * unchanged from the original for exactly that reason.
 *
 * `allowed` gates only the INITIAL "Switch source" button — once a switch
 * is armed and submitted, its own mutation.isPending is what's live, not
 * the module's stageActions() gate (which will already read empty the
 * instant this control's own switch starts, by design: nothing else may
 * start a NEW action while one is running).
 */
const OBSERVED_SOURCE_STALE_MS = 15_000
const OBSERVED_SOURCE_UNKNOWN_MESSAGE =
  'Live source is unknown or stale — refresh to retry before switching.'

export default function ConfigureStage({
  workload,
  state,
  actions,
  onBusyChange,
  onSwitchResult,
  onJobStart,
}: {
  workload: MediaWorkload
  state: StageState
  actions: StageActionId[]
  onBusyChange: (busy: boolean) => void
  onSwitchResult: (result: SwitchSourceResult) => void
  /**
   * Called synchronously in the same event that fires the switch mutation —
   * the wizard's job-owner marker must not wait on this stage's own
   * onBusyChange effect, which is one render behind the click (umbrella
   * #347 WO-D1 spec A).
   */
  onJobStart: () => void
}) {
  const allowed = actions.includes('switch-source')
  const [pending, setPending] = useState<Set<string>>(new Set())

  // Bail out to the SAME Set reference when nothing actually changed. This
  // is load-bearing, not cosmetic: InstanceSwitchControl's effect depends on
  // this callback's identity (see pendingCallbackFor below), so an
  // unconditional `new Set(prev)` here would re-render this component every
  // time the effect re-fires, which recreates the callback, which re-fires
  // the effect again — a tight infinite loop, not just wasted renders.
  const setInstancePending = useCallback((instance: string, isPending: boolean) => {
    setPending((prev) => {
      if (prev.has(instance) === isPending) return prev
      const next = new Set(prev)
      if (isPending) next.add(instance)
      else next.delete(instance)
      return next
    })
  }, [])

  // A STABLE callback per instance (cached across renders), so
  // InstanceSwitchControl's effect dependency array only changes when
  // switchMutation.isPending itself changes — never merely because the
  // parent re-rendered. Same infinite-loop defence as the bail-out above,
  // belt-and-suspenders.
  const pendingCallbacks = useRef(new Map<string, (isPending: boolean) => void>())
  const pendingCallbackFor = useCallback(
    (instance: string) => {
      let cb = pendingCallbacks.current.get(instance)
      if (!cb) {
        cb = (isPending: boolean) => setInstancePending(instance, isPending)
        pendingCallbacks.current.set(instance, cb)
      }
      return cb
    },
    [setInstancePending],
  )

  // #344: derived through the CURRENT instance list, not the pending Set's
  // own size — a departed instance's pending flag has no fresh child to ever
  // clear it, and .size counted it forever (ConfigureStage.tsx:45, :81, :127
  // pre-fix). Filtering through workload.instances makes a departed row's
  // stale `true` inert without any pruning effect.
  const busy = workload.instances.some((inst) => pending.has(inst.instance))
  useEffect(() => onBusyChange(busy), [busy, onBusyChange])

  const instances = [...workload.instances].sort((a, b) => a.instance.localeCompare(b.instance))

  if (state === 'not-applicable') {
    return (
      <StageCard label="Configure" state={state}>
        <p className="text-muted">Nothing is running yet — there is no source to configure.</p>
      </StageCard>
    )
  }

  return (
    <StageCard label="Configure" state={state}>
      <div className="space-y-4">
        {instances.map((inst) => (
          <InstanceSwitchControl
            key={inst.instance}
            instance={inst.instance}
            allowed={allowed}
            onPendingChange={pendingCallbackFor(inst.instance)}
            onResult={onSwitchResult}
            onJobStart={onJobStart}
          />
        ))}
      </div>
    </StageCard>
  )
}

function InstanceSwitchControl({
  instance,
  allowed,
  onPendingChange,
  onResult,
  onJobStart,
}: {
  instance: string
  allowed: boolean
  onPendingChange: (pending: boolean) => void
  onResult: (result: SwitchSourceResult) => void
  onJobStart: () => void
}) {
  // fix-round 6 (PR #81, umbrella #385): retrofitted onto settleQuery — the
  // raw query is kept alongside for `.refetch()` (not part of the settled
  // shape, which is deliberately read-only), used below on a successful
  // switch.
  const topologyQuery = useInstanceTopology(instance)
  const topology = settleQuery(topologyQuery)
  const switchMutation = useSwitchSource()
  const recordAwxWrite = useActivityStore((s) => s.recordAwxWrite)
  const [arming, setArming] = useState(false)
  const [target, setTarget] = useState('')

  useEffect(() => onPendingChange(switchMutation.isPending), [switchMutation.isPending, onPendingChange])

  // Same TOCTOU defence as the original: force a re-render roughly once a
  // second while armed so staleness that creeps past the bound while the
  // operator sits on the form is caught reactively, not just at submit.
  const [, armedFreshnessTick] = useState(0)
  useEffect(() => {
    if (!arming) return
    const id = setInterval(() => armedFreshnessTick((t) => (t + 1) % 100000), 1_000)
    return () => clearInterval(id)
  }, [arming])

  // fix-round 5 (PR #81, codex sibling sweep): consistency touch-up with
  // Operate.tsx's InstanceActiveSource and DesignStage's InstanceComposition
  // (both fixed the same way this round). Lower-severity here specifically
  // because isObservedFresh below already self-fails-closed within 15s
  // regardless of isError (observed_at goes stale on its own), but the
  // withdraw-on-error contract should read the same everywhere this
  // topology shape is consumed.
  if (topology.failed || !topology.data || !Array.isArray(topology.data.sources)) return null

  const { sources, active_source, provenance, observed_at } = topology.data
  const isObservedFresh =
    provenance === 'observed-flow' &&
    !!active_source &&
    !!observed_at &&
    Date.now() - new Date(observed_at).getTime() < OBSERVED_SOURCE_STALE_MS

  const otherSources = isObservedFresh ? sources.filter((s) => s.id !== active_source) : []
  if (isObservedFresh && otherSources.length === 0) return null

  const result = switchMutation.data

  const submit = (reason: string) => {
    if (!target) return
    const stillFresh =
      provenance === 'observed-flow' &&
      !!active_source &&
      !!observed_at &&
      Date.now() - new Date(observed_at).getTime() < OBSERVED_SOURCE_STALE_MS
    if (!stillFresh) return
    onJobStart()
    switchMutation.mutate(
      { instance, sourceInstance: target, reason },
      {
        onSuccess: (res) => {
          recordAwxWrite({
            request_id: res.request_id,
            action: 'switch-source',
            target: instance,
            reason: res.reason,
            actor: res.actor,
            role: res.role,
            outcome: res.status,
          })
          onResult(res)
          setArming(false)
          setTarget('')
          topologyQuery.refetch()
        },
      },
    )
  }

  return (
    <div className="border-t border-white/5 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-wide text-muted">
          Source · <span className="font-mono normal-case text-muted">{instance}</span>
        </div>
        {/* No disabled button: the arm affordance only appears when a switch
            is actually offerable (allowed by the rail AND a fresh observed
            source AND another source to go to). Anything else renders as
            the explanatory line below instead. */}
        {!arming && allowed && isObservedFresh && otherSources.length > 0 && (
          <button
            className="btn btn-secondary btn-sm shrink-0"
            onClick={() => {
              switchMutation.reset()
              setArming(true)
            }}
          >
            Switch source
          </button>
        )}
      </div>

      {/* Shown while armed too, not just before: if the observation goes
          stale under the operator mid-form, Confirm goes dead — and a dead
          Confirm with no stated reason is the honesty gap, not the block
          itself (Art. 1). */}
      {!isObservedFresh && (
        <p className="mt-1 text-[11px] text-amber-200/60">{OBSERVED_SOURCE_UNKNOWN_MESSAGE}</p>
      )}
      {!arming && isObservedFresh && !allowed && !result && (
        <p className="mt-1 text-[11px] text-muted">
          Configure isn&apos;t currently offering to switch this source — see the rail state
          above.
        </p>
      )}

      {arming ? (
        <div className="mt-2">
          <ReasonConfirm
            title="Switch active source"
            description="Coarse reconfigure/reconnect actuator — not a live IS-05 switch. Re-points this viewer to a different source and is recorded in the audit trail with your reason."
            confirmLabel="Confirm switch"
            pendingLabel="Switching…"
            pending={switchMutation.isPending}
            error={switchMutation.isError ? switchMutation.error : undefined}
            onConfirm={submit}
            onCancel={() => {
              setArming(false)
              setTarget('')
            }}
            extraField={{
              label: 'Target source',
              placeholder: 'Select a source…',
              value: target,
              // umbrella #402: `topology` now polls while armed (it didn't
              // before), so `target` — plain state, not re-derived from
              // `otherSources` — can point at a source that a poll landing
              // mid-arm has since promoted to active_source or dropped from
              // the list entirely. Both leave the <select> showing a value
              // with no matching <option> while target itself stays set, so
              // without this check Confirm would still be clickable and
              // submit() would fire against a target neither list nor gate
              // still vouches for. This is a NEW gap polling introduces
              // (topology.data could not change while armed before this
              // fix); it is deliberately NOT a change to isObservedFresh or
              // submit()'s own freshness re-check, both out of scope here —
              // this only widens the existing Confirm-disable condition to a
              // fact already available at render time.
              invalid: target === '' || !isObservedFresh || !otherSources.some((s) => s.id === target),
              invalidHint:
                target !== '' && isObservedFresh && !otherSources.some((s) => s.id === target)
                  ? 'Selected source is no longer available — choose again.'
                  : undefined,
              onChange: setTarget,
              options: otherSources.map((s) => ({ value: s.id, label: `${s.id} (${s.pattern})` })),
            }}
          />
        </div>
      ) : result ? (
        <div className="mt-1">
          <div className={`text-xs ${result.status === 'active' ? 'text-green-400' : 'text-red-300'}`}>
            {result.outcome_message ??
              (result.status === 'active'
                ? `Active source: ${result.source_instance}`
                : `Switch failed (${result.error ?? 'failed_rollback_required'}) — operator retry/rollback required.`)}
          </div>
          <details className="mt-1 text-xs text-muted">
            <summary className="cursor-pointer select-none opacity-80 hover:opacity-100">System details</summary>
            <p className="mt-1 pl-4 font-mono">
              request {result.request_id}
              {result.outcome ? ` · ${result.outcome}` : ''}
            </p>
          </details>
        </div>
      ) : (
        <div className="mt-0.5 font-mono text-sm text-text">{active_source ?? '—'}</div>
      )}
    </div>
  )
}
