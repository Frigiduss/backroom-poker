// Blackjack against the house: a six-deck shoe, the dealer's hand, and every seat's hands
// through splits and doubles. Pure rules and no DOM, like the poker engine, so the table
// screen, the bots and the tests all play by the same code.
//
// House rules: six decks, the dealer peeks for blackjack under an ace or a ten, stands on all
// 17s, blackjack pays 3 to 2 and insurance 2 to 1. Players may double any first two cards
// (after a split too), split pairs of the same value up to four hands, and split aces once
// for one card each.
import { Card, Rng, cardLabel, fullDeck, rankOf, shuffle } from './cards';

export const BJ_DECKS = 6;
/** Share of the shoe dealt before the cut card comes out and the shoe is reshuffled. */
export const BJ_PENETRATION = 0.75;
/** Hands one seat can hold after splitting. */
export const BJ_MAX_HANDS = 4;

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
  /** Cards to deal next, in order, before the shuffled ones (tests and the console). */
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

  draw(): Card {
    if (this.rigged.length) return this.rigged.shift()!;
    if (!this.cards.length) this.shuffle();
    this.dealt++;
    return this.cards.pop()!;
  }
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

export class Round {
  readonly seats: BjSeat[];
  readonly dealer: Card[] = [];
  holeShown = false;
  phase: Phase = 'play';
  /** The seat and hand whose turn it is, while playing. */
  seatTurn = -1;
  handTurn = 0;
  readonly log: BjEvent[] = [];

  constructor(private readonly shoe: Shoe, entries: readonly SeatEntry[]) {
    if (!entries.length) throw new Error('A round needs at least one seat.');
    this.seats = entries.map((e) => {
      if (!(e.bet > 0) || e.bet > e.stack) throw new Error(`${e.name} can't cover a bet of ${e.bet}.`);
      return { id: e.id, name: e.name, stack: e.stack - e.bet, hands: [newHand(e.bet)], insurance: null, wagered: e.bet, returned: 0 };
    });
    for (let pass = 0; pass < 2; pass++) {
      for (const s of this.seats) s.hands[0].cards.push(this.shoe.draw());
      this.dealer.push(this.shoe.draw());
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

  get upcard(): Card {
    return this.dealer[0];
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
      const c = this.shoe.draw();
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
      const c = this.shoe.draw();
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
        x.cards.push(this.shoe.draw());
        x.done = true;
      }
      if (!aces) this.dealSecond(h);
    }
    this.advance();
  }

  /** A split hand gets its second card when its turn comes. */
  private dealSecond(h: BjHand) {
    if (h.cards.length !== 1) return;
    const c = this.shoe.draw();
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
      const c = this.shoe.draw();
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
