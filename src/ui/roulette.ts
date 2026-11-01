// The roulette table: the wheel, the betting layout and a rack of chips. The player puts
// chips on any spot of the layout, spins, and the house pays what the ball hits. Bets come
// out of the chip bank when the wheel spins and winnings go back when the ball drops.
import { credit, rouletteTally, setBlackjackBank } from '../accounts';
import { createRng } from '../engine/cards';
import {
  DOUBLE_ZERO, Layout, PAYOUT, Pocket, RL_LIMITS, RlLimits, SpinResult, WHEEL_ORDER, Wheel,
  describeSpot, isZero, layoutProblem, layoutTotal, pocketColor, pocketLabel, settle, spin, spotFor,
} from '../engine/roulette';
import { chipsHtml, esc, fmt } from './dom';
import { HouseHooks, HouseTable, chipRackHtml, houseCardHtml, seg } from './house';
import { play } from './sound';
import { floatOver } from './talk';
import { Dealer, DealerMoment, dealerLine, dealerSpeaks, pickDealer, rlMoment, shouldWhisper, whisperLine } from '../bots/dealers';

// ---------- lobby settings ----------

export interface RlSetup {
  limits: RlLimits;
  wheel: Wheel;
  /** The chip a click on the layout puts down. */
  chip: number;
  /** The last spin's bets, for Rebet. */
  last: Layout;
  /** Where the ball landed lately, newest first. */
  recent: Pocket[];
}

export const DEFAULT_RL: RlSetup = { limits: 'low', wheel: 'european', chip: 5, last: {}, recent: [] };
export const RL_CHIPS: Record<RlLimits, number[]> = { low: [5, 25, 100], mid: [25, 100, 500], high: [100, 500, 1000] };
const WHEEL_NAMES: Record<Wheel, string> = { european: 'European', american: 'American' };
const limitText = (l: RlLimits) => `${fmt(RL_LIMITS[l].min)} – ${fmt(RL_LIMITS[l].max)}`;

export function rlSetupCardHtml(rl: RlSetup, bank: number, refillable: boolean): string {
  const { min, max } = RL_LIMITS[rl.limits];
  return houseCardHtml({
    name: `${WHEEL_NAMES[rl.wheel]} Roulette`,
    rules: rl.wheel === 'european' ? 'One zero · straight up pays 35 to 1' : 'Zero and double zero · straight up pays 35 to 1',
    min, bank, refillable,
    fields: `
      <div class="field">
        <span class="flabel">Wheel</span>
        ${seg('rl-wheel', [['european', 'European (0)'], ['american', 'American (0, 00)']], rl.wheel)}
        <span class="hint">${rl.wheel === 'european' ? 'Thirty-seven pockets. The house edge is 2.7% on every bet.' : 'Thirty-eight pockets. The extra double zero doubles the house edge to 5.3%.'}</span>
      </div>
      <div class="field">
        <span class="flabel">Table limits</span>
        ${seg('rl-limits', (Object.keys(RL_LIMITS) as RlLimits[]).map((l) => [l, limitText(l)]), rl.limits)}
        <span class="hint">Each bet at least ${fmt(min)} chips, and up to ${fmt(max)} on the layout per spin.</span>
      </div>
      <div class="field">
        <span class="flabel">Payouts</span>
        <span class="hint">Straight up 35 to 1 · split 17 · street 11 · corner 8 · six line 5 · column and dozen 2 · red, black, odd, even, 1–18 and 19–36 even money. Even-money bets lose on a zero.</span>
      </div>`,
  });
}

export function bindRlSetupCard(rl: RlSetup, update: (fn: () => void) => void) {
  document.querySelectorAll<HTMLButtonElement>('[data-rl-limits]').forEach((b) => (b.onclick = () => update(() => (rl.limits = b.dataset.rlLimits as RlLimits))));
  document.querySelectorAll<HTMLButtonElement>('[data-rl-wheel]').forEach((b) => (b.onclick = () => update(() => (rl.wheel = b.dataset.rlWheel as Wheel))));
}

// ---------- the betting layout ----------
//
// Spots are placed in "layout space": a is the street (0 for 1-2-3 up to 11 for 34-35-36) and
// b the place in it (0, 1, 2). Bands below b = -0.5 hold the dozens and the even-money bets,
// a = -1 the zero and a = 12 the columns. Wide screens lay it out lengthwise as at a real
// table; phones stand it on end.

