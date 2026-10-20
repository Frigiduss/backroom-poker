// The developer console: a drop-down command line for admin accounts (open with the ` key).
// It can edit the current player, look inside and steer the table (rig the deck, retune bots,
// pause, autopilot), and manage every account's players through the admin rules in
// supabase/admin.sql. It only appears after the database confirms the account is an admin,
// and every change to another account is checked by the database again. At an online table
// the table commands go to the table server, which checks the account is an admin itself.
import { Bot, STYLE_NAMES } from '../bots/bot';
import { simulateEquity } from '../bots/equity';
import { buildView } from '../bots/view';
import { Card, cardLabel, createRng, parseCard } from '../engine/cards';
import { Hand, rigProblem } from '../engine/hand';
import { BotStyle, DIFFICULTIES, DIFFICULTY_NAMES, Difficulty, Seat, Table } from '../engine/table';
import { VARIANTS, VariantDef } from '../engine/variants';
import { TableClient } from '../online/client';
import { AdminCommand, AdminTableInfo } from '../online/protocol';
import { AdminApi, AdminPlayer, OnlineAuth, Profile, ProfileStats, cleanName, emptyProfileStats } from '../accounts';
import { esc, fmt } from './dom';
import { player, savePlayer } from './profiles';

/** What the console needs from a running game (main.ts's Game provides it). */
export interface DevGame {
  readonly table: Table;
  readonly bots: Map<string, Bot>;
  readonly humanId: string;
  paused: boolean;
  /** A bot that plays the player's seat, or null. */
  autopilot: Bot | null;
  /** Milliseconds between bot moves, overriding the speed setting; null uses the setting. */
  botDelay: number | null;
  /** Redraws the table and lets the bots carry on. */
  refresh(): void;
  /** Makes the next bot (or autopilot) move now, even while paused. */
  step(): void;
  /** Deals the next hand if the current one is finished. */
  deal(): void;
}

export interface DevHooks {
  game(): DevGame | null;
  /** Redraws whatever screen is showing, after a change to the player or the announcement. */
  redraw(): void;
  /** Practice mode (bots' cards face up). Sets it when `on` is given; returns the new value. */
  reveal(on?: boolean): boolean;
  /** Called after the console changes the lobby announcement. */
  announced(text: string): void;
  /** The online table on screen, if any; table commands then go to the table server. */
  onlineTable(): { tableId: string; code: string } | null;
}

type Out = (html: string, kind?: 'ok' | 'err' | 'dim' | 'cmd' | 'group') => void;

interface Command {
  name: string;
  usage: string;
  help: string;
  group: 'Console' | 'Your player' | 'Table' | 'Online tables' | 'Accounts';
  run(args: string[], out: Out): void | Promise<void>;
}

const HISTORY_KEY = 'backroom-poker-console-history';

let hooks: DevHooks;
let admin: AdminApi | null = null;
let auth: OnlineAuth | null = null;
let checkedFor = '';
let enabled = false;
let root: HTMLElement | null = null;
let history: string[] = [];
let historyAt = -1;
/** The last player list fetched, so commands can refer to players by short id or name. */
let known: AdminPlayer[] = [];
let tables: TableClient | null = null;
/** An online table picked with the table command, which table commands then act on. */
let pinned: string | null = null;

export function initConsole(h: DevHooks, a: OnlineAuth | null) {
  hooks = h;
  auth = a;
  admin = a ? new AdminApi(a) : null;
  tables = a ? new TableClient(a) : null;
  try {
    history = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  } catch {
    history = [];
  }
  document.addEventListener('keydown', (e) => {
    if (!enabled || e.key !== '`' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const inOther = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.id !== 'dev-input';
    if (inOther) return;
    e.preventDefault();
    toggleConsole();
  }, true);
}

/**
 * Asks the database whether the signed-in account is an admin. Called whenever the lobby
 * draws, so signing in or out turns the console on or off. Cached per account.
 */
export async function refreshConsoleAccess(): Promise<boolean> {
  const id = auth?.current?.userId ?? '';
  if (id === checkedFor) return enabled;
  checkedFor = id;
  const was = enabled;
  enabled = !!id && !!admin && (await admin.isAdmin());
  if (!enabled) closeConsole();
  if (enabled !== was) hooks.redraw();
  return enabled;
}

export const consoleEnabled = (): boolean => enabled;

/** A small button for screens without a ` key (phones), shown only to admins. */
export const consoleButtonHtml = (): string =>
  enabled ? '<button type="button" class="dev-open" id="dev-open" title="Developer console (`)">&gt;_<span> Console</span></button>' : '';

export function bindConsoleButton() {
  const b = document.getElementById('dev-open');
  if (b) b.onclick = () => toggleConsole();
}

export function toggleConsole() {
  if (root) closeConsole();
  else openConsole();
}

function closeConsole() {
  root?.remove();
  root = null;
}

function openConsole() {
  if (!enabled || root) return;
  root = document.createElement('section');
  root.className = 'dev-console';
  root.setAttribute('aria-label', 'Developer console');
  root.innerHTML = `
    <header class="dev-head">
      <span class="dev-title">&gt;_ Developer console</span>
      <span class="dev-who">${esc(auth?.current?.email ?? '')} · admin</span>
      <span class="dev-quick">
        ${['state', 'reveal', 'pause', 'deck', 'players', 'accounts', 'help'].map((c) => `<button type="button" data-run="${c}">${c}</button>`).join('')}
      </span>
      <button type="button" class="dev-close" id="dev-close" aria-label="Close console">✕</button>
    </header>
    <div class="dev-out" id="dev-out" role="log" aria-live="polite"></div>
    <form class="dev-prompt" id="dev-form" autocomplete="off">
      <span aria-hidden="true">›</span>
      <input id="dev-input" spellcheck="false" autocapitalize="off" placeholder="Type a command, or help" aria-label="Console command">
    </form>`;
  document.body.appendChild(root);
  const input = root.querySelector<HTMLInputElement>('#dev-input')!;
  const form = root.querySelector<HTMLFormElement>('#dev-form')!;
  root.querySelector<HTMLButtonElement>('#dev-close')!.onclick = closeConsole;
  root.querySelectorAll<HTMLButtonElement>('[data-run]').forEach((b) => (b.onclick = () => {
    void execute(b.dataset.run!);
    input.focus();
  }));
  form.onsubmit = (e) => {
    e.preventDefault();
    const line = input.value.trim();
    input.value = '';
    if (line) void execute(line);
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!history.length) return;
      historyAt = e.key === 'ArrowUp' ? Math.min(history.length - 1, historyAt + 1) : Math.max(-1, historyAt - 1);
      input.value = historyAt < 0 ? '' : history[history.length - 1 - historyAt];
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const [word, ...rest] = input.value.split(' ');
      if (rest.length) return;
      const hits = COMMANDS.filter((c) => c.name.startsWith(word.toLowerCase()));
      if (hits.length === 1) input.value = `${hits[0].name} `;
      else if (hits.length > 1) print(hits.map((c) => c.name).join('  '), 'dim');
    } else if (e.key === 'Escape') {
      closeConsole();
    }
    e.stopPropagation();
  };
  print(`Signed in as <b>${esc(auth?.current?.email ?? '')}</b>. Type <b>help</b> for commands, Tab to complete, ↑ for history, \` to close.`, 'dim');
  input.focus();
}

