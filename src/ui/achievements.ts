// The achievements screen (progress on every achievement, and the title picker) and the
// pop-up that celebrates a new unlock.
import { ACHIEVEMENTS, Achievement, GROUP_NAMES, GROUP_ORDER, TIER_NAMES, allCounters, isUnlocked } from '../accounts';
import { esc, fmt, titleHtml } from './dom';
import { currentTitle, isOnline, player, refreshAwards, savePlayer, serverAwards } from './profiles';
import { play } from './sound';

// ---------- unlock pop-ups ----------

let toastRoot: HTMLElement | null = null;

/** Shows a pop-up for each newly unlocked achievement (a few at most, then a count). */
export function announce(list: Achievement[]) {
  if (!list.length || typeof document === 'undefined') return;
  if (!toastRoot || !toastRoot.isConnected) {
    toastRoot = document.createElement('div');
    toastRoot.className = 'ach-toasts';
    toastRoot.setAttribute('role', 'status');
    toastRoot.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastRoot);
  }
  const shown = [...list].sort((a, b) => b.tier - a.tier).slice(0, 3);
  const extra = list.length - shown.length;
  shown.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = `ach-toast t${a.tier}`;
    el.innerHTML = `${medalHtml(a)}<span class="at-text"><span class="at-kicker">Achievement unlocked${i === shown.length - 1 && extra > 0 ? ` · and ${extra} more` : ''}</span><b>${esc(a.name)}</b><span>${a.title ? `New title: <em>${esc(a.title)}</em>` : esc(a.desc)}</span></span>`;
    el.style.animationDelay = `${i * 0.25}s`;
    toastRoot!.appendChild(el);
    window.setTimeout(() => el.classList.add('out'), 5200 + i * 250);
    window.setTimeout(() => el.remove(), 5800 + i * 250);
  });
  play('win', 300);
}

/** Checks for new unlocks (fetching online progress first when signed in) and celebrates them. */
export async function checkAchievements(): Promise<void> {
  announce(await refreshAwards());
}

// ---------- the screen ----------

const medalHtml = (a: Achievement) => `<span class="medal t${a.tier}" title="${TIER_NAMES[a.tier]}" aria-label="${TIER_NAMES[a.tier]}">${a.online ? '<svg viewBox="0 0 24 24"><path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 19c0-3 3-5 6-5s6 2 6 5M14 14.5c.6-.3 1.3-.5 2-.5 3 0 6 2 6 5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.4 6.8 19.2l1-5.9L3.5 9.2l5.9-.8z"/></svg>'}</span>`;

type Filter = 'all' | 'unlocked' | 'locked';
let filter: Filter = 'all';

/** Every achievement with its progress, grouped, plus the title picker. */
export async function renderAchievements(app: HTMLElement, onBack: () => void) {
  const draw = () => {
    const p = player();
    const c = allCounters(p, serverAwards());
    const got = ACHIEVEMENTS.filter((a) => isUnlocked(a, c));
    const titles = got.filter((a) => a.title);
    const chosen = currentTitle();
    const card = (a: Achievement) => {
      const value = Math.min(a.measure(c), a.goal);
      const done = value >= a.goal;
      const when = p.achievements.unlocked[a.id];
      const progress = done
        ? `<span class="ach-done">${when ? `Unlocked ${new Date(when).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Unlocked'}</span>`
        : `<span class="bar" aria-hidden="true"><i style="width:${(value / a.goal) * 100}%"></i></span><span class="ach-num">${fmt(Math.floor(value))} / ${fmt(a.goal)}</span>`;
      return `<li class="ach ${done ? 'got' : 'locked'} t${a.tier}">
        ${medalHtml(a)}
        <div class="ach-body">
          <b>${esc(a.name)}</b>
          <span class="ach-desc">${esc(a.desc)}</span>
          ${a.title ? `<span class="ach-title">Title: <em>${esc(a.title)}</em></span>` : ''}
          <div class="ach-progress">${progress}</div>
        </div>
      </li>`;
    };
    const groups = GROUP_ORDER.map((g) => {
      const all = ACHIEVEMENTS.filter((a) => a.group === g);
      const items = all.filter((a) => (filter === 'all' ? true : filter === 'unlocked' ? isUnlocked(a, c) : !isUnlocked(a, c)));
      if (!items.length) return '';
      const n = all.filter((a) => isUnlocked(a, c)).length;
      const note = g === 'online' ? `<p class="fine">${isOnline() ? 'Counted by the table server at online tables, so they can\'t be faked.' : 'Sign in and play at an online table to earn these.'}</p>` : '';
      return `<section class="panel ach-group"><h2 class="step">${GROUP_NAMES[g]}<span class="ach-count">${n} / ${all.length}</span></h2>${note}<ul class="ach-list">${items.map(card).join('')}</ul></section>`;
    }).join('');

    app.innerHTML = `
    <main class="lobby profile-page ach-page">
      <div class="profile-top">
        <button type="button" class="btn" id="back">← Back</button>
      </div>
      <section class="panel ach-head">
        <div class="ach-summary">
          <span class="sl">Achievements</span>
          <b>${got.length} <span>of ${ACHIEVEMENTS.length}</span></b>
          <span class="bar" aria-hidden="true"><i style="width:${(got.length / ACHIEVEMENTS.length) * 100}%"></i></span>
          <span class="ach-tiers">${([4, 3, 2, 1] as const).map((t) => `<span class="medal-count t${t}">${got.filter((a) => a.tier === t).length} ${TIER_NAMES[t]}</span>`).join('')}</span>
        </div>
        <div class="title-pick">
          <span class="sl">Your title</span>
          <p class="fine">Shows next to your name in the lobby and at every table${isOnline() ? ', online tables included' : ''}.</p>
          <div class="title-chips" role="group" aria-label="Title">
            <button type="button" class="title-chip" data-title="" aria-pressed="${!chosen}">No title</button>
            ${titles.map((a) => `<button type="button" class="title-chip t${a.tier}" data-title="${a.id}" aria-pressed="${p.title === a.id && !!chosen}">${esc(a.title!)}</button>`).join('')}
          </div>
          ${titles.length ? '' : '<p class="fine">Unlock an achievement marked with a title to wear it.</p>'}
          ${chosen ? `<p class="title-preview">${esc(p.name)} ${titleHtml(chosen)}</p>` : ''}
        </div>
      </section>
      <div class="seg ach-filter" role="group" aria-label="Show">
        ${(['all', 'unlocked', 'locked'] as Filter[]).map((f) => `<button type="button" data-filter="${f}" aria-pressed="${f === filter}">${{ all: 'All', unlocked: 'Unlocked', locked: 'Still to get' }[f]}</button>`).join('')}
      </div>
      ${groups || '<p class="fine">Nothing here yet.</p>'}
    </main>`;

    document.getElementById('back')!.onclick = onBack;
    app.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) => (b.onclick = () => {
      filter = b.dataset.filter as Filter;
      draw();
    }));
    app.querySelectorAll<HTMLButtonElement>('[data-title]').forEach((b) => (b.onclick = async () => {
      p.title = b.dataset.title || null;
      p.updatedAt = Date.now();
      draw();
      await savePlayer();
    }));
  };
  draw();
  window.scrollTo(0, 0);
  // Pull in anything credited at online tables, then redraw with it.
  const fresh = await refreshAwards();
  announce(fresh);
  if (app.querySelector('.ach-page')) draw();
}
