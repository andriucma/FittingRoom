#!/usr/bin/env python3
"""Re-dress the ORIGINAL spin video with Gemini Omni 1.2 Flash (video edit + reference images).

Real motion comes from the source video; the outfit comes from up to 3 try-on keyframes
(front / side / back) passed as reference images of the same person. Needs GEMINI_API_KEY in .env.local.

Usage:
  .venv/bin/python scripts/omni_video.py                      # 360p draft, refs from exp2-angle-views 0/90/180°
  .venv/bin/python scripts/omni_video.py --resolution 720p --refs work/runs/X/tryon_001.png ...
  .venv/bin/python scripts/omni_video.py --dry-run            # trim + print the request, no API call
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL = "gemini-omni-flash-preview"  # 1.2-flash per docs; this key only exposes the preview ID

PROMPT = """Edit this video. It shows a man slowly turning a full circle in place in his bedroom. The reference images show the same man wearing the target outfit from the front, the side and the back.

Replace only his clothing, in every frame, with exactly the outfit in the reference images: an off-white oversized short-sleeve t-shirt with a small dark logo on the left chest and a large print on the back, and black wide-leg pants. The back print must match the back reference exactly and be visible only while his back faces the camera; the chest logo is visible only while his front faces the camera. The garments must turn with his body naturally and look the same throughout the turn.

Only the t-shirt and pants change. Everything else he wears stays exactly as in the video in every frame: whatever is on his feet, his watch and any other accessory or clothing. Do not take shoes, socks, accessories or anything else from the reference images except the t-shirt and pants, and do not invent, add or remove any item.

Keep everything else exactly as in the video: his face, hair, body, hands, his movement and its timing, the room, the lighting and the camera. Do not add objects, text, music or camera movement."""

PROMPT_STUDIO = """Edit this video. It shows a man slowly turning a full circle in place in his bedroom. The first three reference images show the same man wearing the target outfit, from the front, the side and the back, in a photo studio. The last reference image is that empty studio.

1. Replace only his clothing, in every frame, with exactly the outfit in the reference images: an off-white oversized short-sleeve t-shirt with a small dark logo on the left chest and a large print on the back, and black wide-leg pants. The back print must match the back reference exactly and be visible only while his back faces the camera; the chest logo is visible only while his front faces the camera. The garments must turn with his body naturally and look the same throughout the turn.
2. Replace the entire bedroom (walls, door, bed, furniture, lamp, keyboard, floor, cables) with the empty studio from the last reference image: a seamless light-grey backdrop curving into the floor, with soft even studio lighting and a soft shadow under his feet. Nothing from the bedroom may remain. Relight him to match the studio.

Only the t-shirt and pants change. Everything else he wears stays exactly as in the video in every frame: whatever is on his feet, his watch and any other accessory or clothing. Do not take shoes, socks, accessories or anything else from the reference images except the t-shirt and pants, and do not invent, add or remove any item.

