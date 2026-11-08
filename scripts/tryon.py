#!/usr/bin/env python3
"""360° virtual try-on: dress every frame of a spin video in a given top + bottom.

Consistency strategy (from OpenAI's "Preserve identity and change clothing" and
"Keep a character consistent" guides):
  1. ANCHOR: edit one front-facing frame with [frame, top, bottom].
  2. FRAMES: edit every other frame with [frame, top, bottom, anchor result], telling
     the model the anchor shows exactly how the outfit must look, so every angle
     reuses the same rendering of the garments instead of re-inventing them.

Usage:
  .venv/bin/python scripts/tryon.py --top inputs/shirt.png --bottom inputs/pants.png
  # test on just a few frames first:
  .venv/bin/python scripts/tryon.py --top ... --bottom ... --only 1,10,15
  # reuse an anchor from a previous run (skips step 1):
  .venv/bin/python scripts/tryon.py --top ... --bottom ... --anchor work/runs/X/anchor.png
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent

# Only the requested garments may change; everything else the person wears is copied from THEIR photo,
# never from the product photos (which show a model with their own shoes, socks, tops, accessories).
KEEP_OTHER_ITEMS = """Only the top and the pants change. Every other item the person is wearing must stay exactly as it is in image 1, the photo of the person: whatever is on their feet (shoes, socks or bare feet), any watch, jewelry, glasses, hat, belt or other accessory, and any other clothing or layer that is not the top or the pants. Do not take anything from the product photos except the top and the pants themselves: no shoes, socks, belts, accessories or other clothing worn by the product model. Do not invent, add or remove any item. If part of an item is hidden in image 1, keep it hidden rather than inventing it."""

GARMENT_RULES = """Reproduce the garments faithfully: same color, fabric, texture, pattern, graphics, logos, neckline, sleeve length, fit, rise and leg cut as in the product photos. The product photos show the garments worn by a model; ignore that model, their body, skin and the studio background, and use only the top and the pants themselves.

Do not change the person's face, facial features, hair, skin tone, body shape, proportions, pose, stance, body rotation, hands or identity in any way. On the person, replace only the top and the pants, fitting them naturally to the existing pose and body with realistic drape, folds and fabric behavior. Do not add watermarks, or any text or logos other than what is printed on the garments in the product photos.

""" + KEEP_OTHER_ITEMS

SCENE_KEEP = """Match the lighting, shadows and color temperature of the original photo so the outfit looks photographed, not pasted on. Keep the background, room, camera angle, framing, crop and image quality exactly the same."""


def scene_replace(n: int) -> str:
    return f"""Image {n} is the background plate. Replace everything behind and around the person in image 1 (walls, doors, windows, furniture, floor, lamps, cables and every other object) with exactly the empty scene in image {n}: same backdrop color, floor, horizon line and light. Nothing from the original room may remain. Keep the person at exactly the same position, height in the frame, size and crop as in image 1, standing on the floor of image {n} with a soft natural contact shadow under their feet. Relight the person and the garments to match the lighting of image {n} so they look photographed there, not cut out and pasted, while keeping their skin tone, hair, identity and everything they wear unchanged. Changing the background is not a reason to restyle the person: no new shoes or accessories. Keep the camera angle and framing of image 1."""


# Reusable backgrounds: --background <preset> generates the empty plate once and caches it in
# inputs/backgrounds/<preset>.png; every frame then receives the same plate so the backdrop never drifts.
BACKGROUND_PRESETS = {
    "studio": ("An empty professional photo studio for full-body fashion photos: a seamless warm light-grey paper backdrop "
               "that curves smoothly into the floor (infinity cove) with no visible seams, corners, props, lights or "
               "equipment. Soft, even, diffused lighting with a gentle gradient on the backdrop, slightly brighter behind "
               "the subject area. Vertical phone photo taken at chest height, eye-level, as if framing a standing person "
               "full-body in the center. Photorealistic, completely empty, no people, no text."),
}

VIEW_RULE = """The person may be facing the camera, turned to the side, or facing away. Work out which way the person's body faces in image 1 and show the garments from that same angle, using the matching product view: the front design when you see their chest, the back design when you see their back, and the side view in profile. Any graphic or text printed on the back must appear only when the back is visible, and must match the back product photo exactly."""


