"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { Department, GarmentView, ImportedProduct, ProductSummary, TryOnKind } from "@/lib/types";

const VIEWS: GarmentView[] = ["front", "back", "side", "detail", "other"];

export function ProductPicker({ kind, storeId, department, value, onChange, onSelected }: {
  kind: TryOnKind; storeId: number | null; department: Department; value: number | null;
  onChange: (id: number | null) => void; onSelected?: (product: ProductSummary) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [product, setProduct] = useState<ImportedProduct | null>(null);
  const [searching, setSearching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const search = async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ kind, department, q, ...(storeId ? { store: String(storeId) } : {}) });
        const response = await fetch(`/api/products?${params}`, { signal: abort.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Couldn’t load clothes. Please try again.");
        if (abort.signal.aborted) return;
        setError(null);
        setResults(data.products ?? []);
        if (!data.products?.length && !q) timer = setTimeout(search, 5000);
      } catch (e) {
        if (!abort.signal.aborted) setError((e as Error).message);
      } finally {
        if (!abort.signal.aborted) setSearching(false);
      }
    };
    timer = setTimeout(search, 250);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [q, kind, storeId, department]);

  useEffect(() => {
    if (!value) return;
    const abort = new AbortController();
    fetch(`/api/products/${value}`, { signal: abort.signal }).then(async (r) => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Couldn’t load this piece.");
      if (!abort.signal.aborted) { setError(null); setProduct(d); }
    }).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [value]);

  async function relabel(index: number, view: GarmentView) {
    try {
      const r = await fetch(`/api/products/${value}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ index, view }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Couldn’t update this photo.");
      setProduct(data);
    } catch (e) { setError((e as Error).message); }
  }

  const title = kind === "top" ? "tops" : kind === "bottom" ? "bottoms" : "dresses";
  const shown = product?.id === value ? product : null;
  if (value) return <div aria-live="polite">
    {error && <p className="notice error mb-4" role="alert">{error}</p>}
    {shown ? <>
      <div className="selected-product"><img src={shown.images.find((im) => im.view === "front")?.url ?? shown.images[0]?.url ?? ""} alt={shown.title} /><div><h3>{shown.title}</h3><p><Icon name="check" width="14" height="14" /> Added to your look</p><button className="text-link" onClick={() => onChange(null)}>Choose a different piece</button></div></div>
      <details className="photo-settings"><summary>Review product photo angles</summary><p className="mt-2">These angles help us show the right side of your clothes. You can correct a label if needed.</p><div className="photo-label-grid">{shown.images.map((im) => <div key={im.index}><img src={im.url ?? ""} alt={`${shown.title}, ${im.view} view`} /><select aria-label={`Photo ${im.index + 1} angle`} className="field-input" value={im.view} onChange={(e) => void relabel(im.index, e.target.value as GarmentView)}>{VIEWS.map((v) => <option key={v} value={v}>{v}{im.manual && v === im.view ? " ✓" : ""}</option>)}</select></div>)}</div></details>
    </> : <div className="empty-state"><Icon name="hanger" /><p>{error ? "This piece couldn’t be loaded." : "Getting your piece ready…"}</p><button className="text-link" onClick={() => onChange(null)}>Choose another piece</button></div>}
  </div>;

  return <div>
    <label className="search-field"><Icon name="search" width="17" height="17" /><input aria-label={`Search ${title}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find your ${title}… try “black” or “oversized”`} /></label>
    {error && <p role="alert" className="notice error mb-4">{error}</p>}
    <div className="product-grid" aria-busy={searching}>{results.map((p) => <button key={p.id} className="product-card" onClick={() => { onSelected?.(p); onChange(p.id); }}><span className="product-image"><img src={p.image} alt={p.title} loading="lazy" /></span><span className="product-title line-clamp-2">{p.title}</span><span className="product-price">{p.storeName}{p.price ? ` · $${p.price}` : ""}</span></button>)}
      {!results.length && <div className="empty-state" role="status"><span className="empty-icon"><Icon name="hanger" width="28" height="28" /></span><p>{searching ? "Finding your next favorite…" : q ? "No pieces found. Try another search or store." : "Your next look is on its way. Clothes will appear here once a store is ready."}</p></div>}
    </div>
  </div>;
}
