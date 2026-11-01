// The blackjack table: the player against the dealer from a six-deck shoe, with a few bots
// playing basic strategy in the other spots for company. Bets come straight out of the
// player's chip bank and winnings go straight back in.
import { blackjackTally, canRefill, credit, setBlackjackBank, takeUnlocks } from '../../accounts';
import { BJ_DECKS, BJ_LIMITS, BjAction, BjLimits, BjHand, Round, RoundRig, RoundView, Shoe, bookPlay, describeTotal, handTotal, isNatural } from '../../engine/blackjack';
import { createRng, shuffle } from '../../engine/cards';
import { announce } from '../player/achievements';
import { bindConsoleButton, consoleEnabled, toggleConsole } from '../console';
import type { DevBlackjack } from '../console-blackjack';
import { cardHtml, chipsHtml, esc, fmt, isPhone, withHero } from '../dom';
import { GUIDE_ICON, openGuide } from '../guides/guide';
import { currentTitle, player, savePlayer, serverAwards } from '../player/profiles';
import { SoundName, play, setVolume } from '../sound';
import { PERSONA_NAMES, TalkEvent, lineFor, personaFor } from '../../bots/persona';
import { avatarHtml, floatOver } from '../talk';
import { Dealer, DealerMoment, bjMoment, dealerLine, dealerSpeaks, pickDealer, shouldWhisper, whisperLine } from '../../bots/dealers';

// ---------- lobby settings ----------

/** Chips to bet with at each table limit. */
export const BJ_CHIPS: Record<BjLimits, number[]> = { low: [5, 25, 100], mid: [25, 100, 500], high: [25, 100, 500, 1000] };

export interface BjSetup {
  limits: BjLimits;
  /** Bots in the other spots. */
  bots: number;
  /** Show the basic-strategy play for the player's hand. */
  hints: boolean;
  /** The last bet, offered again at the next sitting. */
  bet: number;
}

export const DEFAULT_BJ: BjSetup = { limits: 'low', bots: 2, hints: true, bet: 20 };
export const BJ_MAX_BOTS = 4;

/** Table preferences shared with the poker table. */
export interface BjPrefs {
  speed: 'relaxed' | 'normal' | 'fast';
  sound: boolean;
  volume: number;
  fourColor: boolean;
  /** Bots chat at the table now and then. */
  talk: boolean;
  /** The dealer says something now and then. Missing on older saved settings, which means on. */
  dealerTalk?: boolean;
}

export const limitText = (l: BjLimits) => `${fmt(BJ_LIMITS[l].min)} – ${fmt(BJ_LIMITS[l].max)}`;
export const BJ_RULES_LINE = 'Six decks · dealer stands on 17 · pays 3 to 2';

/** The "Your table" card in the lobby when blackjack is picked. */
export function bjSetupCardHtml(bj: BjSetup, bank: number, refillable: boolean): string {
  const seg = (name: string, items: [string, string][], current: string) =>
    `<div class="seg" role="group">${items.map(([v, l]) => `<button type="button" data-${name}="${v}" aria-pressed="${v === current}">${l}</button>`).join('')}</div>`;
  const { min } = BJ_LIMITS[bj.limits];
  const ok = bank >= min;
  return `<aside class="panel setup-card" aria-label="Your table">
    <div class="ticket">
      <span class="eyebrow">Your table</span>
      <b>Blackjack</b>
      <span>${BJ_RULES_LINE}</span>
    </div>
    <div class="options">
      <div class="field">
        <span class="flabel">Table limits</span>
        ${seg('bj-limits', (Object.keys(BJ_LIMITS) as BjLimits[]).map((l) => [l, limitText(l)]), bj.limits)}
        <span class="hint">Bet anywhere from ${fmt(min)} to ${fmt(BJ_LIMITS[bj.limits].max)} chips a hand.</span>
      </div>
      <div class="field">
        <label for="bj-bots">Other players <output id="bj-bots-out">${bj.bots || 'None'}</output></label>
        <input id="bj-bots" class="slider" type="range" min="0" max="${BJ_MAX_BOTS}" value="${bj.bots}">
        <span class="hint">Bots play by the book for company. Everyone plays against the dealer, not each other.</span>
      </div>
      <div class="field">
        <span class="flabel">Strategy hints</span>
        ${seg('bj-hints', [['on', 'Show'], ['off', 'Hide']], bj.hints ? 'on' : 'off')}
        <span class="hint">Shows the by-the-book play for every hand you're dealt.</span>
      </div>
      <div class="field">
        <span class="flabel">House rules</span>
        <span class="hint">Double on any two cards, also after a split. Split pairs up to four hands; split aces get one card each. Insurance pays 2 to 1 when the dealer shows an ace.</span>
      </div>
    </div>
    <div class="deal-box">
      <span class="${ok ? 'cost' : 'cost short'}">${ok ? `Bets come straight from your bank of <b>${fmt(bank)}</b>` : `The minimum bet is ${fmt(min)} and your bank has ${fmt(bank)}.`}</span>
      ${!ok && refillable ? '<button type="button" class="btn btn-lg" id="refill">Refill bank</button>' : ''}
      <button type="button" class="btn btn-primary btn-lg" id="deal" ${ok ? '' : 'disabled'}>Take a seat</button>
    </div>
  </aside>`;
}

