import { useState } from 'react'

/**
 * The ONE consequential Media Workloads write (ADR-0037), as a self-contained
 * control so every caller shares one audit path (hard gate 3 + C5): click
 * arms a per-instance confirm with a MANDATORY reason; nothing fires on the
 * first click. On success — in the STAGE, which owns the mutation — the
 * console-local Activity record is written (correlated by request_id), and
 * the mutation hook invalidates the grouped inventory so the now-stale
 * action stops being offered.
 *
 * It does NOT own the mutation. The stage does. This control lives inside a
 * subtree the stage hides while any write is in flight, so owning the
 * mutation here meant unmounting the owner mid-request: the pending flag
 * that raised `busy` could never be lowered, and the rail stuck busy forever
 * after one clear (GATE-S1-RV2 P1). Ownership belongs above the gate; this
 * component just collects a reason and calls back.
 */
export default function ClearForDeployment({
  instance,
  onConfirm,
  pending = false,
  failed = false,
}: {
  instance: string
  /** The stage owns the mutation; this reports the operator's intent. */
  onConfirm: (instance: string, reason: string) => void
  pending?: boolean
  failed?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')

  const submit = () => {
    onConfirm(instance, reason.trim())
    setConfirming(false)
    setReason('')
  }

  if (!confirming) {
    return (
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => {
          setConfirming(true)
        }}
      >
        Clear for deployment
      </button>
    )
  }

  return (
    <div className="min-w-64 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100">
      <div className="text-xs font-semibold">Clear {instance} for deployment?</div>
      <p className="mt-1 text-xs text-amber-200/80">
        This records the intent to run in the facility source of truth. It
        shows as pending reconciliation until something deploys it — today,
        that's Provision. This action does not deploy anything itself.
      </p>
      <textarea
        className="mt-2 w-full rounded border border-white/10 bg-black/20 p-1 text-xs text-text"
        placeholder="Reason (required, recorded in the audit trail)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
      />
      {failed && (
        <p className="mt-1 text-xs text-red-300">
          The desired state was not recorded — nothing changed. Check your access, then retry.
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className="btn btn-primary btn-sm"
          disabled={!reason.trim() || pending}
          onClick={submit}
        >
          {pending ? 'Recording…' : 'Confirm'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => {
            setConfirming(false)
            setReason('')
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
