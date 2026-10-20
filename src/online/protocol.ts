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

export type Request =
  | { op: 'create'; name: string; settings: TableSettings }
  | { op: 'join'; code: string; name: string }
  | { op: 'leave'; tableId: string }
  | { op: 'start'; tableId: string }
  | { op: 'act'; tableId: string; hand: number; action: Action }
  /** Lets the server move things along: a bot's turn, a player's clock running out, the next deal. */
  | { op: 'tick'; tableId: string; version: number }
  | { op: 'rebuy'; tableId: string }
  /** Take your seat back from the bot that played while you were away. */
  | { op: 'back'; tableId: string }
  /** Developer console: change or look inside any table. Only admin accounts (supabase/admin.sql). */
  | { op: 'admin'; tableId?: string; code?: string; command: AdminCommand }
  /** Developer console: the tables in play. Admins only. */
  | { op: 'tables' };

/** What an admin can do to a live table. Seats are named by id (p0), number (0) or name. */
export type AdminCommand =
  | { do: 'inspect' }
  /** Deals a seat these cards next hand. */
  | { do: 'rig'; seat: string; cards: Card[] }
  | { do: 'unrig' }
  /** The board cards still to come this hand; between hands, the next hand's board. */
  | { do: 'board'; cards: Card[] }
  | { do: 'stack'; seat: string; amount: number }
  | { do: 'bot'; seat: string; difficulty?: Difficulty; style?: BotStyle }
  | { do: 'pause' }
  | { do: 'resume' }
  /** Makes the next bot move or deal now. */
  | { do: 'step' }
  | { do: 'level'; level: number }
  /** Removes a person from the table (a bot plays their chips). */
  | { do: 'kick'; member: string }
  /** Deletes the table for everyone. */
  | { do: 'close' };

/** Everything about a live table, every card included. Only ever sent to admins. */
export interface AdminTableInfo {
  tableId: string;
  code: string;
  version: number;
  phase: 'lobby' | 'playing' | 'over';
  paused: boolean;
  settings: TableSettings;
  members: { name: string; userId: string; seat: string | null; host: boolean; left: boolean; away: boolean }[];
  handNumber: number;
  level: number;
  seats: { id: string; name: string; isHuman: boolean; difficulty?: Difficulty; style?: BotStyle; stack: number; busted: boolean }[];
  hand: null | {
    street: number;
    numStreets: number;
    phase: HandPhase;
    complete: boolean;
    pot: number;
    /** Seat id of the player to act, or null. */
    toAct: string | null;
    board: Card[];
    players: { seat: string; cards: Card[]; status: PlayerStatus; stack: number; totalBet: number }[];
    /** Next cards off the deck, top first. */
    upcoming: Card[];
    /** Board cards fixed to come. */
    rigBoard: Card[];
  };
  /** Cards fixed for the next hand, by seat id. */
  nextRig: { hole: Record<string, Card[]>; board: Card[] } | null;
}

export interface AdminTableSummary {
  tableId: string;
  code: string;
  phase: 'lobby' | 'playing' | 'over';
  game: string;
  people: string[];
  handNumber: number;
  paused: boolean;
  updatedAt: string;
}

export interface AdminReply {
  ok: true;
  message: string;
  table: AdminTableInfo | null;
  tables?: AdminTableSummary[];
}

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
  host: boolean;
  you: boolean;
  /** Seat id once the game has started (or once a late joiner is dealt in). */
  seat: string | null;
  left: boolean;
}

export interface SeatView {
  id: string;
  name: string;
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
  /** An admin has paused the table from the developer console. */
  paused?: boolean;
}

export const TURN_SECONDS = 30;
