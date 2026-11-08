import { videoOperationSignal } from "@/lib/server/videoOperations";
import { connection } from "next/server";
import { listVideos, saveUpload } from "@/lib/server/videos";

export async function GET() {
  await connection();
  return Response.json({ videos: await listVideos() });
}

/** POST multipart/form-data with field "video". */
export async function POST(req: Request) {
  const signal = videoOperationSignal(req);
  if (signal.aborted) return new Response(null, { status: 499 });
  const form = await req.formData().catch(() => null);
  if (signal.aborted) return new Response(null, { status: 499 });
  const file = form?.get("video");
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: "missing 'video' file" }, { status: 400 });
  if (file.size > 300 * 1024 * 1024) return Response.json({ error: "video too large (max 300 MB)" }, { status: 413 });
  try {
    return Response.json(await saveUpload(file, signal), { status: 201 });
  } catch (e) {
    if (signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
