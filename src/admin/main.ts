// The admin dashboard (admin/ next to the game): the developer console as a page of its own,
// with panels for live tables, players, accounts, the lobby announcement and the change log.
// It signs in with the same accounts as the game. Nothing here is trusted: every panel reads
// and changes things through the same database rules (supabase/admin.sql) and table-server
// admin checks as the console, and most buttons simply run a console command.
import { ONLINE } from '../accounts/config';
import { AdminApi, AdminLogEntry, AdminPlayer, OnlineAuth, OnlineError, onlineEnabled } from '../accounts';
import { Card } from '../engine/cards';
import { DIFFICULTY_NAMES } from '../engine/table';
import { VARIANTS } from '../engine/variants';
import { TableClient } from '../online/client';
import { AdminTableInfo, AdminTableSummary } from '../online/protocol';
import { cardHtml, esc, fmt } from '../ui/dom';
import { consolePrint, dockConsole, execute, initConsole, pinTable, refreshConsoleAccess } from '../ui/console';

type Tab = 'tables' | 'players' | 'accounts' | 'announcement' | 'log';
const TABS: [Tab, string][] = [
  ['tables', 'Live tables'],
  ['players', 'Players'],
  ['accounts', 'Accounts'],
  ['announcement', 'Announcement'],
  ['log', 'Change log'],
];
const TAB_KEY = 'backroom-poker-admin-tab';
/** How often the live panels (tables, the table being watched, the log) fetch again. */
const REFRESH_MS = 3000;

const app = document.getElementById('app')!;
let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch {
  /* storage blocked: sign in again each visit */
}
const auth = onlineEnabled(ONLINE) ? new OnlineAuth(ONLINE, storage) : null;
const api = auth ? new AdminApi(auth) : null;
const tables = auth ? new TableClient(auth) : null;
/** The game, relative to this page: one folder up on the published site, index.html next to a local copy. */
const gameUrl = /\.html?$/.test(location.pathname) ? 'index.html' : '../';

let tab: Tab = 'tables';
try {
  const saved = storage?.getItem(TAB_KEY);
  if (TABS.some(([t]) => t === saved)) tab = saved as Tab;
} catch {
  /* start on tables */
}
/** Code of the online table being watched, or null. */
let watching: string | null = null;
let playerSearch = '';
let consoleReady = false;
let loading = false;

const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const shortId = (id: string) => id.replace(/^pr_/, '').slice(0, 8);
const cards = (cs: readonly (Card | null)[], empty = '<span class="adm-muted">none</span>') =>
  cs.length ? `<span class="adm-cards">${cs.map((c) => cardHtml(c)).join('')}</span>` : empty;
