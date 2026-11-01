// Achievements and the titles they unlock. Everything here is plain data and pure functions
// so the browser (games against bots) and the poker-table server (online tables) count
// progress the same way.
//
// Progress is a set of counters: "hands played", "wins with a flush", "biggest pot in big
// blinds" and so on. Each achievement is a goal on one measure of those counters, so an
// achievement is unlocked exactly when its counters say so, and a progress bar is free.
// Counters starting with "online." are only ever written by the server, so the browser can
// never award itself an online achievement.
import { Card, rankOf, suitOf } from '../engine/cards';
import { Cat, categoryOf } from '../engine/evaluator';
import { Round, handTotal } from '../engine/blackjack';
import type { Coup, BacResult } from '../engine/baccarat';
import { SpinResult, isZero } from '../engine/roulette';
import { VpHand, VpResult, isAcesLine, isQuadsLine } from '../engine/videopoker';
import type { SlotSpin } from '../engine/slots';
import type { Hand } from '../engine/hand';
import { Difficulty, Format } from '../engine/table';
import { VARIANTS, VARIANT_ORDER, VariantId, showdownValue } from '../engine/variants';

export type Counters = Record<string, number>;

export type Tier = 1 | 2 | 3 | 4;
export const TIER_NAMES: Record<Tier, string> = { 1: 'Bronze', 2: 'Silver', 3: 'Gold', 4: 'Diamond' };

export type AchievementGroup = 'career' | 'hands' | 'games' | 'formats' | 'bots' | 'blackjack' | 'casino' | 'videopoker' | 'slots' | 'online';
export const GROUP_NAMES: Record<AchievementGroup, string> = {
  career: 'Career',
  hands: 'Big hands',
  games: 'Games',
  formats: 'Cash and tournaments',
  bots: 'Bot hunting',
  blackjack: 'Blackjack',
  casino: 'Roulette and baccarat',
  videopoker: 'Video poker',
  slots: 'Slots',
  online: 'Online with friends',
};
export const GROUP_ORDER: AchievementGroup[] = ['career', 'hands', 'games', 'formats', 'bots', 'blackjack', 'casino', 'videopoker', 'slots', 'online'];

export interface Achievement {
  id: string;
  name: string;
  /** What to do, in a sentence. */
  desc: string;
  group: AchievementGroup;
  tier: Tier;
  /** The number this achievement watches. */
  measure: (c: Counters) => number;
  goal: number;
  /** A title the player can show next to their name once this is unlocked. */
  title?: string;
  /** Only the server can credit it (online tables). */
  online?: boolean;
}

/** Counters that keep the best value seen rather than a running total. */
const MAX_COUNTERS = new Set(['bigPotBB', 'bestRun', 'peakBank', 'cashBestBB', 'online.bigPotBB', 'bj.bestRun', 'bj.bigWin', 'rl.bigWin', 'bac.bigWin', 'bac.bestRun', 'vp.bigWin', 'sl.bigWin', 'sl.mostLines']);
export const isMaxCounter = (key: string): boolean => MAX_COUNTERS.has(key);
export const isOnlineCounter = (key: string): boolean => key.startsWith('online.');

const n = (c: Counters, key: string): number => c[key] ?? 0;
const counter = (key: string) => (c: Counters) => n(c, key);

// ---------- the list ----------

const list: Achievement[] = [];
interface Step { id: string; name: string; desc: string; tier: Tier; goal: number; title?: string }

/** A ladder of achievements on one measure, from bronze up. */
function ladder(group: AchievementGroup, measure: string | ((c: Counters) => number), steps: Step[], online = false) {
  const m = typeof measure === 'string' ? counter(measure) : measure;
  for (const s of steps) list.push({ ...s, group, measure: m, online: online || undefined });
}

