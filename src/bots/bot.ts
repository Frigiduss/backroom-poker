import { Rng, createRng } from '../engine/cards';
import { Action } from '../engine/hand';
import { BotStyle, Difficulty } from '../engine/table';
import { chooseDiscards } from './draw';
import { simulateEquity, specFromView } from './equity';
import { startingPercentile } from './strength';
import { PlayerView } from './view';

interface Profile {
  /** Monte Carlo iterations per decision. */
  sims: number;
  /** Random error added to the bot's read of its own equity. */
  noise: number;
  /** How far below the pot odds the bot will still call. */
  callBias: number;
  /** 0 = always calls, 1 = raises whenever it can justify it. */
  aggression: number;
  /** Chance of betting or raising with a weak hand when it looks profitable. */
  bluff: number;
  /** Narrow opponents' hands from their actions before the flop. */
  ranges: boolean;
  /** Use observed tendencies (VPIP, aggression) of each opponent. */
  adapt: boolean;
  /** Equity multiplier per raise faced this round, a stand-in for reading strength. */
  raiseRespect: number;
  /** Shove-or-fold play when short stacked in no-limit tournaments. */
  pushFold: boolean;
  /** Sometimes check a monster to trap. */
  slowplay: number;
  /** Bet sizes vary with hand strength (otherwise fixed and readable). */
  sizing: boolean;
  timeBudgetMs: number;
}

export const PROFILES: Record<Difficulty, Profile> = {
  beginner: { sims: 60, noise: 0.16, callBias: 0.22, aggression: 0.15, bluff: 0.01, ranges: false, adapt: false, raiseRespect: 1, pushFold: false, slowplay: 0, sizing: false, timeBudgetMs: 20 },
  easy: { sims: 150, noise: 0.09, callBias: 0.1, aggression: 0.3, bluff: 0.03, ranges: false, adapt: false, raiseRespect: 0.97, pushFold: false, slowplay: 0, sizing: false, timeBudgetMs: 40 },
  medium: { sims: 400, noise: 0.045, callBias: 0.03, aggression: 0.5, bluff: 0.07, ranges: false, adapt: false, raiseRespect: 0.9, pushFold: true, slowplay: 0.05, sizing: true, timeBudgetMs: 80 },
  hard: { sims: 800, noise: 0.02, callBias: 0.01, aggression: 0.6, bluff: 0.1, ranges: true, adapt: false, raiseRespect: 0.95, pushFold: true, slowplay: 0.12, sizing: true, timeBudgetMs: 140 },
  expert: { sims: 1400, noise: 0.008, callBias: 0, aggression: 0.65, bluff: 0.12, ranges: true, adapt: true, raiseRespect: 0.96, pushFold: true, slowplay: 0.2, sizing: true, timeBudgetMs: 220 },
};

const STYLE_MODS: Record<BotStyle, { callBias: number; aggression: number; bluff: number; tight: number }> = {
  balanced: { callBias: 0, aggression: 0, bluff: 0, tight: 0 },
  tight: { callBias: -0.04, aggression: -0.05, bluff: -0.03, tight: 0.05 },
  loose: { callBias: 0.06, aggression: 0, bluff: 0.02, tight: -0.04 },
  aggressive: { callBias: 0.01, aggression: 0.2, bluff: 0.06, tight: 0 },
  passive: { callBias: 0.04, aggression: -0.25, bluff: -0.03, tight: 0 },
};

