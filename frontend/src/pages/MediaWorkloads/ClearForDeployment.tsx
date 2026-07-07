import { useState } from 'react'
import { useClearForDeployment } from '../../api/hooks'
import { useActivityStore } from '../../store/activity'
import type { ClearForDeploymentResult } from '../../api/types'

/**
 * The ONE consequential Media Workloads write, as a self-contained control so
 * the table cell and the tile footer share ONE audit path (hard gate 3 + C5):
 * click arms a per-instance confirm with an impact preview and a MANDATORY
 * reason; nothing fires on the first click. On success the console-local
 * Activity record is written (correlated by request_id) and the result bubbles
 * up so the page can show the confirmation banner + refetch inventory.
 */
export default function ClearForDeployment({
  instance,
  onCleared,
}: {
  instance: string
  onCleared?: (result: ClearForDeploymentResult) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const clearMutation = useClearForDeployment()

  const submit = () => {
    clearMutation.mutate(
      { instance, reason: reason.trim() },
      {
        onSuccess: (result) => {
          // C5: the console-local record also lands in Activity → History.
          useActivityStore.getState().recordClear(result)
          setConfirming(false)
          setReason('')
          onCleared?.(result)
        },
      },
    )
  }

  if (!confirming) {
    return (
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => {
          clearMutation.reset()
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
        This records the intent to run in the facility source of truth; the
        platform's automation lane will deploy it. The console does not start
        anything directly.
      </p>
      <textarea
        className="mt-2 w-full rounded border border-white/10 bg-black/20 p-1 text-xs text-text"
        placeholder="Reason (required, recorded in the audit trail)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
      />
      {clearMutation.isError && (
        <p className="mt-1 text-xs text-red-300">{String(clearMutation.error)}</p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className="btn btn-primary btn-sm"
          disabled={!reason.trim() || clearMutation.isPending}
          onClick={submit}
        >
          {clearMutation.isPending ? 'Recording…' : 'Confirm'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => {
            setConfirming(false)
            setReason('')
            clearMutation.reset()
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
