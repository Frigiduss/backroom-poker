import { Card, makeCard } from '../engine/cards';
import { VARIANTS, VariantId } from '../engine/variants';
import { cardHtml } from './dom';
import { symHtml } from './slots';

/** Every game in the lobby: a poker variant, or one of the house games. */
export type GameId = VariantId | HouseGame;
export type HouseGame = 'blackjack' | 'roulette' | 'baccarat' | 'videopoker' | 'slots';
export const HOUSE_GAMES: HouseGame[] = ['blackjack', 'roulette', 'baccarat', 'videopoker', 'slots'];
export const isHouseGame = (id: string): id is HouseGame => (HOUSE_GAMES as string[]).includes(id);

interface Category { id: string; name: string; games: GameId[] }

/** The lobby's game tabs, grouped by how the games are dealt. */
const CATEGORIES: Category[] = [
  { id: 'community', name: "Hold'em & Omaha", games: ['holdem', 'shortdeck', 'omaha', 'omaha8'] },
  { id: 'stud', name: 'Stud', games: ['stud7', 'stud8', 'razz'] },
  { id: 'draw', name: 'Draw', games: ['draw5'] },
  { id: 'casino', name: 'Casino', games: HOUSE_GAMES },
];

// Suits: 0 clubs, 1 diamonds, 2 hearts, 3 spades. Ranks 2..14 (ace high).
const c = (rank: number, suit: number): Card => makeCard(rank, suit);

interface Showcase {
  name: string;
  blurb: string;
  /** Short facts shown as chips. */
  facts: string[];
  /** A sample hand, and the board for community-card games. */
  hand: Card[];
  board?: Card[];
  /** Labels for the two rows of cards, when they aren't hand and board. */
  handLabel?: string;
  boardLabel?: string;
  /** A picture in place of cards. */
  art?: string;
  /** What the sample shows. */
  caption: string;
}

const SHOWCASE: Record<GameId, Omit<Showcase, 'name' | 'blurb' | 'facts'>> = {
  holdem: { hand: [c(14, 3), c(13, 3)], board: [c(12, 3), c(11, 3), c(10, 3), c(7, 1), c(2, 0)], caption: 'A royal flush: both hole cards and three from the board.' },
  shortdeck: { hand: [c(9, 2), c(9, 0)], board: [c(9, 3), c(14, 1), c(14, 0), c(8, 2), c(6, 3)], caption: 'Nines full of aces. No card in the deck is lower than a six.' },
  omaha: { hand: [c(14, 2), c(14, 0), c(13, 2), c(12, 0)], board: [c(13, 1), c(10, 3), c(11, 2), c(4, 0), c(2, 1)], caption: 'A straight, using exactly two hole cards.' },
  omaha8: { hand: [c(14, 1), c(2, 0), c(13, 3), c(13, 2)], board: [c(3, 0), c(4, 1), c(5, 2), c(13, 1), c(9, 3)], caption: 'Three kings for high and A-2-3-4-5 for low, likely the whole pot.' },
  draw5: { hand: [c(13, 2), c(13, 0), c(13, 1), c(7, 3), c(2, 2)], caption: 'Three kings. Keep them and draw two.' },
  stud7: { hand: [c(12, 2), c(8, 0), c(12, 3), c(8, 1), c(5, 2), c(3, 0), c(12, 1)], caption: 'Queens full of eights, from seven cards dealt one at a time.' },
  stud8: { hand: [c(14, 0), c(3, 1), c(5, 3), c(6, 2), c(4, 0), c(13, 3), c(2, 1)], caption: 'A six-high straight for high and A-2-3-4-5 for low, so it scoops.' },
  razz: { hand: [c(14, 2), c(2, 3), c(4, 0), c(13, 1), c(5, 2), c(3, 1), c(11, 0)], caption: 'A perfect low, A-2-3-4-5. The face cards do not count.' },
  blackjack: { hand: [c(14, 3), c(13, 2)], caption: 'Blackjack: an ace and a ten-card, paid 3 to 2.' },
  roulette: { hand: [], art: rouletteArt(), caption: 'Seventeen, black. A chip straight up on it pays 35 to 1.' },
  baccarat: { hand: [c(4, 2), c(5, 3)], handLabel: 'Player', board: [c(13, 0), c(7, 1)], boardLabel: 'Banker', caption: 'A natural nine for Player beats Banker\'s seven.' },
  videopoker: { hand: [c(11, 2), c(11, 3), c(4, 0), c(11, 1), c(9, 2)], caption: 'Three jacks dealt. Hold them and draw two more cards.' },
  slots: { hand: [], art: slotsArt(), caption: 'Three sevens on the middle line: 500 coins a coin bet.' },
};

