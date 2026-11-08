import { videoOperationSignal } from "@/lib/server/videoOperations";
import { getVideo, verifyVideo } from "@/lib/server/videos";

/** POST: analyze the recording with the local pose model and check it's a usable full turn. */
export async function POST(req: Request, ctx: RouteContext<"/api/videos/[id]/verify">) {
  const { id } = await ctx.params;
  if (!(await getVideo(id))) return Response.json({ error: "video not found" }, { status: 404 });
  const signal = videoOperationSignal(req);
  try {
    signal.throwIfAborted();
    return Response.json(await verifyVideo(id, 30, signal));
  } catch (e) {
    if (signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
