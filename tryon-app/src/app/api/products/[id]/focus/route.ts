import { focusProductPhoto } from "@/lib/server/garmentFocus";

export async function POST(req: Request, ctx: RouteContext<"/api/products/[id]/focus">) {
  const id = Number((await ctx.params).id);
  const body = (await req.json().catch(() => null) ?? {}) as { index?: number };
  if (!Number.isSafeInteger(id) || id <= 0 || (body.index !== undefined && (!Number.isSafeInteger(body.index) || body.index < 0))) {
    return Response.json({ error: "Choose a valid product and photo." }, { status: 400 });
  }
  try { return Response.json(await focusProductPhoto(id, body.index)); }
  catch (e) { return Response.json({ error: (e as Error).message }, { status: 422 }); }
}