/** Wires up the lobby card. `update` changes a setting and redraws the lobby. */
export function bindBjSetupCard(bj: BjSetup, update: (fn: () => void) => void) {
  document.querySelectorAll<HTMLButtonElement>('[data-bj-limits]').forEach((b) => (b.onclick = () => update(() => (bj.limits = b.dataset.bjLimits as BjLimits))));
  document.querySelectorAll<HTMLButtonElement>('[data-bj-hints]').forEach((b) => (b.onclick = () => update(() => (bj.hints = b.dataset.bjHints === 'on'))));
  const bots = document.getElementById('bj-bots') as HTMLInputElement | null;
  if (bots) {
    bots.oninput = () => (document.getElementById('bj-bots-out')!.textContent = bots.value === '0' ? 'None' : bots.value);
    bots.onchange = () => update(() => (bj.bots = Number(bots.value)));
  }
}

// ---------- the table ----------

interface Hooks {
  app: HTMLElement;
  setup: BjSetup;
  prefs: BjPrefs;
  /** Saves the setup and prefs. */
  save: () => void;
  /** Back to the lobby. */
  leave: () => void;
}

interface Spot {
  id: string;
  name: string;
  isHuman: boolean;
  /** Bots keep their own chips; the player's are their bank. */
  stack: number;
  /** Avatar colour class. */
  level: string;
  /** A person's face (accounts/avatars.ts), or null. */
  avatar?: string | null;
}

const BOT_LEVELS = ['beginner', 'easy', 'medium', 'hard', 'expert'];
const DELAY: Record<BjPrefs['speed'], number> = { relaxed: 1000, normal: 620, fast: 240 };
const BOT_BUYIN = 40;
export const OUTCOME_TEXT: Record<string, string> = { blackjack: 'Blackjack', win: 'Win', push: 'Push', lose: 'Lose', bust: 'Bust' };

// ---------- drawing the felt ----------

/** One spot on the felt, for drawing. */
export interface FeltSpot {
  /** The spot's id at an online table, so chat can float over it. */
  id?: string;
  name: string;
  /** The viewer's own spot. */
  me: boolean;
  stack: number;
  /** Avatar colour class. */
  level: string;
  /** A person's face (accounts/avatars.ts), or null. */
  avatar?: string | null;
  /** Shown under the name: a title, "Bot", "Away"… */
  label: string | null;
  /** Index into the round's seats, or -1 when the spot sits this round out. */
  seat: number;
  /** Chips in the betting circle when no round is in play there. */
  bet: number;
  /** A small note in place of the round result, like "Betting…". */
  note?: string;
}

const DEAL_GAP = 0.13;

/** Draws the half-moon table from a round as players see it. Keeps track of which cards have been dealt, to animate only new ones. */
export class BjFelt {
  private seen = new Set<string>();

  html(o: { round: RoundView | null; spots: FeltSpot[]; roundNo: number; opening: boolean; msg: string; shoeTitle: string; dealer?: Dealer }): string {
    const r = o.round;
    const n = r ? r.seats.length : o.spots.length;
    // On a phone the player's own spot sits below the table, and the others share the arc.
    const phone = isPhone();
    const hero = phone && o.spots.some((s) => s.me);
    const arc = spotLayout(o.spots.length - (hero ? 1 : 0), hero);
    let k = 0;
    const pos = o.spots.map((s) => (hero && s.me ? { x: 50, y: 50 } : arc[k++]));
    const parts: string[] = [];
    let heroHtml = '';
    if (this.seen.size > 3000) this.seen.clear();

    let dealer = '<div class="bj-cards dealer-cards empty"></div>';
    let dealerTotal = '';
    if (r) {
      const cards = r.dealer.map((c, k) => {
        const delay = k < 2 && o.opening ? (k * (n + 1) + n) * DEAL_GAP : 0;
        return this.card(c, `${o.roundNo}:d:${k}:${c !== null}`, delay, k);
      }).join('');
      dealer = `<div class="bj-cards dealer-cards" style="--n:${r.dealer.length}">${cards}</div>`;
      const shown = r.dealer.filter((c): c is number => c !== null);
      const natural = r.holeShown && isNatural(shown);
      dealerTotal = `<span class="bj-total ${handTotal(shown).total > 21 ? 'bust' : ''} ${natural ? 'natural' : ''}">${describeTotal(shown, natural)}</span>`;
    }
    const who = o.dealer
      ? `<span class="dealer-face" aria-hidden="true">${o.dealer.face}</span><span class="bj-dealer-name" title="${esc(`${o.dealer.name} · Dealer\n${o.dealer.bio}`)}">${esc(o.dealer.name)}</span>`
      : '<span class="bj-dealer-name">Dealer</span>';
    parts.push(`<div class="bj-dealer">${dealer}<div class="bj-dealer-tag" data-seat="dealer">${who}${dealerTotal}</div></div>`);

    o.spots.forEach((spot, i) => {
      const p = pos[i];
      const si = spot.seat;
      const seat = r && si >= 0 ? r.seats[si] : null;
      const classes = ['bj-spot'];
      if (spot.me) classes.push('me');
      if (r && si >= 0 && ((r.phase === 'play' && r.seatTurn === si) || (r.phase === 'insurance' && r.insuranceTurn === si))) classes.push('acting');
      let hands = '';
      let wager = spot.bet;
      let tag = spot.note ? `<span class="bubble">${esc(spot.note)}</span>` : '';
      if (seat && r) {
        if (r.phase !== 'done') wager = seat.hands.reduce((sum, h) => sum + h.bet, 0);
        hands = seat.hands.map((h, hi) => this.handHtml(r, h, si, hi, o.opening ? n : -1, o.roundNo)).join('');
        const net = seat.net;
        if (net !== null) {
          classes.push(net > 0 ? 'winner' : net < 0 ? 'loser' : 'pushed');
          tag = `<span class="bubble ${net > 0 ? 'won' : net < 0 ? 'lost' : ''}">${net > 0 ? `+${fmt(net)}` : net < 0 ? `−${fmt(-net)}` : 'Even'}</span>`;
        } else if (seat.insurance) tag = `<span class="bubble">Insured ${fmt(seat.insurance)}</span>`;
      }
      const circle = `<div class="bj-circle ${wager ? 'has-bet' : ''}">${wager ? `${chipsHtml(wager, 6)}<span>${fmt(wager)}</span>` : ''}</div>`;
      const label = spot.label ? `<span class="lvl lv-${spot.level}${spot.me ? ' ttl' : ''}">${esc(spot.label)}</span>` : '';
      const mine = hero && spot.me;
      const spotHtml = `<div class="${classes.join(' ')}"${spot.id ? ` data-seat="${esc(spot.id)}"` : ''}${mine ? '' : ` style="left:${p.x}%;top:${p.y}%"`}>
        <div class="bj-hands">${hands}</div>
        ${circle}
        <div class="pod" title="${esc(spot.name)}">
          ${avatarHtml(spot.name, spot.level, spot.level !== 'human', spot.avatar ?? null)}
          <span class="plate"><span class="nm">${esc(spot.name)}</span><span class="stk">${fmt(spot.stack)}</span></span>
          ${label}
        </div>
        <div class="bubbles">${tag}</div>
      </div>`;
      if (mine) heroHtml = spotHtml;
      else parts.push(spotHtml);
    });

    return withHero(`<div class="bj-table${hero ? ' has-hero' : ''}">
      <div class="bj-rail"><div class="bj-felt">
        <svg class="bj-print" viewBox="0 0 1000 500" aria-hidden="true">
          <defs>
            <path id="bj-arc1" d="M 260 150 A 240 60 0 0 0 740 150"/>
            <path id="bj-arc2" d="M 290 122 A 210 50 0 0 0 710 122"/>
          </defs>
          <text class="bj-print-big"><textPath href="#bj-arc1" startOffset="50%" text-anchor="middle">BLACKJACK PAYS 3 TO 2</textPath></text>
          <text class="bj-print-small"><textPath href="#bj-arc2" startOffset="50%" text-anchor="middle">Dealer stands on all 17s · Insurance pays 2 to 1</textPath></text>
        </svg>
      </div></div>
      <div class="bj-shoe" title="${esc(o.shoeTitle)}"><span></span></div>
      <div class="bj-tray" aria-hidden="true">${[5000, 1000, 500, 100, 25, 5].map((v) => `<i class="v${v}"></i>`).join('')}</div>
      ${o.msg ? `<div class="bj-msg">${esc(o.msg)}</div>` : ''}
      ${parts.join('')}
    </div>`, heroHtml);
  }

