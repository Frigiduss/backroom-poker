import {
  ACHIEVEMENTS, Achievement, AccountStore, Counters, Factor, KeyValueStorage, LocalAccountStore, NAME_MAX, OnlineAccountStore, OnlineAuth, PASSWORD_MIN, PROFILE_COLORS, Profile, REFILL_BELOW, STARTING_BANK,
  BonusClaim, allCounters, applyBonus, canRefill, claimLocally, claimOnlineBonus, cleanName, createProfile, newId, refill, settleOpenTable,
  takeUnlocks, titleFor, FACES, OnlineError, avatarLook, clearOldPictures, deletePicture, pictureKey, uploadPicture,
} from '../accounts';
import { faceHtml, installFaceFallback } from './faces';
import { shrinkPicture } from './picture';
import { VARIANTS, VariantId } from '../engine/variants';
import { makeCard } from '../engine/cards';
import { cardHtml, esc, fmt, titleHtml } from './dom';
import { applyLook } from './looks';
import { loadHands } from './history';
import { historyNet } from '../engine/history';

// ---------- the signed-in player ----------

let local: LocalAccountStore;
let auth: OnlineAuth | null = null;
let storage: KeyValueStorage | null = null;
let store: AccountStore;
let current: Profile | null = null;
let saving: Promise<void> = Promise.resolve();
/** Why the last online save failed, shown on the lobby badge until a save succeeds. */
let saveError = '';
/** A one-off message for the lobby, such as falling back to this device's player. */
let notice = '';

/** Sets up where players are kept. `onlineAuth` is null when online accounts aren't configured. */
export function initAccounts(localStore: LocalAccountStore, onlineAuth: OnlineAuth | null, kv: KeyValueStorage | null) {
  local = localStore;
  auth = onlineAuth;
  installFaceFallback();
  storage = kv;
  store = local;
}

/** Settings from before accounts existed, given to the first player created. */
let welcomeSettings: Record<string, unknown> = {};
export function setWelcomeSettings(settings: Record<string, unknown>) {
  welcomeSettings = settings;
}

export const isOnline = (): boolean => store.kind === 'online';

export function setNotice(text: string) {
  notice = text;
}

export function takeNotice(): string {
  const n = notice;
  notice = '';
  return n;
}

/**
 * Opens the player for the current store (one per account, or one on this device), or the
 * welcome screen when there is none yet. Older saves from when an account could hold several
 * players open the one played last. Any chips left at a table by a closed tab are settled first.
 */
