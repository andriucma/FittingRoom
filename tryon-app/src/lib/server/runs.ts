import "server-only";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { framesToVideo, sideBySide, trimWholeSeconds } from "./ffmpeg";
import { localModels } from "./localModels";
import { omniEdit, omniPrompt } from "./omni";
import { importProduct } from "./shopify";
import { isolatedReferenceViews } from "./garmentFocus";
import { ensureDir, fileUrl, isSafeId, newId, paths, readJson, writeJson } from "./storage";
import { backgroundPlate, editImage, planFrame, pool } from "./tryon";
import { cachedAngles, getVideo } from "./videos";
import { getCatalogProduct } from "./catalog";
import { garmentPrompt, outfitError } from "@/lib/outfit";
import type { AnglesResult } from "./localModels";
import type { Run, RunInput, StepName } from "@/lib/types";

/**
 * Pipeline: angles (Python/MediaPipe) -> try-on (OpenAI) -> framing (Python/SAM 3)
 *           -> spin video (ffmpeg) -> Omni video (Gemini, automatic for new runs).
 * State is persisted to DATA_DIR/runs/<id>/run.json after every change; the UI polls it.
 */

const STEPS: StepName[] = ["angles", "tryon", "framing", "spin", "omni"];
const active = ((globalThis as unknown as { __activeRuns?: Set<string> }).__activeRuns ??= new Set<string>());

const runFile = (id: string) => path.join(paths.runs, id, "run.json");

class RunState {
  private chain = Promise.resolve();
  constructor(public run: Run) {}
  /** Mutate + persist; writes are serialized so concurrent frame updates never clobber each other. */
  update(fn: (r: Run) => void): Promise<void> {
    fn(this.run);
    this.run.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(this.run);
    this.chain = this.chain.then(() => writeJson(runFile(snapshot.id), snapshot));
    return this.chain;
  }
  step(name: StepName, patch: Partial<Run["steps"][StepName]>) {
    return this.update((r) => {
      const now = new Date().toISOString();
      if (patch.status === "running") patch.startedAt = now;
      if (patch.status === "done" || patch.status === "error" || patch.status === "skipped") patch.finishedAt = now;
      r.steps[name] = { ...r.steps[name], ...patch };
    });
  }
}

export async function startRun(input: RunInput): Promise<Run> {
  const invalid = outfitError(getCatalogProduct(input.top), getCatalogProduct(input.bottom));
  if (invalid) throw new Error(invalid);
  const video = await getVideo(input.videoId);
  if (!video) throw new Error("video not found");
  const id = newId("r");
  const run: Run = {
    id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running", input,
    steps: Object.fromEntries(STEPS.map((s) => [s, { status: "pending" }])) as Run["steps"],
    frames: [], outputs: {}, stats: {}, cost: { openaiUsd: 0, geminiUsd: 0 },
  };
  await ensureDir(path.join(paths.runs, id));
  await writeJson(runFile(id), run);
  active.add(id);
  void execute(new RunState(run), video.file).finally(() => active.delete(id));
  return run;
}

