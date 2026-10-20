import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Action } from '../src/engine/hand';
import { VARIANTS, VARIANT_ORDER } from '../src/engine/variants';
import { AdminTableInfo, TableSettings, TableView } from '../src/online/protocol';
import { parseCards } from '../src/engine/cards';
import { AwardCredit, BOT_GAP_MS, DEAL_DELAY_MS, StoredView, TURN_MS, TableDb, TableRow, TableState, handle, rebuild } from '../src/online/server';
import { Counters } from '../src/accounts/achievements';

/** Keeps tables in memory, with the same compare-and-save rule as the real database. */
class MemoryDb implements TableDb {
  rows = new Map<string, TableRow>();
  views = new Map<string, StoredView>();
  private n = 0;
  async byId(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }
  async byCode(code: string) {
    const r = [...this.rows.values()].find((x) => x.code === code);
    return r ? structuredClone(r) : null;
  }
  async insert(code: string, state: TableState) {
    if ([...this.rows.values()].some((x) => x.code === code)) return null;
    const row = { id: `00000000-0000-0000-0000-${String(++this.n).padStart(12, '0')}`, code, version: 0, state: structuredClone(state) };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }
  async update(id: string, version: number, state: TableState) {
    const r = this.rows.get(id);
    if (!r || r.version !== version) return false;
    this.rows.set(id, { ...r, version: version + 1, state: structuredClone(state) });
    return true;
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async putViews(tableId: string, views: StoredView[]) {
    for (const v of views) {
      const k = `${tableId}/${v.userId}`;
      const old = this.views.get(k);
      if (!old || old.version < v.version) this.views.set(k, structuredClone(v));
    }
  }
  async dropView(tableId: string, userId: string) {
    this.views.delete(`${tableId}/${userId}`);
  }
  async sweep() {}
  /** Online achievement counters by `${userId}/${playerId}`, kept like the credit_awards function does. */
  awarded = new Map<string, Counters>();
  /** Each player's own saved counters, as the players table would hold them. */
  profiles = new Map<string, Counters>();
  async awards(userId: string, playerId: string) {
    const k = `${userId}/${playerId}`;
    return { server: { ...(this.awarded.get(k) ?? {}) }, profile: { ...(this.profiles.get(k) ?? {}) } };
  }
  async creditAwards(credits: AwardCredit[]) {
    for (const c of credits) {
      const k = `${c.userId}/${c.playerId}`;
      const cur = this.awarded.get(k) ?? {};
      for (const [key, v] of Object.entries(c.tally.sum)) cur[key] = (cur[key] ?? 0) + v;
      for (const [key, v] of Object.entries(c.tally.max)) cur[key] = Math.max(cur[key] ?? 0, v);
      this.awarded.set(k, cur);
    }
  }
  admins = new Set<string>();
  adminLog: { userId: string; action: string }[] = [];
  async isAdmin(userId: string) {
    return this.admins.has(userId);
  }
  async recent(limit: number) {
    return [...this.rows.values()].slice(0, limit).map((r) => ({ ...structuredClone(r), updatedAt: '2026-10-20T00:00:00Z' }));
  }
  async logAdmin(userId: string, action: string) {
    this.adminLog.push({ userId, action });
  }
  view(tableId: string, userId: string): TableView {
    return this.views.get(`${tableId}/${userId}`)!.view;
  }
}

const SETTINGS: TableSettings = { variant: 'holdem', structure: 'NL', format: 'cash', difficulty: 'easy', stackBB: 100, blindSpeed: 'normal', seats: 4 };

function setup(settings: Partial<TableSettings> = {}) {
  const db = new MemoryDb();
  let clock = 1_000_000;
  const opts = { now: () => clock, seed: () => 12345 };
  const call = async (user: string, req: unknown) => {
    const out = await handle(db, user, req, opts);
    return out as { status: number; body: { ok: boolean; error?: string; tableId: string; code: string; view: TableView } };
  };
  return { db, call, advance: (ms: number) => (clock += ms), now: () => clock, settings: { ...SETTINGS, ...settings } };
}

/** Plays whoever is up: people check or call, the server handles bots and the clock. */
async function drive(s: ReturnType<typeof setup>, tableId: string, people: string[], steps: number) {
  for (let i = 0; i < steps; i++) {
    const row = (await s.db.byId(tableId))!;
    if (row.state.phase !== 'playing') return;
    const turn = people.find((u) => s.db.view(tableId, u).legal);
    if (turn) {
      const mine = s.db.view(tableId, turn);
      const L = mine.legal!;
      const action: Action = L.kind === 'draw' ? { type: 'draw', discard: [] } : L.kind === 'bet' && L.check ? { type: 'check' } : { type: 'call' };
      const r = await s.call(turn, { op: 'act', tableId, hand: mine.handNumber, action });
      assert.equal(r.status, 200, r.body.error);
    } else {
      s.advance(Math.max(BOT_GAP_MS, DEAL_DELAY_MS));
      await s.call(people[0] ?? 'alice', { op: 'tick', tableId, version: row.version });
    }
  }
}

test('friends make a table, join by code, and bots fill the empty seats', async () => {
  const s = setup();
  const made = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings });
  assert.equal(made.status, 200);
  assert.match(made.body.code, /^[A-Z2-9]{5}$/);
  const joined = await s.call('bob', { op: 'join', code: made.body.code.toLowerCase(), name: 'Bob' });
  assert.equal(joined.status, 200);
  assert.deepEqual(joined.body.view.members.map((m) => m.name), ['Alice', 'Bob']);
  assert.equal((await s.call('bob', { op: 'start', tableId: made.body.tableId })).status, 403, 'only the host starts');

