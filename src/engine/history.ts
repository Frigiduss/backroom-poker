// Hand histories: a finished hand saved as plain data from one player's seat, and the
// frames that replay it street by street. Only cards that player could see are kept:
// their own, cards dealt face up, and hands shown down at the end.
import { Card } from './cards';
import { ActionRecord, Hand, HandResult, Stakes } from './hand';
import { Structure, VARIANTS, VariantId } from './variants';

export interface HistoryPlayer {
  name: string;
  /** Chips at the start of the hand. */
  start: number;
  /** Chips at the end of the hand. */
  end: number;
  /** Every card dealt to this player in order, null where the viewer never saw it. */
  cards: (Card | null)[];
  /** Showed down at the end. */
  shown: boolean;
  /** Chips collected from the pot. */
  won: number;
  /** Showdown hand description, if shown. */
  handName: string | null;
}

/** One action as [player, street, type, chips added, round total after, all-in, discarded positions]. */
export type HistoryAction = [number, number, ActionRecord['type'], number, number, 0 | 1, number[]?];

export interface HandHistory {
  v: 1;
  /** Unique within a player's saved hands. */
  id: string;
  at: number;
  variant: VariantId;
  structure: Structure;
  stakes: Stakes;
  button: number;
  /** The viewer's index in players. */
  me: number;
  /** Where it was played: "Cash game", "Online · K7QD", "Practice"… */
  where: string;
  /** Hand number at that table. */
  number: number;
  players: HistoryPlayer[];
  board: Card[];
  actions: HistoryAction[];
  showdown: boolean;
  summary: string[];
}

/** What a hand looks like from one seat: a local Hand or an online HandView can both give this. */
export interface HistorySource {
  variant: VariantId;
  structure: Structure;
  stakes: Stakes;
  button: number;
  board: readonly Card[];
  players: readonly { name: string; startStack: number; stack: number; dealt?: readonly (Card | null)[]; shown: boolean }[];
  actions: readonly ActionRecord[];
  result: HandResult | null;
}

/** The cards one player was dealt, as `viewer` saw them by the end of the hand. */
export function dealtAsSeen(p: { cards: readonly Card[]; faceUp: readonly boolean[]; dealt: readonly Card[]; shown: boolean }, mine: boolean): (Card | null)[] {
  return p.dealt.map((c) => {
    if (mine) return c;
    const k = p.cards.indexOf(c);
    return k >= 0 && (p.shown || p.faceUp[k]) ? c : null;
  });
}

/** A local hand as seen from seat `me`. */
export function sourceOfHand(hand: Hand, me: number): HistorySource {
  return {
    variant: hand.variant.id,
    structure: hand.structure,
    stakes: hand.stakes,
    button: hand.button,
    board: hand.board,
    players: hand.players.map((p, i) => ({ name: p.name, startStack: p.startStack, stack: p.stack, shown: p.shown, dealt: dealtAsSeen(p, i === me) })),
    actions: hand.actions,
    result: hand.result,
  };
}

/** Saves a finished hand as history, or null if it isn't finished or lacks the dealt cards. */
export function recordHistory(src: HistorySource, me: number, meta: { where: string; number: number; at?: number }): HandHistory | null {
  const res = src.result;
  if (!res || src.players.some((p) => !p.dealt)) return null;
  const at = meta.at ?? Date.now();
  return {
    v: 1,
    id: `${at.toString(36)}-${meta.number}`,
    at,
    variant: src.variant,
    structure: src.structure,
    stakes: { ...src.stakes },
    button: src.button,
    me,
    where: meta.where,
    number: meta.number,
    players: src.players.map((p, i) => ({
      name: p.name,
      start: p.startStack,
      end: p.stack,
      cards: [...p.dealt!],
      shown: p.shown,
      won: res.won[i] ?? 0,
      handName: res.handNames[i] ?? null,
    })),
    board: [...src.board],
    actions: src.actions.map((a) => {
      const row: HistoryAction = [a.player, a.street, a.type, a.amount, a.to, a.allIn ? 1 : 0];
      if (a.discard) row.push([...a.discard]);
      return row;
    }),
    showdown: res.showdown,
    summary: [...res.summary],
  };
}

/** The viewer's chips won or lost in the hand. */
export function historyNet(h: HandHistory): number {
  const me = h.players[h.me];
  return me ? me.end - me.start : 0;
}

// ---------- replay ----------

export interface FrameCard {
  card: Card | null;
  up: boolean;
}

