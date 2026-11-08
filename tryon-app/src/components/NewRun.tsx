"use client";
/* eslint-disable @next/next/no-img-element */

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProductPicker } from "./ProductPicker";
import { StoreBar } from "./StoreBar";
import { VideoPicker, recordingName } from "./VideoPicker";
import { Icon } from "./Icon";
import { Journey } from "./Journey";
import type { Background, Department, ProductSummary, RunInput, VideoAsset } from "@/lib/types";

const TITLES = ["Choose your recording", "Choose a top", "Choose bottoms", "Ready for your fitting?"];
const DRAFT_KEY = "fittingroom:outfit:v1";
type Draft = { videoId: string | null; top: ProductSummary | null; bottom: ProductSummary | null; step: number; storeId: number | null; department: Department; background: Background; stepDeg: number; model: string; resolution: "360p" | "720p" | "1080p" };

export function NewRun() {
  const router = useRouter();
  const params = useSearchParams();
  const initialVideo = params.get("video");
  const fresh = params.get("fresh");
  const choosingRecording = params.has("chooseRecording");
  const [videoId, setVideoId] = useState<string | null>(initialVideo);
  const [recording, setRecording] = useState<VideoAsset | null>(null);
  const [checkingVideo, setCheckingVideo] = useState(false);
  const [step, setStep] = useState(initialVideo ? 1 : 0);
  const [topSummary, setTopSummary] = useState<ProductSummary | null>(null);
  const [bottomSummary, setBottomSummary] = useState<ProductSummary | null>(null);
  const top = topSummary?.id ?? null;
  const bottom = bottomSummary?.id ?? null;
  const [focused, setFocused] = useState<Set<number>>(new Set());
  const onPreparing = useCallback((id: number) => setFocused((current) => { const next = new Set(current); next.delete(id); return next; }), []);
  const onFocused = useCallback((id: number) => setFocused((current) => new Set(current).add(id)), []);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [department, setDepartment] = useState<Department>("all");
  const [background, setBackground] = useState<Background>("original");
  const [stepDeg, setStepDeg] = useState(30);
  const [model, setModel] = useState("gpt-image-2.6-flare");
  const [resolution, setResolution] = useState<"360p" | "720p" | "1080p">("720p");
  const [starting, setStarting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    const restore = async () => {
      setHydrated(false); setStarting(false); setError(null); setFocused(new Set());
      try {
        const response = await fetch("/api/videos", { signal: abort.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Your recordings couldn’t load. Please try again.");
        let draft: Draft | null = null;
        try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null"); } catch {}
        if (fresh && sessionStorage.getItem("fittingroom:last-outfit") !== fresh) {
          draft = null;
          sessionStorage.removeItem(DRAFT_KEY);
          sessionStorage.setItem("fittingroom:last-outfit", fresh);
        }
        if (initialVideo && draft?.videoId !== initialVideo) draft = null;
        const id = initialVideo ?? draft?.videoId ?? null;
        const video = (data.videos as VideoAsset[]).find((v) => v.id === id) ?? null;
        if (abort.signal.aborted) return;
        setVideoId(video?.id ?? null); setRecording(video);
        setDepartment(draft?.department ?? video?.profile?.department ?? "all");
        if (draft && video) {
          setTopSummary(draft.top); setBottomSummary(draft.bottom);
          setStoreId(draft.storeId); setBackground(draft.background === "studio" ? "studio" : "original");
          setStepDeg([20, 30, 45, 60].includes(draft.stepDeg) ? draft.stepDeg : 30);
          setModel(draft.model === "gpt-image-2.6-sunburst" ? draft.model : "gpt-image-2.6-flare");
          setResolution(["360p", "720p", "1080p"].includes(draft.resolution) ? draft.resolution : "720p");
          setStep(video.check?.ok ? Math.max(1, Math.min(Number.isInteger(draft.step) ? draft.step : 1, draft.top ? draft.bottom ? 3 : 2 : 1)) : 0);
          for (const product of [draft.top, draft.bottom]) {
            if (!product?.id) continue;
            void fetch(`/api/products/${product.id}/focus`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: abort.signal })
              .then(async (r) => { if (!r.ok) throw new Error("A saved piece couldn’t be prepared. Select it in your outfit to choose another photo or piece."); if (!abort.signal.aborted) onFocused(product.id); }).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
          }
        } else {
          setTopSummary(null); setBottomSummary(null); setStoreId(null);
          setBackground("original"); setStepDeg(30); setModel("gpt-image-2.6-flare"); setResolution("720p");
          setStep(video?.check?.ok ? 1 : 0);
        }
        if (choosingRecording) setStep(0);
      } catch (e) { if (!abort.signal.aborted) { setError((e as Error).message); setStep(0); } }
      finally { if (!abort.signal.aborted) setHydrated(true); }
    };
    void restore();
    return () => abort.abort();
  }, [initialVideo, fresh, choosingRecording, onFocused]);

  useEffect(() => {
    if (!hydrated || starting) return;
    const draft: Draft = { videoId, top: topSummary, bottom: bottomSummary, step, storeId, department, background, stepDeg, model, resolution };
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {}
  }, [hydrated, starting, videoId, topSummary, bottomSummary, step, storeId, department, background, stepDeg, model, resolution]);
  useEffect(() => { if (hydrated) heading.current?.focus({ preventScroll: false }); }, [step, hydrated]);

  const onVideoReady = useCallback((video: VideoAsset) => {
    setVideoId(video.id); setRecording(video); setError(null);
    if (video.profile) setDepartment(video.profile.department);
  }, []);
  function chooseDepartment(dep: Department) {
    setDepartment(dep);
    if (videoId) void fetch(`/api/videos/${videoId}/profile`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ department: dep }) }).catch(() => {});
  }
  const videoReady = !!videoId && recording?.id === videoId && !!recording.check?.ok;
  const topReady = !!top && focused.has(top);
  const bottomReady = !!bottom && focused.has(bottom);
  const canContinue = !checkingVideo && (step === 0 ? videoReady : step === 1 ? videoReady && topReady : step === 2 ? videoReady && topReady && bottomReady : videoReady && topReady && bottomReady);
  const action = starting ? "Starting your fitting…" : checkingVideo ? "Checking recording…" : step === 0 ? "Use this recording" : step === 1 ? "Use this top" : step === 2 ? "Review outfit" : !topReady || !bottomReady ? "Preparing outfit…" : "Create my look";
  const hint = step === 0 && !videoReady && !checkingVideo ? "Choose a recording to continue." : step === 1 && !top ? "Choose one top to continue." : step === 2 && !bottom ? "Choose one pair of bottoms to continue." : null;

  async function start() {
    if (!videoId || !top || !bottom || !canContinue || starting) return;
    setStarting(true); setError(null);
    try {
      const input: RunInput = { videoId, top, bottom, background, stepDeg, model, quality: "medium", omni: { enabled: true, resolution } };
      const res = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "We couldn’t start your fitting. Please try again.");
      try { sessionStorage.removeItem(DRAFT_KEY); } catch {}
      router.push(`/runs/${data.id}`);
    } catch (e) { setError((e as Error).message); setStarting(false); }
  }

  return <div className="page-shell">
    <Journey current={2} />
    <header className="page-heading outfit-heading"><div><h1>Build your outfit.</h1></div></header>
    {!hydrated ? <div className="empty-state" role="status">Getting your fitting ready…</div> : <div className="fitting-layout">
      <aside className="outfit-summary" aria-label="Your fitting summary">
        <div className="summary-recording"><span className="field-label">Your recording</span><p><Icon name="camera" width="15" height="15" />{recording?.id === videoId ? recordingName(recording.name) : "Not selected"}</p>{step !== 0 && <button className="text-link" disabled={starting} onClick={() => { setError(null); setStep(0); }}>Change recording</button>}</div>
        <h2 className="summary-title">Your outfit <Icon name="hanger" width="17" height="17" /></h2>
        <div className="summary-pieces">{([topSummary, bottomSummary] as const).map((piece, i) => <button key={i} className={`summary-piece ${step === i + 1 ? "current" : ""}`} disabled={!videoReady || starting || (i === 1 && !topReady)} onClick={() => { setError(null); setStep(i + 1); }} aria-label={i === 0 ? "Edit selected top" : "Edit selected bottoms"} aria-current={step === i + 1 ? "step" : undefined}><span className="summary-piece-image">{piece ? <img src={piece.image} alt="" /> : <Icon name={i === 0 ? "shirt" : "hanger"} width="22" height="22" />}</span><span><small>{i === 0 ? "Top" : "Bottoms"}</small><strong>{piece?.title ?? "Not chosen yet"}</strong>{piece && <em>{piece.storeName}</em>}</span>{piece && (focused.has(piece.id) ? <Icon name="check" width="14" height="14" /> : <span className="preparing-dot" aria-label="Preparing garment" />)}</button>)}</div>
        {step !== 3 && topReady && bottomReady && <button className="text-link summary-review" disabled={starting} onClick={() => setStep(3)}>Review this outfit →</button>}
      </aside>
      <section className="fitting-card" aria-labelledby="step-title">
        <div className="fitting-card-body" key={step}>
          <header className="step-heading"><div><h2 id="step-title" ref={heading} tabIndex={-1}>{TITLES[step]}</h2></div><span className="step-tag">{["Recording", "Top", "Bottoms", "Review"][step]}</span></header>
          {step === 0 && <VideoPicker value={videoId} onChange={setVideoId} onReady={onVideoReady} onBusyChange={setCheckingVideo} />}
          {(step === 1 || step === 2) && <>
            <div className="selection-meta"><StoreBar value={storeId} onChange={setStoreId} /><div><span className="field-label">Department</span><div className="chips">{(["all", "womens", "mens"] as Department[]).map((dep) => <button key={dep} aria-pressed={department === dep} className={`chip ${department === dep ? "selected" : ""}`} onClick={() => chooseDepartment(dep)}>{dep === "mens" ? "Men" : dep === "womens" ? "Women" : "All clothing"}</button>)}</div></div></div>
            <ProductPicker key={step} kind={step === 1 ? "top" : "bottom"} storeId={storeId} department={department} value={step === 1 ? top : bottom} onChange={(id) => { if (!id) { if (step === 1) setTopSummary(null); else setBottomSummary(null); } }} onSelected={(piece) => { setError(null); if (step === 1) setTopSummary(piece); else setBottomSummary(piece); }} pairWith={step === 1 ? bottom : top} onFocused={onFocused} onPreparing={onPreparing} />
          </>}
          {step === 3 && <>
            <span className="field-label">Background</span><div className="background-options">{(["original", "studio"] as Background[]).map((b) => <button className="background-option" key={b} aria-pressed={background === b} onClick={() => setBackground(b)}><Icon name={background === b ? "check" : "camera"} width="16" height="16" /><span><strong>{b === "original" ? "My original background" : "Photo studio"}</strong><small>{b === "original" ? "Keep the room from your recording." : "Use a clean, softly lit backdrop."}</small></span></button>)}</div>
            <details className="advanced-settings"><summary>Quality & video settings</summary><div className="advanced-grid"><Field label="Angles"><select className="field-input" value={stepDeg} onChange={(e) => setStepDeg(Number(e.target.value))}>{[20, 30, 45, 60].map((d) => <option key={d} value={d}>{Math.ceil(360 / d)} views</option>)}</select></Field><Field label="Image detail"><select className="field-input" value={model} onChange={(e) => setModel(e.target.value)}><option value="gpt-image-2.6-flare">Standard</option><option value="gpt-image-2.6-sunburst">Detailed</option></select></Field><Field label="Smooth video resolution"><select className="field-input" value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>{["360p", "720p", "1080p"].map((r) => <option key={r}>{r}</option>)}</select></Field></div></details>
          </>}
          {error && <p role="alert" className="notice error mt-5">{error}</p>}
        </div>
        <div className="fitting-controls"><button className="text-link" disabled={starting || checkingVideo} onClick={() => { setError(null); if (step === 0) router.push("/"); else setStep(step - 1); }}>← {step === 0 ? "Record a new turn" : "Back"}</button><div className="next-action">{hint && <span className="next-hint">{hint}</span>}<button className="fr-button primary" disabled={!canContinue || starting} onClick={() => { if (step === 3) void start(); else { setStep(step + 1); if (step === 0 && videoId) router.replace(`/new?video=${encodeURIComponent(videoId)}`, { scroll: false }); } }}>{action}{!starting && !checkingVideo && <Icon name="arrow" width="16" height="16" />}</button></div></div>
      </section>
    </div>}
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label><span className="field-label">{label}</span>{children}</label>; }
