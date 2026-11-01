// The baccarat table: punto banco from an eight-deck shoe. The player bets on Player, Banker,
// a Tie or the pair side bets, and the dealer turns the cards over by the fixed drawing rules.
// Bets come out of the chip bank on the deal and winnings go back when the coup is settled.
import { baccaratTally, credit, setBlackjackBank } from '../../accounts';
import { BAC_DECKS, BAC_LIMITS, BAC_PAYOUT, BAC_SPOTS, BAC_SPOT_NAMES, BacBets, BacLimits, BacResult, BacSpot, Coup, betsProblem, betsTotal, dealCoup, handValue, settleCoup } from '../../engine/baccarat';
import { Shoe } from '../../engine/blackjack';
import { createRng } from '../../engine/cards';
import { cardHtml, chipsHtml, esc, fmt } from '../dom';
import { HouseHooks, HouseTable, chipRackHtml, houseCardHtml, seg } from './house';
import { play } from '../sound';
import { floatOver } from '../talk';
import { Dealer, DealerMoment, bacMoment, dealerLine, dealerSpeaks, pickDealer, shouldWhisper, whisperLine } from '../../bots/dealers';

// ---------- lobby settings ----------

/** One coup on the scoreboard: who won, and whether either side was dealt a pair. */
export interface Bead { w: 'P' | 'B' | 'T'; pp?: boolean; bp?: boolean }

export interface BacSetup {
  limits: BacLimits;
  chip: number;
  /** The last coup's bets, for Rebet. */
  last: BacBets;
}

export const DEFAULT_BAC: BacSetup = { limits: 'low', chip: 10, last: {} };
export const BAC_CHIPS: Record<BacLimits, number[]> = { low: [10, 25, 100], mid: [50, 100, 500], high: [250, 500, 1000] };
const limitText = (l: BacLimits) => `${fmt(BAC_LIMITS[l].min)} – ${fmt(BAC_LIMITS[l].max)}`;

export function bacSetupCardHtml(bac: BacSetup, bank: number, refillable: boolean): string {
  const { min, max } = BAC_LIMITS[bac.limits];
  return houseCardHtml({
    name: 'Baccarat',
    rules: 'Punto banco · eight decks · Banker pays 19 to 20',
    min, bank, refillable,
    fields: `
      <div class="field">
        <span class="flabel">Table limits</span>
        ${seg('bac-limits', (Object.keys(BAC_LIMITS) as BacLimits[]).map((l) => [l, limitText(l)]), bac.limits)}
        <span class="hint">Each bet at least ${fmt(min)} chips, and up to ${fmt(max)} in all on one hand.</span>
      </div>
      <div class="field">
        <span class="flabel">How it plays</span>
        <span class="hint">Bet on the Player hand, the Banker hand or a tie. Closest to nine wins: tens and faces count nothing, and only the last digit of a total counts. The dealer draws third cards by the house rules, so there's nothing to decide once the cards are out.</span>
      </div>
      <div class="field">
        <span class="flabel">Payouts</span>
        <span class="hint">Player 1 to 1 · Banker 1 to 1 less 5% commission · Tie 8 to 1, and Player and Banker bets come back on a tie · Player pair and Banker pair 11 to 1.</span>
      </div>`,
  });
}

export function bindBacSetupCard(bac: BacSetup, update: (fn: () => void) => void) {
  document.querySelectorAll<HTMLButtonElement>('[data-bac-limits]').forEach((b) => (b.onclick = () => update(() => (bac.limits = b.dataset.bacLimits as BacLimits))));
}

// ---------- the table ----------

const STEP_MS: Record<'relaxed' | 'normal' | 'fast', number> = { relaxed: 900, normal: 620, fast: 260 };
const SHORT: Record<BacSpot, string> = { player: 'Player', banker: 'Banker', tie: 'Tie', playerPair: 'P pair', bankerPair: 'B pair' };
const ROAD_ROWS = 6;
const ROAD_COLS = 14;

