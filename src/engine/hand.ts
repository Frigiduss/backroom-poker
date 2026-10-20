import { Card, Rng, cardLabel, fullDeck, rankOf, shuffle, suitOf } from './cards';
import { describeHigh, describeLow, evalHigh, evalLow } from './evaluator';
import { Structure, VariantDef, showdownValue } from './variants';

export interface Stakes {
  sb: number;
  bb: number;
  ante: number;
  /** Stud only: the forced opening bet by the lowest (razz: highest) up card. */
  bringIn: number;
  /** Fixed-limit bet sizes; small applies to the early rounds. */
  smallBet: number;
  bigBet: number;
}

export type PlayerStatus = 'active' | 'allin' | 'folded';

export type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  /** Bet or raise so this player's total for the round becomes `to`. */
  | { type: 'raise'; to: number }
  /** Stud: post the bring-in instead of completing. */
  | { type: 'bringin' }
  /** Draw games: indices into the player's cards to throw away. */
  | { type: 'draw'; discard: number[] };

export interface HandPlayerInit {
  id: string;
  name: string;
  stack: number;
}

export interface HandPlayer {
  id: string;
  name: string;
  startStack: number;
  stack: number;
  cards: Card[];
  /** Parallel to cards: true when everyone can see that card. */
  faceUp: boolean[];
  status: PlayerStatus;
  streetBet: number;
  totalBet: number;
  hasActed: boolean;
  /** False after an incomplete all-in raise reached a player who had already acted. */
  mayRaise: boolean;
  lastAction: string | null;
  /** Cards swapped in the draw, or null before drawing. */
  drew: number | null;
  /** Cards were revealed at showdown. */
  shown: boolean;
}

export type LegalActions =
  | { kind: 'none' }
  | { kind: 'draw'; maxDiscard: number }
  | {
      kind: 'bet';
      fold: boolean;
      check: boolean;
      call: boolean;
      /** Chips added by calling (capped by the stack). */
      callAmount: number;
      raise: boolean;
      /** True when nobody has bet yet this round. */
      isBet: boolean;
      minRaiseTo: number;
      maxRaiseTo: number;
      bringIn: boolean;
      bringInAmount: number;
      /** This player's chips already in this round. */
      streetBet: number;
    };

export interface LogEntry {
  kind: 'start' | 'deal' | 'action' | 'street' | 'win' | 'info';
  text: string;
  player?: number;
}

export interface ActionRecord {
  player: number;
  street: number;
  type: Action['type'] | 'blind' | 'ante';
  /** Chips this action added. */
  amount: number;
  /** Round total after the action (raises). */
  to: number;
  allIn: boolean;
  /** Raised or bet (counts as aggression). */
  aggressive: boolean;
}

export interface PotResult {
  amount: number;
  eligible: number[];
  winnersHi: number[];
  winnersLo: number[];
}

export interface HandResult {
  showdown: boolean;
  pots: PotResult[];
  /** Chips won per player index. */
  won: number[];
  /** Hand description per player who showed. */
  handNames: (string | null)[];
  summary: string[];
}

export interface HandConfig {
  variant: VariantDef;
  structure: Structure;
  stakes: Stakes;
  players: HandPlayerInit[];
  /** Index into players of the dealer button. */
  button: number;
  rng: Rng;
  /** Testing: cards to deal on purpose instead of from the shuffle. */
  rig?: Rig;
}

/** Cards fixed in advance (the developer console uses this to set up situations to test). */
export interface Rig {
  /** By player index: the first cards dealt to that player, in dealing order. Extra cards become draws. */
  hole?: Record<number, Card[]>;
  /** Community cards, in the order they come out. */
  board?: Card[];
}

/** Why a rig can't be dealt with this deck (a repeated card, or one the short deck lacks), or null if it's fine. */
export function rigProblem(rig: Rig, shortDeck: boolean, inDeck: readonly Card[] = fullDeck(shortDeck)): string | null {
  const all = [...Object.values(rig.hole ?? {}).flat(), ...(rig.board ?? [])];
  const seen = new Set<Card>();
  const left = new Set(inDeck);
  for (const c of all) {
    if (seen.has(c)) return `${cardLabel(c)} is used twice`;
    seen.add(c);
    if (!left.has(c)) return shortDeck && rankOf(c) < 6 ? `${cardLabel(c)} isn't in the short deck` : `${cardLabel(c)} has already been dealt`;
  }
  return null;
}