// Career
ladder('career', 'hands', [
  { id: 'hands-10', name: 'Pull Up a Chair', desc: 'Play 10 hands.', tier: 1, goal: 10 },
  { id: 'hands-100', name: 'Settling In', desc: 'Play 100 hands.', tier: 1, goal: 100 },
  { id: 'hands-1000', name: 'Grinder', desc: 'Play 1,000 hands.', tier: 2, goal: 1000, title: 'Grinder' },
  { id: 'hands-10000', name: 'Iron Seat', desc: 'Play 10,000 hands.', tier: 3, goal: 10000, title: 'Iron Seat' },
  { id: 'hands-50000', name: 'The Machine', desc: 'Play 50,000 hands.', tier: 4, goal: 50000, title: 'The Machine' },
]);
ladder('career', 'wins', [
  { id: 'wins-1', name: 'First Blood', desc: 'Win a hand.', tier: 1, goal: 1 },
  { id: 'wins-100', name: 'Pot Collector', desc: 'Win 100 hands.', tier: 1, goal: 100 },
  { id: 'wins-1000', name: 'Chip Magnet', desc: 'Win 1,000 hands.', tier: 2, goal: 1000, title: 'Chip Magnet' },
  { id: 'wins-10000', name: 'The Vacuum', desc: 'Win 10,000 hands.', tier: 4, goal: 10000, title: 'The Vacuum' },
]);
ladder('career', 'showdownWins', [
  { id: 'showdown-10', name: 'Show Me', desc: 'Win 10 showdowns.', tier: 1, goal: 10 },
  { id: 'showdown-250', name: 'Card Turner', desc: 'Win 250 showdowns.', tier: 2, goal: 250 },
  { id: 'showdown-2500', name: 'Showdown King', desc: 'Win 2,500 showdowns.', tier: 3, goal: 2500, title: 'Showdown King' },
]);
ladder('career', 'steals', [
  { id: 'steal-25', name: 'Take It Down', desc: 'Bet or raise and win 25 pots without a showdown.', tier: 1, goal: 25 },
  { id: 'steal-500', name: 'Table Bully', desc: 'Bet or raise and win 500 pots without a showdown.', tier: 2, goal: 500, title: 'Bully' },
  { id: 'steal-5000', name: 'Pickpocket', desc: 'Bet or raise and win 5,000 pots without a showdown.', tier: 3, goal: 5000, title: 'Pickpocket' },
]);
ladder('career', 'allinWins', [
  { id: 'allin-1', name: 'Shove', desc: 'Win a hand after going all in.', tier: 1, goal: 1 },
  { id: 'allin-50', name: 'Nerves of Steel', desc: 'Win 50 hands after going all in.', tier: 2, goal: 50 },
  { id: 'allin-250', name: 'Ice Water', desc: 'Win 250 hands after going all in.', tier: 3, goal: 250, title: 'Ice Water' },
]);
ladder('career', 'bigPotBB', [
  { id: 'pot-50', name: 'Big Pot', desc: 'Win a pot worth 50 big blinds.', tier: 1, goal: 50 },
  { id: 'pot-150', name: 'Monster Pot', desc: 'Win a pot worth 150 big blinds.', tier: 2, goal: 150 },
  { id: 'pot-400', name: 'Whale Pot', desc: 'Win a pot worth 400 big blinds.', tier: 3, goal: 400, title: 'High Roller' },
]);
ladder('career', 'bestRun', [
  { id: 'run-3', name: 'Hot Streak', desc: 'Win 3 hands in a row.', tier: 1, goal: 3 },
  { id: 'run-5', name: 'On Fire', desc: 'Win 5 hands in a row.', tier: 2, goal: 5, title: 'On Fire' },
  { id: 'run-8', name: 'Unstoppable', desc: 'Win 8 hands in a row.', tier: 3, goal: 8, title: 'Unstoppable' },
]);
ladder('career', 'peakBank', [
  { id: 'bank-25k', name: 'Comfortable', desc: 'Grow your chip bank to 25,000.', tier: 1, goal: 25_000 },
  { id: 'bank-100k', name: 'Bankroll', desc: 'Grow your chip bank to 100,000.', tier: 2, goal: 100_000, title: 'Big Stack' },
  { id: 'bank-1m', name: 'Millionaire', desc: 'Grow your chip bank to 1,000,000.', tier: 4, goal: 1_000_000, title: 'Millionaire' },
]);

// Big hands
const made = (key: string) => (c: Counters) => n(c, `made.${key}`);
ladder('hands', made('straight'), [
  { id: 'straight-1', name: 'Straight Up', desc: 'Win a showdown with a straight.', tier: 1, goal: 1 },
  { id: 'straight-50', name: 'Connector', desc: 'Win 50 showdowns with a straight.', tier: 2, goal: 50 },
]);
ladder('hands', made('flush'), [
  { id: 'flush-1', name: 'Flushed', desc: 'Win a showdown with a flush.', tier: 1, goal: 1 },
  { id: 'flush-50', name: 'Suited Up', desc: 'Win 50 showdowns with a flush.', tier: 2, goal: 50, title: 'Suited Up' },
]);
ladder('hands', made('fullHouse'), [
  { id: 'boat-1', name: 'Full House', desc: 'Win a showdown with a full house.', tier: 1, goal: 1 },
  { id: 'boat-25', name: 'Full Boat', desc: 'Win 25 showdowns with a full house.', tier: 2, goal: 25, title: 'Captain' },
]);
ladder('hands', made('quads'), [
  { id: 'quads-1', name: 'Four of a Kind', desc: 'Win a showdown with four of a kind.', tier: 2, goal: 1 },
  { id: 'quads-10', name: 'Quad Squad', desc: 'Win 10 showdowns with four of a kind.', tier: 3, goal: 10, title: 'Quad Squad' },
]);
ladder('hands', made('straightFlush'), [
  { id: 'sflush-1', name: 'Straight Flush', desc: 'Win a showdown with a straight flush.', tier: 3, goal: 1, title: 'Lucky' },
]);
ladder('hands', made('royal'), [
  { id: 'royal-1', name: 'Royal Flush', desc: 'Win a showdown with a royal flush.', tier: 4, goal: 1, title: 'Royalty' },
]);
ladder('hands', 'airWins', [
  { id: 'air-1', name: 'Nothing But Air', desc: 'Win a showdown with only a high card.', tier: 1, goal: 1 },
  { id: 'air-25', name: 'Air Marshal', desc: 'Win 25 showdowns with only a high card.', tier: 3, goal: 25, title: 'Air Marshal' },
]);
ladder('hands', 'hammer', [
  { id: 'hammer-1', name: 'The Hammer', desc: "Win a hand of Hold'em holding Seven-Two offsuit.", tier: 2, goal: 1, title: 'The Hammer' },
]);
ladder('hands', 'badBeats', [
  { id: 'beat-1', name: 'Bad Beat', desc: 'Lose a showdown holding a full house or better.', tier: 1, goal: 1 },
  { id: 'beat-10', name: 'Snakebit', desc: 'Lose 10 showdowns holding a full house or better.', tier: 2, goal: 10, title: 'Snakebit' },
]);
ladder('hands', 'lowWins', [
  { id: 'low-10', name: 'Low Down', desc: 'Win 10 low pots or low halves.', tier: 1, goal: 10 },
  { id: 'low-250', name: 'Low Life', desc: 'Win 250 low pots or low halves.', tier: 2, goal: 250, title: 'Low Life' },
]);
ladder('hands', 'wheels', [
  { id: 'wheel-1', name: 'The Wheel', desc: 'Win a low with A-2-3-4-5, the best low there is.', tier: 2, goal: 1 },
  { id: 'wheel-10', name: 'Wheelman', desc: 'Win 10 lows with A-2-3-4-5.', tier: 3, goal: 10, title: 'Wheelman' },
]);

