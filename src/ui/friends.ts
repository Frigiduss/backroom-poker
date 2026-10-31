// Friends: the friends page (your friend code, requests, who's online), the lobby button, invite
// pop-ups, and the one-tap invite list at an online table. The server side is
// supabase/friends.sql; while the game is open it checks in every 20 seconds, which is what
// shows this account as online to its friends.
import {
  ACHIEVEMENT_BY_ID, Friend, FriendCard, FriendsNotSetUpError, FriendsState, OnlineAuth, OnlineError, TableInvite,
  addFriend, answerFriend, cleanFriendCode, dismissInvite, inviteFriend, removeFriend, seenText, syncFriends,
} from '../accounts';
import { esc, titleHtml } from './dom';
import { isOnline } from './profiles';
import { play } from './sound';

interface Hooks {
  app: HTMLElement;
  auth: OnlineAuth | null;
  /** Back to the game menu. */
  lobby: () => void;
  /** A game against bots or the house is on screen, which joining a table would end. */
  busy: () => boolean;
  /** Sits down at (or watches) an online table by its code. */
  join: (table: string, watch: boolean) => void;
}

const SYNC_MS = 20_000;
const FRIEND_KEY = 'backroom-poker-friend';

let hooks: Hooks | null = null;
let fresh: FriendsState | null = null;
/** The account `fresh` belongs to: a different sign-in on this page starts from nothing. */
let owner = '';
let problem = '';
let notSetUp = false;
let timer: number | undefined;
let syncing: Promise<void> | null = null;
/** Invites already shown as a pop-up, so each pops up once. */
const popped = new Set<string>();
/** Friends invited to a table from here, by table code, so the button says so. */
const invited = new Map<string, Set<string>>();
/** A friend code from a shared link (?friend=CODE), waiting for the friends page. */
let linkFriend = '';
/** Redraws the friends page or table list on screen after a sync. */
let onChange: (() => void) | null = null;

const ready = () => !!(hooks?.auth?.current && isOnline());
/** The friends list of the account signed in now, or null until it's read. */
const mine = (): FriendsState | null => (fresh && owner === hooks?.auth?.current?.userId ? fresh : null);
const inviteKey = (i: TableInvite) => `${i.from}/${i.table}/${i.at}`;

export function initFriends(h: Hooks) {
  hooks = h;
  try {
    const url = new URL(location.href);
    const code = url.searchParams.get('friend');
    if (code) {
      localStorage.setItem(FRIEND_KEY, cleanFriendCode(code));
      url.searchParams.delete('friend');
      history.replaceState(null, '', url.toString());
    }
    linkFriend = localStorage.getItem(FRIEND_KEY) ?? '';
  } catch {
    /* no URL or storage to read */
  }
  if (!h.auth) return;
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void sync();
  }, SYNC_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sync();
  });
}

/** Stops checking in (for tests and screenshots). */
export function stopFriends() {
  clearInterval(timer);
}

/** Checks in with the server now: marks this account online and reads friends, requests and invites. */
export function sync(): Promise<void> {
  if (!hooks?.auth || !ready() || notSetUp) return Promise.resolve();
  syncing ??= (async () => {
    try {
      const who = hooks!.auth!.current?.userId ?? '';
      const got = await syncFriends(hooks!.auth!);
      if (who !== owner) popped.clear();
      fresh = got;
      owner = who;
      problem = '';
    } catch (err) {
      if (err instanceof FriendsNotSetUpError) notSetUp = true;
      else if (err instanceof OnlineError && err.status === 401) fresh = null;
      problem = (err as Error).message;
    }
    refreshBadge();
    popInvites();
    onChange?.();
  })().finally(() => (syncing = null));
  return syncing;
}

// ---------- the lobby ----------

const attention = () => {
  const s = mine();
  return s ? s.incoming.length + s.invites.length : 0;
};

function badgeInner(): string {
  const online = mine()?.friends.filter((f) => f.online).length ?? 0;
  const n = attention();
  return `Friends${online ? ` <span class="fr-online-count" title="${online} online"><i class="dot on"></i>${online}</span>` : ''}${n ? ` <b class="fr-badge" aria-label="${n} waiting">${n}</b>` : ''}`;
}

