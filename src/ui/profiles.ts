import {
  AccountStore, KeyValueStorage, LocalAccountStore, NAME_MAX, OnlineAccountStore, OnlineAuth, PROFILE_COLORS, Profile, REFILL_BELOW, STARTING_BANK,
  canRefill, cleanName, createProfile, exportProfile, importProfile, newId, refill, settleOpenTable,
} from '../accounts';
import { VARIANTS, VariantId } from '../engine/variants';
import { esc, fmt } from './dom';

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
    <span class="pb-text"><b>${esc(p.name)}</b><span>Bank <em>${fmt(p.bank)}</em>${saveError ? ' · <i class="unsaved" title="' + esc(saveError) + '">not saved online</i>' : ''}</span></span>
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

// ---------- first visit ----------

/** Shown when there are no players yet. */
export function renderWelcome(app: HTMLElement, onDone: () => void, suggestedName = '', settings: Record<string, unknown> = welcomeSettings) {
  app.innerHTML = `
  <main class="lobby welcome">
    <section class="panel welcome-card">
      <span class="eyebrow">Back Room Poker</span>
      ${(() => {
        const n = takeNotice();
        return n ? `<p class="notice" role="status">${esc(n)}</p>` : '';
      })()}
      <h1>Who's playing?</h1>
      <p>Your player keeps a chip bank between games, tracks your record, and remembers your table settings. You start with <b>${fmt(STARTING_BANK)}</b> chips.</p>
      <form id="create-form" class="create-row">
        <input id="new-name" class="text-input" maxlength="${NAME_MAX}" placeholder="Your name" value="${esc(suggestedName)}" autocomplete="off" required>
        <button type="submit" class="btn btn-primary">Create player</button>
      </form>
      <p class="fine">${isOnline() ? `Saved to your online account (${esc(auth?.current?.email ?? '')}).` : 'Players are saved in this browser.'} Have a backup file? <label class="link-btn">Import it<input type="file" id="import-file" accept="application/json,.json" hidden></label></p>
      <p class="form-error" id="form-error" role="alert"></p>
    </section>
    ${accountPanelHtml('Already have an online account? Sign in to get your players back.')}
  </main>`;
  const input = document.getElementById('new-name') as HTMLInputElement;
  input.focus();
  document.getElementById('create-form')!.onsubmit = async (e) => {
    e.preventDefault();
    const name = cleanName(input.value);
    if (!name) return;
    const p = createProfile(name, { color: PROFILE_COLORS[0], settings });
    await store.put(p);
    await selectPlayer(p);
    onDone();
  };
  bindImport(onDone);
  bindAccountPanel(app, onDone);
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

/** Player profile: stats, rename, refill, backup, and switching between players on this device. */
export async function renderProfile(app: HTMLElement, onBack: () => void) {
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
    ${accountPanelHtml('Sign in to keep your players on every device you play on.')}
  </main>`;

  const rerender = () => renderProfile(app, onBack);
  document.getElementById('back')!.onclick = onBack;

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

// ---------- online account ----------

function accountPanelHtml(pitch: string): string {
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
      <p class="form-error" id="account-error" role="alert"></p>
    </section>`;
  }
  return `<section class="panel account-panel">
    <h2 class="step">Online account</h2>
    <p>${pitch}</p>
    <form id="account-form" class="account-form">
      <input id="acct-email" class="text-input" type="email" placeholder="Email" autocomplete="email" required>
      <input id="acct-pass" class="text-input" type="password" placeholder="Password (6+ characters)" autocomplete="current-password" minlength="6" required>
      <div class="row-btns">
        <button type="submit" class="btn btn-primary btn-sm" id="sign-in">Sign in</button>
        <button type="button" class="btn btn-sm" id="sign-up">Create account</button>
        <button type="button" class="link-btn plain" id="forgot">Forgot password?</button>
      </div>
    </form>
    <p class="form-ok" id="account-ok" role="status"></p>
    <p class="form-error" id="account-error" role="alert"></p>
  </section>`;
}

/** Where links in account emails send people back to: this page, without any old hash. */
const returnUrl = () => location.href.split('#')[0];

function bindAccountPanel(app: HTMLElement, onReady: () => void) {
  if (!auth) return;
  const a = auth;
  const err = document.getElementById('account-error');
  const ok = document.getElementById('account-ok');
  const say = (msg: string, good = false) => {
    if (err) err.textContent = good ? '' : msg;
    if (ok) ok.textContent = good ? msg : '';
  };
  const busy = async (fn: () => Promise<void>) => {
    const btns = app.querySelectorAll<HTMLButtonElement>('.account-panel button');
    btns.forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      say((e as Error).message);
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  };

  document.getElementById('sign-out')?.addEventListener('click', () => busy(async () => {
    await savePlayer();
    await a.signOut();
    store = local;
    saveError = '';
    await openPlayer(onReady, app);
  }));
  document.getElementById('retry-online')?.addEventListener('click', () => busy(async () => {
    await goOnline(onReady, app);
    const n = takeNotice();
    if (n) throw new Error(n);
  }));

  const form = document.getElementById('account-form') as HTMLFormElement | null;
  if (!form) return;
  const email = document.getElementById('acct-email') as HTMLInputElement;
  const pass = document.getElementById('acct-pass') as HTMLInputElement;
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(async () => {
      await savePlayer();
      await a.signIn(email.value.trim(), pass.value);
      await goOnline(onReady, app);
    });
  };
  document.getElementById('sign-up')!.onclick = () => {
    if (!form.reportValidity()) return;
    busy(async () => {
      await savePlayer();
      const session = await a.signUp(email.value.trim(), pass.value, returnUrl());
      if (!session) return say(`Almost there: we sent a link to ${email.value.trim()}. Open it to finish creating your account.`, true);
      await goOnline(onReady, app);
    });
  };
  document.getElementById('forgot')!.onclick = () => {
    if (!email.reportValidity()) return;
    busy(async () => {
      await a.sendPasswordReset(email.value.trim(), returnUrl());
      say(`If there's an account for ${email.value.trim()}, a link to reset the password is on its way.`, true);
    });
  };
}

/** After a password-reset link: the person is signed in and picks a new password. */
export function renderNewPassword(app: HTMLElement, onDone: () => void) {
  if (!auth) return onDone();
  const a = auth;
  app.innerHTML = `
  <main class="lobby welcome">
    <section class="panel welcome-card">
      <span class="eyebrow">Back Room Poker</span>
      <h1>New password</h1>
      <p>Choose a new password for ${esc(a.current?.email ?? 'your account')}.</p>
      <form id="pw-form" class="create-row">
        <input id="new-pass" class="text-input" type="password" minlength="6" placeholder="New password" autocomplete="new-password" required>
        <button type="submit" class="btn btn-primary">Save password</button>
      </form>
      <p class="form-error" id="form-error" role="alert"></p>
    </section>
  </main>`;
  const input = document.getElementById('new-pass') as HTMLInputElement;
  input.focus();
  document.getElementById('pw-form')!.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await a.setPassword(input.value);
      onDone();
    } catch (err) {
      document.getElementById('form-error')!.textContent = (err as Error).message;
    }
  };
}
