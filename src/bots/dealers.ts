// The house's own staff: who deals blackjack and who spins the roulette wheel. Each has a
// name, a face, a short story and a way of talking. They speak now and then about what just
// happened, never about what to do: a dealer gives no advice.
import { Rng } from '../engine/cards';

export type DealerGame = 'blackjack' | 'roulette';

export type BjMoment = 'hello' | 'shuffle' | 'playerBj' | 'dealerBj' | 'dealerBust' | 'bigWin' | 'win' | 'lose' | 'push';
export type RlMoment = 'hello' | 'noMore' | 'zero' | 'straight' | 'repeat' | 'bigWin' | 'win' | 'lose';
export type DealerMoment = BjMoment | RlMoment;

export interface Dealer {
  name: string;
  face: string;
  game: DealerGame;
  /** One line about them, shown when you hover their name. */
  bio: string;
  /** Their own lines; the house lines for the game fill in the rest. `{n}` is the number that came up. */
  lines: Partial<Record<DealerMoment, string[]>>;
}

export const DEALERS: readonly Dealer[] = [
  // Blackjack
  { name: 'Frankie', face: '🤵', game: 'blackjack', bio: 'Thirty years on the Strip. Has seen every hand twice.', lines: {
    hello: ['Evening. Pull up a chair, the cards are warm.', 'Welcome back. Or welcome. Either way.'],
    playerBj: ['Blackjack! Pays three to two, my friend.', 'Now that’s how you start a night.'],
    dealerBj: ['Sorry folks. House has it.', 'Hate to do it to you.'],
    dealerBust: ['Too many. Everybody still standing gets paid.', 'Busted. Drinks are on the house. Kidding.'],
    lose: ['The cards giveth...', 'Next one’s yours. Probably.'],
  } },
  { name: 'Dolores', face: '💅', game: 'blackjack', bio: 'Deals faster than you can blink. Unimpressed by everything.', lines: {
    hello: ['Bets in, sweetheart.', 'Hi. Cards are dealt, not wished for.'],
    playerBj: ['Blackjack. Congratulations, I guess.', 'Look at you.'],
    dealerBj: ['Blackjack. Don’t take it personally.', 'Mm. Mine.'],
    dealerBust: ['Fine. Take it.', 'Ugh. Twenty-two.'],
    win: ['Paid.', 'There you go.'],
    lose: ['Happens.', 'Mm-hm.'],
    shuffle: ['New shoe. Same old me.'],
  } },
  { name: 'Kenji', face: '😄', game: 'blackjack', bio: 'Second week on the job. Loves every single card.', lines: {
    hello: ['Hi! Welcome! I’m Kenji, I’ll be your dealer!', 'Oh good, company! Let’s have fun.'],
    playerBj: ['BLACKJACK! Oh wow, oh wow!', 'Three to two! I love paying those!'],
    dealerBj: ['Oh no, I have blackjack. I’m so sorry!', 'Ah. Sorry, sorry.'],
    dealerBust: ['I busted! Everyone wins! Well, almost everyone.', 'Twenty-five! That’s too many, right? Yes. Too many.'],
    bigWin: ['That’s a big one! Should I ring a bell? Is there a bell?'],
    push: ['A tie! Nobody loses. My favourite.'],
    shuffle: ['Shuffle time! I’ve been practising.'],
  } },
  { name: 'Marge', face: '👓', game: 'blackjack', bio: 'Runs a tight table. Remembers your name and your bets.', lines: {
    hello: ['Good evening. Minimums are on the sign, dear.', 'Welcome. Hands where I can see them.'],
    playerBj: ['Blackjack. Well done, dear.', 'A natural. Lovely.'],
    dealerBj: ['Dealer has blackjack. Better luck next round.'],
    dealerBust: ['Dealer busts. Paying the table.'],
    push: ['Push. Your bet stays where it is.'],
    shuffle: ['Fresh shoe. Cut card’s in.', 'Shuffling up. A moment, please.'],
  } },
  // Roulette
  { name: 'Étienne', face: '🎩', game: 'roulette', bio: 'Trained in Monte Carlo. Says it in French first.', lines: {
    hello: ['Bonsoir. Faites vos jeux.', 'Welcome to my wheel. Faites vos jeux.'],
    noMore: ['Rien ne va plus.', 'Les jeux sont faits.'],
    zero: ['Zéro. The house thanks you.', 'Ah, zéro. C’est la vie.'],
    straight: ['{n}, plein! Magnifique.', 'Straight up on {n}. Bravo.'],
    bigWin: ['Formidable! A very good spin.'],
    lose: ['Next time, peut-être.'],
  } },
  { name: 'Vera', face: '💎', game: 'roulette', bio: 'Spins like she’s on stage. The wheel is her spotlight.', lines: {
    hello: ['Darling, you came! Place your bets.', 'Hello, gorgeous. The wheel missed you.'],
    noMore: ['And around she goes...', 'No more bets, darlings.'],
    zero: ['Zero! How dramatic.'],
    straight: ['{n}! You picked it! I could kiss you.', 'Right on the number, darling.'],
    bigWin: ['Champagne for this one!', 'Now THAT is a spin.'],
    win: ['Lovely. Collect your chips.'],
    lose: ['Oh, the wheel is cruel tonight.'],
  } },
  { name: 'Sal', face: '🧓', game: 'roulette', bio: 'Forty years at the wheel. Has a story about every number.', lines: {
    hello: ['Siddown, siddown. Bets on the layout.', 'Hey, a new face. Good luck, kid.'],
    noMore: ['That’s it, hands off.', 'No more bets.'],
    zero: ['Zero. Seen it come up three times running once. Nineteen seventy-nine.'],
    straight: ['{n}! I had a feeling about {n}.', 'Straight up {n}. Thirty-five to one, kid.'],
    repeat: ['{n} again! Wheel’s got a favourite.'],
    lose: ['That’s roulette, kid.'],
  } },
  { name: 'Bea', face: '🌸', game: 'roulette', bio: 'Cheerful, chatty and quietly counting every chip.', lines: {
    hello: ['Hi there! Pick a chip, any spot you like.', 'Welcome! Big night?'],
    noMore: ['Here we go!', 'Spinning! No more bets!'],
    zero: ['Ooh, the green one.'],
    straight: ['{n}! Right on the money!'],
    win: ['Yay! There’s your chips.', 'A winner!'],
    lose: ['Aw. Next spin!'],
  } },
];

