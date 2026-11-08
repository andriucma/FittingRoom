import "server-only";
import { copyFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { normalizePortrait, webPreview } from "./ffmpeg";
import { localModels, type AnglesResult } from "./localModels";
import { ensureDir, fileUrl, isSafeId, newId, paths, readJson, writeJson } from "./storage";
import { shopperDepartment } from "./decisions";
import type { Department, ShopperProfile, VideoAsset, VideoCheck } from "@/lib/types";

const ALLOWED = new Set([".mov", ".mp4", ".m4v", ".webm"]);
const MIN_TURN_DEG = 320;

/** Folder where a video's angle analysis for a given step is cached (reused by runs). */
export const anglesDir = (id: string, stepDeg: number) => path.join(paths.videos, id, `angles-${stepDeg}`);

export async function cachedAngles(id: string, stepDeg: number): Promise<AnglesResult | null> {
  return readJson<AnglesResult>(path.join(anglesDir(id, stepDeg), "angles.json"));
}

/**
 * Server-side check of a recording with the Python pose model: did the person complete a full turn,
 * and do we get every angle? The analysis is cached and reused by try-on runs.
 */
export async function verifyVideo(id: string, stepDeg = 30): Promise<VideoCheck> {
  const video = await getVideo(id);
  if (!video) throw new Error("video not found");
  const t0 = Date.now();
  const a = await cachedAngles(id, stepDeg) ?? await localModels.extractAngles(video.file, anglesDir(id, stepDeg), stepDeg);
  const issues: string[] = [];
  if (a.total_rotation_deg < MIN_TURN_DEG) {
    issues.push(`You turned about ${Math.round(a.total_rotation_deg)}°; we need a full turn (at least ${MIN_TURN_DEG}°). Keep turning until you face the camera again.`);
  }
  if (a.missing_targets_deg.length) issues.push(`Missing angles: ${a.missing_targets_deg.join("°, ")}°. Turn more slowly and keep your whole body in frame.`);
  const lowConf = a.selected.filter((s) => s.confidence < 0.5).length;
  if (lowConf) issues.push(`${lowConf} angle(s) had low pose confidence; check the lighting and that your whole body is visible.`);
  const check: VideoCheck = {
    ok: issues.length === 0, rotationDeg: a.total_rotation_deg, direction: a.direction, frames: a.selected.length,
    stillLeadInFrames: a.still_lead_in_frames, issues, seconds: (Date.now() - t0) / 1000,
    contactSheet: fileUrl(path.join(anglesDir(id, stepDeg), "contact_sheet.jpg")),
  };
  await writeJson(path.join(paths.videos, id, "check.json"), check);
  // Default catalog department from the front (0°) frame; best effort, never blocks verification.
  const front = a.selected.find((s) => s.target_deg === 0)?.file ?? a.selected[0]?.file;
  if (front && !video.profile) await detectProfile(id, front).catch(() => null);
  return check;
}

/** Which department (men's / women's / all) to show by default, from the shopper's front frame. */
export async function detectProfile(id: string, frontFrame: string): Promise<ShopperProfile> {
  const d = await shopperDepartment(frontFrame);
  const profile: ShopperProfile = { department: d.department, confidence: d.confidence, source: "auto" };
  await writeJson(path.join(paths.videos, id, "profile.json"), profile);
  return profile;
}

export async function setProfile(id: string, department: Department): Promise<ShopperProfile> {
  const profile: ShopperProfile = { department, confidence: 1, source: "manual" };
  await writeJson(path.join(paths.videos, id, "profile.json"), profile);
  return profile;
}

/** Store the original, then derive the canonical 9:16 video (used by the pipeline) and a web preview. */
async function register(id: string, source: string, name: string): Promise<VideoAsset> {
  const dir = path.dirname(source);
  const canonical = path.join(dir, "video.mp4");
  const preview = path.join(dir, "preview.mp4");
  await normalizePortrait(source, canonical);
  await webPreview(canonical, preview);
  const meta = { id, file: canonical, original: source, preview, name, createdAt: new Date().toISOString() };
  await writeJson(path.join(dir, "video.json"), meta);
  return withUrls(meta);
}

export async function saveUpload(file: File): Promise<VideoAsset> {
  const ext = path.extname(file.name).toLowerCase() || ".mp4";
  if (!ALLOWED.has(ext)) throw new Error(`unsupported video type ${ext}`);
  const id = newId("v");
  const dir = await ensureDir(path.join(paths.videos, id));
  const source = path.join(dir, `source${ext}`);
  await writeFile(source, Buffer.from(await file.arrayBuffer()));
  return register(id, source, file.name);
}

export async function registerSample(): Promise<VideoAsset> {
  const existing = (await listVideos()).find((v) => v.name === "sample: IMG_8204.mov");
  if (existing) return existing;
  const id = newId("v");
  const dir = await ensureDir(path.join(paths.videos, id));
  const source = path.join(dir, "source.mov");
  await copyFile(config.sampleVideo, source);
  return register(id, source, "sample: IMG_8204.mov");
}

export async function getVideo(id: string): Promise<(VideoAsset & { file: string }) | null> {
  if (!isSafeId(id)) return null;
  const meta = await readJson<VideoAsset & { preview: string }>(path.join(paths.videos, id, "video.json"));
  if (!meta) return null;
  const check = await readJson<VideoCheck>(path.join(paths.videos, id, "check.json"));
  const profile = await readJson<ShopperProfile>(path.join(paths.videos, id, "profile.json"));
  return withUrls({ ...meta, check, profile });
}

export async function listVideos(): Promise<VideoAsset[]> {
  const ids = await readdir(paths.videos).catch(() => [] as string[]);
  const all = await Promise.all(ids.map((id) => getVideo(id)));
  return all.filter((v): v is VideoAsset & { file: string } => !!v).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function withUrls<T extends { file: string; preview?: string | null }>(m: T) {
  return { ...m, url: fileUrl(m.file), preview: fileUrl(m.preview ?? null) } as T & VideoAsset;
}
