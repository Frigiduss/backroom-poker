// Rivals: the regulars remember how you play against them, across sittings. Take enough of
// a regular's chips, knock them out, or keep pushing them off pots, and they hold a grudge:
// they say so, they play back at you harder, and the sharpest of them use what they've seen
// of your habits. A regular who keeps beating you gets smug instead.
//
// Everything here is plain data and pure functions, so it saves with the player's profile
// and can be tested without a table.
import { Rng } from '../engine/cards';
import { BotStyle, PlayerStats, emptyStats } from '../engine/table';

/** What one regular remembers about the player. */
export interface Rivalry {
  /** Hands dealt together. */
  hands: number;
  /** Big blinds the player has taken off this regular (negative when they're up on the player). */
  net: number;
  /** Showdowns the player won against them, and lost to them. */
  beatThem: number;
  lostTo: number;
  /** Times the player knocked them out, and the other way round. */
  busted: number;
  bustedBy: number;
  /** Pots they folded after the player bet or raised into them. */
  pushed: number;
  /** The player's habits, as seen from this regular's seat. */
  reads: PlayerStats;
  /** The grudge level last shown, so a rise can be announced once. */
  level: number;
  /** When they last sat together. */
  last: number;
}

export type Rivals = Record<string, Rivalry>;

export const emptyRivalry = (): Rivalry => ({ hands: 0, net: 0, beatThem: 0, lostTo: 0, busted: 0, bustedBy: 0, pushed: 0, reads: emptyStats(), level: 0, last: 0 });

/** Hands together before a regular has an opinion of the player either way. */
export const RIVAL_MIN_HANDS = 12;

export interface Mood {
  /** 0 none, 1 wary, 2 grudge, 3 nemesis; -1 when they think they have the player's number. */
  level: -1 | 0 | 1 | 2 | 3;
  /** 0..1, how much the grudge colours their play. */
  heat: number;
  label: string | null;
}

export const GRUDGE_LABELS: Record<number, string> = { [-1]: 'Has your number', 1: 'Wary of you', 2: 'Holds a grudge', 3: 'Nemesis' };

/** How a regular feels about the player right now. */
export function moodOf(r: Rivalry | undefined): Mood {
  if (!r || r.hands < RIVAL_MIN_HANDS) return { level: 0, heat: 0, label: null };
  // Chips are what they remember most, then being knocked out, then being pushed around.
  const sting = r.net / 40 + r.busted * 0.8 + r.beatThem * 0.12 + r.pushed * 0.06 - r.bustedBy * 0.6 - r.lostTo * 0.08;
  const heat = Math.max(0, Math.min(1, sting / 3));
  if (heat >= 0.75) return { level: 3, heat, label: GRUDGE_LABELS[3] };
  if (heat >= 0.4) return { level: 2, heat, label: GRUDGE_LABELS[2] };
  if (heat >= 0.15) return { level: 1, heat, label: GRUDGE_LABELS[1] };
  if (sting <= -1.2) return { level: -1, heat: 0, label: GRUDGE_LABELS[-1] };
  return { level: 0, heat, label: null };
}

/** One finished hand, from the player's side of a regular. All amounts in chips. */
export interface RivalHand {
  bigBlind: number;
  showdown: boolean;
  /** Both of them showed down in the same pot. */
  sameShowdown: boolean;
  playerNet: number;
  /** Chips the player took off this regular (negative: they took the player's). See transferBetween. */
  moved: number;
  /** Who won a showdown between them: the player, the bot, or neither (split, or no showdown). */
  winner: 'player' | 'bot' | null;
  playerBusted: boolean;
  botBusted: boolean;
  /** The bot folded after the player bet or raised. */
  botFoldedToPlayer: boolean;
  /** The player's own stats for this hand alone. */
  playerStats: PlayerStats;
  now: number;
}

/**
 * The chips that went between the player and one other seat in a hand. What the player won
 * is split across the seats that lost, in proportion to what each lost (and what they lost,
 * across the seats that won). Positive when the player took chips off seat `i`.
 */
export function transferBetween(nets: readonly number[], player: number, i: number): number {
  const mine = nets[player];
  const them = nets[i];
  if (mine > 0 && them < 0) {
    const losses = nets.reduce((a, n, k) => (k !== player && n < 0 ? a - n : a), 0);
    return (mine * -them) / losses;
  }
  if (mine < 0 && them > 0) {
    const gains = nets.reduce((a, n, k) => (k !== player && n > 0 ? a + n : a), 0);
    return -(-mine * them) / gains;
  }
  return 0;
}

