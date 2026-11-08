# FittingRoom app

Start with the [main README](../README.md). It explains the app, Mac and Windows setup, keys and how to run it.

## How the app is split up

| Part | What it does |
| --- | --- |
| `src/components/capture` | Camera, framing guidance, countdown and recording. |
| `src/components/NewRun.tsx` | Recording selection, one top, one bottom and final review. |
| `src/components/RunView.tsx` | Progress, 360° viewer, smooth video and comparisons. |
| `src/components/RunsList.tsx` | Saved looks and delete confirmation. |
| `src/app/api` | Website API routes. |
| `src/lib/server` | Catalog, generation pipeline, video preparation and saved state. |
| `python/tryon_local` | MediaPipe, garment masking, framing stabilization and timing alignment. |

Node starts the Python service automatically for both `npm run dev` and `npm start`. The launcher checks ffmpeg and ffprobe first. Node 24+ is needed for the SQLite catalog.

## Recording and cancellation

Each camera/upload attempt has its own operation ID and abort signal. Cancel clears countdown/finish timers, disables the recorder callbacks and stops camera tracks. Cancel or navigation also aborts the upload/verification requests and calls `DELETE /api/video-operations/:id`.

The server stops ffmpeg with that signal and removes an unfinished new upload. Pose verification runs in an isolated worker; a disconnected request terminates the worker and its ffmpeg process tree. Cancellation is remembered briefly so a delayed request cannot restart the attempt. Existing saved recordings and looks are kept.

## Pipeline

1. Convert the recording to portrait H.264 and make a browser preview.
2. Verify the full turn with MediaPipe and cache the angle selection.
3. Import/tag Shopify products and isolate the selected garments from their photos.
4. Generate the outfit at the selected angles with OpenAI.
5. Stabilize the generated frames and build the 360° view.
6. Edit the prepared recording with Gemini using the finished outfit references.
7. Match source/generated body poses and export the comparison at 30 fps.

Apple Silicon uses SAM 3/MLX for segmentation. Windows/Linux fall back to CLIPSeg/PyTorch. Full Windows setup instructions are in the main README; Windows runtime support has not been tested on Windows here.

Comparison alignment only uses poses both videos contain. The full original and generated videos are kept intact. A failed local comparison retry reuses the paid Gemini output. Per-run diagnostics are saved in `data/runs/:id/omni/sync.json`.

## Local data

Everything lives under `data` unless `TRYON_DATA_DIR` overrides it:

- `videos/:id`: original upload, normalized video, preview, angle analysis and verification.
- `products`: downloaded product photos and cached isolated garment references.
- `runs/:id`: saved run state, edited frames, stabilized images and videos.
- `deleted-looks`: archived looks removed from the UI.
- `catalog.db`: store import status and searchable products.

The product photo highlight is for selection. The generation pipeline uses the isolated garment on a neutral background, never the dimmed picker photo.

## Useful checks

```bash
npx next typegen
npm run typecheck
npm test
npm run build -- --webpack
python/.venv/bin/python -m unittest discover -s python/tests -p 'test_*.py'
```

For Python on Windows, use `python/.venv/Scripts/python.exe`.

To rebuild saved comparisons without generating another video, run from `tryon-app/python`:

```bash
.venv/bin/python -m tryon_local.synchronization --runs-dir ../data/runs
```

API keys belong in `tryon-app/.env.local`. Local videos, catalogs, model weights, environments and generated files stay out of Git.
