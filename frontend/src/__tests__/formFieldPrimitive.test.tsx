/**
 * The shared form-field primitive (components/FormField.tsx, umbrella #432
 * §C). What's pinned here, rather than re-derived at each migrated call
 * site's own test file:
 *
 *   - the boundary contrast is READ OUT OF index.css itself, not a copy of
 *     the hex duplicated into a test. A test that hand-copies
 *     `--color-field-border`'s value into TS would keep passing even if the
 *     real CSS regressed under 3:1 — it would prove nothing about what
 *     actually ships. This parses the literal stylesheet text instead, the
 *     same source the rendered component's real colour comes from, and
 *     computes the WCAG ratio from that parsed value (the formula itself is
 *     the published algorithm, not an app colour — reproducing it here
 *     doesn't reintroduce the duplication this exists to avoid).
 *   - that the class the contrast was computed for (`.field`) is the one
 *     the component actually renders, closing the loop between "what the
 *     DOM node gets" and "what that class's CSS says".
 *
 * Each of the six migrated call sites' own render-through-the-primitive
 * assertion (createWorkload.test.tsx, reasonConfirm.test.tsx,
 * clearForDeploymentCopy.test.tsx, adminInvite.test.tsx) and the
 * focus-on-entry pin (createWorkload.test.tsx) live next to the behaviour
 * they're already testing, not duplicated here a second time.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Input } from '../components/FormField'
// Vite's raw-asset import — the literal text of the real stylesheet, not a
// Node `fs` read (this project has no `@types/node`, and adding one is an
// npm dependency this order forbids).
import css from '../index.css?raw'
// umbrella #432 §D3: extracted to testUtils/contrast.ts so
// buttonHierarchy.test.tsx's own contrast check (.btn-secondary) reads the
// SAME WCAG formula rather than a second copy of it.
import { contrastRatio, cssVar } from './testUtils/contrast'

describe('the form-field boundary, read from index.css itself', () => {
  it('applies border-field-border to .field — the class the contrast below is actually computed for', () => {
    const fieldRule = css.match(/\.field\s*{[^}]*}/)?.[0] ?? ''
    expect(fieldRule).toMatch(/\bborder-field-border\b/)
  })

  it('gives the field boundary >=3:1 non-text contrast (WCAG 1.4.11) against --color-panel', () => {
    const panel = cssVar(css, 'color-panel')
    const fieldBorder = cssVar(css, 'color-field-border')
    expect(contrastRatio(fieldBorder, panel)).toBeGreaterThanOrEqual(3)
  })

  it('gives the :focus-visible ring >=3:1 contrast against --color-panel', () => {
    const panel = cssVar(css, 'color-panel')
    const accent = cssVar(css, 'color-accent')
    const ringRule = css.match(/\.field:focus-visible\s*{[^}]*}/)?.[0] ?? ''
    expect(ringRule).toMatch(/var\(--color-accent\)/)
    expect(contrastRatio(accent, panel)).toBeGreaterThanOrEqual(3)
  })

  it('renders <Input> through the .field class this contrast was computed for', () => {
    const { container } = render(<Input aria-label="probe" />)
    const input = container.querySelector('input')
    expect(input?.className.split(/\s+/)).toContain('field')
  })
})
