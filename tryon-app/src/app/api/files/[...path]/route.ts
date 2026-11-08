import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveData } from "@/lib/server/storage";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm", ".json": "application/json",
};

/** Serve files under DATA_DIR, with HTTP Range support so videos can seek. */
export async function GET(req: Request, ctx: RouteContext<"/api/files/[...path]">) {
  const { path: parts } = await ctx.params;
  const abs = resolveData(parts.map(decodeURIComponent).join("/"));
  const info = abs ? await stat(abs).catch(() => null) : null;
  if (!abs || !info?.isFile()) return new Response("not found", { status: 404 });

  const type = TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache" };
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? parseInt(range[1]) : Math.max(0, info.size - parseInt(range[2]));
    const end = range[1] && range[2] ? Math.min(parseInt(range[2]), info.size - 1) : info.size - 1;
    if (start >= info.size || start > end) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${info.size}` } });
    }
    const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(end - start + 1) },
    });
  }
  const body = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(body, { headers: { ...headers, "content-length": String(info.size) } });
}
