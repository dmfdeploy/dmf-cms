import { useState } from 'react'

/**
 * Armed-confirm + mandatory-reason panel for a consequential write (the C5
 * quartet: nothing fires on the first click; a reason is required and lands in
 * the audit trail). Extracted from the clear-for-deployment surface so the
 * catalog deploy/teardown and the Activity Jobs launch share one graduated-
 * friction affordance (UX Constitution hard gate 3, #185 WP-E).
 */
export interface ReasonConfirmExtraField {
  label: string
  placeholder?: string
  helperText?: string
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  invalidHint?: string
}

export default function ReasonConfirm({
  title,
  description,
  confirmLabel = 'Confirm',
  pendingLabel = 'Recording…',
  pending = false,
  error,
  onConfirm,
  onCancel,
  extraField,
}: {
  title: string
  description: string
  confirmLabel?: string
  pendingLabel?: string
  pending?: boolean
  error?: unknown
  onConfirm: (reason: string) => void
  onCancel: () => void
  // Optional single extra text input above the Confirm/Cancel row (e.g. #239
  // workload). Generic slot, not hardcoded to one feature — an invalid value
  // disables Confirm alongside the existing empty-reason guard.
  extraField?: ReasonConfirmExtraField
}) {
  const [reason, setReason] = useState('')
  const extraInvalid = extraField?.invalid ?? false

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
      {extraField && (
        <div className="mt-2">
          <label className="block text-xs text-amber-200/80">{extraField.label}</label>
          <input
            type="text"
            className="mt-1 w-full rounded border border-white/10 bg-black/20 p-1 text-xs text-text"
            placeholder={extraField.placeholder}
            value={extraField.value}
            onChange={(e) => extraField.onChange(e.target.value)}
          />
          {extraInvalid && extraField.invalidHint ? (
            <p className="mt-1 text-[11px] text-red-300">{extraField.invalidHint}</p>
          ) : extraField.helperText ? (
            <p className="mt-1 text-[11px] text-amber-200/60">{extraField.helperText}</p>
          ) : null}
        </div>
      )}
      {error != null && error !== false && (
        <p className="mt-1 text-xs text-red-300">{String(error)}</p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className="btn btn-primary btn-sm"
          disabled={!reason.trim() || pending || extraInvalid}
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
