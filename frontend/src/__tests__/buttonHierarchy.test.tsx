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
 *   - §D2 REVERSAL (operator, live on 0.27.1: "the teardown button is
 *     still not very readable with the nearblack and red combination"):
 *     `.btn-danger-outline` briefly existed as a second danger tier —
 *     6.65:1 by the WCAG formula, and still read as barely-there, because
 *     WCAG 1.4.11's contrast is luminance-only and red carries the
 *     smallest luminance weight of the three channels. It's gone now
 *     (Teardown is filled `.btn-danger`, same as Delete permanently), and
 *     this pins that it's actually gone from the stylesheet — not just
 *     that Teardown stopped referencing it (which workloadSetup.test.tsx
 *     already pins, beside the rest of that button's own behaviour).
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

describe('.btn-danger-outline is deleted, not left unused (umbrella #432 §D2 REVERSAL)', () => {
  // Matches the actual RULE/DECLARATION syntax, not a bare substring — the
  // reversal's own historical comment on .btn-danger legitimately mentions
  // both names in prose, and a substring match would (wrongly) flag that
  // documentation as "still there".
  it('has no rule in index.css any more', () => {
    expect(css).not.toMatch(/\.btn-danger-outline\s*{/)
  })

  it('its border token, --color-danger-border, is deleted too — nothing else referenced it', () => {
    expect(css).not.toMatch(/--color-danger-border:\s*#/)
  })
})
