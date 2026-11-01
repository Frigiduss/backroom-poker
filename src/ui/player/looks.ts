// The player's felt and card back. Choices are set as data attributes on the page, and the
// stylesheet turns them into colours, so every table (poker, blackjack, online) follows.
import { ACHIEVEMENT_BY_ID, CARD_BACKS, Counters, DEFAULT_LOOK, FELTS, Look, LookChoice, Profile, SEASON_BY_ID, allCounters, lookFor, lookOnLoan, lookUnlocked } from '../../accounts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
import { esc } from '../dom';
import { seasonNow } from './season';

/** Shows the player's look, or the free one when nobody is signed in. `awards` is online progress. */
export function applyLook(p: Profile | null, awards: Counters) {
  if (typeof document === 'undefined') return;
  const look = p ? lookFor(p.settings, allCounters(p, awards), seasonNow()) : DEFAULT_LOOK;
  document.documentElement.dataset.felt = look.felt;
  document.documentElement.dataset.back = look.back;
}

const option = (l: Look, c: Counters, chosen: string) => {
  const now = seasonNow();
  const open = lookUnlocked(l, c, now);
  const a = l.unlock ? ACHIEVEMENT_BY_ID.get(l.unlock) : undefined;
  const season = l.season ? SEASON_BY_ID.get(l.season) : undefined;
  const preview = l.kind === 'felt' ? '<span class="look-felt" aria-hidden="true"></span>' : '<span class="card back look-back" aria-hidden="true"></span>';
  const how = lookOnLoan(l, c, now) ? `Free for ${esc(season!.name)}`
    : open ? (l.unlock ? 'Unlocked' : 'Free')
    : season ? `${esc(season.name)}: ${MONTHS[season.from[0] - 1]}`
    : `Unlock: ${esc(a?.name ?? '')}`;
  return `<button type="button" class="look-opt" data-${l.kind}="${l.id}" data-look="${l.kind}" aria-pressed="${l.id === chosen}" ${open ? '' : 'disabled'} title="${open ? esc(l.name) : esc(a ? `${a.name}: ${a.desc}` : '')}">
    ${preview}
    <span class="look-name">${esc(l.name)}</span>
    <span class="look-how">${how}</span>
  </button>`;
};

/** The felt and card back pickers for the achievements screen. */
export function looksPanelHtml(p: Profile, c: Counters): string {
  const look = lookFor(p.settings, c, seasonNow());
  const count = (list: Look[]) => `${list.filter((l) => lookUnlocked(l, c, seasonNow())).length} / ${list.length}`;
  return `<section class="panel looks">
    <h2 class="step">Felt and card backs<span class="ach-count">${count([...FELTS, ...CARD_BACKS])}</span></h2>
    <p class="fine">Your pick shows at every table you sit at, poker and blackjack. Achievements unlock more, and seasonal events lend theirs while they are on.</p>
    <span class="sl">Felt</span>
    <div class="look-row" role="group" aria-label="Felt">${FELTS.map((l) => option(l, c, look.felt)).join('')}</div>
    <span class="sl">Card back</span>
    <div class="look-row" role="group" aria-label="Card back">${CARD_BACKS.map((l) => option(l, c, look.back)).join('')}</div>
  </section>`;
}

/** Wires up the pickers. `c` is all of the player's progress; `save` stores and redraws. */
export function bindLooks(root: HTMLElement, p: Profile, c: Counters, awards: Counters, save: () => void) {
  root.querySelectorAll<HTMLButtonElement>('[data-look]').forEach((b) => (b.onclick = () => {
    const kind = b.dataset.look as keyof LookChoice;
    p.settings = { ...p.settings, look: { ...lookFor(p.settings, c, seasonNow()), [kind]: b.dataset[kind] } };
    p.updatedAt = Date.now();
    applyLook(p, awards);
    save();
  }));
}
