/**
 * In-browser pose analysis for guided capture (MediaPipe Pose Landmarker "lite", self-hosted in /public/mediapipe).
 * All coordinates here are in the 9:16 CENTER CROP of the camera frame, which is exactly what the server
 * keeps (see normalizePortrait), so "in frame" means "in the final video".
 */
import type { NormalizedLandmark, PoseLandmarker, PoseLandmarkerResult } from "@mediapipe/tasks-vision";

export const L = {
  nose: 0, lShoulder: 11, rShoulder: 12, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
} as const;

export const SKELETON: [number, number][] = [
  [11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32],
];

export async function createPoseLandmarker(): Promise<PoseLandmarker> {
  const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const make = (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/mediapipe/pose_landmarker_lite.task", delegate },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await make("GPU");
  } catch {
    try {
      return await make("CPU");
    } catch (cause) {
      throw new Error("Body tracking couldn’t load. Refresh the page and try again. If it keeps happening, the camera model files may need to be restored.", { cause });
    }
  }
}

/** Map full-frame normalized landmarks into the centered 9:16 crop. */
export function toCrop(lms: NormalizedLandmark[], videoW: number, videoH: number): NormalizedLandmark[] {
  const target = 9 / 16;
  const ar = videoW / videoH;
  if (ar > target) {
    const cw = videoH * target;
    const off = (videoW - cw) / 2;
    return lms.map((p) => ({ ...p, x: (p.x * videoW - off) / cw }));
  }
  const ch = videoW / target;
  const off = (videoH - ch) / 2;
  return lms.map((p) => ({ ...p, y: (p.y * videoH - off) / ch }));
}

export type FrameCheck = { ok: boolean; message: string; bodyHeight?: number };

const vis = (p?: NormalizedLandmark, t = 0.5) => !!p && (p.visibility ?? 1) >= t;
const inside = (p: NormalizedLandmark, m = 0) => p.x >= m && p.x <= 1 - m && p.y >= m && p.y <= 1 - m;

/** Is the person (head to toe, or nearly) inside the 9:16 frame at a usable size? */
export function checkFraming(lms: NormalizedLandmark[] | undefined): FrameCheck {
  if (!lms?.length) return { ok: false, message: "Step into the frame" };
  const nose = lms[L.nose];
  const sh = [lms[L.lShoulder], lms[L.rShoulder]];
  const ankles = [lms[L.lAnkle], lms[L.rAnkle]].filter((p) => vis(p, 0.3));
  const knees = [lms[L.lKnee], lms[L.rKnee]].filter((p) => vis(p, 0.4));
  if (!vis(nose, 0.3) || !sh.every((p) => vis(p, 0.3))) return { ok: false, message: "Face the camera so we can see you" };
  const shoulderY = (sh[0].y + sh[1].y) / 2;
  const headTop = nose.y - (shoulderY - nose.y) * 0.9;
  if (headTop < 0.01) return { ok: false, message: "Step back — your head is cut off" };
  if (!knees.length) return { ok: false, message: "Step back — we can't see your legs" };
  // "almost fully visible": ankles may sit right at the bottom edge, but must be in frame
  if (!ankles.length || ankles.some((a) => a.y > 1.01)) return { ok: false, message: "Step back — we can't see your feet" };
  const feet = Math.max(...ankles.map((a) => a.y)) + 0.025;
  const bodyHeight = feet - headTop;
  if (bodyHeight < 0.5) return { ok: false, message: "Come a little closer", bodyHeight };
  if (bodyHeight > 1.0) return { ok: false, message: "Step back a little", bodyHeight };
  const cx = (lms[L.lHip].x + lms[L.rHip].x) / 2;
  if (cx < 0.3 || cx > 0.7) return { ok: false, message: "Move to the center of the frame", bodyHeight };
  if (!sh.every((p) => inside(p, 0.02))) return { ok: false, message: "Keep your whole body inside the frame", bodyHeight };
  return { ok: true, message: "Perfect — hold still", bodyHeight };
}

/** Facing the camera: the person's left shoulder appears on the RIGHT of the raw (unmirrored) image. */
export function facingCamera(lms: NormalizedLandmark[] | undefined): boolean {
  if (!lms?.length) return false;
  const l = lms[L.lShoulder];
  const r = lms[L.rShoulder];
  const width = l.x - r.x;
  const torso = Math.abs((lms[L.lHip].y + lms[L.rHip].y) / 2 - (l.y + r.y) / 2);
  return vis(lms[L.nose], 0.6) && width > 0 && width > torso * 0.55;
}

/**
 * Body yaw (degrees) from 3D world landmarks: direction of the left-minus-right shoulder + hip vectors
 * in the ground plane. Only differences between frames are used, so the zero point doesn't matter.
 */
export function bodyYaw(res: PoseLandmarkerResult): number | null {
  const w = res.worldLandmarks?.[0];
  if (!w?.length) return null;
  const vx = w[L.lShoulder].x - w[L.rShoulder].x + w[L.lHip].x - w[L.rHip].x;
  const vz = w[L.lShoulder].z - w[L.rShoulder].z + w[L.lHip].z - w[L.rHip].z;
  if (Math.hypot(vx, vz) < 0.05) return null;
  return (Math.atan2(vz, vx) * 180) / Math.PI;
}

export const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Accumulates rotation from noisy per-frame yaw; ignores implausible jumps (left/right label swaps). */
export class TurnTracker {
  private prev: number | null = null;
  private smooth: number | null = null;
  total = 0;   // signed degrees turned since start
  max = 0;     // furthest |total| reached (monotonic, for the UI)

  update(yaw: number | null): number {
    if (yaw === null) return this.max;
    this.smooth = this.smooth === null ? yaw : this.smooth + wrap180(yaw - this.smooth) * 0.5;
    if (this.prev !== null) {
      const d = wrap180(this.smooth - this.prev);
      if (Math.abs(d) < 45) this.total += d;   // bigger single-frame jumps are tracking glitches; re-baseline
    }
    this.prev = this.smooth;
    this.max = Math.max(this.max, Math.abs(this.total));
    return this.max;
  }
}