  const started = await s.call('alice', { op: 'start', tableId: made.body.tableId });
  assert.equal(started.status, 200);
  const v = started.body.view;
  assert.equal(v.phase, 'playing');
  assert.equal(v.seats.length, 4);
  assert.equal(v.seats.filter((x) => x.isHuman).length, 2);
  assert.equal(v.seats.filter((x) => !x.isHuman && x.difficulty === 'easy').length, 2);
  assert.ok(v.hand, 'the first hand is dealt');
  assert.ok(s.db.view(made.body.tableId, 'bob').mySeat, 'Bob has a seat');
});

test("nobody's view shows another player's hole cards or the deck", async () => {
  const s = setup();
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob' });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  for (const user of ['alice', 'bob']) {
    const v = s.db.view(body.tableId, user);
    v.hand!.players.forEach((p) => {
      const mine = p.id === v.mySeat;
      assert.equal(p.cards.length, 2);
      assert.equal(p.cards.every((c) => c !== null), mine, `${user} sees ${mine ? 'own' : 'no other'} cards`);
    });
    const text = JSON.stringify(v);
    assert.ok(!/deck|seed|checkpoint|rng/i.test(text), 'no secret state in the view');
  }
});

test('only the player to act can move, and the server deals and plays bots', async () => {
  const s = setup();
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob' });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  const waiting = ['alice', 'bob'].find((u) => !s.db.view(body.tableId, u).legal)!;
  const r = await s.call(waiting, { op: 'act', tableId: body.tableId, hand: 1, action: { type: 'fold' } });
  assert.equal(r.status, 409);

  await drive(s, body.tableId, ['alice', 'bob'], 400);
  const row = (await s.db.byId(body.tableId))!;
  const t = rebuild(row.state);
  assert.ok(t.handNumber >= 5, `several hands were played (got ${t.handNumber})`);
  const total = t.seats.reduce((n, x) => n + x.stack, 0) + (t.hand && !t.hand.isComplete ? t.hand.pot : 0);
  assert.ok(total > 0);
  assert.ok(row.state.events.length < 200, 'saved actions reset every hand');
});

test('a player who lets the clock run out twice is played by a bot until they come back', async () => {
  const s = setup({ seats: 2, format: 'headsup' });
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings });
  const id = body.tableId;
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob' });
  await s.call('alice', { op: 'start', tableId: id });
  const version = async () => (await s.db.byId(id))!.version;
  /** Bob plays along; the server deals; stops when it is Alice's turn. */
  const untilAlice = async () => {
    for (let i = 0; i < 40 && !s.db.view(id, 'alice').legal; i++) {
      const bob = s.db.view(id, 'bob');
      if (bob.legal) await s.call('bob', { op: 'act', tableId: id, hand: bob.handNumber, action: bob.legal.kind === 'bet' && bob.legal.check ? { type: 'check' } : { type: 'call' } });
      else {
        s.advance(DEAL_DELAY_MS);
        await s.call('bob', { op: 'tick', tableId: id, version: await version() });
      }
    }
    assert.ok(s.db.view(id, 'alice').legal, "Alice's turn came round");
  };
  for (let round = 0; round < 2; round++) {
    await untilAlice();
    const v = await version();
    const early = await s.call('bob', { op: 'tick', tableId: id, version: v });
    assert.equal(early.body.view.version, v, 'too early to time out');
    s.advance(TURN_MS + 1);
    await s.call('bob', { op: 'tick', tableId: id, version: v });
    assert.equal(await version(), v + 1, 'the clock ran out');
  }
  const mine = s.db.view(id, 'alice');
  assert.ok(mine.seats.find((x) => x.you)!.away, 'a bot took over');
  await s.call('alice', { op: 'back', tableId: id });
  assert.ok(!s.db.view(id, 'alice').seats.find((x) => x.you)!.away);
});