/** What any dealer of this game might say, when they have nothing of their own. */
const HOUSE_LINES: { blackjack: Record<BjMoment, string[]>; roulette: Record<RlMoment, string[]> } = {
  blackjack: {
    hello: ['Welcome to the table. Good luck.'],
    shuffle: ['Fresh shoe.', 'Shuffling up.'],
    playerBj: ['Blackjack! Pays three to two.'],
    dealerBj: ['Dealer has blackjack.'],
    dealerBust: ['Dealer busts.', 'Too many for the house.'],
    bigWin: ['Nice win.', 'That’s a good round.'],
    win: ['Winner.', 'Pay the player.'],
    lose: ['House wins this one.', 'Better luck next hand.'],
    push: ['Push.', 'A tie. Your bet stays.'],
  },
  roulette: {
    hello: ['Place your bets.'],
    noMore: ['No more bets.'],
    zero: ['Zero.', 'Green, zero.'],
    straight: ['{n}, straight up. A winner!'],
    repeat: ['{n} again!', 'Twice in a row, {n}.'],
    bigWin: ['Big winner on the layout!'],
    win: ['Winner. Paying out.', 'Pay the layout.'],
    lose: ['Better luck next spin.', 'The house takes this one.'],
  },
};

const BY_NAME = new Map(DEALERS.map((d) => [d.name.toLowerCase(), d]));

export const dealerByName = (name: string): Dealer | undefined => BY_NAME.get(name.toLowerCase());

/** A dealer for a new sitting at this game. */
export function pickDealer(game: DealerGame, rng: Rng): Dealer {
  const staff = DEALERS.filter((d) => d.game === game);
  return staff[Math.floor(rng.next() * staff.length)];
}

/** Something this dealer might say about a moment. Their own lines come up more often. */
export function dealerLine(d: Dealer, moment: DealerMoment, rng: Rng, n = ''): string {
  const own = d.lines[moment] ?? [];
  const house = (HOUSE_LINES[d.game] as Record<DealerMoment, string[] | undefined>)[moment] ?? [];
  const all = [...own, ...own, ...house];
  if (!all.length) return '';
  return all[Math.floor(rng.next() * all.length)].split('{n}').join(n);
}

