// The regulars: who sits in a bot's seat. Each one has a name, a face, a playing style
// that matches their character, and a handful of things they say at the table. Skill
// (difficulty) still comes from the table setup, so any regular can turn up at any level.
import { Rng } from '../engine/cards';
import { BotStyle } from '../engine/table';

export type TalkEvent = 'hello' | 'win' | 'bigwin' | 'lose' | 'allin' | 'steal' | 'bust';

export interface Persona {
  name: string;
  /** An emoji face for the avatar. */
  face: string;
  style: BotStyle;
  /** One line about them, shown when you hover the seat. */
  bio: string;
  /** Their own lines; anything missing falls back to lines for their style. */
  lines: Partial<Record<TalkEvent, string[]>>;
}

export const PERSONAS: readonly Persona[] = [
  { name: 'Doc', face: '🧐', style: 'tight', bio: 'Retired surgeon. Folds a lot, then doesn’t.', lines: { win: ['Textbook.', 'The numbers never lie.'], lose: ['Statistically, that was rude.'], hello: ['Evening. Let’s keep it civil.'] } },
  { name: 'Big Lou', face: '😎', style: 'aggressive', bio: 'Owns the bar. Owns most pots too.', lines: { allin: ['All of it. Every chip.', 'You want to dance?'], steal: ['Mine. Thank you.'], bigwin: ['Drinks are on me. Not really.'] } },
  { name: 'Mae', face: '👵', style: 'passive', bio: 'Has played here since 1971. Never raises without the nuts.', lines: { hello: ['Hello, dears.'], win: ['Oh! Would you look at that.', 'Beginner’s luck, sweetie.'], lose: ['Well, aren’t you clever.'] } },
  { name: 'Tex', face: '🤠', style: 'loose', bio: 'Drove in from Amarillo. Plays any two cards.', lines: { win: ['Yeehaw!', 'Saddle up, partner.'], allin: ['Let’s rodeo.'], bust: ['That horse threw me.'] } },
  { name: 'Lucky', face: '🍀', style: 'loose', bio: 'Swears by a rabbit’s foot. Calls far too often.', lines: { win: ['Told you. Lucky.', 'The clover provides.'], lose: ['Must have left my charm in the car.'] } },
  { name: 'Prof', face: '🤓', style: 'balanced', bio: 'Teaches game theory. Tells you about it.', lines: { win: ['As the model predicted.'], lose: ['A variance event. Noted.'], steal: ['Fold equity, everyone.'] } },
  { name: 'Vinnie', face: '🕶️', style: 'aggressive', bio: 'Never takes the shades off. Never slows down.', lines: { steal: ['Nothin’ personal.'], allin: ['Fuhgeddaboudit.'], bigwin: ['That’s how we do it.'] } },
  { name: 'Rosa', face: '🌹', style: 'balanced', bio: 'Quiet, patient and very hard to read.', lines: { win: ['Gracias.'], hello: ['Buena suerte, everyone.'] } },
  { name: 'Slim', face: '🎩', style: 'tight', bio: 'Old-school road gambler. Waits for aces.', lines: { win: ['Patience pays.'], lose: ['Nice catch, friend.'] } },
  { name: 'Duchess', face: '👑', style: 'tight', bio: 'Plays for sport. Expects to be called ma’am.', lines: { win: ['How delightful.', 'Do try to keep up.'], lose: ['How vulgar.'], hello: ['Charmed, I’m sure.'] } },
  { name: 'Skipper', face: '🧔', style: 'balanced', bio: 'Fishing boat captain. Steady hands, salty mouth.', lines: { win: ['Reel it in!'], lose: ['Rough waters.'], bust: ['Abandon ship.'] } },
  { name: 'Ziggy', face: '🤪', style: 'loose', bio: 'Nobody knows what Ziggy has. Ziggy doesn’t either.', lines: { allin: ['Wheee!', 'YOLO.'], win: ['I meant to do that.'], bust: ['Worth it.'] } },
  { name: 'Momo', face: '🐼', style: 'passive', bio: 'Calm as a panda. Calls, calls, calls.', lines: { win: ['Bamboo money.'], hello: ['Hi hi.'] } },
  { name: 'Hank', face: '👷', style: 'passive', bio: 'Comes straight from the site on Fridays.', lines: { win: ['Hard day’s work.'], lose: ['There goes the overtime.'] } },
  { name: 'Pearl', face: '🦪', style: 'tight', bio: 'Clams up and waits for a gem.', lines: { win: ['Worth the wait.'], steal: ['Shh.'] } },
  { name: 'Rocco', face: '🥊', style: 'aggressive', bio: 'Ex-boxer. Leads with his chin and his chips.', lines: { allin: ['Knockout punch.'], bigwin: ['Down goes the pot!'], lose: ['Lucky jab.'] } },
  { name: 'Sunny', face: '🌞', style: 'loose', bio: 'Has never had a bad day. Probably won’t start now.', lines: { win: ['What a day!'], lose: ['Good hand! Really!'], hello: ['Hi everyone! Good luck!'] } },
  { name: 'Bishop', face: '♟️', style: 'balanced', bio: 'Chess club champion. Thinks six moves ahead.', lines: { win: ['Checkmate.'], steal: ['Positional advantage.'] } },
  { name: 'Lola', face: '💃', style: 'aggressive', bio: 'Bets like she dances: fast and fearless.', lines: { allin: ['Shall we?'], win: ['Ole!'] } },
  { name: 'Moose', face: '🫎', style: 'passive', bio: 'Big, gentle, and impossible to bluff off a pair.', lines: { win: ['Hm. Okay.'], lose: ['Aw, shucks.'] } },
  { name: 'Ace', face: '🃏', style: 'aggressive', bio: 'Claims to be a pro. Has a podcast about it.', lines: { win: ['Like and subscribe.'], lose: ['Cooler. Nothing I could do.'], steal: ['Pressure is a privilege.'] } },
  { name: 'Nell', face: '🐈', style: 'tight', bio: 'Brings her cat. The cat is a better player.', lines: { win: ['Purrfect.'], lose: ['Hiss.'] } },
  { name: 'Gus', face: '🍔', style: 'loose', bio: 'Orders fries every orbit. Plays every hand.', lines: { win: ['Fries for everyone!'], bust: ['Back to the kitchen.'] } },
  { name: 'Wren', face: '🐦', style: 'balanced', bio: 'Birdwatcher. Notices everything you do.', lines: { lose: ['Saw that coming. Called anyway.'], win: ['Early bird.'] } },
];

