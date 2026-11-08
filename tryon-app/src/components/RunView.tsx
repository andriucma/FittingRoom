"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Viewer360, type ViewerFrame } from "./Viewer360";
import { Journey } from "./Journey";
import { Icon } from "./Icon";
import type { Run, StepName, StepStatus } from "@/lib/types";

const LABELS: Record<StepName, string> = { angles: "Find the angles", tryon: "Try on your pieces", framing: "Steady the view", spin: "Build the 360° view", omni: "Finish the video" };
const DOT: Record<StepStatus, string> = { pending: "bg-zinc-400", running: "bg-amber-500 animate-pulse", done: "bg-emerald-500", skipped: "bg-zinc-300", error: "bg-red-500" };

export function RunView() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/runs/${id}`, { signal: abort.signal }); const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "We couldn’t load this look.");
        if (abort.signal.aborted) return;
        setError(null); setRun(data);
        if (data.status === "running") timer = setTimeout(poll, 1500);
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [id, pollVersion]);

  if (error) return <div className="page-shell"><p className="notice error mt-8" role="alert">{error}</p><Link href="/runs" className="fr-button mt-5">Back to my looks</Link></div>;
  if (!run) return <div className="empty-state" role="status"><Icon name="hanger" /><p>Loading your look…</p></div>;
  const mediaReady = run.steps.framing.status === "done" || run.steps.framing.status === "skipped";
  const signature = JSON.stringify(mediaReady ? run.frames.filter((f) => f.finalUrl).map((f) => ({ url: f.finalUrl!, origUrl: f.sourceUrl, angle: f.angle })) : []);
  const readyCount = run.frames.filter((f) => f.finalUrl).length;
  const failed = run.status === "error" || run.status === "interrupted";
  const videoFailed = run.steps.omni.status === "error";
  const active = (Object.keys(LABELS) as StepName[]).find((s) => run.steps[s].status === "running");
  const progress = <ol className="grid gap-4 result-progress p-5 text-sm md:grid-cols-5">{(Object.keys(LABELS) as StepName[]).map((s) => {
    const st = run.steps[s]; return <li key={s} className="flex flex-col gap-1"><span className="flex items-center gap-2 font-medium"><span className={`h-2 w-2 rounded-full ${DOT[st.status]}`} />{LABELS[s]}</span><span className="text-xs muted">{st.total ? `${st.done ?? 0}/${st.total} · ` : ""}{({ pending: "Next", running: "Working…", done: "Done", skipped: "Not needed", error: "Retry needed" } as const)[st.status]}</span></li>;
  })}</ol>;
  return <div className="results-shell flex flex-col gap-6">
    <Journey current={3} />
    <header className="look-heading"><div><p className="eyebrow">MADE OF YOUR CHOICES.</p><h1>{run.status === "done" ? "Now that’s your look." : videoFailed ? "Your outfit is ready." : run.status === "running" ? "Putting your look together." : "Let’s finish your look."}</h1><p>{run.status === "done" ? "Turn it around. See how it moves." : videoFailed ? "The 360° view is ready. Your video needs another try." : active ? `${LABELS[active]}… You can leave this page; your fitting will keep running.` : "Your finished images are saved. Continue from the last step."}</p></div><span className={`status-pill ${failed ? "needs-retry" : ""}`}>{run.status === "done" ? "Ready" : failed ? "Paused" : "Creating"}</span></header>
    {run.status === "done" ? <details className="completion-details"><summary>Fitting details · ${(run.cost.openaiUsd + run.cost.geminiUsd).toFixed(2)} generation cost</summary>{progress}</details> : progress}
    {failed && <div className="retry-panel"><div><strong>{videoFailed ? "Keep your look. Finish the video." : "Pick up where you left off."}</strong><p>Completed steps will be reused.</p>{run.error && <details><summary>What happened?</summary><p>{run.error}</p></details>}</div><button className="fr-button primary" disabled={retrying} onClick={async () => {
      setRetrying(true); setRetryError(null);
      try { const response = await fetch(`/api/runs/${run.id}/resume`, { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Couldn’t resume this look."); setRun(data); setPollVersion((n) => n + 1); setRetrying(false); }
      catch (e) { setRetryError((e as Error).message); setRetrying(false); }
    }}>{retrying ? "Resuming…" : videoFailed ? "Retry video" : "Finish this look"}<Icon name="arrow" width="16" height="16" /></button>{retryError && <p className="notice error" role="alert">{retryError}</p>}</div>}
    {mediaReady && readyCount > 1 && <LookMedia signature={signature} run={run} />}
    {readyCount > 0 && <details className="angle-gallery"><summary>View all {readyCount} outfit angles</summary><div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-12 mt-4">{run.frames.filter((f) => f.finalUrl).map((f) => <figure key={f.index}><img src={f.finalUrl!} alt={`Your outfit at ${Math.round(f.angle)} degrees`} className="aspect-[9/16] w-full rounded-lg object-cover" loading="lazy" /><figcaption className="mt-1 text-[10px] muted">{Math.round(f.angle)}°</figcaption></figure>)}</div></details>}
    <div className="look-next"><Link href={`/new?video=${encodeURIComponent(run.input.videoId)}&fresh=${encodeURIComponent(run.id)}`} className="fr-button">Try another outfit <Icon name="hanger" width="16" height="16" /></Link><Link href="/runs" className="text-link">Back to my looks</Link></div>
  </div>;
}

function LookMedia({ signature, run }: { signature: string; run: Run }) {
  const frames = useMemo(() => JSON.parse(signature) as ViewerFrame[], [signature]);
  const [tab, setTab] = useState<"spin" | "video">("spin");
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoReady = !!run.outputs.omniUrl;
  useEffect(() => {
    if (tab === "video") void videoRef.current?.play().catch(() => {});
    else videoRef.current?.pause();
  }, [tab, videoReady]);
  return <section className="look-media" aria-label="Your outfit preview"><div className="media-tabs" role="tablist" aria-label="Preview type" onKeyDown={(e) => { if (videoReady && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); const next = e.key === "Home" ? "spin" : e.key === "End" ? "video" : tab === "spin" ? "video" : "spin"; setTab(next); document.getElementById(`${next}-tab`)?.focus(); } }}><button id="spin-tab" role="tab" tabIndex={tab === "spin" ? 0 : -1} aria-selected={tab === "spin"} aria-controls="spin-panel" onClick={() => setTab("spin")}>360° view</button><button id="video-tab" role="tab" tabIndex={tab === "video" ? 0 : -1} aria-selected={tab === "video"} aria-controls="video-panel" disabled={!videoReady} onClick={() => setTab("video")}>Smooth video{!videoReady ? run.steps.omni.status === "error" ? " · retry needed" : run.steps.omni.status === "skipped" ? " · not included" : " · creating" : ""}</button></div>
    <div className="result-stage" id="spin-panel" role="tabpanel" aria-labelledby="spin-tab" hidden={tab !== "spin"}><Viewer360 key={signature} frames={frames} active={tab === "spin"} /></div>
    <div className="result-stage video-panel" id="video-panel" role="tabpanel" aria-labelledby="video-tab" hidden={tab !== "video"}>{run.outputs.omniUrl && <video ref={videoRef} src={run.outputs.omniUrl} controls loop muted playsInline className="look-video" />}</div>
    <div className="media-downloads">{tab === "video" && run.outputs.omniUrl ? <a href={run.outputs.omniUrl} download className="text-link">Download smooth video ↓</a> : run.outputs.spinUrl ? <a href={run.outputs.spinUrl} download className="text-link">Download 360° video ↓</a> : <span className="muted text-xs">Drag or use the arrow keys to rotate.</span>}{tab === "video" && run.outputs.omniCompareUrl && <a href={run.outputs.omniCompareUrl} target="_blank" rel="noreferrer" className="text-link">Compare with original ↗</a>}</div>
  </section>;
}