export type HandPhase = 'betting' | 'draw' | 'complete';

const FL_CAP = 4;

/** One hand of poker, from forced bets to the final award. Pure game logic; no UI. */
export class Hand {
  readonly variant: VariantDef;
  readonly structure: Structure;
  readonly stakes: Stakes;
  readonly players: HandPlayer[];
  readonly button: number;
  readonly numStreets: number;
  sbIndex = -1;
  bbIndex = -1;
  board: Card[] = [];
  phase: HandPhase = 'betting';
  street = 0;
  toAct = -1;
  currentBet = 0;
  lastRaiseSize = 0;
  fullBetLevel = 0;
  betCount = 0;
  bringInPending = -1;
  log: LogEntry[] = [];
  actions: ActionRecord[] = [];
  result: HandResult | null = null;
  /** Some cards were fixed in advance (developer console), so the hand proves nothing. */
  wasRigged = false;
  private deck: Card[];
  private muck: Card[] = [];
  private drawQueue: number[] = [];
  private rng: Rng;
  private rigHole = new Map<number, Card[]>();
  private rigBoard: Card[] = [];

  constructor(cfg: HandConfig) {
    if (cfg.players.length < 2) throw new Error('A hand needs at least two players');
    this.variant = cfg.variant;
    this.structure = cfg.variant.structures.includes(cfg.structure) ? cfg.structure : cfg.variant.defaultStructure;
    this.stakes = cfg.stakes;
    this.button = cfg.button;
    this.rng = cfg.rng;
    this.numStreets = cfg.variant.streets;
    this.players = cfg.players.map((p) => ({
      id: p.id,
      name: p.name,
      startStack: p.stack,
      stack: p.stack,
      cards: [],
      faceUp: [],
      status: 'active',
      streetBet: 0,
      totalBet: 0,
      hasActed: false,
      mayRaise: true,
      lastAction: null,
      drew: null,
      shown: false,
    }));
    this.deck = shuffle(fullDeck(cfg.variant.shortDeck), this.rng);
    if (cfg.rig) {
      this.wasRigged = true;
      const problem = rigProblem(cfg.rig, cfg.variant.shortDeck);
      if (problem) throw new Error(problem);
      this.takeFromDeck([...Object.values(cfg.rig.hole ?? {}).flat(), ...(cfg.rig.board ?? [])]);
      for (const [i, cards] of Object.entries(cfg.rig.hole ?? {})) this.rigHole.set(Number(i), [...cards]);
      this.rigBoard = [...(cfg.rig.board ?? [])];
    }
    this.begin();
  }

  // ---------- testing ----------

  /** The next cards the deck will give, top first (cards fixed with a rig come before these). */
  upcoming(count = this.deck.length): Card[] {
    return this.deck.slice(-count).reverse();
  }

  /** Cards fixed to come out next on the board, then the cards still undealt. For the developer console. */
  get rigged(): { board: Card[]; hole: Map<number, Card[]> } {
    return { board: [...this.rigBoard], hole: new Map([...this.rigHole].map(([i, c]) => [i, [...c]])) };
  }

  /** Fixes the board cards still to come (replacing any earlier choice). Throws if a card is already out. */
  setBoard(cards: Card[]): void {
    const pool = [...this.deck, ...this.rigBoard];
    const problem = rigProblem({ board: cards }, this.variant.shortDeck, pool);
    if (problem) throw new Error(problem);
    this.deck.unshift(...this.rigBoard);
    this.rigBoard = [];
    this.takeFromDeck(cards);
    this.rigBoard = [...cards];
    this.wasRigged = true;
  }

  private takeFromDeck(cards: Card[]) {
    const out = new Set(cards);
    this.deck = this.deck.filter((c) => !out.has(c));
  }

