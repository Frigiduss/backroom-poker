import { Bot, STYLE_NAMES } from '../bots/bot';
import { simulateEquity, specFromView } from '../bots/equity';
import { buildView } from '../bots/view';
import { createRng, shuffle } from '../engine/cards';
import { Action, Hand, LegalActions } from '../engine/hand';
import { BotStyle, DIFFICULTIES, DIFFICULTY_NAMES, Difficulty, FORMAT_NAMES, Format, Seat, SeatConfig, Table } from '../engine/table';
import { STRUCTURE_NAMES, Structure, VARIANTS, VariantId, describeHolding } from '../engine/variants';
import {
  LocalAccountStore, OnlineAuth, Profile, TOURNAMENT_FEE, onlineEnabled, readAnnouncement, buyIn, canAfford, canRefill, cashOut, createProfile, enterTournament,
  finishTournament, prizeFor, recordHand, refill, setTableStack, abandonTournament, cashTally, credit, handTally, mergeTally, runAfter, takeUnlocks, tournamentTally,
} from '../accounts';
import { cardHtml, chipsHtml, esc, fmt, store } from './dom';
import { ONLINE } from '../accounts/config';
import { currentTitle, goOnline, initAccounts, renderAuth, setWelcomeSettings, openPlayer, player, playerBadgeHtml, renderNewPassword, renderProfile, savePlayer, serverAwards, takeNotice } from './profiles';
import { announce, checkAchievements, renderAchievements } from './achievements';
import { SoundName, play, setVolume } from './sound';
import { activeTable, bindFriendsPanel, friendsPanelHtml, initOnlinePlay, stopOnline } from './online';
import { bindGamePicker, gamePickerHtml } from './picker';
import { BjSetup, BlackjackTable, DEFAULT_BJ, bindBjSetupCard, bjSetupCardHtml } from './blackjack';
import { DevGame, bindConsoleButton, consoleButtonHtml, consoleEnabled, initConsole, refreshConsoleAccess, toggleConsole } from './console';

// ---------- settings ----------

type DifficultyChoice = Difficulty | 'mixed';
type BlindSpeed = 'slow' | 'normal' | 'turbo';
type Speed = 'relaxed' | 'normal' | 'fast';

interface Setup {
  /** Poker (the variant below) or blackjack. */
  game: 'poker' | 'blackjack';
  variant: VariantId;
  structures: Partial<Record<VariantId, Structure>>;
  format: Format;
  opponents: number;
  difficulty: DifficultyChoice;
  stackBB: number;
  blindSpeed: BlindSpeed;
  name: string;
  bj: BjSetup;
}

interface Prefs {
  speed: Speed;
  autoDeal: boolean;
  showOdds: boolean;
  fourColor: boolean;
  reveal: boolean;
  sound: boolean;
  volume: number;
}

// Before player accounts, settings lived under these keys. They seed the first player.
const LEGACY_SETUP_KEY = 'backroom-poker-setup';
const LEGACY_PREFS_KEY = 'backroom-poker-prefs';
const DEFAULT_SETUP: Setup = {
  game: 'poker', bj: DEFAULT_BJ, variant: 'holdem', structures: {}, format: 'cash', opponents: 5, difficulty: 'medium', stackBB: 100, blindSpeed: 'normal', name: 'You',
};
const DEFAULT_PREFS: Prefs = { speed: 'normal', autoDeal: false, showOdds: true, fourColor: false, reveal: false, sound: true, volume: 0.7 };
let setup: Setup = { ...DEFAULT_SETUP };
let prefs: Prefs = { ...DEFAULT_PREFS };

/** Each player keeps their own lobby choices and table preferences. */
function loadSettings(p: Profile) {
  setup = { ...DEFAULT_SETUP, ...(p.settings.setup as Partial<Setup> | undefined), name: p.name };
  prefs = { ...DEFAULT_PREFS, ...(p.settings.prefs as Partial<Prefs> | undefined) };
  if (!VARIANTS[setup.variant]) setup.variant = 'holdem';
  if (setup.game !== 'blackjack') setup.game = 'poker';
  setup.bj = { ...DEFAULT_BJ, ...setup.bj };
  setVolume(prefs.volume, !prefs.sound);
}

function saveSettings() {
  const p = player();
  p.settings = { ...p.settings, setup, prefs };
  savePlayer();
}

const BIG_BLIND = 20;
const HANDS_PER_LEVEL: Record<BlindSpeed, number> = { slow: 15, normal: 10, turbo: 6 };
const BOT_DELAY: Record<Speed, number> = { relaxed: 1150, normal: 650, fast: 220 };
const BOT_NAMES = ['Ada', 'Blaze', 'Cleo', 'Duke', 'Echo', 'Finn', 'Gus', 'Hana', 'Iris', 'Jax', 'Kai', 'Lulu', 'Milo', 'Nova', 'Otto', 'Pia', 'Quinn', 'Rex', 'Sage', 'Tess', 'Vic', 'Wren', 'Zed', 'Bea'];
const STYLES: BotStyle[] = ['balanced', 'balanced', 'tight', 'loose', 'aggressive', 'passive'];
const AVATAR: Record<Difficulty | 'human', string> = {
  human: '#d9a94e', beginner: '#9fd3a8', easy: '#8fc1e8', medium: '#e8d48f', hard: '#e8a36f', expert: '#e07a8a',
};

const structureFor = (v: VariantId): Structure => {
  const s = setup.structures[v];
  return s && VARIANTS[v].structures.includes(s) ? s : VARIANTS[v].defaultStructure;
};

const app = document.getElementById('app')!;
/** The lobby message admins set from the developer console, for everyone. */
let announcement = '';
/** The player whose online achievements were last fetched. */
let awardsChecked = '';

// ---------- setup screen ----------

