import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Round, RoundRig, Shoe } from '../src/engine/blackjack';
import { cardLabel, createRng, parseCards } from '../src/engine/cards';
import { DevBlackjack, runBlackjack } from '../src/ui/console-blackjack';

const c = parseCards;

/** A practice table with the player and one bot, and a console that records what it prints. */
function practice() {
  const shoe = new Shoe(6, createRng(11));
  const t = {
    shoe,
    round: null as Round | null,
    spots: [{ id: 'p0', name: 'Fridge', isHuman: true, stack: 1000 }, { id: 'b0', name: 'Ada', isHuman: false, stack: 400 }],
    nextRig: null as RoundRig | null,
    paused: false,
    setStack(id: string, n: number) {
      this.spots.find((s) => s.id === id)!.stack = n;
    },
    refresh() {},
    step: () => false,
    deal() {
      this.round = new Round(shoe, this.spots.map((s) => ({ ...s, bet: 10 })), this.nextRig);
      this.nextRig = null;
    },
  };
  const lines: string[] = [];
  const out = (html: string) => void lines.push(html.replace(/<[^>]+>/g, ''));
  const run = async (line: string) => {
    const [name, ...args] = line.split(' ');
    lines.length = 0;
    assert.ok(await runBlackjack(name, args, out, { local: t as DevBlackjack }, null), `${name} is a blackjack command`);
    return lines.join('\n');
  };
  return { t, run };
}

const label = (s: string) => c(s).map(cardLabel).join(' ');

test('peek between rounds shows who each opening card goes to, rigged ones included', async () => {
  const { t, run } = practice();
  await run('rig me As Kd');
  await run('rig dealer 9c');
  const next = t.shoe.upcoming(16);
  const text = await run('peek');
  assert.match(text, new RegExp(`Fridge${label('As')}`));
  assert.match(text, /Dealer, face up/);
  assert.ok(text.includes(cardLabel(c('9c')[0])));
  // Ada's first card is the top of the shoe (unless it is one the rig takes out).
  assert.ok(text.includes(`Ada${cardLabel(next.find((x) => x !== c('As')[0] && x !== c('9c')[0])!)}`));
  t.deal();
  assert.deepEqual(t.round!.seats[0].hands[0].cards, c('As Kd'));
  assert.equal(t.round!.dealer[0], c('9c')[0]);
  assert.ok(t.round!.rigged);
});

test('peek during a round shows the hole card, the next card and the dealer run-out', async () => {
  const { t, run } = practice();
  t.nextRig = { seats: { p0: c('Th 6d'), b0: c('Ts 9s') }, dealer: c('6c Td') };
  t.deal();
  await run('rig next 5h 4s 3c');
  const text = await run('peek');
  assert.match(text, new RegExp(`hole card ${label('Td')}`));
  assert.match(text, new RegExp(`Next card ${label('5h')} goes to Fridge`));
  assert.match(text, new RegExp(`draw ${label('5h')} and end on 21`));
  await run('hole 7c');
  assert.equal(t.round!.dealer[1], c('7c')[0]);
  assert.match(await run('state'), /Dealer.*13/);
  assert.match(await run('stack ada +100'), /400 → 500/);
});

test('poker-only commands say so at a blackjack table, and the rest fall through', async () => {
  const { t } = practice();
  await assert.rejects(runBlackjack('board', [], () => {}, { local: t as DevBlackjack }, null), /for poker tables/);
  assert.equal(await runBlackjack('players', [], () => {}, { local: t as DevBlackjack }, null), false);
});