Keep exactly as in the video: his face, hair, body, hands, his movement and its timing, his position and size in the frame, and the camera. Do not add objects, text, music or camera movement."""


def load_env() -> None:
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def probe_duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return float(out)


def trim(video: Path, start: float, end: float | None, out: Path, fps: int = 30) -> tuple[float, int]:
    """Cut [start, end] to a WHOLE number of seconds (3-15): Omni rejects edits whose input length differs from
    the requested duration. Rounds the span up and moves the start earlier (never past 0) to keep the end."""
    end = probe_duration(video) if end is None else end
    seconds = max(3, min(15, int(-(-(end - start) // 1))))     # ceil
    start = max(0.0, end - seconds)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", str(video),
                    "-vf", f"scale=720:1280,fps={fps}", "-frames:v", str(seconds * fps), "-an",
                    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(out)], check=True)
    return start, seconds


def image_part(p: Path) -> dict:
    return {"type": "image", "data": base64.b64encode(p.read_bytes()).decode(),
            "mime_type": mimetypes.guess_type(p.name)[0] or "image/png"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", type=Path, default=ROOT / "IMG_8204.mov")
    ap.add_argument("--start", type=float, default=2.0, help="seconds; default skips the still lead-in")
    ap.add_argument("--end", type=float, help="seconds; default end of video")
    run2 = ROOT / "work/runs/exp2-angle-views"
    ap.add_argument("--refs", type=Path, nargs="+",
                    default=[run2 / "tryon_001.png", run2 / "tryon_004.png", run2 / "tryon_007.png"],
                    help="up to 3 reference images of the dressed person (front, side, back)")
    ap.add_argument("--scene", choices=["original", "studio"], default="original",
                    help="studio: also replace the room with a studio backdrop (uses --plate as an extra reference)")
    ap.add_argument("--plate", type=Path, default=ROOT / "inputs/backgrounds/studio.png",
                    help="empty background image sent as the last reference when --scene studio")
    ap.add_argument("--prompt", help="override the built-in edit instruction")
    ap.add_argument("--resolution", default="360p", choices=["360p", "720p", "1080p", "4k"])
    ap.add_argument("--out", type=Path, help="default work/omni/<timestamp>")
    ap.add_argument("--model", default=MODEL, help="Omni model ID available to your key")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if len(args.refs) > 3:
        sys.exit("Omni allows up to 3 reference images per character")
    prompt = args.prompt or (PROMPT_STUDIO if args.scene == "studio" else PROMPT)
    scene_refs = [args.plate] if args.scene == "studio" else []
    for r in scene_refs:
        if not r.exists():
            sys.exit(f"Missing background plate {r}")
    for r in args.refs:
        if not r.exists():
            sys.exit(f"Missing reference {r}")
    out = (args.out or ROOT / "work/omni" / time.strftime("%Y%m%d-%H%M%S")).resolve()
    out.mkdir(parents=True, exist_ok=True)
    src = out / "source.mp4"
    start, seconds = trim(args.video, args.start, args.end, src)
    dur = probe_duration(src)
    response_format = {"type": "video", "aspect_ratio": "9:16", "resolution": args.resolution,
                       "duration": f"{seconds}s", "delivery": "inline"}
    log = {"model": args.model, "source": str(src), "source_start": round(start, 3), "source_seconds": round(dur, 3), "refs": [str(r) for r in args.refs],
           "scene": args.scene, "scene_refs": [str(r) for r in scene_refs],
           "response_format": response_format, "prompt": prompt}
    print(f"source {src.relative_to(ROOT)}  {dur:.2f}s -> requesting {seconds}s {args.resolution} 9:16")
    for r in args.refs:
        print(f"  ref {r}")
    if args.dry_run:
        for r in scene_refs:
            print(f"  scene ref {r}")
        print("\n" + prompt)
        return

    load_env()
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        sys.exit("Add GEMINI_API_KEY=... to .env.local (get one at https://aistudio.google.com/apikey)")
    from google import genai

    client = genai.Client(api_key=key)
    t0 = time.time()
    video_file = client.files.upload(file=str(src))
    while video_file.state == "PROCESSING":
        time.sleep(3)
        video_file = client.files.get(name=video_file.name)
    if video_file.state != "ACTIVE":
        sys.exit(f"Upload failed: {video_file.state}")
    print(f"uploaded in {time.time() - t0:.1f}s; generating ...")

    t1 = time.time()
    interaction = client.interactions.create(
        model=args.model,
        input=[{"type": "video", "uri": video_file.uri}, *[image_part(r) for r in [*args.refs, *scene_refs]],
               {"type": "text", "text": prompt}],
        response_format=response_format,
        store=False,
    )
    (out / "omni.mp4").write_bytes(base64.b64decode(interaction.output_video.data))
    log["generation_seconds"] = round(time.time() - t1, 1)
    usage = getattr(interaction, "usage", None)
    log["usage"] = usage.model_dump() if hasattr(usage, "model_dump") else usage
    (out / "run.json").write_text(json.dumps(log, indent=2, default=str))

    # Side-by-side with the source for review.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-i", str(out / "omni.mp4"), "-filter_complex",
                    "[0]scale=540:960,setsar=1[a];[1]scale=540:960,setsar=1[b];[a][b]hstack=shortest=1,format=yuv420p",
                    "-c:v", "libx264", "-crf", "20", str(out / "compare.mp4")], check=True)
    print(f"done in {log['generation_seconds']}s -> {out / 'omni.mp4'} (compare.mp4 = source | omni)")


if __name__ == "__main__":
    main()