// Games: a pair for every game, plus variety.
const VARIANT_TITLES: Record<VariantId, [string, string]> = {
  holdem: ['Texan', "Hold'em Master"],
  shortdeck: ['Six Plus', 'Short Deck Master'],
  omaha: ['Four Carder', 'Omaha Master'],
  omaha8: ['Split Pot', 'Hi-Lo Master'],
  draw5: ['Old Timer', 'Draw Master'],
  stud7: ['Stud', 'Stud Master'],
  stud8: ['Eight or Better', 'Stud Hi-Lo Master'],
  razz: ['Razzle Dazzle', 'Razz Master'],
};
for (const v of VARIANT_ORDER) {
  const name = VARIANTS[v].name;
  ladder('games', `play.${v}`, [{ id: `play-${v}`, name: `${name} Regular`, desc: `Play 250 hands of ${name}.`, tier: 1, goal: 250, title: VARIANT_TITLES[v][0] }]);
  ladder('games', `win.${v}`, [{ id: `master-${v}`, name: `${name} Master`, desc: `Win 1,000 hands of ${name}.`, tier: 3, goal: 1000, title: VARIANT_TITLES[v][1] }]);
}
const variety = (c: Counters) => VARIANT_ORDER.filter((v) => n(c, `play.${v}`) >= 25).length;
const mastery = (c: Counters) => VARIANT_ORDER.filter((v) => n(c, `win.${v}`) >= 1000).length;
ladder('games', variety, [
  { id: 'variety-3', name: 'Tourist', desc: 'Play 25 hands each of 3 different games.', tier: 1, goal: 3 },
  { id: 'variety-8', name: 'Globetrotter', desc: 'Play 25 hands of all 8 games.', tier: 2, goal: 8, title: 'Globetrotter' },
]);
ladder('games', mastery, [
  { id: 'mastery-8', name: "Dealer's Choice", desc: 'Master all 8 games.', tier: 4, goal: 8, title: "Dealer's Choice" },
]);

// Cash and tournaments
ladder('formats', 'cashUp', [
  { id: 'cash-1', name: 'In the Black', desc: 'Leave a cash game with more chips than you brought.', tier: 1, goal: 1 },
  { id: 'cash-50', name: 'Bankroll Builder', desc: 'Leave 50 cash games ahead.', tier: 2, goal: 50, title: 'Bankroll Builder' },
]);
ladder('formats', 'cashBestBB', [
  { id: 'session-100', name: 'Double Up', desc: 'Win 100 big blinds in one cash game.', tier: 1, goal: 100 },
  { id: 'session-500', name: 'Cleaned Them Out', desc: 'Win 500 big blinds in one cash game.', tier: 3, goal: 500, title: 'Table Captain' },
]);
ladder('formats', 'sngWins', [
  { id: 'sng-1', name: 'Sit & Go Winner', desc: 'Win a Sit & Go.', tier: 1, goal: 1 },
  { id: 'sng-10', name: 'Closer', desc: 'Win 10 Sit & Gos.', tier: 2, goal: 10, title: 'Closer' },
  { id: 'sng-100', name: 'Tournament Pro', desc: 'Win 100 Sit & Gos.', tier: 4, goal: 100, title: 'Tournament Pro' },
]);
ladder('formats', 'huWins', [
  { id: 'hu-1', name: 'One on One', desc: 'Win a heads-up duel.', tier: 1, goal: 1 },
  { id: 'hu-10', name: 'Duelist', desc: 'Win 10 heads-up duels.', tier: 2, goal: 10, title: 'Duelist' },
  { id: 'hu-100', name: 'Gunslinger', desc: 'Win 100 heads-up duels.', tier: 4, goal: 100, title: 'Gunslinger' },
]);
ladder('formats', 'cashes', [
  { id: 'itm-5', name: 'In the Money', desc: 'Finish in a paid place in 5 tournaments.', tier: 1, goal: 5 },
  { id: 'itm-50', name: 'Min-Cash Merchant', desc: 'Finish in a paid place in 50 tournaments.', tier: 2, goal: 50 },
]);