  // ---------- queries ----------

  get n(): number {
    return this.players.length;
  }

  get pot(): number {
    let t = 0;
    for (const p of this.players) t += p.totalBet;
    return t;
  }

  get isComplete(): boolean {
    return this.phase === 'complete';
  }

  inHand(): number[] {
    const out: number[] = [];
    this.players.forEach((p, i) => p.status !== 'folded' && out.push(i));
    return out;
  }

  /** Current betting unit in fixed-limit (and stud) games. */
  betUnit(): number {
    const { family } = this.variant;
    const early = family === 'draw' ? this.street === 0 : this.street <= 1;
    return early ? this.stakes.smallBet : this.stakes.bigBet;
  }

  legal(): LegalActions {
    if (this.phase === 'draw' && this.toAct >= 0) return { kind: 'draw', maxDiscard: this.variant.holeCards };
    if (this.phase !== 'betting' || this.toAct < 0) return { kind: 'none' };
    const p = this.players[this.toAct];
    const allInTo = p.streetBet + p.stack;

    if (this.bringInPending === this.toAct) {
      const amt = Math.min(this.stakes.bringIn, p.stack);
      const completeTo = Math.min(this.stakes.smallBet, allInTo);
      return {
        kind: 'bet', fold: false, check: false, call: false, callAmount: 0,
        raise: completeTo > amt, isBet: true, minRaiseTo: completeTo, maxRaiseTo: completeTo,
        bringIn: true, bringInAmount: amt, streetBet: p.streetBet,
      };
    }

    const toCall = Math.max(0, this.currentBet - p.streetBet);
    const othersCanAct = this.players.some((q, i) => i !== this.toAct && q.status === 'active');
    let raise = p.mayRaise && allInTo > this.currentBet && othersCanAct;
    if (this.structure === 'FL' && this.betCount >= FL_CAP) raise = false;

    let minTo = 0;
    let maxTo = 0;
    if (this.structure === 'FL') {
      const t = this.flTarget();
      minTo = maxTo = Math.min(t, allInTo);
    } else {
      minTo = this.currentBet + Math.max(this.lastRaiseSize, this.stakes.bb);
      maxTo = allInTo;
      if (this.structure === 'PL') maxTo = Math.min(allInTo, this.currentBet + this.pot + toCall);
      minTo = Math.min(minTo, maxTo);
    }
    if (minTo <= this.currentBet) raise = false;

    return {
      kind: 'bet',
      fold: toCall > 0,
      check: toCall === 0,
      call: toCall > 0,
      callAmount: Math.min(toCall, p.stack),
      raise,
      isBet: this.currentBet === 0,
      minRaiseTo: minTo,
      maxRaiseTo: maxTo,
      bringIn: false,
      bringInAmount: 0,
      streetBet: p.streetBet,
    };
  }

  /** Turn any requested action into the closest legal one (bots and UIs both use this). */
  normalize(a: Action): Action {
    const L = this.legal();
    if (L.kind === 'draw') {
      if (a.type !== 'draw') return { type: 'draw', discard: [] };
      const n = this.players[this.toAct].cards.length;
      const d = [...new Set(a.discard)].filter((i) => Number.isInteger(i) && i >= 0 && i < n).slice(0, L.maxDiscard);
      return { type: 'draw', discard: d };
    }
    if (L.kind !== 'bet') return a;
    if (L.bringIn) {
      if (a.type === 'raise' && L.raise) return { type: 'raise', to: L.minRaiseTo };
      return { type: 'bringin' };
    }
    switch (a.type) {
      case 'fold':
        return L.fold ? a : { type: 'check' };
      case 'check':
        return L.check ? a : { type: 'fold' };
      case 'call':
        return L.call ? a : { type: 'check' };
      case 'raise': {
        if (!L.raise) return L.call ? { type: 'call' } : { type: 'check' };
        const to = Math.round(Math.min(L.maxRaiseTo, Math.max(L.minRaiseTo, a.to)));
        return { type: 'raise', to };
      }
      default:
        return L.check ? { type: 'check' } : { type: 'fold' };
    }
  }

