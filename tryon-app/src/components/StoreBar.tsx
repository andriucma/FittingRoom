"use client";

import { useCallback, useEffect, useState } from "react";
import type { Store } from "@/lib/types";

const BUSY = new Set(["queued", "fetching", "tagging"]);

export function StoreBar({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [setupErrors, setSetupErrors] = useState<{ url: string; message: string }[]>([]);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async (signal: AbortSignal) => {
    const res = await fetch("/api/stores", { signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Couldn’t load your stores.");
    if (signal.aborted) return [] as Store[];
    setStores(data.stores ?? []); setSetupErrors(data.setupErrors ?? []);
    return (data.stores ?? []) as Store[];
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const list = await refresh(abort.signal);
        if (!abort.signal.aborted && list.some((s) => BUSY.has(s.status))) timer = setTimeout(tick, 3000);
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    };
    void tick();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [refresh, refreshKey]);

  async function add(target = url) {
    if (adding) return;
    setAdding(true); setError(null);
    try {
      const r = await fetch("/api/stores", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Couldn’t add this store.");
      setUrl(""); onChange(d.id); setRefreshKey((n) => n + 1);
    } catch (e) { setError((e as Error).message); } finally { setAdding(false); }
  }

  const busy = stores.filter((s) => BUSY.has(s.status));
  const unavailable = stores.filter((s) => s.status === "error");
  return <div><span className="field-label">Your stores</span><div className="chips"><button className={`chip ${value === null ? "selected" : ""}`} aria-pressed={value === null} onClick={() => onChange(null)}>All stores</button>{stores.map((s) => <button key={s.id} className={`chip ${value === s.id ? "selected" : ""}`} aria-pressed={value === s.id} onClick={() => onChange(s.id)}>{s.name}{BUSY.has(s.status) && <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" aria-label="Loading" />}</button>)}</div>
    {busy.length > 0 && <p className="mt-3 text-xs muted" role="status">Getting {busy.map((s) => s.name).join(" and ")} ready. New pieces will appear shortly.</p>}
    <details className="store-settings"><summary>Add a store{unavailable.length + setupErrors.length > 0 ? " · store status" : ""}</summary><form onSubmit={(e) => { e.preventDefault(); void add(); }}><input aria-label="Shopify store URL" value={url} onChange={(e) => setUrl(e.target.value)} className="field-input" placeholder="Shopify store link, e.g. kith.com" /><button className="fr-button small" disabled={!url.trim() || adding}>{adding ? "Checking…" : "Add store"}</button></form>{error && <p className="notice error mt-3" role="alert">{error}</p>}{setupErrors.map((e) => <p key={e.url} className="notice mt-3">Couldn&apos;t add {e.url}: {e.message}</p>)}{unavailable.map((s) => <div key={s.id} className="notice mt-3"><p><strong>{s.name}</strong> is currently unavailable.</p><details><summary>View details</summary><p>{s.error}</p></details><button className="text-link mt-2" disabled={adding} onClick={() => void add(s.domain)}>Try loading again</button></div>)}</details>
  </div>;
}