// Bot hunting: tournament wins where every bot was the same difficulty.
const BOT_STEPS: [Difficulty, string, Tier, string | undefined][] = [
  ['beginner', 'Training Wheels Off', 1, undefined],
  ['easy', 'Easy Money', 1, undefined],
  ['medium', 'Middleweight', 2, undefined],
  ['hard', 'Giant Slayer', 3, 'Giant Slayer'],
  ['expert', 'Shark Hunter', 3, 'Shark Hunter'],
];
for (const [d, name, tier, title] of BOT_STEPS) {
  ladder('bots', `beat.${d}`, [{ id: `beat-${d}`, name, desc: `Win a tournament against ${d === 'expert' ? 'Expert' : d[0].toUpperCase() + d.slice(1)} bots.`, tier, goal: 1, title }]);
}
ladder('bots', 'beat.expert', [
  { id: 'beat-expert-10', name: 'Apex Predator', desc: 'Win 10 tournaments against Expert bots.', tier: 4, goal: 10, title: 'Apex Predator' },
]);
ladder('bots', 'beat.expertFull', [
  { id: 'shark-tank', name: 'Shark Tank', desc: 'Win a Sit & Go against five or more Expert bots.', tier: 4, goal: 1, title: 'Shark Tamer' },
]);
const gauntlet = (c: Counters) => (['beginner', 'easy', 'medium', 'hard', 'expert'] as Difficulty[]).filter((d) => n(c, `beat.${d}`) > 0).length;
ladder('bots', gauntlet, [
  { id: 'gauntlet', name: 'The Gauntlet', desc: 'Win a tournament against every bot difficulty.', tier: 3, goal: 5, title: 'Gauntlet Runner' },
]);

// Blackjack against the dealer.
ladder('blackjack', 'bj.hands', [
  { id: 'bj-hands-25', name: 'Hit Me', desc: 'Play 25 hands of blackjack.', tier: 1, goal: 25 },
  { id: 'bj-hands-500', name: 'Card Counter', desc: 'Play 500 hands of blackjack.', tier: 2, goal: 500, title: 'Card Counter' },
  { id: 'bj-hands-5000', name: 'Pit Boss', desc: 'Play 5,000 hands of blackjack.', tier: 3, goal: 5000, title: 'Pit Boss' },
]);
ladder('blackjack', 'bj.naturals', [
  { id: 'bj-natural-1', name: 'Natural', desc: 'Get dealt a blackjack.', tier: 1, goal: 1 },
  { id: 'bj-natural-100', name: 'Twenty-One', desc: 'Get dealt 100 blackjacks.', tier: 2, goal: 100, title: 'Twenty-One' },
]);
ladder('blackjack', 'bj.doubleWins', [
  { id: 'bj-double-1', name: 'Double Down', desc: 'Win a hand you doubled.', tier: 1, goal: 1 },
  { id: 'bj-double-100', name: 'Double Trouble', desc: 'Win 100 hands you doubled.', tier: 2, goal: 100, title: 'Double Trouble' },
]);
ladder('blackjack', 'bj.splitSweeps', [
  { id: 'bj-split-1', name: 'Split Decision', desc: 'Split a pair and win every hand.', tier: 1, goal: 1 },
  { id: 'bj-split-25', name: 'Split Personality', desc: 'Split a pair and win every hand, 25 times.', tier: 3, goal: 25, title: 'Split Personality' },
]);
ladder('blackjack', 'bj.charlies', [
  { id: 'bj-charlie', name: 'Five-Card Charlie', desc: 'Make 21 with five cards or more.', tier: 2, goal: 1 },
]);
ladder('blackjack', 'bj.insured', [
  { id: 'bj-insured', name: 'Fully Insured', desc: 'Take insurance and see the dealer turn over blackjack.', tier: 1, goal: 1 },
]);
ladder('blackjack', 'bj.bestRun', [
  { id: 'bj-run-5', name: 'Heater', desc: 'Win 5 blackjack hands in a row.', tier: 2, goal: 5 },
  { id: 'bj-run-10', name: 'Hot Shoe', desc: 'Win 10 blackjack hands in a row.', tier: 3, goal: 10, title: 'Hot Shoe' },
]);
ladder('blackjack', 'bj.bigWin', [
  { id: 'bj-win-1000', name: 'Paid Out', desc: 'Win 1,000 chips in one hand of blackjack.', tier: 1, goal: 1000 },
  { id: 'bj-win-10000', name: 'Broke the Bank', desc: 'Win 10,000 chips in one hand of blackjack.', tier: 3, goal: 10_000, title: 'Bank Breaker' },
]);

