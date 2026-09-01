import { useState } from 'react'
import { Input, Select, Textarea } from './FormField'

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
 *
 * umbrella #432, FIX ROUND (operator report, live: "too much small text on
 * those provision / switch / teardown / delete action"). Every size in this
 * component used to sit at 11-12px (title/description text-xs, the reason
 * field's own `field-xs` density, helper/hint text-[11px]) — dense enough
 * that the panel read as a wall of fine print rather than a confirm step.
 * Raised one step across the board — text-xs -> text-sm, the reason/extra
 * fields off `density="xs"` onto FormField's own base size — while keeping
 * the SAME hierarchy (danger banner > title > description > field > helper):
 * nothing here changed relative WEIGHT, only absolute scale and breathing
 * room. `min-w-64` -> `min-w-80` so the wider type has room to sit
 * comfortably rather than wrapping tighter than before. `clear-for-deployment`
 * (ClearForDeployment.tsx) is a separate component that duplicates this same
 * shell rather than rendering THIS one, but reads as the identical
 * affordance to an operator — scaled identically there, in its own file,
 * for the same reason.
 *
 * FIX ROUND (0.28.0 walk finding): `min-w-80` is a MINIMUM — every call
 * site (FinaliseStage.tsx's Teardown/Delete permanently armed panels,
 * ConfigureStage.tsx's Switch source, Catalog/index.tsx,
 * Activity/JobsLane.tsx) mounts this as a bare block inside a wide stage
 * row with nothing else constraining it, so it stretched to fill that row
 * — measured live at 1988px, its description rendered as one 1954px
 * unwrapped line. Pre-existing (min-w-64 had the identical defect before
 * the type-scale round), just made worse by the larger type growing the
 * line length with it — the same "sized by its container, not its
 * content" class as §C's 1295px form field. `max-w-sm` (384px) caps it:
 * at this component's own 14px body text, that leaves ~352px of content
 * width after padding — roughly 45-50 characters per line, the low end of
 * the 45-75ch comfortable-measure range, appropriate for a compact confirm
 * popover rather than a full reading column.
 *
 * RETIRED CROSS-CHECK (umbrella #518): this component used to ALSO render
 * inside a promoted-action popover (ProvisionStage.tsx's own wrapper, fixed
 * at `w-80` = 320px) as well as inline — at the time this sizing was
 * chosen, 320px was checked against `min-w-80`/`max-w-sm` to confirm the
 * promoted case rendered unchanged. That portal is deleted (Deploy renders
 * inline unconditionally now, see ProvisionStage.tsx's own docstring). Every
 * call site (ProvisionStage.tsx, ConfigureStage.tsx, FinaliseStage.tsx,
 * CreateWorkload.tsx, Catalog/index.tsx, Activity/JobsLane.tsx — verified
 * against the real caller list, not assumed) mounts this inline, in its own
 * page or panel body, none through a portal — so there is no second width
 * anywhere to keep in agreement with.
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
          ? 'min-w-80 max-w-sm rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-100'
          : 'min-w-80 max-w-sm rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-amber-100'
      }
    >
      {danger && (
        <div className="mb-1.5 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-red-300">
          <span aria-hidden="true">⚠</span>
          <span>Destructive — cannot be undone</span>
        </div>
      )}
      <div className="text-sm font-semibold">{title}</div>
      <p className={`mt-1.5 text-sm ${danger ? 'text-red-200/80' : 'text-amber-200/80'}`}>{description}</p>
      <Textarea
        className="mt-3"
        placeholder="Reason (required, recorded in the audit trail)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
      />
      {extraField && (
        <div className="mt-3">
          <label className={`block text-sm ${danger ? 'text-red-200/80' : 'text-amber-200/80'}`}>
            {extraField.label}
          </label>
          {extraField.options ? (
            <Select
              className="mt-1.5"
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
            </Select>
          ) : (
            <Input
              type="text"
              className="mt-1.5"
              placeholder={extraField.placeholder}
              value={extraField.value}
              onChange={(e) => extraField.onChange(e.target.value)}
            />
          )}
          {extraInvalid && extraField.invalidHint ? (
            <p className="mt-1.5 text-xs text-red-300">{extraField.invalidHint}</p>
          ) : extraField.helperText ? (
            <p className={`mt-1.5 text-xs ${danger ? 'text-red-200/60' : 'text-amber-200/60'}`}>
              {extraField.helperText}
            </p>
          ) : null}
        </div>
      )}
      {error != null && error !== false && (
        <p className="mt-1.5 text-sm text-red-300">
          {/* Art. 8: the operator gets what happened and what is safe to do
              next, not a stringified exception. Fixed here so all three
              stages inherit it rather than each growing its own copy. */}
          That didn&apos;t go through — nothing was changed. Check your access, then retry.
        </p>
      )}
      <div className="mt-3 flex gap-2">
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
