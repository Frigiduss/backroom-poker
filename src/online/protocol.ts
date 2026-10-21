// What travels between the browser and the poker-table server function. The server keeps
// the deck, every player's cards and the shuffle seed to itself; each player only ever
// receives a TableView, which shows their own cards and whatever the table can see.
import { BjLegal, BjLimits, RoundData, RoundRig, RoundView } from '../engine/blackjack';
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
  /** Seats at the table, people plus bots. At blackjack, the most people who can sit. */
  seats: number;
  /** Poker unless it says blackjack (then the poker fields above are unused). */
  game?: 'poker' | 'blackjack';
  /** Blackjack: the table limits. */
  bjLimits?: BjLimits;
  /** Blackjack: bots in the other spots. */
  bots?: number;
}

export type BjMove = 'bet' | 'sitout' | 'hit' | 'stand' | 'double' | 'split' | 'insure' | 'noinsure';

/** Who is sitting down: the player (profile) id, so online achievements go to the right player, and the title they wear. */
export interface PlayerTag {
  playerId?: string;
  /** Id of the achievement whose title to show. The server checks it was earned. */
  title?: string | null;
}

export type Request =
  | ({ op: 'create'; name: string; settings: TableSettings } & PlayerTag)
  | ({ op: 'join'; code: string; name: string } & PlayerTag)
  /** Watches a table without a seat: no hole cards but the ones shown, no moves. Join later to sit in. */
  | ({ op: 'watch'; code: string; name: string } & PlayerTag)
  | { op: 'leave'; tableId: string }
  | { op: 'start'; tableId: string }
  | { op: 'act'; tableId: string; hand: number; action: Action }
  /** Lets the server move things along: a bot's turn, a player's clock running out, the next deal. */
  | { op: 'tick'; tableId: string; version: number }
  | { op: 'rebuy'; tableId: string }
  /** A blackjack move; `round` is the round number it was made for, and `amount` the bet. */
  | { op: 'bj'; tableId: string; round: number; move: BjMove; amount?: number }
  /** Take your seat back from the bot that played while you were away. */
  | { op: 'back'; tableId: string }
  /** Says something at the table: a line of text or one of the EMOTES. */
  | { op: 'chat'; tableId: string; text?: string; emote?: EmoteId }
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
  | { do: 'close' }
  /** Blackjack: these cards come out of the shoe next, in order. */
  | { do: 'stackshoe'; cards: Card[] }
  /** Blackjack: swaps the dealer's face-down card in the round in play. */
  | { do: 'hole'; card: Card }
  /** Stops a person chatting at this table, or lets them again. */
  | { do: 'mute'; member: string }
  | { do: 'unmute'; member: string }
  /** Wipes the table chat for everyone. */
  | { do: 'clearchat' };

/** Everything about a live table, every card included. Only ever sent to admins. */
export interface AdminTableInfo {
  tableId: string;
  code: string;
  version: number;
  phase: 'lobby' | 'playing' | 'over';
  paused: boolean;
  settings: TableSettings;
  members: { name: string; userId: string; seat: string | null; host: boolean; left: boolean; away: boolean; watching: boolean }[];
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
    /** What the rest of the hand deals if nobody else folds (stud cards by seat id). */
    coming: { name: string; board: Card[]; players: { seat: string; card: Card }[]; draws: Card[] }[];
  };
  /** Cards fixed for the next hand, by seat id. */
  nextRig: { hole: Record<string, Card[]>; board: Card[] } | null;
  /** A blackjack table, every card included. */
  bj?: BjAdminInfo | null;
  /** The table chat, oldest first, and who is muted. */
  chat?: { name: string; text: string; at: number }[];
  muted?: string[];
}

export interface BjAdminInfo {
  phase: 'betting' | 'round';
  roundNumber: number;
  spots: { id: string; name: string; isHuman: boolean; stack: number; bet: number | null; sittingOut: boolean; away: boolean }[];
  /** The round on the table, hole card included. */
  round: RoundData | null;
  /** Spot ids of the round's seats, in order. */
  inRound: string[];
  /** Next cards out of the shoe, first one first. */
  upcoming: Card[];
  shoeLeft: number;
  shoeSize: number;
  /** Cards fixed for the next round: seats by spot id, and the dealer's upcard and hole card. */
  nextRig: RoundRig | null;
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
  /** Title earned through achievements, or null. */
  title: string | null;
  host: boolean;
  you: boolean;
  /** Seat id once the game has started (or once a late joiner is dealt in). */
  seat: string | null;
  left: boolean;
  /** Watching the table, not playing. */
  watching: boolean;
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
  /** Every card dealt to this player in order, null where this viewer can't see it (for the hand history). */
  dealt?: (Card | null)[];
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
  /** The viewer is watching, not playing: they see only what the whole table sees. */
  watching: boolean;
  /** A watcher could sit in now (a seat is open or a bot's seat can be taken). */
  canSit: boolean;
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
  /** A blackjack table: everything about it (the poker fields above stay empty). */
  bj?: BjTableView | null;
  /** The table chat, oldest first. */
  chat?: ChatLineView[];
  /** An admin has stopped this viewer chatting here. */
  chatMuted?: boolean;
}

/** The quick reactions anyone at a table can send, by id. */
export const EMOTES = {
  thumbs: '👍', clap: '👏', laugh: '😂', wow: '😮', cool: '😎', think: '🤔', cry: '😭', angry: '😡', luck: '🍀', fire: '🔥',
} as const;
export type EmoteId = keyof typeof EMOTES;

export const CHAT_MAX = 140;

export interface ChatLineView {
  /** Counts up through the table's chat, so a browser can tell which lines are new. */
  id: number;
  at: number;
  name: string;
  /** Where the speaker sits, to float the line over their seat; null for watchers and notices. */
  seat: string | null;
  you: boolean;
  text?: string;
  emote?: EmoteId;
  /** A notice from the table (chat cleared), not a person. */
  system?: boolean;
}

/** One spot at an online blackjack table. */
export interface BjSpotView {
  id: string;
  name: string;
  title: string | null;
  isHuman: boolean;
  stack: number;
  rebuys: number;
  away: boolean;
  you: boolean;
  /** Betting: the bet placed, or null. */
  bet: number | null;
  /** Betting: chose to sit this round out. */
  sittingOut: boolean;
  /** Index into the round's seats, or -1 when the spot isn't in the round on the table. */
  seat: number;
}

export interface BjTableView {
  limits: BjLimits;
  min: number;
  max: number;
  startingStack: number;
  /** Taking bets for the next round, or a round on the table. */
  phase: 'betting' | 'round';
  roundNumber: number;
  spots: BjSpotView[];
  /** The round in play, or the last one played (shown while bets go down). */
  round: RoundView | null;
  /** The viewer's choices when it is their turn to play a hand. */
  legal: BjLegal | null;
  /** What insurance costs, when it is the viewer's turn to decide on it. */
  insuranceCost: number | null;
  /** When betting closes. */
  bettingEndsAt: number | null;
  shoeLeft: number;
  shoeSize: number;
  /** The viewer's last bet, offered again. */
  lastBet: number;
}

export const TURN_SECONDS = 30;
