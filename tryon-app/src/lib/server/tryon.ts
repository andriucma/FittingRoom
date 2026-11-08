import "server-only";
import { createReadStream } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { config, pricing } from "./config";
import { ensureDir, paths } from "./storage";

/**
 * GPT Image try-on, ported from scripts/tryon.py (validated settings: per-angle product views,
 * no anchor, everything except the two garments kept from the person's own photo).
 */

export type View = "front" | "back" | "side";
export type GarmentRefs = { noun: string; views: Partial<Record<View, string>> };

const openai = () => new OpenAI({ apiKey: config.openaiKey, timeout: 300_000, maxRetries: 2 });

function keepOtherItems(top: string, bottom: string) {
  return `Replace the person's original upper-body garment with the selected ${top}, and the original lower-body garment with the selected ${bottom}. Use exactly one selected upper garment and one selected lower garment; replace the originals instead of stacking the new clothes over them. Do not add a second top, extra pants, a skirt, a dress, or companion garments. Preserve everything outside those two clothing slots exactly as in image 1: whatever is on their feet (shoes, socks or bare feet), their watch, jewelry, glasses, hat, belt and accessories. Do not take anything from the product references except the selected garments themselves. If part of an accessory is hidden in image 1, keep it hidden rather than inventing it.`;
}

function garmentRules(top: string, bottom: string) {
  return `Reproduce the garments faithfully: same color, fabric, texture, pattern, graphics, logos, neckline, sleeve length, fit, rise and leg cut as in the product photos. The product references isolate only the selected garments against a neutral background. That background is not fabric or part of the outfit: do not copy it or its color onto the person. Use only the ${top} and the ${bottom} themselves.

Do not change the person's face, facial features, hair, skin tone, body shape, proportions, pose, stance, body rotation, hands or identity in any way. On the person, replace only the ${top} and the ${bottom}, fitting them naturally to the existing pose and body with realistic drape, folds and fabric behavior. Do not add watermarks, or any text or logos other than what is printed on the garments in the product photos.

${keepOtherItems(top, bottom)}`;
}

const SCENE_KEEP = "Match the lighting, shadows and color temperature of the original photo so the outfit looks photographed, not pasted on. Keep the background, room, camera angle, framing, crop and image quality exactly the same.";

function sceneReplace(n: number) {
  return `Image ${n} is the background plate. Replace everything behind and around the person in image 1 (walls, doors, windows, furniture, floor, lamps, cables and every other object) with exactly the empty scene in image ${n}: same backdrop color, floor, horizon line and light. Nothing from the original room may remain. Keep the person at exactly the same position, height in the frame, size and crop as in image 1, standing on the floor of image ${n} with a soft natural contact shadow under their feet. Relight the person and the garments to match the lighting of image ${n} so they look photographed there, not cut out and pasted, while keeping their skin tone, hair, identity and everything they wear unchanged. Changing the background is not a reason to restyle the person: no new shoes or accessories. Keep the camera angle and framing of image 1.`;
}

export const BACKGROUND_PRESETS: Record<string, string> = {
  studio:
    "An empty professional photo studio for full-body fashion photos: a seamless warm light-grey paper backdrop that curves smoothly into the floor (infinity cove) with no visible seams, corners, props, lights or equipment. Soft, even, diffused lighting with a gentle gradient on the backdrop, slightly brighter behind the subject area. Vertical phone photo taken at chest height, eye-level, as if framing a standing person full-body in the center. Photorealistic, completely empty, no people, no text.",
};

/** Which product views to send for a body angle (0° = facing camera), and how to describe the pose. */
export function orientation(angle: number): { views: View[]; pose: string } {
  const a = ((angle % 360) + 360) % 360;
  const d = Math.min(a, 360 - a);
  if (d <= 45) return { views: ["front"], pose: "In image 1 the person is facing the camera: you see their chest and the front of their legs. Show the front of the garments only. Nothing printed on the back of the garments is visible." };
  if (d >= 75 && d <= 105) return { views: ["side"], pose: "In image 1 the person is standing in profile, side-on to the camera: you see one side of their body. Show the side of the garments. Prints on the front or back of the garments are hidden or only barely visible at the edge." };
  if (d < 90) return { views: ["front", "side"], pose: "In image 1 the person is turned about three-quarters to the side with their chest still partly toward the camera. Show the front and side of the garments. Nothing printed on the back of the garments is visible." };
  if (d < 135) return { views: ["back", "side"], pose: "In image 1 the person is turned more than sideways, mostly away from the camera: you see one side and part of their back. Show the side and back of the garments; any back print appears on the visible part of the back, foreshortened by the angle. Nothing printed on the front of the garments is visible." };
  return { views: ["back"], pose: "In image 1 the person is facing away from the camera: you see their back. Show the back of the garments, including any back print exactly as in the back product photo. Nothing printed on the front of the garments, such as a chest logo, is visible." };
}

