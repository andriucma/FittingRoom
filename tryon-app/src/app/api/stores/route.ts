import { connection } from "next/server";
import { addStore, ensureConfiguredStores, EXAMPLE_STORES, listStores, StoreError } from "@/lib/server/catalog";
import { config } from "@/lib/server/config";

/** GET: sync environment-configured stores, then list the shared catalog. */
export async function GET() {
  await connection();
  const setupErrors = await ensureConfiguredStores([config.shopifyStore, ...config.shopifyStores]);
  return Response.json({ stores: listStores(), examples: EXAMPLE_STORES, setupErrors });
}

/** POST { url }: validate it's a Shopify store with a public catalog, then process it in the background. */
export async function POST(req: Request) {
  const { url } = ((await req.json().catch(() => ({}))) as { url?: string });
  try {
    return Response.json(await addStore(url ?? ""), { status: 202 });
  } catch (e) {
    if (e instanceof StoreError) {
      return Response.json({ error: e.message, code: e.code, examples: EXAMPLE_STORES }, { status: 422 });
    }
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
