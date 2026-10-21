// Bot faces and the speech bubbles that float up over a seat, shared by the poker and
// blackjack tables and the online chat.
import { personaFor } from '../bots/persona';
import { esc } from './dom';

/** A seat's avatar: a regular's face for bots, the first letter of the name for people. */
export function avatarHtml(name: string, level: string, bot: boolean): string {
  const face = bot ? personaFor(name)?.face : undefined;
  return face
    ? `<span class="avatar face lv-${level}" aria-hidden="true">${face}</span>`
    : `<span class="avatar lv-${level}">${esc(name.slice(0, 1).toUpperCase())}</span>`;
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

/** Floats a line (or an emote) up over the seat with this data-seat id. */
export function floatOver(seatId: string, text: string, opts: { emote?: boolean; delay?: number } = {}) {
  const spot = document.querySelector<HTMLElement>(`[data-seat="${CSS.escape(seatId)}"]`);
  const seat = spot?.querySelector<HTMLElement>('.pod') ?? spot;
  if (!seat) return;
  const r = seat.getBoundingClientRect();
  const b = document.createElement('div');
  b.className = opts.emote ? 'chat-float emote' : 'chat-float';
  b.textContent = text;
  b.style.left = `${r.left + r.width / 2}px`;
  b.style.top = `${r.top}px`;
  b.style.animationDelay = `${opts.delay ?? 0}s`;
  floatLayer().append(b);
  b.addEventListener('animationend', () => b.remove());
  // Older browsers without animationend events still get cleaned up.
  window.setTimeout(() => b.remove(), 7000);
}
