// The slot machine: three reels behind glass, one to five pay lines, and a coin a line from
// the chip bank. The stake comes out on the pull, the reels stop one after another, and
// whatever the lines pay goes back into the bank once the last reel lands.
import { credit, setBlackjackBank, slotsTally } from '../../accounts';
import { createRng } from '../../engine/cards';
import { LINES, LINE_NAMES, MAX_LINES, PAYS, PayId, REELS, ROW_COUNT, SlotSpin, Sym, SYMBOL_NAMES, highRollStops, settleSpin, spinSlots, windowAt } from '../../engine/slots';
import { esc, fmt } from '../dom';
import { setSlotsHighRoll, slotsHighRoll } from '../console';
import { HouseTable, chipRackHtml, houseCardHtml, seg } from './house';
import { play } from '../sound';

// ---------- lobby settings ----------

export interface SlSetup {
  /** Chips a line. */
  chip: number;
  lines: number;
}

export const DEFAULT_SL: SlSetup = { chip: 5, lines: MAX_LINES };
/** Coin sizes, in chips a line. */
export const SL_DENOMS = [5, 25, 100, 500];
export const SLOT_NAME = 'Lucky Sevens';

// ---------- symbols ----------

const CROWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="g" d="M3 8.5 7.5 12 12 4.5 16.5 12 21 8.5 19.2 18H4.8Z"/><rect class="g" x="4.6" y="19" width="14.8" height="2.4" rx="1"/><circle class="j" cx="12" cy="14.2" r="1.6"/><circle class="g" cx="3" cy="8" r="1.4"/><circle class="g" cx="21" cy="8" r="1.4"/><circle class="g" cx="12" cy="4" r="1.4"/></svg>';
const CHIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="c" cx="12" cy="12" r="10.5"/><circle class="e" cx="12" cy="12" r="9" pathLength="24"/><circle class="i" cx="12" cy="12" r="5.6"/><text x="12" y="14.6" text-anchor="middle">$</text></svg>';
const GLYPH: Partial<Record<Sym, string>> = { spade: '♠︎', heart: '♥︎', diamond: '♦︎', club: '♣︎', seven: '7' };

export function symHtml(sym: Sym, extra = ''): string {
  const art = sym === 'crown' ? CROWN : sym === 'chip' ? CHIP : `<b>${GLYPH[sym]}</b>`;
  return `<span class="sl-sym s-${sym} ${extra}" role="img" aria-label="${SYMBOL_NAMES[sym]}">${art}</span>`;
}

/** The pay table: what each line pays, in coins. */
function payTableHtml(lit: Set<PayId>, compact = false): string {
  return `<ul class="sl-pays${compact ? ' small' : ''}" aria-label="${SLOT_NAME} pays, in coins a line">${PAYS.map((p) => {
    const show = p.show.map((s) => symHtml(s)).join('') + (p.show.length < 3 ? '<span class="sl-any">any</span>'.repeat(3 - p.show.length) : '');
    return `<li class="${lit.has(p.id) ? 'hit' : ''}" title="${esc(p.name)}"><span class="sl-pay-syms">${show}</span><b>${fmt(p.pays)}</b></li>`;
  }).join('')}</ul>`;
}

export function slSetupCardHtml(sl: SlSetup, bank: number, refillable: boolean): string {
  return houseCardHtml({
    name: SLOT_NAME,
    rules: 'Slot machine · three reels, up to five lines',
    min: SL_DENOMS[0], bank, refillable,
    fields: `
      <div class="field">
        <span class="flabel">Pay lines</span>
        ${seg('sl-lines', Array.from({ length: MAX_LINES }, (_, i) => [String(i + 1), String(i + 1)] as [string, string]), String(sl.lines))}
        <span class="hint">One coin a line. The lines are the three rows, then the two diagonals. Pick the coin size at the machine, from ${fmt(SL_DENOMS[0])} to ${fmt(SL_DENOMS[SL_DENOMS.length - 1])} chips.</span>
      </div>
      <div class="field">
        <span class="flabel">Pays, in coins a line</span>
        ${payTableHtml(new Set(), true)}
        <span class="hint">Symbols pay left to right along a line you bought. Three sevens pay 500 coins, and the machine pays back about 95% over time.</span>
      </div>`,
  });
}

