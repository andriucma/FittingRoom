"use client";
/* eslint-disable @next/next/no-img-element */

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Viewer360, type ViewerFrame } from "./Viewer360";
import { Journey } from "./Journey";
import { Icon } from "./Icon";
import type { Run, StepName, StepStatus } from "@/lib/types";

const STEP_LABEL: Record<StepName, string> = {
  angles: "Find your angles",
  tryon: "Style your outfit",
  framing: "Steady your look",
  spin: "Bring it full circle",
  omni: "A little movie magic",
};
const DOT: Record<StepStatus, string> = {
  pending: "bg-zinc-600", running: "bg-amber-400 animate-pulse", done: "bg-emerald-500", skipped: "bg-zinc-700", error: "bg-red-500",
};

export function RunView() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stop = false;
    const poll = async () => {
      const r = await fetch(`/api/runs/${id}`);
      const d = await r.json();
      if (stop) return;
      if (!r.ok) { setError(d.error); return; }
      setRun(d);
      if (d.status === "running") timer = setTimeout(poll, 1500);
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]);

  if (error) return <p className="p-6 text-red-400">{error}</p>;
  if (!run) return <p className="p-6 text-zinc-400">Loading…</p>;
  const viewerFrames: ViewerFrame[] = run.status === "running" ? []
    : run.frames.filter((f) => f.finalUrl).map((f) => ({ url: f.finalUrl!, origUrl: f.sourceUrl, angle: f.angle }));

  return (
    <div className="results-shell flex flex-col gap-6">
      <Journey current={3} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="page-heading"><p className="eyebrow"><Icon name="sparkle" width="14" height="14" /> THE WHOLE PICTURE</p><h1>{run.status === "done" ? "Hello, new favorite." : run.status === "running" ? "Your look is coming to life." : "Let’s finish your look."}</h1><p>{run.status === "done" ? "Take it for a spin. See yourself from every angle." : "We’re putting the pieces together, one angle at a time."}</p></div>
        <span className="text-xs muted">
          {run.status} · ${(run.cost.openaiUsd + run.cost.geminiUsd).toFixed(2)}
          {run.stats.rotationDeg ? ` · ${run.stats.rotationDeg}° turn` : ""}
        </span>
      </div>

      <ol className="grid gap-2 result-progress p-5 text-sm md:grid-cols-5">
        {(Object.keys(STEP_LABEL) as StepName[]).map((s) => {
          const st = run.steps[s];
          return (
            <li key={s} className="flex flex-col gap-1">
              <span className="flex items-center gap-2 font-medium"><span className={`h-2 w-2 rounded-full ${DOT[st.status]}`} />{STEP_LABEL[s]}</span>
              <span className="text-xs text-zinc-500">
                {st.total ? `${st.done ?? 0}/${st.total} · ` : ""}{({ pending: "Up next", running: "In progress…", done: "Ready", skipped: "Not included", error: "Needs a retry" } as const)[st.status]}
              </span>
            </li>
          );
        })}
      </ol>
      {(run.status === "error" || run.status === "interrupted") && (
        <div className="flex items-center gap-3 text-sm">
          {run.error && <p className="text-red-400">{run.error}</p>}
          <button className="fr-button primary" onClick={async () => {
            const r = await fetch(`/api/runs/${run.id}/resume`, { method: "POST" });
            if (r.ok) { setRun(await r.json()); setTimeout(() => location.reload(), 300); }
          }}>Retry from where it stopped</button>
        </div>
      )}

      {viewerFrames.length > 1 && (
        <section className="result-stage flex flex-wrap items-start justify-center gap-8">
          <Viewer360 key={run.updatedAt} frames={viewerFrames} />
          <div className="flex flex-col gap-4">
            {run.outputs.omniUrl && (
              <figure className="flex flex-col gap-1">
                <figcaption className="text-sm text-zinc-400">Your look in motion</figcaption>
                <video src={run.outputs.omniUrl} className="h-[60vh] rounded-xl bg-black" controls loop autoPlay muted playsInline />
                {run.outputs.omniCompareUrl && <a className="text-xs text-zinc-500 underline" href={run.outputs.omniCompareUrl} target="_blank">side-by-side with original</a>}
              </figure>
            )}
            {run.outputs.spinUrl && <a className="text-sm text-zinc-400 underline" href={run.outputs.spinUrl} target="_blank">Download 360° video</a>}
          </div>
        </section>
      )}

      <section className="result-frames flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">Every angle, all you</h2>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-12">
          {run.frames.map((f) => (
            <figure key={f.index} className="flex flex-col gap-1">
              <div className="relative aspect-[9/16] overflow-hidden rounded bg-zinc-900">
                {f.finalUrl ?? f.tryonUrl
                  ? <img src={(f.finalUrl ?? f.tryonUrl)!} alt="" className="h-full w-full object-cover" />
                  : f.sourceUrl && <img src={f.sourceUrl} alt="" className={`h-full w-full object-cover ${f.error ? "" : "opacity-40"}`} />}
                {!f.tryonUrl && !f.error && run.steps.tryon.status === "running" && <span className="absolute inset-0 grid place-items-center text-xs text-zinc-300">dressing…</span>}
              </div>
              <figcaption className="text-[10px] text-zinc-500">{Math.round(f.angle)}°{f.error ? <span className="text-red-400"> · failed</span> : ""}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}
