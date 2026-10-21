import { Seed, SeededRng, createRng } from './cards';
import { Card } from './cards';
import { ActionRecord, Hand, Rig, Stakes } from './hand';
import { Structure, VARIANTS, VariantDef, VariantId } from './variants';

export type Format = 'cash' | 'sng' | 'headsup';
export type Difficulty = 'beginner' | 'easy' | 'medium' | 'hard' | 'expert';
export type BotStyle = 'balanced' | 'tight' | 'loose' | 'aggressive' | 'passive';

export const FORMAT_NAMES: Record<Format, string> = { cash: 'Cash game', sng: 'Sit & Go tournament', headsup: 'Heads-up duel' };
export const DIFFICULTIES: Difficulty[] = ['beginner', 'easy', 'medium', 'hard', 'expert'];
export const DIFFICULTY_NAMES: Record<Difficulty, string> = { beginner: 'Beginner', easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };

export interface SeatConfig {
  name: string;
  isHuman: boolean;
  difficulty?: Difficulty;
  style?: BotStyle;
}

export interface TableConfig {
  variant: VariantId;
  structure: Structure;
  format: Format;
  startingStack: number;
  bigBlind: number;
  /** Tournaments: hands between blind increases. */
  handsPerLevel: number;
  seats: SeatConfig[];
  seed?: Seed;
}

export interface Seat {
  id: string;
  name: string;
  isHuman: boolean;
  difficulty?: Difficulty;
  style?: BotStyle;
  stack: number;
  /** Out of a tournament, or broke in a cash game until rebuy. */
  busted: boolean;
  /** Tournament finishing place (1 = winner). */
  place?: number;
  rebuys: number;
}

/** Public, observable tendencies (anyone at the table could track these). */
export interface PlayerStats {
  hands: number;
  vpip: number;
  pfr: number;
  bets: number;
  calls: number;
  folds: number;
  showdowns: number;
  showdownWins: number;
}

export const emptyStats = (): PlayerStats => ({ hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0, folds: 0, showdowns: 0, showdownWins: 0 });

const LEVEL_MULTIPLIERS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512];

function niceRound(x: number): number {
  if (x < 10) return Math.max(1, Math.round(x));
  const mag = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / mag / 5) * 5 * mag || Math.round(x);
}

export function stakesFor(v: VariantDef, bb: number, level: number, format: Format): Stakes {
  const big = niceRound(bb * LEVEL_MULTIPLIERS[Math.min(level, LEVEL_MULTIPLIERS.length - 1)]);
  if (v.family === 'stud') {
    const ante = Math.max(1, Math.round(big / 10));
    return { sb: 0, bb: big, ante, bringIn: Math.max(ante, Math.round(big / 4)), smallBet: big, bigBet: big * 2 };
  }
  const ante = format !== 'cash' && level >= 4 ? Math.max(1, Math.round(big / 10)) : 0;
  return { sb: Math.max(1, Math.floor(big / 2)), bb: big, ante, bringIn: 0, smallBet: big, bigBet: big * 2 };
}

/** A session at one table: seats, the button, blind levels, and one hand at a time. */
export class Table {
  readonly config: TableConfig;
  readonly variant: VariantDef;
  readonly seats: Seat[];
  readonly stats: Record<string, PlayerStats> = {};
  readonly rng: SeededRng;
  hand: Hand | null = null;
  /** Seat index of the dealer button. */
  button = -1;
  handNumber = 0;
  level = 0;
  /** Seat ids in the current hand, matching hand.players order. */
  handSeats: string[] = [];
  private settledHand: Hand | null = null;
  /** Testing: cards to deal in the next hand, by seat id. Used once, then cleared. */
  nextRig: { hole: Record<string, Card[]>; board: Card[] } | null = null;

  constructor(config: TableConfig) {
    this.config = config;
    this.variant = VARIANTS[config.variant];
    this.rng = createRng(config.seed);
    this.seats = config.seats.map((s, i) => ({
      id: `p${i}`,
      name: s.name,
      isHuman: s.isHuman,
      difficulty: s.difficulty,
      style: s.style,
      stack: config.startingStack,
      busted: false,
      rebuys: 0,
    }));
    for (const s of this.seats) this.stats[s.id] = emptyStats();
    this.button = Math.floor(this.rng.next() * this.seats.length) - 1;
  }

  get isTournament(): boolean {
    return this.config.format !== 'cash';
  }

  get stakes(): Stakes {
    return stakesFor(this.variant, this.config.bigBlind, this.level, this.config.format);
  }