export function bindSlSetupCard(sl: SlSetup, update: (fn: () => void) => void) {
  document.querySelectorAll<HTMLButtonElement>('[data-sl-lines]').forEach((b) => (b.onclick = () => update(() => (sl.lines = Number(b.dataset.slLines)))));
}

// ---------- the machine ----------

/** How long the first reel spins, and how much later each next one stops. */
const SPIN_MS: Record<'relaxed' | 'normal' | 'fast', [number, number]> = { relaxed: [1500, 420], normal: [1100, 320], fast: [500, 160] };
/** Symbols that roll past on a reel before it lands. */
const ROLL = 14;

/** Row centres of each line on the 300 × 300 window, for drawing the lines over the reels. */
const linePoints = (line: number) => LINES[line].map((row, reel) => `${50 + reel * 100},${50 + row * 100}`).join(' ');

export class SlotsTable extends HouseTable<SlSetup> {
  protected readonly title = 'Slots';
  protected readonly cls = 'slots';
  protected readonly guideId = 'slots' as const;
  private readonly rng = createRng();
  /** The reels where they stand now. */
  private stops: number[] = REELS.map((strip) => Math.floor(Math.random() * strip.length));
  /** A pull in progress: the reels are turning and the win isn't paid yet. */
  private spinning: SlotSpin | null = null;
  /** The spin in play was fixed by the console, so it earns no achievements. */
  private rigged = false;
  private result: SlotSpin | null = null;
  private landTimer: number | undefined;
  private note = '';
  private noteTimer: number | undefined;

  protected get chips() {
    return SL_DENOMS;
  }

  private get bet(): number {
    return this.h.setup.lines * this.h.setup.chip;
  }

  protected infoHtml() {
    const flag = slotsHighRoll() ? ' · <button type="button" class="dev-flag reveal-flag" id="highroll-off" title="Turned on with the console\'s highroll. Tap to turn it off.">High roll ✕</button>' : '';
    return `${SLOT_NAME} · Coin <b>${fmt(this.h.setup.chip)}</b>${flag}`;
  }

