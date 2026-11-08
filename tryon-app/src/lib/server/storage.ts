import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

/**
 * Everything lives under DATA_DIR (shared with the Python service):
 *   videos/<id>/source.<ext>
 *   products/<handle>/product.json, views.json, NN.jpg
 *   backgrounds/<preset>.png
 *   runs/<id>/run.json, frames/, tryon/, aligned/, video/, omni/
 */
export const paths = {
  root: config.dataDir,
  videos: path.join(config.dataDir, "videos"),
  products: path.join(config.dataDir, "products"),
  backgrounds: path.join(config.dataDir, "backgrounds"),
  runs: path.join(config.dataDir, "runs"),
};

export function newId(prefix = ""): string {
  const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${prefix}${t}-${randomBytes(3).toString("hex")}`;
}

export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic write (temp file + rename) so readers never see a half-written JSON. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

/** Resolve a path relative to DATA_DIR, refusing anything that escapes it. */
export function resolveData(rel: string): string | null {
  const abs = path.resolve(paths.root, rel);
  return abs === paths.root || abs.startsWith(paths.root + path.sep) ? abs : null;
}

/** Browser URL for a file under DATA_DIR. */
export function fileUrl(abs: string | undefined | null): string | null {
  if (!abs) return null;
  const rel = path.relative(paths.root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return `/api/files/${rel.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,120}$/.test(id) && !id.includes("..");
}
