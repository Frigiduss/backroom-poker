// The seasonal event in the lobby: a banner while one is on, and the date the screens use to
// decide which seasonal looks are free. The developer console can preview an event out of
// season; a preview changes what is shown only, and games played in it count for nothing.
import { ACHIEVEMENT_BY_ID, CARD_BACKS, Counters, FELTS, Profile, SEASON_BY_ID, Season, isUnlocked, lookFor, seasonLastDay, seasonOn } from '../../accounts';
import { esc } from '../dom';

let preview: Season | null = null;

/** Shows an event as if it were on (until reload), or stops when `id` is null. Returns it. */
export function previewSeason(id: string | null): Season | null {
  preview = id ? SEASON_BY_ID.get(id) ?? null : null;
  return preview;
}
export const previewedSeason = (): Season | null => preview;

/** Today, or a day inside the event the console is previewing. */
export function seasonNow(): Date {
  if (!preview) return new Date();
  return new Date(new Date().getFullYear(), preview.from[0] - 1, preview.from[1], 12);
}

const fmt = (x: number) => x.toLocaleString('en-US');

/** The lobby banner for the event that is on, or '' when none is. `c` is all of the player's progress. */
export function seasonBannerHtml(p: Profile, c: Counters): string {
  const now = seasonNow();
  const s = seasonOn(now);
  if (!s) return '';
  const a = ACHIEVEMENT_BY_ID.get(s.achievement);
  const felt = FELTS.find((l) => l.id === s.felt);
  const back = CARD_BACKS.find((l) => l.id === s.back);
  const done = !!a && isUnlocked(a, c);
  const played = a ? Math.min(a.measure(c), a.goal) : 0;
  const until = seasonLastDay(s, now).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const look = lookFor(p.settings, c, now);
  const wearing = look.felt === s.felt && look.back === s.back;
  const wear = wearing ? '<span class="season-done">Wearing them ✓</span>' : '<button type="button" class="btn btn-sm" id="season-wear">Use them</button>';
  const looks = `the <b>${esc(felt?.name ?? '')}</b> felt and <b>${esc(back?.name ?? '')}</b> card back`;
  const body = done
    ? `You earned <em>${esc(a!.name)}</em>, so ${looks} are yours to keep.`
    : `${looks[0].toUpperCase()}${looks.slice(1)} are free until ${until}. Play ${fmt(s.goal)} games of anything before then to keep them for good.`;
  return `<section class="season-banner season-${s.id}" role="status" aria-label="${esc(s.name)}">
    <span class="season-felt" data-felt="${s.felt}" aria-hidden="true"><span class="card back" data-back="${s.back}"></span></span>
    <div class="season-text">
      <span class="eyebrow">Seasonal event · until ${until}${preview ? ' · preview' : ''}</span>
      <b>${esc(s.name)}</b>
      <span>${esc(s.blurb)} ${body}</span>
    </div>
    <div class="season-side">
      ${done ? '' : `<span class="bar" aria-hidden="true"><i style="width:${(played / s.goal) * 100}%"></i></span>
      <span class="ach-num">${fmt(played)} / ${fmt(s.goal)} games</span>`}
      ${wear}
    </div>
  </section>`;
}

/** Puts the event's felt and card back on. `done` saves the player and redraws. */
export function bindSeasonBanner(root: HTMLElement, p: Profile, c: Counters, done: () => void) {
  const b = root.querySelector<HTMLButtonElement>('#season-wear');
  const s = seasonOn(seasonNow());
  if (!b || !s) return;
  b.onclick = () => {
    p.settings = { ...p.settings, look: { ...lookFor(p.settings, c, seasonNow()), felt: s.felt, back: s.back } };
    p.updatedAt = Date.now();
    done();
  };
}
