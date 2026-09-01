/**
 * LKIRC GATE ROUND 2 (dmfdeploy/dmfdeploy#512). index.css's own
 * `@media (width < 390px)` block hand-copies two of LifecycleStrip.tsx's
 * TS constants into literal CSS numbers — `border-radius: 8px` for
 * `BOX_RADIUS`, and `clip-path: inset(2px round 6px)` for `RING_INSET` /
 * `BOX_RADIUS - RING_INSET` — because that stylesheet rule has to
 * `!important`-override an INLINE style set from those same constants
 * (`chevronStyle`/`chevronInnerStyle`), and a media query cannot read a TS
 * constant. Both call sites say "kept in sync by hand" in their own
 * comments, and that hand-sync is exactly how the round-2 bug arrived
 * unnoticed: `.lifecycle-rail-chevron-fill` lost its `clip-path` entirely
 * for a full fix round (only `border-radius` was restored after the P2
 * fix) and nothing caught it, because nothing compared the CSS literal
 * against the constant it claims to track.
 *
 * This file closes that gap: it reads BOTH sides from their own source of
 * truth — `BOX_RADIUS`/`RING_INSET` from the TS module, the media-query
 * literals from index.css's own raw text — and asserts they still agree,
 * so a future change to either side that isn't mirrored in the other
 * fails HERE, not three fix rounds later on a real render nobody thought
 * to check at a narrow viewport.
 */
import { describe, expect, it } from 'vitest'
import css from '../index.css?raw'
import { BOX_RADIUS, RING_INSET } from '../pages/MediaWorkloads/LifecycleStrip'

/** The `@media (width < 390px) { ... }` block's own body, isolated so the
 *  two rule-extraction regexes below can't accidentally reach past it into
 *  unrelated CSS. Matches the outer, UNINDENTED closing brace specifically
 *  (`\n}` with nothing between the newline and the brace) — every rule
 *  INSIDE the block closes with an indented `\n  }`, which this pattern
 *  does not match, so a non-greedy body capture still stops at the right
 *  place even though the block contains several inner `{...}` pairs of
 *  its own. */
function narrowWidthBlock(): string {
  const m = css.match(/@media \(width < 390px\) \{\n([\s\S]*?)\n\}\n/)
  if (!m) throw new Error('@media (width < 390px) block not found in index.css')
  return m[1]
}

/** One CSS rule's own body, by exact selector text (including the space
 *  before `{`, so `.lifecycle-rail-chevron {` cannot accidentally match
 *  inside `.lifecycle-rail-chevron-fill {` — the two rules share a prefix,
 *  but only one of them is followed directly by a space and brace). */
function ruleBody(block: string, selector: string): string {
  const m = block.match(new RegExp(`${selector.replace(/[.]/g, '\\.')} \\{([\\s\\S]*?)\\n  \\}`))
  if (!m) throw new Error(`${selector} rule not found in the narrow-width media block`)
  return m[1]
}

describe('the narrow-width CSS fallback stays in sync with its own TS constants (lkirc gate round 2)', () => {
  it('.lifecycle-rail-chevron border-radius equals BOX_RADIUS', () => {
    const body = ruleBody(narrowWidthBlock(), '.lifecycle-rail-chevron')
    const m = body.match(/border-radius:\s*(\d+)px\s*!important/)
    if (!m) throw new Error('.lifecycle-rail-chevron carries no border-radius declaration to check')
    expect(Number(m[1]), `index.css's border-radius (${m[1]}px) must equal LifecycleStrip.tsx's BOX_RADIUS (${BOX_RADIUS}px)`).toBe(BOX_RADIUS)
  })

  it('.lifecycle-rail-chevron-fill carries a clip-path (not just a border-radius that no longer does anything), inset RING_INSET, radius BOX_RADIUS - RING_INSET', () => {
    const body = ruleBody(narrowWidthBlock(), '.lifecycle-rail-chevron-fill')
    const m = body.match(/clip-path:\s*inset\((\d+)px round (\d+)px\)\s*!important/)
    if (!m) {
      throw new Error(
        '.lifecycle-rail-chevron-fill carries no clip-path: inset(...) declaration — without it, ' +
          '.lifecycle-rail-chevron\'s own "clip-path: none" (needed so key-edge drops its notch below ' +
          '390px) also strips key-fill\'s inset, collapsing the two layers onto the identical box ' +
          '(lkirc gate round 2: no ring at all, and the fill protrudes past the intended radius at every corner)',
      )
    }
    const [, inset, radius] = m
    expect(Number(inset), `index.css's inset (${inset}px) must equal RING_INSET (${RING_INSET}px)`).toBe(RING_INSET)
    expect(Number(radius), `index.css's radius (${radius}px) must equal BOX_RADIUS - RING_INSET (${BOX_RADIUS - RING_INSET}px)`).toBe(BOX_RADIUS - RING_INSET)
  })
})
