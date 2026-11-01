// Hand history: the last hands a player played, saved in this browser, and a viewer that
// replays any of them street by street. Opens over whatever is on screen (a table or the
// profile) and leaves it untouched underneath.
import { Card, RANK_CHARS, SUIT_SYMBOLS, rankOf, suitOf } from '../../engine/cards';
import { Frame, HandHistory, chapters, historyNet, isHandHistory, replayFrames } from '../../engine/history';
import { STRUCTURE_NAMES, VARIANTS } from '../../engine/variants';
import { SHARE_PREFIX, encodeSharedHand } from '../../engine/share';
import { cardHtml, esc, fmt, isPhone } from '../dom';

/** Hands kept per player; older ones drop off. */
export const HANDS_KEPT = 50;
const PLAY_MS = 1100;
/** A clock turning back, for the History buttons. */
export const HISTORY_ICON = 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 3.5v5h5M12 7.5V12l3 2';
const keyFor = (playerId: string) => `backroom-poker-hands:${playerId}`;

/** The player's saved hands, newest first. */
export function loadHands(playerId: string): HandHistory[] {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(playerId)) ?? '[]');
    return Array.isArray(raw) ? raw.filter(isHandHistory) : [];
  } catch {
    return [];
  }
}

/** Adds a finished hand to the front of the player's history. */
export function saveHand(playerId: string, h: HandHistory | null): void {
  if (!h) return;
  const hands = [h, ...loadHands(playerId).filter((x) => x.id !== h.id)].slice(0, HANDS_KEPT);
  try {
    localStorage.setItem(keyFor(playerId), JSON.stringify(hands));
  } catch {
    /* storage full or blocked: the hand just isn't kept */
  }
}

// ---------- the viewer ----------

interface Options {
  playerId: string;
  fourColor?: boolean;
  /** Open on this hand (by id) instead of the newest. */
  select?: string;
  /** Show only this hand, from a link a friend shared, instead of the player's own; null for a link that didn't read. */
  shared?: HandHistory | null;
  onClose?: () => void;
}

let open: HistoryViewer | null = null;

/** Opens the hand history over the page. */
export function openHandHistory(opts: Options): void {
  open?.close(false);
  open = new HistoryViewer(opts);
}

export const handHistoryOpen = (): boolean => !!open;

const ago = (at: number): string => {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const signed = (n: number): string => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '0');

function miniCard(c: Card | null): string {
  if (c === null) return '<i class="hh-mini back"></i>';
  const r = RANK_CHARS[rankOf(c) - 2];
  const s = suitOf(c);
  return `<i class="hh-mini s${s}">${r === 'T' ? '10' : r}${SUIT_SYMBOLS[s]}</i>`;
}

const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = {
  first: 'M6 5v14M18 5 9 12l9 7V5Z',
  prev: 'M16 5 7 12l9 7V5Z',
  play: 'M8 5v14l11-7L8 5Z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  next: 'M8 5v14l9-7-9-7Z',
  last: 'M18 5v14M6 5l9 7-9 7V5Z',
  share: 'M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5',
};

/** The address that replays this hand for whoever opens it. */
export async function shareLink(h: HandHistory): Promise<string> {
  return `${location.origin}${location.pathname}#${SHARE_PREFIX}${await encodeSharedHand(h)}`;
}

class HistoryViewer {
  private hands: HandHistory[];
  private sel = 0;
  private frames: Frame[] = [];
  private k = 0;
  private timer = 0;
  /** What the Share button says for a moment after it's used. */
  private shareNote = '';
  private shareTimer = 0;
  private root: HTMLDivElement;
  private keys = (e: KeyboardEvent) => this.onKey(e);

  constructor(private opts: Options) {
    this.hands = opts.shared ? [opts.shared] : opts.shared === null ? [] : loadHands(opts.playerId);
    this.sel = Math.max(0, this.hands.findIndex((h) => h.id === opts.select));
    this.root = document.createElement('div');
    this.root.className = `overlay hh-overlay${opts.fourColor ? ' four-color' : ''}`;
    document.body.appendChild(this.root);
    // Capture keys before the table underneath sees them.
    window.addEventListener('keydown', this.keys, true);
    this.pick(this.sel);
  }

