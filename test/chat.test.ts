import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_BURST, CHAT_KEEP, CHAT_WINDOW_MS, cleanChat } from '../src/online/chat';
import { AdminTableInfo, TableView } from '../src/online/protocol';
import { handle } from '../src/online/server';
import { MemoryDb } from './memory-db';

function setup() {
  const db = new MemoryDb();
  let clock = 1_000_000;
  const opts = { now: () => clock, seed: () => 99 };
  const call = async (user: string, req: Record<string, unknown>) => {
    const out = await handle(db, user, req, opts);
    return out as { status: number; body: { ok: boolean; error?: string; tableId: string; code: string; view: TableView; message: string; table: AdminTableInfo | null } };
  };
  return { db, call, advance: (ms: number) => (clock += ms) };
}

type S = ReturnType<typeof setup>;

async function room(s: S, game: 'poker' | 'blackjack' = 'poker') {
  const settings = game === 'blackjack' ? { game, bjLimits: 'low', bots: 1 } : { variant: 'holdem', format: 'cash', seats: 4 };
  const made = await s.call('alice', { op: 'create', name: 'Alice', settings });
  assert.equal(made.status, 200, made.body.error);
  const joined = await s.call('bob', { op: 'join', code: made.body.code, name: 'Bob' });
  assert.equal(joined.status, 200, joined.body.error);
  return made.body.tableId;
}

const say = (s: S, user: string, tableId: string, msg: Record<string, unknown>) => s.call(user, { op: 'chat', tableId, ...msg });

test('chat lines and emotes reach everyone at the table, before and after the start', async () => {
  const s = setup();
  const id = await room(s);
  assert.equal((await say(s, 'bob', id, { text: '  hi   all ' })).status, 200);
  let alice = s.db.view(id, 'alice');
  assert.deepEqual(alice.chat?.map((l) => [l.name, l.text, l.you]), [['Bob', 'hi all', false]]);
  assert.equal(s.db.view(id, 'bob').chat![0].you, true);

  assert.equal((await s.call('alice', { op: 'start', tableId: id })).status, 200);
  s.advance(3000);
  const r = await say(s, 'alice', id, { emote: 'luck' });
  assert.equal(r.status, 200, r.body.error);
  alice = s.db.view(id, 'alice');
  const last = alice.chat!.at(-1)!;
  assert.equal(last.emote, 'luck');
  assert.equal(last.text, undefined);
  assert.equal(last.seat, alice.mySeat, 'the line knows where the speaker sits');
  assert.ok(last.id > alice.chat![0].id);
  // Chatting doesn't move the game along or reset anyone's clock.
  assert.equal(s.db.view(id, 'bob').handNumber, 1);
});

test('chat is checked: no blank lines, unknown emotes, long lines or people who left', async () => {
  const s = setup();
  const id = await room(s);
  assert.equal((await say(s, 'bob', id, { text: '   ' })).status, 400);
  assert.equal((await say(s, 'bob', id, { emote: 'nope' })).status, 400);
  assert.equal((await say(s, 'bob', id, { emote: 'toString' })).status, 400);
  assert.equal((await say(s, 'carol', id, { text: 'hi' })).status, 403);
  await say(s, 'bob', id, { text: 'x'.repeat(500) });
  assert.equal(s.db.view(id, 'alice').chat!.at(-1)!.text!.length, 140);
  assert.equal(cleanChat('a\u0000b‮\nc'), 'a b c');
});

test('chat keeps the latest lines and holds back anyone typing too fast', async () => {
  const s = setup();
  const id = await room(s);
  for (let i = 0; i < CHAT_BURST; i++) assert.equal((await say(s, 'bob', id, { text: `line ${i}` })).status, 200);
  const fast = await say(s, 'bob', id, { text: 'one more' });
  assert.equal(fast.status, 429);
  assert.match(fast.body.error!, /fast/);
  // Someone else can still talk.
  assert.equal((await say(s, 'alice', id, { text: 'calm down' })).status, 200);
  s.advance(CHAT_WINDOW_MS + 1);
  assert.equal((await say(s, 'bob', id, { text: 'sorry' })).status, 200);

  for (let i = 0; i < CHAT_KEEP; i++) {
    s.advance(CHAT_WINDOW_MS);
    await say(s, 'alice', id, { text: `spam ${i}` });
  }
  const chat = s.db.view(id, 'bob').chat!;
  assert.equal(chat.length, CHAT_KEEP);
  assert.equal(chat.at(-1)!.text, `spam ${CHAT_KEEP - 1}`);
});

test('admins can mute, unmute and clear chat from the console, at poker and blackjack', async () => {
  for (const game of ['poker', 'blackjack'] as const) {
    const s = setup();
    s.db.admins.add('fridge');
    const id = await room(s, game);
    await say(s, 'bob', id, { text: 'rude words' });
    const admin = (command: Record<string, unknown>) => s.call('fridge', { op: 'admin', tableId: id, command });

    assert.equal((await s.call('bob', { op: 'admin', tableId: id, command: { do: 'mute', member: 'Alice' } })).status, 403, 'players cannot mute');
    // Works in the waiting room too.
    const muted = await admin({ do: 'mute', member: 'bo' });
    assert.equal(muted.status, 200, muted.body.error);
    assert.deepEqual(muted.body.table!.muted, ['Bob']);
    assert.equal(s.db.view(id, 'bob').chatMuted, true);
    assert.equal(s.db.view(id, 'alice').chatMuted, false);
    assert.equal((await say(s, 'bob', id, { text: 'more' })).status, 403);

    assert.equal((await s.call('alice', { op: 'start', tableId: id })).status, 200);
    const cleared = await admin({ do: 'clearchat' });
    assert.equal(cleared.status, 200, cleared.body.error);
    const chat = s.db.view(id, 'alice').chat!;
    assert.equal(chat.length, 1);
    assert.equal(chat[0].system, true);

    assert.equal((await admin({ do: 'unmute', member: 'Bob' })).status, 200);
    assert.equal((await say(s, 'bob', id, { text: 'sorry' })).status, 200);
    assert.equal((await admin({ do: 'mute', member: 'Zed' })).status, 400);
    const info = (await admin({ do: 'inspect' })).body.table!;
    assert.deepEqual(info.chat!.map((l) => l.text), ['The table admin cleared the chat.', 'sorry']);
  }
});
