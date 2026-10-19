import { Bot, STYLE_NAMES } from '../bots/bot';
import { simulateEquity, specFromView } from '../bots/equity';
import { buildView } from '../bots/view';
import { createRng, shuffle } from '../engine/cards';
import { Action, Hand, LegalActions } from '../engine/hand';
import { BotStyle, DIFFICULTIES, DIFFICULTY_NAMES, Difficulty, FORMAT_NAMES, Format, Seat, SeatConfig, Table } from '../engine/table';
import { STRUCTURE_NAMES, Structure, VARIANTS, VARIANT_ORDER, VariantId, describeHolding } from '../engine/variants';
import { cardHtml, esc, fmt, save, store } from './dom';

// ---------- settings ----------

type DifficultyChoice = Difficulty | 'mixed';
type BlindSpeed = 'slow' | 'normal' | 'turbo';
type Speed = 'relaxed' | 'normal' | 'fast';

interface Setup {
  variant: VariantId;
  structures: Partial<Record<VariantId, Structure>>;
  format: Format;
  opponents: number;
  difficulty: DifficultyChoice;
  stackBB: number;
  blindSpeed: BlindSpeed;
  name: string;
}

interface Prefs {
  speed: Speed;
  autoDeal: boolean;
  showOdds: boolean;
  fourColor: boolean;
  reveal: boolean;
}

const SETUP_KEY = 'backroom-poker-setup';
const PREFS_KEY = 'backroom-poker-prefs';
let setup: Setup = store<Setup>(SETUP_KEY, {
  variant: 'holdem', structures: {}, format: 'cash', opponents: 5, difficulty: 'medium', stackBB: 100, blindSpeed: 'normal', name: 'You',
});
let prefs: Prefs = store<Prefs>(PREFS_KEY, { speed: 'normal', autoDeal: false, showOdds: true, fourColor: false, reveal: false });
if (!VARIANTS[setup.variant]) setup.variant = 'holdem';

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

// ---------- setup screen ----------

