import { resumeRun } from "@/lib/server/runs";

/** POST: resume a failed or interrupted run; finished steps/frames are reused. */
export async function POST(_req: Request, ctx: RouteContext<"/api/runs/[id]/resume">) {
  const { id } = await ctx.params;
  try {
    return Response.json(await resumeRun(id), { status: 202 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
