import {
  ACHIEVEMENTS, Achievement, AccountStore, Counters, KeyValueStorage, LocalAccountStore, NAME_MAX, OnlineAccountStore, OnlineAuth, PROFILE_COLORS, Profile, REFILL_BELOW, STARTING_BANK,
  allCounters, canRefill, cleanName, createProfile, exportProfile, importProfile, newId, refill, settleOpenTable, takeUnlocks, titleFor,
} from '../accounts';
import { VARIANTS, VariantId } from '../engine/variants';
import { makeCard } from '../engine/cards';
import { cardHtml, esc, fmt, titleHtml } from './dom';

// ---------- the signed-in player ----------

let local: LocalAccountStore;
let auth: OnlineAuth | null = null;
let storage: KeyValueStorage | null = null;
let store: AccountStore;
let current: Profile | null = null;
let saving: Promise<void> = Promise.resolve();
/** Why the last online save failed, shown on the lobby badge until a save succeeds. */
let saveError = '';
/** A one-off message for the lobby, such as falling back to this device's players. */
let notice = '';

/** Sets up where players are kept. `onlineAuth` is null when online accounts aren't configured. */
export function initAccounts(localStore: LocalAccountStore, onlineAuth: OnlineAuth | null, kv: KeyValueStorage | null) {
  local = localStore;
  auth = onlineAuth;
  storage = kv;
  store = local;
}

/** Settings from before accounts existed, given to the first player created. */
let welcomeSettings: Record<string, unknown> = {};
export function setWelcomeSettings(settings: Record<string, unknown>) {
  welcomeSettings = settings;
}

export const isOnline = (): boolean => store.kind === 'online';

export function takeNotice(): string {
  const n = notice;
  notice = '';
  return n;
}

/**
 * Opens the last player used with the current store, or the welcome screen when there
 * are none. Any chips left at a table by a closed tab are settled first.
 */
export async function openPlayer(onReady: () => void, app: HTMLElement) {
  let players: Profile[];
  try {
    players = await store.list();
  } catch (err) {
    if (!isOnline()) throw err;
    notice = `${(err as Error).message} You're playing with the players saved on this device.`;
    store = local;
    players = await store.list();
  }
  const id = await store.currentId();
  const p = players.find((x) => x.id === id) ?? players.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  if (!p) {
    current = null;
    return renderWelcome(app, onReady);
  }
  await selectPlayer(p);
  if (p.table) {
    settleOpenTable(p);
    await savePlayer();
  }
  onReady();
}

/**
 * Switches to the signed-in account's players. A brand-new account gets copies of the
 * players on this device, so nobody starts over when they first sign in.
 */
export async function goOnline(onReady: () => void, app: HTMLElement) {
  if (!auth?.current) return openPlayer(onReady, app);
  const online = new OnlineAccountStore(auth, storage);
  store = online;
  try {
    const existing = await online.list();
    if (!existing.length) {
      for (const p of await local.list()) {
        settleOpenTable(p);
        await online.put({ ...p, id: newId() });
      }
    }
  } catch (err) {
    store = local;
    notice = `${(err as Error).message} You're playing with the players saved on this device.`;
  }
  return openPlayer(onReady, app);
}

export function player(): Profile {
  if (!current) throw new Error('No player selected');
  return current;
}


export async function selectPlayer(p: Profile | null) {
  current = p;
  await store.setCurrentId(p?.id ?? null);
}

// ---------- achievements credited by the table server ----------

let awards: Counters = {};
let awardsFor = '';

/** What the table server credited the current player for online play (empty offline). */
export const serverAwards = (): Counters => (current && awardsFor === current.id ? awards : {});

/**
 * Fetches the current player's online progress, then marks and returns any achievements
 * that are newly unlocked (online play, or anything else earned since the last look).
 */
export async function refreshAwards(): Promise<Achievement[]> {
  const p = current;
  if (!p) return [];
  if (store instanceof OnlineAccountStore) {
    try {
      const got = await store.awards(p.id);
      if (current !== p) return [];
      awards = got;
      awardsFor = p.id;
    } catch {
      /* offline for now: keep what we had */
    }
  }
  const fresh = takeUnlocks(p, serverAwards());
  if (fresh.length) await savePlayer();
  return fresh;
}