test('a stale tick does nothing, so two browsers ticking at once move the table once', async () => {
  const s = setup();
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: { ...s.settings, seats: 3 } });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  // Alice plays alone against two bots; find a bot's turn.
  for (let i = 0; i < 50 && s.db.view(body.tableId, 'alice').legal; i++) {
    const v = s.db.view(body.tableId, 'alice');
    await s.call('alice', { op: 'act', tableId: body.tableId, hand: v.handNumber, action: v.legal!.kind === 'bet' && v.legal!.check ? { type: 'check' } : { type: 'call' } });
  }
  const row = (await s.db.byId(body.tableId))!;
  s.advance(DEAL_DELAY_MS);
  const [a, b] = await Promise.all([
    s.call('alice', { op: 'tick', tableId: body.tableId, version: row.version }),
    s.call('alice', { op: 'tick', tableId: body.tableId, version: row.version }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await s.db.byId(body.tableId))!.version, row.version + 1);
});

test('late arrivals take a bot seat in a cash game at the next deal', async () => {
  const s = setup();
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  const j = await s.call('cara', { op: 'join', code: body.code, name: 'Cara' });
  assert.equal(j.status, 200);
  assert.ok(j.body.view.waitingForSeat);
  await drive(s, body.tableId, ['alice'], 200);
  const v = s.db.view(body.tableId, 'cara');
  assert.ok(v.mySeat, 'Cara got a seat');
  assert.equal(v.seats.find((x) => x.you)!.name, 'Cara');
  assert.equal(v.seats.filter((x) => x.isHuman).length, 2);
});

test('tournaments refuse late joiners and leaving hands the seat to a bot', async () => {
  const s = setup({ format: 'sng' });
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob' });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  assert.equal((await s.call('cara', { op: 'join', code: body.code, name: 'Cara' })).status, 409);
  await s.call('bob', { op: 'leave', tableId: body.tableId });
  assert.ok(s.db.view(body.tableId, 'alice').seats.find((x) => x.name === 'Bob')!.away);
  await drive(s, body.tableId, ['alice'], 3000);
  const row = (await s.db.byId(body.tableId))!;
  assert.equal(row.state.phase, 'over', 'the tournament plays to the end');
  const v = s.db.view(body.tableId, 'alice');
  assert.equal(v.seats.filter((x) => x.place === 1).length, 1);
});

test('bad requests get a plain answer', async () => {
  const s = setup();
  assert.equal((await s.call('alice', { op: 'join', code: 'NOPE1', name: 'A' })).status, 404);
  assert.equal((await s.call('alice', { op: 'create', name: 'A', settings: { variant: 'chess' } })).status, 400);
  const { body } = await s.call('alice', { op: 'create', name: 'A', settings: s.settings });
  assert.equal((await s.call('mallory', { op: 'start', tableId: body.tableId })).status, 403);
  await s.call('alice', { op: 'start', tableId: body.tableId });
  const v = s.db.view(body.tableId, 'alice');
  if (v.legal) {
    const r = await s.call('alice', { op: 'act', tableId: body.tableId, hand: v.handNumber, action: { type: 'raise', to: 'lots' } });
    assert.equal(r.status, 400);
  }
});

test('every game replays exactly from its saved state', async () => {
  for (const variant of VARIANT_ORDER) {
    const s = setup({ variant, seats: Math.min(4, VARIANTS[variant].maxPlayers), difficulty: 'beginner' });
    const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings });
    await s.call('alice', { op: 'start', tableId: body.tableId });
    await s.call('alice', { op: 'leave', tableId: body.tableId });
    for (let i = 0; i < 150; i++) {
      const row = (await s.db.byId(body.tableId))!;
      s.advance(DEAL_DELAY_MS);
      const r = await s.call('alice', { op: 'tick', tableId: body.tableId, version: row.version });
      assert.equal(r.status, 200, `${variant}: ${r.body.error}`);
    }
    const t = rebuild((await s.db.byId(body.tableId))!.state);
    assert.ok(t.handNumber >= 3, `${variant} played some hands`);
  }
});