/** The lobby's Friends button, with how many friends are online and how many requests and invites wait. */
export function friendsButtonHtml(): string {
  if (!hooks?.auth || !isOnline()) return '';
  return `<button type="button" class="bonus-btn fr-btn" id="open-friends">${badgeInner()}</button>`;
}

function refreshBadge() {
  const b = document.getElementById('open-friends');
  if (b) b.innerHTML = badgeInner();
  const list = document.getElementById('lobby-invites');
  if (list) list.outerHTML = lobbyInvitesHtml();
  bindInviteRows();
}

/** Invites waiting in the lobby's Play with friends panel. */
export function lobbyInvitesHtml(): string {
  const invites = mine()?.invites ?? [];
  if (!invites.length) return '<div id="lobby-invites" hidden></div>';
  return `<div id="lobby-invites" class="fr-invites">${invites.map((i) => inviteRowHtml(i)).join('')}</div>`;
}

function inviteRowHtml(i: TableInvite): string {
  return `<div class="fr-invite" data-from="${esc(i.from)}" data-table="${esc(i.table)}">
    <span class="pfp sm" style="--pfp:${esc(i.color)}" aria-hidden="true">${esc(i.name.slice(0, 1).toUpperCase())}</span>
    <span class="fr-invite-text"><b>${esc(i.name)}</b> invited you to ${esc(i.game)} · table <b class="code-tag">${esc(i.table)}</b></span>
    <span class="fr-invite-btns">
      <button type="button" class="btn btn-sm btn-primary" data-inv="join">Join</button>
      <button type="button" class="btn btn-sm" data-inv="watch">Watch</button>
      <button type="button" class="btn btn-sm fr-x" data-inv="no" aria-label="No thanks">✕</button>
    </span>
  </div>`;
}

/** Wires the Friends button and any invite rows in the lobby. Opens the friends page for a shared friend link. */
export function bindLobbyFriends(app: HTMLElement, lobby: () => void) {
  const open = document.getElementById('open-friends');
  if (open) open.onclick = () => void renderFriends(app, lobby);
  bindInviteRows();
  if (ready() && !mine()) void sync();
  if (linkFriend && ready()) void renderFriends(app, lobby);
}

function bindInviteRows() {
  document.querySelectorAll<HTMLElement>('.fr-invite').forEach((row) => {
    row.querySelectorAll<HTMLButtonElement>('[data-inv]').forEach((b) => (b.onclick = () => answerInvite(row.dataset.from!, row.dataset.table!, b.dataset.inv as 'join' | 'watch' | 'no')));
  });
}

function answerInvite(from: string, table: string, how: 'join' | 'watch' | 'no') {
  if (!hooks?.auth) return;
  void dismissInvite(hooks.auth, from).catch(() => undefined);
  const s = mine();
  if (s) s.invites = s.invites.filter((i) => !(i.from === from && i.table === table));
  document.querySelectorAll(`.fr-pop[data-from="${from}"]`).forEach((el) => el.remove());
  refreshBadge();
  if (how !== 'no') hooks.join(table, how === 'watch');
}

// ---------- invite pop-ups ----------

