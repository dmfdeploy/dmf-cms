/**
 * WCAG 2.x relative luminance / contrast ratio (umbrella #432 §C, extracted
 * for §D's reuse rather than a second copy) — the published formula
 * (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance), not an app colour
 * value, so sharing/using it doesn't reintroduce the duplication these
 * tests exist to avoid. Callers read the actual colour hex out of the real
 * stylesheet (index.css, via Vite's `?raw` import) and pass it in here —
 * see formFieldPrimitive.test.tsx and buttonHierarchy.test.tsx for that half.
 */

/**
 * BUG FOUND AND FIXED (dmfdeploy/dmfdeploy#512 fix round): this used to
 * regex the raw CSS text directly, comments included. index.css's own doc
 * comments routinely restate a token's value in prose for readability
 * (e.g. "--color-rail-fill: #2c2c2e, Y=0.0253 — the rail key's face...")
 * — text that matches this function's own pattern just as well as the
 * REAL declaration a few lines below it. Since a bare (non-`/g`) `.match`
 * returns the FIRST hit, a comment mentioning a token's value BEFORE its
 * real declaration silently won the match — a mutation to the real,
 * live declaration went completely unobserved, and the test measuring it
 * kept passing for the wrong reason. Caught by hand (mutation-testing this
 * exact function's own caller, railEdgeContrast.test.tsx) precisely
 * because a "mutate the value, confirm the test fails" pass reported a
 * pass it should not have. Comments are stripped before matching now, so
 * only a real `--name: #hex` declaration can ever be found.
 */
export function cssVar(css: string, name: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = withoutComments.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!m) throw new Error(`--${name} not found in index.css (outside comments)`)
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
