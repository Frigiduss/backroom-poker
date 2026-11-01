// The video poker machine: bet one to five coins, get five cards, tap the ones to hold, and
// draw once. The pay table sits on the glass above the cards, lit on the column for the coins
// bet and the line the hand makes. Bets come out of the chip bank on the deal and winnings
// go back on the draw.
import { credit, setBlackjackBank, videoPokerTally } from '../accounts';
import { createRng } from '../engine/cards';
import { LINE_NAMES, MACHINES, MACHINE_NAMES, MAX_COINS, Machine, PAY_TABLES, PayLine, VpHand, VpResult, dealVp, drawVp, linePays, payLine, settleVp } from '../engine/videopoker';
import { cardHtml, esc, fmt } from './dom';
import { HouseTable, chipRackHtml, houseCardHtml, seg } from './house';
import { play } from './sound';

// ---------- lobby settings ----------

export interface VpSetup {
  machine: Machine;
  /** Chips per coin. */
  chip: number;
  coins: number;
}

export const DEFAULT_VP: VpSetup = { machine: 'jacks', chip: 5, coins: MAX_COINS };
/** Coin sizes, in chips. */
export const VP_DENOMS = [5, 25, 100, 500];

const SHORT: Record<Machine, string> = { jacks: 'Jacks', bonus: 'Bonus', ddb: 'Double Double' };
const RULES: Record<Machine, string> = {
  jacks: 'Full pay 9/6 · a pair of jacks or better pays',
  bonus: 'Full pay 8/5 · extra for four aces, twos, threes and fours',
  ddb: 'Full pay 9/6 · huge four-of-a-kind bonuses with the right kicker',
};

/** The pay table as a grid: one row per line, one column per coin bet. */
function payTableHtml(machine: Machine, coins: number, lit: PayLine | null, won: boolean): string {
  const rows = PAY_TABLES[machine].map(([line]) => {
    const cells = Array.from({ length: MAX_COINS }, (_, i) => {
      const n = i + 1;
      return `<td class="${n === coins ? 'on' : ''}">${fmt(linePays(machine, line, n) * n)}</td>`;
    }).join('');
    return `<tr class="${line === lit ? (won ? 'hit' : 'made') : ''}"><th scope="row">${esc(LINE_NAMES[line])}</th>${cells}</tr>`;
  }).join('');
  return `<table class="vp-pays" aria-label="${MACHINE_NAMES[machine]} pay table, in coins"><tbody>${rows}</tbody></table>`;
}

export function vpSetupCardHtml(vp: VpSetup, bank: number, refillable: boolean): string {
  return houseCardHtml({
    name: MACHINE_NAMES[vp.machine],
    rules: `Video poker · ${RULES[vp.machine]}`,
    min: VP_DENOMS[0], bank, refillable,
    fields: `
      <div class="field">
        <span class="flabel">Machine</span>
        ${seg('vp-machine', MACHINES.map((m) => [m, SHORT[m]]), vp.machine)}
      </div>
      <div class="field">
        <span class="flabel">How it plays</span>
        <span class="hint">Bet one to five coins and you get five cards. Tap the ones you want to keep, then draw once to replace the rest. The final hand pays from the table on the machine. Pick the coin size at the machine, from ${fmt(VP_DENOMS[0])} to ${fmt(VP_DENOMS[VP_DENOMS.length - 1])} chips.</span>
      </div>
      <div class="field">
        <span class="flabel">Pays, in coins</span>
        <div class="vp-pays-wrap small">${payTableHtml(vp.machine, vp.coins, null, false)}</div>
        <span class="hint">A royal flush pays 4,000 coins on five coins but only 250 a coin on fewer, so play five.</span>
      </div>`,
  });
}

export function bindVpSetupCard(vp: VpSetup, update: (fn: () => void) => void) {
  document.querySelectorAll<HTMLButtonElement>('[data-vp-machine]').forEach((b) => (b.onclick = () => update(() => (vp.machine = b.dataset.vpMachine as Machine))));
}

// ---------- the machine ----------

