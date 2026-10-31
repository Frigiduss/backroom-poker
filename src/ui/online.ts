// Playing with friends: the lobby panel, the waiting room, and the online table. The table
// here only draws what the server sends; every deal, bot move and payout happens on the
// server (src/online/server.ts), so this page never holds anyone else's cards.
import { simulateEquity, specFromView } from '../bots/equity';
import { STYLE_NAMES } from '../bots/bot';
import { PlayerView } from '../bots/view';
import { OnlineAuth } from '../accounts/online';
import { createRng } from '../engine/cards';
import { Action, LegalActions } from '../engine/hand';
import { DIFFICULTY_NAMES, FORMAT_NAMES } from '../engine/table';
import { STRUCTURE_NAMES, VARIANTS, describeHolding } from '../engine/variants';
import { TableClient } from '../online/client';
import { HandView, PlayerTag, TURN_SECONDS, TableSettings, TableView } from '../online/protocol';
import { checkAchievements } from './achievements';
import { HISTORY_ICON, openHandHistory, saveHand } from './history';
import { recordHistory } from '../engine/history';
import { cardHtml, chipsHtml, esc, fmt, isPhone, titleHtml, withHero } from './dom';
import { SoundName, play } from './sound';
import { consoleEnabled, toggleConsole } from './console';
import { BjScreen } from './online-blackjack';
import { ChatDock } from './chat';
import { BJ_RULES_LINE, limitText } from './blackjack';
import { avatarHtml, botTitle } from './talk';
import { bindTableInvites, lobbyInvitesHtml, openInvitePicker, tableInvitesHtml } from './friends';

/** A person with a plus, for the table's Invite button. */
const INVITE_ICON = 'M15 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10-2v6m3-3h-6';

export interface TablePrefs {
  fourColor: boolean;
  showOdds: boolean;
  sound: boolean;
}

interface Hooks {
  app: HTMLElement;
  auth: OnlineAuth | null;
  /** Back to the game menu. */
  lobby: () => void;
  /** The sign-in page. */
  signIn: () => void;
  prefs: () => TablePrefs;
  toggleSound: () => void;
  /** The player whose hand history finished hands go to. */
  playerId: () => string;
}

let hooks: Hooks;
let client: TableClient | null = null;
let active: OnlineTable | null = null;
/** A table this account is still sitting at, found when the lobby opens. */
let resumable: TableView | null = null;
let checkedResume = false;
/** A code from a shared link (?join=CODE or ?watch=CODE), filled in for the player. */
let linkCode = '';
/** The shared link was to watch, not to sit down. */
let linkWatch = false;
/** Who the player sits down as, from the lobby, for a watcher taking a seat later. */
let pickMe: (() => { name: string } & PlayerTag) | null = null;

export function initOnlinePlay(h: Hooks) {
  hooks = h;
  client = h.auth ? new TableClient(h.auth) : null;
  try {
    const url = new URL(location.href);
    const watch = url.searchParams.get('watch');
    const code = url.searchParams.get('join') ?? watch;
    if (code) {
      // Kept until used, so it survives signing up through an email link.
      localStorage.setItem(JOIN_KEY, code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8));
      if (watch && !url.searchParams.get('join')) localStorage.setItem(WATCH_KEY, '1');
      else localStorage.removeItem(WATCH_KEY);
      url.searchParams.delete('join');
      url.searchParams.delete('watch');
      history.replaceState(null, '', url.toString());
    }
    linkCode = localStorage.getItem(JOIN_KEY) ?? '';
    linkWatch = !!linkCode && localStorage.getItem(WATCH_KEY) === '1';
  } catch {
    /* no URL or storage to read */
  }
}

const JOIN_KEY = 'backroom-poker-join';
const WATCH_KEY = 'backroom-poker-join-watch';

function forgetLinkCode() {
  linkCode = '';
  linkWatch = false;
  try {
    localStorage.removeItem(JOIN_KEY);
    localStorage.removeItem(WATCH_KEY);
  } catch {
    /* nothing kept */
  }
}

const signedIn = () => !!(client && hooks.auth?.current);

/** Sits down at (or watches) a table from a friend's invite, through the lobby like an invite link. */
export function joinTable(code: string, watch: boolean) {
  linkCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  linkWatch = watch;
  hooks.lobby();
}

/** Leaves the online table screen (the seat stays; a bot plays it until the player is back). */
export function stopOnline() {
  active?.stop();
  active = null;
}

export const onlineActive = (): boolean => !!active;

/** The online table on screen, for the developer console. */
export const activeTable = (): { tableId: string; code: string; game: 'poker' | 'blackjack' } | null => (active ? active.where : null);

// ---------- lobby panel ----------

/** `solo` names the picked game when it can only be played alone, so no table can be made for it. */
export function friendsPanelHtml(solo?: string): string {
  if (!hooks?.auth) return '';
  const body = signedIn()
    ? `<p>Make a private table with the game and settings above, then send the code to your friends. Bots take any seats nobody fills. Got a code? Join to play, or watch first and sit in when you're ready.</p>
      ${lobbyInvitesHtml()}
      ${resumable ? `<div class="resume-row"><span>${resumable.watching ? 'You were watching' : 'You still have a seat at'} table <b>${esc(resumable.code)}</b> (${esc(gameName(resumable.settings))}).</span><button type="button" class="btn btn-sm btn-primary" id="resume-table">${resumable.watching ? 'Back to watching' : 'Back to the table'}</button></div>` : ''}
      <div class="friends-actions">
        <button type="button" class="btn btn-primary" id="make-table" ${solo ? 'disabled' : ''}>Make a table</button>
        <form class="join-form" id="join-form">
          <input class="text-input code-input" id="join-code" maxlength="8" placeholder="Table code" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(linkCode)}" aria-label="Table code">
          <button type="submit" class="btn">Join</button>
          <button type="button" class="btn" id="watch-table" title="See the table without taking a seat">Watch</button>
        </form>
      </div>
      ${solo ? `<p class="fine">${solo} is just you against the house for now. Pick poker or blackjack to make a table for friends.</p>` : ''}
      <p class="fine">Online tables play with table chips, so your bank stays as it is. Everyone gets ${TURN_SECONDS} seconds a turn.</p>
      <p class="form-error" id="friends-error" role="alert"></p>`
    : `<p>Sign in to an online account to make a table and invite friends with a code.</p>
      <div class="friends-actions"><button type="button" class="btn btn-primary" id="friends-sign-in">Sign in to play online</button></div>`;
  return `<section class="panel friends-panel">
    <h2 class="step">Play with friends</h2>
    ${body}
  </section>`;
}

