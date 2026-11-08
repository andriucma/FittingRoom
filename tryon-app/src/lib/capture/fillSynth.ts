/**
 * "Filling a bottle" sound design, synthesized with Web Audio (no samples).
 *
 * - bed:    soft filtered noise through a resonant band-pass whose center rises with progress,
 *           like the air column in a bottle getting shorter as it fills.
 * - glug:   short bubble "bloops" (sine with an upward pitch chirp, like a detaching bubble),
 *           pitched by progress: ~200 Hz empty -> ~700 Hz full.
 * - chime:  soft glassy tick each time a 30° angle is captured.
 * - done:   gentle rising major arpeggio.
 * Everything runs through a short synthetic reverb + compressor for a clean, premium finish.
 * Must be created/resumed from a user gesture (browser autoplay rules).
 */
export class FillSynth {
  private ctx: AudioContext;
  private out: GainNode;
  private wet: GainNode;
  private bed?: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
  private lastGlug = 0;
  muted = false;

  constructor() {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    const master = this.ctx.createGain();
    master.gain.value = 0.8;
    comp.connect(master).connect(this.ctx.destination);

    this.out = this.ctx.createGain();       // dry bus
    this.out.connect(comp);
    const verb = this.ctx.createConvolver();
    verb.buffer = this.impulse(1.6, 2.8);
    this.wet = this.ctx.createGain();
    this.wet.gain.value = 0.28;
    this.out.connect(verb).connect(this.wet).connect(comp);
  }

  /** Unlock audio (needs a user gesture). Never blocks the flow for more than 500 ms if the browser refuses. */
  async resume() {
    if (this.ctx.state === "running") return;
    await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
  }

  private get now() {
    return this.ctx.currentTime;
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  private noise(seconds: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0; // cheap pink-ish noise
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    }
    return buf;
  }

  /** Resonant "air column" pitch for a fill level 0..1. */
  private resonance(p: number) {
    return 520 * Math.pow(2, p * 2.1); // ~520 Hz -> ~2.2 kHz
  }

  /** Bubble pitch for a fill level 0..1. */
  private bubble(p: number) {
    return 200 * Math.pow(2, p * 1.8); // ~200 Hz -> ~700 Hz
  }

  startBed() {
    if (this.bed) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise(4);
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 9;
    filter.frequency.value = this.resonance(0);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(this.muted ? 0 : 0.22, this.now + 0.6);
    src.connect(filter).connect(gain).connect(this.out);
    src.start();
    this.bed = { src, filter, gain };
  }

  /** Call continuously with progress 0..1 (fraction of the full turn). */
  setLevel(p: number) {
    if (!this.bed) return;
    this.bed.filter.frequency.setTargetAtTime(this.resonance(p), this.now, 0.08);
  }

  /** One bubble "bloop". Rate-limited so fast turns don't machine-gun. */
  glug(p: number) {
    if (this.muted) return;
    const t = this.now;
    if (t - this.lastGlug < 0.07) return;
    this.lastGlug = t;
    const f = this.bubble(p) * (1 + (Math.random() - 0.5) * 0.06);
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f * 0.72, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.045);   // bubbles chirp upward as they detach
    const partial = this.ctx.createOscillator();
    partial.type = "sine";
    partial.frequency.setValueAtTime(f * 2.01 * 0.72, t);
    partial.frequency.exponentialRampToValueAtTime(f * 2.01, t + 0.045);
    const pg = this.ctx.createGain();
    pg.gain.value = 0.18;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.32, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3200;
    osc.connect(env);
    partial.connect(pg).connect(env);
    env.connect(lp).connect(this.out);
    osc.start(t);
    partial.start(t);
    osc.stop(t + 0.2);
    partial.stop(t + 0.2);
  }

  /** Soft glass tick: an angle has been captured. */
  chime(p: number) {
    if (this.muted) return;
    const t = this.now;
    const f = 880 * Math.pow(2, Math.round(p * 12) / 12 * 0.75); // gently rising, quantized to semitones
    for (const [mult, amp, dur] of [[1, 0.12, 0.9], [2.76, 0.035, 0.5], [5.4, 0.015, 0.3]] as const) {
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f * mult;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.out);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  /** Countdown tick (3, 2, 1). */
  tick(final = false) {
    if (this.muted) return;
    const t = this.now;
    const o = this.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = final ? 1046.5 : 784;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 0.5 : 0.18));
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.6);
  }

  /** Bottle full: fade the bed and play a soft rising arpeggio. */
  complete() {
    this.stopBed(0.4);
    if (this.muted) return;
    const t = this.now;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const s = t + i * 0.09;
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.14, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 1.4);
      o.connect(g).connect(this.out);
      o.start(s);
      o.stop(s + 1.5);
    });
  }

  /** Short demo for the sound check: a quick fill from empty to full. */
  demo() {
    this.startBed();
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      setTimeout(() => {
        const p = i / steps;
        this.setLevel(p);
        this.glug(p);
        if (i % 4 === 0 && i) this.chime(p);
        if (i === steps) this.complete();
      }, i * 110);
    }
  }

  stopBed(fade = 0.3) {
    if (!this.bed) return;
    const { src, gain } = this.bed;
    gain.gain.cancelScheduledValues(this.now);
    gain.gain.setTargetAtTime(0, this.now, fade / 3);
    src.stop(this.now + fade + 0.1);
    this.bed = undefined;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.bed) this.bed.gain.gain.setTargetAtTime(m ? 0 : 0.22, this.now, 0.05);
  }

  close() {
    this.stopBed(0.05);
    void this.ctx.close();
  }
}
