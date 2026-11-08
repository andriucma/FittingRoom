"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { garmentSlot } from "@/lib/outfit";
import type { Department, GarmentView, ImportedProduct, ProductSummary, ProductFocus, TryOnKind } from "@/lib/types";

const VIEWS: GarmentView[] = ["front", "back", "side", "detail", "other"];

export function ProductPicker({ kind, storeId, department, value, onChange, onSelected, pairWith, onFocused, onPreparing }: {
  kind: TryOnKind; storeId: number | null; department: Department; value: number | null;
  onChange: (id: number | null) => void; onSelected?: (product: ProductSummary) => void; pairWith?: number | null; onFocused?: (id: number) => void; onPreparing?: (id: number) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [suggestions, setSuggestions] = useState<ProductSummary[]>([]);
  const [focus, setFocus] = useState<ProductFocus | null>(null);
  const [photoIndex, setPhotoIndex] = useState<number | undefined>();
  const [product, setProduct] = useState<ImportedProduct | null>(null);
  const [searching, setSearching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (value) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const search = async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ kind, department, q, ...(storeId ? { store: String(storeId) } : {}), ...(pairWith ? { pairWith: String(pairWith) } : {}) });
        const response = await fetch(`/api/products?${params}`, { signal: abort.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Couldn’t load clothes. Please try again.");
        if (abort.signal.aborted) return;
        setError(null);
        setResults((data.products ?? []).filter((p: ProductSummary) => garmentSlot(p) === kind));
        setSuggestions((data.suggestions ?? []).filter((p: ProductSummary) => garmentSlot(p) === kind));
        if (!data.products?.length && !data.suggestions?.length && !q) timer = setTimeout(search, 5000);
      } catch (e) {
        if (!abort.signal.aborted) setError((e as Error).message);
      } finally {
        if (!abort.signal.aborted) setSearching(false);
      }
    };
    timer = setTimeout(search, 250);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [q, kind, storeId, department, pairWith, value]);

  useEffect(() => {
    if (!value) return;
    const abort = new AbortController();
    onPreparing?.(value);
    const prepare = async () => {
      try {
        const r = await fetch(`/api/products/${value}`, { signal: abort.signal });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Couldn’t load this piece.");
        if (abort.signal.aborted) return;
        setProduct(d); setFocus(null); setError(null);
        const result = await fetch(`/api/products/${value}/focus`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: photoIndex }), signal: abort.signal });
        const isolated = await result.json();
        if (!result.ok) throw new Error(isolated.error ?? "Couldn’t isolate this garment. Try another photo.");
        if (isolated.productId !== value || typeof isolated.focusUrl !== "string") throw new Error("The highlighted product photo wasn’t ready. Choose another photo or try again.");
        if (!abort.signal.aborted) { setFocus(isolated); onFocused?.(value); }
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    };
    void prepare();
    return () => abort.abort();
  }, [value, photoIndex, onFocused, onPreparing]);

  function clear() { setPhotoIndex(undefined); setFocus(null); onChange(null); }

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
  if (value) return <div>
    {error && <p className="notice error mb-4" role="alert">{error}</p>}
    {shown ? <>
      <div className="selected-product"><img src={focus?.productId === value ? focus.focusUrl : shown.images.find((im) => im.index === photoIndex)?.url ?? shown.images.find((im) => im.view === "front")?.url ?? shown.images[0]?.url ?? ""} alt={shown.title} /><div><h3>{shown.title}</h3><p role="status">{focus?.productId === value ? <><Icon name="check" width="14" height="14" /> Garment highlighted</> : error ? "Try another photo or choose a different piece." : "Highlighting your garment…"}</p><button className="text-link" onClick={clear}>Change piece</button></div></div>
      <details className="photo-settings"><summary>Photo options</summary><div className="photo-label-grid">{shown.images.map((im) => <div key={im.index}><button className="photo-choice" aria-label={`Highlight photo ${im.index + 1}`} aria-pressed={focus?.index === im.index} onClick={() => setPhotoIndex(im.index)}><img src={focus?.index === im.index ? focus.focusUrl : im.url ?? ""} alt={`${shown.title}, ${im.view} view`} /></button><select aria-label={`Photo ${im.index + 1} angle`} className="field-input" value={im.view} onChange={(e) => void relabel(im.index, e.target.value as GarmentView)}>{VIEWS.map((v) => <option key={v} value={v}>{v}{im.manual && v === im.view ? " ✓" : ""}</option>)}</select></div>)}</div></details>
    </> : <div className="empty-state"><Icon name="hanger" /><p>{error ? "This piece couldn’t be loaded." : "Loading product photos…"}</p><button className="text-link" onClick={clear}>Choose another piece</button></div>}
  </div>;

  return <div>
    <label className="search-field"><Icon name="search" width="17" height="17" /><input aria-label={`Search ${title}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${title} by color or style`} /></label>
    {error && <p role="alert" className="notice error mb-4">{error}</p>}
    {!!suggestions.length && <section className="pairing-suggestions" aria-label="Suggested pairings"><h3 className="field-label">Pairs with your {kind === "bottom" ? "top" : "bottoms"}</h3><div className="product-grid suggestion-grid">{suggestions.map((p) => <ProductCard key={p.id} product={p} select={() => { setPhotoIndex(undefined); onSelected?.(p); onChange(p.id); }} />)}</div></section>}
    <div className="product-grid" aria-busy={searching}>{results.map((p) => <ProductCard key={p.id} product={p} select={() => { setPhotoIndex(undefined); onSelected?.(p); onChange(p.id); }} />)}
      {!results.length && !suggestions.length && <div className="empty-state" role="status"><span className="empty-icon"><Icon name="hanger" width="28" height="28" /></span><p>{searching ? "Loading clothes…" : q ? "No pieces found. Try another search or store." : "No pieces match these filters. Try another store or department."}</p></div>}
    </div>
  </div>;
}

function ProductCard({ product: p, select }: { product: ProductSummary; select: () => void }) {
  return <button className="product-card" onClick={select}><span className="product-image"><img src={p.image} alt={p.title} loading="lazy" /></span><span className="product-title line-clamp-2">{p.title}</span><span className="product-price">{p.storeName}{p.price ? ` · $${p.price}` : ""}</span>{p.matchReason && <span className="match-reason">{p.matchReason}</span>}</button>;
}
