import { getVideo, verifyVideo } from "@/lib/server/videos";

/** POST: analyze the recording with the local pose model and check it's a usable full turn. */
export async function POST(_req: Request, ctx: RouteContext<"/api/videos/[id]/verify">) {
  const { id } = await ctx.params;
  if (!(await getVideo(id))) return Response.json({ error: "video not found" }, { status: 404 });
  try {
    return Response.json(await verifyVideo(id));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