  // ---------- actions ----------

  act(action: Action): void {
    if (this.phase === 'complete') throw new Error('Hand is over');
    const L = this.legal();
    const i = this.toAct;
    const p = this.players[i];

    if (L.kind === 'draw') {
      if (action.type !== 'draw') throw new Error('Expected a draw');
      this.doDraw(i, action.discard);
      return;
    }
    if (L.kind !== 'bet') throw new Error('Nobody to act');

    switch (action.type) {
      case 'fold': {
        if (!L.fold) throw new Error('Cannot fold when checking is free');
        p.status = 'folded';
        p.lastAction = 'Fold';
        this.record(i, 'fold', 0, false);
        this.say('action', `${p.name} folds`, i);
        break;
      }
      case 'check': {
        if (!L.check) throw new Error('Cannot check facing a bet');
        p.lastAction = 'Check';
        this.record(i, 'check', 0, false);
        this.say('action', `${p.name} checks`, i);
        break;
      }
      case 'call': {
        if (!L.call) throw new Error('Nothing to call');
        const amt = this.commit(i, L.callAmount);
        p.lastAction = p.status === 'allin' ? 'All-in' : `Call ${amt}`;
        this.record(i, 'call', amt, false);
        this.say('action', `${p.name} calls ${amt}${p.status === 'allin' ? ' and is all-in' : ''}`, i);
        break;
      }
      case 'bringin': {
        if (!L.bringIn) throw new Error('No bring-in pending');
        const amt = this.commit(i, L.bringInAmount);
        this.currentBet = Math.max(this.currentBet, p.streetBet);
        this.bringInPending = -1;
        p.lastAction = `Bring-in ${amt}`;
        this.record(i, 'bringin', amt, false);
        this.say('action', `${p.name} brings it in for ${amt}`, i);
        break;
      }
      case 'raise': {
        if (!L.raise) throw new Error('Raising is not allowed');
        const to = Math.round(action.to);
        if (to < L.minRaiseTo || to > L.maxRaiseTo) throw new Error(`Raise must be between ${L.minRaiseTo} and ${L.maxRaiseTo}`);
        const prevBet = this.currentBet;
        const wasBet = L.isBet && !L.bringIn && prevBet === 0;
        const completing = L.bringIn || (this.variant.family === 'stud' && this.street === 0 && this.fullBetLevel === 0);
        this.commit(i, to - p.streetBet);
        const size = to - prevBet;
        let full: boolean;
        if (this.structure === 'FL') {
          full = to >= this.flTarget();
          if (full) {
            this.fullBetLevel = to;
            this.betCount++;
          }
        } else {
          full = size >= Math.max(this.lastRaiseSize, this.stakes.bb);
          if (full) this.lastRaiseSize = size;
        }
        this.currentBet = to;
        this.bringInPending = -1;
        for (const [j, q] of this.players.entries()) {
          if (j === i || q.status !== 'active') continue;
          if (full) {
            q.hasActed = false;
            q.mayRaise = true;
          } else if (q.hasActed) {
            q.hasActed = false;
            q.mayRaise = false;
          }
        }
        const verb = completing ? 'completes to' : wasBet ? 'bets' : 'raises to';
        const allin = p.status === 'allin';
        p.lastAction = allin ? 'All-in' : completing ? `Complete ${to}` : wasBet ? `Bet ${to}` : `Raise ${to}`;
        this.record(i, 'raise', 0, true, to);
        this.say('action', `${p.name} ${verb} ${to}${allin ? ' and is all-in' : ''}`, i);
        break;
      }
      default:
        throw new Error('Not a betting action');
    }
    p.hasActed = true;
    this.advance();
  }

  // ---------- flow ----------

