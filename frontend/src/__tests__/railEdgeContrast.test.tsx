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
 * from the component's own source text. Deliberately tolerant of arbitrary
 * prose BETWEEN the `data-testid` and `className` attributes (this file
 * carries a long doc comment there) via a non-greedy `[\s\S]*?` — brittle
 * only to the row losing its `data-testid` or its `className` attribute
 * entirely, which is exactly the "structural drift" this needs to fail
 * loudly on, not silently paper over.
 */
function bandBackgroundToken(): string {
  const rowMatch = topbarSource.match(/data-testid="header-slot-row"[\s\S]*?className="([^"]+)"/)
  if (!rowMatch) throw new Error('header-slot-row element (or its className) not found in Topbar.tsx — this test can no longer locate the rail band to check its backdrop')
  const classes = rowMatch[1]
  const bgMatch = classes.match(/\bbg-([a-z][\w-]*)\b/)
  if (!bgMatch) throw new Error(`header-slot-row className carries no bg-* utility to check: "${classes}"`)
  return bgMatch[1]
}

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
