#!/usr/bin/env python3
"""Angle-based frame extraction for 360-degree try-on spin videos.

Instead of sampling every N ms (scripts/extract_frames.sh), this estimates the
person's body yaw (rotation about the vertical axis) in every video frame with
Google MediaPipe Pose Landmarker (+ Face Landmarker on a head crop for
front/back disambiguation), builds a smooth monotonic 0->360 angle track, and
picks one snapshot per fixed angle step. Result is independent of spin speed,
and the "standing still" lead-in collapses to a single 0-degree frame.

Run (needs the .venv-pose env, see below):
    .venv-pose/bin/python scripts/extract_frames_by_angle.py IMG_8204.mov --step-deg 30
Re-pick with another step without re-running the models (~1 s):
    .venv-pose/bin/python scripts/extract_frames_by_angle.py IMG_8204.mov --step-deg 45 --reuse-analysis

Env setup (MediaPipe has no wheels for Python 3.14, so a separate 3.12 env):
    /opt/homebrew/bin/python3.12 -m venv .venv-pose
    .venv-pose/bin/pip install mediapipe matplotlib pillow numpy
Models are downloaded to models/ on first run.

Outputs (in --out, default work/frames_deg/):
    frame_000_deg000.jpg ...   selected frames, 864x1536, named by index + nominal angle
    angles.json                per-video-frame angle/confidence + selection
    contact_sheet.jpg          selected frames labeled with angles   (unless --no-viz)
    angle_plot.png             angle vs. time with selections marked (unless --no-viz)

How the angle is estimated
--------------------------
1. Pose Landmarker (heavy, VIDEO mode) gives 3D *world* landmarks. Body yaw is
   the direction of the left-minus-right vector in the horizontal (x,z) plane,
   averaging the shoulder and hip vectors (they have opposite depth biases, so
   averaging cancels most of it). Because it's a full 3D direction (atan2), it
   is NOT the symmetric |cos| you get from 2D shoulder width -- *if* the model
   labels left/right correctly.
2. The pose model's classic mistakes are mirror errors: a left/right label
   swap (back view read as a front view, +180 deg) and a depth flip (wrong
   shoulder nearer the camera, yaw -> -yaw). Each frame gets 4 hypotheses
   {y, y+180, -y, 180-y}; a Viterbi pass picks the sequence that (a) moves
   smoothly frame-to-frame, (b) doesn't reverse against the spin direction
   (both directions are tried, the cheaper one wins), (c) agrees with the face
   cue: Face Landmarker on an upscaled head crop finds a face only in the
   front hemisphere, and its head yaw must roughly agree with body yaw. (The
   "no face => facing away" half of the cue is disabled if the face model
   barely fires on the video at all.)
3. The chosen track is unwrapped, despiked (median) and smoothed (Gaussian),
   the rotation direction is detected from the net change and flipped so the
   angle increases, then a confidence-weighted isotonic regression makes it
   monotonic (a spin never goes backwards; jitter does). 0 degrees = the
   starting pose (the still lead-in is one flat block of the monotonic track).
4. Targets 0, step, 2*step, ... up to min(total spin, 360 - step/2) (so >360
   spins don't duplicate the front). Each target takes the closest frame
   within +-step/3, ties broken toward low angular speed (less motion blur)
   and high confidence. Targets with no frame in tolerance (spin < 360) are
   reported as missing rather than faked.
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "models"
MODEL_URLS = {
    "pose_heavy": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
    "pose_full": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
    "face": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
}
# MediaPipe pose landmark indices
NOSE, L_SH, R_SH, L_HIP, R_HIP = 0, 11, 12, 23, 24


def model_path(key: str) -> Path:
    p = MODEL_DIR / Path(MODEL_URLS[key]).name
    if not p.exists():
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        print(f"downloading {p.name} ...", file=sys.stderr)
        urllib.request.urlretrieve(MODEL_URLS[key], p)
    return p


def wrap180(a):
    return (np.asarray(a) + 180.0) % 360.0 - 180.0


def probe_times(video: Path) -> list[float]:
    """Presentation timestamps of every video frame (phone videos are often VFR)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "frame=best_effort_timestamp_time", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True).stdout
    ts = []
    for line in out.splitlines():
        f = line.split(",")[0].strip()
        try:
            ts.append(float(f))
        except ValueError:
            pass
    return [t - ts[0] for t in ts] if ts else []


