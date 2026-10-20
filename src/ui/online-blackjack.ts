// An online blackjack table: draws what the table server sends (src/online/blackjack.ts) on
// the same felt as the practice table, and turns the buttons into requests. The shoe and
// the dealer's hole card stay on the server; the round arrives with the hole card blank.
import { BjAction, basicStrategy, describeTotal, isNatural } from '../engine/blackjack';
import { BjMove, BjTableView, TableView } from '../online/protocol';
import { BJ_CHIPS, BjFelt, FeltSpot, OUTCOME_TEXT, limitText } from './blackjack';
import { esc, fmt } from './dom';
import { SoundName, play } from './sound';

export interface BjScreenHooks {
  /** Sends a blackjack move for the round on the table. */
  move(move: BjMove, amount?: number): void;
  rebuy(): void;
  back(): void;
  sending(): boolean;
  secondsLeft(at: number | null): number;
}

const NAMES: Record<BjAction, string> = { hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split' };

export class BjScreen {
  private readonly felt = new BjFelt();
  /** The bet being built, or null to start from the last one. */
  private bet: number | null = null;
  private dealtRound = -1;
  private logRound = -1;
  private logCursor = 0;
  private turnCue = '';
  private opening = false;

  constructor(private readonly h: BjScreenHooks) {}

  title(bj: BjTableView): string {
    return `Limits <b>${limitText(bj.limits)}</b> · Shoe <b>${Math.round((bj.shoeLeft / bj.shoeSize) * 100)}%</b> left · Round <b>${bj.roundNumber}</b>`;
  }

  /** Plays the sounds for what changed since the last view, and notes a fresh deal for the card animation. */
  absorb(v: TableView, withSound: boolean) {
    const bj = v.bj!;
    const r = bj.round;
    this.opening = false;
    if (bj.phase === 'round' && r && this.dealtRound !== bj.roundNumber) {
      this.dealtRound = bj.roundNumber;
      this.opening = withSound;
    }
    if (!r) return;
    if (this.logRound !== bj.roundNumber) {
      this.logRound = bj.roundNumber;
      this.logCursor = 0;
      if (withSound) for (let i = 0; i < Math.min(10, (r.seats.length + 1) * 2); i++) play('deal', 0.2 + i * 0.13);
    }
    const fresh = r.log.slice(this.logCursor);
    this.logCursor = r.log.length;
    if (!withSound) return;
    const me = this.mySeat(bj);
    const cues: SoundName[] = [];
    for (const e of fresh) {
      if (e.kind === 'card') {
        if (/ doubles /.test(e.text)) cues.push('chips');
        cues.push('deal');
        if (e.seat === me && /\(Bust \d/.test(e.text)) cues.push('bust');
      } else if (e.kind === 'flip') cues.push('flip');
      else if (e.kind === 'insurance') cues.push('chips');
      else if (e.kind === 'action' && / splits /.test(e.text)) cues.push('chips', 'deal');
      else if (e.kind === 'action' && / has blackjack$/.test(e.text) && e.seat === me) cues.push('blackjack');
    }
    if (r.phase === 'done' && fresh.length && me >= 0) {
      const net = r.seats[me].net ?? 0;
      cues.push(net > 0 ? 'win' : net < 0 ? 'pot' : 'chips');
    }
    const key = `${bj.roundNumber}:${r.log.length}:${r.phase}:${bj.phase}`;
    if ((bj.legal || bj.insuranceCost !== null) && this.turnCue !== key) {
      this.turnCue = key;
      cues.push('turn');
    }
    cues.slice(-6).forEach((c, i) => play(c, i * 0.14));
  }

  private mySeat(bj: BjTableView): number {
    return bj.spots.find((s) => s.you)?.seat ?? -1;
  }

  /** The bet the chips are building: the last one, kept within the limits and the stack. */
  private betNow(bj: BjTableView, stack: number): number {
    const cap = Math.max(bj.min, Math.min(bj.max, stack));
    return Math.max(bj.min, Math.min(cap, this.bet ?? bj.lastBet));
  }

  feltHtml(v: TableView): string {
    const bj = v.bj!;
    const betting = bj.phase === 'betting';
    const spots: FeltSpot[] = bj.spots.map((s) => ({
      name: s.name, me: s.you, stack: s.stack, level: s.isHuman ? 'human' : 'medium',
      label: s.isHuman ? (s.title ?? (s.you ? 'You' : 'Friend')) : 'Bot',
      seat: s.seat,
      bet: betting ? s.bet ?? 0 : 0,
      note: s.away ? 'Away' : betting && s.sittingOut ? 'Sitting out' : betting && s.isHuman && s.bet === null ? 'Betting…' : undefined,
    }));
    const msg = betting ? (bj.round ? '' : 'Place your bets') : '';
    // While bets go down the last round stays on the felt, until the next deal.
    return this.felt.html({ round: bj.round, spots, roundNo: bj.roundNumber, opening: this.opening, msg, shoeTitle: `${bj.shoeLeft} cards left in the shoe` });
  }

  actionsHtml(v: TableView): string {
    const bj = v.bj!;
    const me = bj.spots.find((s) => s.you);
    const sending = this.h.sending();
    const status = (html: string, buttons = '') => `<span class="status bj-status">${html}</span>${buttons ? `<div class="acts">${buttons}</div>` : ''}`;
    const clock = v.turnDeadline ? `<span class="turn-clock">${bj.phase === 'betting' ? 'Bets close in' : 'Your turn'} · <b id="turn-clock">${this.h.secondsLeft(v.turnDeadline)}s</b></span>` : '';
    if (!me) return status(v.waitingForSeat ? 'You take a spot when the next round opens for bets.' : 'You are watching this table.');
    if (me.away) return status('You stepped away, so you sit out and a bot plays any hand still going.', `<button type="button" class="act raise" id="back-in" ${sending ? 'disabled' : ''}>I'm back</button>`);
    const r = bj.round;
    const si = me.seat;
    const last = r && r.phase === 'done' && si >= 0 ? this.lastLine(r, si) : '';

    if (bj.phase === 'betting') {
      if (me.stack < bj.min) {
        return status(`${last}<div class="bj-short">You have ${fmt(me.stack)}, short of the ${fmt(bj.min)} minimum.</div>`, `<button type="button" class="act raise" id="rebuy" ${sending ? 'disabled' : ''}>Buy back in for ${fmt(bj.startingStack)}</button>`);
      }
      if (me.bet !== null) return status(`${last}<div>Your bet of <b>${fmt(me.bet)}</b> is down. Waiting for the others…</div>${clock}`, `<button type="button" class="act fold" id="bj-sitout" ${sending ? 'disabled' : ''}>Take it back</button>`);
      const bet = this.betNow(bj, me.stack);
      const cap = Math.min(bj.max, me.stack);
      const chips = BJ_CHIPS[bj.limits].map((x) => `<button type="button" class="bj-chip v${x}" data-chip="${x}" ${bet + x > cap ? 'disabled' : ''} title="Add ${fmt(x)}"><span>${x >= 1000 ? `${x / 1000}K` : x}</span></button>`).join('');
      return `<div class="bj-betting">
          <div class="bj-bet"><span class="sl">Your bet</span><b>${fmt(bet)}</b><span class="ss">Chips ${fmt(me.stack)}</span></div>
          <div class="bj-chips">${chips}</div>
          <div class="bj-bet-tools">
            <button type="button" class="preset" id="bj-min">Min</button>
            <button type="button" class="preset" id="bj-half" ${bet / 2 < bj.min ? 'disabled' : ''}>½</button>
            <button type="button" class="preset" id="bj-x2" ${bet * 2 > cap ? 'disabled' : ''}>×2</button>
            <button type="button" class="preset" id="bj-max">Max</button>
          </div>
        </div>
        <span class="status bj-status">${last}${clock}</span>
        <div class="acts${sending ? ' sending' : ''}"><button type="button" class="act fold" id="bj-sitout" ${me.sittingOut ? 'disabled' : ''}>${me.sittingOut ? 'Sitting out' : 'Sit out'}</button><button type="button" class="act raise" id="bj-bet" data-bet="${bet}">Bet ${fmt(bet)}<kbd>Space</kbd></button></div>`;
    }

    if (!r) return status('Dealing…');
    if (bj.insuranceCost !== null && si >= 0) {
      const even = isNatural(r.seats[si].hands[0].cards);
      return `<span class="status bj-status left">${clock}<b>The dealer shows an ace.</b> ${even ? `You have blackjack: take even money and win ${fmt(r.seats[si].hands[0].bet)} for sure, or play it out for 3 to 2.` : `Insurance costs ${fmt(bj.insuranceCost)} and pays 2 to 1 if the dealer has blackjack.`}<span class="bj-hint">Book play: no insurance</span></span>
        <div class="acts${sending ? ' sending' : ''}"><button type="button" class="act call" id="bj-noins">${even ? 'Play it out' : 'No insurance'}<kbd>N</kbd></button><button type="button" class="act raise" id="bj-ins">${even ? 'Even money' : `Insure ${fmt(bj.insuranceCost)}`}<kbd>I</kbd></button></div>`;
    }
    const L = bj.legal;
    if (L && si >= 0) {
      const seat = r.seats[si];
      const h = seat.hands[r.handTurn];
      const up = r.dealer[0];
      const book = up === null ? null : basicStrategy(h.cards, up, { double: L.double, split: L.split });
      const label = seat.hands.length > 1 ? `Hand ${r.handTurn + 1} of ${seat.hands.length}: ` : '';
      return `<div class="myhand"><span class="hn">${label}${describeTotal(h.cards, false)}</span>${book ? `<span class="bj-hint">Book play: <b>${NAMES[book]}</b></span>` : ''}</div>
        ${clock ? `<span class="status">${clock}</span>` : ''}
        <div class="acts${sending ? ' sending' : ''}">
          ${L.split ? `<button type="button" class="act raise" id="bj-split">Split<span class="amt"> ${fmt(h.bet)}</span><kbd>P</kbd></button>` : ''}
          ${L.double ? `<button type="button" class="act raise" id="bj-double">Double<span class="amt"> ${fmt(h.bet)}</span><kbd>D</kbd></button>` : ''}
          <button type="button" class="act fold" id="bj-stand">Stand<kbd>S</kbd></button>
          <button type="button" class="act call" id="bj-hit">Hit<kbd>H</kbd></button>
        </div>`;
    }
    if (r.phase === 'done') return status(`${last}<div>Next round opens for bets in a moment…</div>`);
    const name = (seat: number) => r.seats[seat]?.name ?? '';
    const who = r.phase === 'dealer' ? 'The dealer plays' : r.phase === 'insurance' ? `${esc(name(r.insuranceTurn))} is deciding on insurance` : `${esc(name(r.seatTurn))} is playing`;
    const mine = si >= 0 ? `<div class="myhand"><span class="hn">${r.seats[si].hands.map((h) => describeTotal(h.cards, isNatural(h.cards) && !h.split)).join(' · ')}</span><span class="bj-hint">Your bet ${fmt(r.seats[si].hands.reduce((s, h) => s + h.bet, 0))}</span></div>` : '';
    return `${mine}<span class="status">${who}…${si < 0 ? ' You sit this round out.' : ''}</span>`;
  }

  private lastLine(r: NonNullable<BjTableView['round']>, si: number): string {
    const me = r.seats[si];
    const net = me.net ?? 0;
    const outcomes = me.hands.map((h) => OUTCOME_TEXT[h.outcome!]).join(', ');
    return `<div class="bj-last ${net > 0 ? 'up' : net < 0 ? 'down' : ''}"><b>${net > 0 ? `You win ${fmt(net)}` : net < 0 ? `You lose ${fmt(-net)}` : 'Push, your bet comes back'}</b>${me.hands.length > 1 || me.insurance ? ` · ${outcomes}` : ''}</div>`;
  }

  bind(v: TableView, redraw: () => void) {
    const bj = v.bj!;
    const on = (id: string, fn: () => void) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };
    const me = bj.spots.find((s) => s.you);
    on('back-in', () => this.h.back());
    on('rebuy', () => this.h.rebuy());
    on('bj-hit', () => this.h.move('hit'));
    on('bj-stand', () => this.h.move('stand'));
    on('bj-double', () => this.h.move('double'));
    on('bj-split', () => this.h.move('split'));
    on('bj-ins', () => this.h.move('insure'));
    on('bj-noins', () => this.h.move('noinsure'));
    on('bj-sitout', () => this.h.move('sitout'));
    if (!me) return;
    const cap = Math.max(bj.min, Math.min(bj.max, me.stack));
    const setBet = (x: number) => {
      this.bet = Math.max(bj.min, Math.min(cap, Math.round(x)));
      play('chips');
      redraw();
    };
    const now = this.betNow(bj, me.stack);
    on('bj-bet', () => this.h.move('bet', now));
    on('bj-min', () => setBet(bj.min));
    on('bj-max', () => setBet(cap));
    on('bj-x2', () => setBet(now * 2));
    on('bj-half', () => setBet(now / 2));
    document.querySelectorAll<HTMLButtonElement>('[data-chip]').forEach((b) => (b.onclick = () => setBet(now + Number(b.dataset.chip))));
  }

  /** Keyboard shortcuts, the same as the practice table. True when the key was used. */
  key(k: string): boolean {
    const ids: Record<string, string> = { h: 'bj-hit', s: 'bj-stand', d: 'bj-double', p: 'bj-split', i: 'bj-ins', n: 'bj-noins', ' ': 'bj-bet' };
    const el = ids[k] ? (document.getElementById(ids[k]) as HTMLButtonElement | null) : null;
    if (!el || el.disabled) return false;
    el.click();
    return true;
  }
}