/** Wires up the lobby panel. `pick` reads the table settings and name chosen in the lobby. */
export function bindFriendsPanel(pick: () => { settings: TableSettings; name: string } & PlayerTag) {
  if (!hooks?.auth) return;
  pickMe = pick;
  const err = (msg: string) => {
    const el = document.getElementById('friends-error');
    if (el) el.textContent = msg;
  };
  const busy = (on: boolean) => document.querySelectorAll<HTMLButtonElement>('.friends-panel button').forEach((b) => (b.disabled = on));
  const go = async (fn: () => Promise<TableView>) => {
    busy(true);
    err('');
    try {
      const view = await fn();
      forgetLinkCode();
      openTable(view);
    } catch (e) {
      busy(false);
      err((e as Error).message);
    }
  };
  const signIn = document.getElementById('friends-sign-in');
  if (signIn) signIn.onclick = () => hooks.signIn();
  const make = document.getElementById('make-table');
  if (make) make.onclick = () => go(async () => {
    const { settings, name, playerId, title } = pick();
    return (await client!.send({ op: 'create', name, settings, playerId, title })).view;
  });
  const form = document.getElementById('join-form') as HTMLFormElement | null;
  if (form) form.onsubmit = (e) => {
    e.preventDefault();
    const code = (document.getElementById('join-code') as HTMLInputElement).value.trim();
    if (!code) return err('Type the code your friend sent you.');
    const { name, playerId, title } = pick();
    void go(async () => (await client!.send({ op: 'join', code, name, playerId, title })).view);
  };
  const watchBtn = document.getElementById('watch-table');
  const watch = () => {
    const code = (document.getElementById('join-code') as HTMLInputElement).value.trim();
    if (!code) return err('Type the code of the table you want to watch.');
    const { name, playerId, title } = pick();
    void go(async () => (await client!.send({ op: 'watch', code, name, playerId, title })).view);
  };
  if (watchBtn) watchBtn.onclick = watch;
  const resume = document.getElementById('resume-table');
  if (resume && resumable) resume.onclick = () => go(async () => {
    const { name, playerId, title } = pick();
    // A watcher goes back to watching; joining would sit them down.
    return (await client!.send({ op: resumable!.watching ? 'watch' : 'join', code: resumable!.code, name, playerId, title })).view;
  });

  if (signedIn() && !checkedResume) {
    checkedResume = true;
    void client!.current().then((v) => {
      resumable = v;
      if (v && document.querySelector('.friends-panel')) hooks.lobby();
    }).catch(() => undefined);
  }
  if (linkCode && signedIn() && form) {
    // Try the invite once; if it fails the code stays in the box with the reason.
    const code = linkCode;
    const watching = linkWatch;
    forgetLinkCode();
    linkCode = code;
    if (watching) watch();
    else form.requestSubmit();
    linkCode = '';
  }
}

function gameName(s: TableSettings): string {
  if (s.game === 'blackjack') return 'Blackjack';
  return `${STRUCTURE_NAMES[s.structure]} ${VARIANTS[s.variant].name}`;
}

function openTable(view: TableView) {
  stopOnline();
  resumable = null;
  active = new OnlineTable(view);
  active.start();
}

// ---------- the table ----------

interface LogLine { text: string; kind: string; me: boolean }

const BOT_LABEL = (d?: string) => (d ? DIFFICULTY_NAMES[d as keyof typeof DIFFICULTY_NAMES] : 'Bot');

class OnlineTable {
  private view: TableView;
  private stopped = false;
  private pollTimer: number | undefined;
  private tickTimer: number | undefined;
  private clockTimer: number | undefined;
  /** Client clock minus server clock, to line up countdowns. */
  private skew = 0;
  private sending = false;
  private problem = '';
  private failures = 0;
  private selected = new Set<number>();
  private seenCards = new Set<string>();
  private log: LogLine[] = [];
  private logHand = -1;
  private logCursor = 0;
  private logOpen = window.matchMedia('(min-width: 1280px)').matches;
  private confirmLeave = false;
  private oddsKey = '';
  private oddsValue: number | null = null;
  private turnCue = '';
  private copied = false;
  private copiedWatch = false;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private resizeHandler = () => this.render();
  /** The last finished hand checked for achievements the server credited. */
  private awardsHand = -1;
  /** The last finished hand saved to the hand history, and its id there. */
  private savedHand = -1;
  private lastSaved: string | null = null;
  /** Draws a blackjack table, when this is one. */
  private readonly bj = new BjScreen({
    move: (move, amount) => {
      const v = this.view;
      if (v.bj) void this.send({ op: 'bj', tableId: v.tableId, round: v.bj.roundNumber, move, amount });
    },
    rebuy: () => void this.send({ op: 'rebuy', tableId: this.view.tableId }),
    back: () => void this.send({ op: 'back', tableId: this.view.tableId }),
    sending: () => this.sending,
    secondsLeft: (at) => this.secondsLeft(at),
    sit: () => this.sitIn(),
  });
  private chat: ChatDock | null = null;

  constructor(view: TableView) {
    this.view = view;
    this.skew = Date.now() - view.serverNow;
  }

  get where(): { tableId: string; code: string; game: 'poker' | 'blackjack' } {
    return { tableId: this.view.tableId, code: this.view.code, game: this.view.settings.game ?? 'poker' };
  }

