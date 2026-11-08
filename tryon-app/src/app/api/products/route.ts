import type { NextRequest } from "next/server";
import { searchCatalog } from "@/lib/server/catalog";
import type { Department, TryOnKind } from "@/lib/types";

/** GET /api/products?q=&kind=top|bottom|dress&department=mens|womens|all&store=<id> : search the tagged catalog. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind = (["top", "bottom", "dress"].includes(sp.get("kind") ?? "") ? sp.get("kind") : "top") as TryOnKind;
  const department = (["mens", "womens"].includes(sp.get("department") ?? "") ? sp.get("department") : "all") as Department;
  const storeId = sp.get("store") ? Number(sp.get("store")) : undefined;
  return Response.json({ products: searchCatalog({ q: sp.get("q") ?? "", kind, department, storeId, limit: 60 }) });
}
