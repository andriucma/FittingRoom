"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { VideoAsset } from "@/lib/types";

export function VideoPicker({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  const [videos, setVideos] = useState<VideoAsset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/videos", { signal: abort.signal }).then((r) => r.json()).then((d) => {
      setVideos(d.videos ?? []);
      if (!value && d.videos?.[0]) onChange(d.videos[0].id);
    }).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add(req: Promise<Response>, label: string) {
    setBusy(label); setError(null);
    try {
      const res = await req; const v = await res.json();
      if (!res.ok) throw new Error(v.error ?? res.statusText);
      setVideos((vs) => [v, ...vs.filter((x) => x.id !== v.id)]); onChange(v.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  const selected = videos.find((v) => v.id === value);
  return <div className="video-picker">
    <div className="video-preview">{selected?.preview ? <video key={selected.id} src={selected.preview} muted autoPlay loop playsInline /> : <Icon name="spin" width="36" height="36" />}</div>
    <div className="video-options"><p>Upload a video of yourself turning all the way around. Keep the camera still and your whole body in view.</p><div className="video-actions"><label className="fr-button dark" style={busy ? { pointerEvents: "none", opacity: .5 } : undefined}><Icon name="upload" width="16" height="16" />{busy === "upload" ? "Uploading…" : "Upload a video"}<input type="file" accept="video/*" className="sr-only" disabled={!!busy} onChange={(e) => { const f=e.target.files?.[0]; if (!f) return; const form=new FormData(); form.append("video",f); void add(fetch("/api/videos",{method:"POST",body:form}),"upload"); e.target.value=""; }} /></label><button className="fr-button" disabled={!!busy} onClick={() => void add(fetch("/api/videos/sample",{method:"POST"}),"sample")}>{busy === "sample" ? "Getting it ready…" : "Try a sample"}</button></div>{error && <p role="alert" className="notice error">{error}</p>}{videos.length > 0 && <div className="video-list" aria-label="Your recordings">{videos.map((v) => <button key={v.id} disabled={!!busy} aria-pressed={value === v.id} onClick={() => onChange(v.id)}>{v.name}<span className="muted"> · {new Date(v.createdAt).toLocaleDateString()}</span></button>)}</div>}</div>
  </div>;
}