export async function openPlayer(onReady: () => void, app: HTMLElement) {
  let players: Profile[];
  try {
    players = await store.list();
  } catch (err) {
    if (!isOnline()) throw err;
    notice = `${(err as Error).message} You're playing with the player saved on this device.`;
    store = local;
    players = await store.list();
  }
  const id = await store.currentId();
  const p = players.find((x) => x.id === id) ?? players.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  if (!p) {
    current = null;
    applyLook(null, {});
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
 * Switches to the signed-in account's player. A brand-new account gets a copy of the
 * player on this device, so nobody starts over when they first sign in.
 */
export async function goOnline(onReady: () => void, app: HTMLElement) {
  if (!auth?.current) return openPlayer(onReady, app);
  // An account with an authenticator app needs its code before anything opens. (If the check
  // can't reach the server, the database still refuses a sign-in that skipped the code.)
  const second = await auth.secondStepFactor().catch(() => null);
  if (second) return renderSecondStep(app, onReady, second);
  const online = new OnlineAccountStore(auth, storage);
  store = online;
  try {
    const existing = await online.list();
    if (!existing.length) {
      const here = await local.list();
      const id = await local.currentId();
      const p = here.find((x) => x.id === id) ?? here.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (p) {
        settleOpenTable(p);
        await online.put({ ...p, id: newId() });
      }
    }
  } catch (err) {
    store = local;
    notice = `${(err as Error).message} You're playing with the player saved on this device.`;
  }
  return openPlayer(onReady, app);
}

export function player(): Profile {
  if (!current) throw new Error('No player selected');
  return current;
}


export async function selectPlayer(p: Profile | null) {
  current = p;
  applyLook(p, serverAwards());
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
  // A felt unlocked online only counts once the table server's progress is in.
  applyLook(p, serverAwards());
  const fresh = takeUnlocks(p, serverAwards());
  if (fresh.length) await savePlayer();
  return fresh;
}

/** The current player's chosen title, if they still hold it. */
export const currentTitle = (): string | null => (current ? titleFor(current.title, allCounters(current, serverAwards())) : null);

/** Sign-in for reading the leaderboard, or null when online accounts aren't configured. */
export const onlineAuth = (): OnlineAuth | null => auth;

/**
 * Collects the current player's daily bonus. Online players ask the server, which keeps the
 * claim time; players on this device go by the browser's clock.
 */
export async function claimDailyBonus(): Promise<BonusClaim> {
  const p = player();
  let claim: BonusClaim;
  if (store instanceof OnlineAccountStore && auth) {
    claim = await claimOnlineBonus(auth, p.id);
    if (current !== p) return claim;
    applyBonus(p, claim);
  } else claim = claimLocally(p);
  await savePlayer();
  return claim;
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

export const avatarHtml = (p: Profile, cls = '') => faceHtml(p, cls);

/** The lobby's player badge: who is playing and what is in their bank. */
export function playerBadgeHtml(): string {
  const p = player();
  return `<button type="button" class="player-badge" id="open-profile" title="Your profile and stats">
    ${avatarHtml(p)}
    <span class="pb-text"><b>${esc(p.name)}${titleHtml(currentTitle())}</b><span>Bank <em>${fmt(p.bank)}</em>${saveError ? ' · <i class="unsaved" title="' + esc(saveError) + '">not saved online</i>' : ''}</span></span>
    <span class="pb-more">Profile</span>
  </button>`;
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
          <input id="auth-pass" class="text-input" type="password" ${signup ? `minlength="${PASSWORD_MIN}" placeholder="At least ${PASSWORD_MIN} characters"` : ''} autocomplete="${signup ? 'new-password' : 'current-password'}" required>
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

/** The second step of signing in: a code from the authenticator app. */
export function renderSecondStep(app: HTMLElement, onReady: () => void, factor: Factor) {
  if (!auth) return void openPlayer(onReady, app);
  const a = auth;
  app.innerHTML = authShell(`
    <div class="auth-head">
      <h2>Two-step sign-in</h2>
      <p class="auth-sub">Open your authenticator app and type the 6-digit code for <b>Back Room Poker</b>${a.current?.email ? ` (${esc(a.current.email)})` : ''}.</p>
    </div>
    <form id="code-form" class="auth-form">
      <label class="auth-field"><span>Code</span>
        <input id="mfa-code" class="text-input mfa-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="123456" required>
      </label>
      <button type="submit" class="btn btn-primary btn-lg auth-go">Sign in</button>
    </form>
    <p class="form-error" id="auth-error" role="alert"></p>
    <p class="fine auth-foot">Lost your phone? Ask the site's admin to remove two-step sign-in from your account. <button type="button" class="link-btn plain" id="not-you">Use a different account</button></p>
  `, 'One more check that it\'s really you.');
  const code = document.getElementById('mfa-code') as HTMLInputElement;
  code.focus();
  document.getElementById('code-form')!.onsubmit = (e) => {
    e.preventDefault();
    busy(app, async () => {
      await a.verifyTotp(factor.id, code.value);
      await goOnline(onReady, app);
    });
  };
  document.getElementById('not-you')!.onclick = () => busy(app, () => signOutTo(app, onReady));
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
      : `Saved in this browser only.${auth ? ' <button type="button" class="link-btn plain" id="to-auth">Sign in instead</button>' : ''}`}</p>
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
}

/** Signs out and goes back to the sign-in screen. */
async function signOutTo(app: HTMLElement, onReady: () => void) {
  await savePlayer();
  await auth?.signOut();
  store = local;
  current = null;
  applyLook(null, {});
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
  const c = p.achievements.counters;
  if (c['bj.hands']) tiles.push(['Blackjack result', signed(c['bj.net'] ?? 0), `${fmt(c['bj.hands'])} hand${c['bj.hands'] === 1 ? '' : 's'} · ${fmt(c['bj.naturals'] ?? 0)} blackjack${c['bj.naturals'] === 1 ? '' : 's'}`]);
  return `<div class="stat-grid">${tiles
    .map(([label, value, sub]) => `<div class="stat"><span class="sl">${label}</span><b class="${label.endsWith(' result') ? (value.startsWith('+') ? 'up' : value.startsWith('-') ? 'down' : '') : ''}">${value}</b>${sub ? `<span class="ss">${sub}</span>` : ''}</div>`)
    .join('')}</div>`;
}

/** A link to the stats page with a tiny chip graph of the last 30 points. */
function statsStripHtml(p: Profile): string {
  const pts = p.history.slice(-30).map((x) => x[1]);
  const lo = Math.min(...pts);
  const span = Math.max(...pts) - lo || 1;
  const line = pts.length > 1
    ? pts.map((v, k) => `${k ? 'L' : 'M'}${((k / (pts.length - 1)) * 96 + 2).toFixed(1)},${(26 - ((v - lo) / span) * 22).toFixed(1)}`).join('')
    : 'M2,15L98,15';
  return `<button type="button" class="ach-strip stats-strip" id="open-stats">
    <span class="sl">Stats</span>
    <svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path d="${line}"/></svg>
    <span class="pb-more">Chip graph · VPIP, raise rate, style</span>
  </button>`;
}

/** A link to the hand history, with how many hands are saved and the latest result. */
function historyStripHtml(p: Profile): string {
  const hands = loadHands(p.id);
  const net = hands[0] ? historyNet(hands[0]) : 0;
  const last = hands[0] ? `Last hand <span class="${net > 0 ? 'up' : net < 0 ? 'down' : ''}">${net > 0 ? '+' : net < 0 ? '−' : ''}${fmt(Math.abs(net))}</span>` : 'Nothing yet';
  return `<button type="button" class="ach-strip history-strip" id="open-history">
    <span class="sl">Hand history</span>
    <b>${hands.length} <span>hand${hands.length === 1 ? '' : 's'} saved</span></b>
    <span class="pb-more">${last} · replay any hand street by street</span>
  </button>`;
}

function achievementsStripHtml(p: Profile): string {
  const c = allCounters(p, serverAwards());
  const got = ACHIEVEMENTS.filter((a) => a.measure(c) >= a.goal).length;
  return `<button type="button" class="ach-strip" id="open-achievements">
    <span class="sl">Achievements</span>
    <b>${got} <span>of ${ACHIEVEMENTS.length}</span></b>
    <span class="bar" aria-hidden="true"><i style="width:${(got / ACHIEVEMENTS.length) * 100}%"></i></span>
    <span class="pb-more">See all · titles, felts and card backs</span>
  </button>`;
}

/** Player profile: stats, name, colour, refill, and the online account. */
export async function renderProfile(app: HTMLElement, onBack: () => void, onAchievements?: () => void, onStats?: () => void, onHistory?: () => void) {
  const p = player();
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
      ${facePickerHtml(p)}
      ${statsHtml(p)}
      ${onStats ? statsStripHtml(p) : ''}
      ${onHistory ? historyStripHtml(p) : ''}
      ${onAchievements ? achievementsStripHtml(p) : ''}
    </section>
    ${accountPanelHtml()}
  </main>`;

  const rerender = () => renderProfile(app, onBack, onAchievements, onStats, onHistory);
  document.getElementById('back')!.onclick = onBack;
  const achBtn = document.getElementById('open-achievements');
  if (achBtn && onAchievements) achBtn.onclick = onAchievements;
  const statsBtn = document.getElementById('open-stats');
  if (statsBtn && onStats) statsBtn.onclick = onStats;
  const historyBtn = document.getElementById('open-history');
  if (historyBtn && onHistory) historyBtn.onclick = onHistory;

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

  bindFacePicker(app, p, rerender);
  bindAccountPanel(app, onBack);
}

// ---------- faces (profile page) ----------

/** Keeps the face picker open across the redraw after a pick. */
let faceOpen = false;

function facePickerHtml(p: Profile): string {
  const look = avatarLook(p.avatar);
  const canUpload = !!auth && isOnline();
  const letter = esc((p.name || '?').slice(0, 1).toUpperCase());
  return `<details class="face-pick" id="face-pick"${faceOpen ? ' open' : ''}>
    <summary>Change your face</summary>
    <div class="face-grid" role="group" aria-label="Face">
      <button type="button" class="face-opt letter" data-face="" style="--pfp:${esc(p.color)}" aria-pressed="${look.kind === 'letter'}" aria-label="Your first letter" title="Your first letter">${letter}</button>
      ${FACES.map((f) => `<button type="button" class="face-opt" data-face="f:${f.id}" aria-pressed="${look.kind === 'face' && look.face.id === f.id}" aria-label="${f.name}" title="${f.name}">${f.emoji}</button>`).join('')}
    </div>
    <div class="face-upload">
      ${canUpload ? `<label class="btn btn-sm${look.kind === 'picture' ? '' : ' btn-primary'}" id="face-upload-btn">${look.kind === 'picture' ? 'Upload a different picture' : 'Upload a picture'}<input type="file" id="face-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
        ${look.kind === 'picture' ? '<button type="button" class="btn btn-sm" id="face-remove">Remove picture</button>' : ''}
        <p class="fine">Cropped to a square and shrunk. Everyone at your online tables, on the leaderboard and in your friends list can see it, so keep it friendly.</p>`
        : `<p class="fine">${auth ? 'Sign in to an online account to upload your own picture.' : 'Pick a face for your badge.'}</p>`}
      <p class="form-error" id="face-error" role="alert"></p>
    </div>
  </details>`;
}

function bindFacePicker(app: HTMLElement, p: Profile, rerender: () => void) {
  const box = document.getElementById('face-pick') as HTMLDetailsElement | null;
  if (!box) return;
  box.ontoggle = () => (faceOpen = box.open);
  const err = (msg: string) => {
    const el = document.getElementById('face-error');
    if (el) el.textContent = msg;
  };
  /** Sets the face, saves, and then deletes the picture it replaced. */
  const setFace = async (value: string | null) => {
    const old = pictureKey(p.avatar);
    p.avatar = value;
    p.updatedAt = Date.now();
    await savePlayer();
    if (old && old !== pictureKey(value) && auth) void deletePicture(auth, old);
    rerender();
  };
  app.querySelectorAll<HTMLButtonElement>('[data-face]').forEach((b) => (b.onclick = () => void setFace(b.dataset.face || null)));
  document.getElementById('face-remove')?.addEventListener('click', () => void setFace(null));
  const file = document.getElementById('face-file') as HTMLInputElement | null;
  if (file && auth) file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f || !auth) return;
    const btn = document.getElementById('face-upload-btn');
    btn?.classList.add('busy');
    err('');
    try {
      const jpeg = await shrinkPicture(f);
      let value: string;
      try {
        value = await uploadPicture(auth, jpeg);
      } catch (e) {
        // Too many old pictures left behind (a save that never landed, another device): clear them and try once more.
        if (!(e instanceof OnlineError && e.status === 403) || !(await clearOldPictures(auth, pictureKey(p.avatar)))) throw e;
        value = await uploadPicture(auth, jpeg);
      }
      await setFace(value);
    } catch (e) {
      btn?.classList.remove('busy');
      err((e as Error).message);
    }
  };
}

// ---------- online account (profile page) ----------

function accountPanelHtml(): string {
  if (!auth) return '';
  const s = auth.current;
  if (s && isOnline()) {
    return `<section class="panel account-panel">
      <h2 class="step">Online account</h2>
      <p>Signed in as <b>${esc(s.email)}</b>. Your chips and stats are saved online.</p>
      <div class="row-btns"><button type="button" class="btn btn-sm" id="sign-out">Sign out</button></div>
    </section>
    <section class="panel account-panel" id="security-panel">
      <h2 class="step">Account security</h2>
      <div id="security-body"><p class="fine">Checking…</p></div>
      <p class="form-ok" id="form-ok" role="status"></p>
      <p class="form-error" id="form-error" role="alert"></p>
    </section>`;
  }
  if (s) {
    return `<section class="panel account-panel">
      <h2 class="step">Online account</h2>
      <p>Signed in as <b>${esc(s.email)}</b>, but the account server couldn't be reached, so you're using this device's player.</p>
      <div class="row-btns"><button type="button" class="btn btn-sm btn-primary" id="retry-online">Try again</button><button type="button" class="btn btn-sm" id="sign-out">Sign out</button></div>
      <p class="form-error" id="form-error" role="alert"></p>
    </section>`;
  }
  return `<section class="panel account-panel">
    <h2 class="step">Online account</h2>
    <p>You're playing offline. Sign in to keep your chips and stats on every device; the player on this device comes with you into a new account.</p>
    <div class="row-btns"><button type="button" class="btn btn-sm btn-primary" id="go-auth">Sign in or create an account</button></div>
  </section>`;
}

function bindAccountPanel(app: HTMLElement, onReady: () => void) {
  if (!auth) return;
  if (document.getElementById('security-panel')) void renderSecurity(app, onReady);
  document.getElementById('sign-out')?.addEventListener('click', () => busy(app, () => signOutTo(app, onReady)));
  document.getElementById('go-auth')?.addEventListener('click', () => renderAuth(app, onReady));
  document.getElementById('retry-online')?.addEventListener('click', () => busy(app, async () => {
    await goOnline(onReady, app);
    const n = takeNotice();
    if (n) throw new Error(n);
  }));
}

// ---------- account security (profile page) ----------

const passwordField = (id: string, label: string) => `<label class="auth-field"><span>${label}</span>
  <input id="${id}" class="text-input" type="password" minlength="${PASSWORD_MIN}" placeholder="At least ${PASSWORD_MIN} characters" autocomplete="new-password" required>
</label>`;

const codeField = (id: string) => `<label class="auth-field"><span>Code from the app</span>
  <input id="${id}" class="text-input mfa-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="123456" required>
</label>`;

/** Two-step sign-in, a new password, and signing out on every device. */
async function renderSecurity(app: HTMLElement, onReady: () => void, view: 'main' | 'password' | 'setup' | 'off' = 'main', okText = '') {
  const a = auth;
  const body = document.getElementById('security-body');
  if (!a || !body) return;
  const ok = document.getElementById('form-ok')!;
  const err = document.getElementById('form-error')!;
  ok.textContent = okText;
  err.textContent = '';
  let factor: Factor | undefined;
  try {
    factor = (await a.factors()).find((f) => f.verified);
  } catch (e) {
    body.innerHTML = '';
    err.textContent = (e as Error).message;
    return;
  }
  if (!body.isConnected) return;
  const again = (v: typeof view, msg = '') => renderSecurity(app, onReady, v, msg);

  if (view === 'setup') {
    const setup = await a.enrollTotp().catch((e: Error) => {
      err.textContent = e.message;
      return null;
    });
    if (!setup || !body.isConnected) return;
    body.innerHTML = `<div class="mfa-setup">
        ${setup.qr ? `<img class="mfa-qr" src="${esc(setup.qr)}" alt="QR code for your authenticator app" width="180" height="180">` : ''}
        <div class="mfa-steps">
          <p>1. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) and scan this code.</p>
          <p>Can't scan? Add it by hand with this key: <code class="mfa-secret">${esc(setup.secret.replace(/(.{4})/g, '$1 ').trim())}</code></p>
          <p>2. Type the 6-digit code it shows.</p>
          <form id="mfa-on" class="auth-form">
            ${codeField('mfa-code')}
            <div class="row-btns"><button type="submit" class="btn btn-sm btn-primary">Turn on</button><button type="button" class="btn btn-sm" id="sec-cancel">Cancel</button></div>
          </form>
        </div>
      </div>`;
    document.getElementById('mfa-on')!.onsubmit = (e) => {
      e.preventDefault();
      const code = (document.getElementById('mfa-code') as HTMLInputElement).value;
      busy(app, async () => {
        await a.verifyTotp(setup.id, code);
        await again('main', 'Two-step sign-in is on. Next time you sign in, have your phone handy.');
      });
    };
  } else if (view === 'off' && factor) {
    const f = factor;
    body.innerHTML = `<form id="mfa-off" class="auth-form">
        <p>To turn off two-step sign-in, type a code from your authenticator app.</p>
        ${codeField('mfa-code')}
        <div class="row-btns"><button type="submit" class="btn btn-sm">Turn off</button><button type="button" class="btn btn-sm" id="sec-cancel">Cancel</button></div>
      </form>`;
    document.getElementById('mfa-off')!.onsubmit = (e) => {
      e.preventDefault();
      const code = (document.getElementById('mfa-code') as HTMLInputElement).value;
      busy(app, async () => {
        await a.removeTotp(f.id, code);
        await again('main', 'Two-step sign-in is off.');
      });
    };
  } else if (view === 'password') {
    body.innerHTML = `<form id="pw-change" class="auth-form">
        ${passwordField('new-pass', 'New password')}
        ${passwordField('new-pass2', 'Type it again')}
        <div class="row-btns"><button type="submit" class="btn btn-sm btn-primary">Save password</button><button type="button" class="btn btn-sm" id="sec-cancel">Cancel</button></div>
      </form>`;
    document.getElementById('pw-change')!.onsubmit = (e) => {
      e.preventDefault();
      const pw = (document.getElementById('new-pass') as HTMLInputElement).value;
      if (pw !== (document.getElementById('new-pass2') as HTMLInputElement).value) {
        err.textContent = "The two passwords don't match.";
        return;
      }
      busy(app, async () => {
        await a.setPassword(pw);
        await again('main', 'Password changed.');
      });
    };
  } else {
    body.innerHTML = `<div class="sec-rows">
        <div class="sec-row">
          <div><b>Two-step sign-in</b> <span class="sec-pill ${factor ? 'on' : ''}">${factor ? 'On' : 'Off'}</span>
            <p>${factor ? 'Signing in asks for a code from your authenticator app as well as your password.' : 'Ask for a code from an authenticator app on your phone as well as your password, so a stolen password alone can\'t get in.'}</p></div>
          <button type="button" class="btn btn-sm ${factor ? '' : 'btn-primary'}" id="mfa-toggle">${factor ? 'Turn off' : 'Set up'}</button>
        </div>
        <div class="sec-row">
          <div><b>Password</b><p>Use one you don't use anywhere else.</p></div>
          <button type="button" class="btn btn-sm" id="pw-open">Change password</button>
        </div>
        <div class="sec-row">
          <div><b>Signed in somewhere else?</b><p>Signs this account out on every device, including this one.</p></div>
          <button type="button" class="btn btn-sm" id="sign-out-all">Sign out everywhere</button>
        </div>
      </div>`;
    document.getElementById('mfa-toggle')!.onclick = () => again(factor ? 'off' : 'setup');
    document.getElementById('pw-open')!.onclick = () => again('password');
    document.getElementById('sign-out-all')!.onclick = () => {
      if (!confirm('Sign out on every device? You\'ll need to sign in again here too.')) return;
      busy(app, async () => {
        await savePlayer();
        await a.signOutEverywhere();
        store = local;
        current = null;
        applyLook(null, {});
        saveError = '';
        renderAuth(app, onReady, 'signin', 'Signed out on every device.');
      });
    };
  }
  document.getElementById('sec-cancel')?.addEventListener('click', () => again('main'));
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
        <input id="new-pass" class="text-input" type="password" minlength="${PASSWORD_MIN}" placeholder="At least ${PASSWORD_MIN} characters" autocomplete="new-password" required>
      </label>
      <div id="reset-code" hidden>${codeField('mfa-code')}</div>
      <button type="submit" class="btn btn-primary btn-lg auth-go">Save and play</button>
    </form>
    <p class="form-error" id="auth-error" role="alert"></p>
  `, 'Locked out? Not for long.');
  const input = document.getElementById('new-pass') as HTMLInputElement;
  input.focus();
  // A reset link only proves the email; an account with two-step sign-in needs its code too.
  const codeBox = document.getElementById('reset-code')!;
  const codeInput = document.getElementById('mfa-code') as HTMLInputElement;
  codeInput.required = false;
  let factor: Factor | null = null;
  void a.secondStepFactor().then((f) => {
    factor = f;
    codeBox.hidden = !f;
    codeInput.required = !!f;
  }).catch(() => undefined);
  document.getElementById('pw-form')!.onsubmit = (e) => {
    e.preventDefault();
    busy(app, async () => {
      if (factor) await a.verifyTotp(factor.id, codeInput.value);
      await a.setPassword(input.value);
      onDone();
    });
  };
}