/** The current player's chosen title, if they still hold it. */
export const currentTitle = (): string | null => (current ? titleFor(current.title, allCounters(current, serverAwards())) : null);

/** Saves the current player. Writes are queued so they land in order. */
export function savePlayer(): Promise<void> {
  if (!current) return saving;
  const snapshot = current;
  const target = store;
  saving = saving
    .then(() => target.put(snapshot))
    .then(() => (saveError = ''))
    .catch((err) => (saveError = (err as Error).message || 'Not saved.'))
    .then(() => undefined);
  return saving;
}

// ---------- shared bits ----------

export const avatarHtml = (p: Profile, cls = '') =>
  `<span class="pfp ${cls}" style="--pfp:${esc(p.color)}" aria-hidden="true">${esc(p.name.slice(0, 1).toUpperCase())}</span>`;

/** The lobby's player badge: who is playing and what is in their bank. */
export function playerBadgeHtml(): string {
  const p = player();
  return `<button type="button" class="player-badge" id="open-profile" title="Your profile and stats">
    ${avatarHtml(p)}
    <span class="pb-text"><b>${esc(p.name)}${titleHtml(currentTitle())}</b><span>Bank <em>${fmt(p.bank)}</em>${saveError ? ' · <i class="unsaved" title="' + esc(saveError) + '">not saved online</i>' : ''}</span></span>
    <span class="pb-more">Profile</span>
  </button>`;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- sign in, sign up, pick a name ----------

/** Where links in account emails send people back to: this page, without any old hash. */
const returnUrl = () => location.href.split('#')[0];

/** The email typed last, kept when switching between signing in and signing up. */
let lastEmail = '';

/** Full-screen layout shared by the sign-in, name and password screens: the brand on one side, a card on the other. */
function authShell(card: string, tagline: string): string {
  const fan = [makeCard(14, 3), makeCard(14, 2), makeCard(13, 1), makeCard(13, 0), makeCard(12, 3)]
    .map((c, i) => cardHtml(c, '').replace('class="card', `style="--k:${i - 2}" class="card`))
    .join('');
  const n = takeNotice();
  return `<main class="auth">
    <section class="auth-brand">
      <span class="eyebrow">Card room · open all night</span>
      <h1>Back Room <em>Poker</em></h1>
      <p>${tagline}</p>
      <div class="hero-fan auth-fan" aria-hidden="true">${fan}</div>
    </section>
    <section class="auth-card">
      ${n ? `<p class="notice" role="status">${esc(n)}</p>` : ''}
      ${card}
    </section>
  </main>`;
}

/** Runs an account action with the card's buttons disabled, showing any error under the form. */
async function busy(app: HTMLElement, fn: () => Promise<void>) {
  const btns = app.querySelectorAll<HTMLButtonElement>('.auth-card button, .account-panel button');
  btns.forEach((b) => (b.disabled = true));
  const err = document.getElementById('auth-error') ?? document.getElementById('form-error');
  if (err) err.textContent = '';
  try {
    await fn();
  } catch (e) {
    if (err?.isConnected) err.textContent = (e as Error).message;
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

/** The first screen when online accounts are on: sign in, or create an account. */
export function renderAuth(app: HTMLElement, onReady: () => void, mode: 'signin' | 'signup' = 'signin', message = '') {
  if (!auth) return void openPlayer(onReady, app);
  const a = auth;
  const signup = mode === 'signup';
  app.innerHTML = authShell(`
    <div class="seg auth-tabs" role="group" aria-label="Sign in or create an account">
      <button type="button" data-mode="signin" aria-pressed="${!signup}">Sign in</button>
      <button type="button" data-mode="signup" aria-pressed="${signup}">Create account</button>
    </div>
    <div class="auth-head">
      <h2>${signup ? 'Take a seat' : 'Welcome back'}</h2>
      <p class="auth-sub">${signup
        ? `New players start with <b>${fmt(STARTING_BANK)}</b> chips. Your bank and record follow you to any device.`
        : 'Sign in to pick up your chips and stats where you left them.'}</p>
    </div>
    <form id="auth-form" class="auth-form">
      <label class="auth-field"><span>Email</span>
        <input id="auth-email" class="text-input" type="email" autocomplete="email" value="${esc(lastEmail)}" required>
      </label>
      <label class="auth-field"><span>Password</span>
        <span class="pw-wrap">
          <input id="auth-pass" class="text-input" type="password" minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}" ${signup ? 'placeholder="At least 6 characters"' : ''} required>
          <button type="button" class="pw-show" id="pw-show" aria-pressed="false">Show</button>
        </span>
      </label>
      <button type="submit" class="btn btn-primary btn-lg auth-go">${signup ? 'Create account' : 'Sign in'}</button>
    </form>
    ${signup ? '' : '<button type="button" class="link-btn plain auth-forgot" id="forgot">Forgot your password?</button>'}
    <p class="form-ok" id="auth-ok" role="status">${esc(message)}</p>
    <p class="form-error" id="auth-error" role="alert"></p>
    <div class="auth-alt"><span>or</span></div>
    <button type="button" class="btn auth-offline" id="play-offline">Play offline on this device</button>
  `, 'Pull up a chair. Eight games, five kinds of bots, and a chip bank that follows you from table to table.');

  const email = document.getElementById('auth-email') as HTMLInputElement;
  const pass = document.getElementById('auth-pass') as HTMLInputElement;
  (lastEmail ? pass : email).focus();
  email.oninput = () => (lastEmail = email.value.trim());

  app.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => (b.onclick = () => renderAuth(app, onReady, b.dataset.mode as 'signin' | 'signup')));
  const show = document.getElementById('pw-show') as HTMLButtonElement;
  show.onclick = () => {
    const on = pass.type === 'password';
    pass.type = on ? 'text' : 'password';
    show.textContent = on ? 'Hide' : 'Show';
    show.setAttribute('aria-pressed', String(on));
  };

  document.getElementById('auth-form')!.onsubmit = (e) => {
    e.preventDefault();
    const addr = email.value.trim();
    lastEmail = addr;
    busy(app, async () => {
      if (signup) {
        const session = await a.signUp(addr, pass.value, returnUrl());
        if (!session) return renderAuth(app, onReady, 'signin', `Almost there. We sent a link to ${addr}: open it, then sign in here.`);
      } else {
        await a.signIn(addr, pass.value);
      }
      await goOnline(onReady, app);
    });
  };
  document.getElementById('forgot')?.addEventListener('click', () => {
    const addr = email.value.trim();
    if (!addr || !email.checkValidity()) {
      document.getElementById('auth-error')!.textContent = 'Type your email above first, then click this again.';
      email.focus();
      return;
    }
    busy(app, async () => {
      await a.sendPasswordReset(addr, returnUrl());
      document.getElementById('auth-ok')!.textContent = `If there's an account for ${addr}, a link to reset the password is on its way.`;
    });
  });
  document.getElementById('play-offline')!.onclick = () => {
    store = local;
    void openPlayer(onReady, app);
  };
}

/** Shown when there are no players yet: a new account (or this device) picks a name and colour. */
export function renderWelcome(app: HTMLElement, onDone: () => void, suggestedName = '', settings: Record<string, unknown> = welcomeSettings) {
  let color = PROFILE_COLORS[0];
  const signedIn = isOnline() && auth?.current;
  app.innerHTML = authShell(`
    <div class="auth-head">
      <h2>Pick your name</h2>
      <p class="auth-sub">It's what the table calls you. You start with <b>${fmt(STARTING_BANK)}</b> chips.</p>
    </div>
    <form id="create-form" class="auth-form">
      <div class="name-row">
        <span class="pfp lg" id="name-pfp" style="--pfp:${color}" aria-hidden="true">${esc((suggestedName || '?').slice(0, 1).toUpperCase())}</span>
        <input id="new-name" class="text-input name-big" maxlength="${NAME_MAX}" placeholder="Your name" value="${esc(suggestedName)}" autocomplete="nickname" aria-label="Your name" required>
      </div>
      <div class="colors" role="group" aria-label="Badge colour">
        ${PROFILE_COLORS.map((c) => `<button type="button" class="swatch" data-color="${c}" style="--pfp:${c}" aria-pressed="${c === color}" aria-label="Colour ${c}"></button>`).join('')}
      </div>
      <button type="submit" class="btn btn-primary btn-lg auth-go">Deal me in</button>
    </form>
    <p class="form-error" id="form-error" role="alert"></p>
    <p class="fine auth-foot">${signedIn
      ? `Signed in as <b>${esc(auth!.current!.email)}</b>. <button type="button" class="link-btn plain" id="not-you">Not you?</button>`
      : `Saved in this browser only.${auth ? ' <button type="button" class="link-btn plain" id="to-auth">Sign in instead</button> ·' : ''} <label class="link-btn">Import a backup<input type="file" id="import-file" accept="application/json,.json" hidden></label>`}</p>
  `, 'One last thing before the cards come out.');

  const input = document.getElementById('new-name') as HTMLInputElement;
  const pfp = document.getElementById('name-pfp')!;
  input.focus();
  input.oninput = () => (pfp.textContent = (cleanName(input.value) || '?').slice(0, 1).toUpperCase());
  app.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) => (b.onclick = () => {
    color = b.dataset.color!;
    pfp.style.setProperty('--pfp', color);
    app.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  document.getElementById('create-form')!.onsubmit = (e) => {
    e.preventDefault();
    const name = cleanName(input.value);
    if (!name) return;
    busy(app, async () => {
      const p = createProfile(name, { color, settings });
      await store.put(p);
      await selectPlayer(p);
      onDone();
    });
  };
  document.getElementById('not-you')?.addEventListener('click', () => busy(app, () => signOutTo(app, onDone)));
  document.getElementById('to-auth')?.addEventListener('click', () => renderAuth(app, onDone));
  bindImport(onDone);
}

function bindImport(onDone: () => void) {
  const file = document.getElementById('import-file') as HTMLInputElement | null;
  if (!file) return;
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const p = importProfile(await readFile(f));
      await store.put(p);
      await selectPlayer(p);
      onDone();
    } catch (err) {
      document.getElementById('form-error')!.textContent = (err as Error).message;
    }
  };
}

/** Signs out and goes back to the sign-in screen. */
async function signOutTo(app: HTMLElement, onReady: () => void) {
  await savePlayer();
  await auth?.signOut();
  store = local;
  current = null;
  saveError = '';
  renderAuth(app, onReady);
}

// ---------- profile screen ----------

function statsHtml(p: Profile): string {
  const s = p.stats;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const fav = Object.entries(s.byVariant).sort((a, b) => b[1] - a[1])[0];
  const favName = fav ? VARIANTS[fav[0] as VariantId]?.name ?? fav[0] : '–';
  const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
  const ord = (n: number) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const tiles: [string, string, string?][] = [
    ['Hands played', fmt(s.hands)],
    ['Hands won', fmt(s.handsWon), pct(s.handsWon, s.hands)],
    ['Biggest pot', fmt(s.biggestPot)],
    ['Cash game result', signed(s.cashNet), `${fmt(s.cashSessions)} session${s.cashSessions === 1 ? '' : 's'}`],
    ['Tournaments won', fmt(s.tournamentWins), `of ${fmt(s.tournaments)} · ${fmt(s.tournamentCashes)} paid`],
    ['Best finish', s.bestFinish ? ord(s.bestFinish) : '–'],
    ['Peak bank', fmt(s.peakBank)],
    ['Favourite game', favName],
  ];
  return `<div class="stat-grid">${tiles
    .map(([label, value, sub]) => `<div class="stat"><span class="sl">${label}</span><b class="${label === 'Cash game result' ? (s.cashNet > 0 ? 'up' : s.cashNet < 0 ? 'down' : '') : ''}">${value}</b>${sub ? `<span class="ss">${sub}</span>` : ''}</div>`)
    .join('')}</div>`;
}

function achievementsStripHtml(p: Profile): string {
  const c = allCounters(p, serverAwards());
  const got = ACHIEVEMENTS.filter((a) => a.measure(c) >= a.goal).length;
  return `<button type="button" class="ach-strip" id="open-achievements">
    <span class="sl">Achievements</span>
    <b>${got} <span>of ${ACHIEVEMENTS.length}</span></b>
    <span class="bar" aria-hidden="true"><i style="width:${(got / ACHIEVEMENTS.length) * 100}%"></i></span>
    <span class="pb-more">${p.title ? 'See all and titles' : 'See all · pick a title'}</span>
  </button>`;
}

/** Player profile: stats, rename, refill, backup, and switching between players on this device. */
export async function renderProfile(app: HTMLElement, onBack: () => void, onAchievements?: () => void) {
  const p = player();
  const others = (await store.list().catch(() => [] as Profile[])).filter((x) => x.id !== p.id).sort((a, b) => b.updatedAt - a.updatedAt);
  const refillable = canRefill(p);
  app.innerHTML = `
  <main class="lobby profile-page">
    <div class="profile-top">
      <button type="button" class="btn" id="back">← Back to the tables</button>
    </div>
    <section class="panel profile-card">
      <div class="profile-head">
        ${avatarHtml(p, 'lg')}
        <div class="ph-text">
          <form id="rename-form" class="rename">
            <input id="rename" class="name-input" maxlength="${NAME_MAX}" value="${esc(p.name)}" aria-label="Player name" autocomplete="off">
            <button type="submit" class="btn btn-sm" id="rename-save" hidden>Save name</button>
          </form>
          ${titleHtml(currentTitle(), 'big')}
          <span class="since">Playing since ${new Date(p.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
        </div>
        <div class="bank-box">
          <span class="sl">Chip bank</span>
          <b>${fmt(p.bank)}</b>
          ${refillable ? `<button type="button" class="btn btn-primary btn-sm" id="refill">Refill to ${fmt(STARTING_BANK)}</button>` : `<span class="ss">Refill unlocks below ${fmt(REFILL_BELOW)}</span>`}
        </div>
      </div>
      <div class="colors" role="group" aria-label="Badge colour">
        ${PROFILE_COLORS.map((c) => `<button type="button" class="swatch" data-color="${c}" style="--pfp:${c}" aria-pressed="${c === p.color}" aria-label="Colour ${c}"></button>`).join('')}
      </div>
      ${statsHtml(p)}
      ${onAchievements ? achievementsStripHtml(p) : ''}
      <div class="profile-actions">
        <button type="button" class="btn btn-sm" id="export">Download backup</button>
        <button type="button" class="btn btn-sm danger" id="delete">Delete player</button>
      </div>
    </section>

    <section class="panel">
      <h2 class="step">${isOnline() ? 'Players in your account' : 'Players on this device'}</h2>
      <div class="player-list">
        ${others.map((o) => `<button type="button" class="player-row" data-switch="${esc(o.id)}">${avatarHtml(o)}<span class="pr-name">${esc(o.name)}</span><span class="pr-bank">${fmt(o.bank)} chips</span><span class="pr-go">Switch</span></button>`).join('')}
        ${others.length ? '' : `<p class="fine">Nobody else yet. Add a player for each person who plays${isOnline() ? '' : ' on this device'}.</p>`}
      </div>
      <form id="create-form" class="create-row">
        <input id="new-name" class="text-input" maxlength="${NAME_MAX}" placeholder="New player's name" autocomplete="off" required>
        <button type="submit" class="btn">Add player</button>
      </form>
      <p class="fine">${isOnline() ? 'These players are saved online and open on any device where you sign in.' : 'Players are saved in this browser only. Sign in below, or use a backup file, to move them to another device.'} <label class="link-btn">Import a backup<input type="file" id="import-file" accept="application/json,.json" hidden></label></p>
      <p class="form-error" id="form-error" role="alert"></p>
    </section>
    ${accountPanelHtml()}
  </main>`;

  const rerender = () => renderProfile(app, onBack, onAchievements);
  document.getElementById('back')!.onclick = onBack;
  const achBtn = document.getElementById('open-achievements');
  if (achBtn && onAchievements) achBtn.onclick = onAchievements;

  const rename = document.getElementById('rename') as HTMLInputElement;
  const renameSave = document.getElementById('rename-save')!;
  rename.oninput = () => (renameSave.hidden = cleanName(rename.value) === p.name || !cleanName(rename.value));
  document.getElementById('rename-form')!.onsubmit = async (e) => {
    e.preventDefault();
    const name = cleanName(rename.value);
    if (!name) return;
    p.name = name;
    await savePlayer();
    rerender();
  };

  document.getElementById('refill')?.addEventListener('click', async () => {
    refill(p);
    await savePlayer();
    rerender();
  });

  app.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) => (b.onclick = async () => {
    p.color = b.dataset.color!;
    await savePlayer();
    rerender();
  }));

  document.getElementById('export')!.onclick = () => {
    const safe = p.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'player';
    download(`backroom-poker-${safe}.json`, exportProfile(p));
  };

  const del = document.getElementById('delete') as HTMLButtonElement;
  del.onclick = async () => {
    if (del.dataset.armed !== '1') {
      del.dataset.armed = '1';
      del.textContent = `Delete ${p.name} for good?`;
      return;
    }
    await store.remove(p.id);
    const next = others[0] ?? null;
    await selectPlayer(next);
    if (next) rerender();
    else renderWelcome(app, onBack);
  };

  app.querySelectorAll<HTMLButtonElement>('[data-switch]').forEach((b) => (b.onclick = async () => {
    const next = await store.get(b.dataset.switch!);
    if (!next) return;
    await selectPlayer(next);
    onBack();
  }));

  const input = document.getElementById('new-name') as HTMLInputElement;
  document.getElementById('create-form')!.onsubmit = async (e) => {
    e.preventDefault();
    const name = cleanName(input.value);
    if (!name) return;
    const used = new Set([p.color, ...others.map((o) => o.color)]);
    const color = PROFILE_COLORS.find((c) => !used.has(c)) ?? PROFILE_COLORS[(others.length + 1) % PROFILE_COLORS.length];
    const np = createProfile(name, { color });
    await store.put(np);
    await selectPlayer(np);
    onBack();
  };
  bindImport(onBack);
  bindAccountPanel(app, onBack);
}