function popInvites() {
  const s = mine();
  if (!s) return;
  const news = s.invites.filter((i) => !popped.has(inviteKey(i)) && Date.now() - i.at < 10 * 60_000);
  if (!news.length) return;
  let box = document.getElementById('invite-pops');
  if (!box) {
    box = document.createElement('div');
    box.id = 'invite-pops';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
  }
  for (const i of news) {
    popped.add(inviteKey(i));
    const el = document.createElement('div');
    el.className = 'fr-pop';
    el.dataset.from = i.from;
    const busy = hooks?.busy() ?? false;
    el.innerHTML = `<span class="pfp sm" style="--pfp:${esc(i.color)}" aria-hidden="true">${esc(i.name.slice(0, 1).toUpperCase())}</span>
      <span class="fr-pop-text"><b>${esc(i.name)}</b> invited you to ${esc(i.game)}${busy ? '. Finish up here and it\'s waiting in the lobby.' : '.'}</span>
      <span class="fr-pop-btns">${busy ? '' : '<button type="button" class="btn btn-sm btn-primary" data-pop="join">Join</button><button type="button" class="btn btn-sm" data-pop="watch">Watch</button>'}
      <button type="button" class="btn btn-sm fr-x" data-pop="close" aria-label="Close">✕</button></span>`;
    el.querySelectorAll<HTMLButtonElement>('[data-pop]').forEach((b) => (b.onclick = () => {
      el.remove();
      if (b.dataset.pop !== 'close') answerInvite(i.from, i.table, b.dataset.pop as 'join' | 'watch');
    }));
    box.appendChild(el);
    window.setTimeout(() => el.remove(), 30_000);
    play('turn');
  }
}

// ---------- inviting from a table ----------

function sortFriends(list: Friend[]): Friend[] {
  return [...list].sort((a, b) => Number(b.online) - Number(a.online) || b.seen - a.seen || a.name.localeCompare(b.name));
}

/** The friends list with an Invite button each, for the waiting room and the in-game picker. */
export function tableInvitesHtml(table: string): string {
  if (!hooks?.auth || !isOnline()) return '';
  if (notSetUp) return '';
  const sent = invited.get(table) ?? new Set();
  const s = mine();
  const friends = sortFriends(s?.friends ?? []);
  const body = !s
    ? '<p class="fine">Loading your friends…</p>'
    : !friends.length
      ? '<p class="fine">No friends yet. Add them from <b>Friends</b> in the lobby with their friend code, then invite them here in one tap.</p>'
      : `<ul class="fr-list compact">${friends.map((f) => `<li class="fr-row">
          ${friendFace(f)}
          <span class="fr-who"><b>${esc(f.name)}</b><span class="fr-seen${f.online ? ' on' : ''}">${seenText(f)}</span></span>
          <button type="button" class="btn btn-sm${sent.has(f.code) ? '' : ' btn-primary'}" data-invite="${esc(f.code)}" ${sent.has(f.code) ? 'disabled' : ''}>${sent.has(f.code) ? 'Invited' : 'Invite'}</button>
        </li>`).join('')}</ul>`;
  return `<div class="fr-table-invites" id="table-invites" data-table="${esc(table)}">
    <span class="sl">Invite friends</span>
    ${body}
    <p class="form-error" id="invite-error" role="alert"></p>
  </div>`;
}

/** Wires the Invite buttons drawn by tableInvitesHtml, and keeps the list fresh while it's on screen. */
export function bindTableInvites(table: string) {
  const box = document.getElementById('table-invites');
  if (!box) return;
  box.querySelectorAll<HTMLButtonElement>('[data-invite]').forEach((b) => (b.onclick = async () => {
    if (!hooks?.auth) return;
    b.disabled = true;
    const err = document.getElementById('invite-error');
    if (err) err.textContent = '';
    try {
      await inviteFriend(hooks.auth, b.dataset.invite!, table);
      const set = invited.get(table) ?? new Set<string>();
      set.add(b.dataset.invite!);
      invited.set(table, set);
      b.textContent = 'Invited';
      b.classList.remove('btn-primary');
    } catch (e) {
      b.disabled = false;
      if (err) err.textContent = (e as Error).message;
    }
  }));
  onChange = () => {
    const now = document.getElementById('table-invites');
    if (!now || now.dataset.table !== table) return;
    now.outerHTML = tableInvitesHtml(table);
    bindTableInvites(table);
  };
  if (!mine()) void sync();
}

