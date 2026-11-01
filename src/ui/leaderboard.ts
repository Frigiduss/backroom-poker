// The lobby's daily bonus button and the leaderboard page.
import {
  ACHIEVEMENTS, ACHIEVEMENT_BY_ID, BOARD_NAMES, Board, LEADERBOARD_MIN_HANDS, LeaderRow, NotSetUpError,
  bonusAmount, bonusReady, fetchLeaderboard, nextBonusAt, streakDay,
} from '../accounts';
import { faceHtml } from './faces';
import { esc, fmt, titleHtml } from './dom';
import { claimDailyBonus, isOnline, onlineAuth, player, savePlayer, setNotice } from './profiles';
import { play } from './sound';

function waitText(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

/** The lobby's buttons for the daily bonus and (with online accounts) the leaderboard. */
export function lobbyExtrasHtml(): string {
  const p = player();
  const now = Date.now();
  const bonus = bonusReady(p.bonus, now)
    ? `<button type="button" class="bonus-btn ready" id="claim-bonus" title="Collect today's free chips">Daily<span class="wide"> bonus</span> <b>+${fmt(bonusAmount(streakDay(p.bonus, now)))}</b></button>`
    : `<span class="bonus-btn" title="Day ${p.bonus.streak} in a row. Come back to keep the streak going.">Next<span class="wide"> bonus</span> in ${waitText(nextBonusAt(p.bonus) - now)}</span>`;
  const board = onlineAuth() ? '<button type="button" class="bonus-btn" id="open-leaderboard">Leaderboard</button>' : '';
  return bonus + board;
}

export function bindLobbyExtras(app: HTMLElement, lobby: () => void) {
  const claim = document.getElementById('claim-bonus') as HTMLButtonElement | null;
  if (claim) claim.onclick = async () => {
    claim.disabled = true;
    try {
      const c = await claimDailyBonus();
      if (c.amount > 0) {
        play('chips');
        setNotice(`Daily bonus: ${fmt(c.amount)} chips added to your bank.${c.streak > 1 ? ` That's ${c.streak} days in a row.` : ' Come back tomorrow for more.'}`);
      } else setNotice('You already collected today\'s bonus.');
    } catch (err) {
      setNotice((err as Error).message || 'The bonus could not be collected. Try again.');
    }
    lobby();
  };
  const open = document.getElementById('open-leaderboard');
  if (open) open.onclick = () => renderLeaderboard(app, lobby);
}

// ---------- leaderboard ----------

let board: Board = 'bank';

const valueText = (b: Board, v: number) => (b === 'achievements' ? `${fmt(v)} / ${ACHIEVEMENTS.length}` : `${fmt(v)}<span class="wide"> chips</span>`);

function rowHtml(r: LeaderRow, b: Board): string {
  const title = r.title ? ACHIEVEMENT_BY_ID.get(r.title)?.title : null;
  const medal = r.rank <= 3 ? ` medal m${r.rank}` : '';
  return `<li class="lb-row${r.mine ? ' mine' : ''}">
    <span class="lb-rank${medal}">${r.rank}</span>
    ${faceHtml(r)}
    <span class="lb-name"><b>${esc(r.name)}</b>${titleHtml(title)}</span>
    <span class="lb-value">${valueText(b, r.value)}</span>
  </li>`;
}

function listHtml(rows: LeaderRow[], b: Board): string {
  if (!rows.length) return `<p class="fine">Nobody on this board yet. Players show up once they've played ${LEADERBOARD_MIN_HANDS} hands.</p>`;
  const out: string[] = [];
  rows.forEach((r, i) => {
    // The account's own players can be far below the top: mark the jump.
    if (i > 0 && r.rank > rows[i - 1].rank + 1 && r.mine) out.push('<li class="lb-gap" aria-hidden="true">···</li>');
    out.push(rowHtml(r, b));
  });
  return `<ol class="lb-list">${out.join('')}</ol>`;
}

/** The leaderboard page: the top players by chip bank, biggest pot or achievements. */
export async function renderLeaderboard(app: HTMLElement, onBack: () => void) {
  const auth = onlineAuth();
  if (!auth) return onBack();
  const p = player();
  const online = isOnline();
  const hidden = p.settings.leaderboard === false;
  app.innerHTML = `
  <main class="lobby profile-page leaderboard-page">
    <div class="profile-top">
      <button type="button" class="btn" id="back">← Back to the tables</button>
    </div>
    <section class="panel lb-card">
      <div class="lb-head">
        <h2>Leaderboard</h2>
        <div class="seg" role="group" aria-label="Rank by">
          ${(Object.keys(BOARD_NAMES) as Board[]).map((b) => `<button type="button" data-board="${b}" aria-pressed="${b === board}">${BOARD_NAMES[b]}</button>`).join('')}
        </div>
      </div>
      <div id="lb-body"><p class="fine">Loading…</p></div>
      <p class="fine">${online
        ? `Players show up once they've played ${LEADERBOARD_MIN_HANDS} hands, with the numbers from their last save.`
        : 'Only players saved in an online account are ranked. Sign in from your profile to join in.'}</p>
      ${online ? `<label class="lb-optout"><input type="checkbox" id="lb-show" ${hidden ? '' : 'checked'}> Show ${esc(p.name)} on the leaderboard</label>` : ''}
    </section>
  </main>`;

  document.getElementById('back')!.onclick = onBack;
  app.querySelectorAll<HTMLButtonElement>('[data-board]').forEach((btn) => (btn.onclick = () => {
    board = btn.dataset.board as Board;
    void renderLeaderboard(app, onBack);
  }));
  const show = document.getElementById('lb-show') as HTMLInputElement | null;
  if (show) show.onchange = async () => {
    p.settings = { ...p.settings, leaderboard: show.checked };
    await savePlayer();
    void renderLeaderboard(app, onBack);
  };

  const shown = board;
  let html: string;
  try {
    html = listHtml(await fetchLeaderboard(auth, shown), shown);
  } catch (err) {
    html = `<p class="form-error">${esc(err instanceof NotSetUpError ? `${err.message} It needs supabase/leaderboard.sql run on the server.` : (err as Error).message)}</p>`;
  }
  const body = document.getElementById('lb-body');
  if (body && board === shown) body.innerHTML = html;
}