interface Rect { a0: number; a1: number; b0: number; b1: number }
interface Target { key: string; rect: Rect; cls: string }

const A0 = -1.5, A1 = 12.5, B0 = -2.5, B1 = 2.5;

function toBox(r: Rect, upright: boolean): { x: number; y: number; w: number; h: number } {
  // Percentages of the board.
  const along = (A1 - A0), across = (B1 - B0);
  if (upright) return { x: ((r.b0 - B0) / across) * 100, y: ((r.a0 - A0) / along) * 100, w: ((r.b1 - r.b0) / across) * 100, h: ((r.a1 - r.a0) / along) * 100 };
  return { x: ((r.a0 - A0) / along) * 100, y: ((B1 - r.b1) / across) * 100, w: ((r.a1 - r.a0) / along) * 100, h: ((r.b1 - r.b0) / across) * 100 };
}

const cellOf = (n: number) => ({ a: Math.floor((n - 1) / 3), b: (n - 1) % 3 });
const around = (a: number, b: number, da: number, db: number): Rect => ({ a0: a - da, a1: a + da, b0: b - db, b1: b + db });

/** Every spot a chip can go, edges and corners after the numbers so they sit on top. */
function targets(wheel: Wheel): Target[] {
  const t: Target[] = [];
  const E = 0.2;
  if (wheel === 'american') {
    t.push({ key: 'straight:0', rect: { a0: A0, a1: -0.5, b0: -0.5, b1: 1 }, cls: 'num' });
    t.push({ key: 'straight:00', rect: { a0: A0, a1: -0.5, b0: 1, b1: 2.5 }, cls: 'num' });
  } else t.push({ key: 'straight:0', rect: { a0: A0, a1: -0.5, b0: -0.5, b1: 2.5 }, cls: 'num' });
  for (let n = 1; n <= 36; n++) {
    const { a, b } = cellOf(n);
    t.push({ key: `straight:${n}`, rect: around(a, b, 0.5, 0.5), cls: 'num' });
  }
  for (let c = 1; c <= 3; c++) t.push({ key: `column:${c}`, rect: { a0: 11.5, a1: A1, b0: c - 1.5, b1: c - 0.5 }, cls: 'out' });
  for (let d = 1; d <= 3; d++) t.push({ key: `dozen:${d}`, rect: { a0: (d - 1) * 4 - 0.5, a1: d * 4 - 0.5, b0: -1.5, b1: -0.5 }, cls: 'out' });
  (['low', 'even', 'red', 'black', 'odd', 'high'] as const).forEach((k, i) => t.push({ key: k, rect: { a0: i * 2 - 0.5, a1: i * 2 + 1.5, b0: B0, b1: -1.5 }, cls: 'out' }));
  for (let n = 1; n <= 36; n++) {
    const { a, b } = cellOf(n);
    if (b < 2) t.push({ key: `split:${n}-${n + 1}`, rect: around(a, b + 0.5, 0.32, E), cls: 'edge' });
    if (a < 11) t.push({ key: `split:${n}-${n + 3}`, rect: around(a + 0.5, b, E, 0.32), cls: 'edge' });
  }
  for (let a = 0; a < 12; a++) {
    const n = a * 3 + 1;
    t.push({ key: `street:${n}`, rect: around(a, -0.5, 0.32, E), cls: 'edge' });
    if (a < 11) t.push({ key: `line:${n}`, rect: around(a + 0.5, -0.5, E, E), cls: 'edge corner' });
    for (let b = 0; b < 2; b++) if (a < 11) t.push({ key: `corner:${n + b}`, rect: around(a + 0.5, b + 0.5, E, E), cls: 'edge corner' });
  }
  return t;
}

const OUTSIDE_LABEL: Record<string, string> = {
  'dozen:1': '1st 12', 'dozen:2': '2nd 12', 'dozen:3': '3rd 12', low: '1–18', high: '19–36', even: 'Even', odd: 'Odd',
  red: '<i class="diamond red"></i>', black: '<i class="diamond black"></i>', 'column:1': '2 to 1', 'column:2': '2 to 1', 'column:3': '2 to 1',
};

// ---------- the wheel ----------

const R_POCKET_OUT = 84, R_POCKET_IN = 62, R_BALL_TRACK = 91, R_BALL_REST = 73;

