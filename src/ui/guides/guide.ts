// How to play: a rules page for every game in the lobby and a walk through a first hand, one
// step at a time. It opens over the lobby or a table, like the hand history. The text lives in
// guide-data.ts.
import { VARIANTS } from '../../engine/variants';
import { cardHtml, esc } from '../dom';
import { A, C, D, H, J, K, Q, Ranking, S, Step, T, guideFor } from './guide-data';
import { CATEGORIES, GameId, gameName } from '../picker';
import { symHtml } from '../casino/slots';


const mini = (rank: number, suit: number) => {
  const r = rank === 10 ? '10' : '23456789TJQKA'[rank - 2];
  return `<i class="hg-mini${suit === D || suit === H ? ' red' : ''}">${r}${'♣♦♥♠'[suit]}</i>`;
};
const hand = (cs: [number, number][]) => `<span class="hg-hand">${cs.map(([r, s]) => mini(r, s)).join('')}</span>`;

const HIGH: [string, string][] = [
  ['Royal flush', hand([[A, S], [K, S], [Q, S], [J, S], [T, S]])],
  ['Straight flush', hand([[9, H], [8, H], [7, H], [6, H], [5, H]])],
  ['Four of a kind', hand([[Q, C], [Q, D], [Q, H], [Q, S], [4, C]])],
  ['Full house', hand([[8, S], [8, D], [8, C], [K, H], [K, S]])],
  ['Flush', hand([[A, D], [J, D], [8, D], [6, D], [2, D]])],
  ['Straight', hand([[T, C], [9, D], [8, S], [7, H], [6, C]])],
  ['Three of a kind', hand([[7, C], [7, D], [7, S], [K, H], [2, C]])],
  ['Two pair', hand([[J, H], [J, C], [4, S], [4, D], [A, C]])],
  ['One pair', hand([[T, S], [T, H], [A, D], [8, C], [3, S]])],
  ['High card', hand([[A, H], [Q, C], [9, S], [6, D], [3, C]])],
];

function rankingHtml(kind: Ranking): string {
  let rows: [string, string][] = HIGH;
  let title = 'Hands, best first';
  let note = '';
  if (kind === 'short') {
    const at = (n: string) => HIGH.find(([name]) => name === n)!;
    rows = ['Royal flush', 'Straight flush', 'Four of a kind', 'Flush', 'Full house', 'Three of a kind', 'Straight', 'Two pair', 'One pair', 'High card'].map(at);
    note = 'Flush and full house swap places, and so do three of a kind and straight.';
  } else if (kind === 'videopoker') {
    title = 'Paying hands on Jacks or Better';
    rows = HIGH.slice(0, 8).concat([['Jacks or better', hand([[J, S], [J, D], [9, C], [6, H], [2, S]])]]);
  } else if (kind === 'low' || kind === 'hilo') {
    title = kind === 'low' ? 'Low hands, best first' : 'Low hands, best first (high hands rank as usual)';
    rows = [
      ['The wheel', hand([[5, H], [4, S], [3, D], [2, C], [A, S]])],
      ['Six low', hand([[6, C], [4, D], [3, H], [2, S], [A, C]])],
      ['Seven low', hand([[7, S], [5, C], [4, H], [2, D], [A, H]])],
      ['Eight low', hand([[8, D], [6, S], [5, H], [3, C], [2, C]])],
      ...(kind === 'low' ? [['Nine low and up', hand([[9, C], [8, H], [6, D], [4, S], [3, H]])] as [string, string]] : []),
    ];
    note = kind === 'low'
      ? 'Compare the highest card first, then the next. 7-5-4-2-A beats 7-6-3-2-A. Any pair is worse than any five different cards.'
      : 'Only five different ranks of eight or lower make a low. Compare the highest card first: 7-5-4-2-A beats 7-6-3-2-A.';
  }
  return `<section class="hg-rank" aria-label="${title}">
    <h4>${title}</h4>
    <ol>${rows.map(([name, cards]) => `<li><span>${name}</span>${cards}</li>`).join('')}</ol>
    ${note ? `<p class="hg-note">${note}</p>` : ''}
  </section>`;
}

const RED_POCKETS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const pocketHtml = (n: number) =>
  `<span class="hg-pocket ${n === 0 ? 'green' : RED_POCKETS.has(n) ? 'red' : 'black'}">${n}</span>`;

function stepVisual(s: Step): string {
  if (s.bets) return `<div class="hg-bets">${s.bets.map(([spot, n]) => `<span class="hg-bet"><b>${spot}</b><span class="hg-chip">${n}</span></span>`).join('')}</div>`;
  if (s.pocket !== undefined) return `<div class="hg-bets">${pocketHtml(s.pocket)}</div>`;
  if (s.reels) return `<div class="hg-reels">${s.reels.map((row, i) => `<div class="hg-reel-row${s.paid?.includes(i) ? ' paid' : ''}">${row.map((sym) => symHtml(sym)).join('')}</div>`).join('')}</div>`;
  if (!s.rows) return '';
  return `<div class="hg-rows">${s.rows.map((r) => `<div class="hg-row${r.cards.length > 5 ? ' many' : ''}">
      <span class="hg-label">${esc(r.label)}</span>
      <div class="hg-cards">${r.cards.map((card, i) => cardHtml(card, r.mark?.includes(i) ? 'hg-on' : '')).join('')}</div>
    </div>`).join('')}</div>`;
}

