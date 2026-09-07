/**
 * StaticPatternCard (umbrella #452, canonical frames umbrella #566) — the
 * illustration a topology-spawned SOURCE tile shows in place of
 * PlaceholderThumb when its declared test pattern is one this component
 * knows how to draw. Covers: known patterns render their own canonical
 * `videotestsrc` frame (never a swapped or guessed one) plus the STATIC
 * mark and exact sr-only text; an unknown pattern renders nothing at all
 * (the caller's own fallback, not this component's concern); the frame is
 * always a `data:` URI, never a fetchable URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import StaticPatternCard, { hasStaticPattern } from '../pages/MediaWorkloads/StaticPatternCard'
import { PATTERN_FRAMES } from '../pages/MediaWorkloads/patternFrames.generated'

afterEach(cleanup)

/**
 * sha256 of the raw PNG bytes decoded from each pattern's `data:` URI,
 * pinned independently of PATTERN_FRAMES's own keys — recorded once from
 * the actual `frontend/scripts/generate-pattern-frames.sh` output.
 *
 * This independence is the point: a mutation that swaps which asset lives
 * under which key (e.g. `smpte` and `checkers-8` trade places) leaves
 * PATTERN_FRAMES internally self-consistent — a test that only compares the
 * rendered <img> against `PATTERN_FRAMES[pattern]` would still pass, since
 * both sides read the same swapped map. Hashing against a value recorded
 * OUTSIDE that map is what actually catches it.
 */
const EXPECTED_FRAME_SHA256: Record<string, string> = {
  smpte: '3edd306844cc67321f0835927d60705a7782ba5e5786a8eab58963bf0522b1a8',
  'checkers-8': 'c96ac78d0cf15872b318b5a0da9e8d1de24fc64b04862601de2d76fde9209e34',
}

function decodePng(dataUri: string): Uint8Array {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUri)
  if (!match) throw new Error(`not a base64 PNG data: URI: ${dataUri.slice(0, 32)}...`)
  // Web Crypto's atob, not Node's Buffer — this project carries no
  // @types/node, and tsc typechecks test files alongside src.
  const binary = atob(match[1])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

describe('PATTERN_FRAMES: each known pattern is its own pinned, canonical asset', () => {
  for (const [pattern, expectedHash] of Object.entries(EXPECTED_FRAME_SHA256)) {
    it(`${pattern} matches the pinned sha256 of the real videotestsrc frame`, async () => {
      const frame = PATTERN_FRAMES[pattern]
      expect(frame).toBeTruthy()
      expect(await sha256Hex(decodePng(frame))).toBe(expectedHash)
    })
  }

  it('smpte and checkers-8 are distinct assets', () => {
    expect(PATTERN_FRAMES.smpte).not.toBe(PATTERN_FRAMES['checkers-8'])
  })
})

describe('hasStaticPattern', () => {
  it('knows smpte and checkers-8', () => {
    expect(hasStaticPattern('smpte')).toBe(true)
    expect(hasStaticPattern('checkers-8')).toBe(true)
  })

  it('does not know an arbitrary/unrecognised pattern token', () => {
    // Mutation check: "ball" is a REAL sources[].pattern value elsewhere in
    // this codebase's own test fixtures (test_switch_source.py) — proving
    // this returns false for it (not just for garbage input) is what shows
    // the check actually discriminates known-vs-unknown rather than always
    // returning true. It also has no committed frame (umbrella #566 only
    // generated smpte and checkers-8), so this doubles as a live
    // known/unknown boundary check.
    expect(hasStaticPattern('ball')).toBe(false)
    expect(hasStaticPattern('')).toBe(false)
  })

  it('does not match inherited Object.prototype keys', () => {
    // Guards the hasOwnProperty check in patternFrame: PATTERN_FRAMES is a
    // plain object literal, so a naive `pattern in PATTERN_FRAMES` would
    // wrongly say yes for these.
    expect(hasStaticPattern('toString')).toBe(false)
    expect(hasStaticPattern('constructor')).toBe(false)
    expect(hasStaticPattern('hasOwnProperty')).toBe(false)
  })
})

describe('StaticPatternCard: known patterns', () => {
  it('smpte renders its own committed frame, the STATIC mark, and the sr-only text', () => {
    const { container } = render(<StaticPatternCard pattern="smpte" displayName="Source A" />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(PATTERN_FRAMES.smpte)

    expect(screen.getByText('STATIC')).toBeTruthy()
    expect(
      screen.getByText(
        'Static illustration of the smpte test pattern this source emits — not a live picture.',
      ),
    ).toBeTruthy()
  })

  it('checkers-8 renders its own committed frame (a DIFFERENT asset from smpte), the STATIC mark, and the sr-only text', () => {
    const { container } = render(<StaticPatternCard pattern="checkers-8" displayName="Source B" />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(PATTERN_FRAMES['checkers-8'])
    expect(img?.getAttribute('src')).not.toBe(PATTERN_FRAMES.smpte)

    expect(screen.getByText('STATIC')).toBeTruthy()
    expect(
      screen.getByText(
        'Static illustration of the checkers-8 test pattern this source emits — not a live picture.',
      ),
    ).toBeTruthy()
  })

  it('renders no network-fetchable source: the <img> src is always a base64 data: URI, never a URL', () => {
    const { container } = render(<StaticPatternCard pattern="smpte" displayName="Source A" />)
    const img = container.querySelector('img')
    const src = img?.getAttribute('src') ?? ''
    // Mutation check: pointing the source at a URL (e.g.
    // "/api/media-workloads/.../pattern.png") would fail this exact
    // assertion — a leading "data:" is what makes a network request for
    // this tile structurally impossible, not merely unobserved in jsdom.
    expect(src.startsWith('data:image/png;base64,')).toBe(true)
    expect(src.startsWith('http')).toBe(false)
    expect(src.startsWith('/')).toBe(false)
  })

  it('issues no fetch while rendering', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<StaticPatternCard pattern="smpte" displayName="Source A" />)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('StaticPatternCard: unknown pattern', () => {
  it('returns null — nothing renders, the caller falls back to its own placeholder', () => {
    const { container } = render(<StaticPatternCard pattern="ball" displayName="Source A" />)
    expect(container.innerHTML).toBe('')
  })
})