export class BaccaratTable extends HouseTable<BacSetup> {
  protected readonly title = 'Baccarat';
  protected readonly cls = 'bac';
  protected readonly guideId = 'baccarat' as const;
  private readonly rng = createRng();
  private readonly shoe = new Shoe(BAC_DECKS, this.rng);
  private bets: BacBets = {};
  private placed: { spot: BacSpot; amount: number }[] = [];
  /** The coup on the table, how many of its cards are face up, and what it settles to. */
  private coup: { coup: Coup; bets: BacBets; result: BacResult; shown: number; done: boolean } | null = null;
  private road: Bead[] = [];
  private run = 0;
  private timer: number | undefined;
  private note = '';
  private noteTimer: number | undefined;
  private fresh = false;
  /** Cards already drawn, so only new ones animate. */
  private seen = new Set<string>();
  private coups = 0;
  /** The croupier tonight, the coup they last spoke on, and their line waiting to float up. */
  private readonly talkRng = createRng();
  private readonly dealer: Dealer = pickDealer('baccarat', this.talkRng);
  private dealerLast = -10;
  private dealerSays = '';
  /** The bank when the player sat down, to tell how far down they are; and whether the croupier has whispered yet. */
  private readonly startBank = this.profile.bank;
  private whispered = false;
  private whisper = '';

  constructor(h: HouseHooks<BacSetup>) {
    super(h);
    this.dealerSay('hello');
  }

  private get limits() {
    return BAC_LIMITS[this.h.setup.limits];
  }

  protected get chips() {
    return BAC_CHIPS[this.h.setup.limits];
  }

  protected infoHtml() {
    return `Limits <b>${limitText(this.h.setup.limits)}</b> · Shoe <b>${Math.round((this.shoe.remaining / this.shoe.size) * 100)}%</b> left`;
  }

  private get dealing(): boolean {
    return !!this.coup && !this.coup.done;
  }

  // ---------- betting ----------

  private place(spot: BacSpot) {
    if (this.dealing) return;
    const amount = this.h.setup.chip;
    if (amount > Math.min(this.limits.max, this.bank) - betsTotal(this.bets)) {
      this.say(this.bank < this.limits.max ? 'Your bank can’t cover another chip.' : `The table takes at most ${fmt(this.limits.max)} a hand.`);
      return;
    }
    // A new bet after a coup clears the cards away.
    if (!betsTotal(this.bets)) this.coup = null;
    this.bets[spot] = (this.bets[spot] ?? 0) + amount;
    this.placed.push({ spot, amount });
    play('chips');
    this.render();
  }

  private undo() {
    const p = this.placed.pop();
    if (!p || this.dealing) return;
    this.bets[p.spot] = (this.bets[p.spot] ?? 0) - p.amount;
    if (!(this.bets[p.spot]! > 0)) delete this.bets[p.spot];
    play('chips');
    this.render();
  }

  private clear() {
    if (this.dealing) return;
    this.bets = {};
    this.placed = [];
    this.render();
  }

