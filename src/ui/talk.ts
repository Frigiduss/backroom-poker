// Bot faces and the speech bubbles that float up over a seat, shared by the poker and
// blackjack tables and the online chat.
import { personaFor } from '../bots/persona';
import { avatarLook } from '../accounts';
import { esc } from './dom';
import { faceInner } from './player/faces';

/** A seat's avatar: a regular's face for bots; for people, the face they picked or the first letter of the name. */
export function avatarHtml(name: string, level: string, bot: boolean, avatar: string | null = null): string {
  const face = bot ? personaFor(name)?.face : undefined;
  if (face) return `<span class="avatar face lv-${level}" aria-hidden="true">${face}</span>`;
  const look = bot ? 'letter' : avatarLook(avatar).kind;
  if (look === 'face') return `<span class="avatar face lv-${level}" aria-hidden="true">${faceInner(avatar, name)}</span>`;
  if (look === 'picture') return `<span class="avatar pic lv-${level}" aria-hidden="true">${faceInner(avatar, name)}</span>`;
  return `<span class="avatar lv-${level}">${esc(name.slice(0, 1).toUpperCase())}</span>`;
}

/** Hover text for a bot's seat: who they are, and their one-line story when they have one. */
export function botTitle(name: string, tag: string): string {
  const bio = personaFor(name)?.bio;
  return `${name} · ${tag}${bio ? `\n${bio}` : ''}`;
}

let layer: HTMLElement | null = null;

function floatLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'chat-float-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  return layer;
}

/**
 * Shows a line (or an emote) from the seat with this data-seat id. A line sits beside the
 * player's name plate, on the side facing the middle of the table, so it never covers their
 * name, stack or cards; an emote pops up over the plate.
 */
export function floatOver(seatId: string, text: string, opts: { emote?: boolean; delay?: number; at?: 'right' | 'below'; whisper?: boolean } = {}) {
  const spot = document.querySelector<HTMLElement>(`[data-seat="${CSS.escape(seatId)}"]`);
  const seat = spot?.querySelector<HTMLElement>('.pod') ?? spot;
  if (!seat) return;
  const r = seat.getBoundingClientRect();
  const b = document.createElement('div');
  b.textContent = text;
  b.style.animationDelay = `${opts.delay ?? 0}s`;
  if (opts.emote) {
    b.className = 'chat-float emote';
    b.style.left = `${r.left + r.width / 2}px`;
    b.style.top = `${r.top}px`;
  } else {
    // Point in toward the table. On a phone, or with too little room that side, the middle of
    // the table is the player's own cards, so the line goes above the speaker's cards instead.
    const vw = document.documentElement.clientWidth;
    const felt = (spot?.parentElement ?? document.body).getBoundingClientRect();
    // A dealer asks for a side (or below their name plate) instead of facing the middle.
    const right = opts.at ? opts.at === 'right' : r.left + r.width / 2 < felt.left + felt.width / 2;
    const room = right ? vw - r.right - 18 : r.left - 18;
    // Longer lines stay up a little longer so there is time to read them.
    b.style.animationDuration = `${Math.min(opts.whisper ? 9 : 7, 3.2 + text.length * 0.06)}s`;
    if (opts.at === 'below' || (opts.at && (room < 120 || vw <= 720))) {
      b.className = 'chat-float below';
      b.style.maxWidth = `${Math.min(260, vw - 24)}px`;
      b.style.left = `${Math.max(12 + 130, Math.min(vw - 12 - 130, r.left + r.width / 2))}px`;
      b.style.top = `${r.bottom + 10}px`;
    } else if (room >= 120 && vw > 720) {
      b.className = `chat-float side ${right ? 'to-right' : 'to-left'}`;
      b.style.maxWidth = `${Math.min(240, room)}px`;
      b.style.top = `${r.top + r.height / 2}px`;
      b.style.left = right ? `${r.right + 12}px` : `${r.left - 12}px`;
    } else {
      const cards = spot?.querySelector<HTMLElement>('.cards, .bj-hands')?.getBoundingClientRect();
      b.className = 'chat-float';
      b.style.left = `${r.left + r.width / 2}px`;
      b.style.top = `${Math.min(r.top, cards && cards.height ? cards.top : r.top) - 6}px`;
    }
  }
  if (opts.whisper) b.classList.add('whisper');
  floatLayer().append(b);
  b.addEventListener('animationend', () => b.remove());
  // Older browsers without animationend events still get cleaned up.
  window.setTimeout(() => b.remove(), 11000);
}
