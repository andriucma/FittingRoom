"""Retiming for comparison clips only. Original recordings and Gemini outputs stay intact."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np

from . import angles

VERSION = 3
POSE_VERSION = 2
FPS = 30
_lock = threading.Lock()


def _tool(name):
    return os.environ.get(f"{name.upper()}_PATH", name)


def _signature(file):
    stat = file.stat()
    return {"file": str(file.resolve()), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def _probe(file):
    raw = subprocess.check_output([_tool("ffprobe"), "-v", "error", "-select_streams", "v:0",
                                   "-show_entries", "stream=duration,width,height:format=duration", "-of", "json", str(file)])
    meta = json.loads(raw)
    if not meta.get("streams"):
        raise ValueError("Comparison input has no video stream")
    stream = meta["streams"][0]
    duration = float(stream.get("duration", meta.get("format", {}).get("duration", 0)))
    if not np.isfinite(duration) or duration <= 0:
        raise ValueError("Comparison input has no usable duration")
    return duration, int(stream["width"]), int(stream["height"])


def _write_json(file, data):
    temp = file.with_suffix(".tmp.json")
    temp.write_text(json.dumps(data, indent=2))
    temp.replace(file)


def _measure(video, cache):
    signature = _signature(video)
    try:
        saved = json.loads(cache.read_text())
        if saved.get("version") == POSE_VERSION and saved.get("signature") == signature:
            return saved["records"]
    except (OSError, ValueError, KeyError):
        pass
    records, _ = angles.analyze(video, 432, 768, "pose_heavy", include_landmarks=True)
    _write_json(cache, {"version": POSE_VERSION, "signature": signature, "records": records})
    return records


def pose_features(records):
    valid = np.array([bool(r.get("pose")) and "landmarks" in r and r.get("presence", 0) >= .4 for r in records])
    if len(records) < 12 or valid.mean() < .6:
        raise ValueError("Not enough reliable body poses to align this comparison")
    yaw, _, _ = angles.resolve_front_back(records)
    _, _, progress, _, direction = angles.build_track(records, yaw)
    detected = np.flatnonzero(valid)
    pose = np.array([records[i]["landmarks"] for i in detected])
    # Ignore image placement, person size and clothing texture. Match limb geometry.
    pose = pose * [432 / 768, 1]
    center = (pose[:, 23] + pose[:, 24]) / 2
    shoulders = (pose[:, 11] + pose[:, 12]) / 2
    scale = np.maximum(np.linalg.norm(shoulders - center, axis=1), .03)
    selected = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
    body = ((pose[:, selected] - center[:, None]) / scale[:, None, None]).reshape(len(detected), -1)
    body = np.stack([np.interp(np.arange(len(records)), detected, body[:, i]) for i in range(body.shape[1])], axis=1)
    good_yaw = np.flatnonzero(np.isfinite(yaw))
    unwrapped = np.unwrap(np.radians(yaw[good_yaw]))
    theta = np.interp(np.arange(len(records)), good_yaw, unwrapped)
    orientation = np.stack([np.cos(theta), np.sin(theta)], axis=1)
    return {"body": body, "orientation": orientation, "time": np.array([r["t"] for r in records]),
            "valid": valid, "progress": progress, "direction": direction}


def align_features(source, generated, band=.35):
    """Monotone dynamic time warping; a clock prior limits false matches in static poses."""
    n, m = len(source["body"]), len(generated["body"])
    if min(n, m) < 2:
        raise ValueError("Comparison needs at least two frames on each side")
    body = np.minimum((source["body"][:, None] - generated["body"][None]) ** 2, 4).mean(axis=2)
    orientation = ((source["orientation"][:, None] - generated["orientation"][None]) ** 2).sum(axis=2)
    costs = body + .35 * orientation
    clock = np.abs(np.linspace(0, 1, n)[:, None] - np.linspace(0, 1, m)[None])
    costs += .08 * clock ** 2
    scores = np.full((n + 1, m + 1), np.inf)
    steps = np.zeros((n, m), np.uint8)
    scores[0, 0] = 0
    for i in range(n):
        for j in range(m):
            if clock[i, j] > band:
                continue
            options = [scores[i, j], scores[i, j + 1] + .035, scores[i + 1, j] + .035]
            step = int(np.argmin(options))
            scores[i + 1, j + 1] = costs[i, j] + options[step]
            steps[i, j] = step
    if not np.isfinite(scores[n, m]):
        raise ValueError("No reliable monotone alignment found")
    groups = [[] for _ in range(n)]
    i, j = n - 1, m - 1
    while i >= 0 and j >= 0:
        groups[i].append(j)
        step = steps[i, j]
        if step != 2:
            i -= 1
        if step != 1:
            j -= 1
    mapping = np.array([np.mean(g) for g in groups])
    # Smooth frame choices without allowing time to run backwards.
    mapping = np.maximum.accumulate(angles.gaussian_smooth(mapping, 1.0))
    mapping[0], mapping[-1] = 0, m - 1
    baseline = np.rint(np.linspace(0, m - 1, n)).astype(int)
    chosen = np.clip(np.rint(mapping).astype(int), 0, m - 1)
    before = float(costs[np.arange(n), baseline].mean())
    after = float(costs[np.arange(n), chosen].mean())
    angular = lambda indices: np.degrees(np.arccos(np.clip((source["orientation"] * generated["orientation"][indices]).sum(axis=1), -1, 1)))
    metrics = {"pose_error_before": round(before, 4), "pose_error_after": round(after, 4),
               "median_angle_error_before_deg": round(float(np.median(angular(baseline))), 2),
               "median_angle_error_after_deg": round(float(np.median(angular(chosen))), 2)}
    if after > before:
        return baseline.astype(float), {**metrics, "pose_error_after": round(before, 4)}, False
    return mapping, metrics, True


def _encode_retimed(video, indices, out):
    import cv2
    cap = cv2.VideoCapture(str(video))
    pipe = None
    try:
        ok, frame = cap.read()
        if not ok:
            raise ValueError("Generated video could not be decoded")
        h, w = frame.shape[:2]
        with tempfile.TemporaryFile() as errors:
            pipe = subprocess.Popen([_tool("ffmpeg"), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                                     "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264",
                                     "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)],
                                    stdin=subprocess.PIPE, stderr=errors)
            current = 0
            for target in indices:
                while current < target:
                    ok, next_frame = cap.read()
                    if not ok:
                        raise ValueError("Generated video ended before its measured last frame")
                    frame = next_frame
                    current += 1
                pipe.stdin.write(frame.tobytes())
            pipe.stdin.close()
            if pipe.wait() != 0:
                errors.seek(0)
                raise RuntimeError(errors.read().decode(errors="replace")[-1000:])
    finally:
        cap.release()
        if pipe is not None and pipe.poll() is None:
            if pipe.stdin and not pipe.stdin.closed:
                pipe.stdin.close()
            pipe.terminate()
            pipe.wait()


def shared_interval(errors, tolerance=25):
    """Longest continuous range of matching poses; exclude motion Gemini never produced."""
    reliable = angles.median_filter(np.asarray(errors), 5) <= tolerance
    padded = np.r_[False, reliable, False].astype(int)
    starts, ends = np.flatnonzero(np.diff(padded) == 1), np.flatnonzero(np.diff(padded) == -1)
    if not len(starts):
        raise ValueError("No shared pose interval could be identified")
    best = int(np.argmax(ends - starts))
    start, end = int(starts[best]), int(ends[best])
    if end - start < max(FPS // 2, len(errors) * .2):
        raise ValueError("The generated motion has too few matching poses for a reliable comparison")
    return start, end


def _normalize(video, out, duration, frames):
    actual, _, _ = _probe(video)
    subprocess.run([_tool("ffmpeg"), "-v", "error", "-y", "-i", str(video), "-vf",
                    f"setpts=(PTS-STARTPTS)*{duration / actual:.12f},fps={FPS},tpad=stop_mode=clone:stop_duration={duration}",
                    "-frames:v", str(frames), "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", str(out)], check=True, capture_output=True)


def _comparison(source, aligned, out, start, end):
    common = f"setpts=PTS-STARTPTS,fps={FPS},trim=start_frame={start}:end_frame={end},scale=540:960,setsar=1,settb=AVTB,setpts=N/({FPS}*TB)"
    subprocess.run([_tool("ffmpeg"), "-v", "error", "-y", "-i", str(source), "-i", str(aligned),
                    "-filter_complex", f"[0:v]{common}[a];[1:v]{common}[b];[a][b]hstack=shortest=1,format=yuv420p",
                    "-frames:v", str(end - start), "-r", str(FPS), "-an", "-c:v", "libx264", "-crf", "20",
                    "-movflags", "+faststart", str(out)], check=True, capture_output=True)


def synchronize(source: Path, generated: Path, comparison: Path, report: Path):
    source, generated, comparison, report = map(Path, (source, generated, comparison, report))
    if len({p.resolve() for p in (source, generated, comparison, report)}) != 4:
        raise ValueError("Comparison outputs must not overwrite their input files")
    with _lock:
        signatures = [_signature(source), _signature(generated)]
        try:
            old = json.loads(report.read_text())
            if old.get("version") == VERSION and old.get("inputs") == signatures and comparison.is_file():
                return old
        except (OSError, ValueError):
            pass
        comparison.parent.mkdir(parents=True, exist_ok=True)
        report.parent.mkdir(parents=True, exist_ok=True)
        duration, _, _ = _probe(source)
        frames = max(1, round(duration * FPS))
        duration = frames / FPS
        metrics, reason, method = {}, None, "pose-dtw"
        start, end = 0, frames
        with tempfile.TemporaryDirectory(prefix="sync-", dir=comparison.parent) as temp:
            temp = Path(temp)
            aligned = temp / "aligned.mp4"
            try:
                left = pose_features(_measure(source, report.with_suffix(".source-poses.json")))
                right = pose_features(_measure(generated, report.with_suffix(".generated-poses.json")))
                if left["direction"] != right["direction"] and min(left["progress"][-1], right["progress"][-1]) > 90:
                    raise ValueError("Generated turn reverses direction; timing alone cannot repair it")
                mapping, metrics, improved = align_features(left, right)
                if not improved:
                    raise ValueError("Pose retiming did not improve on the original timing")
                generated_times = np.interp(mapping, np.arange(len(right["time"])), right["time"])
                wanted = np.interp(np.arange(frames) / FPS, left["time"], generated_times)
                indices = np.searchsorted(right["time"], wanted)
                indices = np.clip(indices, 0, len(right["time"]) - 1)
                previous = np.maximum(indices - 1, 0)
                indices = np.where(abs(right["time"][previous] - wanted) <= abs(right["time"][indices] - wanted), previous, indices)
                source_orientation = np.stack([np.interp(np.arange(frames) / FPS, left["time"], left["orientation"][:, k]) for k in (0, 1)], axis=1)
                source_orientation /= np.maximum(np.linalg.norm(source_orientation, axis=1)[:, None], 1e-6)
                errors = np.degrees(np.arccos(np.clip((source_orientation * right["orientation"][indices]).sum(axis=1), -1, 1)))
                start, end = shared_interval(errors)
                metrics["compared_median_angle_error_deg"] = round(float(np.median(errors[start:end])), 2)
                metrics["compared_p90_angle_error_deg"] = round(float(np.percentile(errors[start:end], 90)), 2)
                _encode_retimed(generated, indices, aligned)
                metrics["max_time_shift_seconds"] = round(float(np.max(abs(wanted - np.arange(frames) / FPS))), 3)
            except (ValueError, SystemExit) as error:
                # A missing/ambiguous person must never be presented as a successful pose match.
                method, reason = "timing-only", str(error)
                start, end = 0, frames
                _normalize(generated, aligned, duration, frames)
            output = temp / "compare.mp4"
            _comparison(source, aligned, output, start, end)
            encoded, _, _ = _probe(output)
            if abs(encoded - (end - start) / FPS) > 1 / FPS + 1e-4:
                raise ValueError("Synchronized comparison has an unexpected duration")
            output.replace(comparison)
        result = {"version": VERSION, "inputs": signatures, "method": method, "reason": reason,
                  "fps": FPS, "frames": end - start, "duration": (end - start) / FPS,
                  "source_duration": duration, "source_start": start / FPS, "source_end": end / FPS,
                  "excluded_head_seconds": start / FPS, "excluded_tail_seconds": (frames - end) / FPS, **metrics}
        _write_json(report, result)
        return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs-dir", required=True, type=Path)
    args = parser.parse_args()
    for generated in sorted(args.runs_dir.glob("*/omni/omni.mp4")):
        source = generated.with_name("source.mp4")
        if source.is_file():
            result = synchronize(source, generated, generated.with_name("compare.mp4"), generated.with_name("sync.json"))
            print(json.dumps({"run": generated.parent.parent.name, **result}), flush=True)
