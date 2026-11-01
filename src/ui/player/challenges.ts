// Weekly challenges: the lobby button and the page with this week's three goals.
import { CHALLENGE_LEVELS, ChallengeSlot, ChallengeStatus, NotSetUpError, challengeWeek, weekEnd } from '../../accounts';
import { esc, fmt } from '../dom';
import { claimWeeklyChallenge, weeklyChallenges } from './profiles';
import { play } from '../sound';

/** "3d 4h", "5h 12m" or "8m" until `ms` from now. */
function leftText(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

/** The lobby button: how many goals are done, glowing when one is ready to collect. */
export function challengesButtonHtml(): string {
  const list = weeklyChallenges();
  if (!list.length) return '';
  const ready = list.filter((c) => c.state === 'ready');
  const done = list.filter((c) => c.state !== 'open').length;
  if (ready.length) {
    const chips = ready.reduce((t, c) => t + c.reward, 0);
    return `<button type="button" class="bonus-btn ready" id="open-challenges" title="A weekly challenge is finished: collect your chips">Challenge<span class="wide"> done</span> <b>+${fmt(chips)}</b></button>`;
  }
  return `<button type="button" class="bonus-btn" id="open-challenges" title="This week's challenges">Weekly <b class="ch-count">${done}/3</b></button>`;
}

export function bindChallengesButton(app: HTMLElement, lobby: () => void) {
  const btn = document.getElementById('open-challenges');
  if (btn) btn.onclick = () => renderChallenges(app, lobby);
}

function cardHtml(c: ChallengeStatus): string {
  const pct = (c.progress / c.goal) * 100;
  const action = c.state === 'ready'
    ? `<button type="button" class="btn btn-primary" data-claim="${c.slot}">Collect ${fmt(c.reward)}</button>`
    : c.state === 'claimed'
      ? '<span class="ch-paid"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Collected</span>'
      : `<span class="ch-reward">${fmt(c.reward)} chips</span>`;
  return `<li class="ch-card ch-${c.state} ch-l${c.slot}">
    <span class="ch-level">${CHALLENGE_LEVELS[c.slot]}</span>
    <p class="ch-desc">${esc(c.desc)}</p>
    <div class="ch-progress">
      <span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
      <span class="ch-num">${fmt(c.progress)} / ${fmt(c.goal)}</span>
    </div>
    <div class="ch-action">${action}</div>
  </li>`;
}

/** This week's three challenges with progress, time left and Collect buttons. */
export function renderChallenges(app: HTMLElement, onBack: () => void, message = '') {
  const list = weeklyChallenges();
  const left = weekEnd(challengeWeek()) - Date.now();
  app.innerHTML = `
  <main class="lobby profile-page challenges-page">
    <div class="profile-top">
      <button type="button" class="btn" id="back">← Back to the tables</button>
    </div>
    <section class="panel ch-panel">
      <div class="ch-head">
        <h2>Weekly challenges</h2>
        <span class="ch-left">New challenges in <b>${leftText(left)}</b></span>
      </div>
      ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
      <ol class="ch-list">${list.map(cardHtml).join('')}</ol>
      <p class="fine">Three new goals every Monday (midnight UTC), the same for everyone. Progress counts from when you first opened the lobby this week. Games against bots and online tables both count; practice tables don't. Each goal pays once.</p>
    </section>
  </main>`;
  document.getElementById('back')!.onclick = onBack;
  app.querySelectorAll<HTMLButtonElement>('[data-claim]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const slot = Number(b.dataset.claim) as ChallengeSlot;
    let msg: string;
    try {
      const c = await claimWeeklyChallenge(slot);
      if (c.amount > 0) {
        play('chips');
        msg = `${fmt(c.amount)} chips added to your bank.`;
      } else msg = 'You already collected that one this week.';
    } catch (err) {
      msg = err instanceof NotSetUpError ? `${err.message} It needs supabase/challenges.sql run on the server.` : (err as Error).message || 'The chips could not be collected. Try again.';
    }
    renderChallenges(app, onBack, msg);
  }));
}