const grid = (rows: string[][], head: string[]) =>
  `<div class="adm-scroll"><table class="adm-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => app.querySelector<T>(sel);

// ---------- signing in ----------

function renderGate(title: string, body: string, actions = '') {
  stopTimer();
  app.innerHTML = `
    <main class="adm-gate">
      <div class="adm-card">
        <p class="adm-brand"><span class="adm-suit">♠</span> Back Room Poker <span class="adm-tag">admin</span></p>
        <h1>${title}</h1>
        ${body}
        <div class="adm-actions">${actions}<a class="btn" href="${gameUrl}">Back to the game</a></div>
      </div>
    </main>`;
}

function renderSignIn(message = '') {
  renderGate('Admin dashboard', `
    <p class="adm-muted">Sign in with your Back Room Poker account. Only admin accounts get past this page.</p>
    <form id="adm-signin" class="adm-form">
      <label>Email <input type="email" name="email" autocomplete="username" required></label>
      <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
      <p class="adm-error" role="alert">${esc(message)}</p>
      <button class="btn btn-primary" type="submit">Sign in</button>
    </form>`);
  const form = $<HTMLFormElement>('#adm-signin')!;
  form.querySelector<HTMLInputElement>('input')!.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const button = form.querySelector<HTMLButtonElement>('button')!;
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      await auth!.signIn(String(data.get('email')), String(data.get('password')));
      await enter();
    } catch (err) {
      renderSignIn((err as Error).message);
    }
  };
}

async function signOut() {
  stopTimer();
  await auth?.signOut();
  location.reload();
}

async function enter() {
  renderGate('Checking your account…', '<p class="adm-muted">Asking the server whether this account is an admin.</p>');
  if (!consoleReady) {
    consoleReady = true;
    initConsole({
      place: 'dashboard',
      game: () => null,
      blackjack: () => null,
      onlineTable: () => null,
      reveal: () => false,
      redraw: () => void load(),
      announced: () => {
        if (tab === 'announcement') renderPanel();
      },
    }, auth);
  }
  if (!(await refreshConsoleAccess())) {
    renderGate('Not an admin account', `
      <p><b>${esc(auth?.current?.email ?? '')}</b> isn't on the admin list, or the server couldn't be reached.</p>
      <p class="adm-muted">Admins are added in the Supabase SQL Editor with supabase/admin.sql. Nothing here works for other accounts: the database and the table server check every request.</p>`,
    '<button class="btn" id="adm-signout" type="button">Sign out</button>');
    $('#adm-signout')!.onclick = () => void signOut();
    return;
  }
  renderDashboard();
}

// ---------- the dashboard ----------

let timer = 0;
function stopTimer() {
  clearInterval(timer);
  timer = 0;
}

function renderDashboard() {
  app.innerHTML = `
    <div class="adm">
      <header class="adm-top">
        <span class="adm-brand"><span class="adm-suit">♠</span> Back Room Poker <span class="adm-tag">admin</span></span>
        <nav class="adm-tabs" role="tablist" aria-label="Dashboard sections">
          ${TABS.map(([t, label]) => `<button type="button" role="tab" data-tab="${t}">${label}</button>`).join('')}
        </nav>
        <span class="adm-me">
          <span class="adm-email">${esc(auth?.current?.email ?? '')}</span>
          <a href="${gameUrl}" target="_blank" rel="noopener">Game ↗</a>
          <button type="button" class="adm-link" id="adm-signout" title="Signs this browser out of the game too">Sign out</button>
        </span>
      </header>
      <main class="adm-main">
        <section class="adm-panel" id="adm-panel" role="tabpanel"></section>
        <section class="adm-term" id="adm-term" aria-label="Terminal"></section>
      </main>
    </div>`;
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab as Tab)));
  $('#adm-signout')!.onclick = () => void signOut();
  dockConsole($('#adm-term')!);
  renderPanel();
  stopTimer();
  timer = window.setInterval(() => {
    if (!document.hidden && (tab === 'tables' || tab === 'log')) void load();
  }, REFRESH_MS);
}

function switchTab(t: Tab) {
  tab = t;
  try {
    storage?.setItem(TAB_KEY, t);
  } catch {
    /* remembered for this visit */
  }
  renderPanel();
}

function renderPanel() {
  const panel = $('#adm-panel');
  if (!panel) return;
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (tab === 'tables') {
    panel.innerHTML = `
      <div class="adm-bar"><h2>Live tables</h2><span class="adm-muted">Updates every few seconds</span></div>
      <div id="adm-list" class="adm-data"><p class="adm-muted">Loading…</p></div>
      <div id="adm-watch"></div>`;
  } else if (tab === 'players') {
    panel.innerHTML = `
      <div class="adm-bar"><h2>Players</h2>
        <input type="search" id="adm-search" placeholder="Search by name or email" value="${esc(playerSearch)}" aria-label="Search players">
        <button type="button" class="btn" id="adm-reload">Refresh</button></div>
      <div id="adm-data" class="adm-data"><p class="adm-muted">Loading…</p></div>`;
    const search = $<HTMLInputElement>('#adm-search')!;
    search.oninput = () => {
      playerSearch = search.value;
      drawPlayers();
    };
    $('#adm-reload')!.onclick = () => void load();
  } else if (tab === 'accounts') {
    panel.innerHTML = `
      <div class="adm-bar"><h2>Accounts</h2><button type="button" class="btn" id="adm-reload">Refresh</button></div>
      <div id="adm-data" class="adm-data"><p class="adm-muted">Loading…</p></div>`;
    $('#adm-reload')!.onclick = () => void load();
  } else if (tab === 'announcement') {
    panel.innerHTML = `
      <div class="adm-bar"><h2>Lobby announcement</h2></div>
      <div id="adm-data" class="adm-data"><p class="adm-muted">Loading…</p></div>`;
  } else {
    panel.innerHTML = `
      <div class="adm-bar"><h2>Change log</h2><span class="adm-muted">Everything changed from the console, newest first</span></div>
      <div id="adm-data" class="adm-data"><p class="adm-muted">Loading…</p></div>`;
  }
  void load();
}

/** Fetches whatever the open panel shows. */
async function load() {
  if (loading || !api || !tables) return;
  loading = true;
  const showing = tab;
  try {
    if (showing === 'tables') await loadTables();
    else if (showing === 'players') await loadPlayers();
    else if (showing === 'accounts') await loadAccounts();
    else if (showing === 'announcement') await loadAnnouncement();
    else await loadLog();
  } catch (err) {
    if (err instanceof OnlineError && err.status === 401) return renderSignIn('Your sign-in expired. Sign in again.');
    const el = $(showing === 'tables' ? '#adm-list' : '#adm-data');
    if (el && tab === showing) el.innerHTML = `<p class="adm-error">${esc((err as Error).message)}</p>`;
  } finally {
    loading = false;
  }
}

/** Runs a console command in the terminal, then refreshes the panel. */
async function run(line: string) {
  await execute(line);
  await load();
}

// ---------- live tables ----------

let tableList: AdminTableSummary[] = [];

async function loadTables() {
  const [list, info] = await Promise.all([
    tables!.admin({ op: 'tables' }).then((r) => r.tables ?? []),
    watching ? tables!.admin({ op: 'admin', code: watching, command: { do: 'inspect' } }).then((r) => r.table).catch(() => null) : Promise.resolve(null),
  ]);
  if (tab !== 'tables') return;
  tableList = list;
  const el = $('#adm-list');
  if (!el) return;
  el.innerHTML = list.length
    ? grid(list.map((t) => [
      `<code>${esc(t.code)}</code>`, esc(t.game), `${t.phase}${t.paused ? ' <span class="adm-pill">paused</span>' : ''}`, String(t.handNumber),
      esc(t.people.join(', ') || '–'), ago(t.updatedAt),
      `<button type="button" class="btn btn-sm${t.code === watching ? ' btn-primary' : ''}" data-watch="${esc(t.code)}">${t.code === watching ? 'Watching' : 'Watch'}</button>`,
    ]), ['Code', 'Game', 'State', 'Hand', 'People', 'Active', ''])
    : '<p class="adm-muted">No online tables right now. They show up here as soon as someone opens one.</p>';
  el.querySelectorAll<HTMLButtonElement>('[data-watch]').forEach((b) => (b.onclick = () => {
    watching = watching === b.dataset.watch ? null : b.dataset.watch!;
    void load();
  }));
  if (watching && !info && !list.some((t) => t.code === watching)) watching = null;
  drawWatch(info);
}

function drawWatch(info: AdminTableInfo | null | undefined) {
  const el = $('#adm-watch');
  if (!el) return;
  if (!watching || !info) {
    el.innerHTML = watching ? '<p class="adm-muted">Loading the table…</p>' : '';
    return;
  }
  const bj = info.bj;
  const game = bj ? 'Blackjack' : VARIANTS[info.settings.variant]?.name ?? info.settings.variant;
  const h = info.hand;
  const status = bj
    ? `round ${bj.roundNumber} · ${bj.round ? bj.round.phase : bj.phase} · shoe ${bj.shoeLeft}/${bj.shoeSize}`
    : `hand ${info.handNumber}${h ? ` · ${h.complete ? 'finished' : `${h.phase}, street ${h.street + 1} of ${h.numStreets}`} · pot <b>${fmt(h.pot)}</b>` : ''}`;
  const people = info.members.filter((m) => !m.left);
  el.innerHTML = `
    <div class="adm-watch">
      <div class="adm-bar">
        <h3>Table <code>${esc(info.code)}</code> · ${esc(game)}</h3>
        <span class="adm-muted">${info.phase} · ${status}</span>
        ${info.paused ? '<span class="adm-pill">paused</span>' : ''}
      </div>
      <div class="adm-actions">
        <button type="button" class="btn btn-sm" data-act="${info.paused ? 'resume' : 'pause'}">${info.paused ? 'Resume' : 'Pause'}</button>
        <button type="button" class="btn btn-sm" data-act="step" title="Make the next bot move or deal now">Step</button>
        <button type="button" class="btn btn-sm" data-act="peek" title="Every card still to come, in the terminal">Peek</button>
        <button type="button" class="btn btn-sm" data-act="state" title="Everything about the table, in the terminal">State</button>
        ${people.length ? `<span class="adm-kick"><select id="adm-kick" aria-label="Person to kick">${people.map((m) => `<option>${esc(m.name)}</option>`).join('')}</select><button type="button" class="btn btn-sm" id="adm-kick-go">Kick</button></span>` : ''}
        <button type="button" class="btn btn-sm adm-danger" id="adm-close">Close table</button>
      </div>
      ${info.phase === 'lobby' ? '<p class="adm-muted">Still in the lobby, waiting for the host to start.</p>' : bj ? watchBlackjack(info) : watchPoker(info)}
      <p class="adm-muted adm-people">People: ${people.length ? people.map((m) => `${esc(m.name)}${m.host ? ' (host)' : ''}${m.away ? ' (away)' : ''}`).join(', ') : 'nobody'}</p>
    </div>`;
  const code = info.code;
  const isBj = !!bj;
  el.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => (b.onclick = () => {
    pinTable(code, isBj);
    void run(b.dataset.act!);
  }));
  const kick = $<HTMLButtonElement>('#adm-kick-go');
  if (kick) kick.onclick = () => {
    const who = $<HTMLSelectElement>('#adm-kick')!.value;
    if (!confirm(`Take ${who} off table ${code}? A bot plays their chips, and they can join again with the code.`)) return;
    pinTable(code, isBj);
    void run(`kick "${who.replace(/"/g, '')}"`);
  };
  $('#adm-close')!.onclick = () => {
    if (!confirm(`Close table ${code}? The game ends for everyone at it.`)) return;
    pinTable(code, isBj);
    watching = null;
    void run('close yes');
  };
}

