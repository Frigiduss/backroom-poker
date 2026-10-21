// Blackjack against the house: a six-deck shoe, the dealer's hand, and every seat's hands
// through splits and doubles. Pure rules and no DOM, like the poker engine, so the table
// screen, the bots and the tests all play by the same code.
//
// House rules: six decks, the dealer peeks for blackjack under an ace or a ten, stands on all
// 17s, blackjack pays 3 to 2 and insurance 2 to 1. Players may double any first two cards
// (after a split too), split pairs of the same value up to four hands, and split aces once
// for one card each.
import { Card, Rng, Seed, SeededRng, cardLabel, createRng, fullDeck, rankOf, shuffle } from './cards';

export const BJ_DECKS = 6;
/** Share of the shoe dealt before the cut card comes out and the shoe is reshuffled. */
export const BJ_PENETRATION = 0.75;
/** Hands one seat can hold after splitting. */
export const BJ_MAX_HANDS = 4;

export type BjLimits = 'low' | 'mid' | 'high';
/** Table limits: the smallest and largest bet on one hand. */
export const BJ_LIMITS: Record<BjLimits, { min: number; max: number }> = {
  low: { min: 10, max: 500 },
  mid: { min: 50, max: 2500 },
  high: { min: 250, max: 10_000 },
};

/** Blackjack value of one card: aces count 11 here (handTotal brings them down to 1). */
export function cardPoints(c: Card): number {
  const r = rankOf(c);
  return r === 14 ? 11 : Math.min(10, r);
}

export interface Total {
  total: number;
  /** An ace still counts 11, so one more card can't bust the hand. */
  soft: boolean;
}

export function handTotal(cards: readonly Card[]): Total {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const p = cardPoints(c);
    if (p === 11) aces++;
    total += p;
  }
  while (total > 21 && aces) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

export const isNatural = (cards: readonly Card[]): boolean => cards.length === 2 && handTotal(cards).total === 21;

/** "Soft 17", "12", "Blackjack", "Bust 24". */
export function describeTotal(cards: readonly Card[], natural = isNatural(cards)): string {
  if (!cards.length) return '';
  if (natural) return 'Blackjack';
  const t = handTotal(cards);
  if (t.total > 21) return `Bust ${t.total}`;
  return t.soft && t.total < 21 ? `Soft ${t.total}` : String(t.total);
}

// ---------- the shoe ----------

export class Shoe {
  private cards: Card[] = [];
  private dealt = 0;
  private cut = 0;
  /** Cards to deal next, in order, before the shuffled ones (tests). */
  private rigged: Card[] = [];
  /** Bumps on every shuffle, so the table can play the shuffle sound. */
  shuffles = 0;

  constructor(readonly decks: number, private readonly rng: Rng) {
    this.shuffle();
  }

  get size(): number {
    return this.decks * 52;
  }

  get remaining(): number {
    return this.cards.length;
  }

  /** The cut card has come out: shuffle before the next round. */
  get needsShuffle(): boolean {
    return this.dealt >= this.cut;
  }

  shuffle() {
    const cards: Card[] = [];
    for (let d = 0; d < this.decks; d++) cards.push(...fullDeck());
    this.cards = shuffle(cards, this.rng);
    this.dealt = 0;
    this.cut = Math.round(this.size * BJ_PENETRATION);
    this.shuffles++;
  }

  rig(cards: readonly Card[]) {
    this.rigged.push(...cards);
  }

  /** Cards on top of the shoe that the developer console put there. */
  private stacked = 0;
  /** Whether the last card drawn was one the console stacked. */
  lastWasRigged = false;

  draw(): Card {
    this.lastWasRigged = false;
    if (this.rigged.length) return this.rigged.shift()!;
    if (!this.cards.length) this.shuffle();
    this.dealt++;
    this.lastWasRigged = this.stacked > 0;
    if (this.stacked > 0) this.stacked--;
    return this.cards.pop()!;
  }

  /** The next `n` cards out of the shoe, first one first (the developer console's peek). */
  upcoming(n: number): Card[] {
    return [...this.rigged, ...this.cards.slice(-n).reverse()].slice(0, n);
  }

  /** Takes one copy of `card` out of the shoe. False when every copy is already out. */
  take(card: Card): boolean {
    const i = this.cards.lastIndexOf(card);
    if (i < 0) return false;
    this.cards.splice(i, 1);
    if (i >= this.cards.length - this.stacked + 1) this.stacked--;
    return true;
  }