/** How likely the dealer is to say something about each kind of moment. The big ones nearly always. */
export const DEALER_CHANCE: Record<DealerMoment, number> = {
  hello: 1, shuffle: 0.8, playerBj: 0.9, dealerBj: 0.7, dealerBust: 0.45, bigWin: 0.9, win: 0.2, lose: 0.15, push: 0.2,
  noMore: 0.3, zero: 0.75, straight: 0.9, repeat: 0.8,
};

/** What a blackjack round meant for the player, as the dealer sees it. */
export interface BjRoundView {
  /** The player's hand outcomes. */
  outcomes: string[];
  /** The player's net for the round. */
  net: number;
  /** The table minimum, to judge what counts as a big win. */
  min: number;
  dealerNatural: boolean;
  dealerBusted: boolean;
}

/** The one thing a blackjack dealer would remark on after a round, most notable first. */
export function bjMoment(v: BjRoundView): BjMoment {
  if (v.outcomes.includes('blackjack')) return 'playerBj';
  if (v.dealerNatural) return 'dealerBj';
  if (v.net >= v.min * 8) return 'bigWin';
  if (v.dealerBusted && v.net > 0) return 'dealerBust';
  if (v.net > 0) return 'win';
  if (v.net < 0) return 'lose';
  return 'push';
}

export interface RlSpinView {
  /** The pocket that came up, and the one before it if any. */
  pocket: number;
  previous?: number;
  zero: boolean;
  /** A straight-up bet on the winning number. */
  straightHit: boolean;
  net: number;
  staked: number;
  min: number;
}

/** The one thing a croupier would remark on after a spin, most notable first. */
export function rlMoment(v: RlSpinView): RlMoment {
  if (v.straightHit) return 'straight';
  if (v.net >= Math.max(v.min * 10, v.staked * 5)) return 'bigWin';
  if (v.zero) return 'zero';
  if (v.previous === v.pocket) return 'repeat';
  if (v.net > 0) return 'win';
  return 'lose';
}

/**
 * Decides whether the dealer speaks this time. Small talk waits a couple of rounds after the
 * last line; big moments don't. `roll` is a 0..1 random number.
 */
export function dealerSpeaks(moment: DealerMoment, roundsSinceLast: number, roll: number): boolean {
  const big = DEALER_CHANCE[moment] >= 0.7;
  if (!big && roundsSinceLast < 3) return false;
  return roll < DEALER_CHANCE[moment];
}

// ---------- the whisper ----------

/**
 * Once a player is well down for the sitting, the dealer may lean in, very rarely, and quietly
 * pass on a piece of advice. Never more than once a sitting.
 */
export const WHISPER_CHANCE = 0.001;
/** How far down the player must be, in table minimums, before a whisper can happen. */
export const WHISPER_DOWN_MINS = 25;

const WHISPERS: Record<DealerGame, string[]> = {
  blackjack: [
    'Between you and me: never take insurance. It’s the worst bet on the felt.',
    'Psst. Always split aces and eights. Never split tens or fives.',
    'Little secret: when I show a 4, 5 or 6, let me be the one who busts.',
    'Just between us: double your 11 against anything but my ace.',
    'Psst. Chasing losses is how the house pays for the chandeliers. Take a breather.',
    'Between us: drop to the table minimum for a while. Bad runs end; banks don’t come back.',
  ],
  roulette: [
    'Psst. The European wheel has one zero. Half the house edge of the American.',
    'Between you and me: the wheel has no memory. Red isn’t ‘due’.',
    'Little secret: every bet here has the same edge. Bigger payouts just come less often.',
    'Psst. Chasing losses is how the house pays for the chandeliers. Take a breather.',
    'Between us: set a stopping point before the next spin, and keep to it.',
  ],
};

/** Whether the dealer whispers now: well down for the sitting, no whisper yet, and a rare roll. */
export function shouldWhisper(down: number, min: number, whispered: boolean, roll: number, chance = WHISPER_CHANCE): boolean {
  return !whispered && down >= min * WHISPER_DOWN_MINS && roll < chance;
}

export function whisperLine(game: DealerGame, rng: Rng): string {
  const pool = WHISPERS[game];
  return pool[Math.floor(rng.next() * pool.length)];
}