# --------------------------------------------------------------------------- #
# 1. per-frame measurements
# --------------------------------------------------------------------------- #
def analyze(video: Path, w: int, h: int, pose_model: str):
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    times = probe_times(video)
    fps = (len(times) - 1) / times[-1] if len(times) > 1 and times[-1] > 0 else 30.0
    pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path(pose_model))),
        running_mode=vision.RunningMode.VIDEO))
    face = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path("face"))),
        output_facial_transformation_matrixes=True,
        min_face_detection_confidence=0.3, min_face_presence_confidence=0.3))

    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"scale={w}:{h}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    recs, i, nbytes = [], 0, w * h * 3
    while True:
        buf = proc.stdout.read(nbytes)
        if len(buf) < nbytes:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        t = times[i] if i < len(times) else i / fps
        rec = {"i": i, "t": t, "pose": False, "face": False}
        r = pose.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=frame),
                                  int(round(t * 1000)))
        if r.pose_landmarks:
            lm = np.array([[p.x, p.y, p.presence] for p in r.pose_landmarks[0]])
            wl = np.array([[p.x, p.y, p.z] for p in r.pose_world_landmarks[0]])
            sh = wl[L_SH] - wl[R_SH]
            hp = wl[L_HIP] - wl[R_HIP]
            ysh = math.degrees(math.atan2(sh[2], sh[0]))
            yhp = math.degrees(math.atan2(hp[2], hp[0]))
            v = sh[[0, 2]] / np.linalg.norm(sh[[0, 2]]) + hp[[0, 2]] / np.linalg.norm(hp[[0, 2]])
            rec.update(pose=True, yaw_sh=ysh, yaw_hip=yhp,
                       yaw_raw=math.degrees(math.atan2(v[1], v[0])),
                       agree=float(np.linalg.norm(v) / 2),  # 1 = shoulders & hips agree
                       presence=float(lm[[L_SH, R_SH, L_HIP, R_HIP], 2].min()))
            # 2D shoulder width / torso length (signed: <0 means L is left of R in image)
            P = lm[:, :2] * [w, h]
            torso = np.linalg.norm((P[L_SH] + P[R_SH]) / 2 - (P[L_HIP] + P[R_HIP]) / 2)
            rec["sw2d"] = float((P[L_SH, 0] - P[R_SH, 0]) / max(torso, 1e-6))
            # head crop -> face landmarker (face only visible in front hemisphere)
            c = P[0:11].mean(0)
            half = int(0.45 * torso)
            x0, y0 = int(c[0]) - half, int(c[1]) - half
            crop = frame[max(0, y0):max(0, y0 + 2 * half), max(0, x0):max(0, x0 + 2 * half)]
            if half > 8 and crop.shape[0] > 16 and crop.shape[1] > 16:
                crop = np.ascontiguousarray(cv2.resize(crop, (384, 384)))
                fr = face.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop))
                if fr.face_landmarks:
                    R = np.array(fr.facial_transformation_matrixes[0])[:3, :3]
                    rec["face"] = True
                    rec["face_yaw"] = math.degrees(math.atan2(-R[2, 0], math.hypot(R[0, 0], R[1, 0])))
        recs.append(rec)
        i += 1
    proc.wait()
    return recs, fps


# --------------------------------------------------------------------------- #
# 2. front/back + depth disambiguation (Viterbi over 4 mirror hypotheses)
# --------------------------------------------------------------------------- #
# For a measured yaw y, the pose model's two classic mistakes give 4 candidates:
#   0: y          (correct)
#   1: y + 180    (left/right labels swapped, e.g. back view read as a front view)
#   2: -y         (depth flip: which shoulder is nearer the camera is wrong)
#   3: 180 - y    (both)
HYP_NAMES = ["ok", "lr_swap", "depth_flip", "lr_swap+depth_flip"]
HYP_PRIOR = np.array([0.0, 1.0, 1.0, 1.5])