async function execute(s: RunState, videoFile: string) {
  const { input } = s.run;
  const dir = path.join(paths.runs, s.run.id);
  let current: StepName = "angles";
  try {
    // 1. Angles (Python). On resume, reuse the analysis the frames came from.
    const resumed = s.run.frames.length
      ? await readJson<AnglesResult>(path.join(path.dirname(s.run.frames[0].source), "angles.json"))
      : null;
    if (!resumed) await s.step("angles", { status: "running", detail: "MediaPipe pose: picking frames by body angle" });
    const angles = resumed ?? (await cachedAngles(input.videoId, input.stepDeg))
      ?? await localModels.extractAngles(videoFile, path.join(dir, "frames"), input.stepDeg);
    if (!resumed) await s.update((r) => {
      r.frames = angles.selected.map((p) => ({ index: p.index, angle: p.est_deg, source: p.file }));
      r.stats.rotationDeg = angles.total_rotation_deg;
      r.stats.direction = angles.direction;
      r.outputs.contactSheet = path.join(path.dirname(angles.selected[0].file), "contact_sheet.jpg");
    });
    if (!resumed) await s.step("angles", { status: "done", detail: `${angles.selected.length} frames over ${angles.total_rotation_deg}°${angles.seconds ? ` in ${angles.seconds}s` : " (from verification)"}` });

    // 2. Try-on (OpenAI)
    current = "tryon";
    const todo = s.run.frames.filter((f) => !f.tryon);   // resume: only frames not dressed yet
    await s.step("tryon", { status: "running", detail: "importing products", done: s.run.frames.length - todo.length, total: s.run.frames.length });
    const [top, bottom] = await Promise.all([importProduct(input.top), importProduct(input.bottom)]);
    await s.step("tryon", { detail: "isolating the selected garments from the product photos" });
    const [topRefs, bottomRefs] = todo.length
      ? await Promise.all([isolatedReferenceViews(top), isolatedReferenceViews(bottom)])
      : [
        { noun: garmentPrompt(getCatalogProduct(input.top)!), views: {} },
        { noun: garmentPrompt(getCatalogProduct(input.bottom)!), views: {} },
      ];
    let plate: string | null = null;
    if (input.background !== "original") {
      const bg = await backgroundPlate(input.background, input.model);
      plate = bg.file;
      await s.update((r) => { r.cost.openaiUsd += bg.costUsd; });
    }
    await s.step("tryon", { detail: `dressing ${todo.length} frames with ${input.model}` });
    const outDir = await ensureDir(path.join(dir, "tryon"));
    await s.update((r) => r.frames.forEach((f) => { delete f.error; }));
    const results = await pool(todo, 12, async (f) => {
      const plan = planFrame(f.angle, topRefs, bottomRefs, plate);
      const out = path.join(outDir, `tryon_${String(f.index).padStart(3, "0")}.png`);
      try {
        const r = await editImage({ images: [f.source, ...plan.refs], prompt: plan.prompt, out, model: input.model, quality: input.quality });
        await s.update((run) => {
          const fr = run.frames.find((x) => x.index === f.index)!;
          Object.assign(fr, { tryon: out, final: out, views: plan.views, seconds: r.seconds, costUsd: r.costUsd });
          run.cost.openaiUsd += r.costUsd;
          run.steps.tryon.done = (run.steps.tryon.done ?? 0) + 1;
        });
      } catch (e) {
        await s.update((run) => { run.frames.find((x) => x.index === f.index)!.error = (e as Error).message; });
        throw e;
      }
    });
    const failed = results.filter((r) => r.status === "rejected").length;
    if (todo.length && failed === todo.length && !s.run.frames.some((f) => f.tryon)) throw new Error((results[0] as PromiseRejectedResult).reason?.message ?? "all frames failed");
    if (failed) throw new Error(`${failed} outfit frame(s) failed. Retry to finish them; completed frames will be reused.`);
    await s.step("tryon", { status: "done", detail: `${s.run.frames.length - failed}/${s.run.frames.length} frames${failed ? `, ${failed} failed` : ""}` });
    const good = s.run.frames.filter((f) => f.tryon);

    // 3. Stabilize person scale/position for both original and studio backgrounds.
    current = "framing";
    if (s.run.steps.framing.status === "done" && good.every((f) => f.final && f.final !== f.tryon)) {
      // resume: already aligned
    } else {
      await s.step("framing", { status: "running", detail: "SAM 3: same scale/position in every frame" });
      const fr = await localModels.normalizeFraming(good.map((f) => f.tryon!), path.join(dir, "aligned"));
      await s.update((r) => {
        good.forEach((f, i) => { r.frames.find((x) => x.index === f.index)!.final = fr.outputs[i]; });
        r.stats.framingSpread = fr.spread_pct;
      });
      await s.step("framing", { status: "done", detail: `height spread ${fr.spread_pct.height.before}% → ${fr.spread_pct.height.after}% in ${fr.seconds}s` });
    }

    // 4. Spin video (ffmpeg)
    current = "spin";
    await s.step("spin", { status: "running" });
    const finals = s.run.frames.filter((f) => f.final).sort((a, b) => a.angle - b.angle).map((f) => f.final!);
    const spin = path.join(await ensureDir(path.join(dir, "video")), "spin.mp4");
    await framesToVideo(finals, spin);
    await s.update((r) => { r.outputs.spin = spin; });
    await s.step("spin", { status: "done", detail: `${finals.length} frames, 2 loops` });

    // 5. Omni (Gemini): re-dress the real video using 3 finished frames as references
    current = "omni";
    if (!input.omni.enabled) {
      await s.step("omni", { status: "skipped" });
    } else if (s.run.outputs.omni) {
      // resume: already rendered
    } else {
      await s.step("omni", { status: "running", detail: "trimming the turn and calling Gemini Omni" });
      const omniDir = await ensureDir(path.join(dir, "omni"));
      const track = angles.track;
      const turnStart = Math.max(0, (track.find((p) => p.angle_deg > 2)?.t ?? 0) - 0.2);
      const end = track.at(-1)!.t + 1 / angles.fps;
      const src = path.join(omniDir, "source.mp4");
      const { seconds } = await trimWholeSeconds(videoFile, turnStart, end, src);
      const nearest = (deg: number) => [...good].sort((a, b) => angDist(a.angle, deg) - angDist(b.angle, deg))[0];
      const refs = [nearest(0), nearest(90), nearest(180)].map((f) => f.final!);
      const out = path.join(omniDir, "omni.mp4");
      const r = await omniEdit({
        video: src, seconds, resolution: input.omni.resolution, out,
        refs: plate ? [...refs, plate] : refs,
        prompt: omniPrompt({ top: topRefs.noun, bottom: bottomRefs.noun, studio: !!plate }),
      });
      const compare = path.join(omniDir, "compare.mp4");
      await sideBySide(src, out, compare);
      await s.update((run) => {
        run.outputs.omni = out;
        run.outputs.omniCompare = compare;
        run.cost.geminiUsd += r.costUsd;
      });
      await s.step("omni", { status: "done", detail: `${seconds}s ${input.omni.resolution} in ${r.seconds.toFixed(0)}s` });
    }
    await s.update((r) => { r.status = "done"; });
  } catch (e) {
    const msg = (e as Error).message;
    await s.step(current, { status: "error", detail: msg });
    await s.update((r) => { r.status = "error"; r.error = msg; });
  }
}

