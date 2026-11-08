#!/usr/bin/env python3
"""Swap the background of a try-on run by compositing the person onto a background plate.

Deterministic alternative to asking the image model to redraw the scene: the person keeps the exact
position, scale and pixels from the try-on frames (no zoom/bob between frames, no invented shoes),
and every frame gets the identical plate. Person masks come from MediaPipe Pose Landmarker
segmentation (local, already used by extract_frames_by_angle.py).

Usage (needs the pose env):
  .venv-pose/bin/python scripts/composite_background.py work/runs/exp2-angle-views --background studio
  # -> work/runs/exp2-angle-views-studio/  (tryon_*.png + run.json, viewable in scripts/serve.py)
Background: preset name (inputs/backgrounds/<name>.png, create one with tryon.py --background <name>)
or a path to any image.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import mediapipe as mp
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).parent))
from extract_frames_by_angle import model_path  # noqa: E402  (downloads/caches the pose model)


def person_mask(seg, img: Image.Image) -> np.ndarray:
    """Float mask in [0,1] at image resolution."""
    res = seg.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(img.convert("RGB"))))
    if not res.segmentation_masks:
        raise RuntimeError("no person found")
    return res.segmentation_masks[0].numpy_view().astype(np.float32).squeeze()


def refine(mask: np.ndarray, feather: float) -> np.ndarray:
    m = np.clip((mask - 0.35) / 0.3, 0, 1)                       # harden the soft upsampled edge
    im = Image.fromarray((m * 255).astype(np.uint8))
    im = im.filter(ImageFilter.MinFilter(3))                      # pull edge in 1px to drop room fringe
    im = im.filter(ImageFilter.GaussianBlur(feather))
    return np.asarray(im, dtype=np.float32) / 255


def shadow_layer(mask: np.ndarray, strength: float) -> np.ndarray:
    """Soft floor shadow under the feet: returns a multiply factor (1 = no shadow)."""
    h, w = mask.shape
    rows = np.where((mask > 0.5).sum(1) > 0)[0]
    feet_y = rows.max()
    band = mask[max(feet_y - int(0.03 * h), 0):feet_y + 1] > 0.5
    xs = np.where(band.any(0))[0]
    x0, x1 = xs.min(), xs.max()
    cx, half = (x0 + x1) / 2, max((x1 - x0) * 0.75, 0.06 * w)
    sh = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(sh)
    d.ellipse([cx - half, feet_y - 0.012 * h, cx + half, feet_y + 0.018 * h], fill=int(255 * strength))           # ambient
    d.ellipse([x0 - 0.01 * w, feet_y - 0.006 * h, x1 + 0.01 * w, feet_y + 0.006 * h], fill=int(255 * min(1, strength * 1.8)))  # contact
    sh = sh.filter(ImageFilter.GaussianBlur(0.012 * h))
    return 1 - np.asarray(sh, dtype=np.float32) / 255


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", type=Path, help="try-on run dir containing tryon_*.png")
    ap.add_argument("--background", default="studio", help="preset name or image path")
    ap.add_argument("--out", type=Path, help="default: <run>-<background name>")
    ap.add_argument("--feather", type=float, default=1.2, help="edge blur in px")
    ap.add_argument("--shadow", type=float, default=0.35, help="floor shadow strength 0-1")
    args = ap.parse_args()

    plate_path = Path(args.background) if Path(args.background).is_file() else ROOT / "inputs/backgrounds" / f"{args.background}.png"
    if not plate_path.is_file():
        sys.exit(f"No background plate {plate_path}. Generate it with: "
                 f".venv/bin/python scripts/tryon.py ... --background {args.background} (or pass an image path)")
    frames = sorted(args.run.glob("tryon_*.png"))
    if not frames:
        sys.exit(f"No tryon_*.png in {args.run}")
    out = args.out or args.run.with_name(f"{args.run.name}-{plate_path.stem}")
    out.mkdir(parents=True, exist_ok=True)

    opts = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path("pose_heavy"))),
        running_mode=mp.tasks.vision.RunningMode.IMAGE, output_segmentation_masks=True)
    with mp.tasks.vision.PoseLandmarker.create_from_options(opts) as seg:
        for f in frames:
            img = Image.open(f).convert("RGB")
            plate = Image.open(plate_path).convert("RGB").resize(img.size, Image.LANCZOS)
            m = refine(person_mask(seg, img), args.feather)[..., None]
            bg = np.asarray(plate, dtype=np.float32) * shadow_layer(m[..., 0], args.shadow)[..., None]
            comp = np.asarray(img, dtype=np.float32) * m + bg * (1 - m)
            Image.fromarray(np.clip(comp, 0, 255).astype(np.uint8)).save(out / f.name)
            Image.fromarray((m[..., 0] * 255).astype(np.uint8)).save(out / f.name.replace("tryon_", "mask_"))
            print(f"  ✓ {f.name}")

    # Keep the run metadata so the viewer shows angles/originals; note the composite.
    meta = json.loads((args.run / "run.json").read_text()) if (args.run / "run.json").exists() else {}
    meta.update({"background": plate_path.stem, "background_plate": str(plate_path),
                 "background_mode": "composite", "composited_from": str(args.run.resolve())})
    (out / "run.json").write_text(json.dumps(meta, indent=2))
    fps = 4
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(fps), "-i", str(out / "tryon_%03d.png"),
                    "-vf", "scale=864:-2,format=yuv420p", "-c:v", "libx264", "-r", "30", str(out / "spin.mp4")], check=True)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
