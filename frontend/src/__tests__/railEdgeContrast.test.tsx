/**
 * The lifecycle rail's clipped shapes carry no border (a clip-path cannot
 * draw one), so a fill/edge colour IS the only thing making a silhouette
 * perceivable wherever one is meant to exist (#483). Two live relationships
 * this file asserts, both read straight out of the real stylesheet/
 * component source rather than copied into TS — the same technique
 * formFieldPrimitive.test.tsx already uses for `--color-field-border`, so a
 * regression in EITHER the CSS values or which token a component actually
 * paints fails here, not silently.
 *
 * WHAT CHANGED, AND WHY THIS FILE NO LONGER TESTS `--color-rail-edge`. That
 * token is RETIRED (dmfdeploy/dmfdeploy#512's final edge ruling — see
 * lib/stagePalette.ts's own docstring, point (4), for the two-pass
 * account): the rail's key-edge layer no longer holds a permanent neutral
 * ring at rest. It repaints the SAME token as the fill at rest (no ring at
 * all — the visible label text, not the silhouette, is what WCAG 1.4.11
 * treats as identifying the control here), and `--color-selected-face`
 * only on hover or once selected. So the live guarantee worth asserting
 * moved too: `--color-selected-face` — the ONLY colour that ever actually
 * renders as a visible ring or a selected face — must clear 3:1 against
 * both (a) the real band ground the rail's row paints, and (b) the rail's
 * own resting fill, since that is the fill-vs-fill relationship a selected
 * key (or a hovered one) is actually judged against.
 *
 * THE BACKDROP-DERIVATION TECHNIQUE (kept from the retired version, still
 * live): a hardcoded `cssVar(css, 'color-sidebar')` would only prove the
 * arithmetic is right for a token NAMED sidebar — it would not prove the
 * rail's row actually PAINTS that token. `bandBackgroundToken()` reads the
 * ACTUAL className Topbar.tsx renders for its header-slot row, straight out
 * of the component source, and the contrast assertion looks up whatever
 * token name that resolves to — not a name this file assumes. If Topbar's
 * row ever renders a class this regex cannot parse at all, the extraction
 * throws (fail closed, same convention as `cssVar`'s own "not found" error)
 * rather than silently falling back to an assumption.
 */
import { describe, expect, it } from 'vitest'
import css from '../index.css?raw'
import topbarSource from '../components/Topbar.tsx?raw'
import { contrastRatio, cssVar } from './testUtils/contrast'

/**
 * The single background colour TOKEN NAME (e.g. `sidebar`, not `bg-sidebar`
 * and not a hex) that Topbar.tsx's header-slot row actually renders, read
 * from the component's own source text.
 *
 * CODEX GATE, P2 (dmfdeploy/dmfdeploy#512) — REPRODUCED AND FIXED. The
 * first version of this function found the row's className text, then ran
 * `/\bbg-([a-z][\w-]*)\b/` (no `^`/`$` anchors) against the WHOLE string —
 * a SUBSTRING search, not a token match. Reproduced with codex's own exact
 * string, `className="hover:bg-bg bg-selected-face"`: the regex matches
 * `bg-bg` INSIDE `hover:bg-bg` first (it appears earlier in the string),
 * so the test would have measured against `--color-bg` and reported a
 * passing ~5:1 while the REAL resting background is `selected-face` and
 * the true ratio is 1:1 — the exact "fail open, not fail closed" defect
 * this function exists to prevent, one layer further out than the first
 * version closed it. The same shape of bug covers any variant prefix
 * (`hover:`, `focus:`, …) or opacity modifier (`bg-x/50`) appearing before
 * the row's real bg-* utility in its class list.
 *
 * FIXED by matching whole TOKENS, not substrings: the className is split
 * on whitespace, and each token is tested against `/^bg-[a-z][\w-]*$/`
 * anchored at BOTH ends — `hover:bg-bg` fails immediately (the token does
 * not START with `bg-`, it starts with `hover:`), and `bg-x/50` fails too
 * (the trailing `/50` cannot match `$` right after `[\w-]*`, since `/` is
 * outside that character class). Any token this anchored pattern accepts
 * is unambiguously a bare, unprefixed, unmodified `bg-*` utility. If MORE
 * than one such token is found, or NONE, this throws rather than silently
 * picking the first candidate ("fail loudly on multiple candidates rather
 * than taking the first" — the property this test cares about is "there
 * is exactly one bg-* utility, and this is it," not "here is A candidate").
 *
 * ALSO FIXED: the row-locating regex used `[\s\S]*?` between `data-testid`
 * and `className`, which does not stop at the row's own closing `>` — a
 * descendant element's className, if one existed earlier in the source
 * than the row's own, could win the (non-greedy but still cross-tag) match.
 * A plain `[^>]*?` bound is NOT the fix, despite looking like the obvious
 * one — this file's own doc comment between the two attributes mentions
 * `<header>` in prose, a literal `<`/`>` pair that has nothing to do with
 * JSX structure, and a bare character-class exclusion cannot tell prose
 * from markup. What actually distinguishes them in this codebase's own
 * formatting convention is that a REAL child/sibling element starts a NEW
 * LINE, indented, whereas an inline mention like `<header>` sits inside a
 * comment's running prose on an existing line. The negative lookahead
 * `(?!\n\s*<)` bounds the search to "not preceded by a line that starts a
 * new tag" — tolerant of `<header>`-in-prose, still stopping before any
 * genuine descendant markup.
 */