function wheelSvg(wheel: Wheel, rotor: number, ball: number | null, ballIn: boolean): string {
  const order = WHEEL_ORDER[wheel];
  const n = order.length;
  const seg = 360 / n;
  const pt = (deg: number, r: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return `${(r * Math.cos(rad)).toFixed(2)} ${(r * Math.sin(rad)).toFixed(2)}`;
  };
  const pockets = order.map((p, i) => {
    const a = i * seg - seg / 2, b = a + seg;
    const d = `M ${pt(a, R_POCKET_IN)} L ${pt(a, R_POCKET_OUT)} A ${R_POCKET_OUT} ${R_POCKET_OUT} 0 0 1 ${pt(b, R_POCKET_OUT)} L ${pt(b, R_POCKET_IN)} A ${R_POCKET_IN} ${R_POCKET_IN} 0 0 0 ${pt(a, R_POCKET_IN)} Z`;
    return `<path class="pk ${pocketColor(p)}" d="${d}"/><text class="pk-n" transform="rotate(${(i * seg).toFixed(2)}) translate(0 -${R_POCKET_OUT - 8})" text-anchor="middle" dominant-baseline="central">${pocketLabel(p)}</text>`;
  }).join('');
  const frets = order.map((_, i) => `<line x1="0" y1="-${R_POCKET_IN}" x2="0" y2="-${R_POCKET_OUT}" transform="rotate(${(i * seg - seg / 2).toFixed(2)})"/>`).join('');
  const spokes = [0, 90, 180, 270].map((a) => `<rect x="-2.5" y="-46" width="5" height="40" rx="2.5" transform="rotate(${a})"/>`).join('');
  return `<svg class="rl-wheel" viewBox="-100 -100 200 200" role="img" aria-label="${WHEEL_NAMES[wheel]} roulette wheel">
    <defs>
      <radialGradient id="rl-bowl" r="1"><stop offset=".62" stop-color="#3a2414"/><stop offset=".86" stop-color="#1c110a"/><stop offset="1" stop-color="#5a3a20"/></radialGradient>
      <radialGradient id="rl-cone" r="1"><stop offset="0" stop-color="#7a4f2a"/><stop offset="1" stop-color="#3c2413"/></radialGradient>
      <radialGradient id="rl-ballg" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#b9b9b2"/></radialGradient>
    </defs>
    <circle r="99" fill="url(#rl-bowl)"/>
    <circle r="${R_POCKET_OUT + 2}" class="rl-trackline"/>
    <g class="rl-rotor" style="transform: rotate(${rotor}deg)">
      <circle r="${R_POCKET_OUT}" fill="#111"/>
      ${pockets}
      <g class="rl-frets">${frets}</g>
      <circle r="${R_POCKET_IN}" fill="url(#rl-cone)"/>
      <circle r="${R_POCKET_IN - 10}" class="rl-ring"/>
      <g class="rl-turret">${spokes}<circle r="9"/></g>
    </g>
    ${ball === null ? '' : `<g class="rl-ball" style="transform: rotate(${ball}deg)"><g class="rl-ball-r" style="transform: translateY(${ballIn ? R_BALL_TRACK - R_BALL_REST : 0}px)"><circle cy="-${R_BALL_TRACK}" r="4.2" fill="url(#rl-ballg)"/></g></g>`}
  </svg>`;
}

// ---------- the table ----------

const SPIN_MS: Record<'relaxed' | 'normal' | 'fast', number> = { relaxed: 5600, normal: 4600, fast: 2400 };

export class RouletteTable extends HouseTable<RlSetup> {
  protected readonly title = 'Roulette';
  protected readonly cls = 'rl';
  protected readonly guideId = 'roulette' as const;
  private readonly rng = createRng();
  /** Chips on the layout for the next spin. */
  private bets: Layout = {};
  /** Every chip put down, for Undo. */
  private placed: { key: string; amount: number }[] = [];
  /** The last spin and the bets it settled. */
  private last: { bets: Layout; result: SpinResult } | null = null;
  private spinning: { result: SpinResult } | null = null;
  private rotor = 0;
  private ball: number | null = null;
  private note = '';
  private noteTimer: number | undefined;
  private spinTimer: number | undefined;
  /** The croupier tonight, how many spins ago they last spoke, and their line waiting to float up. */
  private readonly talkRng = createRng();
  private readonly dealer: Dealer = pickDealer('roulette', this.talkRng);
  private spins = 0;
  private dealerLast = -10;
  private dealerSays = '';
  /** The bank when the player sat down, to tell how far down they are; and whether the croupier has whispered yet. */
  private readonly startBank = this.profile.bank;
  private whispered = false;
  private whisper = '';