  private begin() {
    const { stakes, variant } = this;
    this.say('start', `${variant.name} · ${this.describeStakes()}`);
    if (stakes.ante > 0) {
      for (let i = 0; i < this.n; i++) {
        const amt = this.commit(i, stakes.ante, false);
        this.actions.push({ player: i, street: 0, type: 'ante', amount: amt, to: 0, allIn: this.players[i].status === 'allin', aggressive: false });
      }
      this.say('info', `Everyone antes ${stakes.ante}`);
    }
    if (variant.family !== 'stud') {
      if (this.n === 2) {
        this.sbIndex = this.button;
        this.bbIndex = (this.button + 1) % 2;
      } else {
        this.sbIndex = (this.button + 1) % this.n;
        this.bbIndex = (this.button + 2) % this.n;
      }
      this.postBlind(this.sbIndex, stakes.sb, 'small blind');
      this.postBlind(this.bbIndex, stakes.bb, 'big blind');
      this.currentBet = stakes.bb;
      this.lastRaiseSize = stakes.bb;
      if (this.structure === 'FL') {
        this.fullBetLevel = stakes.bb;
        this.betCount = 1;
      }
    }
    this.dealStreet();
    this.startBettingRound();
  }

  private describeStakes(): string {
    const s = this.stakes;
    if (this.variant.family === 'stud') return `${s.smallBet}/${s.bigBet}, ante ${s.ante}, bring-in ${s.bringIn}`;
    const blinds = `${s.sb}/${s.bb}`;
    return s.ante ? `${blinds}, ante ${s.ante}` : blinds;
  }

  private postBlind(i: number, amount: number, label: string) {
    const amt = this.commit(i, amount);
    const p = this.players[i];
    this.actions.push({ player: i, street: 0, type: 'blind', amount: amt, to: p.streetBet, allIn: p.status === 'allin', aggressive: false });
    this.say('action', `${p.name} posts the ${label} of ${amt}${p.status === 'allin' ? ' and is all-in' : ''}`, i);
  }

  /** Move chips from stack into the pot. `street` false means ante (dead money, not part of the round's bet). */
  private commit(i: number, amount: number, street = true): number {
    const p = this.players[i];
    const amt = Math.max(0, Math.min(amount, p.stack));
    p.stack -= amt;
    p.totalBet += amt;
    if (street) p.streetBet += amt;
    if (p.stack === 0 && p.status === 'active') p.status = 'allin';
    return amt;
  }

  private draw1(): Card {
    if (!this.deck.length) {
      // Only reachable in draw games: reshuffle the discards.
      this.deck = shuffle(this.muck, this.rng);
      this.muck = [];
      this.say('info', 'The deck is reshuffled from the discards');
    }
    return this.deck.pop()!;
  }

  private nextBoardCard(): Card {
    return this.rigBoard.length ? this.rigBoard.shift()! : this.draw1();
  }

  private dealTo(i: number, up: boolean) {
    const p = this.players[i];
    const rigged = this.rigHole.get(i);
    p.cards.push(rigged?.length ? rigged.shift()! : this.draw1());
    p.faceUp.push(up);
  }

  private dealStreet() {
    const { family } = this.variant;
    const order = this.inHand();
    if (family === 'flop') {
      if (this.street === 0) {
        for (let k = 0; k < this.variant.holeCards; k++) for (const i of order) this.dealTo(i, false);
        this.say('deal', 'Hole cards are dealt');
      } else {
        this.draw1(); // burn
        const count = this.street === 1 ? 3 : 1;
        for (let k = 0; k < count; k++) this.board.push(this.nextBoardCard());
        const name = ['', 'Flop', 'Turn', 'River'][this.street];
        this.say('street', `${name}: ${this.board.map(cardLabel).join(' ')}`);
      }
    } else if (family === 'draw') {
      if (this.street === 0) {
        for (let k = 0; k < 5; k++) for (const i of order) this.dealTo(i, false);
        this.say('deal', 'Five cards each are dealt');
      }
    } else {
      const s = this.street;
      if (s === 0) {
        for (const i of order) this.dealTo(i, false);
        for (const i of order) this.dealTo(i, false);
        for (const i of order) this.dealTo(i, true);
        this.say('deal', 'Third street: two down, one up');
      } else if (s < 4) {
        for (const i of order) this.dealTo(i, true);
        this.say('street', `${['', 'Fourth', 'Fifth', 'Sixth'][s]} street`);
      } else if (this.deck.length < order.length) {
        this.board.push(this.nextBoardCard());
        this.say('street', `Seventh street: not enough cards, so ${cardLabel(this.board[0])} is dealt face up for everyone`);
      } else {
        for (const i of order) this.dealTo(i, false);
        this.say('street', 'Seventh street: one card down');
      }
    }
  }