  private say(text: string) {
    this.note = text;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      this.note = '';
      if (!this.spinning) this.render();
    }, 2600);
    if (!this.spinning) this.render();
  }

  private cycleLines() {
    if (this.spinning) return;
    this.h.setup.lines = (this.h.setup.lines % MAX_LINES) + 1;
    this.h.save();
    this.result = null;
    play('chips');
    this.render();
  }

  private spinMax() {
    if (this.spinning) return;
    this.h.setup.lines = MAX_LINES;
    this.h.save();
    this.spin();
  }

  // ---------- the pull ----------

  private spin() {
    if (this.spinning || this.stopped) return;
    const { chip, lines } = this.h.setup;
    if (this.bet > this.bank) {
      const fits = Math.min(MAX_LINES, Math.floor(this.bank / chip));
      if (fits < 1) return this.say('Your bank can’t cover a coin this size.');
      return this.say(`Your bank covers ${fits} line${fits > 1 ? 's' : ''} of ${fmt(chip)}, not ${lines}.`);
    }
    // The console's highroll fixes the reels on three sevens.
    this.rigged = slotsHighRoll();
    const s = this.rigged ? settleSpin(highRollStops(), lines, chip) : spinSlots(lines, chip, this.rng);
    setBlackjackBank(this.profile, this.bank - s.staked);
    this.spinning = s;
    this.result = null;
    this.note = '';
    this.stops = s.stops;
    this.render();

    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const [first, gap] = reduce ? [150, 0] : SPIN_MS[this.h.prefs.speed] ?? SPIN_MS.normal;
    play('chips');
    document.querySelectorAll<HTMLElement>('.sl-strip').forEach((el, reel) => {
      const ms = first + reel * gap;
      const cells = Number(el.dataset.cells);
      // The strip starts on the old window, at its far end, and rolls down to the new one.
      const startPct = -((cells - ROW_COUNT) / cells) * 100;
      if (typeof el.animate === 'function') {
        el.animate([{ transform: `translateY(${startPct}%)` }, { transform: 'translateY(0%)' }], { duration: ms, easing: 'cubic-bezier(.25,.6,.3,1)', fill: 'backwards' });
      }
      play('reel', ms / 1000);
    });
    this.landTimer = window.setTimeout(() => this.land(), first + (REELS.length - 1) * gap + 80);
  }

  /** The last reel has stopped: pay the lines. */
  private land() {
    const s = this.spinning;
    if (!s) return;
    this.spinning = null;
    this.result = s;
    setBlackjackBank(this.profile, this.bank + s.paid);
    if (!this.rigged) credit(this.profile, slotsTally(s));
    if (s.wins.some((w) => w.pay === 'sevens' || w.pay === 'crowns')) play('blackjack');
    else if (s.paid > s.staked) play('win');
    else if (s.paid) play('chips');
    if (!this.stopped) this.render();
  }

  protected finish() {
    clearTimeout(this.noteTimer);
    clearTimeout(this.landTimer);
    // Walking away mid-spin still pays: the reels were already decided.
    this.land();
  }

  // ---------- drawing ----------

  /** One reel's strip: the new window on top, the symbols it rolls past, then the old window. */
  private stripHtml(reel: number, rolling: boolean, wonCells: Set<string>): string {
    const strip = REELS[reel];
    const at = (i: number) => strip[((i % strip.length) + strip.length) % strip.length];
    const stop = this.stops[reel];
    const syms: Sym[] = [at(stop - 1), at(stop), at(stop + 1)];
    if (rolling) for (let k = 0; k < ROLL + ROW_COUNT; k++) syms.push(at(stop + 2 + k));
    const cells = syms.map((sym, i) => `<span class="sl-cell${i < ROW_COUNT && wonCells.has(`${reel}:${i}`) ? ' won' : ''}">${symHtml(sym)}</span>`).join('');
    return `<div class="sl-strip" data-cells="${syms.length}" style="--cells:${syms.length}">${cells}</div>`;
  }

  protected feltHtml(): string {
    const r = this.result;
    const rolling = !!this.spinning;
    const lines = (this.spinning ?? r)?.lines ?? this.h.setup.lines;
    const won = new Set(r?.wins.map((w) => w.line) ?? []);
    const wonCells = new Set<string>();
    if (r) {
      const grid = windowAt(r.stops);
      for (const w of r.wins) {
        const syms = LINES[w.line].map((row, reel) => grid[reel][row]);
        // Mark only the symbols that make the win: all three, or the chips on a chip win.
        LINES[w.line].forEach((row, reel) => {
          if ((w.pay !== 'twoChips' && w.pay !== 'oneChip') || syms[reel] === 'chip') {
            if (w.pay !== 'oneChip' || reel === 0) wonCells.add(`${reel}:${row}`);
          }
        });
      }
    }
    const reels = REELS.map((_, reel) => `<div class="sl-reel">${this.stripHtml(reel, rolling, wonCells)}</div>`).join('');
    const overlay = `<svg class="sl-lines" viewBox="0 0 300 300" preserveAspectRatio="none" aria-hidden="true">${
      LINES.map((_, i) => (won.has(i) ? `<polyline points="${linePoints(i)}" class="on"/>` : '')).join('')}</svg>`;
    // Numbered lamps on both sides, level with where each line starts and ends.
    const lamp = (i: number) => `<span class="sl-lamp${i < lines ? ' bought' : ''}${won.has(i) ? ' won' : ''}" title="Line ${i + 1}: ${LINE_NAMES[i]}">${i + 1}</span>`;
    const side = (rowsAtEdge: number[][]) => `<div class="sl-lamps">${rowsAtEdge.map((ls) => `<div>${ls.map(lamp).join('')}</div>`).join('')}</div>`;
    const edge = (end: 0 | 2) => [0, 1, 2].map((row) => LINES.map((l, i) => (l[end] === row ? i : -1)).filter((i) => i >= 0));
    let msg = '';
    let cls = '';
    if (rolling) msg = 'Good luck…';
    else if (r && r.wins.length) {
      const best = r.wins.reduce((a, b) => (b.amount > a.amount ? b : a));
      const what = r.wins.length > 1 ? `${r.wins.length} lines pay` : PAYS.find((p) => p.id === best.pay)!.name;
      msg = `${what} · Win ${fmt(r.paid)}`;
      cls = 'won';
    } else if (r) {
      msg = 'No win';
      cls = 'lost';
    } else msg = `${lines} line${lines > 1 ? 's' : ''} · pull to spin`;
    const lit = new Set(r?.wins.map((w) => w.pay) ?? []);
    return `<div class="sl-machine">
      <div class="sl-cabinet">
        <div class="sl-marquee">${SLOT_NAME}</div>
        <div class="sl-glass">${payTableHtml(lit)}</div>
        <div class="sl-window-row">
          ${side(edge(0))}
          <div class="sl-window${rolling ? ' rolling' : ''}">${reels}${overlay}</div>
          ${side(edge(2))}
        </div>
        <div class="sl-msg ${cls}" role="status">${esc(msg)}</div>
        <div class="vp-meters">
          <span>Lines <b>${lines}</b></span>
          <span>Bet <b>${fmt(lines * ((this.spinning ?? r)?.coin ?? this.h.setup.chip))}</b></span>
          <span>Win <b class="${r?.paid ? 'up' : ''}">${fmt(r?.paid ?? 0)}</b></span>
        </div>
      </div>
    </div>`;
  }

  protected dockHtml(): string {
    const busy = !!this.spinning;
    if (!busy && this.bank < SL_DENOMS[0]) {
      return `<span class="status bj-status left"><span class="bj-short">Your bank has ${fmt(this.bank)}, short of a ${fmt(SL_DENOMS[0])} coin. You can refill it from the menu.</span></span>
        <div class="acts"><button type="button" class="act fold" id="h-menu">Back to menu</button></div>`;
    }
    let status = '';
    if (this.note) status = `<span class="bj-short">${esc(this.note)}</span>`;
    else if (busy) status = '<span class="bj-hint">The reels are turning.</span>';
    else if (this.result) {
      const r = this.result;
      status = `<span class="bj-last ${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}"><b>${r.net > 0 ? `You win ${fmt(r.net)}` : r.net < 0 ? `You lose ${fmt(-r.net)}` : 'Your bet comes back'}</b></span>`;
    } else status = '<span class="bj-hint">Pick a coin size and how many lines, then spin.</span>';
    return `<div class="bj-betting">
        <div class="bj-bet"><span class="sl">Lines</span><b>${this.h.setup.lines} × ${fmt(this.h.setup.chip)}</b><span class="ss">Bank ${fmt(this.bank)}</span></div>
        ${chipRackHtml(this.chips, this.h.setup.chip, busy ? -1 : Infinity)}
        <div class="bj-bet-tools">
          <button type="button" class="preset" id="sl-lines" ${busy ? 'disabled' : ''}>Lines<kbd>L</kbd></button>
        </div>
      </div>
      <span class="status bj-status">${status}</span>
      <div class="acts"><button type="button" class="act call" id="sl-max" ${busy ? 'disabled' : ''}>Spin max<kbd>X</kbd></button><button type="button" class="act raise" id="sl-spin" ${busy ? 'disabled' : ''}>Spin<kbd>Space</kbd></button></div>`;
  }

  protected bindGame() {
    this.on('h-menu', () => this.h.leave());
    this.on('sl-lines', () => this.cycleLines());
    this.on('sl-max', () => this.spinMax());
    this.on('sl-spin', () => this.spin());
    this.on('highroll-off', () => {
      setSlotsHighRoll(false);
      this.render();
    });
  }

  protected onKey(k: string, e: KeyboardEvent) {
    if (k === ' ' || k === 'enter') this.click('sl-spin', e);
    else if (k === 'l') this.click('sl-lines', e);
    else if (k === 'x') this.click('sl-max', e);
  }
}