function renderSetup() {
  game?.stop();
  game = null;
  const v = VARIANTS[setup.variant];
  const maxOpp = v.maxPlayers - 1;
  if (setup.format === 'headsup') setup.opponents = 1;
  setup.opponents = Math.max(1, Math.min(maxOpp, setup.opponents));
  const struct = structureFor(setup.variant);
  const seg = <T extends string>(name: string, items: [T, string][], current: T, disabled: (t: T) => boolean = () => false) =>
    `<div class="seg" role="group">${items
      .map(([val, label]) => `<button type="button" data-${name}="${val}" aria-pressed="${val === current}" ${disabled(val) ? 'disabled' : ''}>${label}</button>`)
      .join('')}</div>`;

  app.innerHTML = `
  <main class="setup">
    <header class="brand">
      <h1>Back Room Poker <span class="pip">♥</span></h1>
      <p>Pick a game, choose your opponents, and take a seat. Bots range from first-timers to sharks that read your betting.</p>
    </header>
    <section>
      <h2 class="section-label">Game</h2>
      <div class="games">
        ${VARIANT_ORDER.map((id) => {
          const g = VARIANTS[id];
          return `<button type="button" class="game-tile" data-variant="${id}" aria-pressed="${id === setup.variant}">
            <span class="name">${g.name}</span>
            <span class="blurb">${g.blurb}</span>
            <span class="meta">${g.structures.map((s) => STRUCTURE_NAMES[s]).join(' · ')} · up to ${g.maxPlayers} players</span>
          </button>`;
        }).join('')}
      </div>
    </section>
    <section class="options">
      <div class="field">
        <span class="flabel">Betting</span>
        ${seg('structure', (['NL', 'PL', 'FL'] as Structure[]).map((s) => [s, STRUCTURE_NAMES[s]]), struct, (s) => !v.structures.includes(s))}
      </div>
      <div class="field">
        <span class="flabel">Format</span>
        ${seg('format', (Object.keys(FORMAT_NAMES) as Format[]).map((f) => [f, FORMAT_NAMES[f]]), setup.format)}
        <span class="hint">${
          setup.format === 'cash'
            ? 'Blinds stay put. Bots who go broke buy back in, and so can you.'
            : setup.format === 'sng'
              ? 'Everyone starts equal, blinds rise, last player with chips wins.'
              : 'One opponent, rising blinds, play until someone has every chip.'
        }</span>
      </div>
      <div class="field">
        <label for="opp">Opponents</label>
        <div class="range-row">
          <input id="opp" type="range" min="1" max="${maxOpp}" value="${setup.opponents}" ${setup.format === 'headsup' ? 'disabled' : ''}>
          <output id="opp-out">${setup.opponents}</output>
        </div>
      </div>
      <div class="field">
        <span class="flabel">Bot difficulty</span>
        ${seg('difficulty', [...DIFFICULTIES.map((d) => [d, DIFFICULTY_NAMES[d]] as [DifficultyChoice, string]), ['mixed', 'Mixed']], setup.difficulty)}
        <span class="hint">${difficultyHint(setup.difficulty)}</span>
      </div>
      <div class="field">
        <span class="flabel">Starting stack</span>
        ${seg('stack', [['50', '50 big blinds'], ['100', '100 big blinds'], ['200', '200 big blinds']], String(setup.stackBB) as '50' | '100' | '200')}
      </div>
      <div class="field">
        <span class="flabel">Blind levels</span>
        ${seg('blinds', [['slow', 'Slow'], ['normal', 'Normal'], ['turbo', 'Turbo']], setup.blindSpeed, () => setup.format === 'cash')}
        <span class="hint">${setup.format === 'cash' ? 'Only used in tournaments.' : `Blinds go up every ${HANDS_PER_LEVEL[setup.blindSpeed]} hands.`}</span>
      </div>
      <div class="field">
        <label for="pname">Your name</label>
        <input id="pname" class="text-input" maxlength="14" value="${esc(setup.name)}" autocomplete="off">
      </div>
    </section>
    <div class="cta-row">
      <button type="button" class="btn btn-primary" id="deal">Deal me in</button>
      <span class="summary-line">${STRUCTURE_NAMES[struct]} ${v.name}, ${FORMAT_NAMES[setup.format].toLowerCase()}, you against ${setup.opponents} ${
        setup.difficulty === 'mixed' ? 'mixed' : DIFFICULTY_NAMES[setup.difficulty].toLowerCase()
      } bot${setup.opponents > 1 ? 's' : ''}.</span>
    </div>
  </main>`;

  const update = (fn: () => void) => {
    fn();
    save(SETUP_KEY, setup);
    renderSetup();
  };
  app.querySelectorAll<HTMLButtonElement>('[data-variant]').forEach((b) => (b.onclick = () => update(() => (setup.variant = b.dataset.variant as VariantId))));
  app.querySelectorAll<HTMLButtonElement>('[data-structure]').forEach((b) => (b.onclick = () => update(() => (setup.structures[setup.variant] = b.dataset.structure as Structure))));
  app.querySelectorAll<HTMLButtonElement>('[data-format]').forEach((b) => (b.onclick = () => update(() => {
    const prev = setup.format;
    setup.format = b.dataset.format as Format;
    if (prev === 'headsup' && setup.format !== 'headsup') setup.opponents = 5;
  })));
  app.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((b) => (b.onclick = () => update(() => (setup.difficulty = b.dataset.difficulty as DifficultyChoice))));
  app.querySelectorAll<HTMLButtonElement>('[data-stack]').forEach((b) => (b.onclick = () => update(() => (setup.stackBB = Number(b.dataset.stack)))));
  app.querySelectorAll<HTMLButtonElement>('[data-blinds]').forEach((b) => (b.onclick = () => update(() => (setup.blindSpeed = b.dataset.blinds as BlindSpeed))));
  const opp = document.getElementById('opp') as HTMLInputElement;
  opp.oninput = () => (document.getElementById('opp-out')!.textContent = opp.value);
  opp.onchange = () => update(() => (setup.opponents = Number(opp.value)));
  const nameInput = document.getElementById('pname') as HTMLInputElement;
  nameInput.oninput = () => {
    setup.name = nameInput.value;
    save(SETUP_KEY, setup);
  };
  document.getElementById('deal')!.onclick = () => {
    setup.name = nameInput.value.trim() || 'You';
    save(SETUP_KEY, setup);
    game = new Game(setup);
    game.start();
  };
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

class Game {
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
  private logOpen = false;
  private oddsKey = '';
  private oddsValue: number | null = null;
  private stopped = false;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

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

  start() {
    document.addEventListener('keydown', this.keyHandler);
    this.dealNext();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    document.removeEventListener('keydown', this.keyHandler);
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
    for (; this.logCursor < hand.log.length; this.logCursor++) {
      const e = hand.log[this.logCursor];
      const text = e.kind === 'start' ? `Hand ${this.table.handNumber} · ${e.text}` : e.text;
      this.log.push({ text: this.speak(text), kind: e.kind, me: e.player !== undefined && e.player === this.humanIndex });
    }
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);

    if (hand.isComplete) {
      this.table.finishHand();
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
    if (!hand || this.modal !== 'none') return;
    const humanOut = this.spectating || this.humanIndex < 0 || hand.players[this.humanIndex].status === 'folded';
    const base = BOT_DELAY[prefs.speed] * (humanOut ? 0.45 : 1);
    if (hand.isComplete) {
      if (prefs.autoDeal || this.spectating) this.timer = window.setTimeout(() => this.dealNext(), Math.max(900, base * 3));
      return;
    }
    if (hand.toAct === this.humanIndex) return;
    this.timer = window.setTimeout(() => this.botAct(), base);
  }

  private botAct() {
    const hand = this.hand;
    if (!hand || hand.isComplete || this.stopped) return;
    const seat = this.table.seatOf(hand.toAct);
    const bot = this.bots.get(seat.id);
    if (!bot) return;
    const action = bot.decide(buildView(hand, hand.toAct, this.table.stats));
    hand.act(hand.normalize(action));
    this.sync();
  }

  private humanAct(a: Action) {
    const hand = this.hand;
    if (!hand || hand.isComplete || hand.toAct !== this.humanIndex) return;
    hand.act(hand.normalize(a));
    this.selected.clear();
    this.sync();
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

    app.innerHTML = `
    <div class="game ${prefs.fourColor ? 'four-color' : ''}">
      <header class="topbar">
        <span class="title">${STRUCTURE_NAMES[hand.structure]} ${v.name}</span>
        <span class="chip-info">${stakes} · Hand <b>${t.handNumber}</b>${level}</span>
        <span class="spacer"></span>
        <button type="button" class="icon-btn log-toggle" id="log-toggle">${this.logOpen ? 'Hide log' : 'Hand log'}</button>
        <button type="button" class="icon-btn" id="open-settings">Settings</button>
        <button type="button" class="icon-btn" id="leave">Leave table</button>
      </header>
      <div class="table-wrap">${this.tableHtml()}</div>
      <div class="actionbar">${this.actionsHtml()}</div>
      <aside class="log ${this.logOpen ? '' : 'collapsed'}">
        <h2>Hand log</h2>
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
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    const rx = narrow ? 40 : 43;
    const ry = narrow ? 43 : 41;
    return this.table.seats.map((_, i) => {
      const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
      return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
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
            return cardHtml(visible ? c : null, cls.join(' ')).replace('<div ', `<div${attr} `);
          })
          .join('');
      }
      const tag = isMe ? 'You' : `${DIFFICULTY_NAMES[seat.difficulty!]} · ${STYLE_NAMES[seat.style ?? 'balanced']}`;
      const stack = hp ? hp.stack : seat.stack;
      let bubble = '';
      if (!hp) bubble = `<span class="bubble">${t.isTournament ? (seat.place ? `Out · ${ordinal(seat.place)}` : 'Out') : 'Broke'}</span>`;
      else if (res?.showdown && res.handNames[hi]) bubble = `<span class="bubble handname">${esc(res.handNames[hi]!)}</span>`;
      else if (hp.status === 'allin') bubble = `<span class="bubble allin">All-in</span>`;
      else if (hp.lastAction) bubble = `<span class="bubble">${esc(hp.lastAction)}</span>`;
      const won = res && hi >= 0 && winners.has(hi) ? `<span class="bubble" style="color:var(--good)">+${fmt(res.won[hi])}</span>` : '';

      parts.push(`<div class="${classes.join(' ')}" style="left:${p.x}%;top:${p.y}%">
        <div class="cards">${cards}</div>
        <div class="plate">
          <span class="avatar" style="background:${AVATAR[isMe ? 'human' : seat.difficulty!]}">${esc(seat.name.slice(0, 2).toUpperCase())}</span>
          <span class="who"><span class="nm">${esc(seat.name)}</span><span class="stk">${fmt(stack)}</span><span class="tag">${tag}</span></span>
        </div>
        ${bubble}${won}
      </div>`);

      if (hp && hp.streetBet > 0 && !hand.isComplete && hand.phase !== 'draw') {
        const bx = cx + (p.x - cx) * 0.55;
        const by = cy + (p.y - cy) * 0.52;
        parts.push(`<div class="bet" style="left:${bx}%;top:${by}%"><span class="chip"></span>${fmt(hp.streetBet)}</div>`);
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

    const potLabel = hand.isComplete ? '' : `<div class="pot">Pot <b>${fmt(hand.pot)}</b></div>`;
    let result = '';
    if (res && this.modal === 'none') {
      const auto = prefs.autoDeal || this.spectating;
      result = `<div class="result" role="status">
        <div class="lines">${res.summary.map((l) => `<div>${esc(this.speak(l))}</div>`).join('')}</div>
        <div class="actions">${auto ? '<span class="chip-info">Next hand coming up</span>' : '<button type="button" class="btn btn-primary" id="next-hand">Next hand <kbd>Space</kbd></button>'}</div>
      </div>`;
    }
    return `<div class="table">
      <div class="felt"><span class="felt-mark">${esc(hand.variant.name)}</span></div>
      <div class="center"><div class="board">${board}</div>${potLabel}</div>
      ${parts.join('')}
      ${result}
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
        odds = `<span class="odds">Pot share vs. random hands: <b>${Math.round(this.oddsValue * 100)}%</b> against ${live - 1}</span>`;
      }
    }
    return `<div class="myhand"><span class="hn">${esc(name || ' ')}</span>${odds}</div>`;
  }

  private actionsHtml(): string {
    const hand = this.hand!;
    const hi = this.humanIndex;
    const mine = this.myHandHtml();
    if (hand.isComplete) return `${mine}<span class="status">${this.spectating ? 'Watching the bots finish the tournament.' : 'Hand over.'}</span>`;
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
        <p>This game ends and you go back to the game menu.</p>
        <div class="row"><button type="button" class="btn" id="close-modal">Keep playing</button><button type="button" class="btn btn-primary" id="confirm-leave">Leave</button></div>
      </div></div>`;
    }
    if (this.modal === 'busted') {
      return `<div class="overlay"><div class="modal" role="dialog">
        <h2>You're out of chips</h2>
        <p>Buy back in for ${fmt(t.config.startingStack)} and keep playing, or head back to the menu.${this.humanSeat.rebuys ? ` You have bought in ${this.humanSeat.rebuys + 1} times.` : ''}</p>
        <div class="row"><button type="button" class="btn" id="confirm-leave">Back to menu</button><button type="button" class="btn btn-primary" id="rebuy">Buy back in</button></div>
      </div></div>`;
    }
    if (this.modal === 'over') {
      const me = this.humanSeat;
      const ranked = [...t.seats].sort((a, b) => (a.place ?? 1) - (b.place ?? 1) || b.stack - a.stack);
      const done = t.isOver;
      const title = me.place === 1 ? 'You won the tournament!' : me.place ? `You finished ${ordinal(me.place)}` : 'Tournament over';
      return `<div class="overlay"><div class="modal" role="dialog">
        <h2>${title}</h2>
        <p>${done ? `${t.handNumber} hands played.` : `${t.liveSeats.length} players are still in.`}</p>
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
    on('leave', () => this.openModal('leave'));
    on('log-toggle', () => {
      this.logOpen = !this.logOpen;
      this.render();
    });
    on('close-modal', () => this.closeModal());
    on('confirm-leave', () => renderSetup());
    on('again', () => {
      game = new Game(this.setup);
      this.stop();
      game.start();
    });
    on('spectate', () => {
      this.spectating = true;
      this.closeModal();
    });
    on('rebuy', () => {
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
      save(PREFS_KEY, prefs);
      this.render();
    }));
    const pref = (id: string, key: keyof Prefs) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.onchange = () => {
        (prefs[key] as boolean) = el.checked;
        save(PREFS_KEY, prefs);
        this.render();
      };
    };
    pref('pref-auto', 'autoDeal');
    pref('pref-odds', 'showOdds');
    pref('pref-four', 'fourColor');
    pref('pref-reveal', 'reveal');
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
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

let game: Game | null = null;
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => game?.render(), 150);
});
renderSetup();