  /** Puts a card back under the rest, where it won't come out this shoe. */
  putBack(card: Card) {
    this.cards.unshift(card);
  }

  /**
   * Moves these cards to the top of the shoe, so they come out next in this order. A card
   * with every copy already dealt is added anyway: the console can deal a seventh ace.
   */
  stackTop(cards: readonly Card[]) {
    for (const c of cards) this.take(c);
    this.cards.push(...[...cards].reverse());
    this.stacked += cards.length;
  }

  /** The shoe as plain data, for a server to save between requests. */
  save(): ShoeData {
    return { decks: this.decks, cards: [...this.cards], dealt: this.dealt, cut: this.cut, shuffles: this.shuffles, rng: (this.rng as SeededRng).state ?? 0, stacked: this.stacked };
  }

  static load(d: ShoeData): Shoe {
    const rng = createRng(d.rng);
    const shoe = new Shoe(d.decks, rng);
    shoe.cards = [...d.cards];
    shoe.dealt = d.dealt;
    shoe.cut = d.cut;
    shoe.shuffles = d.shuffles;
    shoe.stacked = d.stacked ?? 0;
    rng.state = d.rng;
    return shoe;
  }
}

/** A saved shoe. Needs a seeded rng (createRng) so later shuffles carry on from `rng`. */
export interface ShoeData {
  decks: number;
  cards: Card[];
  dealt: number;
  cut: number;
  shuffles: number;
  rng: Seed;
  stacked?: number;
}

// ---------- a round ----------

export type BjAction = 'hit' | 'stand' | 'double' | 'split';
export type Outcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust';
export type Phase = 'insurance' | 'play' | 'dealer' | 'done';

export interface BjHand {
  cards: Card[];
  bet: number;
  doubled: boolean;
  /** Came from splitting a pair. A split hand's 21 is never a blackjack. */
  split: boolean;
  /** Split aces take one card each and stop. */
  splitAces: boolean;
  done: boolean;
  outcome: Outcome | null;
  /** Chips this hand hands back at the end: the bet plus any winnings. */
  payout: number;
}

export interface BjSeat {
  id: string;
  name: string;
  /** Chips not on the table. Every wager comes out of it and every payout goes back. */
  stack: number;
  hands: BjHand[];
  /** Insurance bet, or 0. Null until the seat has decided (only asked under an ace). */
  insurance: number | null;
  /** Total wagered this round, insurance included. */
  wagered: number;
  /** Total returned this round, insurance included. */
  returned: number;
}

export interface SeatEntry {
  id: string;
  name: string;
  stack: number;
  bet: number;
}

export interface BjEvent {
  kind: 'deal' | 'card' | 'flip' | 'action' | 'insurance' | 'result' | 'info';
  text: string;
  seat?: number;
}

export interface BjLegal {
  hit: boolean;
  stand: boolean;
  double: boolean;
  split: boolean;
}

const NONE: BjLegal = { hit: false, stand: false, double: false, split: false };

const newHand = (bet: number, cards: Card[] = [], split = false): BjHand => ({
  cards, bet, doubled: false, split, splitAces: false, done: false, outcome: null, payout: 0,
});

/** A saved round: everything but the shoe. */
export interface RoundData {
  seats: BjSeat[];
  dealer: Card[];
  holeShown: boolean;
  phase: Phase;
  seatTurn: number;
  handTurn: number;
  log: BjEvent[];
  rigged?: boolean;
}

/** Cards the developer console fixed for a round: each seat's two (by seat id), and the dealer's upcard and hole card. */
export interface RoundRig {
  seats?: Record<string, Card[]>;
  dealer?: Card[];
}

/** A round as the players see it: the dealer's hole card stays hidden until it is turned. */
export interface RoundView {
  seats: (BjSeat & { net: number | null })[];
  /** null for the face-down hole card. */
  dealer: (Card | null)[];
  holeShown: boolean;
  phase: Phase;
  seatTurn: number;
  handTurn: number;
  insuranceTurn: number;
  log: BjEvent[];
}

export class Round {
  readonly seats: BjSeat[];
  readonly dealer: Card[] = [];
  holeShown = false;
  phase: Phase = 'play';
  /** The seat and hand whose turn it is, while playing. */
  seatTurn = -1;
  handTurn = 0;
  readonly log: BjEvent[] = [];
  /** The developer console fixed some of this round's cards, so it earns no achievements. */
  rigged = false;

