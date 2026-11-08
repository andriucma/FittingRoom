"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { Run } from "@/lib/types";

export function RunsList() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/runs", { signal: abort.signal }).then(async (r) => { const data = await r.json(); if (!r.ok) throw new Error(data.error ?? "Your looks couldn’t load. Please refresh and try again."); if (!abort.signal.aborted) setRuns(data.runs ?? []); }).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, []);
  return <div className="page-shell">
    <header className="page-heading mt-8"><p className="eyebrow">YOUR PERSONAL LOOKBOOK</p><h1>My looks.</h1><p>A good outfit deserves another look.</p></header>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!runs && !error && <div className="empty-state" role="status">Loading your looks…</div>}
    {runs?.length === 0 && <div className="fitting-card empty-state"><span className="empty-icon"><Icon name="hanger" width="32" height="32" /></span><h2 className="text-xl text-foreground">A little empty. For now.</h2><p>Your outfits will be saved here after your first fitting.</p><Link href="/" className="fr-button primary">Start my first fitting <Icon name="arrow" width="16" height="16" /></Link></div>}
    <div className="looks-grid">{runs?.map((run) => {
      const thumb = run.frames.find((f) => f.finalUrl)?.finalUrl ?? run.frames[0]?.sourceUrl;
      const label = run.status === "done" ? "Ready" : run.status === "running" ? "Creating" : run.steps.omni.status === "error" ? "Video paused" : "Paused";
      return <Link key={run.id} href={`/runs/${run.id}`} className="look-card"><div className="look-card-image">{thumb ? <img src={thumb} alt={`Outfit from ${new Date(run.createdAt).toLocaleDateString()}`} loading="lazy" /> : <Icon name="hanger" width="36" height="36" />}</div><div className="look-meta"><div><h2>{run.input.background === "studio" ? "Studio fitting" : "Original-space fitting"}</h2><p className="mt-1">{new Date(run.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {new Date(run.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</p></div><span className={`status-pill ${run.status === "error" || run.status === "interrupted" ? "needs-retry" : ""}`}>{label}</span></div></Link>;
    })}</div>
  </div>;
}
