import { deleteRun, getRun } from "@/lib/server/runs";

export async function GET(_req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  return run ? Response.json(run) : Response.json({ error: "run not found" }, { status: 404 });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const { id } = await ctx.params;
  try {
    const result = await deleteRun(id);
    if (result === "busy") return Response.json({ error: "This look is still being created. You can delete it when it finishes." }, { status: 409 });
    return new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: "This look couldn’t be deleted. Please try again." }, { status: 500 });
  }
}