ANGLE_RE = re.compile(r"_deg(\d+(?:\.\d+)?)")


def frame_angle(path: Path) -> float | None:
    """Body yaw from angle-based frame names like frame_003_deg090.jpg (0° = facing camera)."""
    m = ANGLE_RE.search(path.stem)
    return float(m.group(1)) % 360 if m else None


def orientation(angle: float) -> tuple[set[str], str]:
    """Which product views to send for a body angle, and how to describe the pose to the model."""
    d = min(angle, 360 - angle)  # angular distance from facing the camera
    if d <= 45:
        return {"front"}, ("In image 1 the person is facing the camera: you see their chest and the front of their legs. "
                           "Show the front of the garments only. Nothing printed on the back of the garments is visible.")
    if 75 <= d <= 105:
        return {"side"}, ("In image 1 the person is standing in profile, side-on to the camera: you see one side of their "
                          "body. Show the side of the garments. Prints on the front or back of the garments are hidden or "
                          "only barely visible at the edge.")
    if d < 90:
        return {"front", "side"}, ("In image 1 the person is turned about three-quarters to the side with their chest still partly "
                                   "toward the camera. Show the front and side of the garments. Nothing printed on the back of "
                                   "the garments is visible.")
    if d < 135:
        return {"back", "side"}, ("In image 1 the person is turned more than sideways, mostly away from the camera: you see one "
                                  "side and part of their back. Show the side and back of the garments; any back print appears on "
                                  "the visible part of the back, foreshortened by the angle. Nothing printed on the front of the "
                                  "garments is visible.")
    return {"back"}, ("In image 1 the person is facing away from the camera: you see their back. Show the back of the garments, "
                      "including any back print exactly as in the back product photo. Nothing printed on the front of the "
                      "garments, such as a chest logo, is visible.")


def select_refs(items: list[tuple[Path, str]], views: set[str]) -> list[tuple[Path, str]]:
    """Product photos matching the wanted views; fall back to all photos if none are labelled for them."""
    picked = [it for it in items if it[1] in views]
    return picked or items


def describe_refs(tops: list[tuple[Path, str]], bottoms: list[tuple[Path, str]], start: int) -> tuple[str, int]:
    lines, n = [], start
    for label, items in (("top", tops), ("pair of pants", bottoms)):
        for _, view in items:
            lines.append(f"Image {n} is a product photo of the {label}" + (f", {view} view." if view else "."))
            n += 1
    return "\n".join(lines), n


def anchor_prompt(tops, bottoms, background: bool = False) -> str:
    refs, n = describe_refs(tops, bottoms, 2)
    return f"""Image 1 is a photo of a person (the subject).
{refs}

Edit image 1 so the person is wearing the top and the pants shown in the product photos.

{VIEW_RULE}

{GARMENT_RULES}

{scene_replace(n) if background else SCENE_KEEP}"""


def frame_prompt(tops, bottoms, with_anchor: bool, pose: str | None = None, background: bool = False) -> str:
    refs, n = describe_refs(tops, bottoms, 2)
    anchor = (f"\nImage {n} is the approved reference: the same person already wearing this exact outfit, seen from the front. "
              "The outfit must look identical to it in every frame: same colors, shading, fit, length, how the top's hem sits "
              "and how the pants break over the feet.") if with_anchor else ""
    bg_n = n + 1 if with_anchor else n
    return f"""Image 1 is a photo of a person (the subject). It is one frame of a video in which the person turns in a full circle, and the outfit must look the same in every frame.
{refs}{anchor}

Edit image 1 so the person is wearing the top and the pants shown in the product photos.

{pose or VIEW_RULE}

{GARMENT_RULES}

{scene_replace(bg_n) if background else SCENE_KEEP}"""


def parse_ref(arg: str) -> tuple[Path, str]:
    """'path.jpg:back' -> (Path('path.jpg'), 'back')."""
    path, _, view = arg.rpartition(":") if ":" in arg and not Path(arg).exists() else (arg, "", "")
    return Path(path), view