// Roulette and baccarat against the house.
ladder('casino', 'rl.spins', [
  { id: 'rl-spins-25', name: 'Place Your Bets', desc: 'Play 25 spins of roulette.', tier: 1, goal: 25 },
  { id: 'rl-spins-500', name: 'Wheel Watcher', desc: 'Play 500 spins of roulette.', tier: 2, goal: 500, title: 'Wheel Watcher' },
]);
ladder('casino', 'rl.straightHits', [
  { id: 'rl-straight-1', name: 'Straight Up', desc: 'Hit a single number in roulette.', tier: 1, goal: 1 },
  { id: 'rl-straight-25', name: 'Sharpshooter', desc: 'Hit a single number in roulette 25 times.', tier: 3, goal: 25, title: 'Sharpshooter' },
]);
ladder('casino', 'rl.zeroHits', [
  { id: 'rl-zero', name: 'Green Machine', desc: 'Win a bet on the zero.', tier: 2, goal: 1 },
]);
ladder('casino', 'rl.bigWin', [
  { id: 'rl-win-5000', name: 'Spin Doctor', desc: 'Win 5,000 chips on one spin of roulette.', tier: 3, goal: 5000, title: 'Spin Doctor' },
]);
ladder('casino', 'bac.hands', [
  { id: 'bac-hands-25', name: 'Punto Banco', desc: 'Play 25 hands of baccarat.', tier: 1, goal: 25 },
  { id: 'bac-hands-500', name: 'Baccarat Baron', desc: 'Play 500 hands of baccarat.', tier: 2, goal: 500, title: 'Baccarat Baron' },
]);
ladder('casino', 'bac.tieWins', [
  { id: 'bac-tie', name: 'All Square', desc: 'Win a Tie bet in baccarat.', tier: 1, goal: 1 },
]);
ladder('casino', 'bac.pairWins', [
  { id: 'bac-pair', name: 'Pair Up', desc: 'Win a pair bet in baccarat.', tier: 1, goal: 1 },
]);
ladder('casino', 'bac.nines', [
  { id: 'bac-nine', name: 'Le Grand', desc: 'Win a baccarat bet on a natural nine.', tier: 2, goal: 1 },
]);
ladder('casino', 'bac.bestRun', [
  { id: 'bac-run-6', name: 'Ride the Dragon', desc: 'Come out ahead on 6 baccarat hands in a row.', tier: 3, goal: 6, title: 'Dragon Rider' },
]);

// Video poker machines.
ladder('videopoker', 'vp.hands', [
  { id: 'vp-hands-50', name: 'Coin In', desc: 'Play 50 hands of video poker.', tier: 1, goal: 50 },
  { id: 'vp-hands-1000', name: 'Video King', desc: 'Play 1,000 hands of video poker.', tier: 2, goal: 1000, title: 'Video King' },
]);
ladder('videopoker', 'vp.cleanSlates', [
  { id: 'vp-clean-slate', name: 'Clean Slate', desc: 'Throw away all five cards and draw a paying hand.', tier: 1, goal: 1 },
]);
ladder('videopoker', 'vp.quads', [
  { id: 'vp-quads-1', name: 'Four Alarm', desc: 'Hit four of a kind in video poker.', tier: 2, goal: 1 },
  { id: 'vp-quads-25', name: 'Quad Machine', desc: 'Hit four of a kind in video poker 25 times.', tier: 3, goal: 25, title: 'Quad Machine' },
]);
ladder('videopoker', 'vp.aces', [
  { id: 'vp-aces', name: 'Aces Up', desc: 'Hit four aces in video poker.', tier: 3, goal: 1, title: 'Ace Hunter' },
]);
ladder('videopoker', 'vp.bigWin', [
  { id: 'vp-win-1000', name: 'Bells and Whistles', desc: 'Win 1,000 chips on one hand of video poker.', tier: 2, goal: 1000 },
]);
ladder('videopoker', 'vp.royals', [
  { id: 'vp-royal', name: 'Royal Jackpot', desc: 'Draw a royal flush in video poker.', tier: 4, goal: 1, title: 'Jackpot' },
]);

// The slot machine.
ladder('slots', 'sl.spins', [
  { id: 'sl-spins-100', name: 'Pull the Lever', desc: 'Spin the slot machine 100 times.', tier: 1, goal: 100 },
  { id: 'sl-spins-2500', name: 'One-Armed Bandit', desc: 'Spin the slot machine 2,500 times.', tier: 2, goal: 2500, title: 'One-Armed Bandit' },
]);
ladder('slots', 'sl.mostLines', [
  { id: 'sl-lines-3', name: 'Lit Up', desc: 'Win on three pay lines in one spin.', tier: 2, goal: 3 },
]);
ladder('slots', 'sl.crowns', [
  { id: 'sl-crowns', name: 'Crowned', desc: 'Line up three crowns.', tier: 2, goal: 1 },
]);
ladder('slots', 'sl.bigWin', [
  { id: 'sl-win-2500', name: 'Coin Shower', desc: 'Win 2,500 chips on one spin of the slots.', tier: 3, goal: 2500 },
]);
ladder('slots', 'sl.sevens', [
  { id: 'sl-sevens', name: 'Triple Seven', desc: 'Line up three sevens for the top prize.', tier: 4, goal: 1, title: 'Lucky Sevens' },
]);

