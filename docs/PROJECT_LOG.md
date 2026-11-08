# RandomTryOn — Project Log

Last updated: 2026-11-07 (web app, guided capture, store catalog + Decisions API, handoff)

Living record of what we've built, tried, solved and ruled out. Keep this updated with every change: new scripts or flags, experiments, problems solved, models adopted or rejected.

---

### Decorative UI cleanup (2026-11-07)

- Removed the header hanger badge, footer color bars, diagonal arrow symbols and the `01 /` prefix before Capture. Kept the FittingRoom wordmark and creator credits.

### Showcase polish and look deletion (2026-11-07)

- Removed generation price estimates, result generation costs, completed pipeline details, redundant slogans/captions and customer-facing store import tools. Store imports remain automatic from environment configuration. Simplified quality labels while retaining options and creator credits.
- Added an inline Delete/Cancel confirmation to each saved look, readable failure recovery and an empty-library state. Creating looks cannot be deleted. The DELETE endpoint is idempotent; completed/interrupted look folders move out of the library into `data/deleted-looks`, leaving original recordings and other looks intact. Delete and resume share a reservation to prevent concurrent writes from recreating removed looks.
- Fixed stale garment readiness when changing a product photo. Network failures on results reconnect automatically without clearing the viewer; missing/deleted looks show an unavailable state. The lookbook polls creating looks and refreshes on window focus, while filtering out successful deletions from stale fetches.
- Validation: TypeScript, production build and all nine Node tests passed, including file preservation and concurrent delete/resume checks. Browser checks passed at desktop, 390px and 320px: full fitting flow, draft recovery, delete confirmation/cancel/failure/retry/persistence, creating-look protection, empty state, generation cost removal and reconnect behavior. A live DELETE/GET/duplicate-delete check passed using a disposable fixture, cleaned afterward. Existing customer looks were not removed; no paid generation was triggered.

### FittingRoom usability and personality refresh (2026-11-07)

- Kept the coral, blush, mint and sky palette, practical rectangular home cards, guided camera visuals and animated viewer. Added clearer action labels, active navigation and a subtle color signature. Footer and metadata credit **Armin Hatamian** and **Marcu Andriuca**.
- Outfit selection now uses one overall journey and one task at a time, with a compact editable recording/top/bottom summary. Recording, garment highlighting and API errors have explicit next steps; unverified recordings cannot continue. Cached recording analysis is reused.
- Save selections, filters and quality/background settings in session storage so refreshing recovers the draft. Successful creation clears it. “Try another outfit” keeps the recording and starts a fresh outfit.
- Results separate the interactive 360° view and smooth video into tabs. Hide completed pipeline details and angle thumbnails until requested, pause inactive media, preserve the viewer during polling, and retry video without reloading the page.
- Added **Taylor Stitch** (`https://www.taylorstitch.com`) and **Outdoor Voices** (`https://www.outdoorvoices.com`) to the local environment and documented store list. Both live public Shopify catalogs imported successfully and are ready: 175 and 413 tagged products respectively. Existing Kith, Alo Yoga and Gymshark remain available. Display names strip SEO suffixes and use readable brand names.
- Validation: production build, TypeScript and seven Node pipeline tests passed. Browser camera checks passed with real local browser models and a fake camera, including visible preview, cancellation, model failure and missing-ffmpeg setup errors. Desktop and 390px/320px browser flow checks passed: validation gates, pairings, draft/settings recovery after refresh, creation errors, fresh outfits using the same recording, keyboard-accessible media tabs, paused inactive video, retry without viewer reload, credits and no horizontal overflow. These checks mock paid generation; live APIs separately confirmed searchable Taylor Stitch men’s tops and Outdoor Voices women’s bottoms.

## 1. Goal & pipeline

- **Goal:** cheap, reliable simulated 360° virtual try-on.
  - A person films themselves spinning 360°. We pick frames around the turn and use GPT Image edits to put chosen garments on them in every frame. Then we play the frames back as a draggable 360° view, and later as a smooth video.
  - Roadmap: prototype with one top + one bottom, then pull products from a Shopify store (`<store>.myshopify.com/products.json`) and let users pick a top and a bottom.
- **Current pipeline** (default choices in bold):
  1. **Fetch products.** `.venv`: `.venv/bin/python scripts/fetch_product.py <product-url> [...]` → `inputs/<handle>/`.
  2. **Pick frames by body angle.** `.venv-pose`: `.venv-pose/bin/python scripts/extract_frames_by_angle.py IMG_8204.mov --step-deg 30` → `work/frames_deg/` (12 frames).
     - Old time-based alternative: `scripts/extract_frames.sh` (every 300 ms → `work/frames/`).
  3. **Dress each frame.** `.venv`: `.venv/bin/python scripts/tryon.py --no-anchor --frames work/frames_deg --top <front>:front <back>:back <side>:side --bottom ... [--background studio]` → `work/runs/<run>/`.
  4. **Normalize framing** (after a generated background). `.venv-sam`: `.venv-sam/bin/python scripts/normalize_framing.py work/runs/<run>` → `work/runs/<run>-aligned/`.
  5. **View.** Stdlib Python: `python3 scripts/serve.py` → http://localhost:8000 (drag-to-rotate viewer).
  6. **Smooth video.** Not done yet.
     - In progress: `scripts/omni_video.py` (Gemini Omni video edit of the original video, optional `--scene studio`).
     - Researched alternative: Luma Ray3.2 multi-keyframe.
- **Env vars** (`.env.local`; never commit values):
  - `OPENAI_KEY`: note the name, not `OPENAI_API_KEY`.
  - `SHOPIFY_STOREFRONT_URL`: currently `https://gymsharkusa.myshopify.com`.
  - `GEMINI_API_KEY`: needed for Omni, not added yet.

---

## 2. Repo map

- **`scripts/download_openai_image_docs.sh`:** downloads the GPT Image 2.6 docs as markdown into `docs/openai/`.
  - Covers the Flare/Sunburst model pages, the image-generation, image-prompting and tools-image-generation guides, and the Images API reference.
  - Uses developers.openai.com `.md` URLs, plus `/v1/models/<id>` metadata via `OPENAI_KEY`.
