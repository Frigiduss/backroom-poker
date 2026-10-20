// Table sounds, synthesized with the Web Audio API so the game ships no audio files and works offline.

export type SoundName = 'deal' | 'flip' | 'check' | 'chips' | 'allin' | 'fold' | 'win' | 'pot' | 'turn' | 'shuffle';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let volume = 0.7;
let muted = false;

/** Browsers only allow audio after a user gesture, so the context is created (or resumed) on the first one. */
function unlock() {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    applyVolume();
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') void ctx.resume();
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlock, { capture: true, passive: true });

function applyVolume() {
  if (master && ctx) master.gain.setValueAtTime(muted ? 0 : volume * volume, ctx.currentTime);
}

export function setVolume(v: number, isMuted: boolean) {
  volume = Math.max(0, Math.min(1, v));
  muted = isMuted;
  applyVolume();
}

// ---------- building blocks ----------

/** A burst of filtered noise: card snaps, swishes and chip clatter are all made from this. */
function hiss(t: number, dur: number, opts: { freq: number; q?: number; type?: BiquadFilterType; gain: number; attack?: number; sweepTo?: number }) {
  const c = ctx!;
  const src = c.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = c.createBiquadFilter();
  f.type = opts.type ?? 'bandpass';
  f.frequency.setValueAtTime(opts.freq, t);
  if (opts.sweepTo) f.frequency.exponentialRampToValueAtTime(opts.sweepTo, t + dur);
  f.Q.value = opts.q ?? 1;
  const g = c.createGain();
  const a = opts.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

function tone(t: number, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', bendTo?: number) {
  const c = ctx!;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (bendTo) o.frequency.exponentialRampToValueAtTime(bendTo, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** One clay chip landing on others: a short bright click with a ringing overtone. */
function chip(t: number, gain = 0.5) {
  const pitch = 3200 + Math.random() * 1800;
  hiss(t, 0.035, { freq: pitch, q: 6, gain });
  tone(t, pitch * 0.62, 0.05, gain * 0.25, 'triangle');
}

const jitter = () => Math.random() * 0.012;

const SOUNDS: Record<SoundName, (t: number) => void> = {
  deal: (t) => hiss(t, 0.07, { freq: 2600, q: 0.9, gain: 0.35, sweepTo: 1200 }),
  flip: (t) => {
    hiss(t, 0.05, { freq: 1800, q: 1.2, gain: 0.3 });
    hiss(t + 0.04, 0.04, { freq: 3000, q: 1.5, gain: 0.25 });
  },
  shuffle: (t) => {
    for (let i = 0; i < 14; i++) hiss(t + i * 0.028 + jitter(), 0.03, { freq: 2000 + Math.random() * 1500, q: 1.4, gain: 0.18 });
  },
  check: (t) => {
    // Two knuckle raps on the felt.
    for (const dt of [0, 0.11]) {
      tone(t + dt, 150, 0.08, 0.55, 'sine', 70);
      hiss(t + dt, 0.04, { freq: 600, type: 'lowpass', gain: 0.35 });
    }
  },
  chips: (t) => {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) chip(t + i * 0.045 + jitter(), 0.45 - i * 0.05);
  },
  allin: (t) => {
    hiss(t, 0.18, { freq: 900, q: 0.7, gain: 0.25, sweepTo: 2500, attack: 0.04 });
    for (let i = 0; i < 9; i++) chip(t + 0.08 + i * 0.03 + jitter(), 0.4);
  },
  fold: (t) => hiss(t, 0.22, { freq: 700, q: 0.6, gain: 0.2, sweepTo: 2200, attack: 0.06 }),
  pot: (t) => {
    hiss(t, 0.3, { freq: 1200, q: 0.5, gain: 0.18, sweepTo: 600, attack: 0.05 });
    for (let i = 0; i < 6; i++) chip(t + 0.12 + i * 0.04 + jitter(), 0.3);
  },
  win: (t) => {
    SOUNDS.pot(t);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(t + 0.1 + i * 0.09, f, 0.5, 0.16, 'triangle');
      tone(t + 0.1 + i * 0.09, f * 2, 0.3, 0.04, 'sine');
    });
  },
  turn: (t) => {
    tone(t, 880, 0.35, 0.12, 'sine');
    tone(t + 0.09, 1318.5, 0.45, 0.1, 'sine');
  },
};

/** Play a sound, optionally a little later so several events in one moment don't land on top of each other. */
export function play(name: SoundName, delay = 0) {
  if (muted || volume === 0 || !ctx || !master || ctx.state !== 'running') return;
  SOUNDS[name](ctx.currentTime + 0.01 + delay);
}
