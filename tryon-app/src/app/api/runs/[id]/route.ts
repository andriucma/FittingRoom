import { getRun } from "@/lib/server/runs";

export async function GET(_req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  return run ? Response.json(run) : Response.json({ error: "run not found" }, { status: 404 });
}
