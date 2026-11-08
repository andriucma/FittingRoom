import "server-only";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

function run(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let failure: Error | undefined;
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (error: NodeJS.ErrnoException) => { failure = error.code === "ENOENT"
      ? new Error("Video processing is not set up on this computer. Install ffmpeg and ffprobe, then restart the app.") : error; });
    p.on("close", (code) => failure ? reject(failure) : code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.slice(-800)}`)));
  });
}

export async function mediaToolsHealth() {
  const check = async (bin: string) => {
    try { await run(bin, ["-version"]); return { ok: true }; }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  };
  const [ffmpeg, ffprobe] = await Promise.all([check(config.ffmpeg), check(config.ffprobe)]);
  return { ffmpeg, ffprobe };
}

export async function probeDuration(file: string): Promise<number> {
  const out = await run(config.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return parseFloat(out);
}

async function probeVideoDuration(file: string): Promise<number> {
  const raw = await run(config.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "json", file]);
  const streams = (JSON.parse(raw) as { streams?: { duration?: string }[] }).streams;
  if (!streams?.length) throw new Error("The recording contains no video stream");
  const duration = Number(streams[0].duration);
  return Number.isFinite(duration) && duration > 0 ? duration : probeDuration(file);
}

/**
 * Hard-cut spin video from frames ordered by angle (each held 1/fps s), encoded at 30 fps.
 * The 0° frame is appended once at the very end so the turn closes (330° -> 0°) and the clip
 * ends on the same pose it starts with; `loops` full turns are played before that closing frame.
 */
export async function framesToVideo(frames: string[], out: string, fps = 3, loops = 2): Promise<void> {
  const list = path.join(path.dirname(out), "frames.txt");
  const seq = [...Array.from({ length: loops }, () => frames).flat(), frames[0]];
  await writeFile(list, seq.map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration ${1 / fps}\n`).join("") + `file '${seq.at(-1)}'\n`);
  await run(config.ffmpeg, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "scale=864:-2,fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", out]);
}

/**
 * Fit the complete [start, end] turn to WHOLE seconds (3–15), 720x1280/30fps, no audio.
 * Gemini Omni rejects edits whose input length differs from the requested duration.
 */
export async function trimWholeSeconds(video: string, start: number, end: number, out: string): Promise<{ start: number; seconds: number }> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Invalid video interval");
  const available = await probeVideoDuration(video);
  if (!Number.isFinite(available) || available <= 0 || start >= available) throw new Error("The recording has no usable video in that interval");
  const finish = Math.min(end, available);
  const begin = Math.max(0, start);
  if (finish <= begin) throw new Error("The recording has no usable video in that interval");
  const seconds = Math.max(3, Math.min(15, Math.ceil(finish - begin - 1e-6)));
  const s = begin;
  const speed = seconds / (finish - s);
  // Preserve the entire turn: uniformly retime it instead of dropping the start
  // or assuming rounding adds frames. Padding covers only frame-grid rounding.
  await run(config.ffmpeg, ["-v", "error", "-y", "-ss", s.toFixed(6), "-i", video,
    "-vf", `trim=duration=${(finish - s).toFixed(6)},setpts=(PTS-STARTPTS)*${speed.toFixed(12)},fps=30,tpad=stop_mode=clone:stop_duration=${seconds},trim=duration=${seconds},scale=720:1280`,
    "-frames:v", String(seconds * 30), "-an", "-fps_mode", "cfr",
    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  await assertOmniDuration(out, seconds);
  return { start: s, seconds };
}

/** Fail locally, before upload/billing, if an external caller passes mismatched media. */
export async function assertOmniDuration(video: string, seconds: number): Promise<void> {
  if (!Number.isInteger(seconds) || seconds < 3 || seconds > 15) throw new Error("Smooth video duration must be a whole number from 3 to 15 seconds");
  const actual = await probeVideoDuration(video);
  if (!Number.isFinite(actual) || Math.round(actual * 10) !== seconds * 10) {
    throw new Error(`Video preparation failed: expected ${seconds}s but encoded ${actual}s. Retry to prepare the recording again.`);
  }
}

/** Side-by-side review video (left | right). */
export async function sideBySide(left: string, right: string, out: string): Promise<void> {
  await run(config.ffmpeg, ["-v", "error", "-y", "-i", left, "-i", right, "-filter_complex",
    "[0:v]setpts=PTS-STARTPTS,fps=30,scale=540:960,setsar=1,settb=AVTB,setpts=N/(30*TB)[a];[1:v]setpts=PTS-STARTPTS,fps=30,scale=540:960,setsar=1,settb=AVTB,setpts=N/(30*TB)[b];[a][b]hstack=shortest=1,format=yuv420p",
    "-an", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", out]);
}

/** Re-encode any uploaded video to a web-safe H.264 MP4 preview. */
export async function webPreview(video: string, out: string, signal?: AbortSignal): Promise<void> {
  await run(config.ffmpeg, ["-v", "error", "-y", "-i", video, "-vf", "scale=-2:960,format=yuv420p",
    "-an", "-c:v", "libx264", "-crf", "23", "-movflags", "+faststart", out], signal);
}

/**
 * Canonical pipeline video: center-crop to 9:16 portrait (no-op for phone portrait video; laptop webcams
 * are landscape and the capture UI keeps the person inside the 9:16 guide), 1080x1920, 30 fps, no audio.
 * Also fixes browser MediaRecorder WebM files that lack duration metadata.
 */
export async function normalizePortrait(video: string, out: string, signal?: AbortSignal): Promise<void> {
  await run(config.ffmpeg, ["-v", "error", "-y", "-i", video, "-vf",
    "crop='if(gt(iw/ih,9/16),trunc(ih*9/16/2)*2,iw)':'if(gt(iw/ih,9/16),ih,trunc(iw*16/9/2)*2)',scale=1080:1920,fps=30,format=yuv420p",
    "-an", "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", out], signal);
}
