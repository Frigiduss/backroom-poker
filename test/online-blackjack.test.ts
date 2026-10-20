import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCards } from '../src/engine/cards';
import { Round, Shoe, bookPlay, handTotal } from '../src/engine/blackjack';
import { createRng } from '../src/engine/cards';
import { BJ_BET_MS } from '../src/online/blackjack';
import { AdminTableInfo, BjMove, TableView } from '../src/online/protocol';
import { TURN_MS, handle } from '../src/online/server';
import { MemoryDb } from './memory-db';

const c = parseCards;

function setup() {
  const db = new MemoryDb();
  let clock = 1_000_000;
  const opts = { now: () => clock, seed: () => 777 };
  const call = async (user: string, req: Record<string, unknown>) => {
    const out = await handle(db, user, req, opts);
    return out as { status: number; body: { ok: boolean; error?: string; tableId: string; code: string; view: TableView; message: string; table: AdminTableInfo | null } };
  };
  return { db, call, advance: (ms: number) => (clock += ms) };
}

type S = ReturnType<typeof setup>;

/** Alice and Bob at a blackjack table with one bot, betting open on the first round. */
async function table(s: S, bots = 1) {
  const made = await s.call('alice', { op: 'create', name: 'Alice', playerId: 'pa', settings: { game: 'blackjack', bjLimits: 'low', bots } });
  assert.equal(made.status, 200, made.body.error);
  await s.call('bob', { op: 'join', code: made.body.code, name: 'Bob', playerId: 'pb' });
  const started = await s.call('alice', { op: 'start', tableId: made.body.tableId });
  assert.equal(started.status, 200, started.body.error);
  return made.body.tableId;
}

const view = (s: S, id: string, user: string) => s.db.view(id, user).bj!;

const move = (s: S, id: string, user: string, m: BjMove, amount?: number) =>
  s.call(user, { op: 'bj', tableId: id, round: view(s, id, user).roundNumber, move: m, amount });

/** Plays whoever is up: people bet the minimum and play the book; the server does bots, the dealer and clocks. */
async function drive(s: S, id: string, people: string[], steps: number) {
  for (let i = 0; i < steps; i++) {
    const row = (await s.db.byId(id))!;
    const bj = row.state.bj!;
    const v = (u: string) => view(s, id, u);
    const bettor = bj.phase === 'betting' ? people.find((u) => { const x = v(u); const me = x.spots.find((p) => p.you); return me && me.bet === null && !me.sittingOut && me.stack >= x.min; }) : undefined;
    const player = people.find((u) => v(u).legal || v(u).insuranceCost !== null);
    if (bettor) assert.equal((await move(s, id, bettor, 'bet', v(bettor).min)).status, 200);
    else if (player) {
      const x = v(player);
      if (x.insuranceCost !== null) await move(s, id, player, 'noinsure');
      else {
        const r = Round.load(new Shoe(6, createRng(1)), (await s.db.byId(id))!.state.bj!.round!);
        assert.equal((await move(s, id, player, bookPlay(r)!)).status, 200);
      }
    } else {
      s.advance(5000);
      await s.call(people[0], { op: 'tick', tableId: id, version: row.version });
    }
  }
}

test('friends sit at a blackjack table with bots, and nobody sees the hole card', async () => {
  const s = setup();
  const id = await table(s);
  const v = s.db.view(id, 'bob');
  assert.equal(v.phase, 'playing');
  assert.equal(v.hand, null);
  assert.equal(v.bj!.phase, 'betting');
  assert.equal(v.bj!.spots.length, 3);
  assert.equal(v.bj!.spots.filter((x) => x.isHuman).length, 2);
  assert.equal(v.bj!.min, 10);
  assert.equal(v.bj!.spots[0].stack, 1000);
  assert.equal((await move(s, id, 'alice', 'bet', 5)).status, 409, 'under the minimum');
  assert.equal((await move(s, id, 'alice', 'bet', 50)).status, 200);
  assert.equal(view(s, id, 'bob').phase, 'betting', 'waits for Bob');
  assert.equal((await move(s, id, 'bob', 'bet', 20)).status, 200);
  const r = view(s, id, 'bob');
  assert.equal(r.phase, 'round', 'everyone bet, so the round is dealt');
  assert.equal(r.round!.seats.length, 3);
  if (!r.round!.holeShown) assert.equal(r.round!.dealer[1], null, 'the hole card stays on the server');
});

test('rounds play through with people, bots and the dealer, and chips add up', async () => {
  const s = setup();
  const id = await table(s, 2);
  await drive(s, id, ['alice', 'bob'], 400);
  const bj = (await s.db.byId(id))!.state.bj!;
  assert.ok(bj.roundNumber >= 10, `played ${bj.roundNumber} rounds`);
  const awarded = s.db.awarded.get('alice/pa') ?? {};
  assert.ok((awarded['bj.hands'] ?? 0) >= 8, 'blackjack hands count toward achievements');
  assert.equal(awarded['online.games'], 1);
});

