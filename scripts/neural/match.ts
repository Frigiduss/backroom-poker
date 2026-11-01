// Duplicate match: the same deals played once with Expert and once with Master in the hero seat.
// Run through scripts/neural/run.mjs. Args: seed hands opponents(comma list of difficulty[:style])
import { Bot } from '../../src/bots/bot';
import { buildView } from '../../src/bots/view';
import { createRng } from '../../src/engine/cards';
import { Hand } from '../../src/engine/hand';
import { BotStyle, Difficulty, stakesFor } from '../../src/engine/table';
import { VARIANTS } from '../../src/engine/variants';

const [, , seedArg, handsArg, oppArg] = process.argv;
const rng = createRng(Number(seedArg));
const STYLES: BotStyle[] = ['balanced', 'tight', 'loose', 'aggressive', 'passive'];
const opps = (oppArg ?? 'hard,expert').split(',').map((x) => x.split(':') as [Difficulty, BotStyle?]);
const STAKES = stakesFor(VARIANTS.holdem, 20, 0, 'cash');
const u32 = () => (rng.next() * 2 ** 32) >>> 0;

let n = 0, sum = 0, sum2 = 0, expertTotal = 0, masterTotal = 0;
for (let k = 0; k < Number(handsArg); k++) {
  const players = 2 + Math.floor(rng.next() * 5);
  const seed = u32(), button = Math.floor(rng.next() * players), hero = Math.floor(rng.next() * players), heroSeed = u32();
  const stacks = Array.from({ length: players }, () => Math.round(30 + rng.next() * 170) * STAKES.bb);
  const seats = stacks.map(() => { const [d, st] = opps[Math.floor(rng.next() * opps.length)]; return { d, st: st ?? STYLES[Math.floor(rng.next() * 5)], seed: u32() }; });
  const play = (level: Difficulty) => {
    const h = new Hand({ variant: VARIANTS.holdem, structure: 'NL', stakes: STAKES, button, rng: createRng(seed), players: stacks.map((stack, i) => ({ id: `p${i}`, name: `P${i}`, stack })) });
    const bots = seats.map((s, i) => (i === hero ? new Bot(level, 'balanced', heroSeed) : new Bot(s.d, s.st, s.seed)));
    while (!h.isComplete) h.act(h.normalize(bots[h.toAct].decide(buildView(h, h.toAct))));
    return (h.players[hero].stack - h.players[hero].startStack) / STAKES.bb;
  };
  const e = play('expert'), m = play('master');
  n++; sum += m - e; sum2 += (m - e) ** 2; expertTotal += e; masterTotal += m;
}
console.log(JSON.stringify({ n, sum, sum2, expertTotal, masterTotal }));