const print: Out = (html, kind) => {
  const out = root?.querySelector('#dev-out');
  if (!out) return;
  const line = document.createElement('div');
  line.className = `dev-line${kind ? ` dev-${kind}` : ''}`;
  line.innerHTML = html;
  out.appendChild(line);
  while (out.childElementCount > 400) out.firstElementChild?.remove();
  out.scrollTop = out.scrollHeight;
};

/** Runs one command line. Exported for tests and the quick buttons. */
export async function execute(line: string, out: Out = print): Promise<void> {
  out(esc(line), 'cmd');
  if (history[history.length - 1] !== line) history.push(line);
  history = history.slice(-60);
  historyAt = -1;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* history lasts for this visit */
  }
  const [name, ...args] = tokenize(line);
  const cmd = COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!cmd) return out(`Unknown command <b>${esc(name)}</b>. Type <b>help</b> for the list.`, 'err');
  try {
    // At an online table, table commands run on the table server instead of this page.
    if (cmd.group === 'Table' && onlineTarget()) {
      const remote = ONLINE_TABLE[cmd.name];
      if (!remote) throw new UsageError(`${cmd.name} only works at your practice tables. At an online table, state shows every card.`);
      return await remote(args, out);
    }
    await cmd.run(args, out);
  } catch (err) {
    out(esc((err as Error).message || String(err)), 'err');
  }
}

