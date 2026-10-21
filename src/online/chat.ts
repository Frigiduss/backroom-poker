// Table chat and emotes for online tables. Lines are kept in the table's state, so they reach
// everyone through the same per-person views as the cards do, and the server enforces the
// rate limit and any mute an admin sets from the developer console.
import { AdminCommand, CHAT_MAX, ChatLineView, EMOTES, EmoteId } from './protocol';

/** Lines kept per table; older ones drop off. */
export const CHAT_KEEP = 40;
/** At most CHAT_BURST lines from one person in any CHAT_WINDOW_MS. */
export const CHAT_BURST = 5;
export const CHAT_WINDOW_MS = 10_000;

export interface ChatLine {
  id: number;
  at: number;
  /** Speaker's account id; empty for a notice from the table. */
  user: string;
  name: string;
  text?: string;
  emote?: EmoteId;
}

export interface ChatState {
  lines: ChatLine[];
  next: number;
  /** Account ids an admin has muted at this table. */
  muted: string[];
  /** When each person last spoke, for the rate limit. */
  recent: Record<string, number[]>;
}

/** The bits of a table member chat needs. */
interface Speaker {
  userId: string;
  name: string;
  seat: string | null;
  left: boolean;
}

export class ChatError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const chatOf = (state: { chat?: ChatState }): ChatState => (state.chat ??= { lines: [], next: 1, muted: [], recent: {} });

/** Strips control characters and runs of spaces, and cuts the line to CHAT_MAX. */
export function cleanChat(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX);
}

function push(c: ChatState, line: Omit<ChatLine, 'id'>) {
  c.lines.push({ id: c.next++, ...line });
  if (c.lines.length > CHAT_KEEP) c.lines.splice(0, c.lines.length - CHAT_KEEP);
}

/** Adds what a person said, or throws ChatError when it can't go out. */
export function chatSay(state: { chat?: ChatState }, m: Speaker, req: { text?: unknown; emote?: unknown }, now: number) {
  if (m.left) throw new ChatError("You've left this table.", 403);
  const c = chatOf(state);
  if (c.muted.includes(m.userId)) throw new ChatError('The table admin has muted your chat.', 403);
  const emote = typeof req.emote === 'string' && Object.prototype.hasOwnProperty.call(EMOTES, req.emote) ? (req.emote as EmoteId) : undefined;
  const text = emote ? '' : cleanChat(req.text);
  if (!emote && !text) throw new ChatError('Type something to say.');
  const recent = (c.recent[m.userId] ?? []).filter((t) => t > now - CHAT_WINDOW_MS);
  if (recent.length >= CHAT_BURST) throw new ChatError("You're chatting fast. Give it a few seconds.", 429);
  recent.push(now);
  // Only people who spoke lately need a spot in the rate limit.
  for (const [id, times] of Object.entries(c.recent)) if (!times.some((t) => t > now - CHAT_WINDOW_MS)) delete c.recent[id];
  c.recent[m.userId] = recent;
  push(c, emote ? { at: now, user: m.userId, name: m.name, emote } : { at: now, user: m.userId, name: m.name, text });
}

/** What one person sees of the chat. */
export function chatView(state: { chat?: ChatState; members: Speaker[] }, userId: string): { chat: ChatLineView[]; chatMuted: boolean } {
  const c = state.chat;
  if (!c) return { chat: [], chatMuted: false };
  return {
    chat: c.lines.map((l) => ({
      id: l.id, at: l.at, name: l.name, you: !!l.user && l.user === userId,
      seat: l.user ? state.members.find((m) => m.userId === l.user)?.seat ?? null : null,
      ...(l.emote ? { emote: l.emote } : { text: l.text ?? '' }),
      ...(l.user ? {} : { system: true }),
    })),
    chatMuted: c.muted.includes(userId),
  };
}

/** The chat for the developer console: every line, and who is muted. */
export function chatAdminInfo(state: { chat?: ChatState; members: Speaker[] }): { chat: { name: string; text: string; at: number }[]; muted: string[] } {
  const c = state.chat;
  if (!c) return { chat: [], muted: [] };
  return {
    chat: c.lines.map((l) => ({ name: l.user ? l.name : '(table)', text: l.emote ? EMOTES[l.emote] : l.text ?? '', at: l.at })),
    muted: c.muted.map((id) => state.members.find((m) => m.userId === id)?.name ?? id),
  };
}

/** A person at the table by the start of their name. */
export function findMember<M extends Speaker>(members: M[], ref: unknown): M {
  const r = String(ref ?? '').trim().toLowerCase();
  const here = members.filter((m) => !m.left);
  const exact = here.filter((m) => m.name.toLowerCase() === r);
  const hits = exact.length === 1 ? exact : here.filter((m) => m.name.toLowerCase().startsWith(r));
  if (!r || hits.length !== 1) throw new ChatError(hits.length ? `"${ref}" matches ${hits.map((m) => m.name).join(', ')}.` : `Nobody called "${ref}" is at the table.`);
  return hits[0];
}

/** The console's chat commands. Returns what to tell the admin. */
export function chatAdmin(state: { chat?: ChatState; members: Speaker[] }, cmd: Extract<AdminCommand, { do: 'mute' | 'unmute' | 'clearchat' }>, now: number): string {
  const c = chatOf(state);
  if (cmd.do === 'clearchat') {
    c.lines = [];
    push(c, { at: now, user: '', name: '', text: 'The table admin cleared the chat.' });
    return 'Chat cleared.';
  }
  const m = findMember(state.members, cmd.member);
  if (cmd.do === 'mute') {
    if (!c.muted.includes(m.userId)) c.muted.push(m.userId);
    return `${m.name} can't chat at this table now.`;
  }
  c.muted = c.muted.filter((id) => id !== m.userId);
  return `${m.name} can chat again.`;
}