  close(notify = true) {
    clearInterval(this.timer);
    clearTimeout(this.shareTimer);
    window.removeEventListener('keydown', this.keys, true);
    this.root.remove();
    if (open === this) open = null;
    if (notify) this.opts.onClose?.();
  }

  private pick(i: number) {
    this.stop();
    this.sel = i;
    const h = this.hands[i];
    this.frames = h ? replayFrames(h) : [];
    this.k = 0;
    this.render();
    this.root.querySelector<HTMLElement>(`.hh-item[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private go(k: number) {
    this.k = Math.max(0, Math.min(this.frames.length - 1, k));
    if (this.k === this.frames.length - 1) this.stop();
    this.render();
  }

  private get playing() {
    return this.timer !== 0;
  }

  private play() {
    if (this.playing) return this.stop(), this.render();
    if (this.k >= this.frames.length - 1) this.k = 0;
    this.timer = window.setInterval(() => this.go(this.k + 1), PLAY_MS);
    this.go(this.k + 1);
  }

  private stop() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  /** Hands the link to the phone's share sheet, or copies it. */
  private async share() {
    const h = this.hands[this.sel];
    if (!h || this.opts.shared) return;
    let note = 'Link copied';
    try {
      const url = await shareLink(h);
      if (isPhone() && typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: `A ${VARIANTS[h.variant].name} hand`, text: 'Watch how this hand played out', url });
          note = '';
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') return;
          throw e;
        }
      } else {
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          prompt('Copy this link:', url);
          note = '';
        }
      }
    } catch {
      note = "Couldn't make a link";
    }
    if (open !== this) return;
    this.shareNote = note;
    clearTimeout(this.shareTimer);
    this.shareTimer = window.setTimeout(() => ((this.shareNote = ''), open === this && this.render()), 2500);
    this.render();
  }

  private chapterJump(dir: 1 | -1) {
    this.stop();
    const marks = chapters(this.frames).map((c) => c.at);
    const target = dir > 0 ? marks.find((a) => a > this.k) ?? this.frames.length - 1 : [...marks].reverse().find((a) => a < this.k) ?? 0;
    this.go(target);
  }

  private onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.stopPropagation();
    const k = e.key;
    if (k === 'Escape') this.close();
    else if (k === 'ArrowRight') (this.stop(), this.go(this.k + 1));
    else if (k === 'ArrowLeft') (this.stop(), this.go(this.k - 1));
    else if (k === ' ') this.play();
    else if (k === 'Home') (this.stop(), this.go(0));
    else if (k === 'End') (this.stop(), this.go(this.frames.length - 1));
    else if (k === 'ArrowDown' && this.sel < this.hands.length - 1) this.pick(this.sel + 1);
    else if (k === 'ArrowUp' && this.sel > 0) this.pick(this.sel - 1);
    else if ((k === 's' || k === 'S') && !e.ctrlKey && !e.metaKey && !this.opts.shared) void this.share();
    else return;
    e.preventDefault();
  }

  private render() {
    const h = this.hands[this.sel];
    const shared = this.opts.shared;
    const broken = shared === null;
    const sharer = shared?.players[shared.me]?.name;
    const listScroll = this.root.querySelector('.hh-list')?.scrollTop;
    const stepsScroll = this.root.querySelector('.hh-steps');
    this.root.innerHTML = `
    <div class="hh" role="dialog" aria-modal="true" aria-labelledby="hh-title">
      <header class="hh-head">
        <h2 id="hh-title">${shared || broken ? 'Shared hand' : 'Hand history'}</h2>
        <span class="hh-sub">${shared ? `Played from ${sharer ? esc(sharer) : 'a friend'}’s seat` : this.hands.length ? `Your last ${this.hands.length === 1 ? 'hand' : `${this.hands.length} hands`} on this device` : ''}</span>
        <button type="button" class="icon-btn" id="hh-close" aria-label="Close hand history">✕</button>
      </header>
      ${h ? `<div class="hh-body${shared ? ' solo' : ''}">
        ${shared ? '' : `<nav class="hh-list" aria-label="Saved hands">${this.hands.map((x, i) => this.itemHtml(x, i)).join('')}</nav>`}
        <section class="hh-replay" aria-label="Replay">${this.replayHtml(h)}</section>
      </div>` : broken ? `<div class="hh-empty">
        <p><b>This hand can’t be shown.</b></p>
        <p>The link may have been cut short when it was copied. Ask your friend to send it again.</p>
      </div>` : `<div class="hh-empty">
        <p><b>No hands saved yet.</b></p>
        <p>Every poker hand you play is kept here, your last ${HANDS_KEPT} on this device, so you can step back through how it went street by street.</p>
      </div>`}
    </div>`;
    const list = this.root.querySelector('.hh-list');
    if (list && listScroll !== undefined) list.scrollTop = listScroll;
    const steps = this.root.querySelector<HTMLElement>('.hh-steps');
    if (steps) {
      if (stepsScroll) steps.scrollTop = stepsScroll.scrollTop;
      const cur = steps.querySelector<HTMLElement>('[aria-current="step"]');
      if (cur && (cur.offsetTop < steps.scrollTop || cur.offsetTop + cur.offsetHeight > steps.scrollTop + steps.clientHeight)) {
        steps.scrollTop = cur.offsetTop - steps.clientHeight / 2;
      }
    }
    this.bind();
  }

  private itemHtml(h: HandHistory, i: number): string {
    const v = VARIANTS[h.variant];
    const net = historyNet(h);
    const me = h.players[h.me];
    const cards = (me?.cards ?? []).slice(0, v.family === 'stud' ? 3 : v.holeCards);
    return `<button type="button" class="hh-item" data-i="${i}" ${i === this.sel ? 'aria-current="true"' : ''}>
      <span class="hh-cards${cards.length > 2 ? ' many' : ''}">${cards.map(miniCard).join('')}</span>
      <span class="hh-what"><b>${esc(v.name)}</b><span>${esc(h.where)} · Hand ${h.number} · ${ago(h.at)}</span></span>
      <b class="hh-net ${net > 0 ? 'up' : net < 0 ? 'down' : ''}">${signed(net)}</b>
    </button>`;
  }

  private replayHtml(h: HandHistory): string {
    const f = this.frames[this.k];
    const v = VARIANTS[h.variant];
    const marks = chapters(this.frames);
    const s = h.stakes;
    const stakes = v.family === 'stud' ? `${fmt(s.smallBet)}/${fmt(s.bigBet)}` : `${fmt(s.sb)}/${fmt(s.bb)}`;
    const when = new Date(h.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const shareBtn = this.opts.shared ? '' : `<button type="button" class="btn btn-sm hh-share" id="hh-share" title="Send this hand to a friend (S)">${icon(ICONS.share)}<span>${esc(this.shareNote || 'Share')}</span></button>`;
    const at = this.k;
    const chapterNow = f.chapter;
    return `
      <div class="hh-info"><b>${STRUCTURE_NAMES[h.structure]} ${esc(v.name)}</b> <span>${stakes} · ${esc(h.where)} · Hand ${h.number} · ${when}</span>${shareBtn}</div>
      <div class="hh-felt">${this.feltHtml(h, f)}</div>
      <p class="hh-caption ${f.final ? 'final' : ''}" role="status"><span class="hh-chap">${esc(f.chapter)}</span>${esc(f.text)}</p>
      <div class="hh-controls">
        <button type="button" class="icon-btn" data-go="first" title="Previous street">${icon(ICONS.first)}</button>
        <button type="button" class="icon-btn" data-go="prev" title="Step back (←)">${icon(ICONS.prev)}</button>
        <button type="button" class="icon-btn hh-play" data-go="play" title="${this.playing ? 'Pause' : 'Play'} (Space)">${icon(this.playing ? ICONS.pause : ICONS.play)}<span>${this.playing ? 'Pause' : at >= this.frames.length - 1 ? 'Replay' : 'Play'}</span></button>
        <button type="button" class="icon-btn" data-go="next" title="Step forward (→)">${icon(ICONS.next)}</button>
        <button type="button" class="icon-btn" data-go="last" title="Next street">${icon(ICONS.last)}</button>
        <span class="hh-count">${at + 1} / ${this.frames.length}</span>
      </div>
      <div class="hh-chapters" role="group" aria-label="Streets">
        ${marks.map((c) => `<button type="button" data-at="${c.at}" aria-pressed="${c.name === chapterNow}">${esc(c.name)}</button>`).join('')}
      </div>
      <ol class="hh-steps">${this.frames.map((x, k) => {
        const head = marks.find((c) => c.at === k && k > 0);
        return `${head ? `<li class="hh-step-head">${esc(head.name)}</li>` : ''}<li><button type="button" data-step="${k}" class="${x.actor === h.me ? 'me' : ''}${x.final ? ' final' : ''}" ${k === at ? 'aria-current="step"' : ''}>${esc(x.text)}</button></li>`;
      }).join('')}</ol>`;
  }

  private feltHtml(h: HandHistory, f: Frame): string {
    const n = f.players.length;
    const v = VARIANTS[h.variant];
    const seats = f.players.map((p, i) => {
      const a = Math.PI / 2 + ((i - h.me) * 2 * Math.PI) / n;
      const x = 50 + 42 * Math.cos(a);
      const y = 50 + 38 * Math.sin(a);
      const cls = ['hh-seat', i === h.me ? 'me' : '', p.status === 'folded' ? 'folded' : '', f.actor === i ? 'acting' : '', p.won > 0 ? 'winner' : ''].filter(Boolean).join(' ');
      const cards = p.cards.map((c) => cardHtml(c.card, c.up ? 'upcard' : '')).join('');
      const tag = f.final ? (p.won > 0 ? `Wins ${fmt(p.won)}` : p.handName ?? '') : p.action ?? '';
      const btn = v.family !== 'stud' && h.button === i ? '<span class="hh-dealer" title="Dealer button">D</span>' : '';
      const bet = p.bet > 0 ? `<span class="hh-bet" style="left:${50 + 27 * Math.cos(a)}%;top:${48 + 16 * Math.sin(a)}%">${fmt(p.bet)}</span>` : '';
      return `${bet}<div class="${cls}" style="left:${x}%;top:${y}%">
        <div class="hh-hole">${cards}</div>
        <div class="hh-plate">${btn}<b>${esc(p.name)}</b><span>${fmt(p.stack)}</span></div>
        ${tag ? `<span class="hh-tag">${esc(f.final && p.won > 0 && p.handName ? `${tag} · ${p.handName}` : tag)}</span>` : ''}
      </div>`;
    }).join('');
    const board = f.board.map((c) => cardHtml(c)).join('');
    return `${seats}<div class="hh-center"><div class="hh-board">${board}</div><span class="hh-pot">Pot <b>${fmt(f.pot)}</b></span></div>`;
  }

  private bind() {
    this.root.querySelector<HTMLElement>('#hh-close')!.onclick = () => this.close();
    const shareBtn = this.root.querySelector<HTMLElement>('#hh-share');
    if (shareBtn) shareBtn.onclick = () => void this.share();
    this.root.onclick = (e) => {
      if (e.target === this.root) this.close();
    };
    this.root.querySelectorAll<HTMLButtonElement>('.hh-item').forEach((b) => (b.onclick = () => this.pick(Number(b.dataset.i))));
    this.root.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) => (b.onclick = () => (this.stop(), this.go(Number(b.dataset.step)))));
    this.root.querySelectorAll<HTMLButtonElement>('[data-at]').forEach((b) => (b.onclick = () => (this.stop(), this.go(Number(b.dataset.at)))));
    this.root.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => (b.onclick = () => {
      const g = b.dataset.go;
      if (g === 'play') return this.play();
      if (g === 'first') return this.chapterJump(-1);
      if (g === 'last') return this.chapterJump(1);
      this.stop();
      this.go(this.k + (g === 'next' ? 1 : -1));
    }));
  }
}
