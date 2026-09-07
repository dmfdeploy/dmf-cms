/**
 * umbrella #452 — a static, inline-SVG illustration of the fixed test
 * pattern a topology-spawned SOURCE instance is declared to emit
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
 * NO <img>, NO url, NO fetch: every pixel is drawn by this SVG, so the tile
 * makes zero additional network requests to show it (see the acceptance
 * network trace in the PR).
 *
 * The `STATIC` mark exists so the illustration can never be mistaken for a
 * live frame at a glance, INCLUDING for an operator viewing a greyscale
 * capture/printout — see hasStaticPattern's docstring below for the
 * contrast numbers.
 */

export interface StaticPatternCardProps {
  pattern: string
  displayName: string
}

const BAR_COLORS = ['#FFFFFF', '#FFFF00', '#00FFFF', '#00FF00', '#FF00FF', '#FF0000', '#0000FF']

/** Seven vertical colour bars (SMPTE order) over a plain dark lower third. */
function SmpteBars() {
  return (
    <svg
      viewBox="0 0 700 480"
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      {BAR_COLORS.map((color, i) => (
        <rect key={color} x={i * 100} y={0} width={100} height={320} fill={color} />
      ))}
      <rect x={0} y={320} width={700} height={160} fill="#141414" />
    </svg>
  )
}

/** An 8×8 checkerboard, top-left cell WHITE (the worst-case backdrop the
 *  STATIC mark's contrast is computed against — see hasStaticPattern). */
function Checkers8() {
  const cells: React.JSX.Element[] = []
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const light = (row + col) % 2 === 0
      cells.push(
        <rect
          key={`${row}-${col}`}
          x={col}
          y={row}
          width={1}
          height={1}
          fill={light ? '#FFFFFF' : '#000000'}
        />,
      )
    }
  }
  return (
    <svg
      viewBox="0 0 8 8"
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      {cells}
    </svg>
  )
}

function patternSvg(pattern: string): React.JSX.Element | null {
  switch (pattern) {
    case 'smpte':
      return <SmpteBars />
    case 'checkers-8':
      return <Checkers8 />
    default:
      return null
  }
}

/**
 * Whether this component can actually draw `pattern`. LivePreviewBox.tsx
 * calls this to decide the render branch (card vs PlaceholderThumb) AND to
 * gate the caption/liveDot/tick logic in useLivePreview — ONE check shared
 * both places, so they can never disagree about which patterns are "known".
 *
 * Contrast (WCAG 2.x formula, computed by hand against the WORST-case
 * backdrop the mark ever overlays — the white top-left cell/bar both known
 * patterns place there): the mark is white text on `bg-black/80` (rgba(0,0,
 * 0,0.8)) composited over white. That composite is rgb(51,51,51); relative
 * luminance ≈0.0332. White text's luminance is 1.0. Contrast ratio =
 * (1.0+0.05)/(0.0332+0.05) ≈ 12.6:1 — comfortably above the 4.5:1 floor,
 * and every other backdrop the mark can sit over (any darker cell/bar) only
 * increases it further, so white is the worst case, not one of many.
 */
export function hasStaticPattern(pattern: string): boolean {
  return patternSvg(pattern) !== null
}

export default function StaticPatternCard({ pattern, displayName }: StaticPatternCardProps) {
  const svg = patternSvg(pattern)
  if (!svg) return null

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-md bg-black"
      title={`${displayName} — static ${pattern} test pattern`}
    >
      {svg}
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
