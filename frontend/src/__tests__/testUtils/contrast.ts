/**
 * WCAG 2.x relative luminance / contrast ratio (umbrella #432 §C, extracted
 * for §D's reuse rather than a second copy) — the published formula
 * (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance), not an app colour
 * value, so sharing/using it doesn't reintroduce the duplication these
 * tests exist to avoid. Callers read the actual colour hex out of the real
 * stylesheet (index.css, via Vite's `?raw` import) and pass it in here —
 * see formFieldPrimitive.test.tsx and buttonHierarchy.test.tsx for that half.
 */

export function cssVar(css: string, name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!m) throw new Error(`--${name} not found in index.css`)
  return m[1]
}

function srgbToLinear(c: number): number {
  const cs = c / 255
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  const n = hex.replace('#', '')
  const r = parseInt(n.slice(0, 2), 16)
  const g = parseInt(n.slice(2, 4), 16)
  const b = parseInt(n.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}