def hypotheses(y):
    return np.stack([y, wrap180(y + 180), wrap180(-y), wrap180(180 - y)], -1)


def viterbi(hyp, gaps, emis, direction=0.0, sigma=20.0, sigma_back=6.0):
    """hyp/emis: (n,K). Transition cost penalises big per-frame jumps and (if a
    spin direction is known) motion against it -- a spin doesn't reverse."""
    n, K = hyp.shape
    cost = emis[0].copy()
    back = np.zeros((n, K), int)
    for k in range(1, n):
        d = wrap180(hyp[k][:, None] - hyp[k - 1][None, :])  # (to, from)
        trans = np.minimum((np.abs(d) / (sigma * gaps[k])) ** 2, 50)
        if direction:
            trans += np.minimum((np.maximum(0, -direction * d) / (sigma_back * gaps[k])) ** 2, 50)
        tot = cost[None, :] + trans
        back[k] = np.argmin(tot, 1)
        cost = tot[np.arange(K), back[k]] + emis[k]
    st = np.zeros(n, int)
    st[-1] = int(np.argmin(cost))
    for k in range(n - 1, 0, -1):
        st[k - 1] = back[k, st[k]]
    return st, float(cost.min())


def resolve_front_back(recs):
    n = len(recs)
    has = np.array([r["pose"] for r in recs])
    raw = np.array([r.get("yaw_raw", np.nan) for r in recs])
    face = np.array([r["face"] for r in recs])
    fyaw = np.array([r.get("face_yaw", np.nan) if r.get("face_yaw") is not None else np.nan for r in recs])
    # face-yaw sign convention vs body yaw: fit it from frames that are clearly frontal
    m = face & has & (np.abs(wrap180(raw)) < 80)
    fsign = 1.0 if m.sum() < 5 or np.nansum(fyaw[m] * wrap180(raw[m])) >= 0 else -1.0

    idx = np.flatnonzero(has)
    if len(idx) == 0:
        raise SystemExit("no person detected in any frame")
    hyp = hypotheses(raw[idx])
    a = np.abs(hyp)
    f = face[idx][:, None]
    fy = (fsign * fyaw[idx])[:, None]
    # face found -> front hemisphere, and head yaw ~ body yaw (head may lead/lag ~30 deg)
    e_face = 4.0 * np.maximum(0, a - 100) / 80 + np.where(
        np.isnan(fy), 0.0, 1.5 * np.minimum(np.abs(wrap180(hyp - np.nan_to_num(fy))), 120) / 60)
    # no face while supposedly facing the camera -> suspicious (soft: blur/small faces happen)
    e_noface = 2.0 * np.maximum(0, 50 - a) / 50
    # only trust "no face => not facing camera" if the face model demonstrably works on
    # this video (tiny/blurry faces => it never fires, and the cue would be pure noise)
    if face[idx].mean() < 0.15:
        e_noface = np.zeros_like(e_noface)
    emis = np.where(f, e_face, e_noface) + HYP_PRIOR[None, :]
    gaps = np.diff(idx, prepend=idx[0]).clip(1)
    # spin direction: whichever no-reversal prior explains the data more cheaply
    (st_p, c_p), (st_n, c_n) = (viterbi(hyp, gaps, emis, d) for d in (1.0, -1.0))
    st = st_p if c_p <= c_n else st_n
    yaw = np.full(n, np.nan)
    yaw[idx] = hyp[np.arange(len(idx)), st]
    state = np.full(n, -1)
    state[idx] = st
    return yaw, state, fsign


# --------------------------------------------------------------------------- #
# 3. unwrap, smooth, orient, monotonic
# --------------------------------------------------------------------------- #
def median_filter(x, k):
    p = k // 2
    xp = np.pad(x, p, mode="edge")
    return np.array([np.median(xp[i:i + k]) for i in range(len(x))])


def gaussian_smooth(x, sigma):
    r = int(3 * sigma)
    kern = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    kern /= kern.sum()
    return np.convolve(np.pad(x, r, mode="edge"), kern, mode="valid")