function watchPoker(info: AdminTableInfo): string {
  const h = info.hand;
  if (!h) return '<p class="adm-muted">No hand dealt yet.</p>';
  const seat = (id: string) => info.seats.find((s) => s.id === id);
  const players = info.seats.map((s) => {
    const hp = h.players.find((p) => p.seat === s.id);
    const who = s.isHuman ? 'person' : `${DIFFICULTY_NAMES[s.difficulty!] ?? 'bot'} bot`;
    return `
      <div class="adm-seat${h.toAct === s.id && !h.complete ? ' adm-turn' : ''}${hp?.status === 'folded' || !hp ? ' adm-out' : ''}">
        <div class="adm-seat-head"><b>${esc(s.name)}</b><span class="adm-muted">${who}</span></div>
        ${hp ? cards(hp.cards) : '<span class="adm-muted">not in this hand</span>'}
        <div class="adm-muted">${fmt(hp ? hp.stack : s.stack)} chips${hp?.totalBet ? ` · ${fmt(hp.totalBet)} in` : ''}${hp ? ` · ${hp.status}` : ''}</div>
      </div>`;
  }).join('');
  const coming = h.complete ? [] : h.coming;
  return `
    <div class="adm-board"><span class="adm-label">Board</span>${cards(h.board)}</div>
    <div class="adm-seats">${players}</div>
    ${coming.length ? `<div class="adm-coming"><span class="adm-label">Still to come</span>${coming.map((c) => `
      <div class="adm-street"><span class="adm-muted">${esc(c.name)}</span>
        ${c.board.length ? cards(c.board) : ''}
        ${c.players.map((p) => `<span class="adm-for">${esc(seat(p.seat)?.name ?? p.seat)} ${cards([p.card])}</span>`).join('')}
        ${c.draws.length ? `<span class="adm-for">draws ${cards(c.draws)}</span>` : ''}
      </div>`).join('')}</div>` : ''}
    ${info.nextRig ? '<p class="adm-muted">The next hand is rigged. Run state in the terminal for the cards.</p>' : ''}`;
}

