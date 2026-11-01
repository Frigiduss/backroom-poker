import { Action } from '../engine/hand';
import { startingPercentile } from './strength';
import { PlayerView } from './view';
import { NEURAL_WEIGHTS, PackedNet } from './neural-weights';

/**
 * The Master bot's neural net (No-Limit Hold'em only).
 *
 * It looks at the betting situation plus what the Expert logic would do, and scores five moves
 * in big blinds: fold, check/call, a half-pot bet, a pot-sized bet, and all in. It was trained
 * on bot-vs-bot hands where every move was played out to the end to see what it really won.
 * The Master starts from Expert's choice and only switches when the net is clearly sure.
 */

export const NET_ACTIONS = 5;
export const NET_FEATURES = 24;
const MOVE_NAMES = ['folding', 'calling', 'a half-pot bet', 'a pot-sized bet', 'going all in'];

/** Net outputs are tens of big blinds. A switch needs this much more value than Expert's move. */
const SWITCH_MARGIN = 0.2;
/** All in with chips still deep behind needs a bigger edge, so the Master doesn't shove at random. */
const DEEP_ALLIN_MARGIN = 0.6;
const DEEP_SPR = 1.5;

interface Net {
  sizes: number[];
  W: Float32Array[];
  b: Float32Array[];
  mean: Float32Array;
  std: Float32Array;
}

function decode(b64: string): Int8Array {
  const bin = atob(b64);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
  return out;
}

export function unpack(p: PackedNet): Net {
  return {
    sizes: p.sizes,
    W: p.layers.map((l) => Float32Array.from(decode(l.w), (q) => q * l.scale)),
    b: p.layers.map((l) => Float32Array.from(l.b)),
    mean: Float32Array.from(p.mean),
    std: Float32Array.from(p.std),
  };
}

let cached: Net | null = null;
const net = () => (cached ??= unpack(NEURAL_WEIGHTS));

export function forward(n: Net, x: Float32Array): Float32Array {
  let a = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) a[i] = (x[i] - n.mean[i]) / n.std[i];
  for (let l = 0; l < n.W.length; l++) {
    const nin = n.sizes[l], nout = n.sizes[l + 1], w = n.W[l], last = l === n.W.length - 1;
    const z = new Float32Array(nout);
    for (let o = 0; o < nout; o++) {
      let s = n.b[l][o];
      const off = o * nin;
      for (let i = 0; i < nin; i++) s += w[off + i] * a[i];
      z[o] = last || s > 0 ? s : 0.01 * s;
    }
    a = z;
  }
  return a;
}

/** The five moves the net scores, or null where a move isn't allowed or duplicates another. */
export function candidates(view: PlayerView): (Action | null)[] {
  const L = view.legal;
  if (L.kind !== 'bet') return [null, null, null, null, null];
  const out: (Action | null)[] = [L.fold && !L.check ? { type: 'fold' } : null, L.check ? { type: 'check' } : { type: 'call' }, null, null, null];
  if (L.raise) {
    const sized = (frac: number) => {
      let to = view.currentBet + (view.pot + L.callAmount) * frac;
      if (view.street === 0 && view.currentBet <= view.stakes.bb) to = view.stakes.bb * (frac < 0.8 ? 2.5 : 3.5);
      const unit = Math.max(1, view.stakes.sb);
      to = Math.round(to / unit) * unit;
      return Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, to));
    };
    const half = sized(0.5), pot = sized(1), all = L.maxRaiseTo;
    if (half < all) out[2] = { type: 'raise', to: half };
    if (pot < all && pot > half) out[3] = { type: 'raise', to: pot };
    out[4] = { type: 'raise', to: all };
  }
  return out;
}