export interface FramePlayer {
  name: string;
  stack: number;
  /** Chips in front of the player this round. */
  bet: number;
  status: 'active' | 'folded' | 'allin';
  /** What they did last this round ("Raise 60"), or null. */
  action: string | null;
  cards: FrameCard[];
  /** Final frame: chips collected and the hand shown. */
  won: number;
  handName: string | null;
}

export interface Frame {
  /** The part of the hand this frame belongs to ("Flop", "The draw", "Result"). */
  chapter: string;
  board: Card[];
  pot: number;
  /** Who acted in this frame, or -1 for a deal or the result. */
  actor: number;
  text: string;
  players: FramePlayer[];
  final: boolean;
}

const FLOP_STREETS = ['Pre-flop', 'Flop', 'Turn', 'River'];
const STUD_STREETS = ['Third street', 'Fourth street', 'Fifth street', 'Sixth street', 'Seventh street'];

/** Every step of a saved hand, from the deal to the result. */
export function replayFrames(h: HandHistory): Frame[] {
  const variant = VARIANTS[h.variant];
  const family = variant.family;
  const n = h.players.length;
  const total = h.players.map(() => 0);
  const bet = h.players.map(() => 0);
  const status: FramePlayer['status'][] = h.players.map(() => 'active');
  const said: (string | null)[] = h.players.map(() => null);
  // Draw games: each player's hand, as positions into their dealt cards.
  const held: number[][] = h.players.map(() => Array.from({ length: variant.holeCards }, (_, k) => k));
  const nextDraw = h.players.map(() => variant.holeCards);
  const frames: Frame[] = [];
  let street = 0;
  let drawing = false;
  let roundBet = 0;
  let aggression = 0;

  const chapter = (): string => {
    if (family === 'flop') return FLOP_STREETS[street] ?? `Street ${street + 1}`;
    if (family === 'stud') return STUD_STREETS[street] ?? `Street ${street + 1}`;
    return street === 0 ? 'Before the draw' : drawing ? 'The draw' : 'After the draw';
  };
  const boardAt = (s: number): Card[] => {
    if (family === 'flop') return h.board.slice(0, s === 0 ? 0 : s + 2);
    return family === 'stud' && s >= 4 ? [...h.board] : [];
  };
  const cardsAt = (i: number, s: number, reveal: boolean): FrameCard[] => {
    const dealt = h.players[i].cards;
    const shown = (c: Card | null, up: boolean): FrameCard => ({ card: up || i === h.me || reveal ? c : null, up });
    if (family === 'stud') return dealt.slice(0, Math.min(dealt.length, 3 + s)).map((c, k) => shown(c, k >= 2 && k <= 5));
    if (family === 'draw') return held[i].map((k) => shown(dealt[k] ?? null, false));
    return dealt.map((c) => shown(c, false));
  };
  const snap = (actor: number, text: string, final = false) => {
    const players = h.players.map((p, i): FramePlayer => ({
      name: p.name,
      stack: p.start - total[i] + (final ? p.won : 0),
      bet: final ? 0 : bet[i],
      status: status[i],
      action: final ? null : said[i],
      cards: cardsAt(i, street, final && p.shown),
      won: final ? p.won : 0,
      handName: final ? p.handName : null,
    }));
    frames.push({ chapter: final ? 'Result' : chapter(), board: boardAt(street), pot: total.reduce((a, b) => a + b, 0), actor, text, players, final });
  };
  const newStreet = (s: number) => {
    street = s;
    drawing = false;
    roundBet = 0;
    aggression = 0;
    bet.fill(0);
    for (let i = 0; i < n; i++) if (status[i] !== 'folded') said[i] = null;
  };
  const dealText = (s: number): string => {
    if (family === 'flop') return s === 1 ? 'The flop comes down' : s === 2 ? 'The turn' : 'The river';
    if (family === 'stud') return s === 4 && h.board.length ? 'Seventh street: one card dealt face up for everyone' : `${STUD_STREETS[s]}: ${s === 4 ? 'one more card face down' : 'one more card face up'}`;
    return 'After the draw';
  };

  // Antes and blinds go in with the deal.
  const forced = h.actions.filter((a) => a[2] === 'ante' || a[2] === 'blind');
  let blinds = 0;
  for (const a of forced) {
    const [i, , type, amount, , allIn] = a;
    total[i] += amount;
    if (type === 'blind') {
      bet[i] += amount;
      roundBet = Math.max(roundBet, bet[i]);
      said[i] = `${blinds === 0 ? 'Small' : 'Big'} blind`;
      blinds++;
    }
    if (allIn) status[i] = 'allin';
  }
  const opening = family === 'flop' ? 'Hole cards are dealt' : family === 'draw' ? 'Five cards each are dealt' : 'Third street: two down, one up';
  const forcedText = [blinds ? `Blinds ${h.stakes.sb}/${h.stakes.bb}` : '', forced.some((a) => a[2] === 'ante') ? `antes ${h.stakes.ante}` : ''].filter(Boolean);
  const first = forcedText.length ? `${forcedText.join(', ')} · ${opening.toLowerCase()}` : opening;
  snap(-1, first[0].toUpperCase() + first.slice(1));
  if (blinds) aggression = 1;

  for (const a of h.actions) {
    const [i, s, type, amount, to, allIn, discard] = a;
    if (type === 'ante' || type === 'blind') continue;
    if (type === 'draw' && !drawing && street === 0) {
      newStreet(1);
      drawing = true;
      snap(-1, 'The draw');
    } else if (s > street) {
      for (let k = street + 1; k <= s; k++) {
        newStreet(k);
        snap(-1, dealText(k));
      }
    } else if (drawing && type !== 'draw') {
      newStreet(1);
      snap(-1, 'After the draw: one more round of betting');
    }
    const name = h.players[i].name;
    let text = '';
    total[i] += amount;
    if (type === 'fold') {
      status[i] = 'folded';
      said[i] = 'Fold';
      text = `${name} folds`;
    } else if (type === 'check') {
      said[i] = 'Check';
      text = `${name} checks`;
    } else if (type === 'call') {
      bet[i] += amount;
      said[i] = allIn ? 'All-in' : `Call ${amount}`;
      text = `${name} calls ${amount}`;
    } else if (type === 'bringin') {
      bet[i] += amount;
      roundBet = Math.max(roundBet, bet[i]);
      said[i] = `Bring-in ${amount}`;
      text = `${name} brings it in for ${amount}`;
    } else if (type === 'raise') {
      const put = to - bet[i];
      total[i] += put;
      const completing = family === 'stud' && street === 0 && aggression === 0;
      const opening = roundBet === 0;
      const verb = completing ? 'completes to' : opening ? 'bets' : 'raises to';
      bet[i] = to;
      roundBet = to;
      aggression++;
      said[i] = allIn ? 'All-in' : completing ? `Complete ${to}` : opening ? `Bet ${to}` : `Raise ${to}`;
      text = `${name} ${verb} ${to}`;
    } else if (type === 'draw') {
      const out = new Set(discard ?? []);
      const kept = held[i].filter((_, k) => !out.has(k));
      for (let k = 0; k < out.size; k++) kept.push(nextDraw[i]++);
      held[i] = kept;
      said[i] = out.size ? `Draws ${out.size}` : 'Stands pat';
      text = out.size ? `${name} draws ${out.size}` : `${name} stands pat`;
    }
    if (allIn && type !== 'fold') {
      status[i] = 'allin';
      text += ' and is all-in';
    }
    snap(i, text);
  }

  // Cards still to come once nobody can bet any more (an all-in run-out).
  const last = lastStreet(h);
  if (family !== 'draw') {
    for (let k = street + 1; k <= last; k++) {
      newStreet(k);
      snap(-1, dealText(k));
    }
  }
  snap(-1, h.summary.join(' · ') || 'The hand is over', true);
  return frames;
}

/** The last street that was dealt. */
function lastStreet(h: HandHistory): number {
  const family = VARIANTS[h.variant].family;
  if (family === 'flop') return h.board.length ? h.board.length - 2 : 0;
  if (family === 'stud') return h.board.length ? 4 : Math.max(0, ...h.players.map((p) => p.cards.length - 3));
  return h.actions.some((a) => a[1] > 0) ? 1 : 0;
}

/** Where each chapter starts in the frames, in order. */
export function chapters(frames: readonly Frame[]): { name: string; at: number }[] {
  const out: { name: string; at: number }[] = [];
  frames.forEach((f, k) => {
    if (!out.length || out[out.length - 1].name !== f.chapter) out.push({ name: f.chapter, at: k });
  });
  return out;
}

/** Checks a value read back from storage is a hand history this version can show. */
export function isHandHistory(x: unknown): x is HandHistory {
  const h = x as HandHistory;
  return !!h && typeof h === 'object' && h.v === 1 && typeof h.id === 'string' && h.variant in VARIANTS
    && Array.isArray(h.players) && Array.isArray(h.actions) && Array.isArray(h.board) && h.players.length >= 2;
}
