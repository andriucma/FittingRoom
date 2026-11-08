# FittingRoom

Record a 360° spin in the browser, pick a top and bottom from any Shopify store, and get a stabilized drag-to-rotate try-on plus an automatically generated smooth video.

## Setup (macOS, Apple Silicon)

Prerequisites: Node 24+ (built-in `node:sqlite` is used), Python 3.12 (`brew install python@3.12`; mediapipe has no 3.14 wheels), ffmpeg (`brew install ffmpeg`).

```bash
cp ../.env.example ../.env.local      # fill in OPENAI_KEY and GEMINI_API_KEY
ln -sf ../.env.local .env.local       # the app reads the repo root's env file
npm install                           # postinstall copies the in-browser MediaPipe runtime + downloads the lite pose model
npm run setup:python                  # Python 3.12 venv for the local models + SAM 3 weights (~1 GB, one time)
npm run dev                           # Python service on a free port + Next.js wired to it → http://localhost:3000
```

SAM 3 (MLX) needs Apple Silicon. Everything else runs anywhere ffmpeg and Python 3.12 do.

## Architecture

```
browser ──► Next.js 16 (UI + /api route handlers) ──► Python FastAPI "local-models" (127.0.0.1:<free port>)
              │  OpenAI GPT Image + Decisions,           └─ MediaPipe Pose (angles), SAM 3 MLX (alignment, masks)
              │  Gemini Omni, Shopify, ffmpeg,
              │  SQLite catalog, job runner
              └─ data/  (videos, products, runs, catalog.db) shared by both
```

- **Python only runs on-device models** (`python/tryon_local`): `/angles/extract`, `/framing/normalize`, `/segment`, `/health`.
- **Everything else is in Next.js API routes** (`src/app/api`, logic in `src/lib/server`).
- **`scripts/dev.mjs`** picks a free port, starts `uvicorn`, waits for `/health`, then runs `next dev` with `LOCAL_MODELS_URL`.
- **Production preview:** after `npm run build`, use `npm start -- --port 3100`. This now starts both the Python service and Next.js, checks ffmpeg/ffprobe before startup, and stops both services with Ctrl+C. The launcher reads `.env.local` for shared data-directory and tool overrides.

| File | Role |
|---|---|
| `src/lib/server/catalog.ts` | Store validation, catalog fetch, sampling, Decisions tagging, search |
| `src/lib/server/db.ts` | SQLite schema (`stores`, `products`, FTS5 `products_fts`) at `data/catalog.db` |
| `src/lib/server/decisions.ts` | Decisions API: product tags and shopper department |
| `src/lib/server/shopify.ts` | Downloads a catalog product's photos for try-on and picks the front/back/side refs |
| `src/lib/server/tryon.ts` | GPT Image prompts (per-angle views, keep-everything-else rule, studio plate) |
| `src/lib/server/omni.ts` | Gemini Omni video edit (`apiVersion: "v1beta"`) |
| `src/lib/server/runs.ts` | Pipeline runner, resumable |
| `src/lib/server/videos.ts` | Upload, 9:16 normalization, verification, shopper profile |
| `src/components/capture/*`, `src/lib/capture/*` | Guided recording: in-browser pose, turn tracking, audio synth |

## Flow

1. **`/` Record.**
   - Rectangular camera/upload/lookbook panels open the relevant task directly. **Open camera** starts the camera with a 9:16 guide; the separate **Camera & sound settings** screen preserves sound preview, mute, and back-camera controls. Recording tips are expandable.
   - The in-browser MediaPipe Pose model (lite, self-hosted under `public/mediapipe`) waits until you're head-to-toe in frame and facing the camera, counts down, records, and tracks your turn live.
   - Feedback while turning: a 12-segment ring and the "filling bottle" audio (`src/lib/capture/fillSynth.ts`).
   - It stops automatically after a full turn.
   - The upload is cropped to a 9:16, 1080×1920, 30 fps video and verified server-side with the heavy pose model (≥320° turn, all angles present).
   - The front (0°) frame is sent to the Decisions API to choose a default department (Men's / Women's / Everything). Below 0.8 confidence it falls back to Everything. It is always overridable and saved per video as `profile.json`.