function watchBlackjack(info: AdminTableInfo): string {
  const bj = info.bj!;
  const r = bj.round;
  const spots = bj.spots.map((s) => {
    const si = r ? bj.inRound.indexOf(s.id) : -1;
    const seat = si >= 0 ? r!.seats[si] : null;
    return `
      <div class="adm-seat${seat ? '' : ' adm-out'}">
        <div class="adm-seat-head"><b>${esc(s.name)}</b><span class="adm-muted">${s.isHuman ? 'person' : 'bot'}${s.away ? ' · away' : ''}</span></div>
        ${seat ? seat.hands.map((hand) => `<div>${cards(hand.cards)} <span class="adm-muted">${fmt(hand.bet)}${hand.outcome ? ` · ${hand.outcome}` : ''}</span></div>`).join('') : `<span class="adm-muted">${s.sittingOut ? 'sitting out' : s.bet ? `bet ${fmt(s.bet)}` : 'no bet yet'}</span>`}
        <div class="adm-muted">${fmt(s.stack)} chips</div>
      </div>`;
  }).join('');
  return `
    <div class="adm-board"><span class="adm-label">Dealer</span>${r ? cards(r.dealer) : '<span class="adm-muted">between rounds</span>'}${r && !r.holeShown ? '<span class="adm-muted">hole card still face down for players</span>' : ''}</div>
    <div class="adm-seats">${spots}</div>
    <div class="adm-board"><span class="adm-label">Next from the shoe</span>${cards(bj.upcoming.slice(0, 10))}</div>`;
}

