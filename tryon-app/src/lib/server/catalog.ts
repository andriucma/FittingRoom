import "server-only";
import { db } from "./db";
import { config } from "./config";
import { displayStoreName } from "@/lib/presentation";
import { balancedSample } from "./catalogSampling";
import { tagProduct } from "./decisions";
import { pool } from "./tryon";
import type { CatalogImage, CatalogProduct, Department, ProductSummary, Store, TryOnKind } from "@/lib/types";

/**
 * Store catalog: validate a Shopify store, pull its public catalog (/products.json), sample big stores,
 * tag every product with the Decisions API, and keep it all in the local SQLite dataset for search.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAMPLE_THRESHOLD = 500;   // stores bigger than this are sampled...
const PER_SECTION = 50;         // ...this many products per apparel section
const MAX_PAGES = 40;           // 40 x 250 = 10k products max fetched
const APPAREL = ["top", "bottom", "dress", "outerwear", "swimwear"] as const;

export const EXAMPLE_STORES = ["gymshark.com", "allbirds.com", "kith.com", "aloyoga.com", "outdoorvoices.com", "taylorstitch.com"];

export class StoreError extends Error {
  constructor(public code: "invalid_url" | "not_shopify" | "catalog_private" | "unreachable", message: string) {
    super(message);
  }
}

type RawProduct = {
  id: number; handle: string; title: string; product_type: string; vendor: string; body_html: string | null;
  tags: string[] | string; images: { src: string; width: number; height: number; position: number }[];
  variants: { price: string; available?: boolean }[];
};

async function get(url: string, accept = "application/json"): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA, accept }, signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (res.status !== 429 || attempt >= 4) return res;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));   // Shopify rate limit
  }
}

async function productsJsonOk(origin: string): Promise<boolean> {
  try {
    const res = await get(`${origin}/products.json?limit=1`);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return false;
    return Array.isArray(((await res.json()) as { products?: unknown }).products);
  } catch {
    return false;
  }
}

function normalizeHost(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw) throw new StoreError("invalid_url", "Enter a store URL, like kith.com");
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    if (!u.hostname.includes(".")) throw new Error();
    return u.hostname.replace(/^www\./, "");
  } catch {
    throw new StoreError("invalid_url", `"${input}" doesn't look like a store URL. Try something like kith.com`);
  }
}

/** Decide whether a URL is a Shopify store with a public catalog, and where to read it from. */
export async function resolveStore(input: string): Promise<{ domain: string; apiBase: string; name: string | null }> {
  const domain = normalizeHost(input);
  const candidates = [`https://${domain}`, `https://www.${domain}`];
  let html = "";
  for (const origin of candidates) {
    if (await productsJsonOk(origin)) return { domain, apiBase: origin, name: await siteName(origin) };
  }
  try {
    html = await (await get(`https://${domain}/`, "text/html")).text();
  } catch {
    throw new StoreError("unreachable", `We couldn't reach ${domain}. Check the address and try again.`);
  }
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/([a-z0-9][a-z0-9-]*)\.myshopify\.com/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  const shop = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (shop && (await productsJsonOk(`https://${shop}.myshopify.com`))) {
    return { domain, apiBase: `https://${shop}.myshopify.com`, name: titleOf(html) };
  }
  if (shop || /cdn\.shopify\.com|Shopify\.theme|shopify-section/.test(html)) {
    throw new StoreError("catalog_private", `${domain} runs on Shopify but doesn't share its product catalog publicly, so we can't add it yet.`);
  }
  throw new StoreError("not_shopify", `Sorry, we only work with Shopify stores right now, and ${domain} isn't one.`);
}

function titleOf(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i)?.[1];
  const t = og ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  return t ? t.replace(/\s+/g, " ").trim().slice(0, 80) : null;
}

async function siteName(origin: string): Promise<string | null> {
  try {
    return titleOf(await (await get(`${origin}/`, "text/html")).text());
  } catch {
    return null;
  }
}

