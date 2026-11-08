#!/usr/bin/env bash
# Chop a spin video into frames every N ms (default 300), scaled to 864x1536 (9:16, /16-aligned).
# Usage: scripts/extract_frames.sh [video] [interval_ms] [out_dir]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VIDEO="${1:-$ROOT/IMG_8204.mov}"
MS="${2:-300}"
OUT="${3:-$ROOT/work/frames}"
mkdir -p "$OUT" && rm -f "$OUT"/frame_*.jpg
ffmpeg -v error -y -i "$VIDEO" -vf "fps=1000/$MS,scale=864:1536" -q:v 2 "$OUT/frame_%03d.jpg"
echo "$(ls "$OUT"/frame_*.jpg | wc -l | tr -d ' ') frames -> $OUT"
