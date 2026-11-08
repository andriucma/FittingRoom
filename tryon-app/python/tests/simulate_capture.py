"""Offline QA for the in-browser capture logic (src/lib/capture/pose.ts + CaptureFlow thresholds).

Runs the SAME MediaPipe Pose Landmarker "lite" model the browser uses over a video file and replays the
UI state machine (framing -> facing -> countdown -> recording -> auto-stop), printing what the user would see.
Keep the constants/functions below in sync with pose.ts / CaptureFlow.tsx.

  python/.venv/bin/python python/tests/simulate_capture.py <video>
"""
from __future__ import annotations

import math
import subprocess
import sys
import urllib.request
from pathlib import Path

import mediapipe as mp
import numpy as np

MODEL = Path(__file__).resolve().parents[1] / "models" / "pose_landmarker_lite.task"
URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
NOSE, LSH, RSH, LHIP, RHIP, LKNEE, RKNEE, LANK, RANK = 0, 11, 12, 23, 24, 25, 26, 27, 28
import os
HOLD_FRAMING_MS, HOLD_FACING_MS = 1200, 800
COUNTDOWN_MS = int(os.environ.get("COUNTDOWN_MS", 2700))  # 0 = person stands still through the countdown
DONE_DEG, DONE_DEG_FACING, MAX_RECORD_MS = 340, 330, 30_000


def vis(p, t=0.5):
    return p is not None and (p.visibility if p.visibility is not None else 1) >= t


def check_framing(l):
    if not l:
        return False, "Step into the frame"
    nose, sh = l[NOSE], [l[LSH], l[RSH]]
    ankles = [p for p in (l[LANK], l[RANK]) if vis(p, 0.3)]
    knees = [p for p in (l[LKNEE], l[RKNEE]) if vis(p, 0.4)]
    if not vis(nose, 0.3) or not all(vis(p, 0.3) for p in sh):
        return False, "Face the camera so we can see you"
    shoulder_y = (sh[0].y + sh[1].y) / 2
    head_top = nose.y - (shoulder_y - nose.y) * 0.9
    if head_top < 0.01:
        return False, "Step back — your head is cut off"
    if not knees:
        return False, "Step back — we can't see your legs"
    if not ankles or any(a.y > 1.01 for a in ankles):
        return False, "Step back — we can't see your feet"
    body = max(a.y for a in ankles) + 0.025 - head_top
    if body < 0.5:
        return False, "Come a little closer"
    if body > 1.0:
        return False, "Step back a little"
    cx = (l[LHIP].x + l[RHIP].x) / 2
    if cx < 0.3 or cx > 0.7:
        return False, "Move to the center of the frame"
    if not all(0.02 <= p.x <= 0.98 and 0.02 <= p.y <= 0.98 for p in sh):
        return False, "Keep your whole body inside the frame"
    return True, "Perfect — hold still"


def facing_camera(l):
    if not l:
        return False
    lsh, rsh = l[LSH], l[RSH]
    width = lsh.x - rsh.x
    torso = abs((l[LHIP].y + l[RHIP].y) / 2 - (lsh.y + rsh.y) / 2)
    return vis(l[NOSE], 0.6) and width > 0 and width > torso * 0.55


def body_yaw(w):
    if not w:
        return None
    vx = w[LSH].x - w[RSH].x + w[LHIP].x - w[RHIP].x
    vz = w[LSH].z - w[RSH].z + w[LHIP].z - w[RHIP].z
    if math.hypot(vx, vz) < 0.05:
        return None
    return math.degrees(math.atan2(vz, vx))


def wrap180(a):
    return ((a + 180) % 360 + 360) % 360 - 180


class TurnTracker:
    def __init__(self):
        self.prev = self.smooth = None
        self.total = self.max = 0.0

    def update(self, yaw):
        if yaw is None:
            return self.max
        self.smooth = yaw if self.smooth is None else self.smooth + wrap180(yaw - self.smooth) * 0.5
        if self.prev is not None:
            d = wrap180(self.smooth - self.prev)
            if abs(d) < 45:
                self.total += d
        self.prev = self.smooth
        self.max = max(self.max, abs(self.total))
        return self.max


def frames(video: Path, w=540, h=960):
    cmd = ["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"scale={w}:{h},fps=30", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = w * h * 3
    while (buf := p.stdout.read(n)) and len(buf) == n:
        yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)


def main():
    video = Path(sys.argv[1])
    if not MODEL.exists():
        urllib.request.urlretrieve(URL, MODEL)
    opts = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO, num_poses=1)
    stage, since, rec_start, tracker, last_msg, chimes = "framing", None, None, TurnTracker(), None, 0
    with mp.tasks.vision.PoseLandmarker.create_from_options(opts) as pose:
        for i, img in enumerate(frames(video)):
            t = i * 1000 / 30
            res = pose.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=img), int(t))
            l = res.pose_landmarks[0] if res.pose_landmarks else None
            w = res.pose_world_landmarks[0] if res.pose_world_landmarks else None
            msg = None
            if stage == "framing":
                ok, msg = check_framing(l)
                since = (since or t) if ok else None
                if ok and t - since > HOLD_FRAMING_MS:
                    stage, since = "facing", None
            elif stage == "facing":
                ok, m = check_framing(l)
                f = ok and facing_camera(l)
                msg = m if not ok else ("Great — hold still…" if f else "Face the camera")
                since = (since or t) if f else None
                if f and t - since > HOLD_FACING_MS:
                    stage, since = "countdown", t
            elif stage == "countdown":
                msg = "3-2-1 (video keeps playing here; the browser test mode pauses it)"
                if t - since > COUNTDOWN_MS:
                    stage, rec_start = "recording", t
            elif stage == "recording":
                deg = tracker.update(body_yaw(w))
                seg = int(deg // 30)
                if seg > chimes:
                    chimes = seg
                    print(f"  {t/1000:5.2f}s  chime: angle {seg * 30}° captured")
                msg = f"turned {deg:5.1f}°"
                if deg >= DONE_DEG or (deg >= DONE_DEG_FACING and facing_camera(l)) or t - rec_start > MAX_RECORD_MS:
                    print(f"  {t/1000:5.2f}s  AUTO-STOP after {deg:.0f}° ({(t - rec_start)/1000:.1f}s recording)")
                    return
            if msg != last_msg and stage != "recording":
                print(f"  {t/1000:5.2f}s  [{stage}] {msg}")
                last_msg = msg
    print(f"video ended in stage {stage}; turned {tracker.max:.0f}° (no auto-stop)")


if __name__ == "__main__":
    main()