// ---------- online account (profile page) ----------

function accountPanelHtml(): string {
  if (!auth) return '';
  const s = auth.current;
  if (s && isOnline()) {
    return `<section class="panel account-panel">
      <h2 class="step">Online account</h2>
      <p>Signed in as <b>${esc(s.email)}</b>. Your players are saved online.</p>
      <div class="row-btns"><button type="button" class="btn btn-sm" id="sign-out">Sign out</button></div>
    </section>`;
  }
  if (s) {
    return `<section class="panel account-panel">
      <h2 class="step">Online account</h2>
      <p>Signed in as <b>${esc(s.email)}</b>, but the account server couldn't be reached, so you're using this device's players.</p>
      <div class="row-btns"><button type="button" class="btn btn-sm btn-primary" id="retry-online">Try again</button><button type="button" class="btn btn-sm" id="sign-out">Sign out</button></div>
      <p class="form-error" id="form-error" role="alert"></p>
    </section>`;
  }
  return `<section class="panel account-panel">
    <h2 class="step">Online account</h2>
    <p>You're playing offline. Sign in to keep your players on every device; the ones on this device come with you into a new account.</p>
    <div class="row-btns"><button type="button" class="btn btn-sm btn-primary" id="go-auth">Sign in or create an account</button></div>
  </section>`;
}

