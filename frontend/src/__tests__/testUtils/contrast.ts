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
 * BUG FOUND AND FIXED (dmfdeploy/dmfdeploy#512 fix round, first pass): this
 * used to regex the raw CSS text directly, comments included. index.css's
 * own doc comments routinely restate a token's value in prose for
 * readability (e.g. "--color-rail-fill: #2c2c2e, Y=0.0253 — the rail key's
 * face...") — text that matches this function's own pattern just as well
 * as the REAL declaration a few lines below it. Since a bare (non-`/g`)
 * `.match` returns the FIRST hit, a comment mentioning a token's value
 * BEFORE its real declaration silently won the match — a mutation to the
 * real, live declaration went completely unobserved, and the test
 * measuring it kept passing for the wrong reason. Caught by hand
 * (mutation-testing this exact function's own caller,
 * railEdgeContrast.test.tsx) precisely because a "mutate the value,
 * confirm the test fails" pass reported a pass it should not have. That
 * first fix stripped `/* ... *\/` comments with a blanket regex before
 * matching.
 *
 * CODEX GATE, P2 (dmfdeploy/dmfdeploy#512) — three more ways to win a
 * false match, all REPRODUCED against the first-pass fix above and fixed
 * here:
 *
 *   (a) A `content:` string VALUE containing a token mention (e.g.
 *       `content: "--color-rail-fill: #111111"` in some unrelated
 *       decorative rule) is not a comment, so the blanket comment-stripper
 *       left it alone — and a bare (non-`/g`) `.match` still takes
 *       whichever occurrence comes FIRST in the text, string or not.
 *       Reproduced: such a string ahead of the real declaration won.
 *
 *   (b) No boundary check before the name: the pattern `--${name}:` has no
 *       anchor ruling out more identifier characters immediately before
 *       it, so `--theme--color-rail-fill: #999999` contains the exact
 *       substring `--color-rail-fill:` and satisfies a lookup for
 *       `color-rail-fill` even though it is a DIFFERENT custom property.
 *       Reproduced: `--theme--color-rail-fill` won over the real
 *       `--color-rail-fill`.
 *
 *   (c) The comment-stripper itself is blind to string literals: it scans
 *       for the next literal `/ *` ... `* /` pair with no notion of "inside
 *       a string." A CSS string VALUE that happens to contain a bare `/ *`
 *       (e.g. `content: "hello /* world"`, a syntactically valid string —
 *       the quotes make it just text, not a real comment open) makes the
 *       blanket regex treat everything from there up to the NEXT real
 *       `* /` — which can be a real, unrelated trailing comment — as one
 *       giant comment, silently deleting a live declaration that sat in
 *       between. Reproduced: the real `--color-rail-fill` declaration was
 *       deleted entirely, and lookup failed as if the token didn't exist.
 *
 * FIXED by replacing the regex comment-stripper with a small character
 * scanner (`maskCommentsAndStrings`) that tracks whether it is currently
 * inside a `"`/`'` string and only treats `/ *` as a real comment start
 * when it is NOT — closing (b)'s question of "was that `/ *` real" and (c)'s
 * "did a string's `/ *` eat a real declaration" the same way a CSS
 * tokenizer would. String contents (not the quotes) are blanked the same
 * way comments are, so (a)'s `content: "..."` mention can never match
 * either. On top of the masked text, the declaration lookup adds a
 * negative lookbehind, `(?<![\w-])`, immediately before the leading `--` —
 * a real declaration is never preceded by another identifier character or
 * dash, so `--theme--color-rail-fill` can no longer satisfy a lookup for
 * `color-rail-fill` (closing (b) structurally, not by exclusion list).
 *
 * CONFIRMED CLEAN (not bugs): a token used as a NAME SUFFIX, e.g.
 * `--color-rail-fill-hover`, cannot match a lookup for `color-rail-fill`
 * regardless of boundary handling, because the pattern requires a literal
 * `:` immediately after the name and `-hover` sits in the way. And this
 * file's masking only needs to understand `/ *...* /` block comments, not
 * `//` line comments — CSS has no `//` comment syntax, so not handling it
 * introduces no gap.
 */
function maskCommentsAndStrings(css: string): string {
  let out = ''
  let i = 0
  const n = css.length
  let quote: '"' | "'" | null = null
  while (i < n) {
    const c = css[i]
    if (quote) {
      if (c === '\\' && i + 1 < n) {
        out += '  '
        i += 2
        continue
      }
      out += c === quote ? c : ' '
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += ' '.repeat(stop - i)
      i = stop
      continue
    }
    out += c
    i++
  }
  return out
}

export function cssVar(css: string, name: string): string {
  const masked = maskCommentsAndStrings(css)
  const m = masked.match(new RegExp(`(?<![\\w-])--${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!m) throw new Error(`--${name} not found in index.css (outside comments/strings)`)
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