/** `source` defaults to the real Topbar.tsx text; overridable so codex's
 *  exact repro strings can be pinned as permanent regression tests below
 *  without needing to actually mutate the real component file for each. */
function bandBackgroundToken(source: string = topbarSource): string {
  const rowMatch = source.match(/data-testid="header-slot-row"((?:(?!\n\s*<)[\s\S])*?)className="([^"]+)"/)
  if (!rowMatch) throw new Error('header-slot-row element (or its className, within the SAME opening tag) not found — this test can no longer locate the rail band to check its backdrop')
  const classes = rowMatch[2]
  const bareBgTokens = classes.split(/\s+/).filter((token) => /^bg-[a-z][\w-]*$/.test(token))
  if (bareBgTokens.length === 0) {
    throw new Error(`header-slot-row className carries no unambiguous, unprefixed bg-* utility to check: "${classes}"`)
  }
  if (bareBgTokens.length > 1) {
    throw new Error(`header-slot-row className carries MULTIPLE candidate bg-* utilities, ambiguous which is the real backdrop: ${bareBgTokens.join(', ')} (from "${classes}")`)
  }
  return bareBgTokens[0].slice('bg-'.length)
}

describe('bandBackgroundToken, pinned against codex’s own repro strings', () => {
  it('extracts the real bg-* utility even when a variant-prefixed one appears earlier — codex’s exact repro', () => {
    const fakeSource = 'data-testid="header-slot-row" className="hover:bg-bg bg-selected-face"'
    expect(bandBackgroundToken(fakeSource)).toBe('selected-face')
  })

  it('rejects an opacity-modified utility rather than matching it', () => {
    const fakeSource = 'data-testid="header-slot-row" className="bg-selected-face/50"'
    expect(() => bandBackgroundToken(fakeSource)).toThrow(/no unambiguous/)
  })

  it('throws on multiple bare bg-* candidates rather than silently taking the first', () => {
    const fakeSource = 'data-testid="header-slot-row" className="bg-sidebar bg-selected-face"'
    expect(() => bandBackgroundToken(fakeSource)).toThrow(/MULTIPLE candidate/)
  })

  it('does not cross into a descendant element’s own className, even past an inline <tag>-in-prose mention', () => {
    const fakeSource = [
      'data-testid="header-slot-row"',
      '// see <header> for the ancestor role this maps to',
      'className="bg-sidebar"',
      '>',
      '  <div className="bg-wrong-descendant" />',
    ].join('\n')
    expect(bandBackgroundToken(fakeSource)).toBe('sidebar')
  })
})

describe('the rail selected/hover face, read from index.css and Topbar.tsx themselves', () => {
  it('Topbar.tsx header-slot row and this test agree on which token is the backdrop, and --color-selected-face clears >=3:1 against it', () => {
    const tokenName = bandBackgroundToken()
    const face = cssVar(css, 'color-selected-face')
    const backdrop = cssVar(css, `color-${tokenName}`)
    expect(contrastRatio(face, backdrop), `--color-selected-face vs --color-${tokenName} (the token Topbar.tsx's header-slot row actually renders)`).toBeGreaterThanOrEqual(3)
  })

  // The tightest number in the whole #512 design (per the operator's own
  // flag) — a relationship between two opaque tokens now, not an alpha
  // over a substrate, so it holds regardless of any future compositing
  // question. Covers BOTH "selected face vs its own resting fill" and
  // "hover edge vs the resting fill it sits inside," since hover and
  // selected share the same --color-selected-face literal.
  it('--color-selected-face clears >=3:1 against --color-rail-fill (selected/hover face vs the resting fill)', () => {
    const face = cssVar(css, 'color-selected-face')
    const fill = cssVar(css, 'color-rail-fill')
    expect(contrastRatio(face, fill), '--color-selected-face vs --color-rail-fill').toBeGreaterThanOrEqual(3)
  })
})