/** Resume a failed/interrupted run from where it stopped (finished work is reused, not re-billed). */
export async function resumeRun(id: string): Promise<Run> {
  if (!isSafeId(id)) throw new Error("bad id");
  const run = await readJson<Run>(runFile(id));
  if (!run) throw new Error("run not found");
  const invalid = outfitError(getCatalogProduct(run.input.top), getCatalogProduct(run.input.bottom));
  if (invalid) throw new Error(invalid);
  if (active.has(id)) throw new Error("run is already running");
  if (run.status === "done") throw new Error("run already finished");
  const video = await getVideo(run.input.videoId);
  if (!video) throw new Error("video not found");
  for (const st of Object.values(run.steps)) if (st.status === "error" || st.status === "running") { st.status = "pending"; delete st.detail; }
  run.status = "running";
  delete run.error;
  await writeJson(runFile(id), run);
  active.add(id);
  void execute(new RunState(run), video.file).finally(() => active.delete(id));
  return run;
}

const angDist = (a: number, b: number) => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360));

/** Run with browser URLs; runs left "running" by a server restart show as interrupted. */
export async function getRun(id: string): Promise<Run | null> {
  if (!isSafeId(id)) return null;
  const run = await readJson<Run>(runFile(id));
  if (!run) return null;
  if (run.status === "running" && !active.has(id)) run.status = "interrupted";
  return {
    ...run,
    frames: run.frames.map((f) => ({ ...f, sourceUrl: fileUrl(f.source), tryonUrl: fileUrl(f.tryon), finalUrl: fileUrl(f.final) })),
    outputs: {
      ...run.outputs,
      spinUrl: fileUrl(run.outputs.spin), omniUrl: fileUrl(run.outputs.omni),
      omniCompareUrl: fileUrl(run.outputs.omniCompare), contactSheetUrl: fileUrl(run.outputs.contactSheet),
    },
  };
}

export async function listRuns(): Promise<Run[]> {
  const ids = await readdir(paths.runs).catch(() => [] as string[]);
  const runs = await Promise.all(ids.map(getRun));
  return runs.filter((r): r is Run => !!r).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
