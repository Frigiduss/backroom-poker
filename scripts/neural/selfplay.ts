// Training data for the Master bot's net: bot-vs-bot No-Limit Hold'em spots, each move played out.
// Run through scripts/neural/run.mjs. Args: outFile seed seconds
import { appendFileSync, writeFileSync } from 'node:fs';
import { Bot, PROFILES } from '../../src/bots/bot';
import { NET_ACTIONS, candidates, features, moveIndex } from '../../src/bots/neural';
import { buildView } from '../../src/bots/view';
import { Rng, createRng, shuffle } from '../../src/engine/cards';
import { Action, Hand } from '../../src/engine/hand';
import { BotStyle, Difficulty, stakesFor } from '../../src/engine/table';
import { VARIANTS } from '../../src/engine/variants';

const [, , outFile, seedArg, secondsArg] = process.argv;
const rng = createRng(Number(seedArg));
/** Playouts per move; they share a reshuffled deck so moves are compared on the same cards. */
const PLAYOUTS = 3;
/** Share of seats played by the current Master, so the net also learns against itself. */
const MASTER_SHARE = 0.4;
const SAMPLE = 0.3;

// Lighter thinking keeps playouts fast. Equity reads stay unbiased, just a little noisier.
PROFILES.medium.sims = 200;
PROFILES.hard.sims = 300;
PROFILES.expert.sims = PROFILES.master.sims = 400;

const V = VARIANTS.holdem;
const STAKES = stakesFor(V, 20, 0, 'cash');
const STYLES: BotStyle[] = ['balanced', 'tight', 'loose', 'aggressive', 'passive'];
const OTHERS: Difficulty[] = ['medium', 'hard', 'hard', 'expert'];
const u32 = (r: Rng) => (r.next() * 2 ** 32) >>> 0;

interface Setup { seed: number; button: number; stacks: number[] }
interface Seat { difficulty: Difficulty; style: BotStyle }

const deal = (s: Setup) => new Hand({
  variant: V, structure: 'NL', stakes: STAKES, button: s.button, rng: createRng(s.seed),
  players: s.stacks.map((stack, i) => ({ id: `p${i}`, name: `P${i}`, stack })),
});

/** Big blinds `hero` wins from this point on if it makes `move`, with `deckSeed` deciding the cards still to come. */
function playout(s: Setup, seats: Seat[], history: Action[], move: Action, hero: number, deckSeed: number): number {
  const h = deal(s);
  for (const a of history) h.act(a);
  shuffle((h as unknown as { deck: number[] }).deck, createRng(deckSeed));
  const before = h.players[hero].stack;
  h.act(h.normalize(move));
  const bots = seats.map((x) => new Bot(x.difficulty, x.style, u32(rng)));
  while (!h.isComplete) h.act(h.normalize(bots[h.toAct].decide(buildView(h, h.toAct))));
  return (h.players[hero].stack - before) / STAKES.bb;
}

writeFileSync(outFile, '');
const end = Date.now() + Number(secondsArg) * 1000;
const reader = new Bot('master', 'balanced', u32(rng));
const expert = new Bot('expert', 'balanced', u32(rng));
let spots = 0;
while (Date.now() < end) {
  const n = 2 + Math.floor(rng.next() * 5);
  const s: Setup = { seed: u32(rng), button: Math.floor(rng.next() * n), stacks: Array.from({ length: n }, () => Math.round(30 + rng.next() * 170) * STAKES.bb) };
  const seats: Seat[] = s.stacks.map(() => ({
    difficulty: rng.next() < MASTER_SHARE ? 'master' : OTHERS[Math.floor(rng.next() * OTHERS.length)],
    style: STYLES[Math.floor(rng.next() * STYLES.length)],
  }));
  const bots = seats.map((x) => new Bot(x.difficulty, x.style, u32(rng)));
  const h = deal(s);
  const history: Action[] = [];
  const lines: string[] = [];
  while (!h.isComplete) {
    const view = buildView(h, h.toAct);
    if (view.legal.kind === 'bet' && rng.next() < SAMPLE) {
      const moves = candidates(view);
      const value: (number | null)[] = moves.map((m) => (m ? 0 : null));
      for (let k = 0; k < PLAYOUTS; k++) {
        const deckSeed = u32(rng);
        for (let i = 0; i < NET_ACTIONS; i++) {
          const m = moves[i];
          if (m && m.type !== 'fold') value[i]! += playout(s, seats, history, m, h.toAct, deckSeed) / PLAYOUTS;
        }
      }
      (reader as unknown as { equity(v: typeof view): number }).equity(view);
      const eq = (reader as unknown as { rawEquity: number }).rawEquity;
      const b = moveIndex(moves, h.normalize(expert.decide(view)));
      lines.push(JSON.stringify({ f: Array.from(features(view, eq), (x) => +x.toFixed(4)), r: value.map((x) => (x === null ? null : +x.toFixed(2))), b }));
      spots++;
    }
    const a = h.normalize(bots[h.toAct].decide(view));
    history.push(a);
    h.act(a);
  }
  if (lines.length) appendFileSync(outFile, lines.join('\n') + '\n');
}
console.log(`${outFile}: ${spots} spots`);