  private startBettingRound() {
    this.phase = 'betting';
    if (this.street > 0) {
      for (const p of this.players) {
        p.streetBet = 0;
        p.hasActed = false;
        p.mayRaise = true;
        if (p.status !== 'folded') p.lastAction = null;
      }
      this.currentBet = 0;
      this.lastRaiseSize = this.stakes.bb;
      this.fullBetLevel = 0;
      this.betCount = 0;
    }

    const actives = this.players.filter((p) => p.status === 'active');
    if (actives.length === 0 || (actives.length === 1 && actives[0].streetBet >= this.currentBet)) {
      this.endBettingRound();
      return;
    }

    let start: number;
    if (this.variant.family === 'stud') {
      if (this.street === 0) {
        const b = this.bringInPlayer();
        if (b >= 0) {
          this.bringInPending = b;
          this.toAct = b;
          this.say('info', `${this.players[b].name} has the bring-in`);
          return;
        }
        start = 0;
      } else {
        start = this.bestShowing();
      }
    } else {
      start = this.street === 0 ? (this.bbIndex + 1) % this.n : (this.button + 1) % this.n;
    }
    this.toAct = this.nextToAct(start - 1);
    if (this.toAct < 0) this.endBettingRound();
  }

  private nextToAct(fromExclusive: number): number {
    for (let k = 1; k <= this.n; k++) {
      const i = (((fromExclusive + k) % this.n) + this.n) % this.n;
      const p = this.players[i];
      if (p.status === 'active' && (!p.hasActed || p.streetBet < this.currentBet)) return i;
    }
    return -1;
  }

  private advance() {
    if (this.inHand().length === 1) {
      this.settle(false);
      return;
    }
    const next = this.nextToAct(this.toAct);
    if (next < 0) this.endBettingRound();
    else this.toAct = next;
  }

  private endBettingRound() {
    this.toAct = -1;
    if (this.inHand().length === 1) {
      this.settle(false);
      return;
    }
    this.street++;
    if (this.street >= this.numStreets) {
      this.settle(true);
      return;
    }
    if (this.variant.family === 'draw' && this.street === 1) {
      this.startDraw();
      return;
    }
    this.dealStreet();
    this.startBettingRound();
  }

  private startDraw() {
    this.phase = 'draw';
    this.drawQueue = [];
    for (let k = 1; k <= this.n; k++) {
      const i = (this.button + k) % this.n;
      if (this.players[i].status !== 'folded') this.drawQueue.push(i);
    }
    for (const p of this.players) if (p.status !== 'folded') p.lastAction = null;
    this.say('street', 'The draw');
    this.toAct = this.drawQueue[0];
  }

  private doDraw(i: number, discard: number[]) {
    const p = this.players[i];
    const idx = [...new Set(discard)].filter((d) => d >= 0 && d < p.cards.length).sort((a, b) => b - a);
    for (const d of idx) {
      this.muck.push(p.cards[d]);
      p.cards.splice(d, 1);
      p.faceUp.splice(d, 1);
    }
    for (let k = 0; k < idx.length; k++) this.dealTo(i, false);
    p.drew = idx.length;
    p.lastAction = idx.length ? `Draws ${idx.length}` : 'Stands pat';
    this.record(i, 'draw', 0, false);
    this.say('action', idx.length ? `${p.name} draws ${idx.length}` : `${p.name} stands pat`, i);
    this.drawQueue.shift();
    if (this.drawQueue.length) this.toAct = this.drawQueue[0];
    else this.startBettingRound();
  }

