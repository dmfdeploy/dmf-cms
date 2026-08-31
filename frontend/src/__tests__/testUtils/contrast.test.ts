/**
 * Regression tests for `cssVar()` itself (dmfdeploy/dmfdeploy#512 codex gate,
 * P2). Three shared callers (railEdgeContrast.test.tsx,
 * formFieldPrimitive.test.tsx, buttonHierarchy.test.tsx) all trust this
 * function to find the ONE real declaration of a custom property in raw
 * CSS text — a false match here silently corrupts every contrast
 * assertion built on top of it, the same failure shape as the
 * comment-vs-declaration bug this file's sibling doc comment already
 * describes. These pin codex's own three repro strings so the fix doesn't
 * quietly regress the next time someone touches `maskCommentsAndStrings`
 * or the declaration regex.
 */
import { describe, expect, it } from 'vitest'
import { cssVar } from './contrast'

describe('cssVar', () => {
  it('finds a real declaration in ordinary CSS', () => {
    const css = `
      :root {
        --color-rail-fill: #2c2c2e;
      }
    `
    expect(cssVar(css, 'color-rail-fill')).toBe('#2c2c2e')
  })

  it('ignores a doc comment restating the value in prose before the real declaration (first-pass fix, still covered)', () => {
    const css = `
      /* --color-rail-fill: #111111 is mentioned here for readability */
      --color-rail-fill: #2c2c2e;
    `
    expect(cssVar(css, 'color-rail-fill')).toBe('#2c2c2e')
  })

  it('(codex a) ignores a token mention inside a content: string value', () => {
    const css = `
      .foo::before { content: "--color-rail-fill: #111111"; }
      --color-rail-fill: #2c2c2e;
    `
    expect(cssVar(css, 'color-rail-fill')).toBe('#2c2c2e')
  })

  it('(codex b) does not let --theme--color-rail-fill satisfy a lookup for color-rail-fill', () => {
    const css = `
      --theme--color-rail-fill: #999999;
      --color-rail-fill: #2c2c2e;
    `
    expect(cssVar(css, 'color-rail-fill')).toBe('#2c2c2e')
  })

  it('(codex c) a string value containing /* does not make the masker eat a real declaration up to the next unrelated comment', () => {
    const css = `
      .foo { content: "hello /* world"; }
      --color-rail-fill: #2c2c2e;
      /* trailing comment */
    `
    expect(cssVar(css, 'color-rail-fill')).toBe('#2c2c2e')
  })

  it('confirmed clean: a name used only as a suffix (e.g. -hover) cannot satisfy the base lookup', () => {
    const css = `
      --color-rail-fill-hover: #999999;
      --color-rail-fill: #2c2c2e;
    `
    expect(cssVar(css, 'color-rail-fill')).toBe('#2c2c2e')
  })

  it('throws when the name genuinely has no real declaration', () => {
    const css = `
      /* --color-missing: #111111 (comment only) */
      .foo::before { content: "--color-missing: #222222"; }
      --color-missing-hover: #333333;
    `
    expect(() => cssVar(css, 'color-missing')).toThrow(/not found/)
  })
})
