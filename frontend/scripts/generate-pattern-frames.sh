#!/usr/bin/env bash
# umbrella dmfdeploy/dmfdeploy#566 — regenerates the canonical videotestsrc
# frame for every source pattern StaticPatternCard.tsx knows how to draw,
# from the pattern's documented `videotestsrc` index (see
# dmf-media/charts/mxl-fabrics-demo/values.yaml). This is the ONLY thing
# that should ever produce patternFrames.generated.ts — adding a pattern
# means adding a line below and re-running this script, never hand-drawing
# a new illustration (that divergence is exactly what #566 fixed).
#
# Requires gst-launch-1.0 (GStreamer 1.x, `pngenc` element).
#
# Deterministic: videotestsrc draws its patterns from pure pixel math with
# no clock/overlay, and pngenc's output carries no embedded generation
# timestamp — two runs of this script produce a byte-identical
# patternFrames.generated.ts (verified via `cmp` on back-to-back runs; see
# the PR this shipped in for the transcript).
set -euo pipefail

# name -> videotestsrc pattern index (gst-inspect-1.0 videotestsrc). Keep in
# lockstep with StaticPatternCard.tsx's PATTERN_FRAMES keys — this is the
# single source of truth for which patterns are "known" at all.
PATTERNS=(
  "smpte:0"
  "checkers-8:10"
)

WIDTH=640
HEIGHT=360

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_TS="$SCRIPT_DIR/../src/pages/MediaWorkloads/patternFrames.generated.ts"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

command -v gst-launch-1.0 >/dev/null 2>&1 || {
  echo "generate-pattern-frames.sh: gst-launch-1.0 not found — install GStreamer 1.x to regenerate pattern frames" >&2
  exit 1
}

{
  echo "/**"
  echo " * GENERATED FILE — DO NOT EDIT BY HAND."
  echo " *"
  echo " * Regenerate with: frontend/scripts/generate-pattern-frames.sh"
  echo " * (requires gst-launch-1.0 / GStreamer 1.x on PATH)"
  echo " *"
  echo " * Each entry is the exact PNG \`videotestsrc\` emits for that"
  echo " * pattern's index at ${WIDTH}x${HEIGHT}, base64-inlined as a"
  echo " * \`data:\` URI so a source tile makes zero network requests to show"
  echo " * it (umbrella dmfdeploy/dmfdeploy#566 — the frame is the tile's own"
  echo " * bundled bytes, never a fetched asset)."
  echo " */"
  echo "export const PATTERN_FRAMES: Readonly<Record<string, string>> = {"
  for entry in "${PATTERNS[@]}"; do
    name="${entry%%:*}"
    index="${entry##*:}"
    out="$TMP_DIR/$name.png"
    gst-launch-1.0 -q videotestsrc "pattern=$index" num-buffers=1 \
      ! "video/x-raw,width=$WIDTH,height=$HEIGHT" ! pngenc ! filesink "location=$out" >&2
    size=$(wc -c <"$out" | tr -d ' ')
    echo "generate-pattern-frames.sh: $name (pattern=$index) -> ${size} bytes" >&2
    b64=$(base64 <"$out" | tr -d '\n')
    printf '  "%s": "data:image/png;base64,%s",\n' "$name" "$b64"
  done
  echo "}"
} >"$OUT_TS"

echo "generate-pattern-frames.sh: wrote $OUT_TS" >&2
