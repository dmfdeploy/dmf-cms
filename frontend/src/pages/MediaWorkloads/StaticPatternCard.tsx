import { PATTERN_FRAMES } from './patternFrames.generated'

/**
 * umbrella #452 — a static illustration of the fixed test pattern a
 * topology-spawned SOURCE instance is declared to emit
 * (`instance.topology_source_pattern`, media_workloads.py's own
 * derivation). Sources carry a live MXL status sidecar (`live_view: true`)
 * but that sidecar's own preview endpoint 404s for a source role — today's
 * tile reads "Sidecar live · no preview on this side" over a bare
 * placeholder glyph, which tells the operator nothing about what this
 * source actually is. This card replaces that placeholder ONLY when the
 * pattern is one this component knows how to draw; an unrecognised pattern
 * string returns null and the caller falls back to the ordinary
 * PlaceholderThumb (LivePreviewBox.tsx) — never a guessed illustration.
 *
 * umbrella #566 — #452 shipped with a HAND-DRAWN inline SVG per pattern
 * (seven colour bars over a plain dark lower third for `smpte`), which
 * drifted from what the source actually emits: a real `videotestsrc smpte`
 * frame also has a castellation/reverse-bar strip and a pluge section with
 * a noise block, neither of which the hand-drawn version showed. The frame
 * below is instead the CANONICAL `videotestsrc` output for each pattern's
 * own index, generated offline and committed as a base64 `data:` URI — see
 * patternFrames.generated.ts's own header and
 * `frontend/scripts/generate-pattern-frames.sh`, the ONLY thing that should
 * ever produce that file. Adding a pattern means adding a line to that
 * script and re-running it, never drawing a new illustration by hand.
 *
 * NO url, NO fetch: the frame is inlined as a `data:` URI at build time, so
 * the tile makes zero additional network requests to show it (see the
 * acceptance network trace in the PR).
 *
 * The `STATIC` mark exists so the illustration can never be mistaken for a
 * live frame at a glance, INCLUDING for an operator viewing a greyscale
 * capture/printout — see hasStaticPattern's docstring below for the
 * contrast numbers, now measured against the real frames' own corner
 * colours rather than a hand-drawn stand-in.
 */

export interface StaticPatternCardProps {
  pattern: string
  displayName: string
}

/** The canonical frame for `pattern`, or null if this component does not
 *  know how to draw it. The ONE lookup shared by hasStaticPattern and the
 *  component below, so they can never disagree about which patterns are
 *  "known" — same role `patternSvg` played before #566, just backed by a
 *  generated frame table instead of hand-drawn SVG. `pattern in
 *  PATTERN_FRAMES` is avoided on purpose: PATTERN_FRAMES is a plain object
 *  literal, so `in` would also match inherited Object.prototype keys (e.g.
 *  a pattern literally named "toString") — hasOwnProperty does not. */
function patternFrame(pattern: string): string | null {
  return Object.prototype.hasOwnProperty.call(PATTERN_FRAMES, pattern)
    ? PATTERN_FRAMES[pattern]
    : null
}

/**
 * Whether this component can actually draw `pattern`. LivePreviewBox.tsx
 * calls this to decide the render branch (card vs PlaceholderThumb) AND to
 * gate the caption/liveDot/tick logic in useLivePreview — ONE check shared
 * both places, so they can never disagree about which patterns are "known".
 *
 * Contrast (WCAG 2.x formula), computed against the ACTUAL top-left corner
 * of each pattern's real frame — the corner the STATIC mark always sits
 * over — not assumed from the old hand-drawn SVG:
 *
 *   - smpte: the corner is the pure white 100% bar (`#FFFFFF`), unchanged
 *     from the old illustration. The mark is white text on `bg-black/80`
 *     (rgba(0,0,0,0.8)) composited over that white: composite
 *     rgb(51,51,51), relative luminance ≈0.0331. Contrast vs white text
 *     (luminance 1.0) = (1.0+0.05)/(0.0331+0.05) ≈ 12.6:1.
 *   - checkers-8: the real `videotestsrc` frame draws this pattern in
 *     alternating RED/GREEN 8px cells (a chroma-subsampling test, not
 *     black/white — verified by direct pixel sampling, see the PR), so the
 *     mark's corner is a fine red/green checkerboard rather than one solid
 *     colour. Composited the same way: red cell -> rgb(51,0,0), luminance
 *     ≈0.0070, contrast ≈18.4:1; green cell -> rgb(0,51,0), luminance
 *     ≈0.0237, contrast ≈14.3:1. Both cells clear the floor by a wide
 *     margin, and BOTH remain above the smpte case.
 *
 * White is the worst case of the three (and, by the same reasoning, of any
 * single-hue backdrop at this composite ratio: spreading intensity across
 * all three luminance-weighted channels always beats concentrating it in
 * one), so smpte's 12.6:1 is the floor, comfortably above the 4.5:1
 * WCAG AA floor. This was re-verified visually too, not just by formula —
 * composited PNG renders of both patterns in colour and in a CSS
 * `filter: grayscale(1)`-equivalent (Rec.709 luma) came out unmistakably
 * legible in both cases; see the PR description for both renders.
 */
export function hasStaticPattern(pattern: string): boolean {
  return patternFrame(pattern) !== null
}

export default function StaticPatternCard({ pattern, displayName }: StaticPatternCardProps) {
  const frame = patternFrame(pattern)
  if (!frame) return null

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-md bg-black"
      title={`${displayName} — static ${pattern} test pattern`}
    >
      {/* `frame` is always a `data:` URI (patternFrames.generated.ts) —
          never a URL, so this <img> issues no network request. */}
      <img
        src={frame}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {/* Persistent, survives-greyscale mark (see hasStaticPattern's own
          docstring for the measured contrast) — text on a near-opaque black
          chip, never colour-only (Art. 11). */}
      <span
        aria-hidden="true"
        className="absolute left-1 top-1 border border-white/60 bg-black/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-white"
      >
        STATIC
      </span>
      <span className="sr-only">
        {`Static illustration of the ${pattern} test pattern this source emits — not a live picture.`}
      </span>
    </div>
  )
}