// Online with friends: credited by the table server only.
ladder('online', 'online.games', [
  { id: 'online-1', name: 'Friendly Game', desc: 'Play a game at an online table.', tier: 1, goal: 1 },
  { id: 'online-25', name: 'Game Night', desc: 'Play 25 games at online tables.', tier: 2, goal: 25 },
  { id: 'online-250', name: 'Card Room Regular', desc: 'Play 250 games at online tables.', tier: 3, goal: 250, title: 'Card Room Regular' },
], true);
ladder('online', 'online.hosted', [
  { id: 'host-1', name: 'Host', desc: 'Start a game at a table you made.', tier: 1, goal: 1 },
  { id: 'host-25', name: 'The Host with the Most', desc: 'Start 25 games at tables you made.', tier: 2, goal: 25, title: 'The Host' },
], true);
ladder('online', 'online.hands', [
  { id: 'online-hands-100', name: 'Late Night', desc: 'Play 100 hands at online tables.', tier: 1, goal: 100 },
  { id: 'online-hands-2500', name: 'Night Owl', desc: 'Play 2,500 hands at online tables.', tier: 2, goal: 2500, title: 'Night Owl' },
], true);
ladder('online', 'online.beatFriend', [
  { id: 'gotcha-1', name: 'Gotcha', desc: 'Beat a friend at showdown.', tier: 1, goal: 1 },
  { id: 'gotcha-50', name: 'Rival', desc: 'Beat friends at showdown 50 times.', tier: 2, goal: 50, title: 'Rival' },
  { id: 'gotcha-500', name: 'Nemesis', desc: 'Beat friends at showdown 500 times.', tier: 3, goal: 500, title: 'Nemesis' },
], true);
ladder('online', 'online.bigPotBB', [
  { id: 'online-pot', name: 'Friendly Fire', desc: 'Win a 100 big blind pot at an online table.', tier: 2, goal: 100 },
], true);
ladder('online', 'online.tourneyWins', [
  { id: 'online-champ-1', name: 'Champion', desc: 'Win a tournament at an online table.', tier: 2, goal: 1, title: 'Champion' },
  { id: 'online-champ-25', name: 'Dynasty', desc: 'Win 25 tournaments at online tables.', tier: 4, goal: 25, title: 'Dynasty' },
], true);
ladder('online', 'online.friendTourneyWins', [
  { id: 'bragging-rights', name: 'Bragging Rights', desc: 'Win a tournament with at least one friend at the table.', tier: 2, goal: 1, title: 'Bragging Rights' },
  { id: 'friend-champ-10', name: 'Last One Standing', desc: 'Win 10 tournaments with friends at the table.', tier: 3, goal: 10, title: 'Last One Standing' },
], true);

export const ACHIEVEMENTS: readonly Achievement[] = list;
export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, Achievement> = new Map(list.map((a) => [a.id, a]));

// ---------- counting ----------

/** What one event adds to a player's counters: running totals, and best-ever values. */
export interface Tally {
  sum: Counters;
  max: Counters;
}

export const emptyTally = (): Tally => ({ sum: {}, max: {} });
export const tallyIsEmpty = (t: Tally): boolean => !Object.keys(t.sum).length && !Object.keys(t.max).length;

/** Adds `t` into `c` in place. Online counters are skipped unless `online` is set. */
export function addTally(c: Counters, t: Tally, online = false): Counters {
  for (const [k, v] of Object.entries(t.sum)) if (online || !isOnlineCounter(k)) c[k] = n(c, k) + v;
  for (const [k, v] of Object.entries(t.max)) if (online || !isOnlineCounter(k)) c[k] = Math.max(n(c, k), v);
  return c;
}

export function mergeTally(a: Tally, b: Tally): Tally {
  const out: Tally = { sum: { ...a.sum }, max: { ...a.max } };
  for (const [k, v] of Object.entries(b.sum)) out.sum[k] = (out.sum[k] ?? 0) + v;
  for (const [k, v] of Object.entries(b.max)) out.max[k] = Math.max(out.max[k] ?? 0, v);
  return out;
}

/**
 * A player's whole record: what they did in this browser (`local`, never trusted for online
 * counters) together with what the table server credited (`server`).
 */
export function combine(local: Counters, server: Counters = {}): Counters {
  const out: Counters = {};
  for (const [k, v] of Object.entries(local)) if (!isOnlineCounter(k) && Number.isFinite(v)) out[k] = v;
  for (const [k, v] of Object.entries(server)) {
    if (!Number.isFinite(v)) continue;
    out[k] = isMaxCounter(k) ? Math.max(n(out, k), v) : n(out, k) + v;
  }
  return out;
}

export const isUnlocked = (a: Achievement, c: Counters): boolean => a.measure(c) >= a.goal;
export const unlockedIn = (c: Counters): Achievement[] => ACHIEVEMENTS.filter((a) => isUnlocked(a, c));

/** The display text of a title, if `id` names an unlocked achievement that grants one. */
export function titleFor(id: string | null | undefined, c: Counters): string | null {
  const a = id ? ACHIEVEMENT_BY_ID.get(id) : undefined;
  return a?.title && isUnlocked(a, c) ? a.title : null;
}