/** Splits a line on spaces, keeping "quoted text" together. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out.length ? out : [''];
}

// ---------- helpers ----------

class UsageError extends Error {}

function need<T>(x: T | null | undefined, msg: string): T {
  if (x === null || x === undefined) throw new UsageError(msg);
  return x;
}

function currentGame(): DevGame {
  return need(hooks.game(), 'Start a game first: this command works at the table.');
}

function onlineAdmin(): AdminApi {
  return need(admin, 'Online accounts are off, so there are no other accounts to manage.');
}

/** "500", "+500", "-500", "10k" against a current value. */
function amount(arg: string | undefined, current: number): number {
  const m = need(arg, 'Give an amount, like 50000, +5000 or -1000.').toLowerCase().replace(/,/g, '').match(/^([+-]?)(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) throw new UsageError(`"${arg}" isn't an amount. Try 50000, +5000, -1000 or 2.5k.`);
  const n = Math.round(Number(m[2]) * (m[3] === 'k' ? 1e3 : m[3] === 'm' ? 1e6 : 1));
  const v = m[1] === '+' ? current + n : m[1] === '-' ? current - n : n;
  return Math.max(0, v);
}

/** "As", "10h", "kd" → card. */
function card(s: string): Card {
  return parseCard(s.replace(/^10/, 'T'));
}

const cardsText = (cs: readonly Card[]): string => cs.map((c) => `<span class="dev-card s${c & 3}">${cardLabel(c)}</span>`).join(' ') || '<span class="dev-dim">none</span>';

function seatOf(t: Table, ref: string | undefined): Seat {
  const r = need(ref, 'Name a seat: its number from state (0 is you) or the start of a name.').toLowerCase();
  if (/^\d+$/.test(r)) return need(t.seats[Number(r)], `There is no seat ${r}.`);
  if (r === 'me' || r === 'you') return t.seats[0];
  const hits = t.seats.filter((s) => s.name.toLowerCase().startsWith(r));
  if (hits.length !== 1) throw new UsageError(hits.length ? `"${ref}" matches ${hits.map((s) => s.name).join(', ')}.` : `No seat called "${ref}".`);
  return hits[0];
}

function table(rows: (string | number)[][], head: string[]): string {
  return `<table class="dev-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${typeof c === 'number' ? fmt(c) : c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

const STAT_FIELDS = Object.keys(emptyProfileStats()).filter((k) => k !== 'byVariant' && k !== 'bestFinish') as (keyof ProfileStats)[];

function setStat(p: Profile, field: string | undefined, value: string | undefined) {
  const f = STAT_FIELDS.find((k) => k.toLowerCase() === need(field, `Name a stat: ${STAT_FIELDS.join(', ')}.`).toLowerCase());
  if (!f) throw new UsageError(`Stats you can set: ${STAT_FIELDS.join(', ')}.`);
  const v = Number(need(value, 'Give a number.'));
  if (!Number.isFinite(v)) throw new UsageError(`"${value}" isn't a number.`);
  (p.stats[f] as number) = Math.round(v);
  p.updatedAt = Date.now();
  return f;
}

function resetStats(p: Profile) {
  p.stats = emptyProfileStats(p.bank);
  p.updatedAt = Date.now();
}

function setBank(p: Profile, n: number) {
  p.bank = n;
  p.stats.peakBank = Math.max(p.stats.peakBank, n);
  p.updatedAt = Date.now();
}

const shortId = (id: string) => id.replace(/^pr_/, '').slice(0, 8);

async function findPlayer(ref: string | undefined): Promise<AdminPlayer> {
  const r = need(ref, 'Name a player: their short id from players, or their name in quotes.').toLowerCase();
  const api = onlineAdmin();
  const match = (list: AdminPlayer[]) => {
    const exact = list.filter((x) => x.profile.id === ref || x.profile.name.toLowerCase() === r);
    return exact.length ? exact : list.filter((x) => shortId(x.profile.id).startsWith(r));
  };
  let hits = match(known);
  if (hits.length !== 1) {
    known = await api.players();
    hits = match(known);
  }
  if (hits.length > 1) throw new UsageError(`"${ref}" matches ${hits.length} players: ${hits.map((h) => `${h.profile.name} (${shortId(h.profile.id)})`).join(', ')}. Use the short id.`);
  return need(hits[0], `No player matches "${ref}". Run players to see everyone.`);
}

/** Applies a change to any player. The one being played here changes in place so it isn't overwritten later. */
async function changePlayer(target: AdminPlayer, change: (p: Profile) => void, action: string, detail: Record<string, unknown>) {
  let mine: Profile | null = null;
  try {
    mine = player();
  } catch {
    /* no player open */
  }
  if (mine && mine.id === target.profile.id) {
    change(mine);
    await savePlayer();
    hooks.redraw();
  } else {
    change(target.profile);
    await onlineAdmin().savePlayer(target.profile);
  }
  await admin?.log(action, { player: target.profile.id, name: target.profile.name, ...detail });
}

const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/** Each live player's real chance of winning, knowing every hand (no folds from here). */
function equityOf(variant: VariantDef, players: { cards: Card[]; folded: boolean }[], board: Card[]): Map<number, number> {
  const res = new Map<number, number>();
  const live = players.map((p, i) => (p.folded ? -1 : i)).filter((i) => i >= 0);
  if (live.length < 2) return res;
  const stud = variant.family === 'stud';
  const future = (cards: Card[]) => (stud ? Math.max(0, 7 - cards.length - board.length) : 0);
  const dead = players.flatMap((p) => (p.folded ? p.cards : []));
  for (const i of live) {
    const opponents = live.filter((j) => j !== i).map((j) => ({ known: [...players[j].cards], unknown: 0, future: future(players[j].cards) }));
    const spec = { variant, mine: players[i].cards, myFuture: future(players[i].cards), opponents, board, boardFuture: variant.family === 'flop' ? 5 - board.length : 0, dead };
    res.set(i, simulateEquity(spec, { iterations: 2500, rng: createRng(), timeBudgetMs: 40 }));
  }
  return res;
}

function trueEquity(hand: Hand): Map<number, number> {
  if (hand.isComplete) return new Map();
  return equityOf(hand.variant, hand.players.map((p) => ({ cards: p.cards, folded: p.status === 'folded' })), hand.board);
}

// ---------- online tables ----------

function onlineTarget(): { tableId?: string; code?: string } | null {
  if (pinned) return { code: pinned };
  const t = hooks.onlineTable();
  return t ? { tableId: t.tableId } : null;
}

async function remote(command: AdminCommand, out?: Out): Promise<AdminTableInfo> {
  const client = need(tables, 'Online tables are off.');
  const r = await client.admin({ op: 'admin', ...need(onlineTarget(), 'No online table picked.'), command });
  if (out && r.message) out(esc(r.message), 'ok');
  return need(r.table, 'That table is gone.');
}

function remoteSeat(info: AdminTableInfo, ref: string | undefined): AdminTableInfo['seats'][number] {
  const r = need(ref, 'Name a seat: its number from state or the start of a name.').toLowerCase();
  if (r === 'me' || r === 'you') {
    const mine = info.members.find((m) => m.userId === auth?.current?.userId)?.seat;
    return need(info.seats.find((s) => s.id === mine), "You aren't seated at that table.");
  }
  if (/^\d+$/.test(r)) return need(info.seats[Number(r)], `There is no seat ${r}.`);
  const hits = info.seats.filter((s) => s.id === r || s.name.toLowerCase().startsWith(r));
  if (hits.length !== 1) throw new UsageError(hits.length ? `"${ref}" matches ${hits.map((s) => s.name).join(', ')}.` : `No seat called "${ref}".`);
  return hits[0];
}

function printTable(info: AdminTableInfo, out: Out) {
  const v = VARIANTS[info.settings.variant];
  const h = info.hand;
  out(`Online table <b>${esc(info.code)}</b> · <b>${esc(v.name)}</b> ${info.settings.structure} · ${info.phase} · hand ${info.handNumber}${info.settings.format !== 'cash' ? ` · level ${info.level + 1}` : ''}${h ? ` · ${h.complete ? 'finished' : `${h.phase}, street ${h.street + 1} of ${h.numStreets}`} · pot <b>${fmt(h.pot)}</b>` : ''}${info.paused ? ' · <b>paused</b>' : ''}`);
  if (h) out(`Board ${cardsText(h.board)}${h.rigBoard.length ? ` · coming: ${cardsText(h.rigBoard)}` : ''}`);
  const eq = h && !h.complete ? equityOf(v, h.players.map((p) => ({ cards: p.cards, folded: p.status === 'folded' })), h.board) : new Map<number, number>();
  out(table(info.seats.map((seat, si) => {
    const hi = h ? h.players.findIndex((p) => p.seat === seat.id) : -1;
    const hp = hi >= 0 ? h!.players[hi] : null;
    const member = info.members.find((m) => m.seat === seat.id);
    const who = seat.isHuman ? `person${member?.away ? ' (away, bot playing)' : ''}${member?.host ? ', host' : ''}` : `${DIFFICULTY_NAMES[seat.difficulty ?? 'medium']} ${STYLE_NAMES[seat.style ?? 'balanced']}`;
    return [
      `${si}`, `${esc(seat.name)}${h?.toAct === seat.id ? ' ◀' : ''}`, who, hp ? hp.stack : seat.stack, hp ? hp.totalBet : 0,
      hp ? hp.status : seat.busted ? 'out' : 'sitting out', hp ? cardsText(hp.cards) : '', eq.has(hi) ? `${Math.round(eq.get(hi)! * 100)}%` : '',
    ];
  }), ['#', 'Seat', 'Plays', 'Stack', 'In pot', 'Status', 'Cards', 'Wins']));
  const watching = info.members.filter((m) => !m.seat && !m.left);
  if (watching.length) out(`Waiting or watching: ${watching.map((m) => esc(m.name)).join(', ')}`, 'dim');
  if (info.nextRig) out(`Next hand is rigged: ${Object.entries(info.nextRig.hole).map(([id, c]) => `${esc(info.seats.find((s) => s.id === id)?.name ?? id)} ${cardsText(c)}`).join(' · ')}${info.nextRig.board.length ? ` · board ${cardsText(info.nextRig.board)}` : ''}`, 'dim');
}

/** The table commands, as run on the table server for an online table. */
const ONLINE_TABLE: Record<string, (args: string[], out: Out) => Promise<void>> = {
  async state(_, out) {
    printTable(await remote({ do: 'inspect' }), out);
  },
  async deck(args, out) {
    const h = need((await remote({ do: 'inspect' })).hand, 'No hand dealt yet.');
    if (h.rigBoard.length) out(`Board cards fixed to come: ${cardsText(h.rigBoard)}`);
    out(`Next ${Math.min(16, Number(args[0]) || 12)}: ${cardsText(h.upcoming.slice(0, Math.min(16, Number(args[0]) || 12)))}`);
  },
  async board(args, out) {
    const cards = args[0] === 'clear' ? [] : args.map(card);
    if (!cards.length && args[0] !== 'clear') throw new UsageError('List cards, like board Ah Kh 2c, or board clear.');
    await remote({ do: 'board', cards }, out);
  },
  async rig(args, out) {
    if (args[0] === 'clear') return void (await remote({ do: 'unrig' }, out));
    const seat = remoteSeat(await remote({ do: 'inspect' }), args[0]);
    const cards = args.slice(1).map(card);
    if (!cards.length) throw new UsageError('List the cards, like rig me As Ad.');
    await remote({ do: 'rig', seat: seat.id, cards }, out);
  },
  async stack(args, out) {
    const info = await remote({ do: 'inspect' });
    const seat = remoteSeat(info, args[0]);
    const hp = info.hand && !info.hand.complete ? info.hand.players.find((p) => p.seat === seat.id) : null;
    await remote({ do: 'stack', seat: seat.id, amount: amount(args[1], hp ? hp.stack : seat.stack) }, out);
  },
  async bot(args, out) {
    const seat = remoteSeat(await remote({ do: 'inspect' }), args[0]);
    if (seat.isHuman) throw new UsageError(`${seat.name} is a person.`);
    let difficulty: Difficulty | undefined;
    let style: BotStyle | undefined;
    for (const a of args.slice(1).map((x) => x.toLowerCase())) {
      if ((DIFFICULTIES as string[]).includes(a)) difficulty = a as Difficulty;
      else if (a in STYLE_NAMES) style = a as BotStyle;
      else throw new UsageError(`"${a}" isn't a difficulty or a style.`);
    }
    if (!difficulty && !style) return out(`${esc(seat.name)} plays <b>${DIFFICULTY_NAMES[seat.difficulty ?? 'medium']} · ${STYLE_NAMES[seat.style ?? 'balanced']}</b>`);
    await remote({ do: 'bot', seat: seat.id, difficulty, style }, out);
  },
  async pause(_, out) {
    const info = await remote({ do: 'inspect' });
    await remote({ do: info.paused ? 'resume' : 'pause' }, out);
  },
  async resume(_, out) {
    await remote({ do: 'resume' }, out);
  },
  async step(_, out) {
    await remote({ do: 'step' }, out);
  },
  async deal(_, out) {
    await remote({ do: 'step' }, out);
  },
  async level(args, out) {
    const n = Math.floor(Number(args[0]) || 0);
    if (n < 1) throw new UsageError('Give a level number, like level 5.');
    await remote({ do: 'level', level: n }, out);
  },
};

// ---------- commands ----------

const COMMANDS: Command[] = [
  {
    name: 'help', usage: 'help [command]', group: 'Console', help: 'Lists commands, or explains one.',
    run(args, out) {
      if (args[0]) {
        const c = need(COMMANDS.find((x) => x.name === args[0].toLowerCase()), `No command called ${args[0]}.`);
        return out(`<b>${esc(c.usage)}</b> · ${esc(c.help)}`);
      }
      if (onlineTarget()) out('Table commands are going to an online table, where reveal, ask, autopilot and speed don\'t apply.', 'dim');
      for (const g of ['Console', 'Your player', 'Table', 'Online tables', 'Accounts'] as const) {
        out(g, 'group');
        out(table(COMMANDS.filter((c) => c.group === g).map((c) => [`<b>${esc(c.usage)}</b>`, esc(c.help)]), ['Command', 'What it does']));
      }
    },
  },
  {
    name: 'clear', usage: 'clear', group: 'Console', help: 'Empties the console.',
    run() {
      const o = root?.querySelector('#dev-out');
      if (o) o.innerHTML = '';
    },
  },
  {
    name: 'whoami', usage: 'whoami', group: 'Console', help: 'Your account, and the player you are playing as.',
    run(_, out) {
      const p = player();
      out(`Account <b>${esc(auth?.current?.email ?? '–')}</b> (${esc(auth?.current?.userId ?? '')}), admin.`);
      out(`Playing as <b>${esc(p.name)}</b> (${shortId(p.id)}), bank ${fmt(p.bank)}${p.table ? `, ${fmt(p.table.paidIn)} at a ${p.table.kind} table` : ''}.`);
    },
  },

  // Your player
  {
    name: 'bank', usage: 'bank [amount | +n | -n]', group: 'Your player', help: 'Shows or sets your chip bank. 2.5k and 1m work too.',
    async run(args, out) {
      const p = player();
      if (!args[0]) return out(`Bank: <b>${fmt(p.bank)}</b>`);
      const before = p.bank;
      setBank(p, amount(args[0], p.bank));
      await savePlayer();
      hooks.redraw();
      await admin?.log('bank', { player: p.id, name: p.name, from: before, to: p.bank });
      out(`Bank ${fmt(before)} → <b>${fmt(p.bank)}</b>`, 'ok');
    },
  },
  {
    name: 'stat', usage: 'stat [name value]', group: 'Your player', help: 'Shows your lifetime stats, or sets one (like stat tournamentWins 12).',
    async run(args, out) {
      const p = player();
      if (!args[0]) return out(table(STAT_FIELDS.map((k) => [k, p.stats[k] as number]), ['Stat', 'Value']));
      const f = setStat(p, args[0], args[1]);
      await savePlayer();
      hooks.redraw();
      out(`${f} = <b>${fmt(p.stats[f] as number)}</b>`, 'ok');
    },
  },
  {
    name: 'resetstats', usage: 'resetstats', group: 'Your player', help: 'Wipes your lifetime stats (the bank stays).',
    async run(_, out) {
      const p = player();
      resetStats(p);
      await savePlayer();
      hooks.redraw();
      out('Stats reset.', 'ok');
    },
  },

  // Table
  {
    name: 'state', usage: 'state', group: 'Table', help: 'Everything about the current hand: every card, stacks, the pot and each player\'s real odds.',
    run(_, out) {
      const g = currentGame();
      const t = g.table;
      const h = t.hand;
      if (!h) return out('No hand dealt yet.');
      const eq = trueEquity(h);
      const s = h.stakes;
      out(`<b>${esc(t.variant.name)}</b> ${h.structure} · hand ${t.handNumber} · ${t.isTournament ? `level ${t.level + 1} · ` : ''}blinds ${fmt(s.sb)}/${fmt(s.bb)}${s.ante ? ` ante ${fmt(s.ante)}` : ''} · ${h.isComplete ? 'finished' : `${h.phase}, street ${h.street + 1} of ${h.numStreets}`} · pot <b>${fmt(h.pot)}</b>${g.paused ? ' · <b>paused</b>' : ''}${g.autopilot ? ' · autopilot on' : ''}`);
      out(`Board ${cardsText(h.board)}${h.rigged.board.length ? ` · coming: ${cardsText(h.rigged.board)}` : ''}`);
      out(table(t.seats.map((seat, si) => {
        const hi = t.handIndexOf(seat.id);
        const hp = hi >= 0 ? h.players[hi] : null;
        const who = seat.isHuman ? 'you' : `${DIFFICULTY_NAMES[seat.difficulty!]} ${STYLE_NAMES[g.bots.get(seat.id)?.style ?? 'balanced']}`;
        const mark = hi === h.toAct && !h.isComplete ? ' ◀' : '';
        return [
          `${si}`, `${esc(seat.name)}${mark}`, who, hp ? hp.stack : seat.stack, hp ? hp.totalBet : 0,
          hp ? hp.status : seat.busted ? 'out' : 'sitting out', hp ? cardsText(hp.cards) : '', eq.has(hi) ? `${Math.round(eq.get(hi)! * 100)}%` : '',
        ];
      }), ['#', 'Seat', 'Plays', 'Stack', 'In pot', 'Status', 'Cards', 'Wins']));
      if (t.nextRig) out(`Next hand is rigged: ${Object.entries(t.nextRig.hole).map(([id, c]) => `${esc(t.seats.find((s) => s.id === id)?.name ?? id)} ${cardsText(c)}`).join(' · ')}${t.nextRig.board.length ? ` · board ${cardsText(t.nextRig.board)}` : ''}`, 'dim');
    },
  },
  {
    name: 'reveal', usage: 'reveal [on | off]', group: 'Table', help: 'Shows the bots\' cards on the table (the practice mode setting).',
    run(args, out) {
      const on = args[0] ? args[0] === 'on' : !hooks.reveal();
      out(`Bots' cards ${hooks.reveal(on) ? 'face up' : 'face down'}.`, 'ok');
    },
  },
  {
    name: 'deck', usage: 'deck [count]', group: 'Table', help: 'The next cards off the deck, top first (burn cards included).',
    run(args, out) {
      const h = need(currentGame().table.hand, 'No hand dealt yet.');
      const n = Math.max(1, Math.min(52, Number(args[0]) || 12));
      const rig = h.rigged;
      if (rig.board.length) out(`Board cards fixed to come: ${cardsText(rig.board)}`);
      out(`Next ${n}: ${cardsText(h.upcoming(n))}`);
    },
  },
  {
    name: 'board', usage: 'board <cards> | board clear', group: 'Table', help: 'Fixes the board cards still to come this hand, like board Ah Kh 2c. Between hands it sets the next hand\'s board.',
    run(args, out) {
      const g = currentGame();
      const h = g.table.hand;
      const cards = args[0] === 'clear' ? [] : args.map(card);
      if (!cards.length && args[0] !== 'clear') throw new UsageError('List cards, like board Ah Kh 2c, or board clear.');
      if (h && !h.isComplete) {
        if (h.variant.family !== 'flop') throw new UsageError('Only community-card games have a board.');
        h.setBoard(cards);
        out(cards.length ? `Next board cards: ${cardsText(cards)}` : 'Board back to the shuffle.', 'ok');
      } else {
        const rig = g.table.nextRig ?? { hole: {}, board: [] };
        const problem = rigProblem({ hole: Object.fromEntries(Object.entries(rig.hole).map(([, c], i) => [i, c])), board: cards }, g.table.variant.shortDeck);
        if (problem) throw new UsageError(problem);
        g.table.nextRig = { ...rig, board: cards };
        out(cards.length ? `Next hand's board: ${cardsText(cards)}` : 'Next hand\'s board back to the shuffle.', 'ok');
      }
    },
  },
  {
    name: 'rig', usage: 'rig <seat> <cards> | rig clear', group: 'Table', help: 'Deals a seat these cards next hand, in dealing order (rig me As Ad). Extra cards in draw games become the draw.',
    run(args, out) {
      const g = currentGame();
      const t = g.table;
      if (args[0] === 'clear') {
        t.nextRig = null;
        return out('Next hand deals from the shuffle.', 'ok');
      }
      const seat = seatOf(t, args[0]);
      const cards = args.slice(1).map(card);
      if (!cards.length) throw new UsageError('List the cards, like rig me As Ad.');
      const rig = t.nextRig ?? { hole: {}, board: [] };
      const hole = { ...rig.hole, [seat.id]: cards };
      const problem = rigProblem({ hole: Object.fromEntries(Object.values(hole).map((c, i) => [i, c])), board: rig.board }, t.variant.shortDeck);
      if (problem) throw new UsageError(problem);
      t.nextRig = { hole, board: rig.board };
      out(`${esc(seat.name)} gets ${cardsText(cards)} next hand.`, 'ok');
    },
  },
  {
    name: 'stack', usage: 'stack <seat> <amount | +n | -n>', group: 'Table', help: 'Sets a seat\'s chips at the table. Your extra chips go to your bank when you leave a cash game.',
    run(args, out) {
      const g = currentGame();
      const t = g.table;
      const seat = seatOf(t, args[0]);
      const h = t.hand;
      const hi = t.handIndexOf(seat.id);
      const live = h && !h.isComplete && hi >= 0;
      const now = live ? h.players[hi].stack : seat.stack;
      const n = amount(args[1], now);
      if (live) {
        const p = h.players[hi];
        p.stack = n;
        if (n > 0 && p.status === 'allin') p.status = 'active';
      }
      seat.stack = n;
      if (n > 0) seat.busted = false;
      g.refresh();
      out(`${esc(seat.name)}: ${fmt(now)} → <b>${fmt(n)}</b>`, 'ok');
    },
  },
  {
    name: 'bot', usage: 'bot <seat> [difficulty] [style]', group: 'Table', help: `Shows or swaps a bot's brain. Difficulties: ${DIFFICULTIES.join(', ')}. Styles: ${Object.keys(STYLE_NAMES).join(', ')}.`,
    run(args, out) {
      const g = currentGame();
      const seat = seatOf(g.table, args[0]);
      if (seat.isHuman) throw new UsageError('That\'s you. Try autopilot instead.');
      let d = seat.difficulty!;
      let st = g.bots.get(seat.id)?.style ?? 'balanced';
      for (const a of args.slice(1).map((x) => x.toLowerCase())) {
        if ((DIFFICULTIES as string[]).includes(a)) d = a as Difficulty;
        else if (a in STYLE_NAMES) st = a as BotStyle;
        else throw new UsageError(`"${a}" isn't a difficulty or a style.`);
      }
      if (args.length > 1) {
        seat.difficulty = d;
        seat.style = st;
        g.bots.set(seat.id, new Bot(d, st));
        g.refresh();
      }
      out(`${esc(seat.name)} plays <b>${DIFFICULTY_NAMES[d]} · ${STYLE_NAMES[st]}</b>`, args.length > 1 ? 'ok' : undefined);
    },
  },
  {
    name: 'ask', usage: 'ask', group: 'Table', help: 'What the player to act would do and the odds it sees, without making the move. On your turn, asks the autopilot (or an expert).',
    run(args, out) {
      const g = currentGame();
      const t = g.table;
      const h = need(t.hand, 'No hand dealt yet.');
      if (h.isComplete) throw new UsageError('The hand is over.');
      const seat = args[0] ? seatOf(t, args[0]) : t.seatOf(h.toAct);
      const hi = t.handIndexOf(seat.id);
      if (hi < 0) throw new UsageError(`${seat.name} isn't in this hand.`);
      const bot = seat.isHuman ? g.autopilot ?? new Bot('expert') : need(g.bots.get(seat.id), 'No bot in that seat.');
      if (hi !== h.toAct) throw new UsageError(`It isn't ${seat.name}'s turn. Bots only decide when it's their move.`);
      const d = bot.think(buildView(h, hi, t.stats));
      const a = d.action;
      const what = a.type === 'raise' ? `raise to ${fmt(a.to)}` : a.type === 'draw' ? `discard ${a.discard.length}` : a.type;
      out(`${esc(seat.name)} (${DIFFICULTY_NAMES[bot.difficulty]} ${STYLE_NAMES[bot.style]}) would <b>${what}</b>${d.equity !== undefined ? ` · thinks it wins ${Math.round(d.equity * 100)}% of the time` : ''}`);
    },
  },
  {
    name: 'autopilot', usage: 'autopilot [difficulty | off]', group: 'Table', help: 'A bot plays your seat (expert unless you name a level). Good for watching long sessions.',
    run(args, out) {
      const g = currentGame();
      const a = (args[0] ?? (g.autopilot ? 'off' : 'expert')).toLowerCase();
      if (a === 'off') g.autopilot = null;
      else if ((DIFFICULTIES as string[]).includes(a)) g.autopilot = new Bot(a as Difficulty);
      else throw new UsageError(`Use a difficulty (${DIFFICULTIES.join(', ')}) or off.`);
      g.refresh();
      out(g.autopilot ? `Autopilot on: ${DIFFICULTY_NAMES[g.autopilot.difficulty]} plays for you.` : 'Autopilot off.', 'ok');
    },
  },
  {
    name: 'pause', usage: 'pause', group: 'Table', help: 'Freezes the bots so you can look around (or carries on if paused). step moves one at a time.',
    run(_, out) {
      const g = currentGame();
      g.paused = !g.paused;
      g.refresh();
      out(g.paused ? 'Paused. step makes one move, pause again to carry on.' : 'Carrying on.', 'ok');
    },
  },
  {
    name: 'resume', usage: 'resume', group: 'Table', help: 'Lets the bots carry on after pause.',
    run(_, out) {
      const g = currentGame();
      g.paused = false;
      g.refresh();
      out('Carrying on.', 'ok');
    },
  },
  {
    name: 'step', usage: 'step', group: 'Table', help: 'Makes the next bot move now (or deals the next hand).',
    run() {
      currentGame().step();
    },
  },
  {
    name: 'speed', usage: 'speed <ms | default>', group: 'Table', help: 'Time between bot moves, like speed 0 to blitz through hands.',
    run(args, out) {
      const g = currentGame();
      const a = need(args[0], 'Give milliseconds, like speed 50, or speed default.');
      g.botDelay = a === 'default' ? null : Math.max(0, Math.min(10000, Number(a) || 0));
      g.refresh();
      out(g.botDelay === null ? 'Bot speed back to your setting.' : `Bots move every ${g.botDelay} ms.`, 'ok');
    },
  },
  {
    name: 'level', usage: 'level <n>', group: 'Table', help: 'Jumps a tournament to blind level n from the next hand.',
    run(args, out) {
      const t = currentGame().table;
      if (!t.isTournament) throw new UsageError('Cash games have one blind level.');
      const n = Math.max(1, Math.floor(Number(args[0]) || 0));
      if (!args[0] || !n) throw new UsageError('Give a level number, like level 5.');
      t.level = n - 1;
      out(`Blind level ${n} from the next hand.`, 'ok');
    },
  },
  {
    name: 'deal', usage: 'deal', group: 'Table', help: 'Deals the next hand now, if this one is finished.',
    run() {
      currentGame().deal();
    },
  },

  // Online tables
  {
    name: 'tables', usage: 'tables', group: 'Online tables', help: 'Every online table, newest first: code, game, who is there.',
    async run(_, out) {
      const r = await need(tables, 'Online tables are off.').admin({ op: 'tables' });
      const list = r.tables ?? [];
      if (!list.length) return out('No online tables right now.');
      out(table(list.map((t) => [`<code>${esc(t.code)}</code>`, esc(t.game), t.phase + (t.paused ? ', paused' : ''), t.handNumber, esc(t.people.join(', ') || '–'), ago(t.updatedAt)]), ['Code', 'Game', 'State', 'Hand', 'People', 'Active']));
      out('Use table CODE to point the table commands at one.', 'dim');
    },
  },
  {
    name: 'table', usage: 'table [code | off]', group: 'Online tables', help: 'Points the table commands (state, rig, stack, pause…) at an online table by its code, even one you aren\'t at. off goes back to the table on screen.',
    async run(args, out) {
      const code = (args[0] ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) {
        const t = onlineTarget();
        return out(t ? `Table commands go to online table <b>${esc(pinned ?? hooks.onlineTable()?.code ?? '')}</b>.` : 'Table commands go to the practice table on screen.');
      }
      if (code === 'OFF') {
        pinned = null;
        return out(hooks.onlineTable() ? 'Back to the online table on screen.' : 'Back to the practice table on screen.', 'ok');
      }
      pinned = code;
      try {
        printTable(await remote({ do: 'inspect' }), out);
      } catch (err) {
        pinned = null;
        throw err;
      }
      out(`Table commands now go to <b>${esc(code)}</b>. table off to stop.`, 'ok');
    },
  },
  {
    name: 'kick', usage: 'kick <name>', group: 'Online tables', help: 'Takes a person off the online table; a bot plays their chips. They can join again with the code.',
    async run(args, out) {
      if (!onlineTarget()) throw new UsageError('Open an online table, or pick one with table CODE.');
      await remote({ do: 'kick', member: need(args.join(' ') || null, 'Name the person.') }, out);
    },
  },
  {
    name: 'close', usage: 'close yes', group: 'Online tables', help: 'Deletes the online table for everyone at it. Add yes to confirm.',
    async run(args, out) {
      const t = need(onlineTarget(), 'Open an online table, or pick one with table CODE.');
      if ((args[0] ?? '').toLowerCase() !== 'yes') return out(`This ends the game at ${esc(t.code ?? 'this table')} for everyone. Run <b>close yes</b> to go ahead.`, 'err');
      const r = await need(tables, 'Online tables are off.').admin({ op: 'admin', ...t, command: { do: 'close' } });
      pinned = null;
      out(esc(r.message), 'ok');
    },
  },

  // Accounts
  {
    name: 'accounts', usage: 'accounts', group: 'Accounts', help: 'Every online account: email, players, last sign-in.',
    async run(_, out) {
      const list = await onlineAdmin().accounts();
      out(table(list.map((a) => [esc(a.email) + (a.admin ? ' <span class="dev-tag">admin</span>' : ''), a.players, ago(a.lastSignInAt), new Date(a.createdAt).toLocaleDateString()]), ['Email', 'Players', 'Last sign-in', 'Joined']));
      out(`${list.length} account${list.length === 1 ? '' : 's'}.`, 'dim');
    },
  },
  {
    name: 'players', usage: 'players [search]', group: 'Accounts', help: 'Every player in every account, richest first. Search by name or email.',
    async run(args, out) {
      const api = onlineAdmin();
      const [players, accounts] = await Promise.all([api.players(), api.accounts().catch(() => [])]);
      known = players;
      const email = new Map(accounts.map((a) => [a.id, a.email]));
      const q = args.join(' ').toLowerCase();
      const rows = players
        .filter((x) => !q || x.profile.name.toLowerCase().includes(q) || (email.get(x.owner) ?? '').toLowerCase().includes(q))
        .sort((a, b) => b.profile.bank - a.profile.bank);
      out(table(rows.map((x) => [`<code>${shortId(x.profile.id)}</code>`, esc(x.profile.name), esc(email.get(x.owner) ?? x.owner.slice(0, 8)), x.profile.bank, x.profile.stats.hands, ago(x.updatedAt)]), ['Id', 'Name', 'Account', 'Bank', 'Hands', 'Saved']));
      out(`${rows.length} player${rows.length === 1 ? '' : 's'}. Use the id with edit.`, 'dim');
    },
  },
  {
    name: 'edit', usage: 'edit <player> bank <n> | name <new> | stat <name> <n> | resetstats', group: 'Accounts',
    help: 'Changes any player, in any account. If they are playing right now, their next save can undo it.',
    async run(args, out) {
      const target = await findPlayer(args[0]);
      const what = (args[1] ?? '').toLowerCase();
      const name = esc(target.profile.name);
      if (what === 'bank') {
        const before = target.profile.bank;
        const n = amount(args[2], before);
        await changePlayer(target, (p) => setBank(p, n), 'edit bank', { from: before, to: n });
        out(`${name}'s bank ${fmt(before)} → <b>${fmt(n)}</b>`, 'ok');
      } else if (what === 'name') {
        const nm = cleanName(args.slice(2).join(' '));
        if (!nm) throw new UsageError('Give the new name.');
        await changePlayer(target, (p) => {
          p.name = nm;
          p.updatedAt = Date.now();
        }, 'edit name', { to: nm });
        out(`${name} is now <b>${esc(nm)}</b>`, 'ok');
      } else if (what === 'stat') {
        let field = '';
        await changePlayer(target, (p) => (field = setStat(p, args[2], args[3])), 'edit stat', { stat: args[2], to: args[3] });
        out(`${name}: ${field} = <b>${esc(args[3])}</b>`, 'ok');
      } else if (what === 'resetstats') {
        await changePlayer(target, resetStats, 'reset stats', {});
        out(`${name}'s stats reset.`, 'ok');
      } else {
        throw new UsageError('Say what to change: bank, name, stat or resetstats.');
      }
    },
  },
  {
    name: 'inspect', usage: 'inspect <player>', group: 'Accounts', help: 'Everything saved for one player.',
    async run(args, out) {
      const t = await findPlayer(args[0]);
      const p = t.profile;
      out(`<b>${esc(p.name)}</b> · ${esc(p.id)} · owner ${esc(t.owner)} · bank <b>${fmt(p.bank)}</b>${p.table ? ` · ${fmt(p.table.paidIn)} at a ${p.table.kind} table` : ''}`);
      out(table(STAT_FIELDS.map((k) => [k, p.stats[k] as number]), ['Stat', 'Value']));
      out(`<pre class="dev-pre">${esc(JSON.stringify(p.settings, null, 1))}</pre>`, 'dim');
    },
  },
  {
    name: 'delete', usage: 'delete <player> yes', group: 'Accounts', help: 'Deletes a player for good. Add yes to confirm.',
    async run(args, out) {
      const t = await findPlayer(args[0]);
      try {
        if (player().id === t.profile.id) throw new UsageError('That\'s the player you are using. Switch players first.');
      } catch (err) {
        if (err instanceof UsageError) throw err;
      }
      if ((args[1] ?? '').toLowerCase() !== 'yes') return out(`This deletes <b>${esc(t.profile.name)}</b> (bank ${fmt(t.profile.bank)}, ${fmt(t.profile.stats.hands)} hands) for good. Run <b>delete ${shortId(t.profile.id)} yes</b> to go ahead.`, 'err');
      await onlineAdmin().deletePlayer(t.profile.id);
      await admin?.log('delete player', { player: t.profile.id, name: t.profile.name, bank: t.profile.bank });
      known = known.filter((x) => x !== t);
      out(`Deleted ${esc(t.profile.name)}.`, 'ok');
    },
  },
  {
    name: 'announce', usage: 'announce [text | off]', group: 'Accounts', help: 'A message at the top of everyone\'s lobby. Use quotes or just type the text.',
    async run(args, out) {
      const api = onlineAdmin();
      if (!args.length) {
        const now = await api.announcement();
        return out(now ? `Announcement: <b>${esc(now)}</b>` : 'No announcement.');
      }
      const text = args[0].toLowerCase() === 'off' && args.length === 1 ? '' : args.join(' ').slice(0, 280);
      await api.setAnnouncement(text);
      await api.log('announce', { text });
      hooks.announced(text);
      out(text ? `Everyone now sees: <b>${esc(text)}</b>` : 'Announcement removed.', 'ok');
    },
  },
  {
    name: 'log', usage: 'log [count]', group: 'Accounts', help: 'Recent console changes, newest first.',
    async run(args, out) {
      const rows = await onlineAdmin().recentLog(Math.max(1, Math.min(200, Number(args[0]) || 20)));
      if (!rows.length) return out('Nothing logged yet.');
      out(table(rows.map((r) => [new Date(r.at).toLocaleString(), esc(r.action), `<code>${esc(JSON.stringify(r.detail))}</code>`]), ['When', 'Action', 'Detail']));
    },
  },
];

export const COMMAND_NAMES = COMMANDS.map((c) => c.name);