def isotonic_increasing(y, w):
    """Weighted pool-adjacent-violators: closest non-decreasing fit."""
    blocks = []  # [mean, weight, count]
    for yi, wi in zip(y, w):
        blocks.append([yi, wi, 1])
        while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
            m2, w2, c2 = blocks.pop()
            m1, w1, c1 = blocks.pop()
            ww = w1 + w2
            blocks.append([(m1 * w1 + m2 * w2) / ww, ww, c1 + c2])
    return np.concatenate([[m] * c for m, _, c in blocks])


def build_track(recs, yaw):
    n = len(yaw)
    t = np.arange(n)
    ok = ~np.isnan(yaw)
    un = np.full(n, np.nan)
    un[ok] = np.degrees(np.unwrap(np.radians(yaw[ok])))
    un = np.interp(t, t[ok], un[ok])  # fill frames with no detection
    despiked = median_filter(un, 5)
    smooth = gaussian_smooth(despiked, 2.0)
    direction = 1.0 if smooth[-1] - smooth[0] >= 0 else -1.0
    oriented = direction * smooth
    resid = np.abs(direction * un - oriented)
    presence = np.array([r.get("presence", 0.0) for r in recs])
    agree = np.array([r.get("agree", 0.0) for r in recs])
    conf = ok * presence * np.clip((agree - 0.5) / 0.45, 0, 1) * np.exp(-(resid / 20.0) ** 2)
    mono = isotonic_increasing(oriented, np.maximum(conf, 0.05))
    zero = mono[0]
    return (direction * un - zero), (oriented - zero), (mono - zero), conf, direction


# --------------------------------------------------------------------------- #
# 4. selection
# --------------------------------------------------------------------------- #
def select(mono, smooth, conf, step):
    span = float(mono[-1])
    speed = np.abs(np.gradient(smooth))  # deg/frame, proxy for motion blur
    tol = step / 3.0
    last = min(span + tol, 360.0 - step / 2.0)
    picks, missing = [], []
    k = 0
    while k * step <= last + 1e-9:
        target = k * step
        d = np.abs(mono - target)
        cand = np.flatnonzero(d <= tol)
        if len(cand) == 0:
            missing.append(target)
        else:
            # mono is flat on still segments -> break ties with the smoothed angle,
            # speed (blur) and confidence
            score = d[cand] + 0.5 * np.abs(smooth[cand] - target) + 1.0 * speed[cand] + 5.0 * (1 - conf[cand])
            picks.append((target, int(cand[np.argmin(score)])))
        k += 1
    return picks, missing, span


# --------------------------------------------------------------------------- #
# 5. output + verification artifacts
# --------------------------------------------------------------------------- #
def write_frames(video, out, picks, w, h):
    expr = "+".join(f"eq(n\\,{fi})" for _, fi in picks)
    tmp = out / "_tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vf",
                    f"select='{expr}',scale={w}:{h}", "-fps_mode", "passthrough",
                    "-q:v", "2", str(tmp / "%03d.jpg")], check=True)
    got = sorted(tmp.glob("*.jpg"))
    if len(got) != len(picks):
        raise SystemExit(f"ffmpeg wrote {len(got)} frames, expected {len(picks)}")
    names = []
    for (k, (target, _)), src in zip(enumerate(picks), got):
        name = f"frame_{k:03d}_deg{int(round(target)):03d}.jpg"
        src.rename(out / name)
        names.append(name)
    tmp.rmdir()
    return names


