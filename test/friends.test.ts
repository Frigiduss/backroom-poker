import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRIEND_CODE, FriendsNotSetUpError, MemoryStorage, OnlineAuth, addFriend, answerFriend, cleanFriendCode, dismissInvite, inviteFriend,
  parseFriends, removeFriend, seenText, syncFriends,
} from '../src/accounts';
import { FakeSupabase } from './fake-supabase';

const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };

async function people(fake: FakeSupabase, ...names: string[]) {
  const out: OnlineAuth[] = [];
  for (const name of names) {
    const auth = new OnlineAuth(config, new MemoryStorage(), fake.fetch);
    await auth.signUp(`${name.toLowerCase()}@x.test`, 'password1');
    fake.rows.push({ id: `p-${name}`, owner: auth.current!.userId, data: { name, color: '#3fa36b' }, updated_at: new Date().toISOString() });
    out.push(auth);
  }
  return out;
}

test('friend codes are tidied and checked', () => {
  assert.equal(cleanFriendCode(' kq3-7mz '), 'KQ37MZ');
  assert.ok(FRIEND_CODE.test('KQ37MZ'));
  assert.ok(!FRIEND_CODE.test('KQ07MZ'));
});

test('asking, accepting, inviting and removing', async () => {
  const fake = new FakeSupabase();
  const [ann, bo, cy] = await people(fake, 'Ann', 'Bo', 'Cy');
  const annCode = (await syncFriends(ann, fake.fetch)).code;
  const boCode = (await syncFriends(bo, fake.fetch)).code;
  assert.notEqual(annCode, boCode);

  assert.deepEqual(await addFriend(bo, annCode.toLowerCase(), fake.fetch), { status: 'requested', name: 'Ann' });
  let a = await syncFriends(ann, fake.fetch);
  assert.deepEqual(a.incoming.map((f) => f.name), ['Bo']);
  assert.deepEqual((await syncFriends(bo, fake.fetch)).outgoing.map((f) => f.name), ['Ann']);

  await answerFriend(ann, boCode, true, fake.fetch);
  a = await syncFriends(ann, fake.fetch);
  assert.deepEqual(a.friends.map((f) => [f.name, f.online]), [['Bo', true]]);
  assert.equal(a.incoming.length, 0);

  // Only a table you're at, and only a friend.
  await assert.rejects(inviteFriend(bo, annCode, 'TABLE', fake.fetch), /table you're at/);
  fake.seated.set('TABLE', { users: [bo.current!.userId], game: 'poker', variant: 'omaha', structure: 'PL' });
  await syncFriends(cy, fake.fetch);
  await assert.rejects(inviteFriend(cy, annCode, 'TABLE', fake.fetch), /only invite friends/);
  await inviteFriend(bo, annCode, 'TABLE', fake.fetch);
  a = await syncFriends(ann, fake.fetch);
  assert.deepEqual(a.invites.map((i) => [i.name, i.table, i.game]), [['Bo', 'TABLE', 'Pot-Limit Omaha']]);
  await dismissInvite(ann, boCode, fake.fetch);
  assert.equal((await syncFriends(ann, fake.fetch)).invites.length, 0);

  await removeFriend(ann, boCode, fake.fetch);
  assert.equal((await syncFriends(ann, fake.fetch)).friends.length, 0);
  assert.equal((await syncFriends(bo, fake.fetch)).friends.length, 0);
});

test('a turned-down request stays turned down', async () => {
  const fake = new FakeSupabase();
  const [ann, bo] = await people(fake, 'Ann', 'Bo');
  const annCode = (await syncFriends(ann, fake.fetch)).code;
  const boCode = (await syncFriends(bo, fake.fetch)).code;
  await addFriend(bo, annCode, fake.fetch);
  await answerFriend(ann, boCode, false, fake.fetch);
  assert.equal((await syncFriends(ann, fake.fetch)).incoming.length, 0);
  assert.equal((await syncFriends(bo, fake.fetch)).outgoing.length, 1);
  await removeFriend(bo, annCode, fake.fetch);
  assert.equal((await syncFriends(bo, fake.fetch)).outgoing.length, 0);
  await addFriend(bo, annCode, fake.fetch);
  assert.equal((await syncFriends(ann, fake.fetch)).incoming.length, 0);
  // Ann can still change her mind.
  assert.equal((await addFriend(ann, boCode, fake.fetch)).status, 'friends');
});

test('mistakes come back as sentences', async () => {
  const fake = new FakeSupabase();
  const [ann] = await people(fake, 'Ann');
  const code = (await syncFriends(ann, fake.fetch)).code;
  await assert.rejects(addFriend(ann, code, fake.fetch), /your own friend code/);
  await assert.rejects(addFriend(ann, 'ZZZZZZ', fake.fetch), /No player has the friend code ZZZZZZ/);
  fake.friendAccounts = null;
  await assert.rejects(syncFriends(ann, fake.fetch), FriendsNotSetUpError);
});

test('odd server values are cleaned up', () => {
  const s = parseFriends({
    code: 'kq37mz',
    friends: [{ code: 'AAAAAA', name: 'A very long name indeed', color: 'red;background:url(x)', title: 5, online: 'yes', seen: 'x' }, null],
    incoming: 'nope',
    invites: [{ from: 'AAAAAA', name: 'A', table: 'ab<c>de', game: 'poker', variant: 'nope' }, { from: 'B', table: '' }],
  });
  assert.equal(s.code, 'KQ37MZ');
  assert.equal(s.friends.length, 1);
  assert.equal(s.friends[0].name, 'A very long na');
  assert.equal(s.friends[0].online, false);
  assert.equal(s.friends[0].title, null);
  assert.ok(/^#[0-9a-f]{6}$/i.test(s.friends[0].color));
  assert.deepEqual(s.incoming, []);
  assert.deepEqual(s.invites.map((i) => [i.table, i.game]), [['ABCDE', 'Poker']]);
});

test('last seen reads naturally', () => {
  const now = Date.UTC(2026, 9, 31, 12);
  assert.equal(seenText({ online: true, seen: now }, now), 'Online');
  assert.equal(seenText({ online: false, seen: now - 5 * 60_000 }, now), 'Seen 5m ago');
  assert.equal(seenText({ online: false, seen: now - 3 * 3_600_000 }, now), 'Seen 3h ago');
  assert.equal(seenText({ online: false, seen: now - 4 * 86_400_000 }, now), 'Seen 4d ago');
});
