import { Card } from '../engine/cards';
import { ActionRecord, Hand, HandPhase, LegalActions, PlayerStatus, Stakes } from '../engine/hand';
import { PlayerStats } from '../engine/table';
import { Structure, VariantDef } from '../engine/variants';

export interface PublicPlayer {
  id: string;
  name: string;
  stack: number;
  status: PlayerStatus;
  streetBet: number;
  totalBet: number;
  /** Cards everyone can see (stud up cards, or all cards after showdown). */
  upCards: Card[];
  /** Cards this viewer cannot see. */
  hiddenCount: number;
  totalCards: number;
  drew: number | null;
}

/** Everything one seat is allowed to know. Bots decide from this, never from the Hand itself. */
export interface PlayerView {
  variant: VariantDef;
  structure: Structure;
  stakes: Stakes;
  street: number;
  numStreets: number;
  phase: HandPhase;
  me: number;
  myCards: Card[];
  players: PublicPlayer[];
  board: Card[];
  pot: number;
  currentBet: number;
  button: number;
  legal: LegalActions;
  actions: ActionRecord[];
  /** Public tendencies keyed by player id. */
  stats: Record<string, PlayerStats>;
}

export function buildView(hand: Hand, me: number, stats: Record<string, PlayerStats> = {}): PlayerView {
  return {
    variant: hand.variant,
    structure: hand.structure,
    stakes: hand.stakes,
    street: hand.street,
    numStreets: hand.numStreets,
    phase: hand.phase,
    me,
    myCards: [...hand.players[me].cards],
    players: hand.players.map((p, i) => {
      const visible = i === me || p.shown ? p.cards : p.cards.filter((_, k) => p.faceUp[k]);
      return {
        id: p.id,
        name: p.name,
        stack: p.stack,
        status: p.status,
        streetBet: p.streetBet,
        totalBet: p.totalBet,
        upCards: i === me ? p.cards.filter((_, k) => p.faceUp[k]) : [...visible],
        hiddenCount: i === me ? 0 : p.cards.length - visible.length,
        totalCards: p.cards.length,
        drew: p.drew,
      };
    }),
    board: [...hand.board],
    pot: hand.pot,
    currentBet: hand.currentBet,
    button: hand.button,
    legal: hand.legal(),
    actions: [...hand.actions],
    stats,
  };
}