test('the server credits online achievements to the player each person sat down as', async () => {
  const s = setup({ seats: 4 });
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings, playerId: 'pr_alice' });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob', playerId: 'pr_bob' });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  await drive(s, body.tableId, ['alice', 'bob'], 300);
  const alice = s.db.awarded.get('alice/pr_alice')!;
  const bob = s.db.awarded.get('bob/pr_bob')!;
  const t = rebuild((await s.db.byId(body.tableId))!.state);
  assert.equal(alice['online.games'], 1);
  assert.equal(alice['online.hosted'], 1, 'Alice hosted');
  assert.equal(bob['online.hosted'], undefined);
  const v = s.db.view(body.tableId, 'alice');
  const played = (name: string) => t.stats[v.seats.find((x) => x.name === name)!.id].hands;
  assert.ok(played('Alice') > 0);
  assert.equal(alice['online.hands'], played('Alice'), 'every finished hand Alice played counted');
  assert.equal(alice.hands, played('Alice'), 'online hands count toward the career total too');
  assert.equal(bob['online.hands'], played('Bob'));
});

test('hands a bot plays for an away player earn them nothing', async () => {
  const s = setup({ seats: 3 });
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings, playerId: 'pr_alice' });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob', playerId: 'pr_bob' });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  await s.call('bob', { op: 'leave', tableId: body.tableId });
  await drive(s, body.tableId, ['alice'], 300);
  assert.ok((s.db.awarded.get('alice/pr_alice')?.['online.hands'] ?? 0) > 0);
  assert.equal(s.db.awarded.get('bob/pr_bob')?.['online.hands'] ?? 0, 0);
});

test('a tournament winner with a friend at the table gets the online champion achievements', async () => {
  const s = setup({ seats: 2, format: 'headsup', stackBB: 50 });
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings, playerId: 'pr_alice' });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob', playerId: 'pr_bob' });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  // Alice shoves every hand and Bob calls, so someone is soon out.
  for (let i = 0; i < 400 && (await s.db.byId(body.tableId))!.state.phase === 'playing'; i++) {
    const row = (await s.db.byId(body.tableId))!;
    const turn = ['alice', 'bob'].find((u) => s.db.view(body.tableId, u).legal);
    if (!turn) {
      s.advance(DEAL_DELAY_MS);
      await s.call('alice', { op: 'tick', tableId: body.tableId, version: row.version });
      continue;
    }
    const v = s.db.view(body.tableId, turn);
    const L = v.legal!;
    const action: Action = L.kind === 'bet' && turn === 'alice' && L.raise ? { type: 'raise', to: L.maxRaiseTo } : L.kind === 'bet' && L.call ? { type: 'call' } : L.kind === 'bet' && L.check ? { type: 'check' } : { type: 'fold' };
    await s.call(turn, { op: 'act', tableId: body.tableId, hand: v.handNumber, action });
  }
  const v = s.db.view(body.tableId, 'alice');
  assert.equal(v.phase, 'over');
  const winner = v.seats.find((x) => x.place === 1)!.name === 'Alice' ? 'alice/pr_alice' : 'bob/pr_bob';
  const loser = winner === 'alice/pr_alice' ? 'bob/pr_bob' : 'alice/pr_alice';
  assert.equal(s.db.awarded.get(winner)!['online.tourneyWins'], 1);
  assert.equal(s.db.awarded.get(winner)!['online.friendTourneyWins'], 1);
  assert.equal(s.db.awarded.get(winner)!.huWins, 1);
  assert.equal(s.db.awarded.get(loser)!['online.tourneyWins'] ?? 0, 0);
});