// ---------- players and accounts ----------

let players: AdminPlayer[] = [];
let emails = new Map<string, string>();

async function loadPlayers() {
  const [list, accounts] = await Promise.all([api!.players(), api!.accounts().catch(() => [])]);
  players = list;
  emails = new Map(accounts.map((a) => [a.id, a.email]));
  if (tab === 'players') drawPlayers();
}

function drawPlayers() {
  const el = $('#adm-data');
  if (!el) return;
  const q = playerSearch.trim().toLowerCase();
  const rows = players
    .filter((x) => !q || x.profile.name.toLowerCase().includes(q) || (emails.get(x.owner) ?? '').toLowerCase().includes(q))
    .sort((a, b) => b.profile.bank - a.profile.bank);
  el.innerHTML = rows.length
    ? grid(rows.map((x) => [
      `<b>${esc(x.profile.name)}</b> <code class="adm-muted">${shortId(x.profile.id)}</code>`,
      esc(emails.get(x.owner) ?? shortId(x.owner)), fmt(x.profile.bank), fmt(x.profile.stats.hands), ago(x.updatedAt),
      `<span class="adm-row-actions">
        <button type="button" class="btn btn-sm" data-p="inspect" data-id="${esc(x.profile.id)}">Inspect</button>
        <button type="button" class="btn btn-sm" data-p="bank" data-id="${esc(x.profile.id)}">Bank</button>
        <button type="button" class="btn btn-sm" data-p="name" data-id="${esc(x.profile.id)}">Rename</button>
        <button type="button" class="btn btn-sm adm-danger" data-p="delete" data-id="${esc(x.profile.id)}">Delete</button>
      </span>`,
    ]), ['Player', 'Account', 'Bank', 'Hands', 'Saved', ''])
    + `<p class="adm-muted">${rows.length} of ${players.length} players. A player who is online right now can undo a change with their next save.</p>`
    : `<p class="adm-muted">${players.length ? 'No player matches that search.' : 'No players yet.'}</p>`;
  el.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => (b.onclick = () => {
    const p = players.find((x) => x.profile.id === b.dataset.id)!.profile;
    if (b.dataset.p === 'inspect') return void run(`inspect ${p.id}`);
    if (b.dataset.p === 'bank') {
      const v = prompt(`New bank for ${p.name}. Amounts like 2.5k, +500 or -1k work.`, String(p.bank));
      if (v?.trim()) void run(`edit ${p.id} bank ${v.trim().replace(/\s+/g, '')}`);
    } else if (b.dataset.p === 'name') {
      const v = prompt(`New name for ${p.name}`, p.name);
      if (v?.trim()) void run(`edit ${p.id} name "${v.trim().replace(/"/g, '')}"`);
    } else if (confirm(`Delete ${p.name} for good? Bank ${fmt(p.bank)}, ${fmt(p.stats.hands)} hands.`)) {
      void run(`delete ${p.id} yes`);
    }
  }));
}

