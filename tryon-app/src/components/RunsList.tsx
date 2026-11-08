"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { Run } from "@/lib/types";

export function RunsList() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const abort=new AbortController(); fetch("/api/runs",{signal:abort.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error ?? "Couldn’t load your looks.");setRuns(d.runs??[]);}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort(); }, []);
  return <div className="page-shell"><header className="page-heading mt-8"><p className="eyebrow"><Icon name="hanger" width="14" height="14" /> YOUR PERSONAL LOOKBOOK</p><h1>A little wardrobe inspiration.</h1><p>All your fittings, ready for another look.</p></header>{error && <p className="notice error" role="alert">{error}</p>}{!runs && !error && <div className="empty-state" role="status">Getting your looks ready…</div>}{runs?.length === 0 && <div className="fitting-card empty-state"><span className="empty-icon"><Icon name="hanger" width="32" height="32" /></span><h2 className="text-xl text-foreground">Your next favorite look starts here.</h2><p>Try on your first outfit and we&apos;ll save it in your lookbook.</p><Link href="/" className="fr-button primary">Find my fit <Icon name="arrow" width="16" height="16" /></Link></div>}
    <div className="looks-grid">{runs?.map((r) => {const thumb=r.frames.find(f=>f.finalUrl)?.finalUrl??r.frames[0]?.sourceUrl;return <Link key={r.id} href={`/runs/${r.id}`} className="look-card"><div className="look-card-image">{thumb?<img src={thumb} alt={`Your fitting from ${new Date(r.createdAt).toLocaleDateString()}`} loading="lazy" />:<Icon name="hanger" width="36" height="36" />}</div><div className="look-meta"><div><h2>Look {r.id.slice(-6)}</h2><p className="mt-1">{new Date(r.createdAt).toLocaleDateString()} · {r.frames.length} angles</p></div><span className="status-pill">{r.status==="done"?"Ready to view":r.status==="running"?"Creating…":"Needs a retry"}</span></div></Link>;})}</div>
  </div>;
}