2. **`/new` Outfit.**
   - A guided flow shows one task at a time: choose a recording → pick a top → pick bottoms → review and create. Arriving from a recording skips to the top selection.
   - Store and department chips filter the product grid. Selections persist when moving backward and forward, and Continue requires a selection for the current step.
   - Photo-angle corrections and quality/video settings are expandable. Both background choices include stabilization and smooth video; the review displays the estimated generation cost.
   - SAM isolates the chosen garment in its product photo. The picker dims everything else; generation receives a separate neutral-background garment reference, so companion clothing on the store model is excluded. Original photos are kept unchanged. If isolation fails, choose another photo or piece before continuing.
   - One top/jacket and one bottom are allowed. Duplicate products, swapped slots, clothing sets, and one-piece outfits are rejected by the API as well as the picker. New image prompts replace the original clothes rather than stacking duplicate layers.
   - Optional pairing suggestions rank compatible pieces using catalog colors and fits, respecting the active store, department, and search filters. They are suggestions rather than mandatory style rules.
3. **`/runs/:id` Results.**
   - Pipeline: angles (reused from verification) → GPT Image try-on with per-angle product views → SAM 3 alignment (both original and studio backgrounds) → spin video (ends on the 0° frame so it loops) → automatic Gemini Omni video.
   - New runs always include Gemini video at the selected resolution (720p by default), and the displayed estimate includes its cost. Both API keys are required before a run starts. Existing saved runs retain their original Gemini setting when resumed.
   - Failed runs can be resumed without re-paying for finished frames.
   - Gemini input is retimed to a whole 3–15 seconds at exactly 30 fps, preserving the complete selected turn. The encoded video-stream duration is checked before upload. Retry an existing failed video to reuse its completed outfit frames; newly generated frames use isolated garment references.

## Stores and catalog

- **Add store** (`POST /api/stores {url}`):
  - Accepts any URL, e.g. `kith.com` or `https://www.kith.com/collections/x`.
  - It's valid if `https://<domain>/products.json` answers. Otherwise the homepage is scanned for `<shop>.myshopify.com` and that domain is tried.
  - If not, the response explains why (`not_shopify` "Sorry, we only work with Shopify stores right now…", `catalog_private`, `unreachable`, `invalid_url`) and suggests example stores.
- **Processing runs in the background** (status `fetching` → `tagging` → `ready`), and the UI says it will show up shortly.
  - Fetches up to 40 × 250 products.
  - Stores with more than 500 products are sampled: up to 50 per apparel section (top, bottom, dress, outerwear, swimwear), in-stock first.
- **Tagging:** one Decisions request per product (`gpt-6-luna`, about $0.0008 each) returns:
  - `department` (mens, womens, unisex, kids), `category`, a try-on suitability probability, `color`, `fit`
  - for each photo, its `view` (front, back, side, detail, other) and a `clean` studio-shot probability
- **Search** (`GET /api/products?kind=top|bottom|dress&department=mens|womens|all&store=<id>&q=`): FTS5 full-text search over the title, type, tags, description, vendor, color and category. Men's and Women's results include unisex products.
- **Automatic stores:** set a comma-separated list in `tryon-app/.env.local`, restart the app, then open **Choose your outfit**:

  ```env
  SHOPIFY_STORE_URLS=https://gymsharkusa.myshopify.com,https://kith.com,https://www.aloyoga.com,https://www.taylorstitch.com,https://www.outdoorvoices.com
  ```

  Each store is validated and imported automatically through the same pipeline as **Add store**. Bare domains and collection/product URLs work too. Duplicate hosts and repeated page loads don't start duplicate imports. Ready catalogs are reused; failed/interrupted imports retry once per server process, reusing tagged products. Invalid URLs appear as errors without preventing other stores from importing. Removing a URL from the list does not delete its saved catalog. The older single-store `SHOPIFY_STOREFRONT_URL` setting still works alongside the list. No brands are hardcoded as automatic imports.
- **Balanced sampling:** large catalogs retain up to 50 items per apparel section, taking turns across the departments identified in listing types/tags. Adult sections exclude explicitly tagged kids' items; in-stock items come first within each group. The Decisions API still determines final department and category filters.
- **Import setup:** `OPENAI_KEY` and API credits are required to import and tag these catalogs. Missing credentials or billing failures appear as store errors with **Retry import**. Configure the key/credits and restart to retry configured stores automatically, or use the button. Authentication/billing failures stop new tagging tasks; failed products are retained for retry instead of reporting the store as ready.
- **Measured:**

  | Store | Products | Sampled + tagged | Cost | Time |
  |---|---|---|---|---|
  | Gymshark | 9,985 | 221 | $0.18 | ~70 s |
  | Kith | 10,000+ (fetch cap) | 250 | $0.13 | ~70 s |

