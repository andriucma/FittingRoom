"use client";

import { useCallback, useEffect, useState } from "react";
import { displayStoreName } from "@/lib/presentation";
import type { Store } from "@/lib/types";

const BUSY = new Set(["queued", "fetching", "tagging"]);
const usable = (store: Store) => store.status === "ready" || store.tagged > 0;

export function StoreBar({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [setupErrors, setSetupErrors] = useState<{ url: string; message: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(async (signal: AbortSignal) => {
    const response = await fetch("/api/stores", { signal }); const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Stores couldn’t load.");
    if (signal.aborted) return [] as Store[];
    setStores(data.stores ?? []); setSetupErrors(data.setupErrors ?? []); setLoadError(null);
    return (data.stores ?? []) as Store[];
  }, []);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try { const list = await refresh(abort.signal); if (!abort.signal.aborted && list.some((s) => BUSY.has(s.status))) timer = setTimeout(tick, 3000); }
      catch (e) { if (!abort.signal.aborted) setLoadError((e as Error).message); }
    };
    void tick(); return () => { abort.abort(); clearTimeout(timer); };
  }, [refresh, refreshKey]);
  const busy = stores.filter((s) => BUSY.has(s.status));
  const unavailable = stores.filter((s) => s.status === "error");
  const label = (s: Store) => displayStoreName(s.name, s.domain);
  return <div>
    <span className="field-label">Store</span>
    <div className="chips store-chips"><button className={`chip ${value === null ? "selected" : ""}`} aria-pressed={value === null} onClick={() => onChange(null)}>All stores</button>{stores.map((s) => <button key={s.id} title={usable(s) ? label(s) : `${label(s)} · ${BUSY.has(s.status) ? "loading" : "unavailable"}`} disabled={!usable(s)} className={`chip ${value === s.id ? "selected" : ""}`} aria-pressed={value === s.id} onClick={() => onChange(s.id)}>{label(s)}{BUSY.has(s.status) && <span className="preparing-dot" aria-label="Loading" />}</button>)}</div>
    <select className="field-input store-select" aria-label="Filter by store" value={value ?? "all"} onChange={(e) => onChange(e.target.value === "all" ? null : Number(e.target.value))}><option value="all">All stores</option>{stores.map((s) => <option key={s.id} value={s.id} disabled={!usable(s)}>{label(s)}{!usable(s) ? BUSY.has(s.status) ? " · loading" : " · unavailable" : ""}</option>)}</select>
    {loadError && <p className="notice error mt-3" role="alert">{loadError} <button className="text-link" onClick={() => setRefreshKey((n) => n + 1)}>Reload stores</button></p>}
    {!!busy.length && <p className="mt-3 text-xs muted" role="status">Adding {busy.map(label).join(" and ")} in the background. You can keep browsing.</p>}
    {(unavailable.length > 0 || setupErrors.length > 0) && <p className="muted text-xs mt-3">Some stores are temporarily unavailable.</p>}
  </div>;
}