  /** A card, with the deal animation the first time it shows (staggered for the opening deal). */
  private card(c: number | null, key: string, delay: number, k: number): string {
    const fresh = !this.seen.has(key);
    if (fresh) this.seen.add(key);
    const style = `--k:${k}`;
    const anim = fresh ? ` deal" style="animation-delay:${delay.toFixed(2)}s;${style}` : `" style="${style}`;
    return cardHtml(c, '').replace(/" aria-label=/, `${anim}" aria-label=`);
  }

  private handHtml(r: RoundView, h: BjHand, si: number, hi: number, openingSeats: number, roundNo: number): string {
    const seat = r.seats[si];
    const active = r.phase === 'play' && r.seatTurn === si && r.handTurn === hi;
    const cls = ['bj-hand'];
    if (active && seat.hands.length > 1) cls.push('active');
    if (h.outcome) cls.push(`o-${h.outcome}`);
    const cards = h.cards.map((c, k) => {
      const delay = openingSeats >= 0 && k < 2 ? (k * (openingSeats + 1) + si) * DEAL_GAP : 0;
      return this.card(c, `${roundNo}:${si}:${hi}:${k}:${c}`, delay, k);
    }).join('');
    const natural = isNatural(h.cards) && !h.split;
    const total = describeTotal(h.cards, natural);
    const bust = handTotal(h.cards).total > 21;
    const result = h.outcome && h.outcome !== 'blackjack' && h.outcome !== 'bust' ? `<span class="bj-result">${OUTCOME_TEXT[h.outcome]}</span>` : '';
    const bet = seat.hands.length > 1 ? `<span class="bj-hbet">${fmt(h.bet)}</span>` : h.doubled ? '<span class="bj-hbet">Doubled</span>' : '';
    return `<div class="${cls.join(' ')}">
      <div class="bj-cards" style="--n:${h.cards.length}">${cards}</div>
      <div class="bj-tags"><span class="bj-total ${bust ? 'bust' : ''} ${natural ? 'natural' : ''}">${total}</span>${result}${bet}</div>
    </div>`;
  }
}

/** Where each spot sits on the arc, first base (dealt first) on the right. With the player's
 *  own spot below the table (phones), the rest share a shorter felt. */
function spotLayout(n: number, hero = false): { x: number; y: number }[] {
  const narrow = isPhone();
  const spread = n <= 1 ? 0 : hero ? Math.min(140, 46 * (n - 1)) : narrow ? Math.min(130, 50 * (n - 1)) : Math.min(120, 34 * (n - 1));
  return Array.from({ length: n }, (_, i) => {
    const a = ((90 - spread / 2 + (n === 1 ? 0 : (spread * i) / (n - 1))) * Math.PI) / 180;
    return hero
      ? { x: 50 + 39 * Math.cos(a), y: 22 + 56 * Math.sin(a) }
      : narrow
        ? { x: 50 + 38 * Math.cos(a), y: 10 + 68 * Math.sin(a) }
        : { x: 50 + 42 * Math.cos(a), y: 7 + 73 * Math.sin(a) };
  });
}

export class BlackjackTable {
  private readonly rng = createRng();
  private readonly shoe = new Shoe(BJ_DECKS, this.rng);
  private readonly spots: Spot[];
  private readonly humanSpot: number;
  private readonly profile = player();
  private round: Round | null = null;
  private rounds = 0;
  /** The bet being built for the next round. */
  private bet: number;
  private timer: number | undefined;
  private modal: 'none' | 'leave' | 'settings' = 'none';
  private logCursor = 0;
  private readonly felt = new BjFelt();
  /** Wins in a row this sitting (a push doesn't break it). */
  private run = 0;
  private recorded: Round | null = null;
  private shuffleNote = false;
  private stopped = false;
  private lastShuffles = this.shoe.shuffles;
  private turnCue = '';
  /** The next render is the opening deal, whose cards land one after another. */
  private opening = false;
  /** When the opening deal's last card has landed. */
  private dealLands = 0;
  /** The player's last move busted their hand. */
  private busted = false;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  /** Developer console: the bots and dealer wait while paused. */
  private paused = false;
  /** Round number of the last bot remark, and lines waiting to float up once drawn. */
  private lastTalk = -10;
  private talkRng = createRng();
  private talkQueue: { seat: string; text: string }[] = [];
  /** Who deals tonight, the round of their last remark, and their line waiting to float up. */
  private readonly dealer: Dealer = pickDealer('blackjack', this.talkRng);
  private dealerLast = -10;
  private dealerSays = '';
  /** The bank when the player sat down, to tell how far down they are; and whether the dealer has whispered yet. */
  private readonly startBank = this.profile.bank;
  private whispered = false;
  private dealerWhispers = '';
  /** Developer console: cards to deal next round, by spot id. */
  private nextRig: RoundRig | null = null;

  constructor(private readonly h: Hooks) {
    const names = shuffle(PERSONA_NAMES.filter((n) => n.toLowerCase() !== this.profile.name.toLowerCase()), this.rng);
    const limits = this.limits;
    const bots: Spot[] = Array.from({ length: Math.max(0, Math.min(BJ_MAX_BOTS, h.setup.bots)) }, (_, i) => ({
      id: `b${i}`, name: names[i], isHuman: false, stack: limits.min * BOT_BUYIN, level: BOT_LEVELS[Math.floor(this.rng.next() * BOT_LEVELS.length)],
    }));
    // The player sits in the middle, with bots on either side.
    this.humanSpot = Math.floor(bots.length / 2);
    bots.splice(this.humanSpot, 0, { id: 'p0', name: this.profile.name, isHuman: true, stack: 0, level: 'human' });
    this.spots = bots;
    this.bet = this.clampBet(h.setup.bet);
  }

  private get limits() {
    return BJ_LIMITS[this.h.setup.limits];
  }

  private get bank(): number {
    return this.profile.bank;
  }

  private clampBet(x: number): number {
    const { min, max } = this.limits;
    return Math.max(min, Math.min(max, Math.round(x) || min));
  }

  start() {
    document.addEventListener('keydown', this.keyHandler);
    play('shuffle');
    this.dealerSay('hello');
    this.render();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    document.removeEventListener('keydown', this.keyHandler);
    // Wagers on an unfinished hand are already out of the bank; they stay on the table.
    announce(takeUnlocks(this.profile, serverAwards()));
    void savePlayer();
  }

  private get inPlay(): boolean {
    return !!this.round && !this.round.isComplete;
  }

  // ---------- the flow ----------

  private deal() {
    if (this.inPlay || this.modal !== 'none' || this.stopped) return;
    const bet = this.clampBet(this.bet);
    if (bet > this.bank) return this.render();
    if (this.shoe.needsShuffle) this.shoe.shuffle();
    for (const s of this.spots) {
      if (!s.isHuman && s.stack < this.limits.min) s.stack = this.limits.min * BOT_BUYIN;
    }
    const entries = this.spots.map((s) => ({
      id: s.id, name: s.isHuman ? 'You' : s.name,
      stack: s.isHuman ? this.bank : s.stack,
      bet: s.isHuman ? bet : this.botBet(s),
    }));
    this.h.setup.bet = bet;
    this.h.save();
    this.round = new Round(this.shoe, entries, this.nextRig);
    this.nextRig = null;
    this.rounds++;
    this.logCursor = 0;
    const cues: SoundName[] = [];
    if (this.shoe.shuffles !== this.lastShuffles) {
      this.lastShuffles = this.shoe.shuffles;
      this.shuffleNote = true;
      if (this.rounds > 1) this.dealerSay('shuffle');
      cues.push('shuffle');
    } else this.shuffleNote = false;
    cues.push('chips');
    cues.forEach((c, i) => play(c, i * 0.3));
    const dealt = (this.spots.length + 1) * 2;
    for (let i = 0; i < Math.min(dealt, 10); i++) play('deal', 0.35 + i * DEAL_GAP);
    this.opening = true;
    this.dealLands = Date.now() + dealt * DEAL_GAP * 1000;
    this.sync(0.35 + dealt * DEAL_GAP);
  }

  private botBet(s: Spot): number {
    const { min, max } = this.limits;
    const units = [1, 1, 2, 2, 3, 5][Math.floor(this.rng.next() * 6)];
    return Math.min(max, s.stack, min * units);
  }

  /** After any change: keep the bank in step, play sounds, draw, and schedule what's next. */
  private sync(soundDelay = 0) {
    if (this.stopped) return;
    const r = this.round!;
    const me = r.seats[this.humanSpot];
    setBlackjackBank(this.profile, me.stack);
    this.spots.forEach((s, i) => {
      if (!s.isHuman) s.stack = r.seats[i].stack;
    });
    this.sounds(r, soundDelay);
    if (r.isComplete) this.record(r);
    void savePlayer();
    this.render();
    this.schedule();
  }

  private sounds(r: Round, delay: number) {
    const cues: SoundName[] = [];
    for (; this.logCursor < r.log.length; this.logCursor++) {
      const e = r.log[this.logCursor];
      if (e.kind === 'card') cues.push('deal');
      else if (e.kind === 'flip') cues.push('flip');
      else if (e.kind === 'insurance') cues.push('chips');
      else if (e.kind === 'action' && / splits /.test(e.text)) cues.push('chips', 'deal');
      else if (e.kind === 'action' && / has blackjack$/.test(e.text) && e.seat === this.humanSpot) cues.push('blackjack');
    }
    if (/ doubles /.test(r.log[r.log.length - 1]?.text ?? '')) cues.unshift('chips');
    if (this.busted) cues.push('bust');
    this.busted = false;
    if (r.isComplete) {
      const net = r.net(this.humanSpot);
      cues.push(net > 0 ? 'win' : net < 0 ? 'pot' : 'chips');
    }
    const key = `${this.rounds}:${r.log.length}:${r.phase}`;
    if (this.myTurn(r) && this.turnCue !== key) {
      this.turnCue = key;
      cues.push('turn');
    }
    cues.slice(-6).forEach((c, i) => play(c, delay + i * 0.14));
  }

  private myTurn(r = this.round): boolean {
    if (!r) return false;
    return (r.phase === 'insurance' && r.insuranceTurn() === this.humanSpot) || (r.phase === 'play' && r.seatTurn === this.humanSpot);
  }

  private schedule() {
    clearTimeout(this.timer);
    const r = this.round;
    if (!r || r.isComplete || this.modal !== 'none' || this.stopped || this.paused || this.myTurn(r)) return;
    // Let the opening deal land before anyone moves.
    const landing = Math.max(0, this.dealLands - Date.now());
    this.timer = window.setTimeout(() => this.step(), DELAY[this.h.prefs.speed] + landing);
  }

  /** What the developer console sees and changes at this table. */
  get dev(): DevBlackjack {
    const t = this;
    return {
      shoe: t.shoe,
      round: t.round,
      spots: t.spots.map((s, i) => ({ id: s.id, name: s.isHuman ? t.profile.name : s.name, isHuman: s.isHuman, stack: s.isHuman ? t.bank : t.round && !t.round.isComplete ? t.round.seats[i].stack : s.stack })),
      get nextRig() {
        return t.nextRig;
      },
      set nextRig(r) {
        t.nextRig = r;
      },
      get paused() {
        return t.paused;
      },
      set paused(on) {
        t.paused = on;
        t.render();
        t.schedule();
      },
      setStack(id, n) {
        const i = t.spots.findIndex((s) => s.id === id);
        const r = t.round;
        if (r && !r.isComplete) r.seats[i].stack = n;
        if (t.spots[i].isHuman) setBlackjackBank(t.profile, n);
        else t.spots[i].stack = n;
        if (r && !r.isComplete) t.sync();
        else {
          void savePlayer();
          t.render();
        }
      },
      refresh: () => {
        if (t.round) t.sync();
        else t.render();
      },
      step: () => {
        const r = t.round;
        if (!r || r.isComplete || t.myTurn(r)) return false;
        t.step();
        return true;
      },
    };
  }

  /** One move by a bot or the dealer. */
  private step() {
    const r = this.round;
    if (!r || r.isComplete || this.stopped) return;
    if (r.phase === 'insurance') r.insure(r.insuranceTurn(), false);
    else if (r.phase === 'play') r.act(bookPlay(r)!);
    else if (r.phase === 'dealer') r.dealerStep();
    this.sync();
  }

  private humanAct(a: BjAction) {
    const r = this.round;
    if (!r || r.phase !== 'play' || r.seatTurn !== this.humanSpot || !r.legal()[a]) return;
    const h = r.hand!;
    r.act(a);
    this.busted = handTotal(h.cards).total > 21;
    this.sync();
  }

  private insure(take: boolean) {
    const r = this.round;
    if (!r || r.insuranceTurn() !== this.humanSpot) return;
    r.insure(this.humanSpot, take);
    this.sync();
  }

  /** Counts a finished round toward the player's achievements. */
  private record(r: Round) {
    if (this.recorded === r) return;
    this.recorded = r;
    const net = r.net(this.humanSpot);
    if (net > 0) this.run++;
    else if (net < 0) this.run = 0;
    credit(this.profile, blackjackTally(r, this.humanSpot, this.run));
    this.dealerSay(bjMoment({
      outcomes: r.seats[this.humanSpot].hands.map((h) => h.outcome ?? ''), net, min: this.limits.min,
      dealerNatural: isNatural(r.dealer), dealerBusted: handTotal(r.dealer).total > 21,
    }));
    // Well down for the night, the dealer may (very rarely) lean in with some advice.
    if (this.h.prefs.dealerTalk !== false && shouldWhisper(this.startBank - this.bank, this.limits.min, this.whispered, this.talkRng.next())) {
      this.whispered = true;
      this.dealerWhispers = whisperLine('blackjack', this.talkRng);
      this.dealerSays = '';
    }
    // The dealer and a bot don't talk over each other.
    if (!this.dealerSays && !this.dealerWhispers) this.talk(r);
    // A bet the bank can no longer cover comes down to what's left.
    this.bet = this.clampBet(Math.min(this.bet, this.profile.bank));
    announce(takeUnlocks(this.profile, serverAwards()));
  }

  /** Now and then the dealer says something about the round; nearly always about the big moments. */
  private dealerSay(m: DealerMoment) {
    if (this.h.prefs.dealerTalk === false || !dealerSpeaks(m, this.rounds - this.dealerLast, this.talkRng.next())) return;
    const line = dealerLine(this.dealer, m, this.talkRng);
    if (!line) return;
    this.dealerLast = this.rounds;
    this.dealerSays = line;
  }

  /** Now and then a bot says something about how their round went. */
  private talk(r: Round) {
    if (!this.h.prefs.talk || this.rounds - this.lastTalk < 2 || this.talkRng.next() > 0.3) return;
    const said = r.seats.flatMap((seat, i) => {
      const spot = this.spots[i];
      const who = spot && !spot.isHuman ? personaFor(spot.name) : undefined;
      const outcome = seat.hands[0]?.outcome;
      if (!who || !outcome || outcome === 'push') return [];
      const event: TalkEvent = outcome === 'blackjack' ? 'bigwin' : outcome === 'win' ? 'win' : 'lose';
      return [{ who, spot, event }];
    });
    const pick = said[Math.floor(this.talkRng.next() * said.length)];
    if (!pick) return;
    this.lastTalk = this.rounds;
    this.talkQueue.push({ seat: pick.spot.id, text: lineFor(pick.who, pick.event, this.talkRng) });
  }

  // ---------- rendering ----------

  render() {
    if (this.stopped) return;
    const r = this.round;
    const shoeLeft = Math.round((this.shoe.remaining / this.shoe.size) * 100);
    const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    const sound = this.h.prefs.sound;
    this.h.app.innerHTML = `
    <div class="game bj ${this.h.prefs.fourColor ? 'four-color' : ''}">
      <header class="topbar">
        <div class="tb-game">
          <span class="title">Blackjack</span>
          <span class="chip-info">Limits <b>${limitText(this.h.setup.limits)}</b> · Shoe <b>${shoeLeft}%</b> left · Bank <b>${fmt(this.bank)}</b></span>
        </div>
        <div class="tb-actions">
          ${consoleEnabled() ? `<button type="button" class="icon-btn" id="dev-toggle" title="Developer console (\`)">${icon('m5 7 5 5-5 5M12 18h7')}<span>Console</span></button>` : ''}
<button type="button" class="icon-btn" id="open-guide" title="How to play">${icon(GUIDE_ICON)}<span>Rules</span></button>
          <button type="button" class="icon-btn" id="sound-toggle" aria-pressed="${sound}" title="${sound ? 'Mute sounds (M)' : 'Turn sounds on (M)'}">${icon(sound ? 'M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z' : 'M4 9v6h4l5 4V5L8 9H4Zm12 .5 5 5m0-5-5 5')}<span>${sound ? 'Sound' : 'Muted'}</span></button>
          <button type="button" class="icon-btn" id="open-settings" title="Settings">${icon('M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.5a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.4 2.5h4l.4-2.5c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6Z')}<span>Settings</span></button>
          <button type="button" class="icon-btn" id="leave" title="Leave table">${icon('M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11')}<span>Leave</span></button>
        </div>
      </header>
      <div class="table-wrap">${this.feltHtml(r)}</div>
      <div class="actionbar">${this.actionsHtml(r)}</div>
    </div>
    ${this.modalHtml()}`;
    const opened = this.opening;
    this.opening = false;
    this.bind();
    const said = this.talkQueue.splice(0);
    if (said.length) requestAnimationFrame(() => said.forEach((l) => floatOver(l.seat, l.text)));
    const dealerSays = this.dealerSays;
    this.dealerSays = '';
    if (dealerSays) requestAnimationFrame(() => floatOver('dealer', dealerSays, { at: 'right', delay: opened ? 0.6 : 0 }));
    const whisper = this.dealerWhispers;
    this.dealerWhispers = '';
    if (whisper) requestAnimationFrame(() => floatOver('dealer', whisper, { at: 'right', whisper: true }));
  }

  private feltHtml(r: Round | null): string {
    const spots: FeltSpot[] = this.spots.map((s, i) => ({
      id: s.id, name: s.name, me: s.isHuman, stack: s.isHuman ? this.bank : s.stack, level: s.level, avatar: s.isHuman ? this.profile.avatar : null,
      label: s.isHuman ? currentTitle() : 'Bot', seat: r ? i : -1,
      // Between rounds the circle holds the next bet.
      bet: s.isHuman && (!r || r.isComplete) ? this.bet : 0,
    }));
    const msg = !r ? 'Place your bet' : this.shuffleNote && this.opening ? 'Fresh shoe, shuffled' : '';
    return this.felt.html({ round: r ? r.view() : null, spots, roundNo: this.rounds, opening: this.opening, msg, shoeTitle: `${this.shoe.remaining} cards left in the shoe`, dealer: this.dealer });
  }

  private actionsHtml(r: Round | null): string {
    const bank = this.bank;
    const { min, max } = this.limits;
    const chips = BJ_CHIPS[this.h.setup.limits];
    if (!r || r.isComplete) {
      // Between rounds: build the next bet.
      const lines: string[] = [];
      if (r) {
        const me = r.seats[this.humanSpot];
        const net = r.net(this.humanSpot);
        const outcomes = me.hands.map((h) => OUTCOME_TEXT[h.outcome!]).join(', ');
        lines.push(`<div class="bj-last ${net > 0 ? 'up' : net < 0 ? 'down' : ''}"><b>${net > 0 ? `You win ${fmt(net)}` : net < 0 ? `You lose ${fmt(-net)}` : 'Push, your bet comes back'}</b>${me.hands.length > 1 || me.insurance ? ` · ${outcomes}${me.insurance ? ', insurance ' + (isNatural(r.dealer) ? 'paid' : 'lost') : ''}` : ''}</div>`);
      }
      const short = bank < min;
      const bet = Math.min(this.bet, Math.max(min, bank));
      if (short) {
        lines.push(`<div class="bj-short">Your bank has ${fmt(bank)}, short of the ${fmt(min)} minimum.${canRefill(this.profile) ? ' You can refill it from the game menu.' : ''}</div>`);
        return `<span class="status bj-status">${lines.join('')}</span><div class="acts"><button type="button" class="act fold" id="bj-menu">Back to menu</button></div>`;
      }
      const chipBtns = chips.map((v) => `<button type="button" class="bj-chip v${v}" data-chip="${v}" ${bet + v > Math.min(max, bank) ? 'disabled' : ''} title="Add ${fmt(v)}"><span>${v >= 1000 ? `${v / 1000}K` : v}</span></button>`).join('');
      return `<div class="bj-betting">
          <div class="bj-bet"><span class="sl">Your bet</span><b>${fmt(this.bet)}</b><span class="ss">Bank ${fmt(bank)}</span></div>
          <div class="bj-chips">${chipBtns}</div>
          <div class="bj-bet-tools">
            <button type="button" class="preset" id="bj-min">Min</button>
            <button type="button" class="preset" id="bj-half" ${this.bet / 2 < min ? 'disabled' : ''}>½</button>
            <button type="button" class="preset" id="bj-x2" ${this.bet * 2 > Math.min(max, bank) ? 'disabled' : ''}>×2</button>
            <button type="button" class="preset" id="bj-max">Max</button>
          </div>
        </div>
        ${lines.length ? `<span class="status bj-status">${lines.join('')}</span>` : ''}
        <div class="acts"><button type="button" class="act raise" id="bj-deal" ${this.bet > bank ? 'disabled' : ''}>Deal<kbd>Space</kbd></button></div>`;
    }
    if (r.phase === 'insurance' && r.insuranceTurn() === this.humanSpot) {
      const me = r.seats[this.humanSpot];
      const cost = r.insuranceCost(me);
      const even = isNatural(me.hands[0].cards);
      return `<span class="status bj-status left"><b>The dealer shows an ace.</b> ${even ? `You have blackjack: take even money and win ${fmt(me.hands[0].bet)} for sure, or play it out for 3 to 2.` : `Insurance costs ${fmt(cost)} and pays 2 to 1 if the dealer has blackjack.`}${this.h.setup.hints ? '<span class="bj-hint">Book play: no insurance</span>' : ''}</span>
        <div class="acts"><button type="button" class="act call" id="bj-noins">${even ? 'Play it out' : 'No insurance'}<kbd>N</kbd></button><button type="button" class="act raise" id="bj-ins">${even ? 'Even money' : `Insure ${fmt(cost)}`}<kbd>I</kbd></button></div>`;
    }
    if (r.phase === 'play' && r.seatTurn === this.humanSpot) {
      const me = r.seats[this.humanSpot];
      const h = r.hand!;
      const L = r.legal();
      const book = bookPlay(r);
      const label = me.hands.length > 1 ? `Hand ${r.handTurn + 1} of ${me.hands.length}: ` : '';
      const names: Record<BjAction, string> = { hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split' };
      return `<div class="myhand"><span class="hn">${label}${describeTotal(h.cards, false)}</span>${this.h.setup.hints && book ? `<span class="bj-hint">Book play: <b>${names[book]}</b></span>` : `<span class="bj-hint">Dealer shows ${describeTotal([r.upcard], false) === '11' ? 'an ace' : describeTotal([r.upcard], false)}</span>`}</div>
        <div class="acts">
          ${L.split ? `<button type="button" class="act raise" id="bj-split">Split<span class="amt"> ${fmt(h.bet)}</span><kbd>P</kbd></button>` : ''}
          ${L.double ? `<button type="button" class="act raise" id="bj-double">Double<span class="amt"> ${fmt(h.bet)}</span><kbd>D</kbd></button>` : ''}
          <button type="button" class="act fold" id="bj-stand">Stand<kbd>S</kbd></button>
          <button type="button" class="act call" id="bj-hit">Hit<kbd>H</kbd></button>
        </div>`;
    }
    const who = r.phase === 'dealer' ? 'The dealer plays' : r.phase === 'insurance' ? `${this.spots[r.insuranceTurn()].name} is deciding on insurance` : `${this.spots[r.seatTurn].name} is playing`;
    const mine = r.seats[this.humanSpot].hands.map((h) => describeTotal(h.cards, isNatural(h.cards) && !h.split)).join(' · ');
    return `<div class="myhand"><span class="hn">${mine}</span><span class="bj-hint">Your bet ${fmt(r.seats[this.humanSpot].hands.reduce((s, h) => s + h.bet, 0))}</span></div><span class="status">${esc(who)}…</span>`;
  }

  private modalHtml(): string {
    if (this.modal === 'leave') {
      const wager = this.round ? this.round.seats[this.humanSpot].hands.reduce((s, h) => s + h.bet, 0) + (this.round.seats[this.humanSpot].insurance ?? 0) : 0;
      return `<div class="overlay"><div class="modal" role="dialog">
        <h2>Leave the table?</h2>
        <p>This hand isn't finished. Your ${fmt(wager)} in bets stays on the table and is lost.</p>
        <div class="row"><button type="button" class="btn" id="close-modal">Keep playing</button><button type="button" class="btn btn-primary" id="confirm-leave">Leave</button></div>
      </div></div>`;
    }
    if (this.modal === 'settings') {
      const p = this.h.prefs;
      const speeds: [BjPrefs['speed'], string][] = [['relaxed', 'Relaxed'], ['normal', 'Normal'], ['fast', 'Fast']];
      return `<div class="overlay"><div class="modal" role="dialog" aria-labelledby="set-title">
        <h2 id="set-title">Table settings</h2>
        <div class="field"><span class="flabel">Dealer speed</span><div class="seg">${speeds.map(([s, l]) => `<button type="button" data-speed="${s}" aria-pressed="${p.speed === s}">${l}</button>`).join('')}</div></div>
        <div class="field"><label for="pref-volume">Sound volume <output id="vol-out">${p.sound ? `${Math.round(p.volume * 100)}%` : 'Muted'}</output></label>
          <input id="pref-volume" class="slider" type="range" min="0" max="100" step="5" value="${Math.round(p.volume * 100)}"></div>
        <label class="toggle"><input type="checkbox" id="pref-sound" ${p.sound ? 'checked' : ''}> Play table sounds</label>
        <label class="toggle"><input type="checkbox" id="pref-hints" ${this.h.setup.hints ? 'checked' : ''}> Show the by-the-book play</label>
        <label class="toggle"><input type="checkbox" id="pref-talk" ${p.talk ? 'checked' : ''}> Let the bots chat at the table</label>
        <label class="toggle"><input type="checkbox" id="pref-dealer" ${p.dealerTalk !== false ? 'checked' : ''}> Let the dealer chat</label>
        <label class="toggle"><input type="checkbox" id="pref-four" ${p.fourColor ? 'checked' : ''}> Four-colour deck (blue diamonds, green clubs)</label>
        <div class="row"><button type="button" class="btn btn-primary" id="close-modal">Done</button></div>
      </div></div>`;
    }
    return '';
  }

  // ---------- events ----------

  private bind() {
    const on = (id: string, fn: () => void) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };
    on('dev-toggle', toggleConsole);
    bindConsoleButton();
    on('sound-toggle', () => this.toggleSound());
    on('open-settings', () => this.openModal('settings'));
    on('open-guide', () => openGuide('blackjack'));
    on('leave', () => (this.inPlay ? this.openModal('leave') : this.h.leave()));
    on('bj-menu', () => this.h.leave());
    on('confirm-leave', () => this.h.leave());
    on('close-modal', () => this.closeModal());
    on('bj-deal', () => this.deal());
    on('bj-hit', () => this.humanAct('hit'));
    on('bj-stand', () => this.humanAct('stand'));
    on('bj-double', () => this.humanAct('double'));
    on('bj-split', () => this.humanAct('split'));
    on('bj-ins', () => this.insure(true));
    on('bj-noins', () => this.insure(false));
    const { min, max } = this.limits;
    const cap = () => Math.max(min, Math.min(max, this.bank));
    const setBet = (x: number) => {
      this.bet = Math.max(min, Math.min(cap(), Math.round(x)));
      play('chips');
      this.render();
    };
    // A fresh table (or one after a round) starts the bet from the last one; chips add to it.
    on('bj-min', () => setBet(min));
    on('bj-max', () => setBet(cap()));
    on('bj-x2', () => setBet(this.bet * 2));
    on('bj-half', () => setBet(this.bet / 2));
    document.querySelectorAll<HTMLButtonElement>('[data-chip]').forEach((b) => (b.onclick = () => setBet(this.bet + Number(b.dataset.chip))));
    document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => (b.onclick = () => {
      this.h.prefs.speed = b.dataset.speed as BjPrefs['speed'];
      this.h.save();
      this.render();
    }));
    const pref = (id: string, set: (v: boolean) => void) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.onchange = () => {
        set(el.checked);
        this.h.save();
        setVolume(this.h.prefs.volume, !this.h.prefs.sound);
        this.render();
      };
    };
    pref('pref-sound', (v) => (this.h.prefs.sound = v));
    pref('pref-hints', (v) => (this.h.setup.hints = v));
    pref('pref-four', (v) => (this.h.prefs.fourColor = v));
    pref('pref-talk', (v) => (this.h.prefs.talk = v));
    pref('pref-dealer', (v) => (this.h.prefs.dealerTalk = v));
    const vol = document.getElementById('pref-volume') as HTMLInputElement | null;
    if (vol) {
      vol.oninput = () => {
        this.h.prefs.volume = Number(vol.value) / 100;
        if (this.h.prefs.volume > 0) this.h.prefs.sound = true;
        setVolume(this.h.prefs.volume, !this.h.prefs.sound);
        document.getElementById('vol-out')!.textContent = `${vol.value}%`;
        const box = document.getElementById('pref-sound') as HTMLInputElement | null;
        if (box) box.checked = this.h.prefs.sound;
      };
      vol.onchange = () => {
        this.h.save();
        play('chips');
      };
    }
  }

  private toggleSound() {
    this.h.prefs.sound = !this.h.prefs.sound;
    this.h.save();
    setVolume(this.h.prefs.volume, !this.h.prefs.sound);
    this.render();
    play('chips');
  }

  private openModal(m: 'leave' | 'settings') {
    clearTimeout(this.timer);
    this.modal = m;
    this.render();
  }

  private closeModal() {
    this.modal = 'none';
    this.render();
    this.schedule();
  }

  private onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    if (this.modal !== 'none') {
      if (e.key === 'Escape') this.closeModal();
      return;
    }
    const click = (id: string) => {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (el && !el.disabled) {
        e.preventDefault();
        el.click();
      }
    };
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') click('bj-deal');
    else if (k === 'h') click('bj-hit');
    else if (k === 's') click('bj-stand');
    else if (k === 'd') click('bj-double');
    else if (k === 'p') click('bj-split');
    else if (k === 'i') click('bj-ins');
    else if (k === 'n') click('bj-noins');
    else if (k === 'm') {
      e.preventDefault();
      this.toggleSound();
    }
  }
}
