"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ViewerFrame = { url: string; origUrl?: string | null; angle: number };

const DRAG_TURN = 1.4;    // stage widths of drag for one full turn
const FRICTION_MS = 320;  // inertia decay
const MAX_FLING = 0.9;    // deg/ms cap on release velocity
const AUTO_DEG_PER_S = 40;

function load(src: string): Promise<HTMLImageElement> {
  // Wait on onload, not img.decode(): decode() can stall forever in background tabs.
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

function drawCover(g: CanvasRenderingContext2D, img: HTMLImageElement | null, alpha: number) {
  if (!img) return;
  const { width: cw, height: ch } = g.canvas;
  const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  g.globalAlpha = alpha;
  g.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
}

/** Drag-to-rotate 360° viewer: frames placed at their body angle, momentum, seamless loop, crossfade.
 *  Give it a `key` that changes with the frame set; it loads its frames once per mount. */
export function Viewer360({ frames }: { frames: ViewerFrame[] }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const tryonRef = useRef<HTMLCanvasElement>(null);
  const origRef = useRef<HTMLCanvasElement>(null);
  const seq = useRef<{ deg: number; img: HTMLImageElement; orig: HTMLImageElement | null }[]>([]);
  const state = useRef({ pos: 0, vel: 0, dragging: false, lastX: 0, samples: [] as { x: number; t: number }[] });
  const [loaded, setLoaded] = useState(0);
  const [ready, setReady] = useState(false);
  const [smooth, setSmooth] = useState(true);
  const [auto, setAuto] = useState(true);
  const [reverse, setReverse] = useState(false);
  const [compare, setCompare] = useState(false);
  const [label, setLabel] = useState("");
  const opts = useRef({ smooth, auto, reverse, compare });
  const lastLabel = useRef("");
  useEffect(() => { opts.current = { smooth, auto, reverse, compare }; }, [smooth, auto, reverse, compare]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(frames.map(async (f) => {
      const [img, orig] = await Promise.all([load(f.url), f.origUrl ? load(f.origUrl).catch(() => null) : Promise.resolve(null)]);
      if (!cancelled) setLoaded((n) => n + 1);
      return { deg: ((f.angle % 360) + 360) % 360, img, orig };
    })).then((s) => {
      if (cancelled) return;
      seq.current = s.sort((a, b) => a.deg - b.deg);
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [frames]);

  const render = useCallback(() => {
    const s = seq.current;
    if (!s.length) return;
    const p = ((state.current.pos % 360) + 360) % 360;
    let i = s.findLastIndex((f) => f.deg <= p);
    if (i < 0) i = s.length - 1;
    const a = s[i];
    const b = s[(i + 1) % s.length];
    const span = ((b.deg - a.deg + 360) % 360) || 360;
    const t = ((p - a.deg + 360) % 360) / span;
    for (const [canvas, key] of [[tryonRef.current, "img"], [origRef.current, "orig"]] as const) {
      if (!canvas || (key === "orig" && !opts.current.compare)) continue;
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(r.width * dpr)) canvas.width = Math.round(r.width * dpr);
      if (canvas.height !== Math.round(r.height * dpr)) canvas.height = Math.round(r.height * dpr);
      const g = canvas.getContext("2d")!;
      g.globalAlpha = 1;
      g.clearRect(0, 0, canvas.width, canvas.height);
      if (opts.current.smooth) {
        drawCover(g, a[key], 1);
        drawCover(g, b[key], t);
      } else {
        drawCover(g, (t < 0.5 ? a : b)[key], 1);
      }
    }
    const lbl = `${Math.round(p)}°`;
    if (lbl !== lastLabel.current) { lastLabel.current = lbl; setLabel(lbl); }
  }, []);

  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 50);
      last = now;
      const st = state.current;
      if (!st.dragging) {
        if (Math.abs(st.vel) > 0.002) { st.pos += st.vel * dt; st.vel *= Math.exp(-dt / FRICTION_MS); }
        else if (opts.current.auto) { st.vel = 0; st.pos += (AUTO_DEG_PER_S * dt) / 1000; }
        else st.vel = 0;
      }
      render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, render]);

  const degPerPx = () => (360 / ((stageRef.current?.clientWidth ?? 400) * DRAG_TURN)) * (opts.current.reverse ? 1 : -1);
  const onDown = (e: React.PointerEvent) => {
    const st = state.current;
    st.dragging = true; st.vel = 0; st.lastX = e.clientX; st.samples = [{ x: e.clientX, t: performance.now() }];
    setAuto(false);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const st = state.current;
    if (!st.dragging) return;
    st.pos += (e.clientX - st.lastX) * degPerPx();
    st.lastX = e.clientX;
    const now = performance.now();
    st.samples.push({ x: e.clientX, t: now });
    while (st.samples.length > 2 && now - st.samples[0].t > 80) st.samples.shift();
  };
  const onUp = () => {
    const st = state.current;
    if (!st.dragging) return;
    st.dragging = false;
    const s0 = st.samples[0];
    const s1 = st.samples.at(-1)!;
    const dt = s1.t - s0.t;
    const v = dt > 0 && performance.now() - s1.t < 60 ? ((s1.x - s0.x) / dt) * degPerPx() : 0;
    st.vel = Math.max(-MAX_FLING, Math.min(MAX_FLING, v));
  };

  const stageCls = "relative aspect-[9/16] h-[70vh] max-w-[45vw] touch-none select-none cursor-grab active:cursor-grabbing";
  const hasOrig = frames.some((f) => f.origUrl);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex gap-4">
        <div ref={stageRef} className={stageCls} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <canvas ref={tryonRef} className="h-full w-full rounded-xl bg-black" />
          <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs">Try-on · {label}</span>
          {!ready && <div className="absolute inset-0 grid place-items-center text-sm text-zinc-400">Loading {loaded}/{frames.length}…</div>}
        </div>
        {compare && (
          <div className={stageCls} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            <canvas ref={origRef} className="h-full w-full rounded-xl bg-black" />
            <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs">Original</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-4 text-sm text-zinc-400">
        {([["Smooth", smooth, setSmooth], ["Auto-rotate", auto, setAuto], ["Reverse drag", reverse, setReverse]] as const).map(([name, v, set]) => (
          <label key={name} className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} /> {name}
          </label>
        ))}
        {hasOrig && (
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Show original
          </label>
        )}
        <span>drag to rotate</span>
      </div>
    </div>
  );
}