function renderSetup() {
  game?.stop();
  game = null;
  blackjack?.stop();
  blackjack = null;
  stopOnline();
  const me = player();
  loadSettings(me);
  const v = VARIANTS[setup.variant];
  const maxOpp = v.maxPlayers - 1;
  if (setup.format === 'headsup') setup.opponents = 1;
  setup.opponents = Math.max(1, Math.min(maxOpp, setup.opponents));
  const struct = structureFor(setup.variant);
  const seg = <T extends string>(name: string, items: [T, string][], current: T, disabled: (t: T) => boolean = () => false) =>
    `<div class="seg" role="group">${items
      .map(([val, label]) => `<button type="button" data-${name}="${val}" aria-pressed="${val === current}" ${disabled(val) ? 'disabled' : ''}>${label}</button>`)
      .join('')}</div>`;

  const oppLabel = setup.difficulty === 'mixed' ? 'mixed' : DIFFICULTY_NAMES[setup.difficulty].toLowerCase();
  const cost = entryCost(setup);
  const affordable = canAfford(me, cost);
  const field = (setup.format === 'headsup' ? 1 : setup.opponents) + 1;
  const costLine = setup.format === 'cash'
    ? `Buy-in <b>${fmt(cost)}</b> from your bank of ${fmt(me.bank)}`
    : `Entry <b>${fmt(cost)}</b> · first place wins ${fmt(prizeFor(1, field))}`;

  const notice = takeNotice();
  // Every choice redraws the lobby; keep the setup card's options where they were scrolled to.
  const optionsScroll = app.querySelector('.setup-card .options')?.scrollTop ?? 0;

  app.innerHTML = `
  <main class="lobby">
    <header class="lobby-head">
      <div class="brand">
        <span class="eyebrow">Card room · open all night</span>
        <h1>Back Room <em>Poker</em></h1>
      </div>
      <div class="lobby-top">${consoleButtonHtml()}${playerBadgeHtml()}</div>
    </header>
    ${notice || announcement ? `<div class="notices">${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ''}${announcement ? `<p class="notice announce" role="status">${esc(announcement)}</p>` : ''}</div>` : ''}

    <div class="lobby-grid">
      ${gamePickerHtml(setup.game === 'blackjack' ? 'blackjack' : setup.variant)}

      ${setup.game === 'blackjack' ? bjSetupCardHtml(setup.bj, me.bank, canRefill(me)) : `<aside class="panel setup-card" aria-label="Your table">
        <div class="ticket">
          <span class="eyebrow">Your table</span>
          <b>${STRUCTURE_NAMES[struct]} ${v.name}</b>
          <span>${FORMAT_NAMES[setup.format]} · you against ${setup.opponents} ${oppLabel} bot${setup.opponents > 1 ? 's' : ''}</span>
        </div>
        <div class="options">
          <div class="field">
            <span class="flabel">Format</span>
            ${seg('format', (Object.keys(FORMAT_NAMES) as Format[]).map((f) => [f, FORMAT_NAMES[f].replace(' tournament', '')]), setup.format)}
            <span class="hint">${
              setup.format === 'cash'
                ? 'Blinds stay put. Bots who go broke buy back in, and so can you.'
                : setup.format === 'sng'
                  ? 'Everyone starts equal, blinds rise, last player with chips wins.'
                  : 'One opponent, rising blinds, play until someone has every chip.'
            }</span>
          </div>
          <div class="field">
            <span class="flabel">Bot difficulty</span>
            ${seg('difficulty', [...DIFFICULTIES.map((d) => [d, DIFFICULTY_NAMES[d]] as [DifficultyChoice, string]), ['mixed', 'Mixed']], setup.difficulty).replace('class="seg"', 'class="seg seg-3"')}
            <span class="hint">${difficultyHint(setup.difficulty)}</span>
          </div>
          <div class="field">
            <label for="opp">Opponents <output id="opp-out">${setup.opponents}</output></label>
            <input id="opp" class="slider" type="range" min="1" max="${maxOpp}" value="${setup.opponents}" ${setup.format === 'headsup' ? 'disabled' : ''}>
            <span class="hint">${setup.format === 'headsup' ? 'Heads-up is always one on one.' : `${v.name} seats up to ${v.maxPlayers}.`}</span>
          </div>
          <div class="field">
            <span class="flabel">Betting</span>
            ${seg('structure', (['NL', 'PL', 'FL'] as Structure[]).map((st) => [st, STRUCTURE_NAMES[st]]), struct, (st) => !v.structures.includes(st))}
          </div>
          <div class="field">
            <span class="flabel">Starting stack</span>
            ${seg('stack', [['50', '50 BB'], ['100', '100 BB'], ['200', '200 BB']], String(setup.stackBB) as '50' | '100' | '200')}
          </div>
          ${setup.format === 'cash' ? '' : `<div class="field">
            <span class="flabel">Blind levels</span>
            ${seg('blinds', [['slow', 'Slow'], ['normal', 'Normal'], ['turbo', 'Turbo']], setup.blindSpeed)}
            <span class="hint">Blinds go up every ${HANDS_PER_LEVEL[setup.blindSpeed]} hands.</span>
          </div>`}
        </div>
        <div class="deal-box">
          <span class="${affordable ? 'cost' : 'cost short'}">${affordable ? costLine : `You need ${fmt(cost)} chips and your bank has ${fmt(me.bank)}.${setup.format === 'cash' && setup.stackBB > 50 && canAfford(me, 50 * BIG_BLIND) ? ' Try a smaller starting stack.' : ''}`}</span>
          ${!affordable && canRefill(me) ? '<button type="button" class="btn btn-lg" id="refill">Refill bank</button>' : ''}
          <button type="button" class="btn btn-primary btn-lg" id="deal" ${affordable ? '' : 'disabled'}>Deal me in</button>
        </div>
      </aside>`}

      ${friendsPanelHtml()}
    </div>
  </main>`;
  app.querySelector('.setup-card .options')!.scrollTop = optionsScroll;

  const update = (fn: () => void) => {
    fn();
    saveSettings();
    renderSetup();
  };
  bindGamePicker((id) => update(() => {
    if (id === 'blackjack') setup.game = 'blackjack';
    else {
      setup.game = 'poker';
      setup.variant = id;
    }
  }));
  bindBjSetupCard(setup.bj, update);
  app.querySelectorAll<HTMLButtonElement>('[data-structure]').forEach((b) => (b.onclick = () => update(() => (setup.structures[setup.variant] = b.dataset.structure as Structure))));
  app.querySelectorAll<HTMLButtonElement>('[data-format]').forEach((b) => (b.onclick = () => update(() => {
    const prev = setup.format;
    setup.format = b.dataset.format as Format;
    if (prev === 'headsup' && setup.format !== 'headsup') setup.opponents = 5;
  })));
  app.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((b) => (b.onclick = () => update(() => (setup.difficulty = b.dataset.difficulty as DifficultyChoice))));
  app.querySelectorAll<HTMLButtonElement>('[data-stack]').forEach((b) => (b.onclick = () => update(() => (setup.stackBB = Number(b.dataset.stack)))));
  app.querySelectorAll<HTMLButtonElement>('[data-blinds]').forEach((b) => (b.onclick = () => update(() => (setup.blindSpeed = b.dataset.blinds as BlindSpeed))));
  const opp = document.getElementById('opp') as HTMLInputElement | null;
  if (opp) {
    opp.oninput = () => (document.getElementById('opp-out')!.textContent = opp.value);
    opp.onchange = () => update(() => (setup.opponents = Number(opp.value)));
  }
  const openProfile = () => renderProfile(app, renderSetup, () => renderAchievements(app, openProfile));
  document.getElementById('open-profile')!.onclick = openProfile;
  bindFriendsPanel(() => ({
    name: me.name,
    playerId: me.id,
    title: currentTitle() ? me.title : null,
    settings: {
      variant: setup.variant, structure: struct, format: setup.format, difficulty: setup.difficulty,
      stackBB: setup.stackBB, blindSpeed: setup.blindSpeed, seats: setup.format === 'headsup' ? 2 : setup.opponents + 1,
      // A blackjack table takes the limits and bots from the blackjack card.
      ...(setup.game === 'blackjack' ? { game: 'blackjack' as const, bjLimits: setup.bj.limits, bots: setup.bj.bots } : {}),
    },
  }));
  bindConsoleButton();
  void refreshConsoleAccess();
  if (awardsChecked !== me.id) {
    // Once per player: pick up achievements the table server credited since last time.
    awardsChecked = me.id;
    const before = currentTitle();
    void checkAchievements().then(() => {
      if (currentTitle() !== before && !game && document.querySelector('main.lobby:not(.profile-page):not(.welcome):not(.room)')) renderSetup();
    });
  }
  const refillBtn = document.getElementById('refill');
  if (refillBtn) refillBtn.onclick = () => {
    refill(me);
    savePlayer();
    renderSetup();
  };
  document.getElementById('deal')!.onclick = () => {
    saveSettings();
    if (setup.game === 'blackjack') {
      blackjack = new BlackjackTable({ app, setup: setup.bj, prefs, save: saveSettings, leave: renderSetup });
      blackjack.start();
      return;
    }
    const next = new Game(setup);
    if (!next.start()) return renderSetup();
    game = next;
  };
}

