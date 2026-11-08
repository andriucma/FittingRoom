"use client";

import { useEffect, useRef, useState } from "react";
import { VideoOperation } from "@/lib/capture/videoOperation";
import { Icon } from "./Icon";
import type { VideoAsset, VideoCheck } from "@/lib/types";

export function recordingName(name: string) {
  return /^capture-\d+\./.test(name) ? "Camera recording" : name.startsWith("sample:") ? "Sample recording" : name;
}

export function VideoPicker({ value, onChange, onReady, onBusyChange }: {
  value: string | null; onChange: (id: string | null) => void;
  onReady?: (video: VideoAsset) => void; onBusyChange?: (busy: boolean) => void;
}) {
  const operation = useRef<VideoOperation | null>(null);
  useEffect(() => () => { operation.current?.cancel(); onBusyChange?.(false); }, [onBusyChange]);
  const [videos, setVideos] = useState<VideoAsset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/videos", { signal: abort.signal }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Your recordings couldn’t load. Try uploading a video.");
      if (!abort.signal.aborted) setVideos(data.videos ?? []);
    }).catch((e) => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);

  function save(video: VideoAsset) { setVideos((items) => [video, ...items.filter((v) => v.id !== video.id)]); }

  function begin() {
    operation.current?.cancel();
    const op = new VideoOperation(); operation.current = op;
    return op;
  }
  function cancel() {
    operation.current?.cancel(); operation.current = null;
    setBusy(null); setError(null); onBusyChange?.(false); onChange(null);
  }
  async function choose(video: VideoAsset, op = begin()) {
    if (!op.active) return;
    setError(null); onChange(video.id); save(video);
    if (video.check?.ok) { onReady?.(video); op.finish(); return; }
    setBusy("check"); onBusyChange?.(true);
    try {
      const response = await op.fetch(`/api/videos/${video.id}/verify`, { method: "POST" });
      const check = await response.json() as VideoCheck & { error?: string };
      if (!op.active || operation.current !== op) return;
      if (!response.ok) throw new Error(check.error ?? "We couldn’t check this turn. Please try again.");
      const checked = { ...video, check }; save(checked); onReady?.(checked);
      if (!check.ok) throw new Error(check.issues?.[0] ?? "This recording needs a full turn. Record again with your whole body in view.");
    } catch (e) { if (op.active && operation.current === op) setError((e as Error).message); }
    finally { if (operation.current === op) { op.finish(); setBusy(null); onBusyChange?.(false); } }
  }

  async function add(request: (op: VideoOperation) => Promise<Response>, label: string) {
    const op = begin();
    onChange(null); setBusy(label); setError(null); onBusyChange?.(true);
    try {
      const res = await request(op); const video = await res.json();
      if (!op.active || operation.current !== op) return;
      if (!res.ok) throw new Error(video.error ?? "We couldn’t upload that recording.");
      await choose(video, op);
    } catch (e) { if (op.active && operation.current === op) setError((e as Error).message); }
    finally { if (operation.current === op) { op.finish(); setBusy(null); onBusyChange?.(false); } }
  }

  const selected = videos.find((v) => v.id === value);
  return <div className="video-picker">
    <div className="video-preview">{selected?.preview ? <video key={selected.id} src={selected.preview} muted autoPlay loop playsInline aria-label="Selected recording preview" /> : <Icon name="spin" width="36" height="36" />}</div>
    <div className="video-options">
      <p>Choose a saved recording or upload a video of one full turn, with your whole body in view.</p>
      <label className="fr-button dark" style={busy ? { pointerEvents: "none", opacity: .5 } : undefined}><Icon name="upload" width="16" height="16" />{busy === "upload" ? "Uploading…" : "Upload video"}<input type="file" accept="video/*" className="sr-only" disabled={!!busy} onChange={(e) => { const file=e.target.files?.[0]; if (!file) return; const form=new FormData(); form.append("video",file); void add((op) => op.fetch("/api/videos",{method:"POST",body:form}),"upload"); e.target.value=""; }} /></label>
      <p className="recording-status" role="status">{busy === "check" ? "Checking your full turn…" : selected?.check?.ok ? <><Icon name="check" width="14" height="14" /> Full turn checked · {selected.check.frames} angles</> : loading ? "Loading saved recordings…" : ""}</p>
      {busy && <button className="text-link" onClick={cancel}>Cancel</button>}
      {error && <p role="alert" className="notice error">{error}</p>}
      {videos.length > 0 && <div className="video-list" aria-label="Saved recordings">{videos.map((v) => <button key={v.id} disabled={!!busy} aria-pressed={value === v.id} onClick={() => void choose(v)}><span>{recordingName(v.name)}</span><span className="muted">{new Date(v.createdAt).toLocaleDateString()} · {v.check?.ok ? "Ready" : "Check turn"}</span></button>)}</div>}
      <details className="sample-option"><summary>Just trying it out?</summary><button className="text-link" disabled={!!busy} onClick={() => void add((op) => op.fetch("/api/videos/sample",{method:"POST"}),"sample")}>{busy === "sample" ? "Loading sample…" : "Try a sample recording"}</button></details>
    </div>
  </div>;
}
