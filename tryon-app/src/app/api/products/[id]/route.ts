import type { NextRequest } from "next/server";
import { importProduct, setImageView } from "@/lib/server/shopify";
import type { GarmentView } from "@/lib/types";

const VIEWS: GarmentView[] = ["front", "back", "side", "detail", "other"];

/** GET: download the product's photos for try-on (cached) with their front/back/side labels. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/products/[id]">) {
  try {
    return Response.json(await importProduct(Number((await ctx.params).id)));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}

/** PATCH { index, view }: correct a photo's view label. */
export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/products/[id]">) {
  const body = (await req.json().catch(() => ({}))) as { index?: number; view?: GarmentView };
  if (typeof body.index !== "number" || !body.view || !VIEWS.includes(body.view)) {
    return Response.json({ error: "expected { index: number, view: front|back|side|detail|other }" }, { status: 400 });
  }
  try {
    return Response.json(await setImageView(Number((await ctx.params).id), body.index, body.view));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}
