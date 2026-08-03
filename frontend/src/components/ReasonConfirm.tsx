import { useState } from 'react'

/**
 * Armed-confirm + mandatory-reason panel for a consequential write (the C5
 * quartet: nothing fires on the first click; a reason is required and lands in
 * the audit trail). Extracted from the clear-for-deployment surface so the
 * catalog deploy/teardown and the Activity Jobs launch share one graduated-
 * friction affordance (UX Constitution hard gate 3, #185 WP-E).
 *
 * ``variant="danger"`` (umbrella #347, Console UX Constitution Art. 7 —
 * "destructive" needs MORE friction than "disruptive"): a distinct red
 * treatment plus a redundant text+icon badge (Art. 11 — colour is never the
 * only signal), for actions with no rollback path, layered on top of the
 * SAME typed-``extraField`` + mandatory-reason mechanics every variant
 * shares. Defaults to ``"warning"`` (byte-for-byte the original amber
 * styling) so every existing caller is unaffected.
 */
export interface ReasonConfirmExtraField {
  label: string
  placeholder?: string
  helperText?: string
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  invalidHint?: string
  // umbrella #201 WP5: when provided, renders a <select> of these options
  // (e.g. the switch-source target picker) instead of the default free-text
  // <input> — every other consumer (the #239 workload field) omits this and
  // is unaffected.
  options?: { value: string; label: string }[]
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
  variant = 'warning',
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
  variant?: 'warning' | 'danger'
}) {
  const [reason, setReason] = useState('')
  const extraInvalid = extraField?.invalid ?? false
  const danger = variant === 'danger'

  return (
    <div
      className={
        danger
          ? 'min-w-64 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-red-100'
          : 'min-w-64 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100'
      }
    >
      {danger && (
        <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-red-300">
          <span aria-hidden="true">⚠</span>
          <span>Destructive — cannot be undone</span>
        </div>
      )}
      <div className="text-xs font-semibold">{title}</div>
      <p className={`mt-1 text-xs ${danger ? 'text-red-200/80' : 'text-amber-200/80'}`}>{description}</p>
      <textarea
        className="mt-2 w-full rounded border border-white/10 bg-black/20 p-1 text-xs text-text"
        placeholder="Reason (required, recorded in the audit trail)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
      />
      {extraField && (
        <div className="mt-2">
          <label className={`block text-xs ${danger ? 'text-red-200/80' : 'text-amber-200/80'}`}>
            {extraField.label}
          </label>
          {extraField.options ? (
            <select
              className="mt-1 w-full rounded border border-white/10 bg-black/20 p-1 text-xs text-text"
              value={extraField.value}
              onChange={(e) => extraField.onChange(e.target.value)}
            >
              <option value="" disabled>
                {extraField.placeholder ?? 'Select…'}
              </option>
              {extraField.options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="mt-1 w-full rounded border border-white/10 bg-black/20 p-1 text-xs text-text"
              placeholder={extraField.placeholder}
              value={extraField.value}
              onChange={(e) => extraField.onChange(e.target.value)}
            />
          )}
          {extraInvalid && extraField.invalidHint ? (
            <p className="mt-1 text-[11px] text-red-300">{extraField.invalidHint}</p>
          ) : extraField.helperText ? (
            <p className={`mt-1 text-[11px] ${danger ? 'text-red-200/60' : 'text-amber-200/60'}`}>
              {extraField.helperText}
            </p>
          ) : null}
        </div>
      )}
      {error != null && error !== false && (
        <p className="mt-1 text-xs text-red-300">
          {/* Art. 8: the operator gets what happened and what is safe to do
              next, not a stringified exception. Fixed here so all three
              stages inherit it rather than each growing its own copy. */}
          That didn&apos;t go through — nothing was changed. Check your access, then retry.
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`}
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