/** Which of the five moves an action is closest to. */
export function moveIndex(c: (Action | null)[], a: Action): number {
  if (a.type === 'fold') return c[0] ? 0 : 1;
  if (a.type !== 'raise') return 1;
  let best = 1, bd = Infinity;
  for (let i = 2; i < NET_ACTIONS; i++) {
    const x = c[i];
    if (x && x.type === 'raise') {
      const d = Math.abs(Math.log(x.to / Math.max(1, a.to)));
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}

function positionFactor(view: PlayerView): number {
  const order: number[] = [];
  const n = view.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (view.button + k) % n;
    if (view.players[i].status !== 'folded') order.push(i);
  }
  const pos = order.indexOf(view.me);
  return order.length > 1 ? pos / (order.length - 1) : 1;
}

/** What the net sees: the bot's own read of its equity plus the betting situation. */
export function features(view: PlayerView, equity: number): Float32Array {
  const L = view.legal;
  if (L.kind !== 'bet') throw new Error('features need a betting decision');
  const bb = view.stakes.bb;
  const me = view.players[view.me];
  const opps = view.players.filter((q, i) => i !== view.me && q.status !== 'folded');
  const nOpp = opps.length;
  const toCall = L.callAmount;
  const pot = view.pot;
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const raisesStreet = view.actions.filter((a) => a.street === view.street && a.aggressive && a.player !== view.me).length;
  const raisesAll = view.actions.filter((a) => a.aggressive && a.player !== view.me).length;
  const mine = view.actions.filter((a) => a.aggressive && a.player === view.me).length;
  const lastEarlier = [...view.actions].reverse().find((a) => a.aggressive && a.street < view.street);
  const effStack = Math.min(me.stack, Math.max(0, ...opps.map((o) => o.stack + o.streetBet - me.streetBet)));
  const fair = 1 / (nOpp + 1);
  const f = new Float32Array(NET_FEATURES);
  let k = 0;
  f[k++] = equity;
  f[k++] = equity - fair;
  f[k++] = (equity - fair) / (1 - fair);
  f[k++] = potOdds;
  f[k++] = equity - potOdds;
  f[k++] = Math.log1p(pot / bb) / 5;
  f[k++] = Math.log1p(toCall / bb) / 5;
  f[k++] = Math.min(10, effStack / Math.max(1, pot)) / 10;
  f[k++] = Math.log1p(effStack / bb) / 5;
  for (let s = 0; s < 4; s++) f[k++] = view.street === s ? 1 : 0;
  f[k++] = nOpp / 5;
  f[k++] = nOpp === 1 ? 1 : 0;
  f[k++] = positionFactor(view);
  f[k++] = raisesStreet / 3;
  f[k++] = raisesAll / 5;
  f[k++] = mine / 3;
  f[k++] = lastEarlier && lastEarlier.player === view.me ? 1 : 0;
  f[k++] = view.street === 0 ? startingPercentile(view.variant, view.myCards) : equity;
  f[k++] = L.check ? 1 : 0;
  f[k++] = toCall >= me.stack ? 1 : 0;
  f[k++] = 1;
  return f;
}

export interface NetChoice {
  action: Action;
  /** Big blinds the net expects this move to gain over Expert's move. */
  edge: number;
  reason: string;
}

/**
 * Asks the net whether to play something other than Expert's move. Returns null to keep it.
 * `equity` is the bot's pot share before any noise.
 */
export function netOverride(view: PlayerView, base: Action, equity: number, n: Net = net()): NetChoice | null {
  const L = view.legal;
  if (L.kind !== 'bet' || L.bringIn) return null;
  const c = candidates(view);
  const b = moveIndex(c, base);
  const x = new Float32Array(n.sizes[0]);
  x.set(features(view, equity));
  if (x.length > NET_FEATURES) x[NET_FEATURES + b] = 1;
  const q = forward(n, x);
  const bestOf = (upTo: number) => {
    let a = -1;
    for (let i = 0; i < upTo; i++) if (c[i] && (a < 0 || q[i] > q[a])) a = i;
    return a;
  };
  let a = bestOf(NET_ACTIONS);
  if (a === 4 && b !== 4) {
    const spr = (L.maxRaiseTo - L.streetBet) / Math.max(1, view.pot + L.callAmount);
    if (spr > DEEP_SPR && !(q[4] > q[b] + DEEP_ALLIN_MARGIN)) a = bestOf(4);
  }
  if (a < 0 || a === b || !(q[a] > q[b] + SWITCH_MARGIN)) return null;
  const edge = (q[a] - q[b]) * 10;
  const action = c[a]!;
  const instead = a === 1 && L.check ? 'checking' : MOVE_NAMES[a];
  return { action, edge, reason: `Its neural net rates ${instead} about ${Math.max(1, Math.round(edge))} big blinds better than ${b === 1 && L.check ? 'checking' : MOVE_NAMES[b]} here.` };
}
