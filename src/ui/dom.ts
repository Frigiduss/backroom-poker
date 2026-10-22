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
  const face = 'JQK'.includes(r) ? ' face' : '';
  const corner = `<span class="rank">${rank}</span><span class="suit">${sym}</span>`;
  return `<div class="card ${SUIT_CHARS[s]}${red}${face} ${cls}" aria-label="${rank} of ${names[s]}">`
    + `<span class="corner tl">${corner}</span><span class="pip">${face ? r : sym}</span><span class="corner br">${corner}</span></div>`;
}

/** A player's title, shown next to their name. Nothing when they have none. */
export const titleHtml = (title: string | null | undefined, cls = ''): string =>
  title ? `<span class="ptitle ${cls}">${esc(title)}</span>` : '';

const CHIP_VALUES = [5000, 1000, 500, 100, 25, 5, 1];

/** A small stack of casino chips whose colours follow the amount's denominations. */
export function chipsHtml(amount: number, max = 5): string {
  const chips: number[] = [];
  let left = amount;
  for (const v of CHIP_VALUES) {
    while (left >= v && chips.length < max) {
      chips.push(v);
      left -= v;
    }
  }
  if (!chips.length) chips.push(1);
  return `<span class="chips" aria-hidden="true">${chips
    .map((v, i) => `<span class="chip v${v}" style="--i:${i}"></span>`)
    .join('')}</span>`;
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

/** Phone-sized screen: the player's own cards leave the felt for their own row above the dock. */
export const isPhone = (): boolean => window.matchMedia('(max-width: 720px)').matches;

/** A table with the player's own seat beside it in a row of its own (phones), or just the table. */
export function withHero(table: string, hero: string): string {
  return hero ? `<div class="felt-box">${table}</div><div class="hero-row">${hero}</div>` : table;
}
