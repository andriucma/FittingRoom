import { cancelVideoOperation } from "@/lib/server/videoOperations";

export async function DELETE(_req: Request, ctx: RouteContext<"/api/video-operations/[id]">) {
  const { id } = await ctx.params;
  return cancelVideoOperation(id) ? new Response(null, { status: 204 }) : Response.json({ error: "Invalid operation" }, { status: 400 });
}