const WHEEL_LOW = (5 << 16) | (4 << 12) | (3 << 8) | (2 << 4) | 1;
const CAT_KEYS: Record<number, string> = {
  [Cat.STRAIGHT]: 'straight', [Cat.FLUSH]: 'flush', [Cat.FULL_HOUSE]: 'fullHouse', [Cat.QUADS]: 'quads', [Cat.STRAIGHT_FLUSH]: 'straightFlush',
};

const isHammer = (cards: readonly Card[]) =>
  cards.length === 2 && suitOf(cards[0]) !== suitOf(cards[1]) && [rankOf(cards[0]), rankOf(cards[1])].sort((a, b) => a - b).join() === '2,7';

export interface HandTallyOptions {
  /** Played at an online table (adds the online counters). */
  online?: boolean;
  /** Online: hand indexes of the other people (not bots) in the hand. */
  friends?: readonly number[];
}

/** What a finished hand adds to the record of the player at hand index `i`. */
export function handTally(hand: Hand, i: number, opts: HandTallyOptions = {}): Tally {
  const t = emptyTally();
  const res = hand.result;
  const p = hand.players[i];
  if (!res || !p) return t;
  const v = hand.variant;
  const add = (k: string, by = 1) => (t.sum[k] = (t.sum[k] ?? 0) + by);
  const best = (k: string, x: number) => (t.max[k] = Math.max(t.max[k] ?? 0, x));
  const won = res.won[i] ?? 0;
  const net = p.stack - p.startStack;
  const potBB = Math.floor(won / Math.max(1, hand.stakes.bb));

  add('hands');
  add(`play.${v.id}`);
  if (net > 0) {
    add('wins');
    add(`win.${v.id}`);
    best('bigPotBB', potBB);
    if (p.status === 'allin') add('allinWins');
    if (v.id === 'holdem' && isHammer(p.cards)) add('hammer');
  }
  if (!res.showdown && won > 0 && hand.actions.some((a) => a.player === i && a.aggressive)) add('steals');

  // How the player plays, for the stats page: the first betting round is pre-flop in flop
  // games, third street in stud and before the draw in draw games.
  const mine = hand.actions.filter((a) => a.player === i);
  const decisions = mine.filter((a) => a.type === 'fold' || a.type === 'check' || a.type === 'call' || a.type === 'raise');
  add('style.dealt');
  if (decisions.some((a) => a.street === 0 && (a.type === 'call' || a.type === 'raise'))) add('style.vpip');
  if (decisions.some((a) => a.street === 0 && a.aggressive)) add('style.pfr');
  if (decisions.length) add('style.decisions', decisions.length);
  const raises = decisions.filter((a) => a.aggressive).length;
  if (raises) add('style.raises', raises);
  const calls = decisions.filter((a) => a.type === 'call').length;
  if (calls) add('style.calls', calls);
  if (res.showdown && p.shown) add('style.showdowns');

  if (res.showdown && p.shown) {
    // Only contested pots count: a side pot nobody else could win proves nothing.
    const contested = res.pots.filter((pot) => pot.eligible.length > 1);
    const wonHi = contested.some((pot) => pot.winnersHi.includes(i));
    const wonLo = contested.some((pot) => pot.winnersLo.includes(i));
    if (won > 0 && (wonHi || wonLo)) add('showdownWins');
    const val = showdownValue(v, p.cards, hand.board);
    if (val.hi !== null) {
      const cat = categoryOf(val.hi, v.shortDeck);
      if (wonHi) {
        if (CAT_KEYS[cat]) add(`made.${CAT_KEYS[cat]}`);
        if (cat === Cat.STRAIGHT_FLUSH && ((val.hi >> 16) & 15) === 14) add('made.royal');
        if (cat === Cat.HIGH) add('airWins');
      } else if (won === 0 && cat >= Cat.FULL_HOUSE && contested.length) add('badBeats');
    }
    if (val.lo !== null && wonLo) {
      add('lowWins');
      if (val.lo === WHEEL_LOW) add('wheels');
    }
  }

  if (opts.online) {
    add('online.hands');
    if (net > 0) best('online.bigPotBB', potBB);
    const beaten = (opts.friends ?? []).filter((j) => j !== i && hand.players[j]?.shown && (res.won[j] ?? 0) === 0);
    if (res.showdown && won > 0 && p.shown && beaten.length) add('online.beatFriend', beaten.length);
  }
  return t;
}

/** Keeps the current winning run, which `bestRun` remembers the best of. */
export function runAfter(run: number, hand: Hand, i: number): number {
  const p = hand.players[i];
  return p && p.stack > p.startStack ? run + 1 : 0;
}

export interface TournamentFinish {
  format: Format;
  place: number;
  /** Paid a prize. */
  cashed: boolean;
  /** Difficulty of each bot at the table. */
  bots: (Difficulty | undefined)[];
  online?: boolean;
  /** Online: other people who played in it. */
  friends?: number;
}