/** The invite list as a pop-over, for the Invite button in an online table's top bar. */
export function openInvitePicker(table: string) {
  document.getElementById('invite-picker')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'invite-picker';
  wrap.className = 'overlay';
  const draw = () => {
    wrap.innerHTML = `<div class="modal fr-picker" role="dialog" aria-label="Invite friends">
      ${tableInvitesHtml(table) || `<p>${notSetUp ? 'Friends aren\'t switched on yet. Send the table code instead.' : 'Sign in to an online account to invite friends.'}</p>`}
      <div class="row"><button type="button" class="btn" id="invite-done">Done</button></div>
    </div>`;
    wrap.querySelector<HTMLButtonElement>('#invite-done')!.onclick = close;
    bindTableInvites(table);
  };
  const close = () => {
    wrap.remove();
    onChange = null;
    document.removeEventListener('keydown', esc_);
  };
  const esc_ = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  wrap.onclick = (e) => {
    if (e.target === wrap) close();
  };
  document.addEventListener('keydown', esc_);
  document.body.appendChild(wrap);
  draw();
  void sync();
}

// ---------- the friends page ----------

function friendFace(f: FriendCard & { online?: boolean }): string {
  return `<span class="fr-face"><span class="pfp" style="--pfp:${esc(f.color)}" aria-hidden="true">${esc(f.name.slice(0, 1).toUpperCase())}</span>${f.online === undefined ? '' : `<i class="dot${f.online ? ' on' : ''}" aria-hidden="true"></i>`}</span>`;
}

const titleOf = (f: FriendCard) => (f.title ? ACHIEVEMENT_BY_ID.get(f.title)?.title : null);

function pageHtml(prefill: string, note: string): string {
  if (notSetUp) return `<p class="form-error">Friends aren't switched on yet. It needs supabase/friends.sql run on the server.</p>`;
  const s = mine();
  if (!s) return `<p class="fine">${problem ? esc(problem) : 'Loading…'}</p>`;
  const link = `${location.origin}${location.pathname}?friend=${s.code}`;
  const friends = sortFriends(s.friends);
  const online = friends.filter((f) => f.online).length;
  return `
    <div class="fr-code-box">
      <span class="sl">Your friend code</span>
      <span class="room-code fr-code" aria-label="Friend code ${esc(s.code.split('').join(' '))}">${esc(s.code)}</span>
      <button type="button" class="btn btn-sm" id="copy-friend" data-link="${esc(link)}">Copy friend link</button>
    </div>
    <p class="fine">Send your code or link to a friend. Once you've both said yes, you'll see when each other is online and can invite each other to a table in one tap.</p>
    <form class="join-form fr-add" id="add-friend">
      <input class="text-input code-input" id="friend-code" maxlength="8" placeholder="Friend's code" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(prefill)}" aria-label="Friend's code">
      <button type="submit" class="btn btn-primary">Add friend</button>
    </form>
    ${note ? `<p class="notice" role="status">${esc(note)}</p>` : ''}
    <p class="form-error" id="friends-page-error" role="alert">${problem ? esc(problem) : ''}</p>
    ${s.incoming.length ? `<section class="fr-section">
      <h3 class="sl">Friend requests</h3>
      <ul class="fr-list">${s.incoming.map((f) => `<li class="fr-row">
        ${friendFace(f)}
        <span class="fr-who"><b>${esc(f.name)}</b>${titleHtml(titleOf(f))}<span class="fr-seen">Wants to be friends</span></span>
        <span class="fr-btns"><button type="button" class="btn btn-sm btn-primary" data-accept="${esc(f.code)}">Accept</button><button type="button" class="btn btn-sm" data-decline="${esc(f.code)}">Decline</button></span>
      </li>`).join('')}</ul>
    </section>` : ''}
    <section class="fr-section">
      <h3 class="sl">Friends${friends.length ? ` · ${online} online` : ''}</h3>
      ${friends.length ? `<ul class="fr-list">${friends.map((f) => `<li class="fr-row">
        ${friendFace(f)}
        <span class="fr-who"><b>${esc(f.name)}</b>${titleHtml(titleOf(f))}<span class="fr-seen${f.online ? ' on' : ''}">${seenText(f)}</span></span>
        <span class="fr-btns"><button type="button" class="btn btn-sm fr-remove" data-remove="${esc(f.code)}" data-name="${esc(f.name)}">Remove</button></span>
      </li>`).join('')}</ul>` : '<p class="fine">No friends yet. Add one with their friend code above.</p>'}
    </section>
    ${s.outgoing.length ? `<section class="fr-section">
      <h3 class="sl">Waiting for an answer</h3>
      <ul class="fr-list">${s.outgoing.map((f) => `<li class="fr-row">
        ${friendFace(f)}
        <span class="fr-who"><b>${esc(f.name)}</b><span class="fr-seen">Request sent</span></span>
        <span class="fr-btns"><button type="button" class="btn btn-sm" data-cancel="${esc(f.code)}">Cancel</button></span>
      </li>`).join('')}</ul>
    </section>` : ''}`;
}