/** Chips a game takes from the bank: the cash buy-in, or the tournament entry fee. */
function entryCost(s: Setup): number {
  return s.format === 'cash' ? s.stackBB * BIG_BLIND : TOURNAMENT_FEE;
}

function difficultyHint(d: DifficultyChoice): string {
  switch (d) {
    case 'beginner': return 'Calls too much, rarely raises, almost never bluffs.';
    case 'easy': return 'Plays a lot of hands and is easy to push off a pot.';
    case 'medium': return 'Plays solid starting hands and respects pot odds.';
    case 'hard': return 'Reads your likely range from your betting and bluffs at the right times.';
    case 'expert': return 'Tracks how each player bets over time and adjusts to it.';
    default: return 'Every bot gets a random skill level and style.';
  }
}

// ---------- game ----------

interface LogLine { text: string; kind: string; me: boolean }

class Game implements DevGame {
  readonly setup: Setup;
  readonly table: Table;
  readonly bots = new Map<string, Bot>();
  readonly humanId = 'p0';
  private timer: number | undefined;
  private log: LogLine[] = [];
  private logCursor = 0;
  private logHand: Hand | null = null;
  private selected = new Set<number>();
  private seenCards = new Set<string>();
  private modal: 'none' | 'settings' | 'leave' | 'busted' | 'over' = 'none';
  private spectating = false;
  private logOpen = window.matchMedia('(min-width: 1280px)').matches;
  private oddsKey = '';
  private oddsValue: number | null = null;
  private turnCue = '';
  private stopped = false;
  /** The player whose bank pays for this game. */
  private readonly profile = player();
  private recorded: Hand | null = null;
  /** The console rigged a hand or played for the player, so this game earns no achievements. */
  private tainted = false;
  /** Tournament prize paid into the bank, once the player's finishing place is known. */
  private prize: number | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  // Developer console controls.
  paused = false;
  autopilot: Bot | null = null;
  botDelay: number | null = null;

