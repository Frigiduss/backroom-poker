// The house's own staff: who deals blackjack, who spins the roulette wheel and who runs the
// baccarat shoe. Each has a
// name, a face, a short story and a way of talking. They speak now and then about what just
// happened, never about what to do: a dealer gives no advice.
import { Rng } from '../engine/cards';

export type DealerGame = 'blackjack' | 'roulette' | 'baccarat';

export type BjMoment = 'hello' | 'shuffle' | 'playerBj' | 'dealerBj' | 'dealerBust' | 'bigWin' | 'win' | 'lose' | 'push';
export type RlMoment = 'hello' | 'noMore' | 'zero' | 'straight' | 'repeat' | 'bigWin' | 'win' | 'lose';
export type BacMoment = 'hello' | 'shuffle' | 'natural' | 'tie' | 'pair' | 'bigWin' | 'win' | 'lose' | 'push';
export type DealerMoment = BjMoment | RlMoment | BacMoment;

export interface Dealer {
  name: string;
  face: string;
  game: DealerGame;
  /** One line about them, shown when you hover their name. */
  bio: string;
  /**
   * Their own lines; the house lines for the game fill in the rest. `{n}` is the number that came
   * up at roulette, and at baccarat the winning total (or the side that won, for `win`/`lose`).
   */
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
  // Baccarat
  { name: 'Lorenzo', face: '🥂', game: 'baccarat', bio: 'Ran the salon privé in Macau. Treats every coup like a ceremony.', lines: {
    hello: ['Good evening. Player, Banker or Tie. The shoe is waiting.', 'Welcome to the salon. Please, be seated.'],
    shuffle: ['A fresh shoe. Eight decks, and a new scoreboard.'],
    natural: ['A natural {n}. Nobody draws.', 'Natural {n}. Elegant.'],
    tie: ['Égalité. {n} all.', 'A tie, {n} each. Player and Banker bets come back.'],
    pair: ['A pair. Eleven to one, with pleasure.'],
    bigWin: ['Splendid. The salon salutes you.'],
    lose: ['The shoe giveth, the shoe taketh.'],
  } },
  { name: 'Mei', face: '🏮', game: 'baccarat', bio: 'Squeezes every third card like it owes her money.', lines: {
    hello: ['Hello! Pick a side. I’ll do the squeezing.', 'Hi there. Player or Banker tonight?'],
    natural: ['Natural {n}! No squeeze needed.', 'Ooh, {n} straight off.'],
    tie: ['A tie! {n} all. Didn’t see that coming.', '{n} and {n}. The shoe is teasing us.'],
    pair: ['Pair! I love a pair.', 'Look at that pair. Eleven to one!'],
    win: ['{n} wins. You called it.', 'Nicely read.'],
    lose: ['{n} this time. Next shoe’s yours.'],
    bigWin: ['That’s a big one! Lucky red envelope for you.'],
  } },
  { name: 'Hugo', face: '🧐', game: 'baccarat', bio: 'Old-school. Calls the totals and nothing else, mostly.', lines: {
    hello: ['Evening. Bets on the layout, please.', 'Good evening. Player, Banker, Tie.'],
    shuffle: ['New shoe. Burning the first card.'],
    natural: ['Natural {n}.', '{n}, a natural. Nobody draws.'],
    tie: ['Tie hand, {n} all.'],
    win: ['{n} wins.'],
    lose: ['{n} wins.'],
    push: ['Bets stand.'],
  } },
  { name: 'Coco', face: '🎀', game: 'baccarat', bio: 'Believes in streaks, hunches and lucky earrings.', lines: {
    hello: ['Hi darling! I have a feeling about tonight.', 'Oh, welcome! Lucky earrings are on.'],
    natural: ['A natural {n}! Told you, a feeling.', 'Natural {n}! Mwah.'],
    tie: ['A tie! {n} all! I adore a tie.'],
    pair: ['A pair! Like my earrings!'],
    bigWin: ['Darling! That’s a big one!', 'Champagne for the lucky one!'],
    win: ['{n}! Yes!', 'Ooh, {n} for you.'],
    lose: ['Aw, {n}. It’ll swing back, darling.'],
  } },
];

/** What any dealer of this game might say, when they have nothing of their own. */
const HOUSE_LINES: { blackjack: Record<BjMoment, string[]>; roulette: Record<RlMoment, string[]>; baccarat: Record<BacMoment, string[]> } = {
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
  baccarat: {
    hello: ['Place your bets. Player, Banker or Tie.'],
    shuffle: ['Fresh shoe.', 'New shoe, new scoreboard.'],
    natural: ['A natural {n}.', 'Natural {n}. No more cards.'],
    tie: ['Tie, {n} all.', 'A tie. Player and Banker bets push.'],
    pair: ['A pair! Pays eleven to one.'],
    bigWin: ['Big winner on the layout!', 'That’s a good coup.'],
    win: ['{n} wins. Paying out.', 'Winner.'],
    lose: ['{n} wins this one.', 'Better luck next coup.'],
    push: ['Bets come back.'],
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
  natural: 0.7, tie: 0.8, pair: 0.9,
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

export interface BacCoupView {
  winner: 'player' | 'banker' | 'tie';
  /** Either side had 8 or 9 on its first two cards. */
  natural: boolean;
  /** A pair bet of the player's won. */
  pairHit: boolean;
  /** The player's net for the coup. */
  net: number;
  min: number;
}

/** The one thing a baccarat croupier would remark on after a coup, most notable first. */
export function bacMoment(v: BacCoupView): BacMoment {
  if (v.pairHit) return 'pair';
  if (v.winner === 'tie') return 'tie';
  if (v.net >= v.min * 8) return 'bigWin';
  if (v.natural) return 'natural';
  if (v.net > 0) return 'win';
  if (v.net < 0) return 'lose';
  return 'push';
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
  baccarat: [
    'Psst. Banker is the best bet on this table, even after the commission.',
    'Between you and me: stay off the Tie. Eight to one looks generous; it isn’t.',
    'Little secret: the pair bets are pretty to look at and expensive to keep.',
    'Between us: the scoreboard is for show. The shoe doesn’t remember streaks.',
    'Psst. Chasing losses is how the house pays for the chandeliers. Take a breather.',
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
