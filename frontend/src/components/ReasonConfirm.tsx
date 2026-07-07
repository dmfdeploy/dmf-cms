import { useState } from 'react'

/**
 * Armed-confirm + mandatory-reason panel for a consequential write (the C5
 * quartet: nothing fires on the first click; a reason is required and lands in
 * the audit trail). Extracted from the clear-for-deployment surface so the
 * catalog deploy/teardown and the Activity Jobs launch share one graduated-
 * friction affordance (UX Constitution hard gate 3, #185 WP-E).
 */
export default function ReasonConfirm({
  title,
  description,
  confirmLabel = 'Confirm',
  pendingLabel = 'Recording…',
  pending = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string
  description: string
  confirmLabel?: string
  pendingLabel?: string
  pending?: boolean
  error?: unknown
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')

  return (
    <div className="min-w-64 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100">
      <div className="text-xs font-semibold">{title}</div>
      <p className="mt-1 text-xs text-amber-200/80">{description}</p>
      <textarea
        className="mt-2 w-full rounded border border-white/10 bg-black/20 p-1 text-xs text-text"
        placeholder="Reason (required, recorded in the audit trail)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
      />
      {error != null && error !== false && (
        <p className="mt-1 text-xs text-red-300">{String(error)}</p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className="btn btn-primary btn-sm"
          disabled={!reason.trim() || pending}
          onClick={() => onConfirm(reason.trim())}
        >
          {pending ? pendingLabel : confirmLabel}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </div>
  )
}
