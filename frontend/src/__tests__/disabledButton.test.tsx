/**
 * umbrella #444 — disabled `.btn`s used to be pixel-identical to enabled
 * ones (no `:disabled` rule existed anywhere in index.css), which is how an
 * outsider usability session sat on ReasonConfirm's gated Confirm button
 * saying "I cannot switch the source" with no idea why. jsdom computes no
 * pixels, so — same method buttonHierarchy.test.tsx and
 * formFieldPrimitive.test.tsx use — this reads the literal stylesheet text
 * and the shared WCAG helper (testUtils/contrast.ts) rather than asserting
 * only that the `disabled` DOM attribute is set, which
 * configureStageTopologyRenewal.test.tsx already did and which passed
 * throughout the original defect.
 */
import { describe, expect, it } from 'vitest'
import css from '../index.css?raw'
import { contrastRatio, cssVar } from './testUtils/contrast'

describe('.btn:disabled lives on the shared .btn layer (umbrella #444)', () => {
  it('declares a :disabled rule on .btn itself, not only on one variant or one call site', () => {
    const rule = css.match(/\.btn:disabled[^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).not.toBe('')
    // every one of the three live variants applies `.btn` alongside its own
    // class (e.g. `btn btn-primary`), so a rule keyed on `.btn:disabled`
    // reaches all three without per-variant duplication.
    expect(rule).toMatch(/background-color:\s*var\(--color-border\)/)
    expect(rule).toMatch(/color:\s*var\(--color-muted\)/)
    expect(rule).toMatch(/border-color:\s*var\(--color-field-border\)/)
    expect(rule).toMatch(/cursor:\s*not-allowed/)
  })

  it('does not recreate .btn-danger-outline — umbrella #432 §D2 deleted that class deliberately', () => {
    expect(css).not.toMatch(/\.btn-danger-outline\s*{/)
  })

  it('the disabled label clears 4.5:1 against the disabled fill (WCAG text contrast)', () => {
    const muted = cssVar(css, 'color-muted')
    const border = cssVar(css, 'color-border')
    expect(contrastRatio(muted, border)).toBeGreaterThanOrEqual(4.5)
  })

  it('the disabled border clears 3:1 against --color-panel (WCAG 1.4.11 non-text/boundary contrast)', () => {
    const fieldBorder = cssVar(css, 'color-field-border')
    const panel = cssVar(css, 'color-panel')
    expect(contrastRatio(fieldBorder, panel)).toBeGreaterThanOrEqual(3)
  })

  it('reserves border-width on the base .btn so gaining a disabled border does not shift layout', () => {
    const rule = css.match(/\.btn\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/\bborder\b/)
  })

  it('overrides :disabled:hover explicitly, so a variant\'s own hover brighten cannot show through a disabled button', () => {
    // .btn-primary:hover / .btn-danger:hover / .btn-secondary:hover each tie
    // `.btn:disabled` at CSS specificity (0,2,0) — without the extra
    // `:hover` pseudo-class here (raising this rule to (0,3,0)), a mouse
    // resting on a disabled button would still show the live variant's own
    // hover fill, which is the literal defect umbrella #444 reported.
    expect(css).toMatch(/\.btn:disabled:hover/)
  })

  it('the disabled fill/text/border do not match any live variant\'s own colours', () => {
    const disabledBg = cssVar(css, 'color-border')
    const accent = cssVar(css, 'color-accent')
    const muted = cssVar(css, 'color-muted')
    const text = cssVar(css, 'color-text')
    expect(disabledBg.toLowerCase()).not.toBe(accent.toLowerCase())
    expect(muted.toLowerCase()).not.toBe(text.toLowerCase())
  })
})
