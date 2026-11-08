#!/usr/bin/env python3
"""Lightweight local server for the 360° try-on viewer (stdlib only).

Usage:
  python3 scripts/serve.py [--port 8000]
  open http://localhost:8000            (or http://localhost:8000/?run=<run-name>)

Routes:
  /                     web/index.html
  /api/runs             list of runs in work/runs that have try-on frames
  /api/runs/<name>      frames of one run (try-on + original video frame + optional angle)
  /files/<path>         static files under work/ (images)

Optional per-run angles: put angles.json in the run dir as {"<frame index>": degrees, ...}
(or a "frames" list of {"index", "angle"}); the viewer then spaces frames by real body angle.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work"
RUNS = WORK / "runs"
WEB = ROOT / "web"
TRYON_RE = re.compile(r"tryon_(\d+)\.(png|jpg|jpeg|webp)$")


def run_frames(run: Path) -> list[tuple[int, Path]]:
    out = []
    for p in run.iterdir():
        m = TRYON_RE.match(p.name)
        if m:
            out.append((int(m.group(1)), p))
    return sorted(out)


def load_angles(run: Path) -> dict[int, float]:
    f = run / "angles.json"
    if not f.exists():
        return {}
    data = json.loads(f.read_text())
    if isinstance(data, dict) and isinstance(data.get("frames"), list):
        return {int(x["index"]): float(x["angle"]) for x in data["frames"] if "angle" in x}
    if isinstance(data, dict):
        return {int(k): float(v) for k, v in data.items() if str(k).isdigit()}
    return {}


def run_detail(name: str) -> dict | None:
    run = (RUNS / name).resolve()
    if not run.is_dir() or run.parent != RUNS.resolve():
        return None
    meta = json.loads((run / "run.json").read_text()) if (run / "run.json").exists() else {}
    frames_dir = Path(meta.get("frames_dir") or WORK / "frames")
    angles = load_angles(run)
    frames = []
    logged = meta.get("frames", {})
    for idx, p in run_frames(run):
        info = logged.get(str(idx), {})
        # Source frame: recorded by tryon.py, else the time-based naming convention.
        orig = Path(info["src"]) if info.get("src") else next(
            (frames_dir / f"frame_{idx:03d}{ext}" for ext in (".jpg", ".png")
             if (frames_dir / f"frame_{idx:03d}{ext}").exists()), None)
        orig = orig.resolve() if orig and orig.exists() else None
        angle = angles.get(idx, info.get("angle"))
        frames.append({
            "index": idx,
            "tryon": f"/files/{p.relative_to(WORK)}?v={int(p.stat().st_mtime)}",
            "orig": f"/files/{orig.relative_to(WORK.resolve())}" if orig and orig.is_relative_to(WORK.resolve()) else None,
            "angle": angle,
        })
    keep = ("model", "quality", "complexity", "size", "top", "bottom", "anchor_mode")
    return {"name": name, "meta": {k: meta[k] for k in keep if k in meta}, "frames": frames}


def list_runs() -> list[dict]:
    runs = []
    if RUNS.exists():
        for d in RUNS.iterdir():
            if d.is_dir() and (n := len(run_frames(d))):
                runs.append({"name": d.name, "frames": n, "mtime": d.stat().st_mtime})
    return sorted(runs, key=lambda r: -r["mtime"])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter logs: only errors
        if args and str(args[1])[0] in "45":
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path in ("/", "/index.html"):
            return self.send_file(WEB / "index.html")
        if path == "/api/runs":
            return self.send_json(list_runs())
        if path.startswith("/api/runs/"):
            detail = run_detail(path.removeprefix("/api/runs/").strip("/"))
            return self.send_json(detail) if detail else self.send_json({"error": "run not found"}, 404)
        if path.startswith("/files/"):
            target = (WORK / path.removeprefix("/files/")).resolve()
            if target.is_file() and target.is_relative_to(WORK.resolve()):
                return self.send_file(target)
        self.send_json({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"360° viewer on http://localhost:{args.port}  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
