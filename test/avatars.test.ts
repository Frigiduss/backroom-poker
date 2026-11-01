import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdminApi, AvatarsNotSetUpError, FACES, MemoryStorage, OnlineAuth, avatarLook, cleanAvatar, clearOldPictures, createProfile, listPictures, normalizeProfile,
  pictureKey, pictureUrl, uploadPicture, deletePicture,
} from '../src/accounts';
import { FakeSupabase } from './fake-supabase';

const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };
const jpeg = (bytes = 5000) => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });

async function signedIn(fake: FakeSupabase, email: string) {
  const auth = new OnlineAuth(config, new MemoryStorage(), fake.fetch);
  await auth.signUp(email, 'password1');
  return auth;
}

test('face values are checked strictly', () => {
  assert.equal(cleanAvatar('f:fox'), 'f:fox');
  assert.equal(cleanAvatar('u:0123456789abcdef0123456789abcdef'), 'u:0123456789abcdef0123456789abcdef');
  for (const bad of ['f:nope', 'f:fox ', 'f:fox"><img src=x>', 'u:0123', 'u:0123456789ABCDEF0123456789ABCDEF', 'https://evil.test/x.jpg', 42, null, 'u:0123456789abcdef0123456789abcdef\n']) {
    assert.equal(cleanAvatar(bad), null, String(bad));
  }
  assert.equal(new Set(FACES.map((f) => f.id)).size, FACES.length);
  assert.ok(FACES.every((f) => /^[a-z]{2,12}$/.test(f.id)));
  assert.deepEqual(avatarLook('f:owl'), { kind: 'face', face: FACES.find((f) => f.id === 'owl') });
  assert.deepEqual(avatarLook('garbage'), { kind: 'letter' });
  assert.equal(pictureKey('u:0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(pictureUrl('https://x.supabase.co', 'ab'), 'https://x.supabase.co/storage/v1/object/public/avatars/ab.jpg');
});

test('profiles keep a good face and drop a bad one', () => {
  const p = createProfile('Ann');
  assert.equal(p.avatar, null);
  assert.equal(normalizeProfile({ ...p, avatar: 'f:fox' })!.avatar, 'f:fox');
  assert.equal(normalizeProfile({ ...p, avatar: 'javascript:alert(1)' })!.avatar, null);
  assert.equal(normalizeProfile({ ...p, avatar: undefined })!.avatar, null);
});

test('uploading, the three-picture limit, and deleting', async () => {
  const fake = new FakeSupabase();
  const ann = await signedIn(fake, 'ann@x.test');
  const bo = await signedIn(fake, 'bo@x.test');
  const a = await uploadPicture(ann, jpeg(), fake.fetch);
  assert.match(a, /^u:[0-9a-f]{32}$/);
  await assert.rejects(uploadPicture(ann, new Blob(['x'], { type: 'image/png' }), fake.fetch), /JPEG/);
  await assert.rejects(uploadPicture(ann, jpeg(70_000), fake.fetch), /too big/);
  await uploadPicture(ann, jpeg(), fake.fetch);
  await uploadPicture(ann, jpeg(), fake.fetch);
  await assert.rejects(uploadPicture(ann, jpeg(), fake.fetch), /can't upload a picture right now/);
  assert.equal((await listPictures(ann, fake.fetch)).length, 3);
  assert.equal(await deletePicture(bo, pictureKey(a)!, fake.fetch), false, 'others can\'t delete it');
  assert.equal(await clearOldPictures(ann, pictureKey(a), fake.fetch), 2);
  assert.deepEqual(await listPictures(ann, fake.fetch), [pictureKey(a)]);
  await uploadPicture(ann, jpeg(), fake.fetch);
});

test('an admin can take a picture down and stop uploads', async () => {
  const fake = new FakeSupabase();
  const ann = await signedIn(fake, 'ann@x.test');
  const boss = await signedIn(fake, 'boss@x.test');
  fake.admins.add(boss.current!.userId);
  const a = await uploadPicture(ann, jpeg(), fake.fetch);
  assert.equal(await new AdminApi(boss, fake.fetch).setPictureBlocked(ann.current!.userId, true, pictureKey(a)), true);
  assert.equal(fake.pictures!.size, 0);
  await assert.rejects(uploadPicture(ann, jpeg(), fake.fetch), /can't upload/);
  await new AdminApi(boss, fake.fetch).setPictureBlocked(ann.current!.userId, false);
  await uploadPicture(ann, jpeg(), fake.fetch);
  await assert.rejects(new AdminApi(ann, fake.fetch).setPictureBlocked(boss.current!.userId, true), /permission|not allowed|denied/i);
});

test('a project without avatars.sql says so', async () => {
  const fake = new FakeSupabase();
  fake.pictures = null;
  const ann = await signedIn(fake, 'ann@x.test');
  await assert.rejects(uploadPicture(ann, jpeg(), fake.fetch), AvatarsNotSetUpError);
});