let open: GuideViewer | null = null;

/** Opens the how to play guide over the page, on one game. */
export function openGuide(game: GameId, onClose?: () => void): void {
  open?.close(false);
  open = new GuideViewer(game, onClose);
}

export const guideOpen = (): boolean => !!open;

/** The question mark used on the table bars' Rules button. */
export const GUIDE_ICON = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.4 9.3a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.2-2.6 4M12 17.4v.2';

class GuideViewer {
  private step = 0;
  private root: HTMLDivElement;
  private keys = (e: KeyboardEvent) => this.onKey(e);
  private before = document.activeElement as HTMLElement | null;

  constructor(private game: GameId, private onClose?: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'overlay hg-overlay';
    this.root.onclick = (e) => e.target === this.root && this.close();
    document.body.appendChild(this.root);
    window.addEventListener('keydown', this.keys, true);
    this.render();
    this.root.querySelector<HTMLElement>('.hg-close')?.focus();
  }

  close(notify = true) {
    window.removeEventListener('keydown', this.keys, true);
    this.root.remove();
    if (open === this) open = null;
    this.before?.focus?.();
    if (notify) this.onClose?.();
  }

  private pick(game: GameId) {
    this.game = game;
    this.step = 0;
    this.render();
    this.root.querySelector<HTMLElement>(`[data-guide-game="${game}"]`)?.focus();
    this.root.querySelector('.hg-body')?.scrollTo(0, 0);
  }

  private go(k: number) {
    const n = guideFor(this.game).steps.length;
    this.step = Math.max(0, Math.min(n - 1, k));
    this.render();
  }

  private render() {
    const g = guideFor(this.game);
    const s = g.steps[this.step];
    const n = g.steps.length;
    const name = gameName(this.game);
    const sub = this.game in VARIANTS ? 'Poker' : 'Casino';
    this.root.innerHTML = `<div class="hg" role="dialog" aria-modal="true" aria-labelledby="hg-title">
      <header class="hg-head">
        <h2 id="hg-title">How to play</h2>
        <button type="button" class="icon-btn hg-close" aria-label="Close">✕</button>
      </header>
      <nav class="hg-games" aria-label="Games">
        ${CATEGORIES.map((cat) => `<div class="hg-cat"><span>${cat.name}</span>${cat.games.map((id) => `<button type="button" class="game-pill" data-guide-game="${id}" aria-pressed="${id === this.game}">${gameName(id)}</button>`).join('')}</div>`).join('')}
      </nav>
      <div class="hg-body">
        <section class="hg-rules">
          <span class="eyebrow">${sub}</span>
          <h3>${name}</h3>
          <p class="hg-goal">${g.goal}</p>
          <ol class="hg-list">${g.rules.map((r) => `<li>${r}</li>`).join('')}</ol>
          ${g.ranking ? rankingHtml(g.ranking) : ''}
        </section>
        <section class="hg-walk" aria-label="Your first hand">
          <div class="hg-walk-head"><h4>Your first ${this.game === 'roulette' || this.game === 'slots' ? 'spin' : this.game === 'baccarat' ? 'coup' : 'hand'}</h4><span>Step ${this.step + 1} of ${n}</span></div>
          <div class="hg-dots" aria-hidden="true">${g.steps.map((_, i) => `<i class="${i === this.step ? 'on' : i < this.step ? 'done' : ''}"></i>`).join('')}</div>
          <div class="hg-step" aria-live="polite">
            <h5>${s.title}</h5>
            ${stepVisual(s)}
            <p>${s.text}</p>
          </div>
          <div class="hg-nav">
            <button type="button" class="btn btn-sm" id="hg-prev" ${this.step === 0 ? 'disabled' : ''}>Back</button>
            ${this.step < n - 1
              ? '<button type="button" class="btn btn-sm btn-primary" id="hg-next">Next</button>'
              : '<button type="button" class="btn btn-sm btn-primary" id="hg-done">Got it</button>'}
          </div>
        </section>
      </div>
    </div>`;
    this.root.querySelector<HTMLButtonElement>('.hg-close')!.onclick = () => this.close();
    this.root.querySelectorAll<HTMLButtonElement>('[data-guide-game]').forEach((b) => (b.onclick = () => this.pick(b.dataset.guideGame as GameId)));
    const btn = (id: string, fn: () => void) => {
      const el = this.root.querySelector<HTMLButtonElement>(`#${id}`);
      if (el) el.onclick = fn;
    };
    btn('hg-prev', () => this.go(this.step - 1));
    btn('hg-next', () => this.go(this.step + 1));
    btn('hg-done', () => this.close());
    this.root.querySelector<HTMLElement>('.hg-games [aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // The table underneath must not see these keys.
    e.stopPropagation();
    if (e.key === 'Escape') this.close();
    else if (e.key === 'ArrowRight') this.go(this.step + 1);
    else if (e.key === 'ArrowLeft') this.go(this.step - 1);
    else if (e.key === 'Tab') this.trapTab(e);
  }

  /** Keeps Tab inside the guide while it is open. */
  private trapTab(e: KeyboardEvent) {
    const items = Array.from(this.root.querySelectorAll<HTMLElement>('button:not([disabled])'));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  }
}

