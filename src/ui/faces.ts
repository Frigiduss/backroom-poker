// Drawing a player's face: their first letter on their colour, one of the game's faces, or an
// uploaded picture. Face values come from other players' saves, so they're checked against the
// strict pattern in accounts/avatars.ts before anything is drawn, and a picture is only ever a
// link to the game's own storage bucket.
import { avatarLook, pictureUrl } from '../accounts';
import { ONLINE } from '../accounts/config';
import { esc } from './dom';

const letterOf = (name: string): string => esc((name || '?').slice(0, 1).toUpperCase());

/** What goes inside a round badge (.pfp or a table seat's .avatar). */
export function faceInner(avatar: unknown, name: string): string {
  const look = avatarLook(avatar);
  if (look.kind === 'face') return `<span class="pfp-emoji">${look.face.emoji}</span>`;
  if (look.kind === 'picture' && ONLINE.url) {
    return `<img class="pfp-img" src="${esc(pictureUrl(ONLINE.url, look.key))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-letter="${letterOf(name)}">`;
  }
  return letterOf(name);
}

/** A player's round badge. */
export function faceHtml(who: { name: string; color: string; avatar?: string | null }, cls = ''): string {
  const look = avatarLook(who.avatar);
  const kind = look.kind === 'face' ? ' has-emoji' : look.kind === 'picture' ? ' has-pic' : '';
  return `<span class="pfp${kind}${cls ? ` ${cls}` : ''}" style="--pfp:${esc(who.color)}" aria-hidden="true">${faceInner(who.avatar, who.name)}</span>`;
}

let fallback = false;

/** A picture that won't load (deleted, or offline) turns back into the player's first letter. */
export function installFaceFallback() {
  if (fallback || typeof document === 'undefined') return;
  fallback = true;
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('pfp-img')) return;
    const box = img.parentElement;
    box?.classList.remove('has-pic');
    img.replaceWith(document.createTextNode(img.dataset.letter || '?'));
  }, true);
}