/** Cheap keyword section, only used to sample big stores before tagging. */
export function sectionOf(p: Pick<RawProduct, "product_type" | "title">): string {
  const test = (s: string) => {
    const t = s.toLowerCase();
    if (/(gift ?card|bottle|shaker|bag|backpack|hat\b|cap\b|beanie|belt|keychain|wallet|sunglass|jewel|necklace|bracelet|accessor|equipment|strap)/.test(t)) return "accessory";
    if (/(shoe|sneaker|boot|slide|sandal|sock|footwear)/.test(t)) return "footwear";
    if (/(swim|bikini|trunk)/.test(t)) return "swimwear";
    if (/(dress|jumpsuit|romper|bodysuit|one[ -]?piece|unitard|catsuit)/.test(t)) return "dress";
    if (/(jacket|coat|parka|vest|gilet|windbreaker|track top|puffer|outerwear|anorak|blazer)/.test(t)) return "outerwear";
    if (/(pant|jogger|jean|short|legging|skirt|trouser|bottom|sweatpant|chino|cargo)/.test(t)) return "bottom";
    if (/(tee|t-shirt|shirt|tank|top|hoodie|sweatshirt|sweater|crew|pullover|polo|bra\b|henley|cardigan|long sleeve|knit)/.test(t)) return "top";
    return null;
  };
  return test(p.product_type ?? "") ?? test(p.title) ?? "other";
}

