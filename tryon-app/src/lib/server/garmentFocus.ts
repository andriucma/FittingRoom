import "server-only";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { garmentPrompt, garmentSlot } from "@/lib/outfit";
import { getCatalogProduct } from "./catalog";
import { importProduct, referenceViews } from "./shopify";
import { localModels } from "./localModels";
import { fileUrl, readJson, writeJson } from "./storage";
import type { GarmentRefs, View } from "./tryon";
import type { ImportedProduct, ProductFocus, ProductImage } from "@/lib/types";

type FocusResult = Awaited<ReturnType<typeof localModels.focusGarment>>;
type CachedFocus = FocusResult & { sourceSize: number; sourceModified: number };
const tasks = ((globalThis as unknown as { __garmentFocus?: Map<string, Promise<FocusResult>> }).__garmentFocus ??= new Map<string, Promise<FocusResult>>());

async function isolate(product: ImportedProduct, image: ProductImage): Promise<FocusResult> {
  const listing = getCatalogProduct(product.id);
  if (!listing || !["top", "bottom"].includes(garmentSlot(listing) ?? "")) throw new Error("Select a single top or bottom to isolate.");
  const prompt = garmentPrompt(listing);
  const source = await stat(image.file);
  const out = path.join(path.dirname(image.file), "garments-v1", `${image.index}-${prompt.replace(/[^a-z0-9]+/g, "-")}`);
  const key = `${out}:${source.size}:${source.mtimeMs}`;
  const active = tasks.get(key);
  if (active) return active;
  const task = (async () => {
    const cached = await readJson<CachedFocus>(path.join(out, "focus.json"));
    if (cached?.sourceSize === source.size && cached.sourceModified === source.mtimeMs) {
      try { await Promise.all([cached.focus, cached.reference, cached.mask].map((f) => access(f))); return cached; } catch {}
    }
    const result = await localModels.focusGarment(image.file, prompt, out);
    await writeJson(path.join(out, "focus.json"), { ...result, sourceSize: source.size, sourceModified: source.mtimeMs });
    return result;
  })();
  tasks.set(key, task);
  try { return await task; } finally { tasks.delete(key); }
}

/** UI uses the dimmed image; generation uses a separate neutral-background reference. */
export async function focusProductPhoto(id: number, index?: number): Promise<ProductFocus> {
  const product = await importProduct(id);
  const preferred = referenceViews(product);
  const defaultFile = preferred.front ?? preferred.side ?? preferred.back;
  const image = index === undefined ? product.images.find((i) => i.file === defaultFile) ?? product.images[0] : product.images.find((i) => i.index === index);
  if (!image) throw new Error("This product photo was not found.");
  const result = await isolate(product, image);
  return { productId: id, index: image.index, prompt: result.prompt, score: result.score, focusUrl: fileUrl(result.focus)!, maskUrl: fileUrl(result.mask)! };
}

/** Preserve view labels and garment pixels; remove the model's other clothes from AI inputs. */
export async function isolatedReferenceViews(product: ImportedProduct): Promise<GarmentRefs> {
  const listing = getCatalogProduct(product.id);
  if (!listing) throw new Error("Product not found");
  const views: GarmentRefs["views"] = {};
  for (const view of ["front", "back", "side"] as View[]) {
    const candidates = product.images.filter((image) => image.view === view)
      .sort((a, b) => Number(!!b.manual) - Number(!!a.manual) || (b.clean ?? 0) - (a.clean ?? 0) || a.index - b.index);
    for (const image of candidates) {
      try { views[view] = (await isolate(product, image)).reference; break; }
      catch { /* Try a different photo of this view; never fall back to the unmasked model. */ }
    }
  }
  if (!Object.keys(views).length) throw new Error(`${product.title}: the garment could not be isolated from its photos. Choose another product or review its photo angles.`);
  return { noun: garmentPrompt(listing), views };
}