  get liveSeats(): Seat[] {
    return this.seats.filter((s) => !s.busted && s.stack > 0);
  }

  get isOver(): boolean {
    return this.isTournament && this.liveSeats.length <= 1;
  }

  handsUntilNextLevel(): number {
    if (!this.isTournament) return Infinity;
    const per = Math.max(1, this.config.handsPerLevel);
    return per - (this.handNumber % per);
  }

  seatOf(handIndex: number): Seat {
    return this.seats.find((s) => s.id === this.handSeats[handIndex])!;
  }

  handIndexOf(seatId: string): number {
    return this.handSeats.indexOf(seatId);
  }

  nextHand(): Hand {
    if (this.hand && !this.hand.isComplete) throw new Error('The current hand is not finished');
    if (this.hand) this.finishHand();
    const live = this.liveSeats;
    if (live.length < 2) throw new Error('Not enough players with chips');
    // Move the button to the next seat that still has chips.
    for (let k = 1; k <= this.seats.length; k++) {
      const i = (this.button + k + this.seats.length) % this.seats.length;
      const s = this.seats[i];
      if (!s.busted && s.stack > 0) {
        this.button = i;
        break;
      }
    }
    if (this.isTournament && this.handNumber > 0 && this.handNumber % Math.max(1, this.config.handsPerLevel) === 0) this.level++;
    this.handNumber++;
    this.handSeats = live.map((s) => s.id);
    const buttonId = this.seats[this.button].id;
    let rig: Rig | undefined;
    if (this.nextRig) {
      const hole: Record<number, Card[]> = {};
      for (const [id, cards] of Object.entries(this.nextRig.hole)) if (this.handSeats.includes(id)) hole[this.handSeats.indexOf(id)] = cards;
      rig = { hole, board: this.nextRig.board };
      this.nextRig = null;
    }
    this.hand = new Hand({
      variant: this.variant,
      structure: this.config.structure,
      stakes: this.stakes,
      players: live.map((s) => ({ id: s.id, name: s.name, stack: s.stack })),
      button: this.handSeats.indexOf(buttonId),
      rng: this.rng,
      rig,
    });
    return this.hand;
  }

  /** Copy stacks back, update stats, and handle busts. Safe to call twice. */
  finishHand(): void {
    const hand = this.hand;
    if (!hand || !hand.isComplete || this.settledHand === hand) return;
    this.settledHand = hand;
    hand.players.forEach((p, i) => {
      const seat = this.seatOf(i);
      seat.stack = p.stack;
    });
    this.updateStats(hand);
    const busted = hand.players
      .map((p, i) => ({ p, seat: this.seatOf(i) }))
      .filter(({ seat }) => seat.stack === 0 && !seat.busted)
      .sort((a, b) => b.p.startStack - a.p.startStack);
    let remaining = this.seats.filter((s) => !s.busted).length;
    for (const { seat } of busted) {
      seat.busted = true;
      if (this.isTournament) seat.place = remaining;
      remaining--;
    }
    if (this.isTournament) {
      const left = this.liveSeats;
      if (left.length === 1) left[0].place = 1;
    } else {
      // Bots in a cash game buy back in right away.
      for (const s of this.seats) if (s.busted && !s.isHuman) this.rebuy(s.id);
    }
  }

  rebuy(seatId: string): void {
    const s = this.seats.find((x) => x.id === seatId);
    if (!s || this.isTournament) return;
    s.stack = this.config.startingStack;
    s.busted = false;
    s.rebuys++;
  }

  private updateStats(hand: Hand) {
    const per = new Map<number, ActionRecord[]>();
    for (const a of hand.actions) {
      if (!per.has(a.player)) per.set(a.player, []);
      per.get(a.player)!.push(a);
    }
    hand.players.forEach((p, i) => {
      const st = this.stats[this.handSeats[i]];
      st.hands++;
      const acts = per.get(i) ?? [];
      const pre = acts.filter((a) => a.street === 0);
      if (pre.some((a) => a.type === 'call' || a.type === 'raise')) st.vpip++;
      if (pre.some((a) => a.type === 'raise')) st.pfr++;
      for (const a of acts) {
        if (a.type === 'raise') st.bets++;
        else if (a.type === 'call') st.calls++;
        else if (a.type === 'fold') st.folds++;
      }
      if (hand.result?.showdown && p.shown) {
        st.showdowns++;
        if (hand.result.won[i] > 0) st.showdownWins++;
      }
    });
  }
}