/** A few pockets of the wheel around 17, for the feature panel. */
function rouletteArt(): string {
  const run = [4, 21, 2, 25, 17, 34, 6, 27, 13];
  const reds = new Set([21, 25, 34, 27]);
  return `<div class="rl-art" aria-hidden="true">${run.map((n, i) => `<span class="${reds.has(n) ? 'red' : 'black'}${n === 17 ? ' hit' : ''}" style="--i:${i}">${n}${n === 17 ? '<i class="rl-art-ball"></i>' : ''}</span>`).join('')}</div>`;
}

/** The slot window with three sevens across the middle, for the feature panel. */
function slotsArt(): string {
  const rows = [['crown', 'heart', 'chip'], ['seven', 'seven', 'seven'], ['spade', 'club', 'diamond']] as const;
  return `<div class="sl-art" aria-hidden="true">${rows.map((r, i) => r.map((s) => symHtml(s, i === 1 ? 'hit' : '')).join('')).join('')}</div>`;
}

const HOUSE: Record<HouseGame, { name: string; blurb: string; facts: string[] }> = {
  blackjack: {
    name: 'Blackjack',
    blurb: 'Beat the dealer to 21 without going over. Double, split and insure, and a blackjack pays 3 to 2.',
    facts: ['Casino', 'vs the dealer', '6 decks'],
  },
  roulette: {
    name: 'Roulette',
    blurb: 'Spread chips over the layout and spin. Pick a single number for 35 to 1, or play red or black, odd or even, dozens and columns.',
    facts: ['Casino', 'vs the house', 'European or American wheel'],
  },
  baccarat: {
    name: 'Baccarat',
    blurb: 'Bet on Player, Banker or a tie, and the closest hand to nine wins. The cards are drawn by the house rules, so it is all in the bet.',
    facts: ['Casino', 'vs the house', '8 decks', 'Punto banco'],
  },
  videopoker: {
    name: 'Video Poker',
    blurb: 'Five cards, one draw, and a pay table on the glass. Hold what you like, draw the rest, and a royal flush on five coins pays 4,000.',
    facts: ['Casino', 'vs the machine', 'Jacks or Better', 'Bonus Poker', 'Double Double Bonus'],
  },
  slots: {
    name: 'Slots',
    blurb: 'Lucky Sevens: three reels of suits, chips, crowns and sevens. Play one to five lines, pull, and three sevens on a line pays 500 coins.',
    facts: ['Casino', 'vs the machine', '3 reels', '5 lines'],
  },
};

function showcase(id: GameId): Showcase {
  if (isHouseGame(id)) return { ...HOUSE[id], ...SHOWCASE[id] };
  const g = VARIANTS[id];
  const family = { flop: 'Community cards', draw: 'Draw', stud: 'Stud' }[g.family];
  return {
    name: g.name, blurb: g.blurb, ...SHOWCASE[id],
    facts: [family, `${g.holeCards} cards each`, g.structures.join(' · '), `Up to ${g.maxPlayers} players`],
  };
}

const categoryOf = (id: GameId) => CATEGORIES.find((cat) => cat.games.includes(id)) ?? CATEGORIES[0];
const shortName = (id: GameId) => (isHouseGame(id) ? HOUSE[id].name : VARIANTS[id].name);

/** Each tab remembers the game last picked in it, so switching back lands on it again. */
const lastPick: Record<string, GameId> = {};
/** The game featured last time, so the feature only animates when it changes. */
let featured: GameId | null = null;