function bindAccountPanel(app: HTMLElement, onReady: () => void) {
  if (!auth) return;
  document.getElementById('sign-out')?.addEventListener('click', () => busy(app, () => signOutTo(app, onReady)));
  document.getElementById('go-auth')?.addEventListener('click', () => renderAuth(app, onReady));
  document.getElementById('retry-online')?.addEventListener('click', () => busy(app, async () => {
    await goOnline(onReady, app);
    const n = takeNotice();
    if (n) throw new Error(n);
  }));
}

/** After a password-reset link: the person is signed in and picks a new password. */
export function renderNewPassword(app: HTMLElement, onDone: () => void) {
  if (!auth) return onDone();
  const a = auth;
  app.innerHTML = authShell(`
    <div class="auth-head">
      <h2>New password</h2>
      <p class="auth-sub">Choose a new password for <b>${esc(a.current?.email ?? 'your account')}</b>.</p>
    </div>
    <form id="pw-form" class="auth-form">
      <label class="auth-field"><span>New password</span>
        <input id="new-pass" class="text-input" type="password" minlength="6" placeholder="At least 6 characters" autocomplete="new-password" required>
      </label>
      <button type="submit" class="btn btn-primary btn-lg auth-go">Save and play</button>
    </form>
    <p class="form-error" id="auth-error" role="alert"></p>
  `, 'Locked out? Not for long.');
  const input = document.getElementById('new-pass') as HTMLInputElement;
  input.focus();
  document.getElementById('pw-form')!.onsubmit = (e) => {
    e.preventDefault();
    busy(app, async () => {
      await a.setPassword(input.value);
      onDone();
    });
  };
}