test('betting closes on the clock, and the people who did not bet sit the round out', async () => {
  const s = setup();
  const id = await table(s, 0);
  await move(s, id, 'alice', 'bet', 10);
  const row = (await s.db.byId(id))!;
  s.advance(BJ_BET_MS - 1);
  await s.call('alice', { op: 'tick', tableId: id, version: row.version });
  assert.equal(view(s, id, 'alice').phase, 'betting', 'still open');
  s.advance(2);
  await s.call('alice', { op: 'tick', tableId: id, version: row.version });
  const v = view(s, id, 'alice');
  assert.equal(v.phase, 'round');
  assert.equal(v.round!.seats.length, 1, 'only Alice is dealt in');
});

test('a person whose clock runs out stands, and a bot plays them once they are away', async () => {
  const s = setup();
  const id = await table(s, 0);
  for (let n = 0; n < 6; n++) {
    const bj = (await s.db.byId(id))!.state.bj!;
    if (bj.phase === 'betting') {
      await move(s, id, 'alice', 'bet', 10);
      await move(s, id, 'bob', 'sitout');
    }
    const row = (await s.db.byId(id))!;
    s.advance(TURN_MS);
    await s.call('bob', { op: 'tick', tableId: id, version: row.version });
  }
  const st = (await s.db.byId(id))!.state;
  const alice = st.members.find((m) => m.userId === 'alice')!.seat!;
  assert.ok(st.away[alice] || st.bj!.roundNumber > 1, 'the table never stalls on Alice');
});

test('a late arrival takes a bot spot at the next round', async () => {
  const s = setup();
  const id = await table(s, 2);
  const code = (await s.db.byId(id))!.code;
  const j = await s.call('cara', { op: 'join', code, name: 'Cara' });
  assert.equal(j.status, 200, j.body.error);
  assert.ok(j.body.view.waitingForSeat);
  await drive(s, id, ['alice', 'bob'], 60);
  const v = s.db.view(id, 'cara');
  assert.ok(v.mySeat, 'Cara is seated');
  assert.equal(v.bj!.spots.filter((x) => x.isHuman).length, 3);
});

test('only admins use the console on a blackjack table, and they see every card', async () => {
  const s = setup();
  const id = await table(s);
  const code = (await s.db.byId(id))!.code;
  assert.equal((await s.call('bob', { op: 'admin', code, command: { do: 'inspect' } })).status, 403);
  s.db.admins.add('fridge');
  await move(s, id, 'alice', 'bet', 10);
  await move(s, id, 'bob', 'bet', 10);
  const r = await s.call('fridge', { op: 'admin', code, command: { do: 'inspect' } });
  assert.equal(r.status, 200, r.body.error);
  const bj = r.body.table!.bj!;
  assert.equal(bj.round!.dealer.length, 2, 'the hole card is there');
  assert.ok(bj.round!.dealer.every((x) => typeof x === 'number'));
  assert.equal(bj.upcoming.length, 16);
  assert.ok(!/upcoming/.test(JSON.stringify(s.db.view(id, 'bob'))));
});

test('an admin can rig the next round, stack the shoe and swap the hole card, and rigged rounds earn nothing', async () => {
  const s = setup();
  const id = await table(s, 0);
  const code = (await s.db.byId(id))!.code;
  s.db.admins.add('fridge');
  const admin = (command: Record<string, unknown>) => s.call('fridge', { op: 'admin', code, command });
  assert.equal((await admin({ do: 'rig', seat: 'Alice', cards: c('Th Td') })).status, 200);
  assert.equal((await admin({ do: 'rig', seat: 'Bob', cards: c('9h 8h') })).status, 200);
  assert.equal((await admin({ do: 'rig', seat: 'dealer', cards: c('9s 7c') })).status, 200);
  assert.equal((await admin({ do: 'stackshoe', cards: c('5h 4d') })).status, 200);
  const before = s.db.awarded.get('alice/pa')?.['bj.hands'] ?? 0;
  await move(s, id, 'alice', 'bet', 10);
  await move(s, id, 'bob', 'bet', 10);
  const info = (await admin({ do: 'inspect' })).body.table!.bj!;
  const st = (await s.db.byId(id))!.state;
  const aliceSeat = info.inRound.indexOf(st.members.find((m) => m.userId === 'alice')!.seat!);
  assert.deepEqual(info.round!.seats[aliceSeat].hands[0].cards, c('Th Td'));
  assert.deepEqual(info.round!.dealer, c('9s 7c'));
  assert.deepEqual(info.upcoming.slice(0, 2), c('5h 4d'), 'the stacked cards come next');
  const h = await admin({ do: 'hole', card: c('Ks')[0] });
  assert.equal(h.status, 200, h.body.error);
  assert.deepEqual(h.body.table!.bj!.round!.dealer, c('9s Ks'));
  assert.equal(h.body.table!.bj!.upcoming.length, 16);
  // Play it out: everyone stands.
  for (let i = 0; i < 20; i++) {
    const p = ['alice', 'bob'].find((u) => view(s, id, u).legal);
    if (p) await move(s, id, p, 'stand');
    else {
      const row = (await s.db.byId(id))!;
      if (row.state.bj!.round!.phase === 'done') break;
      s.advance(1000);
      await s.call('alice', { op: 'tick', tableId: id, version: row.version });
    }
  }
  const done = (await s.db.byId(id))!.state.bj!.round!;
  assert.equal(done.phase, 'done');
  assert.equal(handTotal(done.dealer).total, 19);
  assert.equal(s.db.awarded.get('alice/pa')?.['bj.hands'] ?? 0, before, 'a rigged round earns no achievements');
  assert.equal((await admin({ do: 'stack', seat: 'bob', amount: 5000 })).body.table!.bj!.spots.find((x) => x.name === 'Bob')!.stack, 5000);
  assert.equal((await admin({ do: 'board', cards: [] })).status, 400, 'poker-only commands are refused');
});