test('people wear only titles they have earned, and everyone at the table sees them', async () => {
  const s = setup();
  s.db.profiles.set('alice/pr_alice', { hands: 1200 });
  // Bob's own save claims an online achievement, but only the server can credit those.
  s.db.profiles.set('bob/pr_bob', { 'online.games': 999 });
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings, playerId: 'pr_alice', title: 'hands-1000' });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob', playerId: 'pr_bob', title: 'online-250' });
  const lobby = s.db.view(body.tableId, 'bob');
  assert.deepEqual(lobby.members.map((m) => m.title), ['Grinder', null]);
  await s.call('alice', { op: 'start', tableId: body.tableId });
  const v = s.db.view(body.tableId, 'bob');
  assert.equal(v.seats.find((x) => x.name === 'Alice')!.title, 'Grinder');
  assert.equal(v.seats.find((x) => x.name === 'Bob')!.title, null);
  assert.ok(v.seats.filter((x) => !x.isHuman).every((x) => x.title === null));

  s.db.awarded.set('bob/pr_bob', { 'online.games': 250 });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob', playerId: 'pr_bob', title: 'online-250' });
  assert.equal(s.db.view(body.tableId, 'alice').seats.find((x) => x.name === 'Bob')!.title, 'Card Room Regular', 'earned for real, it shows');
});

test('a table keeps going when achievements cannot be saved', async () => {
  const s = setup({ seats: 3 });
  s.db.creditAwards = async () => {
    throw new Error('no player_awards table');
  };
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings, playerId: 'pr_alice' });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  await drive(s, body.tableId, ['alice'], 100);
  assert.ok(rebuild((await s.db.byId(body.tableId))!.state).handNumber >= 3);
});

// ---------- developer console at online tables ----------

const admin = async (s: ReturnType<typeof setup>, user: string, req: Record<string, unknown>) => {
  const out = await handle(s.db, user, req, { now: s.now, seed: () => 12345 });
  return out as { status: number; body: { ok: boolean; error?: string; message: string; table: AdminTableInfo | null; tables?: unknown[] } };
};

async function startedTable(s: ReturnType<typeof setup>) {
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob' });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  return body;
}

test('only admin accounts can use console commands on a table', async () => {
  const s = setup();
  const body = await startedTable(s);
  assert.equal((await admin(s, 'bob', { op: 'admin', code: body.code, command: { do: 'inspect' } })).status, 403);
  assert.equal((await admin(s, 'bob', { op: 'tables' })).status, 403);
  s.db.admins.add('fridge');
  const r = await admin(s, 'fridge', { op: 'admin', code: body.code, command: { do: 'inspect' } });
  assert.equal(r.status, 200, r.body.error);
  assert.ok(r.body.table!.hand!.players.every((p) => p.cards.length === 2), 'an admin sees every card');
  assert.equal(r.body.table!.hand!.upcoming.length, 16);
  assert.equal(((await admin(s, 'fridge', { op: 'tables' })).body.tables ?? []).length, 1);
  // Nobody else's view gains anything from the admin's look.
  assert.ok(!/upcoming/.test(JSON.stringify(s.db.view(body.tableId, 'bob'))));
});

test('an admin can rig the next hand, fix the board, set stacks and swap bots, and it all replays', async () => {
  const s = setup();
  s.db.admins.add('fridge');
  const body = await startedTable(s);
  const cmd = (command: Record<string, unknown>) => admin(s, 'fridge', { op: 'admin', tableId: body.tableId, command });
  const bobSeat = s.db.view(body.tableId, 'bob').mySeat!;
  let r = await cmd({ do: 'rig', seat: bobSeat, cards: parseCards('As Ad') });
  assert.equal(r.status, 200, r.body.error);
  const spare = (await cmd({ do: 'inspect' })).body.table!.hand!.upcoming.slice(-3);
  r = await cmd({ do: 'board', cards: spare });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual(r.body.table!.hand!.rigBoard, spare);
  assert.equal((await cmd({ do: 'rig', seat: 'alice', cards: parseCards('As 2c') })).status, 400, 'a card used twice is refused');
  const bot = r.body.table!.seats.find((x) => !x.isHuman)!;
  r = await cmd({ do: 'bot', seat: bot.id, difficulty: 'expert', style: 'aggressive' });
  assert.equal(r.status, 200, r.body.error);
  r = await cmd({ do: 'stack', seat: 'bob', amount: 12345 });
  assert.equal(r.status, 200, r.body.error);

  // Finish this hand and deal the next one with the rig.
  for (let i = 0; i < 40 && (await admin(s, 'fridge', { op: 'admin', tableId: body.tableId, command: { do: 'inspect' } })).body.table!.handNumber < 2; i++) {
    const turn = ['alice', 'bob'].find((u) => s.db.view(body.tableId, u).legal);
    if (turn) await s.call(turn, { op: 'act', tableId: body.tableId, hand: s.db.view(body.tableId, turn).handNumber, action: { type: 'fold' } });
    else await cmd({ do: 'step' });
  }
  const info = (await cmd({ do: 'inspect' })).body.table!;
  assert.equal(info.handNumber, 2);
  assert.deepEqual(info.hand!.players.find((p) => p.seat === bobSeat)!.cards, parseCards('As Ad'));
  assert.equal(info.seats.find((x) => x.id === bot.id)!.difficulty, 'expert');
  assert.equal(info.nextRig, null, 'a rig is used once');
  assert.deepEqual(s.db.view(body.tableId, 'bob').hand!.players.find((p) => p.id === bobSeat)!.cards, parseCards('As Ad'));
  // Board rig on hand 2, mid-hand, then check it survives a reload.
  const later = info.hand!.upcoming.slice(-5);
  r = await cmd({ do: 'board', cards: later });
  assert.equal(r.status, 200, r.body.error);
  const t = rebuild((await s.db.byId(body.tableId))!.state);
  assert.deepEqual(t.hand!.rigged.board, later);
  assert.ok(s.db.adminLog.length >= 5);
});

