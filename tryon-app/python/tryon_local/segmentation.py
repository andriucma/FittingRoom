"""Text-prompted segmentation and person-framing normalization.

Two interchangeable backends sit behind the public ``segment()`` API:

  * **mlx**  — SAM 3 (MLX, 8-bit) on Apple Silicon. The original, highest-quality path.
  * **clipseg** — CLIPSeg (PyTorch, CPU) used wherever MLX can't load, e.g. Windows / Linux.

The backend is picked once, automatically, by whether Apple's ``mlx`` runs here, so the
Mac keeps using SAM 3 unchanged while other platforms fall back to CLIPSeg.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np
from PIL import Image

SAM3_MODEL = "mlx-community/sam3-8bit"
CLIPSEG_MODEL = "CIDAS/clipseg-rd64-refined"
_lock = threading.Lock()          # neither backend is safe to call from several threads at once
_predictor = None                 # MLX SAM 3 (Apple Silicon)
_clipseg = None                   # (processor, model) tuple for the CPU fallback
_backend: str | None = None       # "mlx" or "clipseg", decided once


def _mlx_available() -> bool:
    """True only where Apple's MLX native library actually loads (Apple Silicon)."""
    try:
        import mlx.core  # noqa: F401  # the Metal-backed core DLL is absent off Apple Silicon
        return True
    except Exception:
        return False


def backend() -> str:
    global _backend
    if _backend is None:
        _backend = "mlx" if _mlx_available() else "clipseg"
    return _backend


def loaded() -> bool:
    """Whether the active backend's model is resident in memory yet."""
    return _predictor is not None or _clipseg is not None


def predictor():
    global _predictor
    if _predictor is None:
        from mlx_vlm.models.sam3.generate import Sam3Predictor
        from mlx_vlm.models.sam3.processing_sam3 import Sam3Processor
        from mlx_vlm.utils import get_model_path, load_model

        path = get_model_path(SAM3_MODEL)
        _predictor = Sam3Predictor(load_model(path), Sam3Processor.from_pretrained(str(path)), score_threshold=0.4)
    return _predictor


def _clipseg_model():
    global _clipseg
    if _clipseg is None:
        import torch
        from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor

        processor = CLIPSegProcessor.from_pretrained(CLIPSEG_MODEL)
        model = CLIPSegForImageSegmentation.from_pretrained(CLIPSEG_MODEL)
        model.eval()
        torch.set_num_threads(max(1, os.cpu_count() or 1))
        _clipseg = (processor, model)
    return _clipseg


def _segment_mlx(img: Image.Image, prompt: str) -> tuple[np.ndarray | None, float]:
    with _lock:
        r = predictor().predict(img.convert("RGB"), text_prompt=prompt)
    if len(r.scores) == 0:
        return None, 0.0
    areas = r.masks.reshape(len(r.scores), -1).sum(1)
    i = int(np.argmax(r.scores * areas))
    return r.masks[i].astype(bool), float(r.scores[i])


def _segment_clipseg(img: Image.Image, prompt: str) -> tuple[np.ndarray | None, float]:
    import torch

    processor, model = _clipseg_model()
    rgb = img.convert("RGB")
    with _lock:
        inputs = processor(text=[prompt], images=[rgb], return_tensors="pt")
        with torch.no_grad():
            logits = model(**inputs).logits            # (H', W') heatmap for the one prompt
        prob = torch.sigmoid(logits).squeeze().to(torch.float32).cpu().numpy()
    # Upsample the low-res heatmap back to the source resolution.
    prob_full = np.asarray(
        Image.fromarray((np.clip(prob, 0, 1) * 255).astype(np.uint8)).resize(rgb.size, Image.BILINEAR),
        dtype=np.float32,
    ) / 255.0
    peak = float(prob_full.max())
    if peak < 0.40:                                    # nothing matched the prompt with any confidence
        return None, 0.0
    # Threshold relative to the peak so a weak-but-real garment still fills out,
    # without dragging in low-confidence background.
    mask = prob_full >= max(0.40, 0.5 * peak)
    if not mask.any():
        return None, 0.0
    return mask, peak


def segment(img: Image.Image, prompt: str) -> tuple[np.ndarray | None, float]:
    """Mask (H, W) bool of the best instance for `prompt`, and a 0..1 confidence score."""
    return _segment_mlx(img, prompt) if backend() == "mlx" else _segment_clipseg(img, prompt)


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


def focus_garment(image: Path, prompt: str, out_dir: Path) -> dict:
    """Preserve the target garment pixels; create a dimmed UI preview and clean AI reference."""
    from PIL import ImageEnhance

    img = Image.open(image).convert("RGB")
    mask, score = segment(img, prompt)
    if mask is None or not mask.any():
        raise ValueError(f"Could not identify the {prompt} in this photo. Choose another product photo.")
    fraction = float(mask.mean())
    # Reject tiny detail detections or masks covering essentially the entire image.
    if score < 0.4 or fraction < 0.005 or fraction > 0.95:
        raise ValueError(f"Could not isolate the {prompt} confidently. Choose another product photo.")
    if mask.shape != (img.height, img.width):
        mask = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize(img.size, Image.NEAREST)) > 0
    alpha = Image.fromarray(mask.astype(np.uint8) * 255)
    background = ImageEnhance.Brightness(ImageEnhance.Color(img).enhance(0.15)).enhance(0.22)
    focused = Image.composite(img, background, alpha)
    reference = Image.composite(img, Image.new("RGB", img.size, (242, 242, 242)), alpha)
    out_dir.mkdir(parents=True, exist_ok=True)
    focused.save(out_dir / "focus.png")
    reference.save(out_dir / "reference.png")
    alpha.save(out_dir / "mask.png")
    return {"score": round(score, 3), "coverage": round(fraction, 4), "prompt": prompt,
            "focus": str(out_dir / "focus.png"), "reference": str(out_dir / "reference.png"),
            "mask": str(out_dir / "mask.png")}