def contact_sheet(out, names, picks, mono, ts, path):
    from PIL import Image, ImageDraw, ImageFont
    tw, th = 216, 384
    cols = min(6, len(names))
    rows = math.ceil(len(names) / cols)
    sheet = Image.new("RGB", (cols * tw, rows * (th + 44)), "white")
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 17)
    except OSError:
        font = ImageFont.load_default()
    d = ImageDraw.Draw(sheet)
    for k, (name, (target, fi)) in enumerate(zip(names, picks)):
        x, y = (k % cols) * tw, (k // cols) * (th + 44)
        sheet.paste(Image.open(out / name).resize((tw, th)), (x, y))
        d.text((x + 6, y + th + 2), f"#{k} target {target:.0f}°", fill="black", font=font)
        d.text((x + 6, y + th + 22), f"est {mono[fi]:.0f}°  f{fi} t={ts[fi]:.2f}s", fill="#555", font=font)
    sheet.save(path, quality=90)


def check_2d(recs, mono):
    """Independent sanity check: signed 2D shoulder width / torso length ~ cos(yaw).
    Only gives |yaw| (front/back symmetric), so map it onto the branch nearest the track."""
    sw = np.array([r.get("sw2d", np.nan) if r.get("sw2d") is not None else np.nan for r in recs])
    if np.all(np.isnan(sw)):
        return sw
    sw0 = np.nanpercentile(np.abs(sw), 95)
    base = np.degrees(np.arccos(np.clip(sw / sw0, -1, 1)))
    cands = np.stack([base + 360 * k for k in (-1, 0, 1)] + [360 * k - base for k in (0, 1, 2)], 1)
    return cands[np.arange(len(sw)), np.nanargmin(np.abs(cands - mono[:, None]), 1)]


def plot(recs, ts, raw, smooth, mono, conf, picks, step, state, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    t = ts
    face = np.array([r["face"] for r in recs])
    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(11, 8), sharex=True,
                                  gridspec_kw={"height_ratios": [3, 1]})
    for k in range(0, 361, int(step)):
        ax.axhline(k, color="#ddd", lw=0.8, zorder=0)
    ax.scatter(t, check_2d(recs, mono), s=12, marker="x", c="#bbb", lw=0.8,
               label="2D shoulder-width check (acos, independent)", zorder=1)
    ax.scatter(t[face], raw[face], s=10, c="#2a7", label="3D yaw per frame (face found)", zorder=2)
    ax.scatter(t[~face], raw[~face], s=10, c="#c63", label="3D yaw per frame (no face)", zorder=2)
    fixed = state > 0
    if fixed.any():
        ax.scatter(t[fixed], raw[fixed], s=40, facecolors="none", edgecolors="m",
                   label="mirror hypothesis corrected", zorder=3)
    ax.plot(t, smooth, c="#888", lw=1, label="smoothed")
    ax.plot(t, mono, c="#1f4e9c", lw=2, label="monotonic track")
    for target, fi in picks:
        ax.plot(t[fi], mono[fi], "o", ms=9, mfc="none", mec="k", mew=1.5, zorder=4)
        ax.annotate(f"{target:.0f}°", (t[fi], mono[fi]), xytext=(-24, 6),
                    textcoords="offset points", fontsize=8)
    ax.set_ylabel("body yaw (deg, 0 = start pose)")
    ax.set_yticks(range(0, 361, int(step) if step >= 30 else 30))
    ax.legend(loc="upper left", fontsize=8)
    ax.set_title(f"Estimated body yaw vs time  (step {step:g}°, {len(picks)} frames selected)")
    ax2.plot(t, conf, c="k", lw=1)
    ax2.set_ylabel("confidence")
    ax2.set_ylim(0, 1.05)
    ax2.set_xlabel("time (s)")
    for _, fi in picks:
        ax2.axvline(t[fi], c="#bbb", lw=0.7)
    fig.tight_layout()
    fig.savefig(path, dpi=110)


MEAS_KEYS = ["yaw_raw", "yaw_sh", "yaw_hip", "agree", "presence", "sw2d", "face_yaw"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("video", nargs="?", default=str(ROOT / "IMG_8204.mov"))
    ap.add_argument("--step-deg", type=float, default=30.0)
    ap.add_argument("--out", default=str(ROOT / "work" / "frames_deg"))
    ap.add_argument("--size", default="864x1536", help="output WxH (also used for analysis)")
    ap.add_argument("--pose-model", choices=["heavy", "full"], default="heavy")
    ap.add_argument("--reuse-analysis", nargs="?", const="", default=None, metavar="ANGLES_JSON",
                    help="reuse per-frame measurements from an earlier angles.json (default "
                         "<out>/angles.json) instead of re-running the models; fast way to try "
                         "another --step-deg")
    ap.add_argument("--no-viz", action="store_true", help="skip contact sheet + plot")
    a = ap.parse_args()
    video, out = Path(a.video).resolve(), Path(a.out).resolve()
    w, h = (int(v) for v in a.size.lower().split("x"))
    out.mkdir(parents=True, exist_ok=True)

    if a.reuse_analysis is not None:
        prev = json.loads(Path(a.reuse_analysis or out / "angles.json").read_text())
        if Path(prev["video"]) != video:
            raise SystemExit(f"angles.json is for {prev['video']}, not {video}")
        fps = prev["fps"]
        recs = [{"i": f["i"], "t": f["t"], "pose": f["pose"], "face": f["face"],
                 **{k: v for k, v in f["mp"].items() if v is not None}} for f in prev["frames"]]
    else:
        recs, fps = analyze(video, w, h, f"pose_{a.pose_model}")
    ts = np.array([r["t"] for r in recs])
    yaw, state, fsign = resolve_front_back(recs)
    raw, smooth, mono, conf, direction = build_track(recs, yaw)
    picks, missing, span = select(mono, smooth, conf, a.step_deg)
    for f in out.glob("frame_*.jpg"):
        f.unlink()
    names = write_frames(video, out, picks, w, h)

    sel = {fi: (k, target) for k, (target, fi) in enumerate(picks)}
    still = int(np.sum(mono < min(5.0, a.step_deg / 6)))
    n_fixed = {HYP_NAMES[k]: int((state == k).sum()) for k in range(1, len(HYP_NAMES))}
    chk = check_2d(recs, mono)
    meta = {
        "video": str(video), "fps": fps, "n_frames": len(recs), "step_deg": a.step_deg,
        "pose_model": a.pose_model,
        # MediaPipe world-coords yaw decreasing = person turns to their own right
        "direction": "turning to their right (clockwise seen from above)" if direction < 0
                     else "turning to their left (counter-clockwise seen from above)",
        "total_rotation_deg": round(span, 1),
        "still_lead_in_frames": still,
        "mirror_corrected_frames": n_fixed,
        "missing_targets_deg": missing,
        "selected": [{"index": k, "target_deg": target, "est_deg": round(float(mono[fi]), 1),
                      "check_2d_deg": None if np.isnan(chk[fi]) else round(float(chk[fi]), 1),
                      "video_frame": fi, "t": round(float(ts[fi]), 3), "confidence": round(float(conf[fi]), 3),
                      "file": name} for (k, (target, fi)), name in zip(enumerate(picks), names)],
        "frames": [{
            "i": r["i"], "t": round(r["t"], 3), "pose": r["pose"], "face": r["face"],
            "angle_deg": round(float(mono[r["i"]]), 2),          # monotonic track (used for selection)
            "angle_smooth_deg": round(float(smooth[r["i"]]), 2),
            "angle_raw_deg": round(float(raw[r["i"]]), 2),       # per-frame, after mirror fix
            "confidence": round(float(conf[r["i"]]), 3),
            "hypothesis": HYP_NAMES[state[r["i"]]] if state[r["i"]] >= 0 else None,
            "selected": r["i"] in sel,
            **({"selected_index": sel[r["i"]][0], "target_deg": sel[r["i"]][1]} if r["i"] in sel else {}),
            "mp": {k: (round(float(r[k]), 3) if k in r else None) for k in MEAS_KEYS},
        } for r in recs],
    }
    (out / "angles.json").write_text(json.dumps(meta, indent=1))
    if not a.no_viz:
        contact_sheet(out, names, picks, mono, ts, out / "contact_sheet.jpg")
        plot(recs, ts, raw, smooth, mono, conf, picks, a.step_deg, state, out / "angle_plot.png")
    print(f"{len(names)} frames -> {out}  (spin {span:.0f}°, {meta['direction']}, "
          f"still lead-in {still} frames, mirror fixes {n_fixed}"
          + (f", MISSING targets {missing}" if missing else "") + ")")
    for s in meta["selected"]:
        print(f"  {s['file']}  est {s['est_deg']:6.1f}°  2D-check {s['check_2d_deg']}°  "
              f"frame {s['video_frame']:3d}  t={s['t']:.2f}s  conf {s['confidence']:.2f}")


if __name__ == "__main__":
    main()