test('pausing stops the table, step moves it one bot at a time, kick and close work', async () => {
  const s = setup({ seats: 4 });
  s.db.admins.add('fridge');
  const body = await startedTable(s);
  const cmd = (command: Record<string, unknown>) => admin(s, 'fridge', { op: 'admin', tableId: body.tableId, command });
  assert.equal((await cmd({ do: 'pause' })).status, 200);
  assert.equal(s.db.view(body.tableId, 'alice').paused, true);
  assert.equal(s.db.view(body.tableId, 'alice').tickAt, null);
  const before = (await s.db.byId(body.tableId))!.version;
  s.advance(60_000);
  await s.call('alice', { op: 'tick', tableId: body.tableId, version: before });
  assert.equal((await s.db.byId(body.tableId))!.version, before, 'nothing moves while paused');
  const turn = ['alice', 'bob'].find((u) => s.db.view(body.tableId, u).legal);
  if (turn) assert.equal((await s.call(turn, { op: 'act', tableId: body.tableId, hand: 1, action: { type: 'fold' } })).status, 409);
  else assert.equal((await cmd({ do: 'step' })).status, 200);
  assert.equal((await cmd({ do: 'resume' })).status, 200);
  assert.equal(s.db.view(body.tableId, 'alice').paused, false);

  const k = await cmd({ do: 'kick', member: 'bo' });
  assert.equal(k.status, 200, k.body.error);
  assert.ok(k.body.table!.members.find((m) => m.name === 'Bob')!.left);
  const c = await cmd({ do: 'close' });
  assert.equal(c.status, 200);
  assert.equal(await s.db.byId(body.tableId), null);
});

test('a hand an admin rigged earns no achievements', async () => {
  const s = setup();
  s.db.admins.add('fridge');
  const { body } = await s.call('alice', { op: 'create', name: 'Alice', settings: s.settings, playerId: 'pr_alice' });
  await s.call('bob', { op: 'join', code: body.code, name: 'Bob', playerId: 'pr_bob' });
  await s.call('alice', { op: 'start', tableId: body.tableId });
  const spare = (await admin(s, 'fridge', { op: 'admin', tableId: body.tableId, command: { do: 'inspect' } })).body.table!.hand!.upcoming.slice(-3);
  assert.equal((await admin(s, 'fridge', { op: 'admin', tableId: body.tableId, command: { do: 'board', cards: spare } })).status, 200);
  for (let i = 0; i < 40 && rebuild((await s.db.byId(body.tableId))!.state).handNumber < 2; i++) {
    const turn = ['alice', 'bob'].find((u) => s.db.view(body.tableId, u).legal);
    const row = (await s.db.byId(body.tableId))!;
    if (turn) await s.call(turn, { op: 'act', tableId: body.tableId, hand: s.db.view(body.tableId, turn).handNumber, action: { type: 'fold' } });
    else {
      s.advance(DEAL_DELAY_MS);
      await s.call('alice', { op: 'tick', tableId: body.tableId, version: row.version });
    }
  }
  assert.equal(s.db.awarded.get('alice/pr_alice')?.['online.hands'] ?? 0, 0);
  assert.equal(s.db.awarded.get('alice/pr_alice')?.['online.games'], 1, 'the game itself still counts');
});
