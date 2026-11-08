import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config";

/**
 * Local catalog database (Node's built-in SQLite, FTS5 for search): data/catalog.db.
 * One shared "public dataset" of every store that has been added.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stores (
  id             INTEGER PRIMARY KEY,
  domain         TEXT NOT NULL UNIQUE,       -- what the user typed, normalized (e.g. kith.com)
  api_base       TEXT NOT NULL,              -- origin that serves /products.json (may be *.myshopify.com)
  name           TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',   -- queued | fetching | tagging | ready | error
  total_products INTEGER DEFAULT 0,          -- products in the store
  sampled        INTEGER DEFAULT 0,          -- products kept (all, or ~50 per section if > 500)
  tagged         INTEGER DEFAULT 0,
  tag_cost_usd   REAL DEFAULT 0,
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY,
  store_id        INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_id      INTEGER,
  handle          TEXT NOT NULL,
  title           TEXT NOT NULL,
  vendor          TEXT,
  product_type    TEXT,
  tags            TEXT,                      -- JSON array
  description     TEXT,                      -- plain text from body_html
  url             TEXT,
  price_min       REAL,
  price_max       REAL,
  available       INTEGER,
  section         TEXT,                      -- heuristic section used for sampling
  images          TEXT NOT NULL,             -- JSON [{src,width,height,position,view?,viewConfidence?}]
  -- Decisions API tags
  department      TEXT, department_conf REAL,   -- mens | womens | unisex | kids
  category        TEXT, category_conf REAL,     -- top | bottom | dress | outerwear | swimwear | footwear | accessory | other
  tryon_prob      REAL,                         -- P(wearable garment that can be tried on in a full-body photo)
  color           TEXT,
  fit             TEXT,
  tagged_at       TEXT,
  tag_error       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, handle)
);
CREATE INDEX IF NOT EXISTS products_filter ON products (store_id, category, department);

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  title, product_type, tags, description, vendor, color, category, department,
  content='products', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, title, product_type, tags, description, vendor, color, category, department)
  VALUES (new.id, new.title, new.product_type, new.tags, new.description, new.vendor, new.color, new.category, new.department);
END;
CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, title, product_type, tags, description, vendor, color, category, department)
  VALUES ('delete', old.id, old.title, old.product_type, old.tags, old.description, old.vendor, old.color, old.category, old.department);
END;
CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, title, product_type, tags, description, vendor, color, category, department)
  VALUES ('delete', old.id, old.title, old.product_type, old.tags, old.description, old.vendor, old.color, old.category, old.department);
  INSERT INTO products_fts(rowid, title, product_type, tags, description, vendor, color, category, department)
  VALUES (new.id, new.title, new.product_type, new.tags, new.description, new.vendor, new.color, new.category, new.department);
END;
`;

const g = globalThis as unknown as { __catalogDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (!g.__catalogDb) {
    mkdirSync(config.dataDir, { recursive: true });
    const d = new DatabaseSync(path.join(config.dataDir, "catalog.db"));
    d.exec(SCHEMA);
    // A previous server process died mid-ingest: mark those stores so they can be resumed.
    d.exec(`UPDATE stores SET status = 'error', error = 'interrupted; add the store again to resume' WHERE status IN ('queued','fetching','tagging')`);
    g.__catalogDb = d;
  }
  return g.__catalogDb;
}
