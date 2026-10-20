import {
  AccountStore, NAME_MAX, PROFILE_COLORS, Profile, REFILL_BELOW, STARTING_BANK,
  canRefill, cleanName, createProfile, exportProfile, importProfile, refill,
} from '../accounts';
import { VARIANTS, VariantId } from '../engine/variants';
import { esc, fmt } from './dom';

// ---------- the signed-in player ----------

let store: AccountStore;
let current: Profile | null = null;
let saving: Promise<void> = Promise.resolve();

export function initAccounts(s: AccountStore) {
  store = s;
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
  saving = saving.then(() => store.put(snapshot)).catch(() => undefined);
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
    <span class="pb-text"><b>${esc(p.name)}</b><span>Bank <em>${fmt(p.bank)}</em></span></span>
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
export function renderWelcome(app: HTMLElement, onDone: () => void, suggestedName = '', settings: Record<string, unknown> = {}) {
  app.innerHTML = `
  <main class="lobby welcome">
    <section class="panel welcome-card">
      <span class="eyebrow">Back Room Poker</span>
      <h1>Who's playing?</h1>
      <p>Your player keeps a chip bank between games, tracks your record, and remembers your table settings. You start with <b>${fmt(STARTING_BANK)}</b> chips.</p>
      <form id="create-form" class="create-row">
        <input id="new-name" class="text-input" maxlength="${NAME_MAX}" placeholder="Your name" value="${esc(suggestedName)}" autocomplete="off" required>
        <button type="submit" class="btn btn-primary">Create player</button>
      </form>
      <p class="fine">Players are saved in this browser. Have a backup file from another device? <label class="link-btn">Import it<input type="file" id="import-file" accept="application/json,.json" hidden></label></p>
      <p class="form-error" id="form-error" role="alert"></p>
    </section>
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
  const others = (await store.list()).filter((x) => x.id !== p.id).sort((a, b) => b.updatedAt - a.updatedAt);
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
      <h2 class="step">Players on this device</h2>
      <div class="player-list">
        ${others.map((o) => `<button type="button" class="player-row" data-switch="${esc(o.id)}">${avatarHtml(o)}<span class="pr-name">${esc(o.name)}</span><span class="pr-bank">${fmt(o.bank)} chips</span><span class="pr-go">Switch</span></button>`).join('')}
        ${others.length ? '' : '<p class="fine">Nobody else yet. Add a player for each person who plays on this device.</p>'}
      </div>
      <form id="create-form" class="create-row">
        <input id="new-name" class="text-input" maxlength="${NAME_MAX}" placeholder="New player's name" autocomplete="off" required>
        <button type="submit" class="btn">Add player</button>
      </form>
      <p class="fine">Players are saved in this browser only. Use a backup file to move one to another device. <label class="link-btn">Import a backup<input type="file" id="import-file" accept="application/json,.json" hidden></label></p>
      <p class="form-error" id="form-error" role="alert"></p>
    </section>
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
}
