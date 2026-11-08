"""SAM 3 text-prompted segmentation (local, Apple Silicon via MLX, 8-bit weights).

Run scripts that import this with the SAM env:  .venv-sam/bin/python ...
First use downloads mlx-community/sam3-8bit (~1 GB) into the Hugging Face cache.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

MODEL = "mlx-community/sam3-8bit"


def load_predictor(threshold: float = 0.4):
    from mlx_vlm.models.sam3.generate import Sam3Predictor
    from mlx_vlm.models.sam3.processing_sam3 import Sam3Processor
    from mlx_vlm.utils import get_model_path, load_model

    path = get_model_path(MODEL)
    return Sam3Predictor(load_model(path), Sam3Processor.from_pretrained(str(path)), score_threshold=threshold)


def segment(predictor, img: Image.Image, prompt: str) -> tuple[np.ndarray | None, float]:
    """Mask (H, W) bool of the main instance for `prompt` (largest score x area), and its score."""
    r = predictor.predict(img.convert("RGB"), text_prompt=prompt)
    if len(r.scores) == 0:
        return None, 0.0
    areas = r.masks.reshape(len(r.scores), -1).sum(1)
    i = int(np.argmax(r.scores * areas))
    return r.masks[i].astype(bool), float(r.scores[i])