const strip = (html: string | null) => (html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;|&#39;|&quot;/g, " ").replace(/\s+/g, " ").trim();

// ---------- ingestion ----------

const jobs = ((globalThis as unknown as { __storeJobs?: Set<number> }).__storeJobs ??= new Set<number>());

function setStore(id: number, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields);
  db().prepare(`UPDATE stores SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

/** Validate + register a store and start processing it in the background. Re-adding resumes/refreshes. */
export async function addStore(input: string): Promise<Store> {
  const { domain, apiBase, name } = await resolveStore(input);
  const d = db();
  d.prepare(`INSERT INTO stores (domain, api_base, name) VALUES (?, ?, ?)
             ON CONFLICT(domain) DO UPDATE SET api_base = excluded.api_base, name = COALESCE(excluded.name, stores.name)`)
    .run(domain, apiBase, name);
  const row = d.prepare("SELECT id, status FROM stores WHERE domain = ?").get(domain) as { id: number; status: string };
  if (!jobs.has(row.id) && row.status !== "ready") {
    setStore(row.id, { status: "queued", error: null });
    jobs.add(row.id);
    void ingest(row.id).finally(() => jobs.delete(row.id));
  }
  return getStore(row.id)!;
}

async function fetchCatalog(apiBase: string): Promise<RawProduct[]> {
  const all: RawProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await get(`${apiBase}/products.json?limit=250&page=${page}`);
    if (!res.ok) throw new Error(`products.json page ${page}: HTTP ${res.status}`);
    const batch = ((await res.json()) as { products: RawProduct[] }).products;
    all.push(...batch);
    if (batch.length < 250) break;
  }
  return all;
}

async function ingest(storeId: number) {
  const d = db();
  try {
    if (!config.openaiKey || config.openaiKey === "sk-...") {
      throw new Error("Set OPENAI_KEY in .env.local, restart the app, then add this store again to import and tag its clothes.");
    }
    const store = d.prepare("SELECT api_base FROM stores WHERE id = ?").get(storeId) as { api_base: string };
    setStore(storeId, { status: "fetching" });
    const all = (await fetchCatalog(store.api_base)).filter((p) => p.images?.length);
    let keep = all.map((p) => ({ p, section: sectionOf(p) }));
    if (all.length > SAMPLE_THRESHOLD) {
      // Keep men's and women's clothing represented even when Shopify orders one first.
      keep = balancedSample(keep, APPAREL, PER_SECTION);
    }
    setStore(storeId, { total_products: all.length, sampled: keep.length });

    const upsert = d.prepare(`INSERT INTO products (store_id, shopify_id, handle, title, vendor, product_type, tags, description, url,
        price_min, price_max, available, section, images)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id, handle) DO UPDATE SET title = excluded.title, vendor = excluded.vendor, product_type = excluded.product_type,
        tags = excluded.tags, description = excluded.description, price_min = excluded.price_min, price_max = excluded.price_max,
        available = excluded.available, section = excluded.section,
        images = CASE WHEN products.tagged_at IS NULL THEN excluded.images ELSE products.images END`);
    d.exec("BEGIN");
    for (const { p, section } of keep) {
      const prices = p.variants.map((v) => parseFloat(v.price)).filter((x) => !isNaN(x));
      const tags = Array.isArray(p.tags) ? p.tags : String(p.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const images: CatalogImage[] = [...p.images].sort((a, b) => a.position - b.position).slice(0, 8)
        .map((im) => ({ src: im.src.split("?")[0], width: im.width, height: im.height, position: im.position }));
      upsert.run(storeId, p.id, p.handle, p.title, p.vendor ?? "", p.product_type ?? "", JSON.stringify(tags), strip(p.body_html).slice(0, 2000),
        `${store.api_base}/products/${p.handle}`, prices.length ? Math.min(...prices) : null, prices.length ? Math.max(...prices) : null,
        p.variants.some((v) => v.available) ? 1 : 0, section, JSON.stringify(images));
    }
    d.exec("COMMIT");

    // Tag with the Decisions API (skip ones already tagged on a previous run).
    const todo = d.prepare("SELECT id, title, product_type, vendor, tags, description, images FROM products WHERE store_id = ? AND tagged_at IS NULL")
      .all(storeId) as { id: number; title: string; product_type: string; vendor: string; tags: string; description: string; images: string }[];
    setStore(storeId, { status: "tagging", tagged: (d.prepare("SELECT COUNT(*) n FROM products WHERE store_id = ? AND tagged_at IS NOT NULL").get(storeId) as { n: number }).n });
    const save = d.prepare(`UPDATE products SET department = ?, department_conf = ?, category = ?, category_conf = ?, tryon_prob = ?,
      color = ?, fit = ?, images = ?, tagged_at = datetime('now'), tag_error = NULL WHERE id = ?`);
    let cost = (d.prepare("SELECT tag_cost_usd FROM stores WHERE id = ?").get(storeId) as { tag_cost_usd: number }).tag_cost_usd;
    let tagFailure: Error | null = null;
    let fatalTagFailure = false;
    await pool(todo, 8, async (row) => {
      if (fatalTagFailure) return;
      const images = JSON.parse(row.images) as CatalogImage[];
      try {
        const t = await tagProduct({ title: row.title, productType: row.product_type, vendor: row.vendor, tags: JSON.parse(row.tags),
          description: row.description, imageUrls: images.map((i) => i.src) });
        images.forEach((im, i) => Object.assign(im, { view: t.views[i]?.view, viewConfidence: t.views[i]?.confidence, clean: t.views[i]?.clean }));
        save.run(t.department, t.departmentConf, t.category, t.categoryConf, t.tryonProb, t.color, t.fit, JSON.stringify(images), row.id);
        cost += t.costUsd;
        d.prepare("UPDATE stores SET tagged = tagged + 1, tag_cost_usd = ? WHERE id = ?").run(cost, storeId);
      } catch (e) {
        tagFailure = e as Error;
        if (/401|403|no credits|insufficient_quota|exceeded your current quota/i.test(tagFailure.message)) fatalTagFailure = true;
        d.prepare("UPDATE products SET tag_error = ? WHERE id = ?").run((e as Error).message.slice(0, 500), row.id);
      }
    });
    if (tagFailure) throw tagFailure;
    setStore(storeId, { status: "ready", error: null });
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch {}
    setStore(storeId, { status: "error", error: (e as Error).message.slice(0, 500) });
  }
}

type StoreSetupError = { url: string; message: string };
const configuredStores = ((globalThis as unknown as { __configuredStores?: Map<string, Promise<StoreSetupError | null>> })
  .__configuredStores ??= new Map<string, Promise<StoreSetupError | null>>());

/** Sync each configured host once per server process; ready stores and active imports are reused. */
export async function ensureConfiguredStores(urls: string[]): Promise<StoreSetupError[]> {
  const pending = urls.filter(Boolean).map((url) => {
    let domain: string;
    try { domain = normalizeHost(url); }
    catch (e) { return Promise.resolve({ url, message: (e as Error).message }); }
    let attempt = configuredStores.get(domain);
    if (!attempt) {
      attempt = (async () => {
        try {
          const existing = db().prepare("SELECT id, status FROM stores WHERE domain = ? OR api_base IN (?, ?)")
            .get(domain, `https://${domain}`, `https://www.${domain}`) as { id: number; status: string } | undefined;
          if (!existing || (existing.status !== "ready" && !jobs.has(existing.id))) await addStore(url);
          return null;
        } catch (e) { return { url, message: (e as Error).message }; }
      })();
      configuredStores.set(domain, attempt);
    }
    return attempt;
  });
  return (await Promise.all(pending)).filter((error): error is StoreSetupError => error !== null);
}

// ---------- queries ----------

type StoreRow = { id: number; domain: string; api_base: string; name: string | null; status: string; total_products: number;
  sampled: number; tagged: number; tag_cost_usd: number; error: string | null; created_at: string; updated_at: string };

function toStore(r: StoreRow): Store {
  return { id: r.id, domain: r.domain, apiBase: r.api_base, name: displayStoreName(r.name, r.domain), status: r.status as Store["status"],
    totalProducts: r.total_products, sampled: r.sampled, tagged: r.tagged, tagCostUsd: r.tag_cost_usd, error: r.error,
    createdAt: r.created_at, processing: jobs.has(r.id) };
}