  /** Stud third street: lowest up card brings it in (razz: highest, aces low). */
  private bringInPlayer(): number {
    let best = -1;
    let bestKey = 0;
    for (const [i, p] of this.players.entries()) {
      if (p.status !== 'active') continue;
      const c = p.cards[2];
      const r = rankOf(c);
      const key = this.variant.lowOnly ? (r === 14 ? 1 : r) * 4 + suitOf(c) : -(r * 4 + suitOf(c));
      if (best < 0 || key > bestKey) {
        best = i;
        bestKey = key;
      }
    }
    return best;
  }

  /** Stud later streets: best showing hand acts first (razz: lowest showing hand). */
  private bestShowing(): number {
    let best = -1;
    let bestVal = 0;
    for (const [i, p] of this.players.entries()) {
      if (p.status === 'folded') continue;
      const up = p.cards.filter((_, k) => p.faceUp[k]);
      const val = this.variant.lowOnly ? -(evalLow(up, false) ?? 0) : evalHigh(up);
      if (best < 0 || val > bestVal) {
        best = i;
        bestVal = val;
      }
    }
    return best < 0 ? 0 : best;
  }

  private flTarget(): number {
    const unit = this.betUnit();
    const t = this.fullBetLevel + unit;
    return t <= this.currentBet ? this.currentBet + unit : t;
  }

  private record(player: number, type: ActionRecord['type'], amount: number, aggressive: boolean, to = 0) {
    const p = this.players[player];
    this.actions.push({ player, street: this.street, type, amount, to: to || p.streetBet, allIn: p.status === 'allin', aggressive });
  }

  private say(kind: LogEntry['kind'], text: string, player?: number) {
    this.log.push({ kind, text, player });
  }

  // ---------- showdown ----------