  constructor(private readonly shoe: Shoe, entries: readonly SeatEntry[], rig?: RoundRig | null) {
    if (!entries.length) throw new Error('A round needs at least one seat.');
    this.seats = entries.map((e) => {
      if (!(e.bet > 0) || e.bet > e.stack) throw new Error(`${e.name} can't cover a bet of ${e.bet}.`);
      return { id: e.id, name: e.name, stack: e.stack - e.bet, hands: [newHand(e.bet)], insurance: null, wagered: e.bet, returned: 0 };
    });
    for (let pass = 0; pass < 2; pass++) {
      for (const s of this.seats) s.hands[0].cards.push(this.dealFrom(rig?.seats?.[s.id]?.[pass]));
      this.dealer.push(this.dealFrom(rig?.dealer?.[pass]));
    }
    this.say('deal', `Dealer shows ${cardLabel(this.upcard)}`);
    if (rankOf(this.upcard) === 14) {
      this.phase = 'insurance';
      // Seats that can't afford half their bet are not asked.
      this.seats.forEach((s) => {
        if (s.stack < this.insuranceCost(s)) s.insurance = 0;
      });
      if (this.insuranceTurn() < 0) this.peek();
    } else if (cardPoints(this.upcard) === 10) this.peek();
    else this.beginPlay();
  }

  save(): RoundData {
    const { seats, dealer, holeShown, phase, seatTurn, handTurn, log, rigged } = this;
    return JSON.parse(JSON.stringify({ seats, dealer, holeShown, phase, seatTurn, handTurn, log, rigged }));
  }

  /** Picks a saved round back up, dealing from `shoe`. */
  static load(shoe: Shoe, d: RoundData): Round {
    const r = Object.create(Round.prototype) as Round;
    Object.assign(r, JSON.parse(JSON.stringify(d)), { shoe });
    return r;
  }

  view(): RoundView {
    const d = this.save();
    return {
      seats: d.seats.map((s, i) => ({ ...s, net: this.isComplete ? this.net(i) : null })),
      dealer: d.dealer.map((c, k) => (k === 1 && !d.holeShown ? null : c)),
      holeShown: d.holeShown,
      phase: d.phase,
      seatTurn: d.seatTurn,
      handTurn: d.handTurn,
      insuranceTurn: this.insuranceTurn(),
      log: d.log,
    };
  }

  get upcard(): Card {
    return this.dealer[0];
  }

  private draw(): Card {
    const c = this.shoe.draw();
    if (this.shoe.lastWasRigged) this.rigged = true;
    return c;
  }

  /** A card the console fixed, taken out of the shoe; or the next card off the shoe. */
  private dealFrom(fixed: Card | undefined): Card {
    if (fixed === undefined) return this.draw();
    this.shoe.take(fixed);
    this.rigged = true;
    return fixed;
  }

  /** The developer console: swaps the dealer's face-down card. The old one goes under the shoe. */
  setHole(card: Card) {
    if (this.holeShown || this.isComplete) throw new Error('The hole card is already face up.');
    const peeked = this.phase !== 'insurance' && (rankOf(this.upcard) === 14 || cardPoints(this.upcard) === 10);
    if (peeked && isNatural([this.upcard, card])) throw new Error('The dealer already checked for blackjack, so that card can\'t be the hole card now.');
    this.shoe.take(card);
    this.shoe.putBack(this.dealer[1]);
    this.dealer[1] = card;
    this.rigged = true;
  }

  get isComplete(): boolean {
    return this.phase === 'done';
  }

  /** The dealer's cards as the players see them. */
  get dealerVisible(): Card[] {
    return this.holeShown ? this.dealer : this.dealer.slice(0, 1);
  }

  get hand(): BjHand | null {
    return this.phase === 'play' && this.seatTurn >= 0 ? this.seats[this.seatTurn].hands[this.handTurn] : null;
  }

  insuranceCost(s: BjSeat): number {
    return Math.floor(s.hands[0].bet / 2);
  }

  /** The next seat to decide on insurance, or -1. */
  insuranceTurn(): number {
    return this.phase === 'insurance' ? this.seats.findIndex((s) => s.insurance === null) : -1;
  }

  insure(seat: number, take: boolean) {
    if (seat !== this.insuranceTurn()) throw new Error('Not your turn to decide on insurance.');
    const s = this.seats[seat];
    const cost = this.insuranceCost(s);
    if (take && cost > 0 && s.stack >= cost) {
      s.stack -= cost;
      s.wagered += cost;
      s.insurance = cost;
      this.say('insurance', `${s.name} ${isNatural(s.hands[0].cards) ? 'takes even money' : `takes insurance for ${cost}`}`, seat);
    } else s.insurance = 0;
    if (this.insuranceTurn() < 0) this.peek();
  }