export function listStores(): Store[] {
  return (db().prepare("SELECT * FROM stores ORDER BY created_at").all() as StoreRow[]).map(toStore);
}

export function getStore(id: number): Store | null {
  const r = db().prepare("SELECT * FROM stores WHERE id = ?").get(id) as StoreRow | undefined;
  return r ? toStore(r) : null;
}

const KIND_CATEGORIES: Record<TryOnKind, string[]> = { top: ["top", "outerwear"], bottom: ["bottom"], dress: ["dress"] };
const DEPT: Record<Department, string[] | null> = { mens: ["mens", "unisex"], womens: ["womens", "unisex"], all: null };

/** Searchable, filtered catalog: only tagged, try-on-able garments of the requested kind/department. */
export function searchCatalog(opts: { storeId?: number; q?: string; kind: TryOnKind; department: Department; limit?: number }): ProductSummary[] {
  const where = ["p.tagged_at IS NOT NULL", "p.tryon_prob >= 0.5"];
  const args: (string | number)[] = [];
  if (opts.storeId) { where.push("p.store_id = ?"); args.push(opts.storeId); }
  const cats = KIND_CATEGORIES[opts.kind];
  where.push(`p.category IN (${cats.map(() => "?").join(",")})`);
  args.push(...cats);
  const deps = DEPT[opts.department];
  if (deps) { where.push(`p.department IN (${deps.map(() => "?").join(",")})`); args.push(...deps); }
  const terms = (opts.q ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  let from = "products p";
  if (terms.length) {
    from = "products_fts f JOIN products p ON p.id = f.rowid";
    where.push("products_fts MATCH ?");
    args.push(terms.map((t) => `"${t}"*`).join(" "));
  }
  const rows = db().prepare(`SELECT p.*, s.name AS store_name, s.domain AS store_domain FROM ${from} JOIN stores s ON s.id = p.store_id
    WHERE ${where.join(" AND ")} ORDER BY ${terms.length ? "bm25(products_fts)," : ""} p.available DESC, p.id LIMIT ?`)
    .all(...args, opts.limit ?? 60) as (ProductRow & { store_name: string | null; store_domain: string })[];
  return rows.map((r) => {
    const images = JSON.parse(r.images) as CatalogImage[];
    const front = images.find((i) => i.view === "front" && (i.clean ?? 0) >= 0.5) ?? images.find((i) => i.view === "front") ?? images[0];
    return {
      id: r.id, storeId: r.store_id, storeName: displayStoreName(r.store_name, r.store_domain), handle: r.handle, title: r.title, productType: r.product_type,
      kind: opts.kind, department: r.department, category: r.category, color: r.color, fit: r.fit,
      price: r.price_min != null ? r.price_min.toFixed(2) : null, image: `${front.src}?width=400`, imageCount: images.length,
    };
  });
}

type ProductRow = { id: number; store_id: number; handle: string; title: string; vendor: string; product_type: string; tags: string;
  description: string; url: string; price_min: number | null; price_max: number | null; available: number; section: string;
  images: string; department: string; department_conf: number; category: string; category_conf: number; tryon_prob: number;
  color: string; fit: string; tagged_at: string | null };

export function getCatalogProduct(id: number): CatalogProduct | null {
  const r = db().prepare("SELECT p.*, s.domain, s.api_base FROM products p JOIN stores s ON s.id = p.store_id WHERE p.id = ?")
    .get(id) as (ProductRow & { domain: string; api_base: string }) | undefined;
  if (!r) return null;
  return {
    id: r.id, storeId: r.store_id, storeDomain: r.domain, apiBase: r.api_base, handle: r.handle, title: r.title, vendor: r.vendor,
    productType: r.product_type, tags: JSON.parse(r.tags), description: r.description, url: r.url, priceMin: r.price_min,
    images: JSON.parse(r.images), department: r.department, category: r.category, tryonProb: r.tryon_prob, color: r.color, fit: r.fit,
    taggedAt: r.tagged_at,
  };
}

export function setCatalogImageView(id: number, index: number, view: string) {
  const p = getCatalogProduct(id);
  if (!p?.images[index]) throw new Error("no such image");
  p.images[index] = { ...p.images[index], view, manual: true };
  db().prepare("UPDATE products SET images = ? WHERE id = ?").run(JSON.stringify(p.images), id);
}
