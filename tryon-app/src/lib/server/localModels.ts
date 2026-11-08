import "server-only";
import { config } from "./config";

/** Client for the Python local-models service (MediaPipe Pose, SAM 3). */

export type AnglePick = {
  index: number;
  target_deg: number;
  est_deg: number;
  video_frame: number;
  t: number;
  confidence: number;
  file: string;
};

export type AnglesResult = {
  video: string;
  fps: number;
  n_frames: number;
  step_deg: number;
  direction: "left" | "right";
  total_rotation_deg: number;
  still_lead_in_frames: number;
  missing_targets_deg: number[];
  selected: AnglePick[];
  track: { t: number; angle_deg: number; confidence: number }[];
  seconds: number;
};

export type FramingResult = {
  target: string;
  outputs: string[];
  frames: { file: string; scale: number }[];
  spread_pct: Record<"top" | "bottom" | "height" | "cx", { before: number; after: number }>;
  seconds: number;
};

async function post<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${config.localModelsUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!res.ok) throw new Error(`local-models ${route} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export const localModels = {
  async health(): Promise<{ ok: boolean; sam3_loaded?: boolean; error?: string }> {
    try {
      const r = await fetch(`${config.localModelsUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return (await r.json()) as { ok: boolean; sam3_loaded: boolean };
    } catch (e) {
      return { ok: false, error: `unreachable at ${config.localModelsUrl}: ${(e as Error).message}` };
    }
  },
  extractAngles: (video: string, outDir: string, stepDeg: number) =>
    post<AnglesResult>("/angles/extract", { video, out_dir: outDir, step_deg: stepDeg }),
  normalizeFraming: (frames: string[], outDir: string, target: "median" | "max" | "source" = "median", sources?: string[]) =>
    post<FramingResult>("/framing/normalize", { frames, out_dir: outDir, target, sources }),
  segment: (image: string, prompt: string, out: string) =>
    post<{ found: boolean; score?: number; mask?: string; bbox?: number[] }>("/segment", { image, prompt, out }),
};
