"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ProductPicker } from "./ProductPicker";
import { StoreBar } from "./StoreBar";
import { VideoPicker } from "./VideoPicker";
import { Icon } from "./Icon";
import { Journey } from "./Journey";
import type { Background, Department, ProductSummary, RunInput, VideoAsset } from "@/lib/types";

const FRAME_COST = 0.072;
const OMNI_PER_S = { "360p": 0.023, "720p": 0.07, "1080p": 0.104 } as const;
const STEPS = ["Your recording", "Pick a top", "Pick your bottoms", "The final touches"];
const DESCRIPTIONS = ["A little turn is all we need to get started.", "Find a piece that feels like you.", "Bring your outfit together with the perfect pair.", "One last look, then let’s make it yours."];

export function NewRun() {
  const router = useRouter();
  const initialVideo = useSearchParams().get("video");
  const [videoId, setVideoId] = useState<string | null>(initialVideo);
  const [step, setStep] = useState(initialVideo ? 1 : 0);
  const [top, setTop] = useState<number | null>(null);
  const [bottom, setBottom] = useState<number | null>(null);
  const [topSummary, setTopSummary] = useState<ProductSummary | null>(null);
  const [bottomSummary, setBottomSummary] = useState<ProductSummary | null>(null);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [department, setDepartment] = useState<Department>("all");
  const [background, setBackground] = useState<Background>("original");
  const [stepDeg, setStepDeg] = useState(30);
  const [model, setModel] = useState("gpt-image-2.6-flare");
  const [resolution, setResolution] = useState<"360p" | "720p" | "1080p">("720p");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step]);
  useEffect(() => {
    if (!videoId) return;
    const abort = new AbortController();
    fetch("/api/videos", { signal: abort.signal }).then((r) => r.json()).then((d) => {
      const v = (d.videos as VideoAsset[]).find((x) => x.id === videoId);
      if (v?.profile) setDepartment(v.profile.department);
    }).catch(() => {});
    return () => abort.abort();
  }, [videoId]);

  function chooseDepartment(dep: Department) {
    setDepartment(dep);
    if (videoId) void fetch(`/api/videos/${videoId}/profile`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ department: dep }) }).catch(() => {});
  }
  const frames = Math.ceil(360 / stepDeg);
  const estimate = frames * FRAME_COST * (model.includes("sunburst") ? 1.5 : 1) + (background === "studio" ? 0.12 : 0) + 5 * OMNI_PER_S[resolution];
  const canVisit = (i: number) => i === 0 || (!!videoId && (i === 1 || (!!top && (i === 2 || !!bottom))));
  const canContinue = step === 0 ? !!videoId : step === 1 ? !!top : step === 2 ? !!bottom : !!videoId && !!top && !!bottom;

  async function start() {
    if (!videoId || !top || !bottom || starting) return;
    setStarting(true);
    setError(null);
    try {
      const input: RunInput = { videoId, top, bottom, background, stepDeg, model, quality: "medium", omni: { enabled: true, resolution } };
      const res = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "We couldn’t start your fitting. Please try again.");
      router.push(`/runs/${d.id}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  }

  return <div className="page-shell">
    <Journey current={2} />
    <header className="page-heading"><p className="eyebrow"><Icon name="hanger" width="14" height="14" /> A LITTLE MIX. A LITTLE MATCH.</p><h1>Let&apos;s put a look together.</h1><p>Your favorite stores. Your own style. One piece at a time.</p></header>
    <div className="fitting-layout">
      <aside className="fitting-sidebar"><ol aria-label="Outfit steps">{STEPS.map((title, i) => <li key={title}><button disabled={!canVisit(i) || starting} aria-current={step === i ? "step" : undefined} onClick={() => setStep(i)}><span>{i < step ? <Icon name="check" width="12" height="12" /> : `0${i + 1}`}</span><span>{title}</span></button></li>)}</ol><div className="sidebar-note"><Icon name="spin" /><h3>Made to move with you.</h3><p>Every fitting includes a 360° view and a smooth video, so you can see the whole outfit.</p></div></aside>
      <section className="fitting-card" aria-labelledby="step-title">
        <div className="fitting-card-body" key={step}>
          <header className="step-heading"><div><h2 id="step-title" ref={heading} tabIndex={-1}>{STEPS[step]}</h2><p>{DESCRIPTIONS[step]}</p></div><span className="step-tag">{step + 1} of 4</span></header>
          {step === 0 && <VideoPicker value={videoId} onChange={setVideoId} />}
          {(step === 1 || step === 2) && <>
            <div className="selection-meta"><StoreBar value={storeId} onChange={setStoreId} /><div><span className="field-label">Shop for</span><div className="chips">{(["all", "womens", "mens"] as Department[]).map((d) => <button key={d} aria-pressed={department === d} className={`chip ${department === d ? "selected" : ""}`} onClick={() => chooseDepartment(d)}>{d === "mens" ? "Men" : d === "womens" ? "Women" : "Everyone"}</button>)}</div></div></div>
            <ProductPicker key={step} kind={step === 1 ? "top" : "bottom"} storeId={storeId} department={department} value={step === 1 ? top : bottom} onChange={step === 1 ? setTop : setBottom} onSelected={step === 1 ? setTopSummary : setBottomSummary} />
          </>}
          {step === 3 && <>
            <div className="review-grid">{([topSummary, bottomSummary] as const).map((p, i) => <div className="review-item" key={i}><span className="field-label">{i === 0 ? "Your top" : "Your bottoms"}</span><h3>{p?.title ?? "Selected piece"}</h3><p>{p?.storeName}</p><button className="text-link mt-3" onClick={() => setStep(i + 1)}>Change piece</button></div>)}</div>
            <span className="field-label">Set the scene</span><div className="background-options">{(["original", "studio"] as Background[]).map((b) => <button className="background-option" key={b} aria-pressed={background === b} onClick={() => setBackground(b)}><span className="mt-0.5">{background === b ? <Icon name="check" width="16" height="16" /> : <Icon name="camera" width="16" height="16" />}</span><span><strong>{b === "original" ? "Keep my space" : "Photo studio"}</strong><small>{b === "original" ? "Your own background, with a steady view." : "A clean backdrop. All eyes on your outfit."}</small></span></button>)}</div>
            <details className="advanced-settings"><summary>Customize quality & video</summary><div className="advanced-grid"><Field label="Angles"><select className="field-input" value={stepDeg} onChange={(e) => setStepDeg(Number(e.target.value))}>{[20, 30, 45, 60].map((d) => <option key={d} value={d}>{Math.ceil(360 / d)} views · {d}° apart</option>)}</select></Field><Field label="Image detail"><select className="field-input" value={model} onChange={(e) => setModel(e.target.value)}><option value="gpt-image-2.6-flare">Standard · Flare</option><option value="gpt-image-2.6-sunburst">Detailed · Sunburst</option></select></Field><Field label="Smooth video resolution"><select className="field-input" value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>{["360p", "720p", "1080p"].map((r) => <option key={r}>{r}</option>)}</select></Field></div></details>
            <p className="price-note"><strong>≈ ${estimate.toFixed(2)}</strong> estimated generation cost<br />Includes your stabilized 360° look and smooth video.</p>
          </>}
          {error && <p role="alert" className="notice error mt-5">{error}</p>}
        </div>
        <div className="fitting-controls"><button className="text-link" disabled={starting} onClick={() => step === 0 ? router.push("/") : setStep(step - 1)}>← {step === 0 ? "Record instead" : "Back"}</button><button className="fr-button primary" disabled={!canContinue || starting} onClick={() => step === 3 ? void start() : setStep(step + 1)}>{starting ? "Creating your look…" : step === 3 ? "Create my look" : "Continue"}{!starting && <Icon name="arrow" width="16" height="16" />}</button></div>
      </section>
    </div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label><span className="field-label">{label}</span>{children}</label>;
}