## API

| Route | |
|---|---|
| `GET /api/health` | Python service, ffmpeg/ffprobe availability, key presence |
| `GET/POST /api/stores` · `GET /api/stores/:id` | list / add (validated, async) / status |
| `GET /api/products?...` | search the tagged catalog |
| `GET /api/products/:id` · `PATCH {index, view}` | download photos for try-on · fix a view label |
| `POST /api/products/:id/focus {index?}` | cached SAM highlight for the chosen photo; clean AI references are prepared separately |
| `GET/POST /api/videos` · `POST /api/videos/sample` | list / upload (multipart `video`) / sample |
| `POST /api/videos/:id/verify` · `PUT /api/videos/:id/profile {department}` | full-turn check + department detection · override |
| `GET/POST /api/runs` · `GET /api/runs/:id` · `POST /api/runs/:id/resume` | runs |
| `GET /api/files/*` | files under `data/` (Range support) |

## QA

- `npm test` runs regression checks for video duration/frame counts, preserving the full turn, overlapping/duplicate garment rejection, pairing filters, separate highlight/reference paths and caching, and resuming without regenerating completed images.
- `python/.venv/bin/python -m unittest discover -s python/tests -p 'test_*.py'` checks exact garment pixel preservation, background removal/dimming, unchanged source files, and failed mask handling.

- FittingRoom uses a light coral, blush, mint, and sky palette with responsive layouts. Live capture overlays, synthesized audio, tracking logic, and the dark drag-to-rotate viewer are preserved. Tailwind runs through PostCSS for both development and production bundlers.
- `predev`, `predev:next`, `prebuild`, and `prestart` restore the self-hosted browser pose runtime/model if needed, even when dependencies were installed with scripts disabled. The model downloads once; later runs reuse it. Capture startup failures and cancellation release camera tracks and show readable errors.
- Camera startup checks that ffmpeg, ffprobe, and the Python verification service are available before requesting camera access, avoiding a full recording followed by a missing-dependency error.
- Redesign verification: TypeScript and the Webpack production build passed. Headless Chrome checks at desktop and phone widths used intercepted API fixtures to verify the recording intro/sound transition, disabled Continue states, complete outfit selection, settings and submitted payload, failed-generation retry, lookbook/results rendering, keyboard skip link, loaded layout utilities, and absence of horizontal overflow/browser exceptions. This does not verify live camera/model generation. Home previews are saved in `../docs/previews/`.

- `?testVideo=<url>` on `/` (dev only) feeds a video file through the capture flow instead of the camera.
- `python/.venv/bin/python python/tests/simulate_capture.py <video>` replays the capture state machine offline with the same lite model (`COUNTDOWN_MS=0` for a still countdown).
- `npx tsc --noEmit && npx eslint src && NEXT_DIST_DIR=.next-build npx next build`: all pass as of the handoff.

## Known issues / next steps

- **Live camera capture is untested in a real browser.** It was only exercised via the offline simulator; the automated Chrome tab was always hidden. Test it first.
- **Department detection** returned "Everything" (0.72 < 0.8) on the sample video. Tune `minConfidence` in `decisions.ts` or the question wording.
- **The `clean` photo predicate scores strictly** (0–0.3 on clean studio shots), but its ranking still picks the right photos. Some side shots are labelled front, which is fixable in the UI.
- **Dresses** are tagged and searchable, but the run UI only does top + bottom; the pipeline needs a single-garment mode.
- **Omni** model access: our key only had `gemini-omni-flash-preview`, not `gemini-omni-1.2-flash`. It took 48–275 s per 5 s clip.
- **Turbopack HMR** sometimes serves a stale module after big refactors. Touch the file or restart `npm run dev`.
- **Deployment:** SAM 3 MLX needs Apple Silicon. In production, swap it for a hosted SAM 3 (Roboflow/fal) or a GPU box, and move `data/` and SQLite to cloud storage/DB.

### FittingRoom interface

Record a turn or select an existing full-turn recording, choose one top and one pair of bottoms, then review the background and create your look. Drafts survive a refresh within the same browser tab. The results page separates the interactive 360° view and smooth video into tabs; completed details and individual angle images are expandable.

The configured store list includes Gymshark, Kith, Alo Yoga, Taylor Stitch and Outdoor Voices. Add Shopify domains to `SHOPIFY_STORE_URLS` in `.env.local`; the outfit picker registers and imports them automatically.

Created by **Armin Hatamian** and **Marcu Andriuca**.
