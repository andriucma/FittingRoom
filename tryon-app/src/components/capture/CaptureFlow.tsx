"use client";
/* eslint-disable @next/next/no-img-element */

import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { FillSynth } from "@/lib/capture/fillSynth";
import { bodyYaw, checkFraming, createPoseLandmarker, facingCamera, SKELETON, toCrop, TurnTracker } from "@/lib/capture/pose";
import type { VideoAsset, VideoCheck } from "@/lib/types";
import { TurnRing } from "./TurnRing";
import { Journey } from "../Journey";
import { Icon } from "../Icon";

type Stage = "intro" | "sound" | "starting" | "framing" | "facing" | "countdown" | "recording" | "uploading" | "verifying" | "done" | "error";

const HOLD_FRAMING_MS = 1200;
const HOLD_FACING_MS = 800;
const DONE_DEG = 340;             // stop here...
const DONE_DEG_FACING = 330;      // ...or here if they're already facing the camera again (server needs ≥320° with the heavy model)
const MAX_RECORD_MS = 30_000;
const GLUG_EVERY_DEG = 6;

function pickMime(): string {
  for (const m of ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export function CaptureFlow() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraSession = useRef(0);
  const poseRef = useRef<PoseLandmarker | null>(null);
  const synthRef = useRef<FillSynth | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunks = useRef<Blob[]>([]);
  const loop = useRef({ raf: 0, okSince: 0, facingSince: 0, recStart: 0, lastSeen: 0, lastGlugDeg: 0, lastChimeSeg: 0 });
  const tracker = useRef(new TurnTracker());
  const stageRef = useRef<Stage>("intro");
  const testRef = useRef(false);
  const analyzeRef = useRef<() => void>(() => {});
  const next = () => { loop.current.raf = requestAnimationFrame(() => analyzeRef.current()); };

  const [stage, setStageState] = useState<Stage>("intro");
  const [message, setMessage] = useState("");
  const [degrees, setDegrees] = useState(0);
  const [count, setCount] = useState(3);
  const [muted, setMuted] = useState(false);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<VideoAsset | null>(null);
  const [check, setCheck] = useState<VideoCheck | null>(null);

  const setStage = useCallback((s: Stage) => { stageRef.current = s; setStageState(s); }, []);

  const stopCamera = useCallback(() => {
    cameraSession.current += 1;
    cancelAnimationFrame(loop.current.raf);
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    synthRef.current?.stopBed();
  }, []);

  useEffect(() => () => { stopCamera(); synthRef.current?.close(); poseRef.current?.close(); }, [stopCamera]);

  // ---------- audio ----------
  async function enableSound() {
    synthRef.current ??= new FillSynth();
    await synthRef.current.resume();
    synthRef.current.demo();
  }

  // ---------- recording ----------
  const upload = useCallback(async (blob: Blob, mime: string) => {
    setStage("uploading");
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const form = new FormData();
    form.append("video", new File([blob], `capture-${Date.now()}.${ext}`, { type: mime.split(";")[0] }));
    try {
      const up = await fetch("/api/videos", { method: "POST", body: form });
      const v = await up.json();
      if (!up.ok) throw new Error(v.error ?? up.statusText);
      setVideo(v);
      setStage("verifying");
      const vr = await fetch(`/api/videos/${v.id}/verify`, { method: "POST" });
      const c = await vr.json();
      if (!vr.ok) throw new Error(c.error ?? vr.statusText);
      setCheck(c);
      setStage("done");
    } catch (e) {
      setError((e as Error).message);
      setStage("error");
    }
  }, [setStage]);

  const finishRecording = useCallback(() => {
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") return;
    synthRef.current?.complete();
    setMessage("Got it! Processing your spin…");
    setTimeout(() => rec.state !== "inactive" && rec.stop(), 500); // a few frames past the finish
  }, []);

  const startRecording = useCallback(() => {
    const stream = streamRef.current!;
    const mime = pickMime();
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
    chunks.current = [];
    rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    rec.onstop = () => {
      stopCamera();
      void upload(new Blob(chunks.current, { type: rec.mimeType || mime }), rec.mimeType || mime || "video/webm");
    };
    rec.start(250);
    if (testRef.current) void videoRef.current?.play();
    recRef.current = rec;
    tracker.current = new TurnTracker();
    Object.assign(loop.current, { recStart: performance.now(), lastGlugDeg: 0, lastChimeSeg: 0 });
    synthRef.current?.startBed();
    setDegrees(0);
    setStage("recording");
    setMessage("Turn slowly in place, all the way around");
  }, [setStage, stopCamera, upload]);

  const countdown = useCallback(() => {
    setStage("countdown");
    if (testRef.current) videoRef.current?.pause();
    let n = 3;
    setCount(n);
    synthRef.current?.tick();
    const id = setInterval(() => {
      n -= 1;
      if (n > 0) {
        setCount(n);
        synthRef.current?.tick();
      } else {
        clearInterval(id);
        countdownTimer.current = null;
        synthRef.current?.tick(true);
        startRecording();
      }
    }, 900);
    countdownTimer.current = id;
  }, [setStage, startRecording]);

  // ---------- per-frame analysis ----------
  const draw = useCallback((lms: { x: number; y: number }[] | undefined, good: boolean) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    if (cv.width !== Math.round(r.width)) cv.width = Math.round(r.width);
    if (cv.height !== Math.round(r.height)) cv.height = Math.round(r.height);
    const g = cv.getContext("2d")!;
    g.clearRect(0, 0, cv.width, cv.height);
    if (!lms) return;
    g.strokeStyle = good ? "rgba(52,211,153,0.85)" : "rgba(255,255,255,0.6)";
    g.lineWidth = 3;
    g.lineCap = "round";
    for (const [a, b] of SKELETON) {
      g.beginPath();
      g.moveTo(lms[a].x * cv.width, lms[a].y * cv.height);
      g.lineTo(lms[b].x * cv.width, lms[b].y * cv.height);
      g.stroke();
    }
  }, []);

  const analyze = useCallback(() => {
    const v = videoRef.current;
    const pose = poseRef.current;
    if (!v || !pose || v.readyState < 2) { next(); return; }
    const now = performance.now();
    const res = pose.detectForVideo(v, now);
    const raw = res.landmarks?.[0];
    const lms = raw ? toCrop(raw, v.videoWidth, v.videoHeight) : undefined;
    const st = stageRef.current;
    const L = loop.current;
    if (lms) L.lastSeen = now;

    if (st === "framing") {
      const c = checkFraming(lms);
      setMessage(c.message);
      if (c.ok) {
        L.okSince ||= now;
        if (now - L.okSince > HOLD_FRAMING_MS) { L.facingSince = 0; setStage("facing"); }
      } else L.okSince = 0;
      draw(lms, c.ok);
    } else if (st === "facing") {
      const c = checkFraming(lms);
      const facing = c.ok && facingCamera(lms);
      setMessage(!c.ok ? c.message : facing ? "Great — hold still…" : "Face the camera, arms relaxed slightly away from your sides");
      if (facing) {
        L.facingSince ||= now;
        if (now - L.facingSince > HOLD_FACING_MS) countdown();
      } else L.facingSince = 0;
      draw(lms, facing);
    } else if (st === "recording") {
      const deg = tracker.current.update(bodyYaw(res));
      setDegrees(deg);
      const synth = synthRef.current;
      synth?.setLevel(Math.min(1, deg / 360));
      if (deg - L.lastGlugDeg >= GLUG_EVERY_DEG) { L.lastGlugDeg = deg; synth?.glug(Math.min(1, deg / 360)); }
      const seg = Math.floor(deg / 30);
      if (seg > L.lastChimeSeg) { L.lastChimeSeg = seg; synth?.chime(seg / 12); }
      if (now - L.lastSeen > 1500) setMessage("We lost you — stay inside the frame");
      else if (deg < 30) setMessage("Turn slowly in place, all the way around");
      else if (deg < 300) setMessage("Keep turning…");
      else setMessage("Almost there — back to facing the camera");
      const elapsed = now - L.recStart;
      if (deg >= DONE_DEG || (deg >= DONE_DEG_FACING && facingCamera(lms)) || elapsed > MAX_RECORD_MS) {
        finishRecording();
        draw(lms, true);
        return; // stop analyzing; recorder.onstop takes over
      }
      draw(lms, true);
    } else {
      draw(lms, false);
    }
    next();

  }, [countdown, draw, finishRecording, setStage]);
  useEffect(() => { analyzeRef.current = analyze; }, [analyze]);

  async function startCamera() {
    stopCamera();
    const session = cameraSession.current;
    setStage("starting");
    setError(null);
    setMessage("Starting your camera…");
    try {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error("We couldn’t check recording setup. Please refresh and try again.");
      const health = await response.json();
      if (session !== cameraSession.current) return;
      if (!health.mediaTools?.ffmpeg?.ok || !health.mediaTools?.ffprobe?.ok) {
        throw new Error("Video processing is not ready on this computer. Install ffmpeg, then restart FittingRoom before recording.");
      }
      if (!health.localModels?.ok) {
        throw new Error("Recording verification is not running. Start the local Python service with the app, then try again.");
      }
      synthRef.current ??= new FillSynth();
      await synthRef.current.resume();
      if (session !== cameraSession.current) return;
      synthRef.current.setMuted(muted);
      const v = videoRef.current!;
      // Dev/QA only: ?testVideo=<url> feeds a video file through the exact same pipeline instead of the camera.
      const testVideo = process.env.NODE_ENV !== "production" ? new URLSearchParams(window.location.search).get("testVideo") : null;
      if (testVideo) {
        testRef.current = true;
        v.src = testVideo;
        v.muted = true;
        await v.play();
        streamRef.current = (v as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        });
        if (session !== cameraSession.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        v.srcObject = stream;
        await v.play();
      }
      if (session !== cameraSession.current) return;
      setMessage("Loading pose model…");
      const pose = poseRef.current ?? await createPoseLandmarker();
      if (session !== cameraSession.current) {
        if (pose !== poseRef.current) pose.close();
        return;
      }
      poseRef.current = pose;
      loop.current.okSince = 0;
      setStage("framing");
      next();
    } catch (e) {
      if (session !== cameraSession.current) return;
      stopCamera();
      const detail = e instanceof Error ? e.message : typeof e === "string" ? e : "";
      setError((e as Error)?.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access and try again." : detail || "We couldn’t start your camera and body tracking. Refresh the page and try again.");
      setStage("error");
    }
  }

  function reset() {
    stopCamera();
    setVideo(null);
    setCheck(null);
    setDegrees(0);
    setError(null);
    setStage("intro");
  }

  // Restart the capture from the framing step WITHOUT tearing the camera down.
  // Aborts any in-progress recording (discarded, not uploaded) and cancels a running
  // countdown, then returns to framing. The existing per-frame analysis loop is already
  // running during the live stages, so it picks up the new stage and the preview keeps
  // rendering — we deliberately avoid a getUserMedia re-acquire, which can leave the
  // camera light on but show no video after stopping and re-requesting the stream.
  function restart() {
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;          // drop the upload-on-stop handler so the partial clip is discarded
      try { rec.stop(); } catch {}
    }
    recRef.current = null;
    chunks.current = [];
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
    synthRef.current?.stopBed();
    tracker.current = new TurnTracker();
    Object.assign(loop.current, { okSince: 0, facingSince: 0, recStart: 0, lastGlugDeg: 0, lastChimeSeg: 0 });
    setDegrees(0);
    if (streamRef.current && stageRef.current !== "starting") {
      setStage("framing");        // the running loop transitions to framing; the live stream stays on
    } else {
      void startCamera();         // no live stream yet — acquire from scratch
    }
  }

  const live = ["starting", "framing", "facing", "countdown", "recording"].includes(stage);
  const mirror = facingMode === "user" ? "-scale-x-100" : "";

  return (
    <div className="capture-flow">
      <Journey current={1} />
      {stage === "intro" && (
        <>
          <header className="workspace-heading"><h1>Your fitting room.</h1><p>Start with a full-turn video. Then choose your clothes.</p></header>
          <section className="capture-workspace" aria-label="Start a fitting">
            <div className="workspace-record">
              <button className="workspace-camera" onClick={startCamera} aria-label="Record a turn">
                <span className="workspace-card-label">CAPTURE</span>
                <span className="camera-viewfinder" aria-hidden="true"><span className="viewfinder-corners" /><Icon name="camera" width="36" height="36" /></span>
                <span className="workspace-card-action"><span>Record a turn</span><span className="workspace-arrow"><Icon name="arrow" width="21" height="21" /></span></span>
              </button>
              <button className="workspace-settings" onClick={() => setStage("sound")}>Camera &amp; sound settings</button>
            </div>
            <div className="workspace-alternatives">
              <Link href="/new?chooseRecording=1" className="workspace-tile upload-tile"><span className="workspace-tile-top"><Icon name="upload" width="24" height="24" /><Icon name="arrow" width="18" height="18" /></span><span><strong>Use a recording</strong><small>Upload a video or choose a saved one.</small></span></Link>
              <Link href="/runs" className="workspace-tile looks-tile"><span className="workspace-tile-top"><Icon name="hanger" width="24" height="24" /><Icon name="arrow" width="18" height="18" /></span><span><strong>My looks</strong></span></Link>
            </div>
          </section>
          <details className="capture-instructions"><summary>Recording tips</summary><ol>
            {[
              ["Set up the camera", "Prop your phone or laptop at about waist height, in good even light."],
              ["Step back", "Stand 2–3 m away so you’re visible from head to toe."],
              ["Face the camera", "Stand still with your arms relaxed slightly away from your sides."],
              ["Take a slow turn", "Turn all the way around in about 5–8 seconds. We’ll stop recording automatically."],
            ].map(([title, description], i) => <li key={title}><span>{i + 1}</span><span><strong>{title}.</strong> {description}</span></li>)}
          </ol></details>
        </>
      )}

      {stage === "sound" && (
        <section className="capture-panel flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Camera &amp; sound</h1>
          <p className="text-zinc-300">
            Chimes guide your turn while you face away. Hear a preview or adjust your camera before recording.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button className="fr-button" onClick={enableSound}>▶ Play sound check</button>
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} /> Record without sound
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input type="checkbox" checked={facingMode === "environment"} onChange={(e) => setFacingMode(e.target.checked ? "environment" : "user")} />
            Use the back camera on my phone
          </label>
          <div className="flex gap-3">
            <button className="fr-button primary" onClick={startCamera}>Start camera</button>
            <button className="text-sm text-zinc-400" onClick={() => setStage("intro")}>Back</button>
          </div>
        </section>
      )}

      <div className={live ? "live-capture flex flex-col items-center gap-4" : "hidden"}>
        <div className="relative aspect-[9/16] h-[72vh] overflow-hidden rounded-2xl bg-black">
          <video ref={videoRef} className={`h-full w-full object-cover ${mirror}`} muted playsInline />
          <canvas ref={canvasRef} className={`pointer-events-none absolute inset-0 h-full w-full ${mirror}`} />
          <div className={`pointer-events-none absolute inset-3 rounded-xl border-2 transition-colors ${stage === "facing" || stage === "countdown" || stage === "recording" ? "border-emerald-400/70" : "border-white/30"}`} />
          {stage === "countdown" && <div className="absolute inset-0 grid place-items-center text-8xl font-semibold text-white drop-shadow-lg">{count}</div>}
          {stage === "recording" && (
            <div className="absolute right-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> REC
            </div>
          )}
          {(stage === "recording") && <div className="absolute bottom-20 left-1/2 -translate-x-1/2"><TurnRing degrees={degrees} /></div>}
          <div className="absolute inset-x-0 bottom-4 flex justify-center px-4">
            <span className="rounded-full bg-black/70 px-4 py-2 text-center text-sm font-medium">{message}</span>
          </div>
        </div>
        <div className="flex gap-4 text-sm text-zinc-400">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={muted} onChange={(e) => { setMuted(e.target.checked); synthRef.current?.setMuted(e.target.checked); }} /> Mute
          </label>
          <button onClick={restart} className="underline">Restart</button>
        </div>
      </div>

      {(stage === "uploading" || stage === "verifying") && (
        <section className="capture-loader" aria-live="polite">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <p>{stage === "uploading" ? "Uploading your spin…" : "Checking your spin with the pose model…"}</p>
        </section>
      )}

      {stage === "done" && check && video && (
        <section className="capture-panel flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">{check.ok ? "Looks great!" : "Let's try that again"}</h1>
          <p className="text-zinc-300">
            We measured a {Math.round(check.rotationDeg)}° turn ({check.direction === "right" ? "to your right" : "to your left"}) and
            captured {check.frames} angles.
          </p>
          {!!check.issues.length && (
            <ul className="list-disc pl-5 text-amber-300">{check.issues.map((i) => <li key={i}>{i}</li>)}</ul>
          )}
          {check.contactSheet && <img src={check.contactSheet} alt="Captured angles" className="w-full rounded-lg" />}
          <div className="flex gap-3">
            {check.ok
              ? <button className="fr-button primary" onClick={() => router.push(`/new?video=${video.id}`)}>Choose your outfit →</button>
              : <button className="fr-button primary" onClick={reset}>Record again</button>}
            {check.ok
              ? <button className="text-sm text-zinc-400 underline" onClick={reset}>Record again</button>
              : <button className="text-sm text-zinc-400 underline" onClick={() => router.push(`/new?video=${video.id}`)}>Use it anyway</button>}
          </div>
        </section>
      )}

      {stage === "error" && (
        <section className="capture-panel flex flex-col gap-3" role="alert">
          <h1>Let&apos;s try that again.</h1>
          <p className="notice error">{error || "Something interrupted your recording. Please try again."}</p>
          <button className="fr-button primary self-start" onClick={reset}>Start over</button>
        </section>
      )}
    </div>
  );
}