export function tournamentTally(f: TournamentFinish): Tally {
  const t = emptyTally();
  const add = (k: string) => (t.sum[k] = (t.sum[k] ?? 0) + 1);
  if (f.cashed) add('cashes');
  if (f.place !== 1) return t;
  add(f.format === 'headsup' ? 'huWins' : 'sngWins');
  const d = f.bots[0];
  if (d && f.bots.every((b) => b === d)) {
    add(`beat.${d}`);
    if (d === 'expert' && f.format === 'sng' && f.bots.length >= 5) add('beat.expertFull');
  }
  if (f.online) {
    add('online.tourneyWins');
    if ((f.friends ?? 0) > 0) add('online.friendTourneyWins');
  }
  return t;
}

/**
 * What a settled blackjack round adds to the record of the player in `seat`. `run` is their
 * winning streak including this round.
 */
export function blackjackTally(round: Round, seat: number, run = 0): Tally {
  const t = emptyTally();
  const s = round.seats[seat];
  // A round the developer console rigged proves nothing.
  if (!round.isComplete || !s || round.rigged) return t;
  const add = (k: string, by = 1) => (t.sum[k] = (t.sum[k] ?? 0) + by);
  const net = round.net(seat);
  add('bj.hands');
  add('bj.net', net);
  if (net > 0) {
    add('bj.wins');
    t.max['bj.bigWin'] = net;
  }
  if (run > 0) t.max['bj.bestRun'] = run;
  const won = (o: string | null) => o === 'win' || o === 'blackjack';
  for (const h of s.hands) {
    if (h.outcome === 'blackjack' || (h.outcome === 'push' && !h.split && h.cards.length === 2 && handTotal(h.cards).total === 21)) add('bj.naturals');
    if (h.doubled && won(h.outcome)) add('bj.doubleWins');
    if (h.cards.length >= 5 && handTotal(h.cards).total === 21) add('bj.charlies');
  }
  if (s.hands.length > 1 && s.hands.every((h) => won(h.outcome))) add('bj.splitSweeps');
  if (s.insurance && round.dealer.length === 2 && handTotal(round.dealer).total === 21) add('bj.insured');
  return t;
}

/** What one spin of the roulette wheel adds to the player's record. */
export function rouletteTally(r: SpinResult): Tally {
  const t = emptyTally();
  if (!r.staked) return t;
  const add = (k: string) => (t.sum[k] = (t.sum[k] ?? 0) + 1);
  add('rl.spins');
  if (r.net > 0) t.max['rl.bigWin'] = r.net;
  const hits = r.spots.filter((s) => s.paid > 0 && s.key.startsWith('straight:'));
  if (hits.length) add('rl.straightHits');
  if (isZero(r.pocket) && hits.length) add('rl.zeroHits');
  return t;
}

/** What one baccarat coup adds to the player's record. `run` is their streak of winning hands including this one. */
export function baccaratTally(coup: Coup, r: BacResult, run = 0): Tally {
  const t = emptyTally();
  if (!r.staked) return t;
  const add = (k: string) => (t.sum[k] = (t.sum[k] ?? 0) + 1);
  add('bac.hands');
  if (r.net > 0) t.max['bac.bigWin'] = r.net;
  if (run > 0) t.max['bac.bestRun'] = run;
  const won = (spot: string) => r.spots.some((s) => s.spot === spot && s.outcome === 'win');
  if (won('tie')) add('bac.tieWins');
  if (won('playerPair') || won('bankerPair')) add('bac.pairWins');
  const nine = coup.natural && ((won('player') && coup.playerTotal === 9) || (won('banker') && coup.bankerTotal === 9));
  if (nine) add('bac.nines');
  return t;
}

/** What one hand of video poker adds to the player's record. */
export function videoPokerTally(hand: VpHand, r: VpResult): Tally {
  const t = emptyTally();
  if (!r.staked) return t;
  const add = (k: string) => (t.sum[k] = (t.sum[k] ?? 0) + 1);
  add('vp.hands');
  if (r.net > 0) t.max['vp.bigWin'] = r.net;
  if (r.line && r.replaced === 5) add('vp.cleanSlates');
  if (isQuadsLine(r.line)) add('vp.quads');
  if (isAcesLine(r.line, hand.cards)) add('vp.aces');
  if (r.line === 'royal') add('vp.royals');
  return t;
}

/** What one spin of the slot machine adds to the player's record. */
export function slotsTally(r: SlotSpin): Tally {
  const t = emptyTally();
  if (!r.staked) return t;
  const add = (k: string) => (t.sum[k] = (t.sum[k] ?? 0) + 1);
  add('sl.spins');
  if (r.net > 0) t.max['sl.bigWin'] = r.net;
  if (r.wins.length) t.max['sl.mostLines'] = r.wins.length;
  if (r.wins.some((w) => w.pay === 'crowns')) add('sl.crowns');
  if (r.wins.some((w) => w.pay === 'sevens')) add('sl.sevens');
  return t;
}

/** Leaving a cash game with `net` chips more (or less) than were bought in. */
export function cashTally(net: number, bigBlind: number): Tally {
  const t = emptyTally();
  if (net > 0) {
    t.sum.cashUp = 1;
    t.max.cashBestBB = Math.floor(net / Math.max(1, bigBlind));
  }
  return t;
}
