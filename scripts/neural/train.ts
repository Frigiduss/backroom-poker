// Trains the Master bot's net on selfplay spots and writes src/bots/neural-weights.ts.
// Run through scripts/neural/run.mjs. Args: dataDir weightsFile [epochs]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NET_ACTIONS, NET_FEATURES } from '../../src/bots/neural';
import { createRng } from '../../src/engine/cards';

const [, , dataDir, outFile, epochsArg] = process.argv;
const EPOCHS = Number(epochsArg ?? 30);
const HIDDEN = [64, 64];
const NIN = NET_FEATURES + NET_ACTIONS; // features + one-hot of Expert's move
/** Targets are tens of big blinds, clipped so a few huge pots don't dominate. */
const tgt = (x: number) => Math.max(-100, Math.min(100, x)) / 10;

interface Spot { f: Float32Array; r: (number | null)[]; b: number }
const spots: Spot[] = [];
for (const file of readdirSync(dataDir).filter((f) => f.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(dataDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    const j = JSON.parse(line);
    const f = new Float32Array(NIN);
    f.set(j.f);
    f[NET_FEATURES + j.b] = 1;
    spots.push({ f, r: j.r, b: j.b });
  }
}
const rng = createRng(42);
const shuffleIn = <T,>(xs: T[]) => { for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } };
shuffleIn(spots);
const val = spots.slice(0, Math.floor(spots.length / 10));
const train = spots.slice(val.length);
console.log(`${spots.length} spots (${train.length} train, ${val.length} check)`);

const sizes = [NIN, ...HIDDEN, NET_ACTIONS];
const W = sizes.slice(1).map((o, l) => Float32Array.from({ length: o * sizes[l] }, () => (rng.next() * 2 - 1) * Math.sqrt(2 / sizes[l]) * 0.9));
const B = sizes.slice(1).map((o) => new Float32Array(o));
const mean = new Float32Array(NIN), std = new Float32Array(NIN);
for (let i = 0; i < NIN; i++) {
  let m = 0, v = 0;
  for (const s of train) m += s.f[i];
  m /= train.length;
  for (const s of train) v += (s.f[i] - m) ** 2;
  mean[i] = m;
  std[i] = Math.sqrt(v / train.length) || 1;
}

function forwardAll(x: Float32Array): Float32Array[] {
  const acts = [Float32Array.from(x, (v, i) => (v - mean[i]) / std[i])];
  for (let l = 0; l < W.length; l++) {
    const a = acts[l], nin = sizes[l], z = new Float32Array(sizes[l + 1]);
    for (let o = 0; o < z.length; o++) {
      let s = B[l][o];
      for (let i = 0; i < nin; i++) s += W[l][o * nin + i] * a[i];
      z[o] = l === W.length - 1 || s > 0 ? s : 0.01 * s;
    }
    acts.push(z);
  }
  return acts;
}
const mse = (set: Spot[]) => {
  let L = 0, n = 0;
  for (const s of set) { const q = forwardAll(s.f).at(-1)!; s.r.forEach((r, a) => { if (r !== null) { L += (q[a] - tgt(r)) ** 2; n++; } }); }
  return L / n;
};

// Adam with a cosine learning rate, Huber-clipped errors, light weight decay.
const mW = W.map((w) => new Float32Array(w.length)), vW = W.map((w) => new Float32Array(w.length));
const mB = B.map((b) => new Float32Array(b.length)), vB = B.map((b) => new Float32Array(b.length));
const gW = W.map((w) => new Float32Array(w.length)), gB = B.map((b) => new Float32Array(b.length));
let t = 0;
for (let ep = 0; ep < EPOCHS; ep++) {
  const lr = 0.002 * (0.5 + 0.5 * Math.cos((Math.PI * ep) / EPOCHS));
  shuffleIn(train);
  for (let b0 = 0; b0 < train.length; b0 += 128) {
    gW.forEach((g) => g.fill(0));
    gB.forEach((g) => g.fill(0));
    const batch = train.slice(b0, b0 + 128);
    for (const s of batch) {
      const acts = forwardAll(s.f);
      let delta = new Float32Array(NET_ACTIONS);
      s.r.forEach((r, a) => { if (r !== null) delta[a] = Math.max(-1.5, Math.min(1.5, acts.at(-1)![a] - tgt(r))); });
      for (let l = W.length - 1; l >= 0; l--) {
        const nin = sizes[l], a = acts[l], prev = new Float32Array(nin);
        for (let o = 0; o < sizes[l + 1]; o++) {
          const d = delta[o];
          if (!d) continue;
          gB[l][o] += d;
          for (let i = 0; i < nin; i++) { gW[l][o * nin + i] += d * a[i]; prev[i] += d * W[l][o * nin + i]; }
        }
        if (l > 0) for (let i = 0; i < nin; i++) if (acts[l][i] <= 0) prev[i] *= 0.01;
        delta = prev;
      }
    }
    t++;
    const step = (p: Float32Array, g: Float32Array, m: Float32Array, v: Float32Array, wd: number) => {
      for (let i = 0; i < p.length; i++) {
        const gi = g[i] / batch.length + wd * p[i];
        m[i] = 0.9 * m[i] + 0.1 * gi;
        v[i] = 0.999 * v[i] + 0.001 * gi * gi;
        p[i] -= (lr * (m[i] / (1 - 0.9 ** t))) / (Math.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8);
      }
    };
    for (let l = 0; l < W.length; l++) { step(W[l], gW[l], mW[l], vW[l], 1e-4); step(B[l], gB[l], mB[l], vB[l], 0); }
  }
  if (ep % 5 === 4 || ep === EPOCHS - 1) console.log(`epoch ${ep + 1}: check error ${mse(val).toFixed(3)}`);
}

// How much better the net's pick is than Expert's on spots it never trained on (same playouts).
for (const margin of [0, 0.2, 0.5]) {
  let gain = 0, moved = 0;
  for (const s of val) {
    const q = forwardAll(s.f).at(-1)!;
    let a = -1;
    s.r.forEach((r, i) => { if (r !== null && (a < 0 || q[i] > q[a])) a = i; });
    if (q[a] > q[s.b] + margin) { moved++; gain += s.r[a]! - s.r[s.b]!; }
  }
  console.log(`margin ${margin}: switches ${((100 * moved) / val.length).toFixed(1)}% of moves, +${(gain / val.length).toFixed(2)} bb per decision`);
}

// Pack: int8 weights per layer (base64) keep the file small.
const layers = W.map((w, l) => {
  const scale = Math.max(...w.map(Math.abs)) / 127;
  const q = Int8Array.from(w, (x) => Math.round(x / scale));
  return { scale: +scale.toPrecision(6), w: Buffer.from(q.buffer).toString('base64'), b: Array.from(B[l], (x) => +x.toFixed(4)) };
});
const packed = { sizes, mean: Array.from(mean, (x) => +x.toFixed(5)), std: Array.from(std, (x) => +x.toFixed(5)), layers };
writeFileSync(outFile, `// Generated by scripts/neural/run.mjs from ${spots.length} self-play spots. Do not edit by hand.

export interface PackedNet {
  sizes: number[];
  mean: number[];
  std: number[];
  /** Weights as int8 (base64) times scale, row-major (output by input). */
  layers: { scale: number; w: string; b: number[] }[];
}

export const NEURAL_WEIGHTS: PackedNet = ${JSON.stringify(packed)};
`);
console.log(`wrote ${outFile}`);