- **`scripts/fetch_product.py`:** downloads a Shopify product's JSON and all of its images.
  - Accepts product URLs from any domain, or bare handles. Fetches `<SHOPIFY_STOREFRONT_URL>/products/<handle>.json`.
  - Sends `Accept: image/jpeg,image/png` for images and picks the file extension from the response `Content-Type`.
- **`scripts/extract_frames.sh`:** time-based frames every N ms (default 300) at 864×1536 → `work/frames/` (23 frames for `IMG_8204.mov`).
- **`scripts/extract_frames_by_angle.py`:** angle-based frame picker (MediaPipe Pose + Face, details in §3).
  - Flags: `--step-deg`, `--pose-model heavy|full`, `--reuse-analysis` (re-picks frames in about 1 s), `--no-viz`.
  - Writes `frame_NNN_degDDD.jpg`, `angles.json`, `contact_sheet.jpg` and `angle_plot.png`.
- **`scripts/tryon.py`:** the GPT Image try-on runner.
  - `--top`/`--bottom` take several `path:view` refs (`front`/`back`/`side`).
  - Per-angle view selection: reads the angle from the `_degNNN` filename.
  - Optional anchor frame (`--no-anchor` makes every frame independent and fully parallel).
  - `--background original|<preset>|text:<desc>|<image>`, with plates cached in `inputs/backgrounds/`; `--regenerate-background`.
  - `--dry-run` prints each frame's views and the prompt with no API call; `--all-views`, `--only`, `--concurrency`.
  - Writes `tryon_NNN.png`, `run.json` (per-frame src, angle, views, prompt, usage and seconds), `spin.gif`, `spin.mp4` and `viewer.html`.
- **`scripts/serve.py`:** stdlib HTTP server for the viewer.
  - `/api/runs` and `/api/runs/<name>` (frames with try-on and original URLs plus angle, read from `run.json` or `angles.json`); `/files/*` serves files under `work/` with a path-traversal guard.
- **`web/index.html`:** single-page 360° viewer.
  - Canvas rendering, drag to rotate with inertia, seamless looping and optional crossfade.
  - Auto-rotate, reverse drag, side-by-side "show original", ←/→ keys and a run picker.
- **`scripts/composite_background.py`** (`.venv-pose`): cuts the person out with the MediaPipe Pose segmentation mask and composites them onto a background plate with a synthetic floor shadow → `<run>-<plate>/`.
- **`scripts/sam3_seg.py`:** SAM 3 helper.
  - `load_predictor()` loads `mlx-community/sam3-8bit`.
  - `segment(pred, img, prompt)` returns the mask of the instance with the highest score × area.
- **`scripts/normalize_framing.py`** (`.venv-sam`): makes the person the same size and position in every frame (details in §3).
  - `--target median|max|source`.
  - Writes `framing.json`, `framing_check.jpg`, `spin.mp4` and `run.json`.
- **`scripts/omni_video.py`** (`.venv`): Gemini Omni 1.2 Flash video edit.
  - Trims the source video (default 2.0 s to the end, which is 4.83 s), uploads it, and sends it with up to 3 try-on reference images plus an edit prompt.
  - Defaults to a 360p, 9:16, 5 s draft.
  - Writes `omni.mp4`, `compare.mp4` and `run.json`. `--dry-run` only trims.
  - `--scene studio`: also replaces the bedroom with the studio; sends `--plate` (default `inputs/backgrounds/studio.png`) as an extra, last reference image and uses a studio prompt that says "grey socks, no shoes".
- **`web/`:** viewer page. **`docs/openai/`:** downloaded OpenAI docs (`models/`, `guides/`, `reference/`).
- **`inputs/`:**
  - `gymshark-vengeance-graphic-t-shirt-ss-tops-white-aw26/` (8 JPEGs + `product.json`).
  - `gymshark-vengeance-utility-pant-pants-black-aw26/` (7 JPEGs + `product.json`).
  - `backgrounds/studio.png` (cached studio plate).
- **`work/frames/`:** 23 time-based frames.
- **`work/frames_deg/`:** 12 angle-based frames plus `angles.json`, contact sheet and plot.
- **`work/runs/*`:** try-on experiments (§4).
- **`work/omni/dryrun/`:** trimmed `source.mp4` for Omni.
- **`models/`:** MediaPipe `pose_landmarker_heavy.task` and `face_landmarker.task`, downloaded automatically.
- **Python environments:**
  - `.venv` (Python 3.14.3): `openai` 3.46.0, `pillow` 13.0.0, `google-genai` 3.0.0.
  - `.venv-pose` (3.12.6): `mediapipe` 1.2.2, `numpy` 2.5.4, `matplotlib` 3.11.2.
  - `.venv-sam` (3.12.6): `mlx` 0.32.4, `mlx-vlm` 0.7.12. SAM 3 weights (about 1.0 GB) live in the Hugging Face cache.

---

## 3. Models & APIs

### In use
- **GPT Image 2.6 Flare** (`gpt-image-2.6-flare`): the try-on edits, via `POST /v1/images/edits` with multiple input images.
  - Settings: `quality=medium`, `size=864x1536` (9:16, multiples of 16), `output_format=png`. `input_fidelity` is omitted, as the 2.6 docs require.
  - The prompt numbers every image and gives it a role: image 1 is the person frame, then the product views, the optional anchor, then the optional background plate. It lists what must stay fixed (identity, pose, socks, watch, framing) and what changes (the clothes only).
  - Pricing: text input $5/M tokens, image input $8/M, image output $30/M (cached input $1.25 and $2). Measured about $0.07–0.11 per frame.
  - Also used through `images.generate` (quality `high`) to create the empty studio plate.