  constructor(s: Setup) {
    this.setup = s;
    const v = VARIANTS[s.variant];
    const rng = createRng();
    const names = shuffle([...BOT_NAMES], rng);
    const opponents = s.format === 'headsup' ? 1 : Math.min(s.opponents, v.maxPlayers - 1);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)];
    const seats: SeatConfig[] = [{ name: s.name || 'You', isHuman: true }];
    for (let i = 0; i < opponents; i++) {
      seats.push({ name: names[i], isHuman: false, difficulty: s.difficulty === 'mixed' ? pick(DIFFICULTIES) : s.difficulty, style: pick(STYLES) });
    }
    this.table = new Table({
      variant: s.variant,
      structure: structureFor(s.variant),
      format: s.format,
      startingStack: s.stackBB * BIG_BLIND,
      bigBlind: BIG_BLIND,
      handsPerLevel: HANDS_PER_LEVEL[s.blindSpeed],
      seats,
    });
    for (const seat of this.table.seats) if (!seat.isHuman) this.bots.set(seat.id, new Bot(seat.difficulty!, seat.style));
  }

  /** Pays the buy-in or entry fee and deals the first hand. False if the bank can't cover it. */
  start(): boolean {
    const p = this.profile;
    const paid = this.table.isTournament ? enterTournament(p) : buyIn(p, this.table.config.startingStack);
    if (!paid) return false;
    savePlayer();
    document.addEventListener('keydown', this.keyHandler);
    this.dealNext();
    return true;
  }

  /** Ends the game. Cash-game chips go back to the bank; an unfinished tournament is forfeited. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    document.removeEventListener('keydown', this.keyHandler);
    if (this.table.isTournament) abandonTournament(this.profile);
    else {
      const net = cashOut(this.profile, this.myStack());
      if (!this.tainted) credit(this.profile, cashTally(net, BIG_BLIND));
    }
    announce(takeUnlocks(this.profile, serverAwards()));
    savePlayer();
  }

  /** The player's chips right now. Leaving mid-hand gives up whatever is already in the pot. */
  private myStack(): number {
    const hand = this.hand;
    const hi = this.humanIndex;
    return hand && !hand.isComplete && hi >= 0 ? hand.players[hi].stack : this.humanSeat.stack;
  }

  /** Adds a finished hand to the player's record and keeps their bank in step with the table. */
  private recordResult(hand: Hand) {
    if (this.recorded === hand) return;
    this.recorded = hand;
    const p = this.profile;
    const hi = this.humanIndex;
    if (hand.wasRigged || this.autopilot) this.tainted = true;
    if (hi >= 0) {
      const me = hand.players[hi];
      const won = hand.result?.won[hi] ?? 0;
      recordHand(p, { variant: this.setup.variant, net: me.stack - me.startStack, collected: won, showdownWin: !!hand.result?.showdown && me.shown && won > 0 });
      if (!this.tainted) {
        const run = runAfter(p.achievements.run, hand, hi);
        p.achievements.run = run;
        credit(p, mergeTally(handTally(hand, hi), { sum: {}, max: { bestRun: run } }));
      }
    }
    if (!this.table.isTournament) setTableStack(p, this.humanSeat.stack);
    else if (this.humanSeat.place && this.prize === null) {
      this.prize = finishTournament(p, this.humanSeat.place, this.table.seats.length);
      if (!this.tainted) {
        const bots = this.table.seats.filter((s) => !s.isHuman).map((s) => s.difficulty);
        credit(p, tournamentTally({ format: this.table.config.format, place: this.humanSeat.place, cashed: this.prize > 0, bots }));
      }
    }
    announce(takeUnlocks(p, serverAwards()));
    savePlayer();
  }

  private get hand(): Hand | null {
    return this.table.hand;
  }

  private get humanIndex(): number {
    return this.table.handIndexOf(this.humanId);
  }

  private get humanSeat(): Seat {
    return this.table.seats[0];
  }

  private dealNext() {
    clearTimeout(this.timer);
    this.selected.clear();
    if (this.table.isOver) {
      this.modal = 'over';
      this.render();
      return;
    }
    this.table.nextHand();
    this.sync();
  }

  /** Pull new log lines, render, and schedule whatever happens next. */
  private sync() {
    if (this.stopped) return;
    const hand = this.hand!;
    if (this.logHand !== hand) {
      this.logHand = hand;
      this.logCursor = 0;
    }
    const fresh = hand.log.slice(this.logCursor);
    for (; this.logCursor < hand.log.length; this.logCursor++) {
      const e = hand.log[this.logCursor];
      const text = e.kind === 'start' ? `Hand ${this.table.handNumber} · ${e.text}` : e.text;
      this.log.push({ text: this.speak(text), kind: e.kind, me: e.player !== undefined && e.player === this.humanIndex });
    }
    this.playSounds(hand, fresh);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);

    if (hand.isComplete) {
      this.table.finishHand();
      this.recordResult(hand);
      const me = this.humanSeat;
      if (!this.spectating && me.busted) this.modal = this.table.isTournament ? 'over' : 'busted';
      else if (this.table.isOver) this.modal = 'over';
    }
    this.render();
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    const hand = this.hand;
    if (!hand || this.modal !== 'none' || this.paused) return;
    const humanOut = this.spectating || this.humanIndex < 0 || hand.players[this.humanIndex].status === 'folded';
    const base = this.botDelay ?? BOT_DELAY[prefs.speed] * (humanOut ? 0.45 : 1);
    if (hand.isComplete) {
      if (prefs.autoDeal || this.spectating || this.autopilot) this.timer = window.setTimeout(() => this.dealNext(), this.botDelay ?? Math.max(900, base * 3));
      return;
    }
    if (hand.toAct === this.humanIndex && !this.autopilot) return;
    this.timer = window.setTimeout(() => this.botAct(), base);
  }

  refresh() {
    this.render();
    this.schedule();
  }

  step() {
    const hand = this.hand;
    if (!hand || this.modal !== 'none') return;
    if (hand.isComplete) this.dealNext();
    else this.botAct();
  }

  deal() {
    if (this.hand?.isComplete && this.modal === 'none') this.dealNext();
  }

  private botAct() {
    const hand = this.hand;
    if (!hand || hand.isComplete || this.stopped) return;
    const seat = this.table.seatOf(hand.toAct);
    const bot = this.bots.get(seat.id) ?? (seat.isHuman ? this.autopilot : null);
    if (!bot) return;
    const action = bot.decide(buildView(hand, hand.toAct, this.table.stats));
    hand.act(hand.normalize(action));
    if (seat.isHuman) this.selected.clear();
    this.sync();
  }

  private humanAct(a: Action) {
    const hand = this.hand;
    if (!hand || hand.isComplete || hand.toAct !== this.humanIndex) return;
    hand.act(hand.normalize(a));
    this.selected.clear();
    this.sync();
  }

  /** Turn the log lines a sync just added into table sounds, spaced out so a burst (blinds, a deal) reads clearly. */
  private playSounds(hand: Hand, entries: Hand['log']) {
    const cues: SoundName[] = [];
    let won = false;
    for (const e of entries) {
      const t = e.text;
      if (e.kind === 'start') cues.push('shuffle');
      else if (e.kind === 'deal') cues.push('deal', 'deal', 'deal');
      else if (e.kind === 'street') cues.push(hand.variant.family === 'flop' ? 'flip' : 'deal');
      else if (e.kind === 'info' && / shows /.test(t)) cues.push('flip');
      else if (e.kind === 'win') won = true;
      else if (e.kind === 'action') {
        if (/all-in/.test(t)) cues.push('allin');
        else if (/ folds$/.test(t)) cues.push('fold');
        else if (/ (checks|stands pat)$/.test(t)) cues.push('check');
        else if (/ draws \d/.test(t)) cues.push('deal', 'deal');
        else cues.push('chips');
      }
    }
    if (won) {
      const res = hand.result;
      const hi = this.humanIndex;
      const mine = !!res && hi >= 0 && res.pots.some((p) => (p.eligible.length > 1 || !res.showdown) && [...p.winnersHi, ...p.winnersLo].includes(hi));
      cues.push(mine ? 'win' : 'pot');
    }
    const key = `${this.table.handNumber}:${hand.log.length}`;
    if (!hand.isComplete && hand.toAct >= 0 && hand.toAct === this.humanIndex && !this.spectating && this.turnCue !== key) {
      this.turnCue = key;
      cues.push('turn');
    }
    // Keep a long burst short: the last few cues are the ones that matter.
    cues.slice(-6).forEach((c, i) => play(c, i * 0.13));
  }

  /** Engine text is third person ("Ada calls"). When the player is named "You", fix the verbs. */
  private speak(text: string): string {
    if (this.humanSeat.name !== 'You') return text;
    return text
      .replace(/\bYou (is|has|calls|checks|folds|bets|raises|posts|shows|wins|brings|completes|draws|stands|gets|scoops|splits)\b/g, (_, v: string) =>
        `You ${v === 'is' ? 'are' : v === 'has' ? 'have' : v.slice(0, -1)}`)
      .replace(/\b(You (?:call|bet|raise|complete|post)[^,]*?) and is all-in/, '$1 and are all-in');
  }

  // ---------- rendering ----------

  render() {
    if (this.stopped) return;
    const hand = this.hand!;
    const t = this.table;
    const v = t.variant;
    const s = hand.stakes;
    const stakes = v.family === 'stud'
      ? `Limits <b>${fmt(s.smallBet)}/${fmt(s.bigBet)}</b> · ante ${fmt(s.ante)}`
      : `Blinds <b>${fmt(s.sb)}/${fmt(s.bb)}</b>${s.ante ? ` · ante ${fmt(s.ante)}` : ''}`;
    const level = t.isTournament
      ? ` · Level <b>${t.level + 1}</b> · next in ${t.handsUntilNextLevel()} hand${t.handsUntilNextLevel() === 1 ? '' : 's'} · <b>${t.liveSeats.length}</b> left`
      : '';
    const logScroll = document.querySelector('.log ol')?.scrollTop;
    const atBottom = (() => {
      const el = document.querySelector('.log ol');
      return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    })();

    const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    app.innerHTML = `
    <div class="game ${prefs.fourColor ? 'four-color' : ''} ${this.logOpen ? 'log-open' : ''}">
      <header class="topbar">
        <div class="tb-game">
          <span class="title">${STRUCTURE_NAMES[hand.structure]} ${v.name}</span>
          <span class="chip-info">${stakes} · Hand <b>${t.handNumber}</b>${level}${this.paused ? ' · <b class="dev-flag">Paused</b>' : ''}${this.autopilot ? ' · <b class="dev-flag">Autopilot</b>' : ''}</span>
        </div>
        <div class="tb-actions">
          ${consoleEnabled() ? `<button type="button" class="icon-btn" id="dev-toggle" title="Developer console (\`)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 7 5 5-5 5M12 18h7"/></svg><span>Console</span></button>` : ''}
          <button type="button" class="icon-btn" id="log-toggle" aria-pressed="${this.logOpen}" title="Hand log">${icon('M4 6h16M4 12h16M4 18h10')}<span>Log</span></button>
          <button type="button" class="icon-btn" id="sound-toggle" aria-pressed="${prefs.sound}" title="${prefs.sound ? 'Mute sounds (M)' : 'Turn sounds on (M)'}">${icon(prefs.sound ? 'M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z' : 'M4 9v6h4l5 4V5L8 9H4Zm12 .5 5 5m0-5-5 5')}<span>${prefs.sound ? 'Sound' : 'Muted'}</span></button>
          <button type="button" class="icon-btn" id="open-settings" title="Settings">${icon('M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.5a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.4 2.5h4l.4-2.5c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6Z')}<span>Settings</span></button>
          <button type="button" class="icon-btn" id="leave" title="Leave table">${icon('M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11')}<span>Leave</span></button>
        </div>
      </header>
      <div class="table-wrap">${this.tableHtml()}</div>
      <div class="actionbar">${this.actionsHtml()}</div>
      <aside class="log" aria-label="Hand log">
        <h2>Hand log <button type="button" class="icon-btn close-log" id="log-close" aria-label="Close log">✕</button></h2>
        <ol>${this.log.map((l) => `<li class="k-${l.kind}${l.me ? ' me' : ''}">${esc(l.text)}</li>`).join('')}</ol>
      </aside>
    </div>
    ${this.modalHtml()}`;

    const ol = document.querySelector('.log ol');
    if (ol) ol.scrollTop = atBottom || logScroll === undefined ? ol.scrollHeight : logScroll;
    this.bind();
  }

  private seatLayout(): { x: number; y: number }[] {
    const n = this.table.seats.length;
    const narrow = window.matchMedia('(max-width: 720px)').matches;
    const rx = narrow ? 40 : 44;
    const ry = narrow ? 40 : 37;
    return this.table.seats.map((_, i) => {
      const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
      // The player's own seat sits a little higher so their bigger cards stay on the table.
      return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) - (i === 0 ? 6 : 0) };
    });
  }

  private tableHtml(): string {
    const hand = this.hand!;
    const t = this.table;
    const pos = this.seatLayout();
    const cx = 50;
    const cy = 47;
    const res = hand.result;
    const parts: string[] = [];
    // Winners of contested pots (an uncalled bet coming back is not a win).
    const winners = new Set<number>();
    for (const pot of res?.pots ?? []) {
      if (pot.eligible.length > 1 || !res!.showdown) for (const w of [...pot.winnersHi, ...pot.winnersLo]) winners.add(w);
    }

    t.seats.forEach((seat, si) => {
      const p = pos[si];
      const hi = t.handIndexOf(seat.id);
      const hp = hi >= 0 ? hand.players[hi] : null;
      const isMe = seat.isHuman;
      const classes = ['seat'];
      if (isMe) classes.push('me');
      if (!hp) classes.push('busted');
      if (hp?.status === 'folded') classes.push('folded');
      if (hi >= 0 && hand.toAct === hi && !hand.isComplete) classes.push('acting');
      if (res && hi >= 0 && winners.has(hi)) classes.push('winner');
      if (hp && hp.cards.length > 4) classes.push('many');
      if (hp && !isMe && hp.status !== 'folded' && (hp.shown || prefs.reveal)) classes.push('showing');

      let cards = '';
      if (hp && (hp.status !== 'folded' || isMe)) {
        const pickable = isMe && hand.phase === 'draw' && hand.toAct === hi;
        cards = hp.cards
          .map((c, k) => {
            const visible = isMe || hp.shown || hp.faceUp[k] || prefs.reveal;
            const key = `${t.handNumber}:${seat.id}:${k}:${visible ? c : 'x'}`;
            const cls: string[] = [];
            if (!this.seenCards.has(key)) {
              cls.push('deal');
              this.seenCards.add(key);
            }
            if (isMe && hand.variant.family === 'stud' && !hp.faceUp[k]) cls.push('hole-own');
            if (hand.variant.family === 'stud' && hp.faceUp[k]) cls.push('upcard');
            if (pickable) cls.push('pickable');
            if (pickable && this.selected.has(k)) cls.push('selected');
            const attr = pickable ? ` data-pick="${k}" role="button" tabindex="0"` : '';
            return cardHtml(visible ? c : null, cls.join(' ')).replace('<div ', `<div style="--k:${k - (hp.cards.length - 1) / 2}"${attr} `);
          })
          .join('');
      }
      const tag = isMe ? 'You' : `${DIFFICULTY_NAMES[seat.difficulty!]} · ${STYLE_NAMES[seat.style ?? 'balanced']}`;
      const stack = hp ? hp.stack : seat.stack;
      let bubble = '';
      if (!hp) bubble = `<span class="bubble">${t.isTournament ? (seat.place ? `Out · ${ordinal(seat.place)}` : 'Out') : 'Broke'}</span>`;
      else if (res && winners.has(hi)) bubble = `<span class="bubble won">+${fmt(res.won[hi])}</span>`;
      else if (res?.showdown && res.handNames[hi]) bubble = `<span class="bubble handname">${esc(res.handNames[hi]!)}</span>`;
      else if (hp.status === 'allin') bubble = `<span class="bubble allin">All-in</span>`;
      else if (hp.lastAction) bubble = `<span class="bubble a-${hp.lastAction.split(' ')[0].toLowerCase()}">${esc(hp.lastAction)}</span>`;
      const handName = res && winners.has(hi) && res.showdown && res.handNames[hi] ? `<span class="bubble handname">${esc(res.handNames[hi]!)}</span>` : '';
      const level = isMe ? 'human' : seat.difficulty!;

      parts.push(`<div class="${classes.join(' ')}" style="left:${p.x}%;top:${p.y}%">
        <div class="cards">${cards}</div>
        <div class="pod" title="${esc(seat.name)} · ${tag}">
          <span class="avatar lv-${level}">${esc(seat.name.slice(0, 1).toUpperCase())}</span>
          <span class="plate"><span class="nm">${esc(seat.name)}</span><span class="stk">${fmt(stack)}</span></span>
          ${isMe ? (currentTitle() ? `<span class="lvl lv-human ttl">${esc(currentTitle()!)}</span>` : '') : `<span class="lvl lv-${level}">${DIFFICULTY_NAMES[seat.difficulty!]}</span>`}
        </div>
        <div class="bubbles">${handName}${bubble}</div>
      </div>`);

      if (hp && hp.streetBet > 0 && !hand.isComplete && hand.phase !== 'draw') {
        // The player's chips go beside their cards rather than on top of them.
        const bx = isMe ? p.x + 13 : cx + (p.x - cx) * 0.55;
        const by = isMe ? p.y - 6 : cy + (p.y - cy) * 0.52;
        parts.push(`<div class="bet" style="left:${bx}%;top:${by}%">${chipsHtml(hp.streetBet)}<span>${fmt(hp.streetBet)}</span></div>`);
      }
      if (hi === hand.button && hand.variant.family !== 'stud') {
        const ang = Math.atan2(p.y - cy, p.x - cx) + 0.32;
        const r = Math.hypot(p.x - cx, p.y - cy) * 0.66;
        parts.push(`<div class="dealer" style="left:${cx + Math.cos(ang) * r}%;top:${cy + Math.sin(ang) * r}%" title="Dealer button">D</div>`);
      }
    });

    const boardSlots = hand.variant.family === 'flop' ? 5 : hand.board.length;
    const board = Array.from({ length: boardSlots }, (_, k) => {
      const c = hand.board[k];
      if (c === undefined) return '<div class="card empty"></div>';
      const key = `${t.handNumber}:board:${k}`;
      const fresh = !this.seenCards.has(key);
      this.seenCards.add(key);
      return cardHtml(c, fresh ? 'deal' : '');
    }).join('');
    if (this.seenCards.size > 4000) this.seenCards.clear();

    const potLabel = hand.isComplete || hand.pot === 0 ? '<div class="pot empty"></div>' : `<div class="pot">${chipsHtml(hand.pot, 7)}<span>Pot <b>${fmt(hand.pot)}</b></span></div>`;
    const result = res ? `<div class="result" role="status">${esc(this.speak(res.summary[0] ?? ''))}</div>` : '';
    return `<div class="table">
      <div class="rail"><div class="felt"></div></div>
      <div class="center"><div class="board">${board}</div>${result || potLabel}</div>
      ${parts.join('')}
    </div>`;
  }

  private myHandHtml(): string {
    const hand = this.hand!;
    const hi = this.humanIndex;
    if (hi < 0) return '';
    const p = hand.players[hi];
    const name = describeHolding(hand.variant, p.cards, hand.board);
    let odds = '';
    if (prefs.showOdds && !hand.isComplete && p.status !== 'folded') {
      const live = hand.players.filter((q) => q.status !== 'folded').length;
      const key = `${this.table.handNumber}|${hand.street}|${hand.phase}|${hand.board.length}|${live}|${p.cards.join(',')}`;
      if (key !== this.oddsKey) {
        this.oddsKey = key;
        const view = buildView(hand, hi, this.table.stats);
        const opts = hand.variant.family === 'draw' && hand.phase === 'draw' && this.selected.size
          ? { keep: p.cards.filter((_, k) => !this.selected.has(k)) }
          : {};
        this.oddsValue = simulateEquity(specFromView(view, opts), { iterations: 1500, rng: createRng(), timeBudgetMs: 60 });
      }
      if (this.oddsValue !== null) {
        const pct = Math.round(this.oddsValue * 100);
        odds = `<span class="odds" title="Your share of the pot against random hands"><span class="meter"><i style="width:${pct}%"></i></span><span>Pot share <b>${pct}%</b> vs ${live - 1} random hand${live > 2 ? 's' : ''}</span></span>`;
      }
    }
    return `<div class="myhand"><span class="hn">${esc(name || ' ')}</span>${odds}</div>`;
  }

  private actionsHtml(): string {
    const hand = this.hand!;
    const hi = this.humanIndex;
    const mine = this.myHandHtml();
    if (hand.isComplete) {
      const res = hand.result;
      const auto = prefs.autoDeal || this.spectating;
      const lines = (res?.summary ?? []).slice(1).map((l) => `<div>${esc(this.speak(l))}</div>`).join('');
      const note = this.spectating ? 'Watching the bots finish the tournament.' : auto ? 'Next hand coming up…' : '';
      return `${mine}<span class="status">${lines}${note ? `<div>${note}</div>` : ''}</span>${
        auto || this.modal !== 'none' ? '' : '<div class="acts"><button type="button" class="act raise" id="next-hand">Next hand<kbd>Space</kbd></button></div>'}`;
    }
    if (hi < 0 || hand.toAct !== hi) {
      const who = hand.toAct >= 0 ? hand.players[hand.toAct].name : '';
      const folded = hi >= 0 && hand.players[hi].status === 'folded';
      return `${mine}<span class="status">${folded ? 'You folded. ' : ''}${who ? `Waiting for <b>${esc(who)}</b>…` : ''}</span>`;
    }
    const L = hand.legal();
    if (L.kind === 'draw') {
      const n = this.selected.size;
      return `${mine}<span class="status">Tap the cards you want to throw away.</span>
        <div class="acts"><button type="button" class="act raise" id="do-draw">${n ? `Discard ${n} and draw` : 'Stand pat'}</button></div>`;
    }
    if (L.kind !== 'bet') return mine;
    return `${mine}<div class="acts">${this.betButtons(L, hand)}</div>`;
  }

  private betButtons(L: Extract<LegalActions, { kind: 'bet' }>, hand: Hand): string {
    const out: string[] = [];
    const me = hand.players[this.humanIndex];
    if (L.bringIn) {
      out.push(`<button type="button" class="act call" id="do-bringin">Bring in ${fmt(L.bringInAmount)}</button>`);
      if (L.raise) out.push(`<button type="button" class="act raise" id="do-raise" data-to="${L.minRaiseTo}">Complete to ${fmt(L.minRaiseTo)}</button>`);
      return out.join('');
    }
    if (L.fold) out.push(`<button type="button" class="act fold" id="do-fold">Fold<kbd>F</kbd></button>`);
    if (L.check) out.push(`<button type="button" class="act call" id="do-check">Check<kbd>C</kbd></button>`);
    if (L.call) {
      const allin = L.callAmount >= me.stack;
      out.push(`<button type="button" class="act call" id="do-call">Call ${fmt(L.callAmount)}${allin ? ' (all-in)' : ''}<kbd>C</kbd></button>`);
    }
    if (!L.raise) return out.join('');
    const verb = L.isBet ? 'Bet' : 'Raise to';
    if (L.minRaiseTo === L.maxRaiseTo) {
      const allin = L.maxRaiseTo >= me.streetBet + me.stack;
      out.push(`<button type="button" class="act raise" id="do-raise" data-to="${L.minRaiseTo}">${allin ? 'All-in' : verb} ${fmt(L.minRaiseTo)}<kbd>R</kbd></button>`);
      return out.join('');
    }
    const potTo = (f: number) => Math.round(hand.currentBet + (hand.pot + L.callAmount) * f);
    const clampTo = (x: number) => Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, x));
    let def: number;
    if (hand.variant.family === 'flop' && hand.street === 0) def = hand.currentBet <= hand.stakes.bb ? hand.stakes.bb * 3 : hand.currentBet * 3;
    else def = potTo(0.6);
    def = clampTo(def);
    const presets: [string, number][] = [
      ['Min', L.minRaiseTo],
      ['½ pot', potTo(0.5)],
      ['¾ pot', potTo(0.75)],
      ['Pot', potTo(1)],
      [hand.structure === 'PL' ? 'Max' : 'All-in', L.maxRaiseTo],
    ];
    const seen = new Set<number>();
    const presetHtml = presets
      .map(([label, to]) => [label, clampTo(to)] as [string, number])
      .filter(([, to]) => (seen.has(to) ? false : (seen.add(to), true)))
      .map(([label, to]) => `<button type="button" class="preset" data-preset="${to}">${label}</button>`)
      .join('');
    out.push(`<div class="sizer">
      ${presetHtml}
      <input type="range" id="raise-range" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" step="1" value="${def}" aria-label="Raise amount">
      <input type="number" id="raise-input" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" value="${def}" aria-label="Raise to">
    </div>
    <button type="button" class="act raise" id="do-raise" data-to="${def}" data-verb="${verb}">${def >= me.streetBet + me.stack ? 'All-in' : verb} ${fmt(def)}<kbd>R</kbd></button>`);
    return out.join('');
  }

  private modalHtml(): string {
    const t = this.table;
    if (this.modal === 'settings') {
      const speeds: [Speed, string][] = [['relaxed', 'Relaxed'], ['normal', 'Normal'], ['fast', 'Fast']];
      return `<div class="overlay"><div class="modal" role="dialog" aria-labelledby="set-title">
        <h2 id="set-title">Table settings</h2>
        <div class="field"><span class="flabel">Bot speed</span><div class="seg">${speeds.map(([s, l]) => `<button type="button" data-speed="${s}" aria-pressed="${prefs.speed === s}">${l}</button>`).join('')}</div></div>
        <div class="field"><label for="pref-volume">Sound volume <output id="vol-out">${prefs.sound ? `${Math.round(prefs.volume * 100)}%` : 'Muted'}</output></label>
          <input id="pref-volume" class="slider" type="range" min="0" max="100" step="5" value="${Math.round(prefs.volume * 100)}"></div>
        <label class="toggle"><input type="checkbox" id="pref-sound" ${prefs.sound ? 'checked' : ''}> Play table sounds</label>
        <label class="toggle"><input type="checkbox" id="pref-auto" ${prefs.autoDeal ? 'checked' : ''}> Deal the next hand automatically</label>
        <label class="toggle"><input type="checkbox" id="pref-odds" ${prefs.showOdds ? 'checked' : ''}> Show my pot share against random hands</label>
        <label class="toggle"><input type="checkbox" id="pref-four" ${prefs.fourColor ? 'checked' : ''}> Four-colour deck (blue diamonds, green clubs)</label>
        <label class="toggle"><input type="checkbox" id="pref-reveal" ${prefs.reveal ? 'checked' : ''}> Practice mode: show the bots' cards</label>
        <div class="row"><button type="button" class="btn btn-primary" id="close-modal">Done</button></div>
      </div></div>`;
    }
    if (this.modal === 'leave') {
      return `<div class="overlay"><div class="modal" role="dialog">
        <h2>Leave the table?</h2>
        <p>${t.isTournament
          ? (this.prize !== null ? 'You go back to the game menu.' : `You give up your ${fmt(TOURNAMENT_FEE)} entry fee and go back to the game menu.`)
          : `Your ${fmt(this.myStack())} chips go back to your bank.${this.hand && !this.hand.isComplete && this.humanIndex >= 0 && this.hand.players[this.humanIndex].status !== 'folded' ? ' Chips already in this pot are lost.' : ''}`}</p>
        <div class="row"><button type="button" class="btn" id="close-modal">Keep playing</button><button type="button" class="btn btn-primary" id="confirm-leave">Leave</button></div>
      </div></div>`;
    }
    if (this.modal === 'busted') {
      return `<div class="overlay"><div class="modal" role="dialog">
        <h2>You're out of chips</h2>
        ${canAfford(this.profile, t.config.startingStack)
          ? `<p>Buy back in for ${fmt(t.config.startingStack)} from your bank of ${fmt(this.profile.bank)}, or head back to the menu.${this.humanSeat.rebuys ? ` You have bought in ${this.humanSeat.rebuys + 1} times.` : ''}</p>`
          : `<p>Your bank has ${fmt(this.profile.bank)} chips, not enough to buy back in for ${fmt(t.config.startingStack)}.${canRefill(this.profile) ? ' You can refill it from the game menu.' : ' Try a table with a smaller starting stack.'}</p>`}
        <div class="row"><button type="button" class="btn" id="confirm-leave">Back to menu</button>${canAfford(this.profile, t.config.startingStack) ? '<button type="button" class="btn btn-primary" id="rebuy">Buy back in</button>' : ''}</div>
      </div></div>`;
    }
    if (this.modal === 'over') {
      const me = this.humanSeat;
      const ranked = [...t.seats].sort((a, b) => (a.place ?? 1) - (b.place ?? 1) || b.stack - a.stack);
      const done = t.isOver;
      const title = me.place === 1 ? 'You won the tournament!' : me.place ? `You finished ${ordinal(me.place)}` : 'Tournament over';
      return `<div class="overlay"><div class="modal" role="dialog">
        <h2>${title}</h2>
        <p>${done ? `${t.handNumber} hands played.` : `${t.liveSeats.length} players are still in.`}${this.prize ? ` <b class="prize">+${fmt(this.prize)} chips</b> to your bank.` : ''}</p>
        <table class="standings"><thead><tr><th>Place</th><th>Player</th><th>Level</th></tr></thead><tbody>
          ${ranked.map((s) => `<tr class="${s.isHuman ? 'me' : ''}"><td>${s.place ? ordinal(s.place) : 'Still in'}</td><td>${esc(s.name)}</td><td>${s.isHuman ? 'You' : DIFFICULTY_NAMES[s.difficulty!]}</td></tr>`).join('')}
        </tbody></table>
        <div class="row">
          ${done ? '' : '<button type="button" class="btn" id="spectate">Watch the rest</button>'}
          <button type="button" class="btn" id="confirm-leave">Back to menu</button>
          <button type="button" class="btn btn-primary" id="again">Play again</button>
        </div>
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
    on('open-settings', () => this.openModal('settings'));
    on('dev-toggle', toggleConsole);
    on('leave', () => this.openModal('leave'));
    const toggleLog = () => {
      this.logOpen = !this.logOpen;
      this.render();
    };
    on('log-toggle', toggleLog);
    on('log-close', toggleLog);
    on('close-modal', () => this.closeModal());
    on('confirm-leave', () => renderSetup());
    on('again', () => {
      this.stop();
      const next = new Game(this.setup);
      if (!next.start()) return renderSetup();
      game = next;
    });
    on('spectate', () => {
      this.spectating = true;
      this.closeModal();
    });
    on('rebuy', () => {
      if (!buyIn(this.profile, this.table.config.startingStack)) return;
      savePlayer();
      this.table.rebuy(this.humanId);
      this.modal = 'none';
      this.dealNext();
    });
    on('next-hand', () => this.dealNext());
    on('do-fold', () => this.humanAct({ type: 'fold' }));
    on('do-check', () => this.humanAct({ type: 'check' }));
    on('do-call', () => this.humanAct({ type: 'call' }));
    on('do-bringin', () => this.humanAct({ type: 'bringin' }));
    on('do-draw', () => this.humanAct({ type: 'draw', discard: [...this.selected] }));
    const raiseBtn = document.getElementById('do-raise');
    if (raiseBtn) raiseBtn.onclick = () => this.humanAct({ type: 'raise', to: Number(raiseBtn.dataset.to) });

    const range = document.getElementById('raise-range') as HTMLInputElement | null;
    const input = document.getElementById('raise-input') as HTMLInputElement | null;
    const setTo = (x: number) => {
      if (!range || !input || !raiseBtn) return;
      const lo = Number(range.min);
      const hi = Number(range.max);
      const to = Math.max(lo, Math.min(hi, Math.round(x) || lo));
      range.value = String(to);
      if (document.activeElement !== input) input.value = String(to);
      raiseBtn.dataset.to = String(to);
      const me = this.hand!.players[this.humanIndex];
      raiseBtn.innerHTML = `${to >= me.streetBet + me.stack ? 'All-in' : raiseBtn.dataset.verb} ${fmt(to)}<kbd>R</kbd>`;
    };
    if (range) range.oninput = () => setTo(Number(range.value));
    if (input) {
      input.oninput = () => setTo(Number(input.value));
      input.onkeydown = (e) => {
        if (e.key === 'Enter') raiseBtn?.click();
      };
    }
    document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => (b.onclick = () => {
      if (input) input.value = b.dataset.preset!;
      setTo(Number(b.dataset.preset));
    }));
    document.querySelectorAll<HTMLElement>('[data-pick]').forEach((el) => {
      const toggle = () => {
        const k = Number(el.dataset.pick);
        if (this.selected.has(k)) this.selected.delete(k);
        else this.selected.add(k);
        this.oddsKey = '';
        this.render();
      };
      el.onclick = toggle;
      el.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      };
    });
    document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => (b.onclick = () => {
      prefs.speed = b.dataset.speed as Speed;
      saveSettings();
      this.render();
    }));
    const pref = (id: string, key: keyof Prefs) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.onchange = () => {
        (prefs[key] as boolean) = el.checked;
        saveSettings();
        setVolume(prefs.volume, !prefs.sound);
        this.render();
      };
    };
    pref('pref-auto', 'autoDeal');
    pref('pref-odds', 'showOdds');
    pref('pref-four', 'fourColor');
    pref('pref-reveal', 'reveal');
    pref('pref-sound', 'sound');
    on('sound-toggle', () => this.toggleSound());
    const vol = document.getElementById('pref-volume') as HTMLInputElement | null;
    if (vol) {
      vol.oninput = () => {
        prefs.volume = Number(vol.value) / 100;
        if (prefs.volume > 0) prefs.sound = true;
        setVolume(prefs.volume, !prefs.sound);
        document.getElementById('vol-out')!.textContent = `${vol.value}%`;
        const box = document.getElementById('pref-sound') as HTMLInputElement | null;
        if (box) box.checked = prefs.sound;
      };
      vol.onchange = () => {
        saveSettings();
        play('chips');
      };
    }
  }

  private toggleSound() {
    prefs.sound = !prefs.sound;
    saveSettings();
    setVolume(prefs.volume, !prefs.sound);
    this.render();
    play('chips');
  }

  private openModal(m: 'settings' | 'leave') {
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
      if (e.key === 'Escape' && (this.modal === 'settings' || this.modal === 'leave')) this.closeModal();
      return;
    }
    const click = (id: string) => {
      const el = document.getElementById(id);
      if (el) {
        e.preventDefault();
        el.click();
      }
    };
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') click('next-hand');
    else if (k === 'f') click('do-fold');
    else if (k === 'c' || k === 'k') {
      if (document.getElementById('do-check')) click('do-check');
      else click('do-call');
    } else if (k === 'r') click('do-raise');
    else if (k === 'm') {
      e.preventDefault();
      this.toggleSound();
    }
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

let game: Game | null = null;
let blackjack: BlackjackTable | null = null;
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    game?.render();
    blackjack?.render();
  }, 150);
});

/** Opens the last player (online if signed in), or asks who's playing on a first visit. */
async function boot() {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    /* storage blocked: players last for this visit */
  }
  const local = new LocalAccountStore(storage);
  const auth = onlineEnabled(ONLINE) ? new OnlineAuth(ONLINE, storage) : null;
  initAccounts(local, auth, storage);
  initOnlinePlay({
    app,
    auth,
    lobby: renderSetup,
    signIn: () => renderAuth(app, renderSetup),
    prefs: () => prefs,
    toggleSound: () => {
      prefs.sound = !prefs.sound;
      saveSettings();
      setVolume(prefs.volume, !prefs.sound);
      play('chips');
    },
  });
  await migrateLegacySettings(local);

  // Links in account emails (confirm sign-up, reset password) come back with a session in the hash.
  let resetPassword = false;
  if (auth && /access_token|error_description/.test(location.hash)) {
    const hash = location.hash;
    history.replaceState(null, '', location.href.split('#')[0]);
    const r = await auth.fromRedirect(hash).catch(() => null);
    if (r && 'type' in r && r.type === 'recovery') resetPassword = true;
  }
  initConsole({
    game: () => game,
    redraw: () => {
      if (game) game.render();
      else if (blackjack) blackjack.render();
      else if (document.querySelector('main.lobby:not(.profile-page):not(.welcome):not(.room)')) renderSetup();
    },
    reveal: (on) => {
      if (on !== undefined && on !== prefs.reveal) {
        prefs.reveal = on;
        saveSettings();
        game?.render();
      }
      return prefs.reveal;
    },
    onlineTable: activeTable,
    blackjack: () => blackjack?.dev ?? null,
    announced: (text) => {
      announcement = text;
      if (!game && document.querySelector('main.lobby:not(.profile-page):not(.welcome):not(.room)')) renderSetup();
    },
  }, auth);
  if (auth) {
    void readAnnouncement(auth).then((text) => {
      announcement = text;
      if (text && !game && document.querySelector('main.lobby:not(.profile-page):not(.welcome):not(.room)')) renderSetup();
    });
  }
  // With online accounts on, everyone starts at the sign-in screen unless already signed in.
  const open = () => (auth?.current ? goOnline(renderSetup, app) : auth ? renderAuth(app, renderSetup) : openPlayer(renderSetup, app));
  if (resetPassword) renderNewPassword(app, open);
  else await open();
}

/** Before accounts existed, one name and its settings lived under older keys. They become the first player. */
async function migrateLegacySettings(local: LocalAccountStore) {
  if ((await local.list()).length) return;
  const legacySetup = store<Partial<Setup>>(LEGACY_SETUP_KEY, {});
  const legacyPrefs = store<Partial<Prefs>>(LEGACY_PREFS_KEY, {});
  if (!Object.keys(legacySetup).length && !Object.keys(legacyPrefs).length) return;
  const settings = { setup: legacySetup, prefs: legacyPrefs };
  const name = legacySetup.name && legacySetup.name !== 'You' ? legacySetup.name : '';
  if (name) await local.put(createProfile(name, { settings }));
  else setWelcomeSettings(settings);
}

boot();
