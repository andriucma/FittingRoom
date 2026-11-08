#!/usr/bin/env bash
# Download OpenAI docs (markdown) for the GPT Image 2.6 Flare and Sunburst models,
# plus the related image guides and API reference, and the live model metadata
# from the API using OPENAI_KEY from .env.local.
#
# Usage: scripts/download_openai_image_docs.sh [output_dir]   (default: docs/openai)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/docs/openai}"
BASE="https://developers.openai.com/api"
MODELS=(gpt-image-2.6-flare gpt-image-2.6-sunburst)

PAGES=(
  "docs/guides/image-generation"
  "docs/guides/tools-image-generation"
  "docs/guides/image-prompting"
  "reference/resources/images"
  "reference/resources/images/generation-streaming-events"
  "reference/resources/images/edit-streaming-events"
)

mkdir -p "$OUT/models" "$OUT/guides" "$OUT/reference"

fetch() { # url dest
  if curl -fsSL --retry 2 -o "$2" "$1"; then
    echo "  ok   $(wc -c <"$2" | tr -d ' ') bytes  ->  ${2#$ROOT/}"
  else
    echo "  FAIL $1" >&2; rm -f "$2"
  fi
}

echo "Model docs:"
for m in "${MODELS[@]}"; do
  fetch "$BASE/docs/models/$m.md" "$OUT/models/$m.md"
done

echo "Guides & reference:"
for p in "${PAGES[@]}"; do
  case "$p" in
    docs/guides/*) dest="$OUT/guides/$(basename "$p").md" ;;
    *)             name="${p#reference/resources/}"; dest="$OUT/reference/${name//\//_}.md" ;;
  esac
  fetch "$BASE/$p.md" "$dest"
done

# Live model metadata from the API (needs OPENAI_KEY in .env.local)
if [[ -f "$ROOT/.env.local" ]]; then
  set -a; source "$ROOT/.env.local"; set +a
fi
if [[ -n "${OPENAI_KEY:-}" ]]; then
  echo "API model metadata:"
  for m in "${MODELS[@]}"; do
    fetch_api() { curl -fsS -H "Authorization: Bearer $OPENAI_KEY" "https://api.openai.com/v1/models/$m"; }
    if fetch_api >"$OUT/models/$m.api.json"; then
      echo "  ok   ->  ${OUT#$ROOT/}/models/$m.api.json"
    else
      echo "  FAIL /v1/models/$m" >&2; rm -f "$OUT/models/$m.api.json"
    fi
  done
else
  echo "OPENAI_KEY not set; skipping API model metadata." >&2
fi

echo "Done -> ${OUT#$ROOT/}"