export const STYLE_NAMES: Record<BotStyle, string> = { balanced: 'Balanced', tight: 'Tight', loose: 'Loose', aggressive: 'Aggressive', passive: 'Passive' };

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function gauss(rng: Rng): number {
  const u = Math.max(1e-9, rng.next());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

export interface Decision {
  action: Action;
  /** Equity estimate behind the choice, for debugging and tests. */
  equity?: number;
}

/** A computer opponent. One instance per seat so it can remember things across hands. */
export class Bot {
  readonly difficulty: Difficulty;
  readonly style: BotStyle;
  private rng: Rng;
  private p: Profile;
  private mods: (typeof STYLE_MODS)[BotStyle];

  constructor(difficulty: Difficulty, style: BotStyle = 'balanced', seed?: number) {
    this.difficulty = difficulty;
    this.style = style;
    this.rng = createRng(seed);
    this.p = PROFILES[difficulty];
    this.mods = STYLE_MODS[style];
  }

  decide(view: PlayerView): Action {
    return this.think(view).action;
  }

  think(view: PlayerView): Decision {
    const L = view.legal;
    if (L.kind === 'draw') return { action: { type: 'draw', discard: chooseDiscards(view.myCards, this.difficulty, this.rng) } };
    if (L.kind !== 'bet') return { action: { type: 'check' } };

    const p = this.p;
    const m = this.mods;
    const v = view.variant;
    const me = view.players[view.me];
    const opps = view.players.filter((q, i) => i !== view.me && q.status !== 'folded');
    const nOpp = opps.length;
    const bb = view.stakes.bb;

    let equity = this.equity(view);
    const raisesFaced = view.actions.filter((a) => a.street === view.street && a.aggressive && a.player !== view.me).length;
    const respect = p.ranges && view.street === 0 && v.family === 'flop' ? 1 : p.raiseRespect;
    equity *= Math.pow(respect, raisesFaced);
    equity = clamp(equity + gauss(this.rng) * p.noise, 0, 1);

    const fair = 1 / (nOpp + 1);
    const s = (equity - fair) / (1 - fair);
    const aggr = clamp(p.aggression + m.aggression, 0.02, 0.95);
    const bluffRate = clamp(p.bluff + m.bluff, 0, 0.4);
    const pot = view.pot;
    const toCall = L.callAmount;
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    const lastStreet = view.street === view.numStreets - 1;
    const stackBB = (me.stack + me.streetBet) / Math.max(1, bb);
    const decision = (action: Action): Decision => ({ action, equity });

    // Stud bring-in: complete with a strong start, otherwise post the minimum.
    if (L.bringIn) {
      return decision(L.raise && s > 0.25 - aggr * 0.15 ? { type: 'raise', to: L.minRaiseTo } : { type: 'bringin' });
    }

    // Short-stacked no-limit tournament play: all in or fold before the flop.
    if (p.pushFold && view.structure === 'NL' && v.family === 'flop' && view.street === 0 && stackBB < 11 && L.raise) {
      const need = 0.05 + stackBB * 0.012 + raisesFaced * 0.08 + m.tight;
      if (s > need) return decision({ type: 'raise', to: L.maxRaiseTo });
      return decision(L.check ? { type: 'check' } : toCall <= bb * 0.5 && equity > potOdds ? { type: 'call' } : { type: 'fold' });
    }

    const valueThr = 0.32 - aggr * 0.22 + m.tight + raisesFaced * 0.1;
    const position = this.positionFactor(view);

    // Before the flop in flop games, raising follows starting-hand charts by position.
    if (v.family === 'flop' && view.street === 0 && this.difficulty !== 'beginner') {
      const pre = this.preflop(view, raisesFaced, position, aggr);
      if (pre) return decision(pre);
    }

    if (L.check) {
      if (L.raise && s > valueThr) {
        if (s > 0.8 && !lastStreet && this.rng.next() < p.slowplay) return decision({ type: 'check' });
        if (this.rng.next() < 0.35 + aggr * 0.65) return decision(this.betAction(view, s, false));
      }
      const bluffSpot = nOpp <= 2 && view.street > 0 ? 1 : 0.4;
      if (L.raise && s < valueThr && this.rng.next() < bluffRate * bluffSpot * (0.6 + position)) {
        return decision(this.betAction(view, 0.2, true));
      }
      return decision({ type: 'check' });
    }

    // Facing a bet.
    let callThr = potOdds - p.callBias - m.callBias + this.opponentAdjust(view);
    if (toCall >= me.stack * 0.6 && p.sizing) callThr += 0.04; // big calls need a little extra
    const chartPreflop = v.family === 'flop' && view.street === 0 && this.difficulty !== 'beginner';
    if (L.raise && !chartPreflop && s > valueThr + 0.05 && this.rng.next() < 0.3 + aggr * 0.7) {
      return decision(this.betAction(view, s, false));
    }
    if (equity >= callThr) return decision({ type: 'call' });
    if (L.raise && nOpp === 1 && raisesFaced <= 1 && this.rng.next() < bluffRate * 0.5 * (0.5 + position)) {
      return decision(this.betAction(view, 0.2, true));
    }
    return decision({ type: 'fold' });
  }

  /** Chart-style raising before the flop. Returns null to fall back to equity-based calling. */
  private preflop(view: PlayerView, raisesFaced: number, position: number, aggr: number): Action | null {
    const L = view.legal;
    if (L.kind !== 'bet' || !L.raise) return null;
    const v = view.variant;
    let pct = startingPercentile(v, view.myCards);
    if (this.difficulty === 'easy') pct = clamp(pct + gauss(this.rng) * 0.12, 0, 1);
    const players = view.players.filter((q) => q.status !== 'folded').length;
    const tight = this.mods.tight * 2;
    if (raisesFaced === 0) {
      let open = (0.1 + 0.3 * position) * (0.6 + aggr) - tight;
      if (players <= 3) open += 0.15;
      if (players === 2) open += 0.15;
      if (pct >= 1 - open && this.rng.next() < 0.6 + aggr * 0.5) return this.betAction(view, pct, false);
      return null;
    }
    const reraise = (raisesFaced === 1 ? 0.045 : 0.018) * (0.6 + aggr) * (players === 2 ? 2 : 1) - tight * 0.2;
    if (pct >= 1 - reraise) return this.betAction(view, pct, false);
    // An occasional light 3-bet from late position keeps strong bots hard to read.
    if (raisesFaced === 1 && this.p.ranges && position > 0.7 && pct > 0.75 && this.rng.next() < this.p.bluff * 0.5) return this.betAction(view, 0.5, true);
    return null;
  }

  /** Estimated share of the pot, using ranges and tendencies where this bot is good enough. */
  private equity(view: PlayerView): number {
    const v = view.variant;
    const opts: { keep?: number[]; ranges?: (number | undefined)[] } = {};
    if (v.family === 'draw' && view.phase === 'betting' && view.players[view.me].drew === null) {
      const discard = chooseDiscards(view.myCards, this.difficulty, this.rng);
      opts.keep = view.myCards.filter((_, i) => !discard.includes(i));
    }
    if (this.p.ranges && v.family === 'flop') opts.ranges = this.estimateRanges(view);
    const spec = specFromView(view, opts);
    let eq = simulateEquity(spec, { iterations: this.p.sims, rng: this.rng, timeBudgetMs: this.p.timeBudgetMs });
    // Opponents in draw games improve too; random five-card hands flatter us.
    if (v.family === 'draw') eq *= view.players[view.me].drew === null ? 0.85 : 0.92;
    // Beginners mostly look at their own cards.
    if (this.difficulty === 'beginner' && v.family === 'flop' && view.street === 0) {
      eq = 0.5 * eq + 0.5 * startingPercentile(v, view.myCards) / (spec.opponents.length * 0.5 + 0.5);
    }
    return clamp(eq, 0, 1);
  }

  /** Each opponent's likely range (fraction of starting hands) from their actions before the flop. */
  private estimateRanges(view: PlayerView): (number | undefined)[] {
    return view.players.map((pl, i) => {
      if (i === view.me || pl.status === 'folded') return undefined;
      const pre = view.actions.filter((a) => a.player === i && a.street === 0);
      const raises = pre.filter((a) => a.type === 'raise').length;
      const called = pre.some((a) => a.type === 'call');
      const st = this.p.adapt ? view.stats[pl.id] : undefined;
      const seen = st && st.hands >= 8;
      const vpip = seen ? clamp(st!.vpip / st!.hands, 0.08, 0.95) : 0.4;
      const pfr = seen ? clamp(st!.pfr / st!.hands, 0.04, 0.8) : 0.16;
      if (raises >= 2) return Math.max(0.03, pfr * 0.3);
      if (raises === 1) return Math.max(0.06, pfr * (view.actions.some((a) => a.street === 0 && a.aggressive && a.player !== i) ? 0.5 : 1));
      if (called) return vpip;
      return undefined;
    });
  }

  /** Expert bots call wider against frequent bettors and tighter against rocks. */
  private opponentAdjust(view: PlayerView): number {
    if (!this.p.adapt) return 0;
    const last = [...view.actions].reverse().find((a) => a.street === view.street && a.aggressive && a.player !== view.me);
    if (!last) return 0;
    const st = view.stats[view.players[last.player].id];
    if (!st || st.hands < 10) return 0;
    const af = st.bets / Math.max(1, st.calls);
    if (af > 2.5) return -0.04;
    if (af < 0.6) return 0.05;
    return 0;
  }

  /** 0 when first to act after the button, up to 1 when acting last. */
  private positionFactor(view: PlayerView): number {
    const order: number[] = [];
    const n = view.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (view.button + k) % n;
      if (view.players[i].status !== 'folded') order.push(i);
    }
    const pos = order.indexOf(view.me);
    return order.length > 1 ? pos / (order.length - 1) : 1;
  }

  private betAction(view: PlayerView, strength: number, bluff: boolean): Action {
    const L = view.legal;
    if (L.kind !== 'bet' || !L.raise) return { type: 'check' };
    if (view.structure === 'FL') return { type: 'raise', to: L.minRaiseTo };
    const rng = this.rng;
    const bb = view.stakes.bb;
    const me = view.players[view.me];
    const allIn = me.streetBet + me.stack;
    const toCall = L.callAmount;
    let to: number;

    if (!this.p.sizing) {
      // Weaker bots: min-raises, pot-ish bets, and the occasional wild shove.
      if (strength > 0.75 && rng.next() < 0.25) to = allIn;
      else if (rng.next() < 0.5) to = L.minRaiseTo;
      else to = view.currentBet + (view.pot + toCall) * (0.5 + rng.next() * 0.5);
    } else if (view.street === 0 && view.variant.family === 'flop') {
      const limpers = view.players.filter((q, i) => i !== view.me && q.status !== 'folded' && q.streetBet === view.currentBet).length;
      if (view.currentBet <= bb) to = bb * (2.3 + rng.next() * 0.7) + Math.max(0, limpers - 2) * bb;
      else to = view.currentBet * (2.6 + rng.next() * 0.6);
    } else {
      const frac = bluff ? 0.45 + rng.next() * 0.3 : 0.4 + clamp(strength, 0, 1) * 0.5 + (rng.next() - 0.5) * 0.2;
      to = view.currentBet + (view.pot + toCall) * frac;
    }
    // Committing most of the stack anyway: just go all in.
    if (view.structure === 'NL' && to > allIn * 0.65) to = allIn;
    to = Math.round(to / Math.max(1, view.stakes.sb || 1)) * Math.max(1, view.stakes.sb || 1);
    return { type: 'raise', to: clamp(to, L.minRaiseTo, L.maxRaiseTo) };
  }
}