def load_key() -> str:
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))
    key = os.environ.get("OPENAI_KEY") or os.environ.get("OPENAI_API_KEY")
    if not key:
        sys.exit("Set OPENAI_KEY in .env.local")
    return key


def edit(client: OpenAI, args, images: list[Path], prompt: str, out: Path) -> dict:
    last_err = None
    for attempt in range(3):
        try:
            t0 = time.time()
            files = [open(p, "rb") for p in images]
            try:
                kw = dict(model=args.model, image=files, prompt=prompt, size=args.size,
                          quality=args.quality, output_format="png")
                if args.complexity:
                    kw["complexity"] = args.complexity
                res = client.images.edit(**kw)
            finally:
                for f in files:
                    f.close()
            out.write_bytes(base64.b64decode(res.data[0].b64_json))
            usage = res.usage.model_dump() if getattr(res, "usage", None) else None
            return {"file": out.name, "seconds": round(time.time() - t0, 1), "usage": usage}
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"  ! {out.name} attempt {attempt + 1} failed: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"{out.name}: {last_err}")


def resolve_background(spec: str | None, regenerate: bool) -> tuple[Path | None, str | None]:
    """-> (plate path, prompt to generate it if it doesn't exist yet)."""
    if not spec or spec == "original":
        return None, None
    if Path(spec).is_file():
        return Path(spec), None
    if spec in BACKGROUND_PRESETS:
        name, prompt = spec, BACKGROUND_PRESETS[spec]
    elif spec.startswith("text:"):
        prompt = spec[5:].strip()
        name = "custom-" + re.sub(r"[^a-z0-9]+", "-", prompt.lower())[:40].strip("-")
    else:
        sys.exit(f"--background must be 'original', a preset ({', '.join(BACKGROUND_PRESETS)}), "
                 f"'text:<description>' or an image path; got {spec!r}")
    plate = ROOT / "inputs/backgrounds" / f"{name}.png"
    return plate, (prompt if regenerate or not plate.exists() else None)


def generate_plate(client: OpenAI, args, prompt: str, out: Path) -> dict:
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    res = client.images.generate(model=args.model, prompt=prompt, size=args.size, quality="high", output_format="png")
    out.write_bytes(base64.b64decode(res.data[0].b64_json))
    return {"file": str(out), "seconds": round(time.time() - t0, 1),
            "usage": res.usage.model_dump() if getattr(res, "usage", None) else None}


def assemble(run: Path, results: list[Path], frames: list[Path], fps: float) -> None:
    """Write a GIF/MP4 of the try-on spin and a drag-to-rotate HTML viewer."""
    listfile = run / "frames.txt"
    listfile.write_text("".join(f"file '{p.resolve()}'\nduration {1 / fps}\n" for p in results)
                        + f"file '{results[-1].resolve()}'\n")
    base = ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listfile)]
    subprocess.run(base + ["-vf", "scale=432:-2,split[a][b];[a]palettegen[p];[b][p]paletteuse",
                           "-loop", "0", str(run / "spin.gif")], check=True)
    subprocess.run(base + ["-vf", "scale=864:-2,format=yuv420p", "-c:v", "libx264",
                           "-r", "30", str(run / "spin.mp4")], check=True)

    pairs = [{"tryon": r.name, "orig": os.path.relpath(f, run)} for r, f in zip(results, frames)]
    (run / "viewer.html").write_text(VIEWER.replace("__FRAMES__", json.dumps(pairs)))


