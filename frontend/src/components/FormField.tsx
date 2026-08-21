import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

/**
 * The console's one shared form-control appearance (umbrella #432 §C).
 *
 * Before this, every text input/textarea/select hand-rolled its own
 * `bg-black/20 border-white/10` at its own call site — measured live on
 * 0.26.0 as a ~1.03:1 fill-vs-panel (i.e. invisible) and a sub-pixel
 * 0.667px border, with no focus-visible ring of its own (`outline: none`
 * falling through to whatever the browser's UA default happened to be).
 * `.field` (index.css) is now the ONLY place a form control's appearance is
 * defined: a solid, opaque `--color-field-border` chosen for >=3:1
 * non-text contrast (WCAG 1.4.11) against `--color-panel` (measured
 * 3.64:1 — see formFieldPrimitive.test.tsx, which parses index.css
 * directly rather than trusting a copy of the hex living in this file), a
 * real `:focus-visible` ring in `--color-accent` (11.0:1 against panel),
 * and a real >=1px border.
 *
 * WHY A DENSITY PROP, NOT A SEPARATE COMPONENT PER SIZE. ReasonConfirm's
 * and ClearForDeployment's fields sit inside a `min-w-64` floating confirm
 * panel and were always visually tighter than a full-page field — a real,
 * deliberate density difference between two contexts, not drift to undo.
 * `density="xs"` reproduces it from the one shared base instead of
 * forking the component.
 *
 * WHY `prefix` LIVES HERE RATHER THAN AT THE CALL SITE. The workload slug
 * field's `workload:` adornment is a plain label beside the control, same
 * relationship as the original markup (an un-bordered <span> next to the
 * bordered <input>) — `prefix` keeps that, rather than merging it into the
 * control's own border, so the control itself is still the one thing
 * `.field` styles and callers migrate onto it without a layout redesign.
 * What moves here is the WIDTH CAP: the caller's `className` always lands
 * on whichever element is the whole visual group — the flex row when a
 * prefix is present, the <input> itself otherwise — never on just the
 * <input> when a prefix sits outside of it, which would cap only part of
 * what the operator reads as one field.
 *
 * NO `disabled` VISUAL STATE. This codebase never renders a locked control
 * as `disabled` (FlowStep.tsx, ViewLiveExit.tsx) — an inert, unexplained
 * greyed-out field would be exactly that failure mode, so `.field` defines
 * none. `readOnly` (Admin's enrollment URL) is unaffected: it displays a
 * value rather than standing in for a withheld action, so it needs no
 * explanation the way a disabled control would.
 *
 * NO LABEL/CAPTION/ERROR WRAPPER. Every label/caption/error string at the
 * six migrated call sites is bespoke prose (Art. 8 copy, not boilerplate
 * markup) — wrapping it in a shared component would add indirection
 * without removing any real duplication, so this module stays scoped to
 * the control itself.
 */

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

type Density = 'xs'

const DENSITY_CLASS: Record<Density, string> = {
  xs: 'field-xs',
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  density?: Density
  /** Leading adornment rendered inside the control's own bordered row
   *  (e.g. the workload slug field's `workload:`) — not a separate element
   *  the operator has to read as attached only by being next to it. */
  prefix?: ReactNode
  /** Focuses this field once, on mount only — never on a later re-render
   *  (this field's own state changing, or anything else on the page), and
   *  without the page-scroll a bare `.focus()` can cause. Exactly one call
   *  site needs this today (CreateWorkload's studio name — umbrella #432
   *  measured defect: `document.activeElement` was `BODY` on load, nothing
   *  was ever focused), so it is opt-in, not a default every field gets. */
  focusOnMount?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { density, prefix, focusOnMount, className = '', ...props },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement>(null)
  useImperativeHandle(forwardedRef, () => innerRef.current as HTMLInputElement)

  // Empty deps: this runs exactly once, at mount — never again on a later
  // re-render, so it can never steal focus back from wherever the operator
  // has since moved it (a different field, a later wizard step).
  useEffect(() => {
    if (focusOnMount) innerRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasPrefix = prefix != null && prefix !== false
  const fieldClassName = cx('field', density && DENSITY_CLASS[density], hasPrefix && 'flex-1 min-w-0')
  const control = (
    <input ref={innerRef} className={hasPrefix ? fieldClassName : cx(fieldClassName, className)} {...props} />
  )

  if (!hasPrefix) return control

  return (
    <div className={cx('flex items-center gap-1', className)}>
      <span className="shrink-0 font-mono text-muted">{prefix}</span>
      {control}
    </div>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  density?: Density
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { density, className = '', ...props },
  ref,
) {
  return <textarea ref={ref} className={cx('field', density && DENSITY_CLASS[density], className)} {...props} />
})

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  density?: Density
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { density, className = '', children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cx('field', density && DENSITY_CLASS[density], className)} {...props}>
      {children}
    </select>
  )
})