test('pause stops a blackjack table, step moves it on, and kick hands the spot to a bot', async () => {
  const s = setup();
  const id = await table(s, 1);
  const code = (await s.db.byId(id))!.code;
  s.db.admins.add('fridge');
  const admin = (command: Record<string, unknown>) => s.call('fridge', { op: 'admin', code, command });
  await move(s, id, 'alice', 'bet', 10);
  await admin({ do: 'pause' });
  assert.equal((await move(s, id, 'bob', 'bet', 10)).status, 409, 'no bets while paused');
  const row = (await s.db.byId(id))!;
  s.advance(BJ_BET_MS * 2);
  await s.call('alice', { op: 'tick', tableId: id, version: row.version });
  assert.equal(view(s, id, 'alice').phase, 'betting', 'nothing moves while paused');
  const st = await admin({ do: 'step' });
  assert.equal(st.status, 200, st.body.error);
  assert.equal(view(s, id, 'alice').phase, 'round', 'step deals the round');
  const away = (await s.db.byId(id))!.state;
  const bob = away.members.find((m) => m.userId === 'bob')!.seat!;
  assert.ok(!away.away[bob], 'step does not count against Bob');
  await admin({ do: 'resume' });
  const k = await admin({ do: 'kick', member: 'Bob' });
  assert.equal(k.status, 200, k.body.error);
  assert.ok((await s.db.byId(id))!.state.away[bob]);
});

test('a shoe and a round save to plain data and pick up exactly where they were', () => {
  const shoe = new Shoe(6, createRng(5));
  const r = new Round(shoe, [{ id: 'a', name: 'A', stack: 1000, bet: 100 }, { id: 'b', name: 'B', stack: 1000, bet: 100 }]);
  while (r.insuranceTurn() >= 0) r.insure(r.insuranceTurn(), false);
  const shoe2 = Shoe.load(JSON.parse(JSON.stringify(shoe.save())));
  const r2 = Round.load(shoe2, JSON.parse(JSON.stringify(r.save())));
  while (r.phase === 'play') {
    const a = bookPlay(r)!;
    r.act(a);
    r2.act(a);
  }
  r.finish();
  r2.finish();
  assert.deepEqual(r2.save(), r.save());
  assert.deepEqual(shoe2.upcoming(10), shoe.upcoming(10));
  assert.equal(r2.view().dealer.length, r.dealer.length);
});

test('stacking the shoe moves real cards to the top, and the hole card can be swapped until the peek', () => {
  const shoe = new Shoe(1, createRng(3));
  shoe.stackTop(c('As Ks'));
  assert.equal(shoe.remaining, 52, 'nothing added: those cards moved');
  assert.deepEqual(shoe.upcoming(2), c('As Ks'));
  // 1 seat: A to the player, K up for the dealer; then 7 and 9 from the stack.
  shoe.stackTop(c('As Ks 7h 9d'));
  const r = new Round(shoe, [{ id: 'a', name: 'A', stack: 1000, bet: 100 }]);
  assert.ok(r.rigged);
  assert.deepEqual(r.dealer, c('Ks 9d'));
  assert.throws(() => r.setHole(c('Ah')[0]), /already checked/);
  r.setHole(c('8c')[0]);
  assert.deepEqual(r.dealer, c('Ks 8c'));
  const fair = new Round(new Shoe(6, createRng(4)), [{ id: 'a', name: 'A', stack: 1000, bet: 100 }]);
  assert.equal(fair.rigged, false);
});
