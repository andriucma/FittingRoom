"""SAM 3 text-prompted segmentation (MLX, 8-bit) and person-framing normalization."""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
from PIL import Image

SAM3_MODEL = "mlx-community/sam3-8bit"
_lock = threading.Lock()          # MLX predictor isn't safe to call from several threads at once
_predictor = None


def predictor():
    global _predictor
    if _predictor is None:
        from mlx_vlm.models.sam3.generate import Sam3Predictor
        from mlx_vlm.models.sam3.processing_sam3 import Sam3Processor
        from mlx_vlm.utils import get_model_path, load_model

        path = get_model_path(SAM3_MODEL)
        _predictor = Sam3Predictor(load_model(path), Sam3Processor.from_pretrained(str(path)), score_threshold=0.4)
    return _predictor


def segment(img: Image.Image, prompt: str) -> tuple[np.ndarray | None, float]:
    """Mask (H, W) bool of the main instance for `prompt` (largest score x area) and its score."""
    with _lock:
        r = predictor().predict(img.convert("RGB"), text_prompt=prompt)
    if len(r.scores) == 0:
        return None, 0.0
    areas = r.masks.reshape(len(r.scores), -1).sum(1)
    i = int(np.argmax(r.scores * areas))
    return r.masks[i].astype(bool), float(r.scores[i])


def measure(mask: np.ndarray) -> dict:
    """Head-top, feet, height and torso center-x of a person mask (pixels)."""
    rows = np.where(mask.any(1))[0]
    top, bottom = int(rows.min()), int(rows.max())
    h = bottom - top
    torso = mask[top + int(0.2 * h): top + int(0.6 * h)]       # shoulders..hips: robust to arm swing
    _, xs = np.nonzero(torso)
    return {"top": top, "bottom": bottom, "height": h, "cx": float(np.median(xs))}


def warp(img: Image.Image, src: dict, dst: dict) -> tuple[Image.Image, float]:
    """Scale about the feet so heights match, then move feet/center onto the target. Edges are extended."""
    s = dst["height"] / src["height"]
    w, h = img.size
    pad = int(0.3 * max(w, h))
    a = np.asarray(img.convert("RGB"))
    padded = Image.fromarray(np.pad(a, ((pad, pad), (pad, pad), (0, 0)), mode="edge"))
    coeffs = (1 / s, 0, src["cx"] - dst["cx"] / s + pad, 0, 1 / s, src["bottom"] - dst["bottom"] / s + pad)
    return padded.transform((w, h), Image.AFFINE, coeffs, resample=Image.BICUBIC), s


def normalize_framing(frames: list[Path], out_dir: Path, target: str = "median",
                      sources: list[Path] | None = None, prompt: str = "person") -> dict:
    """Give the person the same scale/position in every frame. Writes aligned frames (same names) to out_dir."""
    out_dir.mkdir(parents=True, exist_ok=True)
    imgs, boxes, src_boxes = [], [], []
    for i, f in enumerate(frames):
        img = Image.open(f).convert("RGB")
        mask, score = segment(img, prompt)
        if mask is None:
            raise ValueError(f"no '{prompt}' found in {f.name}")
        imgs.append(img)
        boxes.append({**measure(mask), "score": round(score, 3)})
        if target == "source":
            if not sources:
                raise ValueError("target=source needs source frames")
            smask, _ = segment(Image.open(sources[i]).convert("RGB").resize(img.size, Image.LANCZOS), prompt)
            src_boxes.append(measure(smask))

    hs = np.array([b["height"] for b in boxes])
    common = {"height": float(hs.max() if target == "max" else np.median(hs)),
              "bottom": float(np.median([b["bottom"] for b in boxes])),
              "cx": float(np.median([b["cx"] for b in boxes]))}
    outputs, per_frame = [], []
    for i, (f, img) in enumerate(zip(frames, imgs)):
        dst = src_boxes[i] if target == "source" else common
        warped, s = warp(img, boxes[i], dst)
        out = out_dir / f.name
        warped.save(out)
        outputs.append(str(out))
        per_frame.append({"file": str(out), "before": boxes[i], "scale": round(s, 4)})

    after = [measure(segment(Image.open(o), prompt)[0]) for o in outputs]
    H = imgs[0].size[1]

    def spread(bs, key):
        v = [b[key] for b in bs]
        return round(100 * (max(v) - min(v)) / H, 2)

    return {"target": target, "common": common, "frames": per_frame, "outputs": outputs,
            "spread_pct": {k: {"before": spread(boxes, k), "after": spread(after, k)}
                           for k in ("top", "bottom", "height", "cx")}}


def segment_to_file(image: Path, prompt: str, out: Path) -> dict:
    """Binary mask PNG + bbox for `prompt` in `image`."""
    img = Image.open(image).convert("RGB")
    mask, score = segment(img, prompt)
    if mask is None:
        return {"found": False}
    Image.fromarray((mask * 255).astype(np.uint8)).save(out)
    ys, xs = np.nonzero(mask)
    return {"found": True, "score": round(score, 3), "mask": str(out),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]}
