"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { Run } from "@/lib/types";

export function RunsList() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const removed = useRef(new Set<string>());
  async function remove(id: string) {
    if (deleting) return;
    setDeleting(id); setError(null); setMessage("");
    try {
      const response = await fetch(`/api/runs/${id}`, { method: "DELETE" });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "This look couldn’t be deleted. Try again."); }
      removed.current.add(id);
      setRuns((items) => items?.filter((run) => run.id !== id) ?? []);
      setConfirming(null); setMessage("Look deleted."); heading.current?.focus({ preventScroll: true });
    } catch (e) { setError((e as Error).message); }
    finally { setDeleting(null); }
  }
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      clearTimeout(timer);
      try {
        const response = await fetch("/api/runs", { signal: abort.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Your looks couldn’t load. Please try again.");
        if (abort.signal.aborted) return;
        setRuns((data.runs ?? []).filter((run: Run) => !removed.current.has(run.id)));
        if (data.runs?.some((run: Run) => run.status === "running")) timer = setTimeout(refresh, 3000);
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { abort.abort(); clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, []);
  return <div className="page-shell">
    <header className="page-heading mt-8"><h1 ref={heading} tabIndex={-1}>My looks.</h1></header>
    {error && <p className="notice error" role="alert">{error}</p>}
    <p className="sr-only" role="status">{message}</p>
    {!runs && !error && <div className="empty-state" role="status">Loading your looks…</div>}
    {runs?.length === 0 && <div className="fitting-card empty-state"><span className="empty-icon"><Icon name="hanger" width="32" height="32" /></span><h2 className="text-xl text-foreground">Your next look starts here.</h2><p>Record a turn and try your first outfit.</p><Link href="/" className="fr-button primary">Start a fitting <Icon name="arrow" width="16" height="16" /></Link></div>}
    <div className="looks-grid">{runs?.map((run) => {
      const thumb = run.frames.find((f) => f.finalUrl)?.finalUrl ?? run.frames[0]?.sourceUrl;
      const label = run.status === "done" ? "Ready" : run.status === "running" ? "Creating" : run.steps.omni.status === "error" ? "Video paused" : "Paused";
      return <article key={run.id} className="look-card"><Link href={`/runs/${run.id}`} className="look-card-link"><div className="look-card-image">{thumb ? <img src={thumb} alt={`Outfit from ${new Date(run.createdAt).toLocaleDateString()}`} loading="lazy" /> : <Icon name="hanger" width="36" height="36" />}</div><div className="look-meta"><div><h2>{run.input.background === "studio" ? "Studio fitting" : "Your-space fitting"}</h2><p className="mt-1">{new Date(run.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {new Date(run.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</p></div><span className={`status-pill ${run.status === "error" || run.status === "interrupted" ? "needs-retry" : ""}`}>{label}</span></div></Link><div className="look-card-actions">{confirming === run.id ? <div className="delete-confirm" role="group" aria-label="Confirm look deletion"><span>Delete this look?</span><button className="text-link" disabled={deleting === run.id} onClick={() => { setConfirming(null); requestAnimationFrame(() => document.getElementById(`delete-${run.id}`)?.focus()); }}>Cancel</button><button className="delete-look confirm" disabled={!!deleting} onClick={() => void remove(run.id)}>{deleting === run.id ? "Deleting…" : "Delete"}</button></div> : <button id={`delete-${run.id}`} className="delete-look" disabled={run.status === "running" || !!deleting} title={run.status === "running" ? "Available when this look finishes" : undefined} aria-label={`Delete look from ${new Date(run.createdAt).toLocaleString()}`} onClick={() => { setError(null); setConfirming(run.id); }}><Icon name="trash" width="15" height="15" />Delete</button>}</div></article>;
    })}</div>
  </div>;
}