  private rebet(): boolean {
    const last = this.h.setup.last;
    if (this.dealing || !betsTotal(last) || betsProblem(last, this.limits, this.bank)) return false;
    this.bets = { ...last };
    this.placed = (Object.entries(last) as [BacSpot, number][]).map(([spot, amount]) => ({ spot, amount }));
    this.coup = null;
    play('chips');
    return true;
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

  // ---------- the croupier ----------

  /** Now and then the croupier says something; nearly always about the big moments. */
  private dealerSay(m: DealerMoment, n = '') {
    if (this.h.prefs.dealerTalk === false || !dealerSpeaks(m, this.coups - this.dealerLast, this.talkRng.next())) return;
    const line = dealerLine(this.dealer, m, this.talkRng, n);
    if (!line) return;
    this.dealerLast = this.coups;
    this.dealerSays = line;
  }

  /** Floats the croupier's line, once the table is drawn. */
  private flushDealer() {
    const line = this.dealerSays;
    this.dealerSays = '';
    const whisper = this.whisper;
    this.whisper = '';
    if (whisper) requestAnimationFrame(() => floatOver('dealer', whisper, { at: 'right', whisper: true }));
    else if (line) requestAnimationFrame(() => floatOver('dealer', line, { at: 'right' }));
  }

  render() {
    super.render();
    if (!this.stopped) this.flushDealer();
  }

  // ---------- the coup ----------

  private deal() {
    if (this.dealing || this.stopped) return;
    if (!betsTotal(this.bets) && !this.rebet()) return;
    const problem = betsProblem(this.bets, this.limits, this.bank);
    if (problem) return this.say(problem);
    this.fresh = false;
    if (this.shoe.needsShuffle) {
      this.shoe.shuffle();
      // A new shoe starts a new scoreboard, as at the casino.
      this.road = [];
      this.fresh = true;
      play('shuffle');
      if (this.coups > 0) this.dealerSay('shuffle');
    }
    const coup = dealCoup(this.shoe);
    const result = settleCoup(this.bets, coup);
    setBlackjackBank(this.profile, this.bank - result.staked);
    this.h.setup.last = { ...this.bets };
    this.h.save();
    this.coup = { coup, bets: this.bets, result, shown: 0, done: false };
    this.coups++;
    this.bets = {};
    this.placed = [];
    this.note = '';
    play('chips');
    this.next();
  }

  /** Turns the next card over, or settles the coup once every card is out. */
  private next() {
    const c = this.coup;
    if (!c || c.done || this.stopped) return;
    const total = c.coup.order.length;
    if (c.shown < total) {
      c.shown++;
      play(c.shown <= 4 ? 'deal' : 'flip');
      this.render();
      // Third cards come after a pause, like a dealer squeezing them.
      const pause = c.shown === 4 || c.shown === 5 ? 1.8 : 1;
      this.timer = window.setTimeout(() => this.next(), STEP_MS[this.h.prefs.speed] * pause);
      return;
    }
    this.settle();
    this.render();
  }

  private settle() {
    const c = this.coup;
    if (!c || c.done) return;
    c.done = true;
    c.shown = c.coup.order.length;
    const r = c.result;
    setBlackjackBank(this.profile, this.bank + r.paid);
    if (r.net > 0) this.run++;
    else if (r.net < 0) this.run = 0;
    credit(this.profile, baccaratTally(c.coup, r, this.run));
    this.road.push({ w: c.coup.winner === 'player' ? 'P' : c.coup.winner === 'banker' ? 'B' : 'T', pp: c.coup.playerPair || undefined, bp: c.coup.bankerPair || undefined });
    play(r.net > 0 ? 'win' : r.net < 0 ? 'pot' : 'chips');
    if (this.stopped) return;
    const co = c.coup;
    const moment = bacMoment({
      winner: co.winner, natural: co.natural, net: r.net, min: this.limits.min,
      pairHit: r.spots.some((s) => (s.spot === 'playerPair' || s.spot === 'bankerPair') && s.outcome === 'win'),
    });
    const side = co.winner === 'player' ? 'Player' : 'Banker';
    const n = moment === 'win' || moment === 'lose' ? side : String(Math.max(co.playerTotal, co.bankerTotal));
    this.dealerSay(moment, n);
    // Well down for the night, the croupier may (very rarely) lean in with some advice.
    if (this.h.prefs.dealerTalk !== false && shouldWhisper(this.startBank - this.bank, this.limits.min, this.whispered, this.talkRng.next())) {
      this.whispered = true;
      this.whisper = whisperLine('baccarat', this.talkRng);
    }
  }

  protected finish() {
    clearTimeout(this.timer);
    clearTimeout(this.noteTimer);
    // Leaving mid-deal still settles the coup: the cards were already out of the shoe.
    this.settle();
  }

  // ---------- drawing ----------

  private handHtml(who: 'player' | 'banker'): string {
    const c = this.coup;
    const cards = c ? c.coup[who] : [];
    // Which of this hand's cards are face up so far.
    let k = 0;
    const up = c ? c.coup.order.slice(0, c.shown).filter((o) => o === who).length : 0;
    const html = cards.slice(0, up).map((card) => {
      const key = `${this.coups}:${who}:${k}`;
      const isNew = !this.seen.has(key);
      this.seen.add(key);
      const third = k === 2 ? ' third' : '';
      k++;
      return cardHtml(card, `${isNew ? 'deal' : ''}${third}`);
    }).join('');
    const value = up ? handValue(cards.slice(0, up)) : null;
    const won = c?.done && c.coup.winner === who;
    const natural = c?.done && c.coup.natural && value !== null && value >= 8;
    return `<div class="bac-hand ${who} ${won ? 'won' : ''} ${c?.done && c.coup.winner !== who && c.coup.winner !== 'tie' ? 'lost' : ''}">
      <div class="bac-hand-head"><span class="bac-side">${who === 'player' ? 'Player' : 'Banker'}</span>${value !== null ? `<span class="bj-total ${natural ? 'natural' : ''}">${natural ? `Natural ${value}` : value}</span>` : ''}</div>
      <div class="bac-cards">${html || '<span class="bac-empty"></span>'}</div>
    </div>`;
  }

  private roadHtml(): string {
    // Whole columns, newest on the right, dropping the oldest once the board is full.
    const start = Math.max(0, Math.ceil(this.road.length / ROAD_ROWS) - ROAD_COLS) * ROAD_ROWS;
    const shown = this.road.slice(start);
    const counts = { P: 0, B: 0, T: 0 };
    for (const b of this.road) counts[b.w]++;
    const beads = shown.map((b) => `<i class="bead ${b.w}${b.pp ? ' pp' : ''}${b.bp ? ' bp' : ''}">${b.w}</i>`).join('');
    return `<div class="bac-road" aria-label="Scoreboard: Player ${counts.P}, Banker ${counts.B}, Tie ${counts.T}">
      <div class="bac-road-grid" style="--rows:${ROAD_ROWS};--cols:${ROAD_COLS}">${beads}</div>
      <div class="bac-road-count"><span class="P">P ${counts.P}</span><span class="B">B ${counts.B}</span><span class="T">T ${counts.T}</span></div>
    </div>`;
  }

  protected feltHtml(): string {
    const c = this.coup;
    const showing = betsTotal(this.bets) ? this.bets : c?.bets ?? {};
    const outcome = (s: BacSpot) => (c?.done ? c.result.spots.find((r) => r.spot === s)?.outcome ?? null : null);
    const spots = BAC_SPOTS.map((s) => {
      const amt = showing[s] ?? 0;
      const o = outcome(s);
      const won = c?.done && ((s === 'player' || s === 'banker' || s === 'tie') ? c.coup.winner === s : s === 'playerPair' ? c.coup.playerPair : c.coup.bankerPair);
      const pays = s === 'banker' ? '1 : 1 less 5%' : `${BAC_PAYOUT[s]} : 1`;
      return `<button type="button" class="bac-spot ${s} ${won ? 'won' : ''}" data-bac="${s}" aria-label="${BAC_SPOT_NAMES[s]}, pays ${pays}${amt ? `, ${fmt(amt)} on it` : ''}">
        <span class="bac-name">${esc(BAC_SPOT_NAMES[s])}</span><span class="bac-pays">${pays}</span>
        ${amt ? `<span class="rl-stake ${o === 'win' ? 'hit' : o === 'lose' ? 'miss' : ''}">${chipsHtml(amt, 4)}<b>${fmt(amt)}</b></span>` : ''}
      </button>`;
    }).join('');
    let msg = '';
    if (c?.done) msg = c.coup.winner === 'tie' ? `Tie, ${c.coup.playerTotal} all` : `${c.coup.winner === 'player' ? 'Player' : 'Banker'} wins, ${Math.max(c.coup.playerTotal, c.coup.bankerTotal)} over ${Math.min(c.coup.playerTotal, c.coup.bankerTotal)}`;
    else if (this.fresh && c && c.shown <= 1) msg = 'Fresh shoe, shuffled';
    else if (!c) msg = 'Place your bets';
    return `<div class="bac-table">
      <div class="bj-rail bac-rail"><div class="bj-felt bac-felt"></div></div>
      <div class="bj-shoe" title="${this.shoe.remaining} cards left in the shoe"><span></span></div>
      <div class="bac-croupier"><div class="dealer-plate" data-seat="dealer" title="${esc(`${this.dealer.name} · Croupier\n${this.dealer.bio}`)}"><span class="dealer-face" aria-hidden="true">${this.dealer.face}</span><span class="dealer-who"><b>${esc(this.dealer.name)}</b><small>Croupier</small></span></div></div>
      <div class="bac-hands">${this.handHtml('player')}${this.handHtml('banker')}</div>
      ${msg ? `<div class="bj-msg bac-msg ${c?.done ? c.coup.winner : ''}">${esc(msg)}</div>` : ''}
      <div class="bac-spots">${spots}</div>
      ${this.roadHtml()}
    </div>`;
  }

  protected dockHtml(): string {
    const total = betsTotal(this.bets);
    const last = this.h.setup.last;
    const canRebet = !total && betsTotal(last) > 0 && !betsProblem(last, this.limits, this.bank);
    if (this.bank < this.limits.min && !total && !this.dealing) {
      return `<span class="status bj-status left"><span class="bj-short">Your bank has ${fmt(this.bank)}, short of the ${fmt(this.limits.min)} minimum. You can refill it from the menu.</span></span>
        <div class="acts"><button type="button" class="act fold" id="h-menu">Back to menu</button></div>`;
    }
    const c = this.coup;
    let status = '';
    if (this.note) status = `<span class="bj-short">${esc(this.note)}</span>`;
    else if (this.dealing) status = 'Dealing…';
    else if (!total && c?.done) {
      const r = c.result;
      const parts = r.spots.map((s) => `${SHORT[s.spot]} ${s.outcome === 'win' ? `+${fmt(s.paid - s.bet)}` : s.outcome === 'push' ? 'back' : `−${fmt(s.bet)}`}`);
      status = `<span class="bj-last ${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}"><b>${r.net > 0 ? `You win ${fmt(r.net)}` : r.net < 0 ? `You lose ${fmt(-r.net)}` : r.spots.every((x) => x.outcome === 'push') ? 'Your bets come back' : 'You break even'}</b>${r.spots.length > 1 ? ` · ${parts.join(', ')}` : ''}</span>`;
    } else status = '<span class="bj-hint">Pick a chip, then tap Player, Banker, Tie or a pair bet.</span>';
    const busy = this.dealing;
    return `<div class="bj-betting">
        <div class="bj-bet"><span class="sl">Your bets</span><b>${fmt(total)}</b><span class="ss">Bank ${fmt(this.bank - (busy ? 0 : total))}</span></div>
        ${chipRackHtml(this.chips, this.h.setup.chip, Infinity)}
        <div class="bj-bet-tools">
          <button type="button" class="preset" id="bac-undo" ${this.placed.length && !busy ? '' : 'disabled'}>Undo</button>
          <button type="button" class="preset" id="bac-clear" ${total && !busy ? '' : 'disabled'}>Clear</button>
        </div>
      </div>
      <span class="status bj-status">${status}</span>
      <div class="acts">${canRebet && !busy ? `<button type="button" class="act call" id="bac-rebet">Rebet ${fmt(betsTotal(last))}<kbd>R</kbd></button>` : ''}<button type="button" class="act raise" id="bac-deal" ${(total || canRebet) && !busy ? '' : 'disabled'}>${!total && canRebet ? 'Rebet & deal' : 'Deal'}<kbd>Space</kbd></button></div>`;
  }

  protected settingsExtraHtml(): string {
    return `<label class="toggle"><input type="checkbox" data-pref="fourColor" ${this.h.prefs.fourColor ? 'checked' : ''}> Four-colour deck (blue diamonds, green clubs)</label>
      <label class="toggle"><input type="checkbox" data-pref="dealerTalk" ${this.h.prefs.dealerTalk !== false ? 'checked' : ''}> Let the croupier chat</label>`;
  }

  protected bindGame() {
    this.on('h-menu', () => this.h.leave());
    this.on('bac-undo', () => this.undo());
    this.on('bac-clear', () => this.clear());
    this.on('bac-rebet', () => {
      if (this.rebet()) this.render();
    });
    this.on('bac-deal', () => this.deal());
    document.querySelectorAll<HTMLButtonElement>('[data-bac]').forEach((b) => (b.onclick = () => this.place(b.dataset.bac as BacSpot)));
  }

  protected onKey(k: string, e: KeyboardEvent) {
    if (k === ' ' || k === 'enter') this.click('bac-deal', e);
    else if (k === 'r') this.click('bac-rebet', e);
    else if (k === 'u' || (k === 'z' && (e.ctrlKey || e.metaKey))) this.click('bac-undo', e);
    else if (k === 'c') this.click('bac-clear', e);
  }
}
