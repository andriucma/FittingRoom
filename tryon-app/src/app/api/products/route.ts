import type { NextRequest } from "next/server";
import { getCatalogProduct, searchCatalog } from "@/lib/server/catalog";
import { garmentSlot, pairingScore } from "@/lib/outfit";
import type { Department, TryOnKind } from "@/lib/types";

/** GET /api/products?q=&kind=top|bottom|dress&department=mens|womens|all&store=<id> : search the tagged catalog. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind = (["top", "bottom", "dress"].includes(sp.get("kind") ?? "") ? sp.get("kind") : "top") as TryOnKind;
  const department = (["mens", "womens"].includes(sp.get("department") ?? "") ? sp.get("department") : "all") as Department;
  const storeId = sp.get("store") ? Number(sp.get("store")) : undefined;
  const pairWith = sp.get("pairWith");
  const selected = pairWith ? getCatalogProduct(Number(pairWith)) : null;
  if (pairWith && (!selected || !Number.isSafeInteger(Number(pairWith)))) return Response.json({ error: "Selected pairing product was not found." }, { status: 400 });
  const products = searchCatalog({ q: sp.get("q") ?? "", kind, department, storeId, limit: selected ? 240 : 120 })
    .filter((p) => garmentSlot(p) === kind && p.id !== selected?.id);
  const canPair = selected && garmentSlot(selected) !== kind && ["top", "bottom"].includes(garmentSlot(selected) ?? "") && kind !== "dress";
  const ranked = canPair ? products.map((product, order) => ({ product, order, ...pairingScore(product, selected) }))
    .sort((a, b) => b.score - a.score || a.order - b.order) : [];
  const suggestions = ranked.filter((r) => r.reason).slice(0, 4).map((r) => ({ ...r.product, matchReason: r.reason! }));
  const suggested = new Set(suggestions.map((p) => p.id));
  return Response.json({ products: products.filter((p) => !suggested.has(p.id)).slice(0, 60), suggestions, pairingWith: canPair ? selected.title : null });
}