- **GPT Image 2.6 Sunburst** (`gpt-image-2.6-sunburst`): the higher-detail sibling at the same prices. Selectable with `--model`; not tested yet.
- **MediaPipe Pose Landmarker (heavy) + Face Landmarker** (local, CPU, `.venv-pose`):
  - **Body angle.** 3D world landmarks give shoulder and hip yaw via `atan2`, averaged so their opposite depth biases cancel.
  - **Mirror errors.** Each frame gets 4 candidates (y, y+180, −y, 180−y), and a Viterbi pass picks the sequence that is smooth, keeps one spin direction and agrees with the face cue. The face cue comes from the Face Landmarker on an upscaled head crop.
  - **Final track.** Smoothed, unwrapped and fitted to a monotonic track.
  - **Picking.** One frame per angle step; within ±step/3 of the target, it prefers slow-moving, confident frames.
  - **Accuracy.** About ±10°. Runtime about 22 s on CPU.
  - **Also used for** the person mask in `composite_background.py` (coarse, see §5).
- **SAM 3, MLX 8-bit** (`mlx-community/sam3-8bit`, `mlx-vlm` `Sam3Predictor`, local on the Apple Silicon GPU, `.venv-sam`):
  - Text-prompted segmentation; we prompt `"person"`. About 1.04 GB, freely downloadable, SAM License.
  - Used by `normalize_framing.py`. After the one-time download, about 1 minute for 12 frames including the verification pass.
- **Gemini Omni Flash** (Interactions API `client.interactions.create`): docs name `gemini-omni-1.2-flash` as newest, but our key gets **404** for it; `client.models.list()` shows only `models/gemini-omni-flash-preview`, so `omni_video.py` defaults to that (`--model` to override).
  - 1.1 Flash routes to 1.2 automatically from 2026-12-03.
  - Modes: video edit with up to 6 reference images (at most 3 per character), first + last frame (3–10 s), 9:16, 360p–4K, 3–15 s.
  - Restrictions: "certain recognizable people" not supported; editing uploaded videos is unavailable in the EEA, Switzerland and the UK.
  - Price (Google pricing page, $12 per 1M output tokens): 360p ~$0.023/s, 720p ~$0.07/s, 1080p ~$0.104/s, 4K ~$0.209/s. **No free tier** for Omni.
  - `GEMINI_API_KEY` added to `.env.local` on 2026-11-07; first run: `omni1-studio-720p` (see Experiments).

### Researched, not used (yet)
- **Luma Ray3.2 multi-keyframe image-to-video:** up to 64 keyframes pinned at exact output frames (24 fps grid), 9:16, 5 or 10 s.
  - Price: $0.06 for a 360p draft, $0.30 at 720p, $1.20 at 1080p per 5 s.
  - Verdict: **best fit for keyframes → smooth spin.** Needs a Luma key.