VIEWER = """<!doctype html><meta charset=utf-8><title>360 try-on</title>
<style>body{margin:0;background:#111;color:#ddd;font:14px system-ui;display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px}
.row{display:flex;gap:12px}img{height:80vh;border-radius:8px;user-select:none;-webkit-user-drag:none;cursor:ew-resize}
label{margin-right:12px}</style>
<div class=row><img id=t><img id=o></div>
<div><label><input type=checkbox id=auto checked> auto-rotate</label><label><input type=checkbox id=cmp> show original</label><span id=n></span></div>
<script>
const F=__FRAMES__;let i=0;const t=document.getElementById('t'),o=document.getElementById('o'),n=document.getElementById('n');
F.forEach(f=>{new Image().src=f.tryon;new Image().src=f.orig});
o.style.display='none';cmp.onchange=()=>o.style.display=cmp.checked?'':'none';
function show(){const f=F[(i%F.length+F.length)%F.length];t.src=f.tryon;o.src=f.orig;n.textContent=`frame ${(i%F.length+F.length)%F.length+1}/${F.length} — drag to rotate`}
show();setInterval(()=>{if(auto.checked){i++;show()}},300);
let x0=null;addEventListener('pointerdown',e=>{x0=e.clientX;auto.checked=false});addEventListener('pointerup',()=>x0=null);
addEventListener('pointermove',e=>{if(x0===null)return;const d=Math.trunc((e.clientX-x0)/25);if(d){i+=d;x0=e.clientX;show()}});
</script>"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--top", nargs="+", required=True, metavar="PATH[:VIEW]",
                    help="one or more product photos of the top, optionally labelled e.g. shirt_back.jpg:back")
    ap.add_argument("--bottom", nargs="+", required=True, metavar="PATH[:VIEW]")
    ap.add_argument("--no-anchor", action="store_true",
                    help="skip the anchor step; every frame is edited independently, all in parallel")
    ap.add_argument("--frames", type=Path, default=ROOT / "work/frames")
    ap.add_argument("--out", type=Path, help="run dir (default work/runs/<timestamp>)")
    ap.add_argument("--model", default="gpt-image-2.6-flare",
                    help="gpt-image-2.6-flare (fast) or gpt-image-2.6-sunburst (detail)")
    ap.add_argument("--quality", default="medium", choices=["auto", "low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--complexity", choices=["low", "medium", "high"], help="default: model default (high)")
    ap.add_argument("--size", default="864x1536", help="multiples of 16; 864x1536 matches the 9:16 frames")
    ap.add_argument("--anchor-frame", type=int, default=1, help="1-based index of a front-facing frame")
    ap.add_argument("--anchor", type=Path, help="reuse an existing anchor image instead of generating one")
    ap.add_argument("--only", help="comma-separated 1-based frame indexes to process (for testing)")
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--fps", type=float, default=10 / 3, help="playback fps (300ms/frame)")
    ap.add_argument("--all-views", action="store_true",
                    help="send every product photo to every frame even when frame angles are known")
    ap.add_argument("--background", default="original", metavar="original|PRESET|text:DESC|IMAGE",
                    help=f"keep the original room (default), use a preset ({', '.join(BACKGROUND_PRESETS)}), "
                         "describe one with text:..., or pass a background image. Plates are cached in inputs/backgrounds/")
    ap.add_argument("--regenerate-background", action="store_true", help="re-create a cached preset/text plate")
    ap.add_argument("--dry-run", action="store_true",
                    help="print per-frame angle, chosen product photos and prompt; no API calls")
    args = ap.parse_args()

    frames = sorted(args.frames.glob("frame_*.jpg"))
    if not frames:
        sys.exit(f"No frames in {args.frames}. Run scripts/extract_frames.sh first.")
    run = args.out or ROOT / "work/runs" / time.strftime("%Y%m%d-%H%M%S")
    tops, bottoms = [parse_ref(a) for a in args.top], [parse_ref(a) for a in args.bottom]
    for p, _ in tops + bottoms:
        if not p.exists():
            sys.exit(f"Missing reference image: {p}")
    refs = [p for p, _ in tops + bottoms]
    plate, plate_prompt = resolve_background(args.background, args.regenerate_background)
    has_bg = plate is not None

    def plan(frame: Path, with_anchor: bool) -> dict:
        """Per-frame inputs: only the product views that match the way the body faces."""
        angle = frame_angle(frame)
        if angle is None or args.all_views:
            t, b, pose = tops, bottoms, None
        else:
            views, pose = orientation(angle)
            t, b = select_refs(tops, views), select_refs(bottoms, views)
        return {"angle": angle, "refs": [p for p, _ in t + b],
                "views": [f"top:{v}" for _, v in t] + [f"bottom:{v}" for _, v in b],
                "prompt": frame_prompt(t, b, with_anchor, pose, has_bg)}

    idxs = [int(s) for s in args.only.split(",")] if args.only else range(1, len(frames) + 1)
    todo = {i: frames[i - 1] for i in idxs}
    if args.dry_run:
        for i, f in todo.items():
            pl = plan(f, not args.no_anchor)
            ang = "n/a" if pl["angle"] is None else f"{pl['angle']:.0f}°"
            print(f"frame {i:3d}  {f.name:28s} {ang:>5s}  {', '.join(pl['views'])}")
        if has_bg:
            print(f"\nbackground plate: {plate}" + (" (would be generated first)" if plate_prompt else " (cached)"))
        print("\n--- prompt for last frame ---\n" + pl["prompt"])
        return

    run.mkdir(parents=True, exist_ok=True)
    client = OpenAI(api_key=load_key(), timeout=300)
    log: dict = {"frames_dir": str(args.frames.resolve()), "model": args.model, "quality": args.quality, "complexity": args.complexity, "size": args.size,
                 "top": args.top, "bottom": args.bottom, "anchor_mode": not args.no_anchor,
                 "background": args.background, "background_plate": str(plate) if plate else None, "frames": {}}

    # 0. Background plate (generated once, then reused by every frame and every future run)
    if plate_prompt:
        print(f"[background] generating {plate.name} ...")
        log["background_generation"] = generate_plate(client, args, plate_prompt, plate)
        print(f"[background] done in {log['background_generation']['seconds']}s -> {plate}")
    elif plate:
        print(f"[background] using {plate}")
    bg = [plate] if plate else []

    # 1. Anchor
    anchor_src = frames[args.anchor_frame - 1]
    anchor = None
    if args.no_anchor:
        print("Anchor disabled: all frames edited independently")
    elif args.anchor:
        anchor = args.anchor
        print(f"Using existing anchor {anchor}")
    else:
        anchor = run / "anchor.png"
        print(f"[anchor] dressing {anchor_src.name} with {args.model} ...")
        log["anchor"] = edit(client, args, [anchor_src, *refs, *bg], anchor_prompt(tops, bottoms, has_bg), anchor)
        print(f"[anchor] done in {log['anchor']['seconds']}s -> {anchor}")

    # 2. All frames (conditioned on the anchor if there is one)
    print(f"[frames] {len(todo)} frames, concurrency {args.concurrency}")
    plans = {i: plan(f, anchor is not None) for i, f in todo.items()}
    extra = [anchor] if anchor else []
    with ThreadPoolExecutor(args.concurrency) as pool:
        futs = {pool.submit(edit, client, args, [f, *plans[i]["refs"], *extra, *bg], plans[i]["prompt"],
                            run / f"tryon_{i:03d}.png"): i for i, f in todo.items()}
        for fut in as_completed(futs):
            i = futs[fut]
            meta = {"src": str(todo[i].resolve()), "angle": plans[i]["angle"], "views": plans[i]["views"],
                    "prompt": plans[i]["prompt"]}
            try:
                log["frames"][i] = {**meta, **fut.result()}
                print(f"  ✓ frame {i:3d}  {log['frames'][i]['seconds']}s")
            except Exception as e:  # noqa: BLE001
                log["frames"][i] = {**meta, "error": str(e)}
                print(f"  ✗ frame {i:3d}  {e}", file=sys.stderr)

    (run / "run.json").write_text(json.dumps(log, indent=2, default=str))
    done = sorted(i for i, r in log["frames"].items() if "error" not in r)
    if len(done) >= 2:
        assemble(run, [run / f"tryon_{i:03d}.png" for i in done], [frames[i - 1] for i in done], args.fps)
        print(f"Wrote {run}/spin.gif, spin.mp4, viewer.html")
    print(f"Run dir: {run}")


if __name__ == "__main__":
    main()