  constructor(h: HouseHooks<RlSetup>) {
    super(h);
    h.setup.recent = (h.setup.recent ?? []).filter((p) => p !== DOUBLE_ZERO || h.setup.wheel === 'american');
    this.dealerSay('hello');
  }

  /** Now and then the croupier says something; nearly always about the big moments. */
  private dealerSay(m: DealerMoment, n = '') {
    if (this.h.prefs.dealerTalk === false || !dealerSpeaks(m, this.spins - this.dealerLast, this.talkRng.next())) return;
    const line = dealerLine(this.dealer, m, this.talkRng, n);
    if (!line) return;
    this.dealerLast = this.spins;
    this.dealerSays = line;
  }

  /** Floats the croupier's line, once the table is drawn. */
  private flushDealer() {
    const line = this.dealerSays;
    this.dealerSays = '';
    const whisper = this.whisper;
    this.whisper = '';
    if (whisper) requestAnimationFrame(() => floatOver('dealer', whisper, { at: 'below', whisper: true }));
    else if (line) requestAnimationFrame(() => floatOver('dealer', line, { at: 'below' }));
  }

  protected settingsExtraHtml(): string {
    return `<label class="toggle"><input type="checkbox" data-pref="dealerTalk" ${this.h.prefs.dealerTalk !== false ? 'checked' : ''}> Let the croupier chat</label>`;
  }

  private get limits() {
    return RL_LIMITS[this.h.setup.limits];
  }

  protected get chips() {
    return RL_CHIPS[this.h.setup.limits];
  }

  protected infoHtml() {
    return `${WHEEL_NAMES[this.h.setup.wheel]} wheel · Limits <b>${limitText(this.h.setup.limits)}</b>`;
  }

  /** Room left on the layout for more chips: the table maximum or the bank, whichever is less. */
  private get room(): number {
    return Math.min(this.limits.max, this.bank) - layoutTotal(this.bets);
  }

  // ---------- betting ----------

  private place(key: string) {
    if (this.spinning || !spotFor(key, this.h.setup.wheel)) return;
    const amount = this.h.setup.chip;
    if (amount > this.room) {
      this.say(this.bank < this.limits.max ? 'Your bank can’t cover another chip.' : `The table takes at most ${fmt(this.limits.max)} a spin.`);
      return;
    }
    if (!layoutTotal(this.bets)) this.last = null;
    this.bets[key] = (this.bets[key] ?? 0) + amount;
    this.placed.push({ key, amount });
    play('chips');
    this.render();
  }

  private undo() {
    const p = this.placed.pop();
    if (!p || this.spinning) return;
    this.bets[p.key] -= p.amount;
    if (this.bets[p.key] <= 0) delete this.bets[p.key];
    play('chips');
    this.render();
  }

  private clear() {
    if (this.spinning) return;
    this.bets = {};
    this.placed = [];
    this.render();
  }

  /** Puts the last spin's bets back down, if the bank and table still allow them. */
  private rebet(): boolean {
    const last = this.h.setup.last;
    if (this.spinning || !layoutTotal(last) || layoutProblem(last, this.h.setup.wheel, this.limits, this.bank)) return false;
    this.bets = { ...last };
    this.placed = Object.entries(last).map(([key, amount]) => ({ key, amount }));
    this.last = null;
    play('chips');
    return true;
  }

  private double() {
    if (this.spinning || !layoutTotal(this.bets)) return;
    const twice = Object.fromEntries(Object.entries(this.bets).map(([k, v]) => [k, v * 2]));
    if (layoutProblem(twice, this.h.setup.wheel, this.limits, this.bank)) {
      this.say('Doubling would go past the table limit or your bank.');
      return;
    }
    for (const [key, amount] of Object.entries(this.bets)) this.placed.push({ key, amount });
    this.bets = twice;
    play('chips');
    this.render();
  }

