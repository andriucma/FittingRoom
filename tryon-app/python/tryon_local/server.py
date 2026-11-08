"""Local-models service: only the work that needs Python / on-device models.

  GET  /health                 liveness + which models are loaded
  POST /angles/extract         MediaPipe Pose: pick frames by body rotation angle
  POST /framing/normalize      SAM 3: same person scale/position in every frame
  POST /segment                SAM 3: text-prompted mask + bbox

All paths are absolute and must live under TRYON_DATA_DIR (shared with the Next.js app).
Run: uvicorn tryon_local.server:app --port 8001   (scripts/dev.mjs does this for you)
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import angles, segmentation

DATA_DIR = Path(os.environ.get("TRYON_DATA_DIR", Path(__file__).resolve().parents[2] / "data")).resolve()
app = FastAPI(title="tryon-local-models")


def safe(p: str) -> Path:
    path = Path(p).resolve()
    if not path.is_relative_to(DATA_DIR):
        raise HTTPException(400, f"path outside data dir: {p}")
    return path


class AnglesReq(BaseModel):
    video: str
    out_dir: str
    step_deg: float = Field(30.0, gt=1, le=180)
    size: str = "864x1536"


class FramingReq(BaseModel):
    frames: list[str]
    out_dir: str
    target: str = Field("median", pattern="^(median|max|source)$")
    sources: list[str] | None = None
    prompt: str = "person"


class SegmentReq(BaseModel):
    image: str
    prompt: str
    out: str


class GarmentReq(BaseModel):
    image: str
    prompt: str = Field(min_length=1, max_length=80)
    out_dir: str


@app.get("/health")
def health():
    return {"ok": True, "data_dir": str(DATA_DIR),
            "segmenter": segmentation.backend(), "sam3_loaded": segmentation.loaded()}


@app.post("/angles/extract")
def extract_angles(req: AnglesReq):
    video = safe(req.video)
    if not video.is_file():
        raise HTTPException(404, "video not found")
    t0 = time.time()
    meta = angles.extract(video, safe(req.out_dir), req.step_deg, req.size, viz=True)
    return {**meta, "seconds": round(time.time() - t0, 1)}


@app.post("/framing/normalize")
def normalize(req: FramingReq):
    t0 = time.time()
    try:
        rep = segmentation.normalize_framing([safe(f) for f in req.frames], safe(req.out_dir), req.target,
                                             [safe(s) for s in req.sources] if req.sources else None, req.prompt)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {**rep, "seconds": round(time.time() - t0, 1)}


@app.post("/segment")
def segment(req: SegmentReq):
    return segmentation.segment_to_file(safe(req.image), req.prompt, safe(req.out))


@app.post("/garments/focus")
def focus_garment(req: GarmentReq):
    image, out_dir = safe(req.image), safe(req.out_dir)
    if not image.is_file():
        raise HTTPException(404, "Product photo not found")
    try:
        return segmentation.focus_garment(image, req.prompt, out_dir)
    except ValueError as e:
        raise HTTPException(422, str(e))
