import { getStore } from "@/lib/server/catalog";

export async function GET(_req: Request, ctx: RouteContext<"/api/stores/[id]">) {
  const store = getStore(Number((await ctx.params).id));
  return store ? Response.json(store) : Response.json({ error: "store not found" }, { status: 404 });
}
