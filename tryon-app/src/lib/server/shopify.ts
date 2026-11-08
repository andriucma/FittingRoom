import "server-only";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getCatalogProduct, setCatalogImageView } from "./catalog";
import { ensureDir, fileUrl, paths, readJson, writeJson } from "./storage";
import type { GarmentView, ImportedProduct, ProductImage, ProductKind } from "@/lib/types";

/**
 * Prepare a catalog product for try-on: download its original photos (JPEG/PNG, not the CDN's WebP)
 * to DATA_DIR/products/<store>/<handle>/ and carry over the Decisions API view labels.
 */

const kindOfCategory = (c: string): ProductKind => (c === "top" || c === "outerwear" ? "top" : c === "bottom" ? "bottom" : "other");

export async function importProduct(id: number): Promise<ImportedProduct> {
  const p = getCatalogProduct(id);
  if (!p) throw new Error(`product ${id} not in catalog`);
  const dir = path.join(paths.products, p.storeDomain, p.handle);
  const cached = await readJson<ImportedProduct>(path.join(dir, "views.json"));
  const images: ProductImage[] = [];
  for (const [i, im] of p.images.entries()) {
    let file = cached?.images.find((c) => c.index === i)?.file;
    if (!file) {
      const r = await fetch(im.src, { headers: { accept: "image/jpeg,image/png;q=0.9" } });
      if (!r.ok) continue;
      const type = r.headers.get("content-type") ?? "image/jpeg";
      file = path.join(await ensureDir(dir), `${String(i + 1).padStart(2, "0")}${type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : ".jpg"}`);
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
    }
    images.push({
      index: i, file, src: im.src, url: null, width: im.width, height: im.height,
      view: (im.view ?? "other") as GarmentView, fullyVisible: (im.clean ?? 0) >= 0.5, plainBackground: (im.clean ?? 0) >= 0.5,
      clean: im.clean ?? 0, manual: im.manual,
    });
  }
  const product: ImportedProduct = {
    id: p.id, storeDomain: p.storeDomain, handle: p.handle, title: p.title, productType: p.productType,
    kind: kindOfCategory(p.category), price: p.priceMin?.toFixed(2) ?? null, images, importedAt: new Date().toISOString(),
  };
  await writeJson(path.join(dir, "views.json"), product);
  return withUrls(product);
}

/** Manually correct a photo's view label (stored in the catalog DB). */
export async function setImageView(id: number, index: number, view: GarmentView): Promise<ImportedProduct> {
  setCatalogImageView(id, index, view);
  return importProduct(id);
}

function withUrls(p: ImportedProduct): ImportedProduct {
  return { ...p, images: p.images.map((i) => ({ ...i, url: fileUrl(i.file) })) };
}

/** Best photo per view for try-on: manual label > clean studio shot > label confidence order > earlier position. */
export function referenceViews(p: ImportedProduct): Partial<Record<"front" | "back" | "side", string>> {
  const out: Partial<Record<"front" | "back" | "side", string>> = {};
  for (const view of ["front", "back", "side"] as const) {
    const c = p.images.filter((i) => i.view === view)
      .sort((a, b) => Number(!!b.manual) - Number(!!a.manual) || (b.clean ?? 0) - (a.clean ?? 0) || a.index - b.index);
    if (c[0]) out[view] = c[0].file;
  }
  return out;
}