export class VideoPokerTable extends HouseTable<VpSetup> {
  protected readonly title = 'Video Poker';
  protected readonly cls = 'vp';
  protected readonly guideId = 'videopoker' as const;
  protected readonly numberKeysPickChips = false;
  private readonly rng = createRng();
  private hand: VpHand | null = null;
  private result: VpResult | null = null;
  /** Which cards to animate on the next render: all five on a deal, the new ones on a draw. */
  private fresh: boolean[] = [];
  private note = '';
  private noteTimer: number | undefined;

  protected get chips() {
    return VP_DENOMS;
  }

  private get machine(): Machine {
    return this.hand?.machine ?? this.h.setup.machine;
  }

  private get holding(): boolean {
    return !!this.hand && !this.hand.drawn;
  }

  private get bet(): number {
    return this.h.setup.coins * this.h.setup.chip;
  }

  protected infoHtml() {
    return `${MACHINE_NAMES[this.machine]} · Coin <b>${fmt(this.h.setup.chip)}</b>`;
  }

  private say(text: string) {
    this.note = text;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      this.note = '';
      this.render();
    }, 2600);
    this.render();
  }

  // ---------- coins ----------

  private betOne() {
    if (this.holding) return;
    this.h.setup.coins = (this.h.setup.coins % MAX_COINS) + 1;
    this.h.save();
    play('chips');
    this.render();
  }

  private betMax() {
    if (this.holding) return;
    this.h.setup.coins = MAX_COINS;
    this.h.save();
    this.deal();
  }

  // ---------- the hand ----------

  private deal() {
    if (this.holding || this.stopped) return;
    const { chip, coins } = this.h.setup;
    if (this.bet > this.bank) {
      // Drop to as many coins as the bank covers before giving up.
      const fits = Math.floor(this.bank / chip);
      if (fits < 1) return this.say('Your bank can’t cover a coin this size.');
      return this.say(`Your bank covers ${fits} coin${fits > 1 ? 's' : ''} of ${fmt(chip)}, not ${coins}.`);
    }
    setBlackjackBank(this.profile, this.bank - this.bet);
    this.hand = dealVp(this.h.setup.machine, coins, chip, this.rng);
    this.result = null;
    this.fresh = [true, true, true, true, true];
    this.note = '';
    play('deal');
    this.render();
  }

  private toggle(i: number) {
    if (!this.holding || !this.hand) return;
    this.hand.held[i] = !this.hand.held[i];
    play('check');
    this.render();
  }

  private draw() {
    if (!this.holding || !this.hand) return;
    this.settle();
    play(this.result!.line === 'royal' ? 'blackjack' : this.result!.paid ? 'win' : 'flip');
    this.render();
  }

  private settle() {
    if (!this.holding || !this.hand) return;
    this.fresh = this.hand.held.map((h) => !h);
    this.hand = drawVp(this.hand);
    const r = settleVp(this.hand);
    this.result = r;
    setBlackjackBank(this.profile, this.bank + r.paid);
    credit(this.profile, videoPokerTally(this.hand, r));
  }

  protected finish() {
    clearTimeout(this.noteTimer);
    // Walking away mid-hand draws to whatever is held: the coins are already in the machine.
    this.settle();
  }

  // ---------- drawing ----------

  protected feltHtml(): string {
    const hand = this.hand;
    const r = this.result;
    const made = hand && !hand.drawn ? payLine(hand.cards, hand.machine) : null;
    const lit = r ? r.line : made;
    const cards = Array.from({ length: 5 }, (_, i) => {
      const card = hand ? hand.cards[i] : null;
      const held = !!hand?.held[i];
      const anim = this.fresh[i] ? 'deal' : '';
      // New cards turn over one after another.
      const face = cardHtml(card, anim).replace('class="card', `style="--i:${this.fresh.slice(0, i).filter(Boolean).length}" class="card`);
      return `<button type="button" class="vp-card ${held ? 'held' : ''}" data-vp-card="${i}" ${this.holding ? '' : 'disabled'} aria-pressed="${held}" aria-label="${held ? 'Held' : 'Hold'} card ${i + 1}">
        <span class="vp-held">Held</span>${face}<kbd>${i + 1}</kbd>
      </button>`;
    }).join('');
    // Cards only animate on the render right after they come out.
    this.fresh = [];
    let msg = '';
    let cls = '';
    if (r) {
      msg = r.line ? `${LINE_NAMES[r.line]} · Win ${fmt(r.paid)}` : 'No win';
      cls = r.line ? 'won' : 'lost';
    } else if (made) msg = `You have ${LINE_NAMES[made]}`;
    else if (this.holding) msg = 'Hold cards, then draw';
    else msg = `Bet ${this.h.setup.coins} coin${this.h.setup.coins > 1 ? 's' : ''} and deal`;
    return `<div class="vp-machine">
      <div class="vp-cabinet">
        <div class="vp-marquee">${esc(MACHINE_NAMES[this.machine])}</div>
        <div class="vp-pays-wrap">${payTableHtml(this.machine, hand?.coins ?? this.h.setup.coins, lit, !!r?.line)}</div>
        <div class="vp-screen">
          <div class="vp-cards">${cards}</div>
          <div class="vp-msg ${cls}" role="status">${esc(msg)}</div>
        </div>
        <div class="vp-meters">
          <span>Coins <b>${hand?.coins ?? this.h.setup.coins}</b></span>
          <span>Bet <b>${fmt(hand ? hand.coins * hand.denom : this.bet)}</b></span>
          <span>Win <b class="${r?.paid ? 'up' : ''}">${fmt(r?.paid ?? 0)}</b></span>
        </div>
      </div>
    </div>`;
  }

  protected dockHtml(): string {
    const busy = this.holding;
    if (!busy && this.bank < VP_DENOMS[0]) {
      return `<span class="status bj-status left"><span class="bj-short">Your bank has ${fmt(this.bank)}, short of a ${fmt(VP_DENOMS[0])} coin. You can refill it from the menu.</span></span>
        <div class="acts"><button type="button" class="act fold" id="h-menu">Back to menu</button></div>`;
    }
    let status = '';
    if (this.note) status = `<span class="bj-short">${esc(this.note)}</span>`;
    else if (busy) status = '<span class="bj-hint">Tap a card or press <b>1</b>–<b>5</b> to hold it.</span>';
    else if (this.result) {
      const r = this.result;
      status = `<span class="bj-last ${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}"><b>${r.net > 0 ? `You win ${fmt(r.net)}` : r.net < 0 ? `You lose ${fmt(-r.net)}` : 'Your bet comes back'}</b></span>`;
    } else status = '<span class="bj-hint">Pick a coin size, then Bet one or Bet max.</span>';
    return `<div class="bj-betting">
        <div class="bj-bet"><span class="sl">Coins</span><b>${this.h.setup.coins} × ${fmt(this.h.setup.chip)}</b><span class="ss">Bank ${fmt(this.bank)}</span></div>
        ${chipRackHtml(this.chips, this.h.setup.chip, busy ? -1 : Infinity)}
        <div class="bj-bet-tools">
          <button type="button" class="preset" id="vp-one" ${busy ? 'disabled' : ''}>Bet one<kbd>B</kbd></button>
        </div>
      </div>
      <span class="status bj-status">${status}</span>
      <div class="acts">${busy ? '' : `<button type="button" class="act call" id="vp-max">Bet max<kbd>X</kbd></button>`}<button type="button" class="act raise" id="vp-deal">${busy ? 'Draw' : 'Deal'}<kbd>Space</kbd></button></div>`;
  }

  protected settingsExtraHtml(): string {
    return `<label class="toggle"><input type="checkbox" data-pref="fourColor" ${this.h.prefs.fourColor ? 'checked' : ''}> Four-colour deck (blue diamonds, green clubs)</label>`;
  }

  protected bindGame() {
    this.on('h-menu', () => this.h.leave());
    this.on('vp-one', () => this.betOne());
    this.on('vp-max', () => this.betMax());
    this.on('vp-deal', () => (this.holding ? this.draw() : this.deal()));
    document.querySelectorAll<HTMLButtonElement>('[data-vp-card]').forEach((b) => (b.onclick = () => this.toggle(Number(b.dataset.vpCard))));
  }

  protected onKey(k: string, e: KeyboardEvent) {
    const n = Number(k);
    if (n >= 1 && n <= 5 && this.holding) {
      e.preventDefault();
      this.toggle(n - 1);
    } else if (k === ' ' || k === 'enter') this.click('vp-deal', e);
    else if (k === 'b') this.click('vp-one', e);
    else if (k === 'x') this.click('vp-max', e);
  }
}