/** Lines anyone of a given style might say, when they have nothing of their own. */
const STYLE_LINES: Record<BotStyle, Record<TalkEvent, string[]>> = {
  balanced: {
    hello: ['Good luck all.', 'Evening, everyone.'],
    win: ['I’ll take it.', 'Nice pot.'],
    bigwin: ['Now that’s a pot.', 'Stacking up.'],
    lose: ['Nice hand.', 'Well played.'],
    allin: ['I’m all in.', 'Let’s see it.'],
    steal: ['Thanks.', 'I’ll take those blinds.'],
    bust: ['Good game, all.', 'That’s me done.'],
  },
  tight: {
    hello: ['Evening.'],
    win: ['Had it the whole way.', 'Patience.'],
    bigwin: ['Waited all night for that.'],
    lose: ['Unbelievable.', 'You called with THAT?'],
    allin: ['I have it this time.'],
    steal: ['Rare, I know.'],
    bust: ['Ran it bad all night.'],
  },
  loose: {
    hello: ['Let’s gamble!', 'Who’s ready to play some cards?'],
    win: ['Any two cards, baby!', 'Ha! Didn’t see that coming, did you?'],
    bigwin: ['Now we’re cooking!'],
    lose: ['Easy come, easy go.', 'Worth a shot.'],
    allin: ['Why not?', 'Shove it in!'],
    steal: ['Ha!'],
    bust: ['Can I rebuy? Please?'],
  },
  aggressive: {
    hello: ['Hope you brought chips.'],
    win: ['Too easy.', 'Mine.'],
    bigwin: ['Ship it!', 'Who’s next?'],
    lose: ['Lucky river.', 'Enjoy it while it lasts.'],
    allin: ['All in. Your move.', 'Pay to see it.'],
    steal: ['Thanks for folding.', 'Try playing back sometime.'],
    bust: ['This isn’t over.'],
  },
  passive: {
    hello: ['Hello.', 'Hi there.'],
    win: ['Oh, nice!', 'Really? Me?'],
    bigwin: ['Oh my goodness.'],
    lose: ['Oh well.', 'Good one.'],
    allin: ['Um... all in, I suppose.'],
    steal: ['Oh! Thank you.'],
    bust: ['That was fun anyway.'],
  },
};

export const PERSONA_NAMES: readonly string[] = PERSONAS.map((p) => p.name);

const BY_NAME = new Map(PERSONAS.map((p) => [p.name.toLowerCase(), p]));

/** The regular with this name, if it is one of them. */
export const personaFor = (name: string): Persona | undefined => BY_NAME.get(name.toLowerCase());

/** Something this persona might say about what just happened. */
export function lineFor(p: Persona, event: TalkEvent, rng: Rng): string {
  const own = p.lines[event] ?? [];
  const pool = STYLE_LINES[p.style][event];
  // Their own lines come up more often than the general ones.
  const all = [...own, ...own, ...pool];
  return all[Math.floor(rng.next() * all.length)];
}

/** How likely a bot is to speak up after each kind of moment. */
export const TALK_CHANCE: Record<TalkEvent, number> = { hello: 0.5, win: 0.3, bigwin: 0.7, lose: 0.35, allin: 0.4, steal: 0.12, bust: 0.9 };

export interface HandMoment {
  /** Seat ids of bots by hand index; null for people. */
  bots: (string | null)[];
  showdown: boolean;
  /** Chips won or lost this hand, by hand index. */
  net: number[];
  pot: number;
  /** Hand indexes of players this hand knocked out. */
  busted: number[];
  bigBlind: number;
}

export interface Remark {
  seat: string;
  event: TalkEvent;
}

/**
 * Picks who (if anyone) speaks after a finished hand: at most one bot, the one with the
 * most to say. `roll` is a 0..1 random number deciding whether they bother.
 */
export function remarkAfter(m: HandMoment, roll: number): Remark | null {
  const options: { i: number; event: TalkEvent; weight: number }[] = [];
  const big = m.pot >= m.bigBlind * 30;
  m.bots.forEach((seat, i) => {
    if (!seat) return;
    const net = m.net[i];
    if (m.busted.includes(i)) options.push({ i, event: 'bust', weight: 5 });
    else if (net > 0 && m.showdown) options.push({ i, event: big ? 'bigwin' : 'win', weight: big ? 4 : 2 });
    else if (net > 0 && m.pot >= m.bigBlind * 4) options.push({ i, event: 'steal', weight: 1 });
    else if (m.showdown && net <= -m.bigBlind * 10) options.push({ i, event: 'lose', weight: 3 });
  });
  if (!options.length) return null;
  options.sort((a, b) => b.weight - a.weight);
  const top = options[0];
  if (roll >= TALK_CHANCE[top.event]) return null;
  return { seat: m.bots[top.i]!, event: top.event };
}