  /** Split contributions into main and side pots. */
  computePots(): { amount: number; eligible: number[] }[] {
    const live = this.inHand();
    const levels = [...new Set(live.map((i) => this.players[i].totalBet))].filter((x) => x > 0).sort((a, b) => a - b);
    const pots: { amount: number; eligible: number[] }[] = [];
    let prev = 0;
    for (const L of levels) {
      let amount = 0;
      for (const p of this.players) amount += Math.max(0, Math.min(p.totalBet, L) - prev);
      const eligible = live.filter((i) => this.players[i].totalBet >= L);
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === eligible.length) last.amount += amount;
      else pots.push({ amount, eligible });
      prev = L;
    }
    // Chips from folded players above the highest live contribution.
    let extra = 0;
    for (const p of this.players) extra += Math.max(0, p.totalBet - prev);
    if (extra) {
      if (pots.length) pots[pots.length - 1].amount += extra;
      else pots.push({ amount: extra, eligible: live });
    }
    return pots;
  }

  private settle(showdown: boolean) {
    this.phase = 'complete';
    this.toAct = -1;
    const won = this.players.map(() => 0);
    const handNames: (string | null)[] = this.players.map(() => null);
    const live = this.inHand();
    const values = new Map<number, { hi: number | null; lo: number | null }>();

    if (showdown) {
      // Deal out any missing cards is never needed: runouts happen street by street.
      for (const i of live) {
        const p = this.players[i];
        p.shown = true;
        const v = showdownValue(this.variant, p.cards, this.board);
        values.set(i, v);
        const parts: string[] = [];
        if (v.hi !== null) parts.push(describeHigh(v.hi, this.variant.shortDeck));
        if (v.lo !== null) parts.push(describeLow(v.lo));
        else if (this.variant.hiLo) parts.push('no low');
        handNames[i] = parts.join(' · ');
        this.say('info', `${p.name} shows ${p.cards.map(cardLabel).join(' ')} (${handNames[i]})`, i);
      }
    }

    const order: number[] = [];
    for (let k = 1; k <= this.n; k++) order.push((this.button + k) % this.n);
    const byPosition = (a: number, b: number) => order.indexOf(a) - order.indexOf(b);

    const pots: PotResult[] = [];
    for (const pot of this.computePots()) {
      let winnersHi: number[] = [];
      let winnersLo: number[] = [];
      if (pot.eligible.length === 1 || !showdown) {
        const only = pot.eligible.length === 1 ? pot.eligible : [live[0]];
        if (this.variant.lowOnly) winnersLo = [...only];
        else winnersHi = [...only];
      } else {
        if (!this.variant.lowOnly) {
          let best = -Infinity;
          for (const i of pot.eligible) {
            const h = values.get(i)!.hi!;
            if (h > best) { best = h; winnersHi = [i]; }
            else if (h === best) winnersHi.push(i);
          }
        }
        if (this.variant.hiLo || this.variant.lowOnly) {
          let best = Infinity;
          for (const i of pot.eligible) {
            const l = values.get(i)!.lo;
            if (l === null) continue;
            if (l < best) { best = l; winnersLo = [i]; }
            else if (l === best) winnersLo.push(i);
          }
        }
      }
      winnersHi.sort(byPosition);
      winnersLo.sort(byPosition);
      const split = (amount: number, ws: number[]) => {
        const share = Math.floor(amount / ws.length);
        let rem = amount - share * ws.length;
        for (const w of ws) {
          won[w] += share + (rem > 0 ? 1 : 0);
          if (rem > 0) rem--;
        }
      };
      if (this.variant.lowOnly) split(pot.amount, winnersLo);
      else if (winnersLo.length) {
        const hiHalf = Math.ceil(pot.amount / 2);
        split(hiHalf, winnersHi);
        split(pot.amount - hiHalf, winnersLo);
      } else split(pot.amount, winnersHi);
      pots.push({ amount: pot.amount, eligible: pot.eligible, winnersHi, winnersLo });
    }

    for (const [i, p] of this.players.entries()) p.stack += won[i];

    const summary: string[] = [];
    pots.forEach((pot, k) => {
      const potName = pots.length === 1 ? 'the pot' : k === 0 ? 'the main pot' : `side pot ${k}`;
      if (pot.eligible.length === 1 && pots.length > 1 && showdown) {
        summary.push(`${this.players[pot.eligible[0]].name} gets ${pot.amount} back (uncalled)`);
        return;
      }
      const names = (ws: number[]) => ws.map((w) => this.players[w].name).join(' and ');
      if (this.variant.lowOnly) {
        summary.push(`${names(pot.winnersLo)} ${pot.winnersLo.length > 1 ? 'split' : 'wins'} ${potName} (${pot.amount})${showdown ? ` with ${this.lowName(pot.winnersLo[0], values)}` : ''}`);
      } else if (pot.winnersLo.length) {
        const same = pot.winnersHi.length === pot.winnersLo.length && pot.winnersHi.every((w) => pot.winnersLo.includes(w));
        if (same) summary.push(`${names(pot.winnersHi)} ${pot.winnersHi.length > 1 ? 'split' : 'scoops'} ${potName} (${pot.amount}), high and low`);
        else {
          summary.push(`${names(pot.winnersHi)} ${pot.winnersHi.length > 1 ? 'split' : 'wins'} the high half of ${potName} with ${this.highName(pot.winnersHi[0], values)}`);
          summary.push(`${names(pot.winnersLo)} ${pot.winnersLo.length > 1 ? 'split' : 'wins'} the low half with ${this.lowName(pot.winnersLo[0], values)}`);
        }
      } else {
        const how = showdown && pot.eligible.length > 1 ? ` with ${this.highName(pot.winnersHi[0], values)}` : '';
        summary.push(`${names(pot.winnersHi)} ${pot.winnersHi.length > 1 ? 'split' : 'wins'} ${potName} (${pot.amount})${how}`);
      }
    });
    for (const s of summary) this.say('win', s);
    this.result = { showdown, pots, won, handNames, summary };
  }

  private highName(i: number, values: Map<number, { hi: number | null }>): string {
    const v = values.get(i);
    return v && v.hi !== null ? describeHigh(v.hi, this.variant.shortDeck) : '';
  }

  private lowName(i: number, values: Map<number, { lo: number | null }>): string {
    const v = values.get(i);
    return v && v.lo !== null ? describeLow(v.lo) : '';
  }
}
