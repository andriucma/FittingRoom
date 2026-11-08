import { connection } from "next/server";
import { listVideos, saveUpload } from "@/lib/server/videos";

export async function GET() {
  await connection();
  return Response.json({ videos: await listVideos() });
}

/** POST multipart/form-data with field "video". */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("video");
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: "missing 'video' file" }, { status: 400 });
  if (file.size > 300 * 1024 * 1024) return Response.json({ error: "video too large (max 300 MB)" }, { status: 413 });
  try {
    return Response.json(await saveUpload(file), { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