  start() {
    document.addEventListener('keydown', this.keyHandler);
    window.addEventListener('resize', this.resizeHandler);
    this.absorbLog(false);
    window.scrollTo(0, 0);
    this.render();
    this.chat = new ChatDock({
      say: async (msg) => this.update((await client!.send({ op: 'chat', tableId: this.view.tableId, ...msg })).view),
      sound: () => hooks.prefs().sound,
    });
    this.chat.update(this.view);
    this.schedule();
    this.poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.tickTimer);
    clearInterval(this.clockTimer);
    this.chat?.destroy();
    this.chat = null;
    document.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('resize', this.resizeHandler);
  }

  // ---------- keeping up with the server ----------

  private poll() {
    if (this.stopped) return;
    // Check often while things are moving; less often when everyone is waiting on a person.
    const busy = this.view.tickAt !== null || this.view.phase === 'lobby';
    const delay = this.failures ? Math.min(8000, 1000 * 2 ** this.failures) : busy ? 700 : 1200;
    this.pollTimer = window.setTimeout(async () => {
      try {
        const next = await client!.poll(this.view.tableId, this.view.version);
        if (this.failures || this.problem) {
          this.failures = 0;
          this.problem = '';
          this.render();
        }
        if (next) this.update(next);
      } catch (e) {
        this.failures++;
        if (this.failures >= 2) {
          this.problem = `${(e as Error).message} Trying again…`;
          this.render();
        }
      }
      this.poll();
    }, delay);
  }

  private update(next: TableView) {
    if (this.stopped || next.version < this.view.version) return;
    const fresh = next.version > this.view.version;
    this.view = next;
    this.skew = Date.now() - next.serverNow;
    if (!fresh) return;
    if (next.hand?.phase !== 'draw' || next.legal === null) this.selected.clear();
    this.absorbLog(true);
    this.render();
    this.chat?.update(next);
    this.schedule();
    this.saveHistory(next);
    // The server counts achievements as each hand finishes; look for new ones then.
    if (next.mySeat && next.hand?.result && next.handNumber !== this.awardsHand) {
      this.awardsHand = next.handNumber;
      void checkAchievements();
    }
    const round = next.bj?.round;
    if (next.mySeat && round?.phase === 'done' && next.bj!.roundNumber !== this.awardsHand) {
      this.awardsHand = next.bj!.roundNumber;
      void checkAchievements();
    }
  }

  /** The hand history over the table. The table plays on underneath, turn clock included. */
  private openHistory() {
    openHandHistory({ playerId: hooks.playerId(), fourColor: hooks.prefs().fourColor, select: this.view.hand?.result ? this.lastSaved ?? undefined : undefined });
  }

  /** Keeps each finished hand the viewer played in their hand history. */
  private saveHistory(v: TableView) {
    const hand = v.hand;
    if (!hand?.result || !v.mySeat || v.handNumber === this.savedHand) return;
    this.savedHand = v.handNumber;
    const me = hand.players.findIndex((p) => p.id === v.mySeat);
    if (me < 0) return;
    const saved = recordHistory(hand, me, { where: `Online · ${v.code}`, number: v.handNumber });
    saveHand(hooks.playerId(), saved);
    if (saved) this.lastSaved = saved.id;
  }

  /**
   * Asks the server to move things along when it's due: a bot's turn, a clock running out,
   * or the next deal. Every browser at the table does this; the first one wins and the
   * others' requests do nothing, so the table keeps going as long as anyone is there.
   */
  private schedule() {
    clearTimeout(this.tickTimer);
    clearInterval(this.clockTimer);
    const v = this.view;
    if (v.turnDeadline || v.nextDealAt) this.clockTimer = window.setInterval(() => this.renderClock(), 1000);
    if (v.tickAt === null || v.phase !== 'playing') return;
    const present = v.members.filter((m) => !m.left);
    const lead = present[0]?.you ?? true;
    const wait = v.tickAt + this.skew - Date.now() + (lead ? 60 : 1200 + Math.random() * 800);
    const version = v.version;
    this.tickTimer = window.setTimeout(async () => {
      if (this.stopped || this.view.version !== version) return;
      try {
        const r = await client!.send({ op: 'tick', tableId: v.tableId, version });
        this.update(r.view);
        // Nothing moved (another browser got there first, or it's not quite time): look again soon.
        if (r.view.version === version) this.tickTimer = window.setTimeout(() => this.schedule(), 700);
      } catch {
        this.tickTimer = window.setTimeout(() => this.schedule(), 2000);
      }
    }, Math.max(0, wait));
  }

  private async send(req: Parameters<TableClient['send']>[0], after?: () => void) {
    if (this.sending) return;
    this.sending = true;
    this.render();
    try {
      const r = await client!.send(req);
      this.sending = false;
      after?.();
      if (r.view) this.update(r.view);
      else this.render();
    } catch (e) {
      this.sending = false;
      this.problem = (e as Error).message;
      this.render();
      window.setTimeout(() => {
        if (this.problem === (e as Error).message) {
          this.problem = '';
          this.render();
        }
      }, 4000);
    }
  }

  /** A watcher takes a seat: in the waiting room now, or at the next deal. */
  private sitIn() {
    const v = this.view;
    const me = pickMe?.() ?? { name: v.members.find((m) => m.you)?.name ?? 'Player' };
    void this.send({ op: 'join', code: v.code, name: me.name, playerId: me.playerId, title: me.title });
  }

  private act(a: Action) {
    const v = this.view;
    if (!v.legal || !v.hand) return;
    void this.send({ op: 'act', tableId: v.tableId, hand: v.handNumber, action: a }, () => this.selected.clear());
  }

  private async leave() {
    const v = this.view;
    this.stop();
    active = null;
    try {
      await client!.send({ op: 'leave', tableId: v.tableId });
    } catch {
      /* the seat goes to a bot when the clock runs out anyway */
    }
    resumable = null;
    hooks.lobby();
  }

  // ---------- log and sounds ----------

  private get myIndex(): number {
    const h = this.view.hand;
    return h && this.view.mySeat ? h.players.findIndex((p) => p.id === this.view.mySeat) : -1;
  }

  private absorbLog(withSound: boolean) {
    const v = this.view;
    if (v.bj) return this.bj.absorb(v, withSound && hooks.prefs().sound);
    const hand = v.hand;
    if (!hand) return;
    if (this.logHand !== v.handNumber) {
      this.logHand = v.handNumber;
      this.logCursor = 0;
    }
    const fresh = hand.log.slice(this.logCursor);
    const me = this.myIndex;
    for (const e of fresh) {
      this.log.push({ text: e.kind === 'start' ? `Hand ${v.handNumber} · ${e.text}` : e.text, kind: e.kind, me: e.player !== undefined && e.player === me });
    }
    this.logCursor = hand.log.length;
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    if (!withSound || !hooks.prefs().sound) return;
    const cues: SoundName[] = [];
    let won = false;
    for (const e of fresh) {
      const t = e.text;
      if (e.kind === 'start') cues.push('shuffle');
      else if (e.kind === 'deal') cues.push('deal', 'deal', 'deal');
      else if (e.kind === 'street') cues.push(VARIANTS[hand.variant].family === 'flop' ? 'flip' : 'deal');
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
      const mine = !!res && me >= 0 && res.pots.some((p) => (p.eligible.length > 1 || !res.showdown) && [...p.winnersHi, ...p.winnersLo].includes(me));
      cues.push(mine ? 'win' : 'pot');
    }
    const key = `${v.handNumber}:${hand.log.length}`;
    if (v.legal && this.turnCue !== key) {
      this.turnCue = key;
      cues.push('turn');
    }
    cues.slice(-6).forEach((c, i) => play(c, i * 0.13));
  }

  // ---------- drawing ----------

  render() {
    if (this.stopped) return;
    const v = this.view;
    if (v.phase === 'lobby') return this.renderRoom();
    if (v.bj) return this.renderBlackjack();
    const hand = v.hand;
    if (!hand) return this.renderRoom();
    const variant = VARIANTS[hand.variant];
    const s = hand.stakes;
    const stakes = variant.family === 'stud'
      ? `Limits <b>${fmt(s.smallBet)}/${fmt(s.bigBet)}</b> · ante ${fmt(s.ante)}`
      : `Blinds <b>${fmt(s.sb)}/${fmt(s.bb)}</b>${s.ante ? ` · ante ${fmt(s.ante)}` : ''}`;
    const live = v.seats.filter((x) => !x.busted).length;
    const level = v.handsUntilNextLevel !== null
      ? ` · Level <b>${v.level + 1}</b> · next in ${v.handsUntilNextLevel} hand${v.handsUntilNextLevel === 1 ? '' : 's'} · <b>${live}</b> left`
      : '';
    const prefs = hooks.prefs();
    const ol0 = document.querySelector('.log ol');
    const logScroll = ol0?.scrollTop;
    const atBottom = !ol0 || ol0.scrollHeight - ol0.scrollTop - ol0.clientHeight < 30;
    const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    hooks.app.innerHTML = `
    <div class="game online ${prefs.fourColor ? 'four-color' : ''} ${this.logOpen ? 'log-open' : ''}">
      <header class="topbar">
        <div class="tb-game">
          <span class="title">${STRUCTURE_NAMES[hand.structure]} ${variant.name}</span>
          <span class="chip-info">${stakes} · Hand <b>${v.handNumber}</b>${level} · Table <b class="code-tag">${esc(v.code)}</b>${this.watchersHtml()}${v.paused ? ' · <b class="paused-tag">Paused</b>' : ''}</span>
        </div>
        <div class="tb-actions">
          ${consoleEnabled() ? `<button type="button" class="icon-btn" id="dev-toggle" title="Developer console (\`)">${icon('m5 7 5 5-5 5M12 18h7')}<span>Console</span></button>` : ''}
          <button type="button" class="icon-btn" id="log-toggle" aria-pressed="${this.logOpen}" title="Hand log">${icon('M4 6h16M4 12h16M4 18h10')}<span>Log</span></button>
          ${v.watching ? '' : `<button type="button" class="icon-btn" id="open-history" title="Hand history (H)">${icon(HISTORY_ICON)}<span>History</span></button>`}
          <button type="button" class="icon-btn" id="invite-friends" title="Invite friends">${icon(INVITE_ICON)}<span>Invite</span></button>
          <button type="button" class="icon-btn" id="sound-toggle" aria-pressed="${prefs.sound}" title="${prefs.sound ? 'Mute sounds (M)' : 'Turn sounds on (M)'}">${icon(prefs.sound ? 'M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z' : 'M4 9v6h4l5 4V5L8 9H4Zm12 .5 5 5m0-5-5 5')}<span>${prefs.sound ? 'Sound' : 'Muted'}</span></button>
          <button type="button" class="icon-btn" id="leave" title="Leave table">${icon('M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11')}<span>Leave</span></button>
        </div>
      </header>
      ${this.problem ? `<p class="net-problem" role="status">${esc(this.problem)}</p>` : ''}
      <div class="table-wrap">${this.tableHtml(hand)}</div>
      <div class="actionbar">${this.actionsHtml(hand)}</div>
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

  /** The top bar, shared by poker and blackjack. */
  private topbarHtml(title: string, info: string, log: boolean): string {
    const v = this.view;
    const prefs = hooks.prefs();
    const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    return `<header class="topbar">
        <div class="tb-game">
          <span class="title">${title}</span>
          <span class="chip-info">${info} · Table <b class="code-tag">${esc(v.code)}</b>${this.watchersHtml()}${v.paused ? ' · <b class="paused-tag">Paused</b>' : ''}</span>
        </div>
        <div class="tb-actions">
          ${consoleEnabled() ? `<button type="button" class="icon-btn" id="dev-toggle" title="Developer console (\`)">${icon('m5 7 5 5-5 5M12 18h7')}<span>Console</span></button>` : ''}
          ${log ? `<button type="button" class="icon-btn" id="log-toggle" aria-pressed="${this.logOpen}" title="Hand log">${icon('M4 6h16M4 12h16M4 18h10')}<span>Log</span></button>` : ''}
          <button type="button" class="icon-btn" id="invite-friends" title="Invite friends">${icon(INVITE_ICON)}<span>Invite</span></button>
          <button type="button" class="icon-btn" id="sound-toggle" aria-pressed="${prefs.sound}" title="${prefs.sound ? 'Mute sounds (M)' : 'Turn sounds on (M)'}">${icon(prefs.sound ? 'M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z' : 'M4 9v6h4l5 4V5L8 9H4Zm12 .5 5 5m0-5-5 5')}<span>${prefs.sound ? 'Sound' : 'Muted'}</span></button>
          <button type="button" class="icon-btn" id="leave" title="Leave table">${icon('M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11')}<span>Leave</span></button>
        </div>
      </header>`;
  }

  /** How many people are watching, for the top bar, with their names on hover. */
  private watchersHtml(): string {
    const v = this.view;
    const names = v.members.filter((m) => m.watching && !m.left).map((m) => m.name);
    if (v.watching) return ` · <b class="watch-tag" title="${esc(names.join(', '))}">Watching</b>`;
    return names.length ? ` · <span class="watch-count" title="${esc(names.join(', '))}">${names.length} watching</span>` : '';
  }

  private renderBlackjack() {
    const v = this.view;
    hooks.app.innerHTML = `
    <div class="game bj online ${hooks.prefs().fourColor ? 'four-color' : ''}">
      ${this.topbarHtml('Blackjack', this.bj.title(v.bj!), false)}
      ${this.problem ? `<p class="net-problem" role="status">${esc(this.problem)}</p>` : ''}
      <div class="table-wrap">${this.bj.feltHtml(v)}</div>
      <div class="actionbar">${this.bj.actionsHtml(v)}</div>
    </div>
    ${this.modalHtml()}`;
    this.bind();
    this.bj.bind(v, () => this.render());
  }

  private secondsLeft(at: number | null): number {
    return at === null ? 0 : Math.max(0, Math.ceil((at + this.skew - Date.now()) / 1000));
  }

  private renderClock() {
    const el = document.getElementById('turn-clock');
    if (el) el.textContent = `${this.secondsLeft(this.view.turnDeadline)}s`;
    const seatClock = document.querySelector('.seat .clock');
    if (seatClock) seatClock.textContent = `${this.secondsLeft(this.view.turnDeadline)}`;
    const deal = document.getElementById('deal-clock');
    if (deal) deal.textContent = `${this.secondsLeft(this.view.nextDealAt)}`;
  }

  private renderRoom() {
    const v = this.view;
    const s = v.settings;
    const watchers = v.members.filter((m) => !m.left && m.watching);
    const seats: string[] = v.members.filter((m) => !m.left && !m.watching).map((m) =>
      `<li class="filled"><span class="avatar lv-human">${esc(m.name.slice(0, 1).toUpperCase())}</span><span class="rs-name">${esc(m.name)}${titleHtml(m.title)}</span>${m.host ? '<span class="rs-tag host">Host</span>' : ''}${m.you ? '<span class="rs-tag">You</span>' : ''}</li>`);
    const bj = s.game === 'blackjack';
    const open = bj ? Math.min(s.bots ?? 0, Math.max(0, s.seats - seats.length)) : Math.max(0, s.seats - seats.length);
    if (bj) for (let i = 0; i < open; i++) seats.push('<li class="open"><span class="avatar lv-medium">?</span><span class="rs-name">Bot</span><span class="rs-tag">Plays by the book</span></li>');
    else for (let i = 0; i < open; i++) seats.push(`<li class="open"><span class="avatar lv-${s.difficulty === 'mixed' ? 'medium' : s.difficulty}">?</span><span class="rs-name">Open seat</span><span class="rs-tag">${s.difficulty === 'mixed' ? 'Bot' : `${DIFFICULTY_NAMES[s.difficulty]} bot`} if nobody joins</span></li>`);
    const link = `${location.origin}${location.pathname}?join=${v.code}`;
    const watchLink = `${location.origin}${location.pathname}?watch=${v.code}`;
    hooks.app.innerHTML = `
    <main class="lobby room">
      <section class="panel room-card">
        <span class="eyebrow">Private table</span>
        <h1>${esc(gameName(s))}</h1>
        <p class="room-meta">${bj ? `Limits ${limitText(s.bjLimits ?? 'low')} · up to ${s.seats} spots · ${BJ_RULES_LINE}` : `${FORMAT_NAMES[s.format]} · ${s.seats} seats · ${s.stackBB} big blind stacks${s.format === 'cash' ? '' : ` · ${s.blindSpeed} blinds`}`}</p>
        <div class="room-code-box">
          <span class="sl">Table code</span>
          <span class="room-code" aria-label="Table code ${esc(v.code.split('').join(' '))}">${esc(v.code)}</span>
          <button type="button" class="btn btn-sm" id="copy-link">${this.copied ? 'Link copied' : 'Copy invite link'}</button>
          <button type="button" class="btn btn-sm" id="copy-watch">${this.copiedWatch ? 'Link copied' : 'Copy watch link'}</button>
        </div>
        <p>Invite friends below in one tap, or send the code (or the link). They open Back Room Poker, sign in, and enter it under <b>Play with friends</b>. A watch link lets them look on first and sit in when they're ready.</p>
        <ol class="room-seats">${seats.join('')}</ol>
        ${tableInvitesHtml(v.code)}
        ${watchers.length ? `<p class="room-watchers"><span class="sl">Watching</span> ${watchers.map((m) => `${esc(m.name)}${m.you ? ' (you)' : ''}`).join(', ')}</p>` : ''}
        ${this.problem ? `<p class="form-error" role="alert">${esc(this.problem)}</p>` : ''}
        <div class="row">
          <button type="button" class="btn" id="room-leave">${v.watching ? 'Stop watching' : 'Leave'}</button>
          ${v.isHost
            ? `<button type="button" class="btn btn-primary btn-lg" id="room-start" ${this.sending ? 'disabled' : ''}>${open ? `Start with ${open} bot${open === 1 ? '' : 's'}` : 'Start the game'}</button>`
            : v.watching && v.canSit
              ? `<button type="button" class="btn btn-primary btn-lg" id="sit-in" ${this.sending ? 'disabled' : ''}>Take a seat</button>`
              : `<span class="room-wait">${v.watching ? 'Every seat is taken. You can watch the game.' : 'Waiting for the host to start…'}</span>`}
        </div>
      </section>
    </main>`;
    document.getElementById('room-leave')!.onclick = () => void this.leave();
    const startBtn = document.getElementById('room-start');
    if (startBtn) startBtn.onclick = () => void this.send({ op: 'start', tableId: v.tableId });
    const sitBtn = document.getElementById('sit-in');
    if (sitBtn) sitBtn.onclick = () => this.sitIn();
    const copy = (id: string, url: string, done: () => void) => {
      document.getElementById(id)!.onclick = async () => {
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          prompt('Copy this link:', url);
        }
        done();
        this.render();
      };
    };
    copy('copy-link', link, () => (this.copied = true));
    copy('copy-watch', watchLink, () => (this.copiedWatch = true));
    bindTableInvites(v.code);
  }

  /** Seat positions, turned so the viewer always sits at the bottom. */
  private seatLayout(): { x: number; y: number }[] {
    const v = this.view;
    const n = v.seats.length;
    const mine = Math.max(0, v.seats.findIndex((s) => s.you));
    const narrow = isPhone();
    const rx = narrow ? 40 : 44;
    const ry = narrow ? 41 : 37;
    return v.seats.map((_, i) => {
      const k = (i - mine + n) % n;
      const a = Math.PI / 2 + (k * 2 * Math.PI) / n;
      // On a phone the viewer's own seat sits below the table, so it needs no room here.
      return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) - (k === 0 && v.mySeat && !narrow ? 6 : 0) };
    });
  }

  private tableHtml(hand: HandView): string {
    const v = this.view;
    const variant = VARIANTS[hand.variant];
    const pos = this.seatLayout();
    const cx = 50;
    const cy = 47;
    const res = hand.result;
    const complete = hand.phase === 'complete';
    const parts: string[] = [];
    const phone = isPhone();
    let heroHtml = '';
    const winners = new Set<number>();
    for (const pot of res?.pots ?? []) {
      if (pot.eligible.length > 1 || !res!.showdown) for (const w of [...pot.winnersHi, ...pot.winnersLo]) winners.add(w);
    }
    v.seats.forEach((seat, si) => {
      const p = pos[si];
      const hi = hand.players.findIndex((x) => x.id === seat.id);
      const hp = hi >= 0 ? hand.players[hi] : null;
      const isMe = seat.you;
      const classes = ['seat'];
      if (isMe) classes.push('me');
      if (!hp) classes.push('busted');
      if (hp?.status === 'folded') classes.push('folded');
      if (hi >= 0 && hand.toAct === hi && !complete) classes.push('acting');
      if (res && hi >= 0 && winners.has(hi)) classes.push('winner');
      if (hp && hp.cards.length > 4) classes.push('many');
      if (hp && !isMe && hp.status !== 'folded' && hp.shown) classes.push('showing');
      if (seat.away) classes.push('away');

      let cards = '';
      if (hp && (hp.status !== 'folded' || isMe)) {
        const pickable = isMe && hand.phase === 'draw' && !!v.legal && v.legal.kind === 'draw';
        cards = hp.cards.map((c, k) => {
          const key = `${v.handNumber}:${seat.id}:${k}:${c ?? 'x'}`;
          const cls: string[] = [];
          if (!this.seenCards.has(key)) {
            cls.push('deal');
            this.seenCards.add(key);
          }
          if (isMe && variant.family === 'stud' && !hp.faceUp[k]) cls.push('hole-own');
          if (variant.family === 'stud' && hp.faceUp[k]) cls.push('upcard');
          if (pickable) cls.push('pickable');
          if (pickable && this.selected.has(k)) cls.push('selected');
          const attr = pickable ? ` data-pick="${k}" role="button" tabindex="0"` : '';
          return cardHtml(c, cls.join(' ')).replace('<div ', `<div style="--k:${k - (hp.cards.length - 1) / 2}"${attr} `);
        }).join('');
      }
      const level = seat.isHuman ? 'human' : seat.difficulty ?? 'medium';
      const tag = seat.isHuman ? (isMe ? 'You' : seat.away ? 'Away · a bot is playing' : 'Friend') : `${BOT_LABEL(seat.difficulty)} · ${STYLE_NAMES[seat.style ?? 'balanced']}`;
      const stack = hp ? hp.stack : seat.stack;
      let bubble = '';
      if (!hp) bubble = `<span class="bubble">${v.handsUntilNextLevel !== null ? (seat.place ? `Out · ${ordinal(seat.place)}` : 'Out') : seat.busted ? 'Broke' : 'Next hand'}</span>`;
      else if (res && winners.has(hi)) bubble = `<span class="bubble won">+${fmt(res.won[hi])}</span>`;
      else if (res?.showdown && res.handNames[hi]) bubble = `<span class="bubble handname">${esc(res.handNames[hi]!)}</span>`;
      else if (hp.status === 'allin') bubble = '<span class="bubble allin">All-in</span>';
      else if (hp.lastAction) bubble = `<span class="bubble a-${hp.lastAction.split(' ')[0].toLowerCase()}">${esc(hp.lastAction)}</span>`;
      const handName = res && winners.has(hi) && res.showdown && res.handNames[hi] ? `<span class="bubble handname">${esc(res.handNames[hi]!)}</span>` : '';
      const clock = hi >= 0 && hand.toAct === hi && !complete && v.turnDeadline ? `<span class="clock" title="Seconds left">${this.secondsLeft(v.turnDeadline)}</span>` : '';
      const badge = seat.isHuman
        ? seat.away ? '<span class="lvl lv-human">Away</span>' : seat.title ? `<span class="lvl lv-human ttl" title="Title">${esc(seat.title)}</span>` : isMe ? '' : '<span class="lvl lv-human">Friend</span>' : `<span class="lvl lv-${level}">${BOT_LABEL(seat.difficulty)}</span>`;
      const hero = isMe && phone;
      const seatHtml = `<div class="${classes.join(' ')}" data-seat="${seat.id}"${hero ? '' : ` style="left:${p.x}%;top:${p.y}%"`}>
        <div class="cards">${cards}</div>
        <div class="pod" title="${esc(seat.isHuman ? `${seat.name} · ${tag}` : botTitle(seat.name, tag))}">
          ${avatarHtml(seat.name, level, !seat.isHuman)}
          <span class="plate"><span class="nm">${esc(seat.name)}</span><span class="stk">${fmt(stack)}</span></span>
          ${badge}${clock}
        </div>
        <div class="bubbles">${handName}${bubble}</div>
      </div>`;
      if (hero) heroHtml = seatHtml;
      else parts.push(seatHtml);
      if (hp && hp.streetBet > 0 && !complete && hand.phase !== 'draw') {
        // The player's chips go beside their cards rather than on top of them (on a phone,
        // where their cards are below the table, at the bottom of the felt).
        const bx = hero ? 62 : isMe ? p.x + 13 : cx + (p.x - cx) * 0.55;
        const by = hero ? 80 : isMe ? p.y - 6 : cy + (p.y - cy) * 0.52;
        parts.push(`<div class="bet" style="left:${bx}%;top:${by}%">${chipsHtml(hp.streetBet)}<span>${fmt(hp.streetBet)}</span></div>`);
      }
      if (hi === hand.button && variant.family !== 'stud') {
        const ang = Math.atan2(p.y - cy, p.x - cx) + 0.32;
        const r = Math.hypot(p.x - cx, p.y - cy) * 0.66;
        parts.push(`<div class="dealer" style="left:${cx + Math.cos(ang) * r}%;top:${cy + Math.sin(ang) * r}%" title="Dealer button">D</div>`);
      }
    });
    const boardSlots = variant.family === 'flop' ? 5 : hand.board.length;
    const board = Array.from({ length: boardSlots }, (_, k) => {
      const c = hand.board[k];
      if (c === undefined) return '<div class="card empty"></div>';
      const key = `${v.handNumber}:board:${k}`;
      const fresh = !this.seenCards.has(key);
      this.seenCards.add(key);
      return cardHtml(c, fresh ? 'deal' : '');
    }).join('');
    if (this.seenCards.size > 4000) this.seenCards.clear();
    const potLabel = complete || hand.pot === 0 ? '<div class="pot empty"></div>' : `<div class="pot">${chipsHtml(hand.pot, 7)}<span>Pot <b>${fmt(hand.pot)}</b></span></div>`;
    const result = res ? `<div class="result" role="status">${esc(res.summary[0] ?? '')}</div>` : '';
    return withHero(`<div class="table">
      <div class="rail"><div class="felt"></div></div>
      <div class="center"><div class="board">${board}</div>${result || potLabel}</div>
      ${parts.join('')}
    </div>`, heroHtml);
  }

  /** What the bots would know in this seat, for the pot-share meter. */
  private playerView(hand: HandView, me: number): PlayerView {
    return {
      variant: VARIANTS[hand.variant], structure: hand.structure, stakes: hand.stakes, street: hand.street, numStreets: hand.numStreets, phase: hand.phase, me,
      myCards: hand.players[me].cards.filter((c): c is number => c !== null),
      players: hand.players.map((p, i) => {
        const seen = p.cards.filter((c): c is number => c !== null);
        return {
          id: p.id, name: p.name, stack: p.stack, status: p.status, streetBet: p.streetBet, totalBet: p.totalBet,
          upCards: i === me ? p.cards.filter((c, k): c is number => c !== null && p.faceUp[k]) : seen,
          hiddenCount: i === me ? 0 : p.cards.length - seen.length, totalCards: p.cards.length, drew: p.drew,
        };
      }),
      board: hand.board, pot: hand.pot, currentBet: hand.currentBet, button: hand.button, legal: this.view.legal ?? { kind: 'none' }, actions: hand.actions, stats: this.view.stats,
    };
  }

  private myHandHtml(hand: HandView): string {
    const me = this.myIndex;
    if (me < 0) return '';
    const p = hand.players[me];
    const variant = VARIANTS[hand.variant];
    const mine = p.cards.filter((c): c is number => c !== null);
    const name = describeHolding(variant, mine, hand.board);
    let odds = '';
    if (hooks.prefs().showOdds && hand.phase !== 'complete' && p.status !== 'folded') {
      const live = hand.players.filter((q) => q.status !== 'folded').length;
      const key = `${this.view.handNumber}|${hand.street}|${hand.phase}|${hand.board.length}|${live}|${mine.join(',')}|${[...this.selected].join(',')}`;
      if (key !== this.oddsKey) {
        this.oddsKey = key;
        const pv = this.playerView(hand, me);
        const opts = variant.family === 'draw' && hand.phase === 'draw' && this.selected.size ? { keep: mine.filter((_, k) => !this.selected.has(k)) } : {};
        this.oddsValue = simulateEquity(specFromView(pv, opts), { iterations: 1500, rng: createRng(), timeBudgetMs: 60 });
      }
      if (this.oddsValue !== null) {
        const pct = Math.round(this.oddsValue * 100);
        odds = `<span class="odds" title="Your share of the pot against random hands"><span class="meter"><i style="width:${pct}%"></i></span><span>Pot share <b>${pct}%</b> vs ${live - 1} random hand${live > 2 ? 's' : ''}</span></span>`;
      }
    }
    return `<div class="myhand"><span class="hn">${esc(name || ' ')}</span>${odds}</div>`;
  }

  private actionsHtml(hand: HandView): string {
    const v = this.view;
    const mine = this.myHandHtml(hand);
    const seat = v.seats.find((s) => s.you);
    const status = (html: string, buttons = '') => `${mine}<span class="status">${html}</span>${buttons ? `<div class="acts">${buttons}</div>` : ''}`;
    if (!seat) {
      if (!v.watching) return status(v.waitingForSeat ? 'You take a seat when the next hand is dealt.' : 'You are watching this table.');
      const res = hand.result;
      const who = hand.phase !== 'complete' && hand.toAct >= 0 ? hand.players[hand.toAct] : null;
      const now = res
        ? `${(res.summary ?? []).slice(1).map((l) => `<div>${esc(l)}</div>`).join('')}${v.nextDealAt ? `<div>Next hand in <b id="deal-clock">${this.secondsLeft(v.nextDealAt)}</b>s</div>` : ''}`
        : who ? `<div>Waiting for <b>${esc(who.name)}</b>…</div>` : '';
      return status(`${now}${watchNote(v)}`, sitButton(v, this.sending));
    }
    if (seat.away) {
      return status('You stepped away, so a bot is playing your chips.', `<button type="button" class="act raise" id="back-in" ${this.sending ? 'disabled' : ''}>I'm back</button>`);
    }
    if (seat.busted && v.handsUntilNextLevel === null) {
      return v.rebuyPending
        ? status(`You're back in for ${fmt(v.settings.stackBB * 20)} when the next hand is dealt.`)
        : status("You're out of chips.", `<button type="button" class="act raise" id="rebuy" ${this.sending ? 'disabled' : ''}>Buy back in for ${fmt(v.settings.stackBB * 20)}</button>`);
    }
    if (hand.phase === 'complete') {
      const res = hand.result;
      const lines = (res?.summary ?? []).slice(1).map((l) => `<div>${esc(l)}</div>`).join('');
      const next = v.stalled
        ? '<div>Waiting for someone to buy back in…</div>'
        : v.nextDealAt ? `<div>Next hand in <b id="deal-clock">${this.secondsLeft(v.nextDealAt)}</b>s</div>` : '';
      return status(`${lines}${next}`);
    }
    const L = v.legal;
    if (!L) {
      const who = hand.toAct >= 0 ? hand.players[hand.toAct] : null;
      const folded = this.myIndex >= 0 && hand.players[this.myIndex].status === 'folded';
      return status(`${folded ? 'You folded. ' : ''}${who ? `Waiting for <b>${esc(who.name)}</b>…` : ''}`);
    }
    const clock = v.turnDeadline ? `<span class="turn-clock">Your turn · <b id="turn-clock">${this.secondsLeft(v.turnDeadline)}s</b></span>` : '';
    if (L.kind === 'draw') {
      const n = this.selected.size;
      return `${mine}<span class="status">${clock}<div>Tap the cards you want to throw away.</div></span>
        <div class="acts"><button type="button" class="act raise" id="do-draw" ${this.sending ? 'disabled' : ''}>${n ? `Discard ${n} and draw` : 'Stand pat'}</button></div>`;
    }
    if (L.kind !== 'bet') return mine;
    return `${mine}${clock ? `<span class="status">${clock}</span>` : ''}<div class="acts${this.sending ? ' sending' : ''}">${this.betButtons(L, hand)}</div>`;
  }

  private betButtons(L: Extract<LegalActions, { kind: 'bet' }>, hand: HandView): string {
    const out: string[] = [];
    const me = hand.players[this.myIndex];
    const variant = VARIANTS[hand.variant];
    if (L.bringIn) {
      out.push(`<button type="button" class="act call" id="do-bringin">Bring in ${fmt(L.bringInAmount)}</button>`);
      if (L.raise) out.push(`<button type="button" class="act raise" id="do-raise" data-to="${L.minRaiseTo}">Complete to ${fmt(L.minRaiseTo)}</button>`);
      return out.join('');
    }
    if (L.fold) out.push('<button type="button" class="act fold" id="do-fold">Fold<kbd>F</kbd></button>');
    if (L.check) out.push('<button type="button" class="act call" id="do-check">Check<kbd>C</kbd></button>');
    if (L.call) out.push(`<button type="button" class="act call" id="do-call">Call ${fmt(L.callAmount)}${L.callAmount >= me.stack ? ' (all-in)' : ''}<kbd>C</kbd></button>`);
    if (!L.raise) return out.join('');
    const verb = L.isBet ? 'Bet' : 'Raise to';
    if (L.minRaiseTo === L.maxRaiseTo) {
      const allin = L.maxRaiseTo >= me.streetBet + me.stack;
      out.push(`<button type="button" class="act raise" id="do-raise" data-to="${L.minRaiseTo}">${allin ? 'All-in' : verb} ${fmt(L.minRaiseTo)}<kbd>R</kbd></button>`);
      return out.join('');
    }
    const potTo = (f: number) => Math.round(hand.currentBet + (hand.pot + L.callAmount) * f);
    const clampTo = (x: number) => Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, x));
    let def = variant.family === 'flop' && hand.street === 0 ? (hand.currentBet <= hand.stakes.bb ? hand.stakes.bb * 3 : hand.currentBet * 3) : potTo(0.6);
    def = clampTo(def);
    const presets: [string, number][] = [['Min', L.minRaiseTo], ['½ pot', potTo(0.5)], ['¾ pot', potTo(0.75)], ['Pot', potTo(1)], [hand.structure === 'PL' ? 'Max' : 'All-in', L.maxRaiseTo]];
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
    const v = this.view;
    if (this.confirmLeave) {
      const tourney = v.handsUntilNextLevel !== null;
      return `<div class="overlay"><div class="modal" role="dialog">
        <h2>Leave the table?</h2>
        <p>${v.bj ? `Your chips stay in your spot. Come back any time with the code <b>${esc(v.code)}</b>.` : v.phase === 'over' ? 'You go back to the game menu.' : `A bot plays your seat while you're gone. Come back any time with the code <b>${esc(v.code)}</b>${tourney ? '.' : ' and your chips will be waiting.'}`}</p>
        <div class="row"><button type="button" class="btn" id="close-modal">Keep playing</button><button type="button" class="btn btn-primary" id="confirm-leave">Leave</button></div>
      </div></div>`;
    }
    if (v.phase === 'over' && !v.bj) {
      const me = v.seats.find((s) => s.you);
      const ranked = [...v.seats].sort((a, b) => (a.place ?? 1) - (b.place ?? 1) || b.stack - a.stack);
      const winner = ranked[0];
      const title = me?.place === 1 ? 'You won the tournament!' : me?.place ? `You finished ${ordinal(me.place)}` : `${esc(winner?.name ?? '')} won`;
      return `<div class="overlay"><div class="modal" role="dialog">
        <h2>${title}</h2>
        <p>${v.handNumber} hands played.</p>
        <table class="standings"><thead><tr><th>Place</th><th>Player</th><th></th></tr></thead><tbody>
          ${ranked.map((s) => `<tr class="${s.you ? 'me' : ''}"><td>${s.place ? ordinal(s.place) : '–'}</td><td>${esc(s.name)}${titleHtml(s.title)}</td><td>${s.isHuman ? (s.you ? 'You' : 'Friend') : `${BOT_LABEL(s.difficulty)} bot`}</td></tr>`).join('')}
        </tbody></table>
        <div class="row"><button type="button" class="btn btn-primary" id="confirm-leave">Back to menu</button></div>
      </div></div>`;
    }
    return '';
  }

  private bind() {
    const on = (id: string, fn: () => void) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };
    const v = this.view;
    const toggleLog = () => {
      this.logOpen = !this.logOpen;
      this.render();
    };
    on('log-toggle', toggleLog);
    on('log-close', toggleLog);
    on('open-history', () => this.openHistory());
    on('sound-toggle', () => {
      hooks.toggleSound();
      this.render();
    });
    on('leave', () => {
      this.confirmLeave = true;
      this.render();
    });
    on('close-modal', () => {
      this.confirmLeave = false;
      this.render();
    });
    on('confirm-leave', () => void this.leave());
    // Watchers have nothing at stake, so they leave without a question.
    if (v.watching) on('leave', () => void this.leave());
    on('sit-in', () => this.sitIn());
    on('back-in', () => void this.send({ op: 'back', tableId: v.tableId }));
    on('dev-toggle', toggleConsole);
    on('invite-friends', () => openInvitePicker(v.code));
    on('rebuy', () => void this.send({ op: 'rebuy', tableId: v.tableId }));
    on('do-fold', () => this.act({ type: 'fold' }));
    on('do-check', () => this.act({ type: 'check' }));
    on('do-call', () => this.act({ type: 'call' }));
    on('do-bringin', () => this.act({ type: 'bringin' }));
    on('do-draw', () => this.act({ type: 'draw', discard: [...this.selected] }));
    const raiseBtn = document.getElementById('do-raise');
    if (raiseBtn) raiseBtn.onclick = () => this.act({ type: 'raise', to: Number(raiseBtn.dataset.to) });
    const range = document.getElementById('raise-range') as HTMLInputElement | null;
    const input = document.getElementById('raise-input') as HTMLInputElement | null;
    const setTo = (x: number) => {
      if (!range || !input || !raiseBtn || !v.hand) return;
      const to = Math.max(Number(range.min), Math.min(Number(range.max), Math.round(x) || Number(range.min)));
      range.value = String(to);
      if (document.activeElement !== input) input.value = String(to);
      raiseBtn.dataset.to = String(to);
      const me = v.hand.players[this.myIndex];
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
  }

  private onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    if (this.confirmLeave) {
      if (e.key === 'Escape') {
        this.confirmLeave = false;
        this.render();
      }
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
    if (this.view.bj && k !== 'm') {
      if (this.bj.key(k)) e.preventDefault();
      return;
    }
    if (k === 'f') click('do-fold');
    else if (k === 'h' && !this.view.watching) {
      e.preventDefault();
      this.openHistory();
    } else if (k === 'c' || k === 'k') click(document.getElementById('do-check') ? 'do-check' : 'do-call');
    else if (k === 'r') click('do-raise');
    else if (k === 'm') {
      e.preventDefault();
      hooks.toggleSound();
      this.render();
    }
  }
}

/** The line under the table for a watcher. */
export function watchNote(v: TableView): string {
  const why = v.canSit ? '' : v.handsUntilNextLevel !== null ? ' This tournament has started, so its seats are taken.' : ' Every seat is taken.';
  return `<div class="watch-note">You're watching. Cards stay hidden unless they're shown down.${why}</div>`;
}

export function sitButton(v: TableView, sending: boolean): string {
  return v.canSit ? `<button type="button" class="act raise" id="sit-in" ${sending ? 'disabled' : ''}>Sit in</button>` : '';
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