- **Luma Ray3.2 `video_edit`:** source video plus keyframes pinned at source frame indexes.
  - Price: about $1.08–1.44 at 720p (Luma's two pricing pages disagree), $2.16 at 1080p.
  - Verdict: best for keeping the real motion.
- **FLUX 3 keyframes-to-video (fal):** up to 10 keyframes at frame indexes, so 2 calls for 13. About $0.17/s at 720p, about $1.70 per spin. Verdict: backup.
- **Kling 4.0 (fal):** image-to-video with start + up to 8 middle + end keyframes, but no timing control for the middle ones; about $0.94 per spin. A video-edit variant also costs about $0.94. Verdict: backup.
- **Veo 3.1 / Fast, Seedance 2.x, MiniMax H3:** first + last frame only, so 12 clips retimed and stitched (stutter, $2.5–15 per spin).
  - The Veo preview models on the Gemini API were shut down 2026-10-22; Veo is still on Vertex, fal and Runway.
  - Seedance reportedly blocks real faces without a liveness check.
  - Verdict: avoid.
- **Runway Aleph 2.0:** video plus up to 5 guidance images, about $1.40 per spin. Verdict: limited keyframes.
- **Sora 2 API:** reportedly removed 2026-09-24. Verdict: excluded.
- **Hosted SAM 3:** Roboflow `sam3/concept_segment` (about $0.04–0.06 per spin, up to 16 prompts per request); fal `sam-3/video-rle` (about $0.01 per spin); Meta `sam-3.1` (about $0.03 per spin in video mode). Verdict: unnecessary now that local MLX works.
- **Other SAM 3 variants:** EfficientSAM3's text prompts aren't really released; official `facebook/sam3` is gated and 3.4 GB; Core ML export needs macOS 27. Verdict: not used.
- **Local video diffusion (Wan 2.2):** needs ≥24 GB VRAM, won't run on an M2 with 16 GB. RIFE/FILM are only good for small gaps (24→30 fps conversion, closing a ~15° seam).

---

## 4. Experiments

All try-on runs: `gpt-image-2.6-flare`, `quality=medium`, `864x1536`, no anchor (every frame independent, all in parallel). Costs are computed from `usage` in `run.json`.

- **`exp1-multiview-noanchor`:** 23 time-based frames (`work/frames/`), all 6 product views sent to every frame.
  - **$2.56** ($0.111 per frame). 12.8–32.1 s per frame (median 20.1 s), about 1 min wall time at concurrency 12.
  - ✅ Identity, pose and room preserved; pants consistent; front logo correct; back graphic on back views.
  - ❌ Sneakers from the product photos appeared in frames 4 and 19. Frame 13 (three-quarter back): back graphic missing and chest logo on the back. Shirt rendered regular fit rather than oversized. 7 near-duplicate standing frames.
- **`exp2-angle-views`:** 12 angle frames (`work/frames_deg/`, 0–330° in 30° steps), only the matching product views per angle.
  - **$0.86** ($0.071 per frame). 10.8–23.3 s per frame, about 23 s wall time.
  - ✅ Back graphic only at 120–240°, chest logo only at 0–60° and 300–330°, socks kept in all 12, fixed the frame-13 failure.
  - ✅ The dark-red "Lifting Club" script and the thigh logo on the pants turned out to be **real product details**, not errors.
  - ❌ Fit is still more regular than oversized.
- **`exp2-angle-views` → `interp/minterp_30fps.mp4`:** ffmpeg `minterpolate` (motion-compensated) from 3 fps to 30 fps, 111 frames, 18 s.
  - ❌ The middle of each 30° gap ghosts: doubled face and arms, back text smeared into two copies. Only the ±2–3 frames near each keyframe are clean.
- **`exp3-studio`:** same as exp2, plus `--background studio`.
  - The plate (`inputs/backgrounds/studio.png`) is generated once in 7.3 s, then passed to every frame as the final reference image.
  - **$1.02** including the plate. 13.8–25.2 s per frame.
  - ✅ Identical backdrop, natural studio relighting and shadows, identity and graphics held.
  - ❌ The person's scale and position drifted: height spread 9.05% of frame height, head-top 11.13%, feet 3.71%, center 2.41%. Sneakers reappeared in 7 of 12 frames (1–3, 7, 8, 10, 12); only frames 4, 5, 6 (and 9, 11 mostly) kept the grey socks.
- **`exp2-angle-views-studio`:** composite of exp2 onto the studio plate (MediaPipe mask + synthetic shadow). $0 extra, about 6 s.
  - ✅ Geometry, socks and identity are pixel-identical to exp2.
  - ❌ The coarse mask lets the room through: the blue lotion bottle next to the hand, a wood-floor patch between the feet, fringing at the shoulder. The person also keeps the room's lighting, so it looks cut out.
- **`exp3-studio-aligned`:** `normalize_framing.py --target median` on exp3. $0 extra.
  - Spread after alignment (% of frame height): head-top 11.13→**0.2**, feet 3.71→**0.07**, height 9.05→**0.26**, center 2.41→**0.07**.
  - Per-frame scales 0.962–1.098; the biggest fix was frame 6 (150°, ×1.098).
  - Extra outputs: `spin_aligned_loop.mp4` (3 loops, 30 fps) and `before_vs_aligned.mp4`.
  - ✅ The user rated the SAM stabilization "significantly better". ❌ Sneakers from exp3 remain (alignment doesn't change content).
- **`work/frames_deg` angle extraction on `IMG_8204.mov`** (205 frames, 30 fps):
  - Total rotation 345.6°, turning to the person's right. 67-frame still lead-in, collapsed to one 0° frame. 0 mirror corrections needed.
  - Picks (target → estimate @ video frame): 0→0.0@16, 30→28.8@76, 60→60.8@85, 90→90.1@94, 120→118.9@105, 150→149.6@119, 180→180.0@130, 210→210.9@149, 240→240.4@162, 270→271.6@173, 300→298.5@184, 330→330.4@194.
  - By eye, the "180°" frame is closer to about 170°.
- **Omni dry run (`work/omni/dryrun/`):** trimmed source of 4.83 s (2.0 s to the end, a full turn) at 720×1280, no audio.
- **`work/omni/omni1-studio-720p`:** Gemini Omni 1.2 Flash, `--scene studio`, 720p, 5 s, ~$0.35 expected.
  - References: aligned studio frames 11 (300°, front + chest logo), 4 (90°, side), 6 (150°, back print), chosen because they show socks rather than generated sneakers; plus the studio plate.
  - **Result:** success on 3rd attempt (404 model ID, then 400 duration). Upload 5.3 s, generation 47.8 s. Output 720×1280, **24 fps**, 5.03 s, includes an audio track. 28,960 output video tokens → ~$0.35 at $12/1M (+ input tokens).
  - First look (frame strip): studio backdrop throughout, smooth continuous turn, back print appears only on back views, chest logo on front, grey socks on the front views. Needs a full watch for flicker/identity drift.

---

## 5. Technical problems solved

- **Gymshark `.json` 403.**
  - Cause: bot protection on `www.gymshark.com` for `/products/<handle>.json`.
  - Fix: request the same path on the store's myshopify domain (`SHOPIFY_STOREFRONT_URL=https://gymsharkusa.myshopify.com`), which returns JSON with HTTP 200.
  - Note: header spoofing against `www.gymshark.com` was blocked by our own safety check, so the myshopify domain is the supported path.
- **Product images were WebP saved as `.jpg`.**
  - Cause: the Shopify CDN negotiates the format from the `Accept` header (we had sent `image/avif,image/webp`).
  - Fix: request images with `Accept: image/jpeg,image/png;q=0.9` and name files from the response `Content-Type`. We now get the original JPEGs (1692×2018).
- **Chest logo on the back, missing back graphic at three-quarter angles.**
  - Cause: every frame received all 6 product photos, so the model had to guess which side was visible.
  - Fix: per-angle view selection in `tryon.py`, using distance from facing the camera (d):
    - d ≤ 45°: front only.
    - 45–75°: front + side.
    - 75–105°: side only (profile).
    - 105–135°: back + side.
    - over 135°: back only.
  - Plus one sentence in the prompt saying which way the body faces. This also cut cost about 35% per frame.
- **Sneakers leaking from the product photos.**
  - Cause: the product shots show the model wearing sneakers.
  - Partly fixed: the "ignore the model's shoes; keep footwear" rule plus per-angle refs kept socks in all 12 exp2 frames.
  - Still happens in studio-background mode (see §7).
  - 2026-11-07, user rule: **only the requested garments change; every other item stays as in the person's own photo.** Added `KEEP_OTHER_ITEMS` to `tryon.py` (included in `GARMENT_RULES`): feet (shoes/socks/bare), watch, jewelry, glasses, hat, belt and any other layer stay as in image 1; nothing but the top and pants may be taken from the product photos; no inventing, adding or removing items; hidden parts stay hidden. The studio `scene_replace` relight line now says a background change is no reason to restyle the person. `omni_video.py` prompts got the same generic rule (the hard-coded "grey socks" was removed). Not yet re-tested on a try-on run.
- **"Do not add text" conflicted with the back print.**
  - Fix: reworded to "no text or logos other than what is printed on the garments in the product photos".
- **Viewer stuck on "Loading…".**
  - Cause: `img.decode()` never resolves in a hidden or background Chrome tab.
  - Fix: wait on `onload`/`onerror`, then call `decode()` without awaiting it.
- **Pixel-diff duplicate-frame removal failed** (it kept 22 of 23 frames).
  - Cause: handheld camera shake makes whole-frame differences as large while standing still as while turning.
  - Fix: removed it. Real body angles from MediaPipe do the dedupe instead (the still lead-in collapses to one frame).
- **Fling momentum far too fast.**
  - Cause: release velocity is computed from the last 80 ms of pointer samples, and a quick drag gave about 6 deg/ms.
  - Fix: cap at `MAX_FLING = 0.9` deg/ms. Feel constants: `DRAG_TURN = 1.4` stage widths per turn, `FRICTION_MS = 320`.
- **Viewer API returned `angle: null` after a code change.**
  - Cause: a stale `serve.py` process was still running the old code.
  - Fix: restart the server after editing it (it doesn't hot-reload).
- **Time-based frame indexes vs. angle-named frames in the viewer.**
  - Fix: `tryon.py` records `frames_dir` and per-frame `src` and `angle` in `run.json`, and `serve.py` reads them.
- **Generated background changes the person's size and position between frames.**
  - Cause: when the model redraws the whole scene it also reframes the person.
  - Fix: `normalize_framing.py`.
    - SAM 3 segments the `"person"`; it measures head-top, feet and the torso center-x (median x over 20–60% of the body height, so swinging arms don't move it).
    - One affine scale-about-the-feet plus a shift maps every frame onto the median target; uncovered edges are filled by edge-replication padding.
    - It then re-segments the aligned frames to verify. Result: below 0.3% spread.
- **SAM 3 weights download hung at 0 bytes.**
  - Cause: Hugging Face's `hf-xet` backend stalled (0% CPU, `.incomplete` files stuck at 0 B) even though plain HTTP ran at about 5–6 MB/s.
  - Fix: `HF_HUB_DISABLE_XET=1` (plain HTTP); the 1 GB downloaded in about 2–3 min.
- **MediaPipe won't install in `.venv`.**
  - Cause: no wheels for Python 3.14.
  - Fix: separate `.venv-pose` on Homebrew Python 3.12. `.venv-sam` is also on 3.12, keeping MLX away from the other environments.
- **Frame interpolation ghosting across 30° gaps.**
  - Cause: optical-flow interpolation (ffmpeg `minterpolate`) can't infer 3D body rotation or text appearing from behind the body.
  - Resolution: use a generative video model (Luma or Omni) for in-betweens. RIFE/FILM only for small gaps.
- **MediaPipe mask fringe in background compositing.**
  - Cause: the pose segmentation mask is upsampled from about 256 px, so it's soft and includes adjacent objects.
  - Status: not fixed. Planned fix: SAM 3 masks (§7).
- **Viewer path traversal.**
  - Fix: `/files/*` resolves paths and only serves files inside `work/`. Tested: `/files/../.env.local` returns 404.

---

- **Omni 400: "Edited video duration (4.792s) does not match config duration (5s)".**
  - Cause: for video edits, the uploaded clip's length must equal `response_format.duration` (whole seconds).
  - Fix: `omni_video.py` now trims to a whole number of seconds (ceil of the span, 3–15 s), moving the start earlier to keep the end, and writes exactly `seconds × 30` frames (`-frames:v`). Default trim is now 1.83–6.83 s = 5.000 s, 150 frames.
- **Omni 404 for `gemini-omni-1.2-flash`.**
  - Cause: the docs' newest ID isn't enabled for our key; `models.list()` shows only `gemini-omni-flash-preview`.
  - Fix: default `--model gemini-omni-flash-preview`. Neither failed request produced a video.

## 6. Failed / rejected approaches

- **Time-based frames (every 300 ms):** wasteful duplicates while standing still, and uneven angle spacing for variable spin speed. Replaced by angle-based picking.
- **Sending all product views to every frame:** confuses front and back prints (exp1 frame 13) and costs more.
- **Pixel-diff dedupe in the viewer:** defeated by camera shake.
- **ffmpeg `minterpolate` between 30° keyframes:** ghosting.
- **Asking the image model to redraw the background** without post-alignment: scale/position drift of about 9–11% and invented sneakers. Usable only together with `normalize_framing.py`.
- **MediaPipe-mask compositing:** room fringe leaks; lighting doesn't match.
- **Header spoofing to get past Gymshark's 403:** blocked by our own safety rules and unnecessary (the myshopify domain works).
- **One video clip per gap with first/last-frame models (Veo, Seedance, MiniMax):** minimum clip lengths force about 10× retiming, stutter at joins, $2.5–15 per spin.
- **Lightweight SAM 3 variants (EfficientSAM3):** text prompts not actually released.

---

## 7. Web app (`tryon-app/`, Next.js 16.4.5)

- **Layout:** `tryon-app/` (own git repo, created by create-next-app). See `tryon-app/README.md`.
  - **Python only for on-device models:** `tryon-app/python/tryon_local` (FastAPI, one Python 3.12 venv with mediapipe 1.2.2 + mlx-vlm 0.7.12 + numpy 2.5.4, which coexist fine).
    - `POST /angles/extract`: the angle extractor refactored into `angles.extract()`.
    - `POST /framing/normalize`, `POST /segment`: SAM 3 MLX.
    - `GET /health`. All paths must live under `TRYON_DATA_DIR`.
  - **Everything else in Next.js API routes** (`src/app/api/*`, logic in `src/lib/server/*`): Shopify catalog/import, OpenAI try-on (port of `tryon.py` prompts incl. `KEEP_OTHER_ITEMS`), Gemini Omni, ffmpeg via `child_process`, file serving with HTTP Range, persisted job runner (`data/runs/<id>/run.json`).
  - **`npm run dev` → `scripts/dev.mjs`:** free port → `uvicorn` → wait for `/health` → `next dev` with `LOCAL_MODELS_URL`; Ctrl+C stops both. Verified: Python came up on a random port and Next found it.
  - `.env.local` is a symlink to the repo root's (keys not duplicated).
- **Guided capture (`/`):** instructions → sound check → camera with a 9:16 guide.
  - **In-browser MediaPipe Pose (lite, self-hosted in `public/mediapipe`):** waits until head-to-toe is in frame and the person faces the camera (holds 1.2 s / 0.8 s) → 3-2-1 → `MediaRecorder`.
  - **Live turn tracking (`TurnTracker`):** world-landmark shoulder+hip yaw, unwrapped, jumps over 45°/frame ignored. Auto-stop at ≥340°, or ≥330° when facing the camera again, plus a 0.5 s tail.
  - **Then:** upload → server crops to canonical 9:16 1080×1920 30 fps (`normalizePortrait`) → `POST /api/videos/:id/verify` (heavy pose model, needs ≥320°, no missing angles, cached in `videos/<id>/angles-30/` and reused by runs).
  - **Audio (`src/lib/capture/fillSynth.ts`, pure Web Audio):** a "filling bottle" bed (pink noise through a band-pass rising 520 Hz→2.2 kHz), bubble glugs every 6° (sine chirps 200→700 Hz), a glass chime per 30°, countdown ticks, a completion arpeggio, synthetic reverb + compressor; sound check and mute.
  - **UI:** 12-segment progress ring (`TurnRing`).
- **Outfit (`/new?video=`):** store search split by top/bottom from `product_type` (`Gender>Apparel>Category>…`).
  - Import downloads the original JPEGs and labels each photo front/back/side/detail/other with `gpt-5.4-mini` (+ `garment_fully_visible`, `plain_background`), ~4 s per product.
  - Ranking for refs: manual label > fully visible > clean studio shot > position. Labels can be fixed in the UI.
- **Runs (`/runs/:id`):** angles → try-on (concurrency 12) → SAM 3 alignment (studio only) → spin video → optional Omni. Live progress, drag-to-rotate viewer (React port), Omni player.
  - **Resume:** `POST /api/runs/:id/resume` reuses finished frames/steps (no re-billing).
  - **Spin video ends on the 0° frame** (`framesToVideo` appends `frames[0]` once) so the turn closes and the clip loops seamlessly (user request).
- **End-to-end test (`r20261108003451-bdbce5`):** a landscape WebM upload (simulated laptop webcam) → verified 347° / 12 angles.
  - Studio + Omni 360p: try-on 12/12 in 22 s, alignment height spread 8.66%→0.2% (112 s incl. SAM load + verify pass), Omni 275 s, **$1.10 total**.
  - Spin first/last frame both 0°. A half-turn clip was correctly rejected (182°).
- **QA tools:**
  - `?testVideo=<url>` dev mode feeds a file through the capture flow.
  - `python/tests/simulate_capture.py` replays the capture state machine offline with the same lite model. On `IMG_8204.mov`: framing OK at 1.3 s, countdown at 2.2 s, all ten 30° chimes, auto-stop at 332°.
- **Problems solved while building:**
  - **Next 16 + `cacheComponents`:** GET handlers call `await connection()`; client pages that use `useSearchParams` sit inside `<Suspense>`.
  - **React 19 lint:** no sync `setState` in effects (derive state, or remount via `key`); no ref writes during render; the self-scheduling rAF loop goes through a ref.
  - **Gemini JS SDK defaults to `v1`:** Omni needs `new GoogleGenAI({ apiVersion: "v1beta" })` ("'text' not supported for input type in v1").
  - **Product labels:** the vision model labelled lifestyle shots as "back" → added `plain_background` ranking. The pants side shot (04) was still labelled "front"; correct it in the UI.
  - **`useSample` name** tripped the hooks lint rule → `registerSample`.
  - **Turbopack HMR** served a stale module to a newly added route once; touching the file fixed it.
- **Not yet verified:** the live camera capture in a real browser. The automated Chrome tab stays hidden, so media and rAF don't run. Needs a manual test at http://localhost:3100.

---

- **Store catalog + Decisions API (added after the first app build):**
  - **Catalog DB:** `data/catalog.db` (Node's built-in `node:sqlite`; FTS5 full-text search) with `stores`, `products` and `products_fts` (kept in sync by triggers). `@types/node` was bumped to 24 for the `node:sqlite` types.
  - **Add store:** `POST /api/stores {url}`.
    - Valid if `/products.json` answers. Otherwise the homepage is scanned for `<shop>.myshopify.com` and that is tried.
    - Error codes: `not_shopify` ("Sorry, we only work with Shopify stores right now…" + examples), `catalog_private`, `unreachable`, `invalid_url`.
    - Store probe results: gymshark, allbirds, kith, fashionnova, aloyoga, outdoorvoices, taylorstitch, ripndip and cupshe all OK; skims.com via `skimsbody.myshopify.com`; nike and zara are not Shopify.
  - **Ingestion runs in the background** (`fetching` → `tagging` → `ready`). It fetches up to 40×250 products. Stores with more than 500 products are sampled at 50 per apparel section, in-stock first.
  - **Decisions API** (`gpt-6-luna`, `POST /v1/decisions`, $0.10/1M input tokens, output free, ~1.4 s): one request per product returns department, category, try-on suitability, color, fit, and per photo a `view` choice plus a `clean` predicate (question-level images). This replaced the `gpt-5.4-mini` view labelling.
    - Gymshark: 9,985 products → 221 sampled, $0.18. Kith: 10k (fetch cap) → 250, $0.13. Each took ~70 s.
  - **Shopper department:** a Decisions choice on the verified 0° frame (mens / womens / either). Below 0.8 confidence it falls back to "all". Stored per video in `profile.json` and overridable (`PUT /api/videos/:id/profile`). It is a default catalog filter, not a stored gender label. The sample video gave "all" (0.72).
  - **Runs** now reference catalog product ids. Product photos are downloaded on demand to `data/products/<store>/<handle>/`.
  - **UI:** store chips + Add store (validation messages, "processing… it'll show up shortly"), department chips preset from the recording.
  - **Verified:** search filters (men's tops "vengeance", men's bottoms, women's bottoms, Kith "black hoodie"); a catalog-driven 60° run (6 frames, $0.39); relabel via PATCH.
  - **Fixes:**
    - `/runs/[id]` needed `<Suspense>` for `useParams` under Cache Components, otherwise `next build` fails prerendering.
    - `turbopackIgnore` on the data-dir path so the build doesn't trace the whole project.
    - Stale Turbopack module after a route rename (`id.includes is not a function`): touch the file.
- **Handoff (2026-11-07):** `HANDOFF.md` and `.env.example` at the repo root; zip without keys, deps, venvs, data or work outputs.

---

## 8. Open issues & next steps

### Consistent Gemini input and garment-only references (2026-11-07)

- Fixed the 6.208s-input / 7s-config Gemini rejection. Input preparation now clamps to actual video-stream availability and uniformly retimes the complete selected turn to a whole 3–15 seconds at 30 fps. A final-frame pad only covers frame-grid rounding, and ffprobe validates the output before any upload. Long turns retain their beginning rather than dropping it. Audio/container length cannot hide a shorter video stream.
- Added SAM garment isolation using the selected listing's category/type to choose the text prompt. Creates separate lossless outputs: a dimmed surrounding scene for the picker, a neutral-background garment-only reference for image generation, and a mask. Original product images and garment foreground pixels are unchanged. Completed highlights are cached and simultaneous requests deduplicated. Failed views can try another photo; generation never silently falls back to the unmasked store model.
- The picker blocks Continue until the selected garment is isolated, supports highlighting another photo, and shows optional color/fit pairing suggestions in the complementary slot. The current flow enforces exactly one upper and one lower garment; duplicate products, swapped slots, sets, and conflicting one-piece outfits are rejected server-side. Image/video prompts replace the old outfit rather than layering additional garments.
- Resume preserves completed outfit frames and alignment, including Gemini-only retries. Partial frame failures now stop before producing an incomplete spin and can resume only the missing images. SAM dimming is never applied to generated people or videos; only the reference inputs are isolated.
- Verification: Node regression tests cover exact duration/frame counts (including 6.208s, short/off-zero/long clips and audio longer than video), selection rules, suggestions, separate cached outputs, and retries. Python tests cover pixel/source preservation and rejected masks. Real SAM tests isolated the bundled tee (0.986) and pants (0.970), preserving all masked garment pixels exactly. Live selection isolated the user's selected Alo pullover (0.922) and returned compatible bottoms. TypeScript, production build, browser flow, and API rejection checks passed. Cloud generation is not part of these local regression checks.

### GitHub repository preparation (2026-11-07)

- Initialized the project root as a Git repository linked to `andriucma/FittingRoom`, preserving the `tryon-app/`, prototype scripts, product references, and project documentation structure.
- Added a root setup README and ignore rules for local credentials, recordings (including the optional sample spin), catalogs/generated outputs, dependency folders, caches, and model weights. Only the placeholder `.env.example` is tracked. Each clone supplies its own API keys and runs the documented dependency/model setup.

### Recording finished but processing failed (`spawn ffmpeg ENOENT`, 2026-11-07)

- The transferred workspace had neither ffmpeg nor a Python model environment. Installed ffmpeg/ffprobe and Python 3.12 with Homebrew, then installed the Python service requirements and initiated the SAM 3 weight download.
- Recovered the latest unfinished camera upload locally: normalized its preserved source into the canonical portrait video, generated a preview, and registered it as **Recovered recording**. No original footage was removed. Local ffmpeg normalization, ffprobe duration, and preview generation passed.
- `npm start` now launches Python plus Next.js using the same launcher as dev, reads shared environment configuration, and checks media binaries at startup. `/api/health` reports ffmpeg/ffprobe status. The camera checks backend readiness before starting a recording; missing binary errors now explain the required setup.
- Production build and TypeScript passed. The running health endpoint reports both media binaries and the Python service available. Browser fake-camera startup/cancel, model-failure cleanup, and missing-ffmpeg preflight checks passed. Local turn verification of the recovered clip passed: 372.9°, 12 angles, no missing targets or low-confidence selected frames (74 seconds including initial model setup). Saved its verification and confirmed it appears in `/api/videos` with a playable preview. No recovered footage was sent to cloud models.

### Home screen as a fitting workspace (2026-11-07)

- Replaced the promotional hero/photo/stickers and explanatory feature strip with a practical home workspace: a rectangular blush/coral camera panel, sky upload panel, and mint lookbook panel. Kept all existing choices and the recording tips; camera/sound settings remain available separately.
- Open Camera starts the existing capture startup directly. The sound/settings stage is optional, preserving sound preview, mute, and back-camera controls. No permission request occurs until the user opens the camera.
- Production build and TypeScript passed. Desktop/mobile browser checks passed for preserved options, direct camera start, camera cancellation/failure cleanup, optional sound/settings, and the existing outfit flow using mocked catalog/generation APIs. Camera checks used simulated camera frames with the real local MediaPipe model. Updated home screenshots in `docs/previews/`. Local preview remains on port 3100.

### Camera preview disappears after startup (2026-11-07)

- User reported an active camera indicator but no preview, with a blank error panel. The browser MediaPipe WASM/runtime and lite model were absent because the dependency install used `--ignore-scripts` and never ran postinstall. Restored the runtime and downloaded the 5.5 MB lite model.
- Added automatic asset setup before dev, build, and start. Startup now reports a loading message, renders a nonempty error message for thrown strings/non-Error values, and releases camera tracks/video/audio when setup fails or is cancelled. A session counter prevents late async startup results from reopening the camera after cancellation.
- Production Webpack build passed. Chrome checks use a simulated camera with the real local pose runtime/model to verify preview visibility, active framing guidance, and camera shutdown on Cancel; the missing-model case is checked separately. No actual user camera footage is collected by these tests.

### FittingRoom frontend (2026-11-07)

- Branded the app FittingRoom with a hanger mark, page metadata/favicon, a light warm background, coral/blush primary colors, mint/sky accents, responsive header/footer, and a three-stage journey indicator. Used an existing local product image as clearly described style inspiration; no generated result is implied.
- Replaced the single large outfit form with a four-step flow: recording, top, bottoms, review. The reviewed selections persist across navigation; controls gate progression; the final screen retains both backgrounds, automatic Gemini, cost estimate, and expandable quality settings. Photo relabeling and store diagnostics are tucked into expandable panels.
- Modernized the capture introduction, sound/setup panels, store controls, product search/cards, video picker, lookbook, and results shell. Preserved the live camera canvas, MediaPipe tracking, countdown, turn ring, audio synthesis, and 360° canvas viewer behavior. Kept media surfaces dark.
- Browser QA found Webpack lacked the former Turbopack-only Tailwind transform. Replaced that integration with `@tailwindcss/postcss` and `postcss.config.mjs`, allowing both bundlers to generate utilities and font classes consistently.
- Verification: TypeScript and production Webpack build passed. Headless Chrome at 1440px and 390px verified the intro/sound transition, single-task steps, disabled progression, selections/settings, API request payload, error/retry handling, results/lookbook, keyboard skip navigation, generated CSS, and no horizontal overflow or browser exceptions. APIs were mocked to avoid paid requests. Real live camera and model generation remain unverified. Home screenshots are in `docs/previews/`.

### Environment-configured Shopify imports (2026-11-07)

- Replaced hardcoded featured brands with `SHOPIFY_STORE_URLS`, a comma/whitespace-separated URL list. Migrated local configuration and example values to Gymshark, Kith, and Alo Yoga; preserved credentials. Legacy `SHOPIFY_STOREFRONT_URL` remains supported.
- Opening the outfit page syncs configured stores through public-catalog validation and the existing background ingestion/tagging pipeline. Each host is attempted once per server process, including concurrent calls. Ready and active stores are reused; failed/interrupted stores retry on restart. Removing an environment URL leaves saved catalog data intact.
- Invalid links are reported in the store picker without preventing valid links from importing. Tagging failures now mark the store as failed rather than ready; auth/quota failures stop new tagging tasks, and retries retain previously tagged items and accumulated cost.
- Verification: mocked HTTP responses plus real in-memory SQLite covered list parsing, legacy configuration, concurrent duplicate requests, ready-store reuse, failed-store retries, invalid-link isolation, and quota errors. TypeScript passed. No live paid imports were attempted because the account previously reported no API credits.

### Stabilization and automatic smooth video (2026-11-07)

- SAM 3 framing normalization now runs for original-room backgrounds as well as studio backgrounds. Both the spin output and Gemini reference frames use the aligned images. Resuming reuses completed alignment.
- New run requests always enable Gemini Omni video (720p default); the outfit form keeps the resolution selector, removes the opt-in checkbox, and includes video in the estimate. The API requires a Gemini key before starting. Older saved runs retain their original video setting on resume.
- SAM normalization applies a scale/translation to the entire frame, including the original room. Gemini continues to edit the original video using aligned outfit references; SAM does not post-process Gemini's generated video.
- TypeScript and mocked pipeline checks cover both backgrounds, aligned video references, resuming after a Gemini failure without repeating image generation/alignment, and the API's automatic-video and missing-key behavior. Live generation remains unverified: OpenAI billing has no credits, and this workspace lacks the Python model environment and ffmpeg.
- Production build passed with `npm run build -- --webpack`.

### Additional brands (2026-11-07)

- Verified live public `/products.json?limit=250` responses for Kith (`https://kith.com`) and Alo Yoga (`https://www.aloyoga.com`); both included men's and women's listings.
- Added both as featured stores, seeded idempotently alongside the configured default even in an existing catalog.
- Large-catalog sampling now round-robins listing departments within each apparel section instead of selecting only the first 50. In-stock listings are prioritized per department; explicitly tagged kids' listings are excluded from the adult sample. Final classification remains with Decisions.
- Missing `OPENAI_KEY` now stops import with an actionable message; the store bar displays errors and offers **Retry import**.
- This transferred workspace initially had no `.env.local`, catalog database, installed dependencies, Python environment, or ffmpeg. Product tagging/import requires the user's OpenAI key; live import is not yet verified here.
- Validation: department parsing and balanced sampling passed synthetic skew/empty-input checks and checks against both downloaded catalogs. TypeScript passed after Next generated route types. Production build passed with `npm run build -- --webpack`; Turbopack encountered a host port-binding restriction. The running `/api/stores` registered both brands once, retained IDs across repeated requests, and returned the expected missing-key message. Created a Git-ignored `tryon-app/.env.local` with empty keys for local configuration.
- User supplied credentials were saved to the ignored environment file without printing them. Retried Kith and Alo imports; Alo downloaded 491 listings, but OpenAI tagging returned HTTP 429 (`no credits remaining`). Stopped the local server to prevent repeated failed tagging calls and marked the in-progress imports with the billing error. Add API credits before retrying; no searchable products have been tagged in this attempt.

- **Shirt fit:** the shirt renders closer to a regular fit than the product's oversized, boxy cut. Try stronger fit wording or Sunburst.
- **Sneakers in studio mode:** 7 of 12 frames in exp3 (before the `KEEP_OTHER_ITEMS` rule).
  - First: re-run exp3 settings with the new rule (~$1) to see if the prompt alone fixes it.
  - Next: cut the garments out of the product photos with SAM 3 (`"t-shirt"`, `"pants"`) before try-on, so the model never sees the shoes. Then re-run with `--background studio` and align.
- **330°→0° loop seam:** the source video only turns about 345.6°, so the last ~15° must be synthesized (Luma keyframe loop, or RIFE for the small gap).
- **Gemini Omni:** first 720p studio run in progress (`work/omni/omni1-studio-720p`); evaluate motion, outfit consistency, back print, socks, background.
  - Risks: references aren't pinned to frames, so the back print may be less exact; real-person and region restrictions.
- **Luma Ray3.2:** needs a Luma key.
  - Plan: multi-keyframe draft on `exp3-studio-aligned` (13 keyframes at output indexes 0, 10, … 120, 5 s → 4 s at 30 fps, about $0.06 at 360p), then 720p ($0.30).
  - The `video_edit` variant on exp2 is for keeping the real motion.
- **Better cut-outs:** swap the MediaPipe mask in `composite_background.py` for SAM 3 masks to remove the room fringe. Optionally add a light GPT "relight and fix edges" pass, with automatic drift checks under 1%.
- **Shopify product picker:** list `products.json` for a store, download images with `fetch_product.py`, label front/back/side views (manually or automatically), and let the user pick a top and a bottom in the web UI.
- **Ideas not yet tested:**
  - Anchor or neighbor-frame references for extra consistency.
  - `--target source` framing (match the real video geometry).
  - Sunburst vs. Flare comparison.
  - Cost per spin at 15° or 45° steps.