const fan = (n: number) => `<span class="hole" style="--n:${n};--s:${n > 4 ? 5 : n > 2 ? 7 : 9}px" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i style="--i:${i};--k:${i - (n - 1) / 2}"></i>`).join('')}</span>`;
const holeCount = (id: GameId) => (id === 'videopoker' ? 5 : isHouseGame(id) ? 2 : VARIANTS[id].holeCards);
const wheelIcon = '<span class="hole wheel-icon" aria-hidden="true"><i></i></span>';
const slotIcon = '<span class="hole slot-icon" aria-hidden="true">7</span>';
const pillIcon = (id: GameId) => (id === 'roulette' ? wheelIcon : id === 'slots' ? slotIcon : fan(holeCount(id)));

/** Tabs of game families, the games in the open tab, and a featured view of the chosen game. */
export function gamePickerHtml(selected: GameId): string {
  const cat = categoryOf(selected);
  lastPick[cat.id] = selected;
  const s = showcase(selected);
  const enter = featured !== null && featured !== selected;
  featured = selected;
  const cards = (cs: Card[]) => cs.map((card, i) => cardHtml(card, '').replace('class="card', `style="--i:${i}" class="card`)).join('');
  return `<section class="panel games-panel">
    <h2 class="step">Choose a game</h2>
    <div class="cat-tabs" role="tablist" aria-label="Kinds of game">
      ${CATEGORIES.map((t) => `<button type="button" role="tab" class="cat-tab" id="cat-${t.id}" data-cat="${t.id}" aria-selected="${t === cat}" aria-controls="game-feature" tabindex="${t === cat ? 0 : -1}">
        ${t.name}<span class="cat-count">${t.games.length}</span></button>`).join('')}
    </div>
    ${cat.games.length > 1 ? `<div class="cat-games" role="group" aria-label="${cat.name} games">
      ${cat.games.map((id) => `<button type="button" class="game-pill" data-game="${id}" aria-pressed="${id === selected}">${pillIcon(id)}<span>${shortName(id)}</span></button>`).join('')}
    </div>` : ''}
    <div class="feature${enter ? ' enter' : ''}" id="game-feature" role="tabpanel" aria-labelledby="cat-${cat.id}">
      <div class="feature-text">
        <span class="eyebrow">${cat.name}</span>
        <h3>${s.name}</h3>
        <p>${s.blurb}</p>
        <div class="facts">${s.facts.map((f) => `<span>${f}</span>`).join('')}</div>
      </div>
      <figure class="feature-cards" aria-label="${s.art ? 'Example spin' : 'Example hand'}">
        ${s.art ?? `<div class="fc-row hand${s.hand.length > 4 ? ' many' : ''}">${s.handLabel ? `<span class="fc-label">${s.handLabel}</span>` : ''}${cards(s.hand)}</div>`}
        ${s.board ? `<div class="fc-row board"><span class="fc-label">${s.boardLabel ?? 'Board'}</span>${cards(s.board)}</div>` : ''}
        <figcaption>${s.caption}</figcaption>
      </figure>
    </div>
  </section>`;
}

/** Wires up the picker. `pick` is called with the game a tab or game button chose. */
export function bindGamePicker(pick: (id: GameId) => void) {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.cat-tab'));
  tabs.forEach((b, i) => {
    const cat = CATEGORIES.find((t) => t.id === b.dataset.cat)!;
    b.onclick = () => {
      if (b.getAttribute('aria-selected') !== 'true') pick(lastPick[cat.id] ?? cat.games[0]);
    };
    // Arrow keys move between tabs, as tab lists do.
    b.onkeydown = (e: KeyboardEvent) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = CATEGORIES[(i + step + CATEGORIES.length) % CATEGORIES.length];
      pick(lastPick[next.id] ?? next.games[0]);
      document.getElementById(`cat-${next.id}`)?.focus();
    };
  });
  document.querySelectorAll<HTMLButtonElement>('[data-game]').forEach((b) => {
    b.onclick = () => {
      pick(b.dataset.game as GameId);
      document.querySelector<HTMLButtonElement>(`[data-game="${b.dataset.game}"]`)?.focus();
    };
  });
}