  /** The dealer checks the hole card. A dealer blackjack ends the round at once. */
  private peek() {
    if (isNatural(this.dealer)) {
      this.holeShown = true;
      this.say('flip', 'Dealer has blackjack');
      for (const s of this.seats) {
        if (s.insurance) {
          s.stack += s.insurance * 3;
          s.returned += s.insurance * 3;
        }
      }
      this.settle();
      return;
    }
    if (rankOf(this.upcard) === 14 && this.seats.some((s) => s.insurance)) this.say('info', 'Dealer does not have blackjack. Insurance loses.');
    this.beginPlay();
  }

  private beginPlay() {
    this.phase = 'play';
    for (const s of this.seats) {
      const h = s.hands[0];
      if (isNatural(h.cards)) {
        h.done = true;
        this.say('action', `${s.name} has blackjack`, this.seats.indexOf(s));
      }
    }
    this.seatTurn = 0;
    this.handTurn = 0;
    this.advance();
  }

  legal(): BjLegal {
    const h = this.hand;
    if (!h || h.done) return NONE;
    const s = this.seats[this.seatTurn];
    const two = h.cards.length === 2;
    return {
      hit: true,
      stand: true,
      double: two && s.stack >= h.bet,
      split: two && cardPoints(h.cards[0]) === cardPoints(h.cards[1]) && s.hands.length < BJ_MAX_HANDS && s.stack >= h.bet && !h.splitAces,
    };
  }

  act(a: BjAction) {
    const L = this.legal();
    if (!L[a]) throw new Error(`Can't ${a} now.`);
    const si = this.seatTurn;
    const s = this.seats[si];
    const h = this.hand!;
    if (a === 'hit') {
      const c = this.draw();
      h.cards.push(c);
      const t = handTotal(h.cards);
      this.say('card', `${s.name} hits: ${cardLabel(c)} (${describeTotal(h.cards, false)})`, si);
      if (t.total >= 21) h.done = true;
    } else if (a === 'stand') {
      h.done = true;
      this.say('action', `${s.name} stands on ${describeTotal(h.cards, false).toLowerCase()}`, si);
    } else if (a === 'double') {
      s.stack -= h.bet;
      s.wagered += h.bet;
      h.bet *= 2;
      h.doubled = true;
      const c = this.draw();
      h.cards.push(c);
      h.done = true;
      this.say('card', `${s.name} doubles to ${h.bet}: ${cardLabel(c)} (${describeTotal(h.cards, false)})`, si);
    } else {
      s.stack -= h.bet;
      s.wagered += h.bet;
      const aces = rankOf(h.cards[0]) === 14;
      const second = newHand(h.bet, [h.cards.pop()!], true);
      h.split = true;
      s.hands.splice(this.handTurn + 1, 0, second);
      this.say('action', `${s.name} splits ${aces ? 'aces' : `${describeTotal([h.cards[0]], false)}s`}`, si);
      for (const x of [h, second]) {
        if (!aces) continue;
        // Split aces get one card each and no more.
        x.splitAces = true;
        x.cards.push(this.draw());
        x.done = true;
      }
      if (!aces) this.dealSecond(h);
    }
    this.advance();
  }

  /** A split hand gets its second card when its turn comes. */
  private dealSecond(h: BjHand) {
    if (h.cards.length !== 1) return;
    const c = this.draw();
    h.cards.push(c);
    this.say('card', `${this.seats[this.seatTurn].name} gets ${cardLabel(c)} (${describeTotal(h.cards, false)})`, this.seatTurn);
    if (handTotal(h.cards).total === 21) h.done = true;
  }

  /** Moves the turn to the next hand that still needs a decision, or on to the dealer. */
  private advance() {
    for (; this.seatTurn < this.seats.length; this.seatTurn++, this.handTurn = 0) {
      const hands = this.seats[this.seatTurn].hands;
      for (; this.handTurn < hands.length; this.handTurn++) {
        const h = hands[this.handTurn];
        this.dealSecond(h);
        if (!h.done) return;
      }
    }
    this.seatTurn = -1;
    this.phase = 'dealer';
  }

  /** Hands still waiting on the dealer (not bust, not a blackjack already paid). */
  private get live(): boolean {
    return this.seats.some((s) => s.hands.some((h) => handTotal(h.cards).total <= 21 && !(isNatural(h.cards) && !h.split)));
  }

