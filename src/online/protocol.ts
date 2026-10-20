// What travels between the browser and the poker-table server function. The server keeps
// the deck, every player's cards and the shuffle seed to itself; each player only ever
// receives a TableView, which shows their own cards and whatever the table can see.
import { Card } from '../engine/cards';
import { Action, ActionRecord, HandPhase, HandResult, LegalActions, LogEntry, PlayerStatus, Stakes } from '../engine/hand';
import { BotStyle, Difficulty, Format, PlayerStats } from '../engine/table';
import { Structure, VariantId } from '../engine/variants';

export type DifficultyChoice = Difficulty | 'mixed';
export type BlindSpeed = 'slow' | 'normal' | 'turbo';

/** What the host picks when making a table. */
export interface TableSettings {
  variant: VariantId;
  structure: Structure;
  format: Format;
  difficulty: DifficultyChoice;
  stackBB: number;
  blindSpeed: BlindSpeed;
  /** Seats at the table, people plus bots. */
  seats: number;
}

/** Who is sitting down: the player (profile) id, so online achievements go to the right player, and the title they wear. */
export interface PlayerTag {
  playerId?: string;
  /** Id of the achievement whose title to show. The server checks it was earned. */
  title?: string | null;
}

export type Request =
  | ({ op: 'create'; name: string; settings: TableSettings } & PlayerTag)
  | ({ op: 'join'; code: string; name: string } & PlayerTag)
  | { op: 'leave'; tableId: string }
  | { op: 'start'; tableId: string }
  | { op: 'act'; tableId: string; hand: number; action: Action }
  /** Lets the server move things along: a bot's turn, a player's clock running out, the next deal. */
  | { op: 'tick'; tableId: string; version: number }
  | { op: 'rebuy'; tableId: string }
  /** Take your seat back from the bot that played while you were away. */
  | { op: 'back'; tableId: string };

export interface Reply {
  ok: true;
  tableId: string;
  code: string;
  view: TableView;
}

export interface ErrorReply {
  ok: false;
  error: string;
}

export interface MemberView {
  name: string;
  /** Title earned through achievements, or null. */
  title: string | null;
  host: boolean;
  you: boolean;
  /** Seat id once the game has started (or once a late joiner is dealt in). */
  seat: string | null;
  left: boolean;
}

export interface SeatView {
  id: string;
  name: string;
  /** People only: their title, or null. */
  title: string | null;
  isHuman: boolean;
  difficulty?: Difficulty;
  style?: BotStyle;
  stack: number;
  busted: boolean;
  place?: number;
  rebuys: number;
  /** A person who stepped away; a bot plays their chips meanwhile. */
  away: boolean;
  you: boolean;
}

export interface HandPlayerView {
  id: string;
  name: string;
  startStack: number;
  stack: number;
  /** null for a card this viewer can't see. */
  cards: (Card | null)[];
  faceUp: boolean[];
  status: PlayerStatus;
  streetBet: number;
  totalBet: number;
  lastAction: string | null;
  drew: number | null;
  shown: boolean;
}

export interface HandView {
  variant: VariantId;
  structure: Structure;
  stakes: Stakes;
  street: number;
  numStreets: number;
  phase: HandPhase;
  toAct: number;
  button: number;
  board: Card[];
  pot: number;
  currentBet: number;
  players: HandPlayerView[];
  log: LogEntry[];
  actions: ActionRecord[];
  result: HandResult | null;
}

export interface TableView {
  version: number;
  tableId: string;
  code: string;
  phase: 'lobby' | 'playing' | 'over';
  settings: TableSettings;
  members: MemberView[];
  isHost: boolean;
  seats: SeatView[];
  /** The viewer's seat id, or null before the game starts or while waiting to be dealt in. */
  mySeat: string | null;
  /** Joined after the start; gets a seat when the next hand is dealt. */
  waitingForSeat: boolean;
  handNumber: number;
  level: number;
  handsUntilNextLevel: number | null;
  hand: HandView | null;
  /** The viewer's choices when it is their turn. */
  legal: LegalActions | null;
  stats: Record<string, PlayerStats>;
  /** Server clock (epoch ms) when this view was made, to line up the countdowns. */
  serverNow: number;
  /** When the player to act runs out of time (people only). */
  turnDeadline: number | null;
  /** When the next hand gets dealt, once this one is over. */
  nextDealAt: number | null;
  /** When the server will next accept a tick to move things along; null if it is waiting on a person. */
  tickAt: number | null;
  rebuyPending: boolean;
  /** Fewer than two players have chips, so the next hand waits. */
  stalled: boolean;
}

export const TURN_SECONDS = 30;