/** Adds a hand to what a regular remembers. Returns the new mood and whether it just got worse. */
export function noteHand(rivals: Rivals, bot: string, h: RivalHand): { mood: Mood; rose: boolean; moved: number } {
  const r = (rivals[bot] ??= emptyRivalry());
  const moved = h.moved;
  r.hands++;
  r.net = round1(r.net + moved / Math.max(1, h.bigBlind));
  if (h.winner === 'player' && h.sameShowdown) r.beatThem++;
  if (h.winner === 'bot' && h.sameShowdown) r.lostTo++;
  if (h.botBusted && moved > 0) r.busted++;
  if (h.playerBusted && moved < 0) r.bustedBy++;
  if (h.botFoldedToPlayer && h.playerNet > 0) r.pushed++;
  for (const k of Object.keys(r.reads) as (keyof PlayerStats)[]) r.reads[k] += h.playerStats[k];
  r.last = h.now;
  const mood = moodOf(r);
  // A grudge is announced on the way up; cooling off is quiet.
  const rose = mood.level > r.level;
  r.level = Math.max(0, mood.level);
  return { mood, rose, moved };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * A regular with a grudge plays back at the player: the cautious loosen up and the loose get
 * pushy. Used for their decisions in hands the player is still in.
 */
export function grudgeStyle(style: BotStyle, mood: Mood): BotStyle {
  if (mood.level < 2) return style;
  const hot: Record<BotStyle, BotStyle> = { tight: 'balanced', passive: 'loose', balanced: 'loose', loose: 'aggressive', aggressive: 'aggressive' };
  return mood.level >= 3 && style === 'tight' ? 'loose' : hot[style];
}

/** What a regular's seat should know of the player: tonight's stats plus everything they remember. */
export function rememberedStats(tonight: PlayerStats | undefined, r: Rivalry | undefined): PlayerStats {
  const out = { ...(tonight ?? emptyStats()) };
  if (r) for (const k of Object.keys(out) as (keyof PlayerStats)[]) out[k] += r.reads[k];
  return out;
}

export type RivalEvent = 'greetGrudge' | 'greetSmug' | 'rise' | 'revenge' | 'sore';

const RIVAL_LINES: Record<RivalEvent, string[]> = {
  greetGrudge: ['You again, {name}.', 'Oh, it’s {name}. I remember you.', 'Sit down, {name}. We have business.', 'I haven’t forgotten last time, {name}.'],
  greetSmug: ['{name}! My favourite customer.', 'Back for more, {name}?', 'Good to see you, {name}. Bring plenty of chips.'],
  rise: ['That’s it, {name}. Now it’s personal.', 'I’ll remember that, {name}.', 'Keep it up, {name}. See what happens.', 'You’re making an enemy, {name}.'],
  revenge: ['That one’s for last time, {name}.', 'Payback, {name}.', 'Told you I’d remember, {name}.', 'Now we’re even. Almost.'],
  sore: ['Not again, {name}.', 'Every time, {name}. Every time.', 'You’re enjoying this, aren’t you, {name}?'],
};

/** A few regulars say it their own way. */
const OWN_LINES: Record<string, Partial<Record<RivalEvent, string[]>>> = {
  'Big Lou': { greetGrudge: ['You’re still drinking in my bar, {name}?'], revenge: ['My bar. My pot.'] },
  Mae: { greetGrudge: ['Oh, it’s you, dear. I’ve been knitting you a grudge.'], rise: ['Now that wasn’t very nice, sweetie.'] },
  Tex: { rise: ['This town ain’t big enough, {name}.'], revenge: ['Lassoed ya, {name}.'] },
  Doc: { rise: ['I’ve made a note on your chart, {name}.'], greetSmug: ['Ah, {name}. My most generous patient.'] },
  Vinnie: { rise: ['Now it’s personal, {name}.'], revenge: ['Told ya. Nothin’ personal. Okay, a little.'] },
  Duchess: { greetGrudge: ['You. I was told you’d been barred.'], sore: ['Simply intolerable.'] },
  Rocco: { greetGrudge: ['Rematch, {name}. Gloves off.'], revenge: ['Down you go, {name}.'] },
  Prof: { rise: ['I’ve updated my model of you, {name}. Unfavourably.'], revenge: ['Regression to the mean, {name}.'] },
  Wren: { greetGrudge: ['I’ve been watching you, {name}. Closely.'], greetSmug: ['I know all your tells, {name}.'] },
  Nell: { rise: ['The cat doesn’t like you, {name}.'] },
  Ace: { rise: ['You’re going on the podcast, {name}. Not in a good way.'] },
  Bishop: { greetGrudge: ['Shall we resume our game, {name}?'], revenge: ['Checkmate, {name}.'] },
};

/** Something a regular says to the player about their rivalry. */
export function rivalLine(bot: string, event: RivalEvent, playerName: string, rng: Rng): string {
  const own = OWN_LINES[bot]?.[event] ?? [];
  const all = [...own, ...own, ...RIVAL_LINES[event]];
  const name = playerName === 'You' ? 'you' : playerName;
  const line = all[Math.floor(rng.next() * all.length)].replace(/\{name\}/g, name);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** A short line on where the two of them stand, for the hover text and the stats page. */
export function rivalrySummary(r: Rivalry): string {
  const bb = Math.round(Math.abs(r.net));
  const chips = bb === 0 ? 'Even on chips' : r.net > 0 ? `You're up ${bb} big blinds on them` : `They're up ${bb} big blinds on you`;
  const knocks = [r.busted ? `you've knocked them out ${times(r.busted)}` : '', r.bustedBy ? `they've knocked you out ${times(r.bustedBy)}` : ''].filter(Boolean).join(', ');
  return `${chips} over ${r.hands} hand${r.hands === 1 ? '' : 's'}${knocks ? `; ${knocks}` : ''}.`;
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Reads rivals from a saved profile, dropping anything malformed. */
export function normalizeRivals(raw: unknown, names: readonly string[]): Rivals {
  const out: Rivals = {};
  if (!raw || typeof raw !== 'object') return out;
  const known = new Set(names);
  const src = raw as Record<string, Partial<Rivalry>>;
  for (const name of Object.keys(src)) {
    const r = src[name];
    if (!known.has(name) || !r || typeof r !== 'object') continue;
    const reads = emptyStats();
    for (const k of Object.keys(reads) as (keyof PlayerStats)[]) reads[k] = Math.max(0, num(r.reads?.[k]));
    out[name] = {
      hands: Math.max(0, num(r.hands)), net: num(r.net), beatThem: Math.max(0, num(r.beatThem)), lostTo: Math.max(0, num(r.lostTo)),
      busted: Math.max(0, num(r.busted)), bustedBy: Math.max(0, num(r.bustedBy)), pushed: Math.max(0, num(r.pushed)),
      reads, level: Math.max(0, Math.min(3, Math.floor(num(r.level)))), last: num(r.last),
    };
  }
  return out;
}