  private say(text: string) {
    this.note = text;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      this.note = '';
      if (!this.spinning) this.render();
    }, 2600);
    this.render();
  }

  // ---------- the spin ----------

  private spin() {
    if (this.spinning || this.stopped) return;
    if (!layoutTotal(this.bets) && !this.rebet()) return;
    const problem = layoutProblem(this.bets, this.h.setup.wheel, this.limits, this.bank);
    if (problem) return this.say(problem);
    const wheel = this.h.setup.wheel;
    const pocket = spin(wheel, this.rng);
    const result = settle(this.bets, pocket, wheel);
    setBlackjackBank(this.profile, this.bank - result.staked);
    this.h.setup.last = { ...this.bets };
    this.h.save();
    this.spinning = { result };
    this.note = '';
    this.spins++;
    super.render();
    this.dealerSay('noMore');
    this.flushDealer();

    // The rotor turns clockwise and the ball runs the other way, then drops into the pocket.
    const order = WHEEL_ORDER[wheel];
    const seg = 360 / order.length;
    const ms = SPIN_MS[this.h.prefs.speed];
    const from = this.rotor;
    const to = from + 360 * (ms > 3000 ? 2 : 1) + this.rng.next() * 360;
    const ballFrom = this.ball ?? this.rng.next() * 360;
    // Where the winning pocket will be when the rotor stops, wound back a few laps for the ball.
    const land = to + order.indexOf(pocket) * seg;
    const ballTo = land - 360 * Math.ceil((ballFrom - land) / 360 + (ms > 3000 ? 4 : 2));
    this.rotor = ((to % 360) + 360) % 360;
    this.ball = ((land % 360) + 360) % 360;
    const rotorEl = document.querySelector<SVGGElement>('.rl-rotor');
    const ballEl = document.querySelector<SVGGElement>('.rl-ball');
    const dropEl = document.querySelector<SVGGElement>('.rl-ball-r');
    const animate = (el: Element | null, frames: Keyframe[], easing: string) => {
      if (el && typeof el.animate === 'function') el.animate(frames, { duration: ms, easing, fill: 'forwards' });
    };
    animate(rotorEl, [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }], 'cubic-bezier(.2,.6,.3,1)');
    animate(ballEl, [{ transform: `rotate(${ballFrom}deg)` }, { transform: `rotate(${ballTo}deg)` }], 'cubic-bezier(.12,.62,.3,1)');
    animate(dropEl, [
      { transform: 'translateY(0px)', offset: 0 },
      { transform: 'translateY(0px)', offset: 0.6 },
      { transform: `translateY(${R_BALL_TRACK - R_BALL_REST + 6}px)`, offset: 0.72 },
      { transform: `translateY(${R_BALL_TRACK - R_BALL_REST - 4}px)`, offset: 0.8 },
      { transform: `translateY(${R_BALL_TRACK - R_BALL_REST}px)`, offset: 1 },
    ], 'ease-out');
    if (ms > 3000) play('spin');
    else play('chips');
    this.spinTimer = window.setTimeout(() => this.land(), ms + 120);
  }

  /** The ball has dropped: pay the winners and note the number. */
  private land() {
    const s = this.spinning;
    if (!s || this.stopped) return;
    this.spinning = null;
    const r = s.result;
    setBlackjackBank(this.profile, this.bank + r.paid);
    credit(this.profile, rouletteTally(r));
    this.dealerSay(rlMoment({
      pocket: r.pocket, previous: this.h.setup.recent[0], zero: isZero(r.pocket),
      straightHit: r.spots.some((x) => x.key.startsWith('straight:') && x.paid > 0),
      net: r.net, staked: r.staked, min: this.limits.min,
    }), pocketLabel(r.pocket));
    // Well down for the night, the croupier may (very rarely) lean in with some advice.
    if (this.h.prefs.dealerTalk !== false && shouldWhisper(this.startBank - this.bank, this.limits.min, this.whispered, this.talkRng.next())) {
      this.whispered = true;
      this.whisper = whisperLine('roulette', this.talkRng);
    }
    this.h.setup.recent = [r.pocket, ...this.h.setup.recent].slice(0, 16);
    this.h.save();
    this.last = { bets: this.bets, result: r };
    this.bets = {};
    this.placed = [];
    play(r.net > 0 ? 'win' : r.paid > 0 ? 'chips' : 'pot');
    this.render();
  }

  protected finish() {
    clearTimeout(this.spinTimer);
    clearTimeout(this.noteTimer);
    // Walking away mid-spin still settles the spin: the ball was always going to land there.
    if (this.spinning) {
      const r = this.spinning.result;
      setBlackjackBank(this.profile, this.bank + r.paid);
      credit(this.profile, rouletteTally(r));
      this.h.setup.recent = [r.pocket, ...this.h.setup.recent].slice(0, 16);
      this.h.save();
      this.spinning = null;
    }
  }

  render() {
    // A redraw mid-spin would restart the wheel; the spin redraws when it lands.
    if (this.spinning && document.querySelector('.rl-wheel')) return;
    super.render();
    this.flushDealer();
  }

  // ---------- drawing ----------

  protected feltHtml(): string {
    const wheel = this.h.setup.wheel;
    const upright = window.matchMedia('(max-width: 720px)').matches;
    const showing = layoutTotal(this.bets) ? this.bets : this.spinning ? this.bets : this.last?.bets ?? {};
    const result = !this.spinning && this.last ? this.last.result : null;
    const won = result?.pocket;
    const hit = new Set(result ? result.spots.filter((s) => s.paid > 0).map((s) => s.key) : []);

    const ts = targets(wheel);
    const cells = ts.filter((t) => !t.cls.startsWith('edge')).map((t) => {
      const box = toBox(t.rect, upright);
      const [kind, arg] = t.key.split(':');
      let label = OUTSIDE_LABEL[t.key] ?? arg;
      let cls = 'rl-cell';
      if (kind === 'straight') {
        const p = arg === '00' ? DOUBLE_ZERO : Number(arg);
        cls += ` n ${pocketColor(p)}${p === won ? ' won' : ''}`;
        label = arg;
      } else cls += ' o';
      if (kind === 'column') cls += ' col';
      const covers = spotFor(t.key, wheel)!.numbers.map(pocketLabel).join(' ');
      return `<div class="${cls}" data-covers="${covers}" style="left:${box.x}%;top:${box.y}%;width:${box.w}%;height:${box.h}%"><span>${label}</span></div>`;
    }).join('');
    const hot = ts.map((t) => {
      const box = toBox(t.rect, upright);
      const amt = showing[t.key];
      const chip = amt ? `<span class="rl-stake ${result ? (hit.has(t.key) ? 'hit' : 'miss') : ''}">${chipsHtml(amt, 4)}<b>${fmt(amt)}</b></span>` : '';
      const covers = spotFor(t.key, wheel)!.numbers.map(pocketLabel).join(' ');
      return `<button type="button" class="rl-spot ${t.cls}" data-spot="${t.key}" data-covers="${covers}" style="left:${box.x}%;top:${box.y}%;width:${box.w}%;height:${box.h}%" aria-label="${esc(describeSpot(t.key))}, pays ${PAYOUT[spotFor(t.key, wheel)!.kind]} to 1${amt ? `, ${fmt(amt)} on it` : ''}" title="${esc(describeSpot(t.key))} · ${PAYOUT[spotFor(t.key, wheel)!.kind]} to 1">${chip}</button>`;
    }).join('');

    const recent = this.h.setup.recent.slice(0, upright ? 9 : 14);
    const badge = won !== undefined && result
      ? `<div class="rl-result ${pocketColor(won)}"><b>${pocketLabel(won)}</b><span>${isZero(won) ? 'Green' : pocketColor(won) === 'red' ? 'Red' : 'Black'}${isZero(won) ? '' : ` · ${won % 2 ? 'Odd' : 'Even'} · ${won <= 18 ? '1–18' : '19–36'}`}</span></div>`
      : this.spinning ? '<div class="rl-result spinning"><span>No more bets</span></div>' : '<div class="rl-result idle"><span>Place your bets</span></div>';

    return `<div class="rl-table ${upright ? 'upright' : ''}">
      <div class="rl-side">
        <div class="rl-wheel-box">${wheelSvg(wheel, this.rotor, this.ball, this.ball !== null)}</div>
        ${badge}
        <ol class="rl-recent" aria-label="Last numbers">${recent.map((p, i) => `<li class="${pocketColor(p)}${i === 0 && result ? ' new' : ''}">${pocketLabel(p)}</li>`).join('')}</ol>
        <div class="dealer-plate" data-seat="dealer" title="${esc(`${this.dealer.name} · Croupier\n${this.dealer.bio}`)}"><span class="dealer-face" aria-hidden="true">${this.dealer.face}</span><span class="dealer-who"><b>${esc(this.dealer.name)}</b><small>Croupier</small></span></div>
      </div>
      <div class="rl-board-wrap">
        <div class="rl-board ${upright ? 'upright' : ''} ${wheel}">${cells}${hot}</div>
      </div>
    </div>`;
  }

  protected dockHtml(): string {
    const total = layoutTotal(this.bets);
    const last = this.h.setup.last;
    const canRebet = !total && layoutTotal(last) > 0 && !layoutProblem(last, this.h.setup.wheel, this.limits, this.bank);
    if (this.bank < this.limits.min && !total && !this.spinning) {
      return `<span class="status bj-status left"><span class="bj-short">Your bank has ${fmt(this.bank)}, short of the ${fmt(this.limits.min)} minimum. You can refill it from the menu.</span></span>
        <div class="acts"><button type="button" class="act fold" id="h-menu">Back to menu</button></div>`;
    }
    let status = '';
    if (this.note) status = `<span class="bj-short">${esc(this.note)}</span>`;
    else if (this.spinning) status = 'No more bets…';
    else if (!total && this.last) {
      const r = this.last.result;
      status = `<span class="bj-last ${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}"><b>${r.net > 0 ? `You win ${fmt(r.net)}` : r.net < 0 ? `You lose ${fmt(-r.net)}` : 'You break even'}</b> on ${pocketLabel(r.pocket)}</span>`;
    } else status = '<span class="bj-hint">Pick a chip, then tap the layout: a number, a line between numbers, a corner or an outside bet.</span>';
    const busy = this.spinning ? 'disabled' : '';
    return `<div class="bj-betting">
        <div class="bj-bet"><span class="sl">On the layout</span><b>${fmt(total)}</b><span class="ss">Bank ${fmt(this.bank - (this.spinning ? 0 : total))}</span></div>
        ${chipRackHtml(this.chips, this.h.setup.chip, Infinity)}
        <div class="bj-bet-tools">
          <button type="button" class="preset" id="rl-undo" ${this.placed.length && !this.spinning ? '' : 'disabled'}>Undo</button>
          <button type="button" class="preset" id="rl-clear" ${total && !this.spinning ? '' : 'disabled'}>Clear</button>
          <button type="button" class="preset" id="rl-double" ${total && !this.spinning ? '' : 'disabled'}>×2</button>
        </div>
      </div>
      <span class="status bj-status">${status}</span>
      <div class="acts">${canRebet && !this.spinning ? `<button type="button" class="act call" id="rl-rebet">Rebet ${fmt(layoutTotal(last))}<kbd>R</kbd></button>` : ''}<button type="button" class="act raise" id="rl-spin" ${(total || canRebet) && !this.spinning ? '' : 'disabled'} ${busy}>${!total && canRebet ? 'Rebet & spin' : 'Spin'}<kbd>Space</kbd></button></div>`;
  }

  protected bindGame() {
    this.on('h-menu', () => this.h.leave());
    this.on('rl-undo', () => this.undo());
    this.on('rl-clear', () => this.clear());
    this.on('rl-double', () => this.double());
    this.on('rl-rebet', () => {
      if (this.rebet()) this.render();
    });
    this.on('rl-spin', () => this.spin());
    const board = document.querySelector<HTMLElement>('.rl-board');
    if (!board) return;
    const light = (covers: string | null) => {
      const set = new Set(covers ? covers.split(' ') : []);
      board.querySelectorAll<HTMLElement>('.rl-cell.n').forEach((c) => c.classList.toggle('lit', set.has(c.textContent!.trim())));
    };
    board.querySelectorAll<HTMLButtonElement>('[data-spot]').forEach((b) => {
      b.onclick = () => this.place(b.dataset.spot!);
      b.onmouseenter = () => light(b.dataset.covers ?? null);
      b.onmouseleave = () => light(null);
      b.onfocus = () => light(b.dataset.covers ?? null);
      b.onblur = () => light(null);
    });
  }

  protected onKey(k: string, e: KeyboardEvent) {
    if (k === ' ' || k === 'enter') this.click('rl-spin', e);
    else if (k === 'r') this.click('rl-rebet', e);
    else if (k === 'u' || (k === 'z' && (e.ctrlKey || e.metaKey))) this.click('rl-undo', e);
    else if (k === 'c') this.click('rl-clear', e);
  }
}