/** The friends page: your friend code, adding friends, requests, and who's online. */
export async function renderFriends(app: HTMLElement, onBack: () => void) {
  const auth = hooks?.auth;
  if (!auth || !ready()) return onBack();
  let prefill = linkFriend;
  let note = '';
  if (linkFriend) {
    linkFriend = '';
    try {
      localStorage.removeItem(FRIEND_KEY);
    } catch {
      /* nothing kept */
    }
  }
  const draw = () => {
    if (!document.getElementById('friends-body')) return;
    const typed = (document.getElementById('friend-code') as HTMLInputElement | null)?.value;
    document.getElementById('friends-body')!.innerHTML = pageHtml(typed ?? prefill, note);
    bind();
  };
  const act = async (fn: () => Promise<unknown>, after = '') => {
    app.querySelectorAll<HTMLButtonElement>('#friends-body button').forEach((b) => (b.disabled = true));
    note = '';
    try {
      await fn();
      if (after) note = after;
      problem = '';
    } catch (e) {
      problem = (e as Error).message;
    }
    await sync();
    draw();
  };
  const bind = () => {
    const form = document.getElementById('add-friend') as HTMLFormElement | null;
    if (form) form.onsubmit = (e) => {
      e.preventDefault();
      const input = document.getElementById('friend-code') as HTMLInputElement;
      const code = cleanFriendCode(input.value);
      if (!code) {
        problem = 'Type the friend code your friend sent you.';
        return draw();
      }
      void act(async () => {
        const r = await addFriend(auth, code);
        input.value = '';
        prefill = '';
        note = r.status === 'friends' ? `You and ${r.name} are friends now.` : `Friend request sent to ${r.name}. You'll see them here once they say yes.`;
      }).then(() => {
        if (note) play('chips');
      });
    };
    const copy = document.getElementById('copy-friend') as HTMLButtonElement | null;
    if (copy) copy.onclick = async () => {
      const link = copy.dataset.link!;
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        prompt('Copy this link:', link);
      }
      copy.textContent = 'Link copied';
    };
    app.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach((b) => (b.onclick = () => void act(() => answerFriend(auth, b.dataset.accept!, true), 'Friend added.')));
    app.querySelectorAll<HTMLButtonElement>('[data-decline]').forEach((b) => (b.onclick = () => void act(() => answerFriend(auth, b.dataset.decline!, false))));
    app.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach((b) => (b.onclick = () => void act(() => removeFriend(auth, b.dataset.cancel!))));
    app.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) => (b.onclick = () => {
      if (!confirm(`Remove ${b.dataset.name} from your friends?`)) return;
      void act(() => removeFriend(auth, b.dataset.remove!));
    }));
  };

  app.innerHTML = `
  <main class="lobby profile-page friends-page">
    <div class="profile-top">
      <button type="button" class="btn" id="back">← Back to the tables</button>
    </div>
    <section class="panel fr-card">
      <div class="lb-head"><h2>Friends</h2></div>
      <div id="friends-body">${pageHtml(prefill, note)}</div>
    </section>
  </main>`;
  document.getElementById('back')!.onclick = () => {
    onChange = null;
    onBack();
  };
  bind();
  // A check-in every 20 seconds refreshes who's online, but not while a code is being typed.
  onChange = () => {
    if (document.activeElement?.id !== 'friend-code') draw();
  };
  await sync();
}
