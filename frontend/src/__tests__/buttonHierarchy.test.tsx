/**
 * umbrella #432 §D2/§D3 — button hierarchy fixes that don't belong inside
 * any single existing stage's test file:
 *
 *   - §D3: `.btn-secondary`'s boundary contrast, read straight out of
 *     index.css itself (same method §C's formFieldPrimitive.test.tsx uses
 *     for `.field`, and the same shared WCAG helper — testUtils/contrast.ts
 *     — so this isn't a second copy of that formula either). A test that
 *     hand-copied the border colour into TS would keep passing even if the
 *     real CSS regressed back under 3:1; this reads the literal stylesheet
 *     text instead.
 *   - §D2: `.btn-danger-outline` exists and is distinct from both
 *     `.btn-secondary` and filled `.btn-danger` in the same stylesheet.
 *   - §D2 FIX ROUND (operator report on 0.27.0): `.btn-danger-outline`'s
 *     own boundary contrast, same method and same shared helper — the
 *     border used to be `border-red-500/60`, an alpha blend that
 *     composited to only 2.45:1 against --color-panel. Now a solid token
 *     (--color-danger-border), so the ratio is readable straight from
 *     index.css rather than requiring alpha-compositing math against an
 *     opaque `border-red-500/60`-style utility name.
 *
 * "⏏ Teardown" actually rendering `.btn-danger-outline` (not
 * `.btn-secondary`) is pinned in workloadSetup.test.tsx, beside the rest of
 * that button's own behaviour — not repeated here.
 */
import { describe, expect, it } from 'vitest'
import css from '../index.css?raw'
import { contrastRatio, cssVar } from './testUtils/contrast'

describe('.btn-secondary boundary, read from index.css itself', () => {
  it('applies border-field-border, not the old border-muted/30', () => {
    const rule = css.match(/\.btn-secondary\s*{[^}]*}/)?.[0] ?? ''
    expect(rule).toMatch(/\bborder-field-border\b/)
    expect(rule).not.toMatch(/border-muted\/30/)
  })

  it('gives .btn-secondary\'s border >=3:1 non-text contrast (WCAG 1.4.11) against --color-panel', () => {
    const panel = cssVar(css, 'color-panel')
    const fieldBorder = cssVar(css, 'color-field-border')
    expect(contrastRatio(fieldBorder, panel)).toBeGreaterThanOrEqual(3)
  })
})

describe('.btn-danger-outline exists as a tier distinct from .btn-secondary and .btn-danger', () => {
  it('is defined in index.css with its own red border/text, not the neutral secondary treatment', () => {
    const rule = css.match(/\.btn-danger-outline\s*{[^}]*}/)?.[0] ?? ''
    expect(rule).toBeTruthy()
    expect(rule).toMatch(/text-red-400/)
    expect(rule).toMatch(/\bborder-danger-border\b/)
    // Panel fill, not the solid red fill filled .btn-danger uses — that's
    // the whole point of a lower-weight tier than the filled one.
    expect(rule).toMatch(/bg-panel/)
  })

  // umbrella #432 §D2 FIX ROUND: the boundary contrast itself, not just
  // which class references it — a rule that referenced a token whose own
  // value regressed under 3:1 would still pass the test above.
  it('gives .btn-danger-outline\'s border >=3:1 non-text contrast (WCAG 1.4.11) against --color-panel', () => {
    const panel = cssVar(css, 'color-panel')
    const dangerBorder = cssVar(css, 'color-danger-border')
    expect(contrastRatio(dangerBorder, panel)).toBeGreaterThanOrEqual(3)
  })

  it('is NOT an alpha-blend utility on the border — border-red-500/60 measured 2.45:1, below the floor', () => {
    const rule = css.match(/\.btn-danger-outline\s*{[^}]*}/)?.[0] ?? ''
    expect(rule).not.toMatch(/border-red-500\/60/)
  })
})
