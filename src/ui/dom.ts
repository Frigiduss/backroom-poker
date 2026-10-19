import { Card, RANK_CHARS, SUIT_CHARS, SUIT_SYMBOLS, rankOf, suitOf } from '../engine/cards';

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function cardHtml(c: Card | null, cls = ''): string {
  if (c === null) return `<div class="card back ${cls}" aria-label="Face-down card"></div>`;
  const r = RANK_CHARS[rankOf(c) - 2];
  const rank = r === 'T' ? '10' : r;
  const s = suitOf(c);
  const sym = SUIT_SYMBOLS[s];
  const red = s === 1 || s === 2 ? ' red' : '';
  const names = ['clubs', 'diamonds', 'hearts', 'spades'];
  return `<div class="card ${SUIT_CHARS[s]}${red} ${cls}" aria-label="${rank} of ${names[s]}"><span class="r">${rank}</span><span class="s1">${sym}</span><span class="s2">${sym}</span></div>`;
}

export const fmt = (n: number): string => n.toLocaleString('en-US');

export function store<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}
