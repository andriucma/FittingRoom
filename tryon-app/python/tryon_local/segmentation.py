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


# CLIPSeg understands concrete garment nouns far better than abstract ones like "top".
# These are tried in addition to the original prompt (CLIPSeg path only); the Mac's SAM 3
# path and the try-on prompt text are unaffected.
_CLIPSEG_ALIASES = {
    "top": ["shirt", "t-shirt"],
    "pants": ["trousers"],
    "bottoms": ["trousers"],
}


def _clean_mask(mask: np.ndarray) -> np.ndarray:
    """Turn a raw CLIPSeg threshold map into one solid garment region.

    CLIPSeg returns a coarse per-pixel heatmap; thresholding it leaves ragged edges,
    scattered background specks and often several blobs (the garment plus same-ish-colored
    background or the *other* garment). Dressing GPT Image from such a reference is what
    makes the Windows output change from angle to angle. This fills interior holes and
    keeps the main garment region plus any other *sizeable* part, while dropping small
    stray blobs — so the reference is clean and stable without losing, say, the second
    leg of a wide-leg pant when the two legs are detected as separate blobs.

    CLIPSeg (Windows/Linux) only — SAM 3 (Mac) returns clean instance masks and never
    passes through here, so its behaviour is unchanged.
    """
    from scipy import ndimage

    if not mask.any():
        return mask
    structure = np.ones((3, 3), bool)
    h, w = mask.shape
    r = max(1, round(0.004 * max(h, w)))               # speck/smoothing scale, relative to image size
    # Fill interior holes first so prints, buttons or logos don't split the garment.
    m = ndimage.binary_fill_holes(mask)
    # Drop small scattered specks (background that weakly matched the prompt).
    opened = ndimage.binary_opening(m, structure=structure, iterations=r)
    if opened.any():                                   # but not if the garment itself was thin enough to vanish
        m = opened
    # Keep the main region and any other sizeable part (e.g. a separate pant leg),
    # but remove small stray blobs (background, or the other garment bleeding in).
    labels, n = ndimage.label(m, structure=structure)
    if n > 1:
        counts = np.bincount(labels.ravel())
        counts[0] = 0                                  # ignore the background label
        keep = np.flatnonzero(counts >= max(0.12 * int(counts.max()), 0.004 * m.size))
        m = np.isin(labels, keep)
    # Fill any holes reopened by component selection.
    return ndimage.binary_fill_holes(m)


def _clipseg_infer(rgb: Image.Image, prompt: str) -> tuple[np.ndarray | None, float, float]:
    """One CLIPSeg pass: (mask | None, peak probability, mask fraction) at full resolution."""
    import torch

    processor, model = _clipseg_model()
    with _lock:
        inputs = processor(text=[prompt], images=[rgb], return_tensors="pt")
        with torch.no_grad():
            logits = model(**inputs).logits            # (H', W') heatmap for the one prompt
        prob = torch.sigmoid(logits).squeeze().to(torch.float32).cpu().numpy()
    prob_full = np.asarray(
        Image.fromarray((np.clip(prob, 0, 1) * 255).astype(np.uint8)).resize(rgb.size, Image.BILINEAR),
        dtype=np.float32,
    ) / 255.0
    peak = float(prob_full.max())
    if peak < 0.40:                                    # nothing matched the prompt with any confidence
        return None, 0.0, 0.0
    # Threshold relative to the peak so a weak-but-real garment still fills out,
    # without dragging in low-confidence background.
    mask = prob_full >= max(0.40, 0.5 * peak)
    if not mask.any():
        return None, 0.0, 0.0
    mask = _clean_mask(mask)                            # one solid garment region (CLIPSeg path only)
    if not mask.any():
        return None, 0.0, 0.0
    return mask, peak, float(mask.mean())


def _segment_clipseg(img: Image.Image, prompt: str) -> tuple[np.ndarray | None, float]:
    rgb = img.convert("RGB")
    candidates = [prompt, *_CLIPSEG_ALIASES.get(prompt.strip().lower(), [])]
    best: tuple[float, np.ndarray, float] | None = None   # (rank, mask, peak)
    for p in candidates:
        mask, peak, frac = _clipseg_infer(rgb, p)
        if mask is None:
            continue
        # Prefer results whose coverage is in the usable band the caller requires.
        usable = 0.005 <= frac <= 0.95
        rank = peak + (1.0 if usable else 0.0)
        if best is None or rank > best[0]:
            best = (rank, mask, peak)
        if usable and peak >= 0.60:                   # already good — stop early, save a pass
            break
    if best is None:
        return None, 0.0
    return best[1], best[2]


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


_pose = None                                      # MediaPipe Pose Landmarker (IMAGE mode), lazy
_HEAD_LMS = (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)    # nose, eyes, ears, mouth → head line
_FOOT_LMS = (27, 28, 29, 30, 31, 32)              # ankles, heels, foot index → feet line
_TORSO_LMS = (11, 12, 23, 24)                     # shoulders, hips → body center-x


def _pose_landmarker():
    global _pose
    if _pose is None:
        import mediapipe as mp  # noqa: F401
        from mediapipe.tasks.python import BaseOptions, vision
        from . import angles
        _pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(angles.model_path("pose_heavy"))),
            running_mode=vision.RunningMode.IMAGE))
    return _pose


def _pose_measure(img: Image.Image) -> dict | None:
    """Head-top, feet, height and center-x from MediaPipe pose landmarks (pixels), or None.

    Steadier than a CLIPSeg ``person`` mask for the framing step (no contact shadow, no
    dropped limbs), so the Windows path can equalise the person's size across angles the
    way SAM 3 already does on the Mac. Used only off Apple Silicon — see ``_measure_subject``.
    """
    import mediapipe as mp

    arr = np.asarray(img.convert("RGB"), dtype=np.uint8)
    h, w = arr.shape[:2]
    try:
        with _lock:
            res = _pose_landmarker().detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=arr))
    except Exception:
        return None
    if not res.pose_landmarks:
        return None
    lm = res.pose_landmarks[0]
    top = min(lm[i].y for i in _HEAD_LMS) * h
    bottom = max(lm[i].y for i in _FOOT_LMS) * h
    if bottom <= top:
        return None
    cx = float(np.median([lm[i].x for i in _TORSO_LMS])) * w
    return {"top": int(round(top)), "bottom": int(round(bottom)),
            "height": float(bottom - top), "cx": cx, "score": 1.0}


def _measure_subject(img: Image.Image, prompt: str) -> dict | None:
    """Measure the subject for framing. Person off Apple Silicon → pose landmarks (with a
    CLIPSeg fallback); everything else (incl. SAM 3 on the Mac) keeps the mask measurement."""
    if prompt == "person" and backend() != "mlx":
        pm = _pose_measure(img)
        if pm is not None:
            return pm
    mask, score = segment(img, prompt)
    if mask is None:
        return None
    return {**measure(mask), "score": round(score, 3)}


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
        box = _measure_subject(img, prompt)
        if box is None:
            raise ValueError(f"no '{prompt}' found in {f.name}")
        imgs.append(img)
        boxes.append(box)
        if target == "source":
            if not sources:
                raise ValueError("target=source needs source frames")
            sbox = _measure_subject(Image.open(sources[i]).convert("RGB").resize(img.size, Image.LANCZOS), prompt)
            src_boxes.append(sbox)

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

    after = [b for b in (_measure_subject(Image.open(o).convert("RGB"), prompt) for o in outputs) if b]
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
