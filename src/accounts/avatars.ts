// Player faces: the first letter of the name (the default), one of the FACES, or a picture the
// player uploaded. A profile keeps it as one short string, checked against a strict pattern
// wherever it's read, because other players' faces come from their own saves:
//   'f:fox'                                one of the FACES below
//   'u:0123456789abcdef0123456789abcdef'   a picture in the `avatars` storage bucket
// Pictures are squared, shrunk to PICTURE_SIZE and saved as JPEG in the browser before they're
// sent, and the bucket itself (supabase/avatars.sql) only takes small JPEGs from signed-in
// accounts, at a random name, a few per account.
export interface Face {
  id: string;
  emoji: string;
  name: string;
}

export const FACES: Face[] = [
  { id: 'fox', emoji: '🦊', name: 'Fox' },
  { id: 'bear', emoji: '🐻', name: 'Bear' },
  { id: 'tiger', emoji: '🐯', name: 'Tiger' },
  { id: 'lion', emoji: '🦁', name: 'Lion' },
  { id: 'wolf', emoji: '🐺', name: 'Wolf' },
  { id: 'frog', emoji: '🐸', name: 'Frog' },
  { id: 'monkey', emoji: '🐵', name: 'Monkey' },
  { id: 'owl', emoji: '🦉', name: 'Owl' },
  { id: 'penguin', emoji: '🐧', name: 'Penguin' },
  { id: 'octopus', emoji: '🐙', name: 'Octopus' },
  { id: 'shark', emoji: '🦈', name: 'Shark' },
  { id: 'turtle', emoji: '🐢', name: 'Turtle' },
  { id: 'dragon', emoji: '🐲', name: 'Dragon' },
  { id: 'unicorn', emoji: '🦄', name: 'Unicorn' },
  { id: 'bee', emoji: '🐝', name: 'Bee' },
  { id: 'robot', emoji: '🤖', name: 'Robot' },
  { id: 'alien', emoji: '👽', name: 'Alien' },
  { id: 'ghost', emoji: '👻', name: 'Ghost' },
  { id: 'skull', emoji: '💀', name: 'Skull' },
  { id: 'ninja', emoji: '🥷', name: 'Ninja' },
  { id: 'wizard', emoji: '🧙', name: 'Wizard' },
  { id: 'vampire', emoji: '🧛', name: 'Vampire' },
  { id: 'hero', emoji: '🦸', name: 'Hero' },
  { id: 'pizza', emoji: '🍕', name: 'Pizza' },
  { id: 'cactus', emoji: '🌵', name: 'Cactus' },
  { id: 'fire', emoji: '🔥', name: 'Fire' },
  { id: 'bolt', emoji: '⚡', name: 'Lightning' },
  { id: 'diamond', emoji: '💎', name: 'Diamond' },
];

export const FACE_BY_ID = new Map(FACES.map((f) => [f.id, f]));

/** Uploaded pictures are this many pixels square. */
export const PICTURE_SIZE = 160;
/** The bucket refuses anything bigger (supabase/avatars.sql). */
export const PICTURE_MAX_BYTES = 64 * 1024;
/** Pictures picked from the device can be this big before they're shrunk. */
export const PICTURE_PICK_MAX_BYTES = 15 * 1024 * 1024;
export const AVATAR_BUCKET = 'avatars';

/** The same pattern the database checks (supabase/leaderboard.sql, friends.sql). */
export const AVATAR_PATTERN = /^(f:[a-z]{2,12}|u:[0-9a-f]{32})$/;

/** A face value if it's well formed (and a face we know), else null. */
export function cleanAvatar(x: unknown): string | null {
  if (typeof x !== 'string' || !AVATAR_PATTERN.test(x)) return null;
  if (x.startsWith('f:') && !FACE_BY_ID.has(x.slice(2))) return null;
  return x;
}

export type AvatarLook = { kind: 'letter' } | { kind: 'face'; face: Face } | { kind: 'picture'; key: string };

export function avatarLook(x: unknown): AvatarLook {
  const a = cleanAvatar(x);
  if (!a) return { kind: 'letter' };
  if (a.startsWith('f:')) return { kind: 'face', face: FACE_BY_ID.get(a.slice(2))! };
  return { kind: 'picture', key: a.slice(2) };
}

/** Where an uploaded picture can be read, by anyone. */
export const pictureUrl = (baseUrl: string, key: string): string => `${baseUrl}/storage/v1/object/public/${AVATAR_BUCKET}/${key}.jpg`;

/** The uploaded picture's key in a face value, or null. */
export const pictureKey = (x: unknown): string | null => {
  const look = avatarLook(x);
  return look.kind === 'picture' ? look.key : null;
};

/** A fresh, unguessable name for a picture: 32 hex digits. */
export function newPictureKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