async function loadAccounts() {
  const list = await api!.accounts();
  const el = $('#adm-data');
  if (!el || tab !== 'accounts') return;
  el.innerHTML = grid(list.map((a) => [
    `${esc(a.email)}${a.admin ? ' <span class="adm-pill">admin</span>' : ''}`,
    a.players ? `<button type="button" class="adm-link" data-email="${esc(a.email)}">${a.players} player${a.players === 1 ? '' : 's'}</button>` : '0',
    ago(a.lastSignInAt), new Date(a.createdAt).toLocaleDateString(),
  ]), ['Email', 'Players', 'Last sign-in', 'Joined']) + `<p class="adm-muted">${list.length} account${list.length === 1 ? '' : 's'}.</p>`;
  el.querySelectorAll<HTMLButtonElement>('[data-email]').forEach((b) => (b.onclick = () => {
    playerSearch = b.dataset.email!;
    switchTab('players');
  }));
}

// ---------- announcement and log ----------

async function loadAnnouncement() {
  const now = await api!.announcement();
  const el = $('#adm-data');
  if (!el || tab !== 'announcement') return;
  el.innerHTML = `
    <p class="adm-muted">Shown at the top of everyone's lobby. Up to 280 characters.</p>
    <div class="adm-preview">${now ? esc(now) : '<span class="adm-muted">No announcement right now.</span>'}</div>
    <textarea id="adm-text" maxlength="280" rows="3" placeholder="Server maintenance at 9pm…">${esc(now)}</textarea>
    <div class="adm-actions">
      <button type="button" class="btn btn-primary" id="adm-save">Publish</button>
      ${now ? '<button type="button" class="btn" id="adm-clear">Remove it</button>' : ''}
    </div>`;
  const publish = async (text: string) => {
    try {
      await api!.setAnnouncement(text);
      await api!.log('announce', { text });
      consolePrint(text ? `Everyone now sees: <b>${esc(text)}</b>` : 'Announcement removed.', 'ok');
    } catch (err) {
      consolePrint(esc((err as Error).message), 'err');
    }
    await load();
  };
  $('#adm-save')!.onclick = () => void publish($<HTMLTextAreaElement>('#adm-text')!.value.trim().slice(0, 280));
  const clear = $('#adm-clear');
  if (clear) clear.onclick = () => void publish('');
}

async function loadLog() {
  const rows: AdminLogEntry[] = await api!.recentLog(100);
  const el = $('#adm-data');
  if (!el || tab !== 'log') return;
  el.innerHTML = rows.length
    ? grid(rows.map((r) => [`<span title="${esc(new Date(r.at).toLocaleString())}">${ago(r.at)}</span>`, esc(r.action), `<code class="adm-detail">${esc(JSON.stringify(r.detail))}</code>`]), ['When', 'Action', 'Detail'])
    : '<p class="adm-muted">Nothing changed from the console yet.</p>';
}

// ---------- start ----------

if (!auth) {
  renderGate('Online accounts are off', '<p class="adm-muted">This copy of the game keeps players in the browser only, so there are no admin accounts to sign in with.</p>');
} else if (!auth.current) {
  renderSignIn();
} else {
  void enter();
}