/** Matching views for this angle; falls back to whatever views exist (front first). */
function pick(g: GarmentRefs, views: View[]): { file: string; view: View }[] {
  const hit = views.filter((v) => g.views[v]).map((v) => ({ file: g.views[v]!, view: v }));
  if (hit.length) return hit;
  for (const v of ["front", "side", "back"] as View[]) if (g.views[v]) return [{ file: g.views[v]!, view: v }];
  throw new Error(`no usable product photo for the ${g.noun}`);
}

export function planFrame(angle: number, top: GarmentRefs, bottom: GarmentRefs, plate: string | null) {
  const { views, pose } = orientation(angle);
  const t = pick(top, views);
  const b = pick(bottom, views);
  let n = 2;
  const lines = [
    ...t.map((r) => `Image ${n++} is a product photo of the ${top.noun}, ${r.view} view.`),
    ...b.map((r) => `Image ${n++} is a product photo of the ${bottom.noun}, ${r.view} view.`),
  ];
  const prompt = `Image 1 is a photo of a person (the subject). It is one frame of a video in which the person turns in a full circle, and the outfit must look the same in every frame.
${lines.join("\n")}

Edit image 1 so the person is wearing the ${top.noun} and the ${bottom.noun} shown in the product photos.

${pose}

${garmentRules(top.noun, bottom.noun)}

${plate ? sceneReplace(n) : SCENE_KEEP}`;
  return {
    refs: [...t.map((r) => r.file), ...b.map((r) => r.file), ...(plate ? [plate] : [])],
    views: [...t.map((r) => `${top.noun}:${r.view}`), ...b.map((r) => `${bottom.noun}:${r.view}`)],
    prompt,
  };
}

type Usage = { input_tokens_details?: { image_tokens?: number; text_tokens?: number }; output_tokens?: number } | null | undefined;
export function imageCost(u: Usage): number {
  if (!u) return 0;
  const p = pricing.gptImage;
  return ((u.input_tokens_details?.image_tokens ?? 0) * p.imageIn + (u.input_tokens_details?.text_tokens ?? 0) * p.textIn + (u.output_tokens ?? 0) * p.out) / 1e6;
}

const mime = (f: string) => (f.endsWith(".png") ? "image/png" : f.endsWith(".webp") ? "image/webp" : "image/jpeg");

export async function editImage(opts: { images: string[]; prompt: string; out: string; model: string; quality: string; size?: string }) {
  const t0 = Date.now();
  const files = await Promise.all(opts.images.map((f) => toFile(createReadStream(f), path.basename(f), { type: mime(f) })));
  const res = await openai().images.edit({
    model: opts.model, image: files, prompt: opts.prompt, size: (opts.size ?? "864x1536") as "auto",
    quality: opts.quality as "medium", output_format: "png",
  });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error("image model returned no image");
  await writeFile(opts.out, Buffer.from(b64, "base64"));
  return { seconds: (Date.now() - t0) / 1000, costUsd: imageCost(res.usage as Usage) };
}

/** Empty background plate, generated once per preset and cached in DATA_DIR/backgrounds. */
export async function backgroundPlate(preset: string, model: string): Promise<{ file: string; costUsd: number }> {
  const prompt = BACKGROUND_PRESETS[preset];
  if (!prompt) throw new Error(`unknown background preset ${preset}`);
  const file = path.join(await ensureDir(paths.backgrounds), `${preset}.png`);
  try {
    await access(file);
    return { file, costUsd: 0 };
  } catch {}
  const res = await openai().images.generate({ model, prompt, size: "864x1536" as "auto", quality: "high", output_format: "png" });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error("no background image returned");
  await writeFile(file, Buffer.from(b64, "base64"));
  return { file, costUsd: imageCost(res.usage as Usage) };
}

/** Run async jobs with bounded concurrency. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}
