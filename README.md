# FittingRoom

Basically, record yourself turning around, pick some clothes, and see the outfit on you from every angle. You get a draggable 360° view and a smooth video, so you can actually see how the whole fit looks.

Made by **Armin Hatamian and Marcu Andriuca**.

## Which branch do I use?

- **`macbook`** is our tested MacBook version. It includes the latest cancellation fixes and synchronized video comparisons. Use this branch for the Mac setup below.
- **`main`** is the shared branch where Windows work continues. The Windows setup below uses main. The newest MacBook changes stay on their own branch so they can be tested separately.

## What you can do

- Record a full turn with your camera or upload a recording you already have.
- Browse clothes from Gymshark, Kith, Alo Yoga, Taylor Stitch and Outdoor Voices.
- Pick one top and one pair of bottoms, with suggestions that go with your selection.
- Keep your original background or use a studio background.
- Rotate your look, watch the video and compare it with the original.
- Keep your looks in **My looks**, or delete the ones you don’t want.

## What you need first

| Thing | What it’s for |
| --- | --- |
| Node.js 24 or newer | Runs the website and its API. |
| Python 3.12 | Runs the local body tracking and garment tools. |
| ffmpeg, including ffprobe | Prepares and exports the videos. Both commands need to work in your terminal. |
| An OpenAI API key | Generates the outfit images and organizes the clothing catalog. |
| A Gemini API key | Generates the smooth video. |

The API keys need access to the models configured in the app, with billing/credits available. Put them in the environment file, not in the code.

On an Apple Silicon Mac, garment masking uses **SAM 3 through MLX**. Windows and Linux use **CLIPSeg through PyTorch**. These are different masking models, so results can vary. We’ve tested the full setup on Mac; Windows has compatibility support but hasn’t been tested end to end on a Windows machine here.

## Run it on a Mac

Install the tools, clone the repo and open the app folder:

```bash
brew install node python@3.12 ffmpeg
git clone --branch macbook https://github.com/andriucma/FittingRoom.git
cd FittingRoom/tryon-app
```

If you already have the repo, run `git fetch origin` and `git switch macbook` from the repo folder, then open `tryon-app`.

```bash
cp ../.env.example .env.local
npm ci
npm run setup:python
```

The Python setup downloads the local model weights. The first setup can take a bit.

Open `.env.local` and fill in your keys:

```env
OPENAI_KEY=your_openai_key
GEMINI_API_KEY=your_gemini_key
```

Then start it:

```bash
npm run dev -- --port 3100
```

Open **http://localhost:3100**. Keep that terminal open while you use the site. **Ctrl+C** stops the website and the Python service.

## Run it on Windows

Install Node.js 24+, Python 3.12 and ffmpeg first. Make sure these work in a new PowerShell window:

```powershell
node --version
py -3.12 --version
ffmpeg -version
ffprobe -version
```

Then run:

```powershell
git clone https://github.com/andriucma/FittingRoom.git
cd FittingRoom\tryon-app
Copy-Item ..\.env.example .env.local
npm ci
py -3.12 -m venv python\.venv
python\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
```

Fill in `OPENAI_KEY` and `GEMINI_API_KEY` in `.env.local`, then:

```powershell
npm run dev -- --port 3100
```

Open **http://localhost:3100**. Use the manual Python commands above on Windows; `npm run setup:python` is the Mac/Bash setup script.

## Run the showcase build

From `tryon-app`, after the first setup:

```bash
npm run build -- --webpack
npm start -- --port 3100
```

This runs the built version of the site with the local Python service. You still need the Python environment, ffmpeg and your keys.

## How it actually works

1. **Get a recording.** The camera guides you into the frame, counts you in and records your turn. Uploads are converted to a consistent portrait format.
2. **Check the turn.** MediaPipe checks your body rotation and picks frames around the turn. The result is cached so we don’t keep checking the same recording.
3. **Choose the clothes.** The app reads public Shopify product feeds and organizes the items. Garment masking isolates the main product so the AI doesn’t copy extra clothes from the product photo.
4. **Build the outfit.** OpenAI edits the selected angles with your top and bottoms. Stabilization keeps the person’s framing consistent across those images.
5. **Make the video.** Gemini edits the recording using the finished outfit images as references.
6. **Sync the comparison.** We match body poses and retime the generated side to the original at 30 fps. If Gemini skips part of the turn, the comparison only shows the section both videos have. The full videos stay unchanged.
7. **Save the look.** Results are saved locally and show up in My looks. A failed step can reuse work that already finished.

On the **macbook** branch, **Cancel** stops a recording attempt, clears its countdown and stops its upload/verification work. Going back or leaving the recording screen also cancels the unfinished attempt. It doesn’t delete your other recordings or looks.

## Add more Shopify stores

In `tryon-app/.env.local`, add store links separated by commas:

```env
SHOPIFY_STORE_URLS=https://gymsharkusa.myshopify.com,https://kith.com,https://www.aloyoga.com,https://www.taylorstitch.com,https://www.outdoorvoices.com
```

Restart the app and open the outfit picker. New stores are imported and tagged automatically. That first import needs your OpenAI key; completed catalogs are reused. The store needs a public Shopify product feed. You don’t need a Shopify API key.

## Where everything is

| Folder | What’s in it |
| --- | --- |
| `tryon-app/src` | The website, UI and server API. |
| `tryon-app/python` | Body tracking, masking, stabilization and comparison syncing. |
| `tryon-app/data` | Local recordings, product catalog and generated looks. Created when the app runs. |
| `docs` | Project notes and experiments. |
| `scripts` and `web` | The earlier prototype tools and viewer. |

Keys, recordings, generated videos, downloaded weights and dependencies are ignored by Git. Don’t delete `tryon-app/data` if you want to keep your saved looks. Deleting a look in the UI moves its generated files into `data/deleted-looks`; the source recording stays available.

The sample recording isn’t included in Git. To use **Try a sample recording**, put your own `IMG_8204.mov` in the repo root. Otherwise just record or upload a video.

## If something doesn’t work

| What you see | What to check |
| --- | --- |
| `spawn ffmpeg ENOENT` | Install ffmpeg and make sure both `ffmpeg` and `ffprobe` work in the same terminal you use to start the app. |
| Python environment missing | Finish the Python setup above. The app expects it at `tryon-app/python/.venv`. |
| Camera won’t open | Allow camera access and use localhost or HTTPS. Close other apps using the camera. |
| Full-turn check fails | Keep your whole body visible, use even lighting and turn slowly all the way around. |
| API key or credit error | Check `.env.local`, provider billing and model access, then restart the app. |
| A new store isn’t ready yet | The first import can take time. If it fails, check the public product feed and the API key. |

## Check the code

From `tryon-app`:

```bash
npx next typegen
npm run typecheck
npm test
npm run build -- --webpack
python/.venv/bin/python -m unittest discover -s python/tests -p 'test_*.py'
```

For the last command on Windows, use `python\.venv\Scripts\python.exe` instead of `python/.venv/bin/python`.
