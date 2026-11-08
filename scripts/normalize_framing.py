#!/usr/bin/env python3
"""Make the person the same size and position in every frame of a try-on run.

Generated frames (especially with a replaced background) can zoom/shift the person between frames.
This segments the person with SAM 3 ("person"), measures head-top, feet and torso center, then applies
the smallest scale + shift that maps every frame onto one common target, so the spin doesn't bob or pulse.

Targets:
  median  (default) common height/feet/center = median over frames -> each frame's resize is as close to 1x as possible
  max     common height = tallest frame -> only upscales (never shrinks; no edge fill needed for scale)
  source  each frame matches the person's box in its ORIGINAL video frame (real geometry from the video)
Edges uncovered by a shrink/shift are filled by extending the frame's own border pixels (fine for plain backdrops).

Usage:
  .venv-sam/bin/python scripts/normalize_framing.py work/runs/exp3-studio [--target median]
  # -> work/runs/exp3-studio-aligned/ (tryon_*.png, run.json, spin.mp4, framing.json, framing_check.jpg)
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from sam3_seg import load_predictor, segment  # noqa: E402


def measure(mask: np.ndarray) -> dict:
    """Head-top, feet, height and torso center-x of a person mask, in pixels."""
    rows = np.where(mask.any(1))[0]
    top, bottom = int(rows.min()), int(rows.max())
    h = bottom - top
    torso = mask[top + int(0.2 * h): top + int(0.6 * h)]       # shoulders..hips: arms swinging out barely move this
    ys, xs = np.nonzero(torso)
    return {"top": top, "bottom": bottom, "height": h, "cx": float(np.median(xs))}


def warp(img: Image.Image, src: dict, dst: dict) -> tuple[Image.Image, float]:
    """Scale about the feet so height matches, then move feet/center onto the target."""
    s = dst["height"] / src["height"]
    w, h = img.size
    pad = int(0.3 * max(w, h))
    a = np.asarray(img.convert("RGB"))
    padded = Image.fromarray(np.pad(a, ((pad, pad), (pad, pad), (0, 0)), mode="edge"))
    # output (x, y) -> input (x', y'):  x' = (x - X*)/s + cx,  y' = (y - B*)/s + bottom   (+pad for the padded copy)
    coeffs = (1 / s, 0, src["cx"] - dst["cx"] / s + pad,
              0, 1 / s, src["bottom"] - dst["bottom"] / s + pad)
    return padded.transform((w, h), Image.AFFINE, coeffs, resample=Image.BICUBIC), s


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", type=Path)
    ap.add_argument("--target", choices=["median", "max", "source"], default="median")
    ap.add_argument("--prompt", default="person")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    frames = sorted(args.run.glob("tryon_*.png"))
    if not frames:
        sys.exit(f"No tryon_*.png in {args.run}")
    meta = json.loads((args.run / "run.json").read_text()) if (args.run / "run.json").exists() else {}
    out = args.out or args.run.with_name(f"{args.run.name}-aligned")
    out.mkdir(parents=True, exist_ok=True)

    pred = load_predictor()
    imgs, boxes, src_boxes = {}, {}, {}
    for f in frames:
        idx = int(f.stem.split("_")[1])
        img = Image.open(f).convert("RGB")
        mask, score = segment(pred, img, args.prompt)
        if mask is None:
            sys.exit(f"SAM 3 found no '{args.prompt}' in {f.name}")
        imgs[idx], boxes[idx] = img, {**measure(mask), "score": round(score, 3)}
        if args.target == "source":
            src = meta.get("frames", {}).get(str(idx), {}).get("src")
            if not src:
                sys.exit("--target source needs run.json with per-frame 'src' (runs made by the current tryon.py)")
            simg = Image.open(src).convert("RGB").resize(img.size, Image.LANCZOS)
            smask, _ = segment(pred, simg, args.prompt)
            src_boxes[idx] = measure(smask)
        print(f"  segmented {f.name}  height {boxes[idx]['height']}px  feet {boxes[idx]['bottom']}  cx {boxes[idx]['cx']:.0f}")

    hs = np.array([b["height"] for b in boxes.values()])
    common = {"height": float(np.max(hs) if args.target == "max" else np.median(hs)),
              "bottom": float(np.median([b["bottom"] for b in boxes.values()])),
              "cx": float(np.median([b["cx"] for b in boxes.values()]))}

    report = {"target": args.target, "common": common, "frames": {}}
    for idx, img in imgs.items():
        dst = src_boxes[idx] if args.target == "source" else common
        warped, s = warp(img, boxes[idx], dst)
        warped.save(out / f"tryon_{idx:03d}.png")
        report["frames"][idx] = {"before": boxes[idx], "target": dst, "scale": round(s, 4)}

    # Verify: re-segment the aligned frames and report the remaining spread.
    after = {idx: measure(segment(pred, Image.open(out / f"tryon_{idx:03d}.png"), args.prompt)[0]) for idx in imgs}
    def spread(bs, key):  # as % of frame height
        v = [b[key] for b in bs.values()]
        return round(100 * (max(v) - min(v)) / imgs[next(iter(imgs))].size[1], 2)
    report["spread_pct_of_frame_height"] = {
        k: {"before": spread(boxes, k), "after": spread(after, k)} for k in ("top", "bottom", "height", "cx")}
    (out / "framing.json").write_text(json.dumps(report, indent=2))

    meta.update({"framing": {"target": args.target, "from": str(args.run.resolve())}})
    (out / "run.json").write_text(json.dumps(meta, indent=2))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "4", "-i", str(out / "tryon_%03d.png"),
                    "-vf", "scale=864:-2,format=yuv420p", "-c:v", "libx264", "-r", "30", str(out / "spin.mp4")], check=True)
    # Before/after strip with guide lines at the common head-top and feet.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(args.run / "tryon_%03d.png"), "-i", str(out / "tryon_%03d.png"),
                    "-filter_complex",
                    "[0]scale=216:384,tile=12x1[a];[1]scale=216:384,tile=12x1[b];[a][b]vstack,"
                    f"drawbox=y={(common['bottom'] - common['height']) * 384 / 1536:.0f}:w=iw:h=1:color=red,"
                    f"drawbox=y={common['bottom'] * 384 / 1536:.0f}:w=iw:h=1:color=red,"
                    f"drawbox=y={384 + (common['bottom'] - common['height']) * 384 / 1536:.0f}:w=iw:h=1:color=red,"
                    f"drawbox=y={384 + common['bottom'] * 384 / 1536:.0f}:w=iw:h=1:color=red",
                    "-frames:v", "1", str(out / "framing_check.jpg")], check=True)
    print(json.dumps(report["spread_pct_of_frame_height"], indent=1))
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