  /**
   * One move by the dealer: turn the hole card, then draw to 17. Returns false once the
   * dealer is done and the round is settled.
   */
  dealerStep(): boolean {
    if (this.phase !== 'dealer') return false;
    if (!this.holeShown) {
      this.holeShown = true;
      this.say('flip', `Dealer turns ${cardLabel(this.dealer[1])} (${describeTotal(this.dealer)})`);
      return true;
    }
    if (this.live && handTotal(this.dealer).total < 17) {
      const c = this.draw();
      this.dealer.push(c);
      this.say('card', `Dealer draws ${cardLabel(c)} (${describeTotal(this.dealer, false)})`);
      return true;
    }
    this.settle();
    return false;
  }

  /** Plays the dealer out in one go. */
  finish() {
    while (this.dealerStep());
  }

  private settle() {
    this.phase = 'done';
    this.holeShown = true;
    const dealerNatural = isNatural(this.dealer);
    const d = handTotal(this.dealer).total;
    this.seats.forEach((s, si) => {
      for (const h of s.hands) {
        const natural = isNatural(h.cards) && !h.split;
        const t = handTotal(h.cards).total;
        let outcome: Outcome;
        if (t > 21) outcome = 'bust';
        else if (dealerNatural) outcome = natural ? 'push' : 'lose';
        else if (natural) outcome = 'blackjack';
        else if (d > 21 || t > d) outcome = 'win';
        else outcome = t === d ? 'push' : 'lose';
        h.outcome = outcome;
        h.payout = outcome === 'blackjack' ? h.bet + Math.floor((h.bet * 3) / 2) : outcome === 'win' ? h.bet * 2 : outcome === 'push' ? h.bet : 0;
        h.done = true;
        s.stack += h.payout;
        s.returned += h.payout;
      }
      const net = this.net(si);
      this.say('result', `${s.name} ${net > 0 ? `wins ${net}` : net < 0 ? `loses ${-net}` : 'breaks even'}`, si);
    });
  }

  /** What the seat won (or lost, if negative) this round. */
  net(seat: number): number {
    const s = this.seats[seat];
    return s.returned - s.wagered;
  }

  private say(kind: BjEvent['kind'], text: string, seat?: number) {
    this.log.push({ kind, text, seat });
  }
}

// ---------- basic strategy ----------

/**
 * The best play by the book for these rules (six decks, dealer stands on soft 17, double after
 * split). The bots play it, and the table can show it as a hint.
 */
export function basicStrategy(cards: readonly Card[], upcard: Card, can: { double: boolean; split: boolean }): BjAction {
  const up = cardPoints(upcard);
  const { total, soft } = handTotal(cards);
  const between = (lo: number, hi: number) => up >= lo && up <= hi;
  if (can.split && cards.length === 2 && cardPoints(cards[0]) === cardPoints(cards[1])) {
    const p = cardPoints(cards[0]);
    const split =
      p === 11 || p === 8 ? true
        : p === 9 ? between(2, 6) || up === 8 || up === 9
          : p === 7 ? between(2, 7)
            : p === 6 ? between(2, 6)
              : p === 4 ? between(5, 6)
                : p === 3 || p === 2 ? between(2, 7)
                  : false;
    if (split) return 'split';
  }
  const dbl = (fallback: BjAction): BjAction => (can.double ? 'double' : fallback);
  if (soft) {
    if (total >= 19) return 'stand';
    if (total === 18) return between(3, 6) ? dbl('stand') : up === 2 || up === 7 || up === 8 ? 'stand' : 'hit';
    if (total === 17) return between(3, 6) ? dbl('hit') : 'hit';
    if (total === 16 || total === 15) return between(4, 6) ? dbl('hit') : 'hit';
    if (total === 14 || total === 13) return between(5, 6) ? dbl('hit') : 'hit';
    return 'hit';
  }
  if (total >= 17) return 'stand';
  if (total >= 13) return between(2, 6) ? 'stand' : 'hit';
  if (total === 12) return between(4, 6) ? 'stand' : 'hit';
  if (total === 11) return up === 11 ? 'hit' : dbl('hit');
  if (total === 10) return between(2, 9) ? dbl('hit') : 'hit';
  if (total === 9) return between(3, 6) ? dbl('hit') : 'hit';
  return 'hit';
}

/** The book play for the hand whose turn it is. */
export function bookPlay(round: Round): BjAction | null {
  const h = round.hand;
  if (!h) return null;
  const L = round.legal();
  return basicStrategy(h.cards, round.upcard, L);
}
