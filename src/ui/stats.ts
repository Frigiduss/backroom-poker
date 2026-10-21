// The stats page: chips over time, how the player plays, and how each game has gone.
import { ChipPoint, STYLE_MIN_HANDS, STYLE_NOTES, allCounters, chipsOf, chipsSince, playingStyle } from '../accounts';
import { VARIANTS, VariantId } from '../engine/variants';
import { esc, fmt } from './dom';
import { isOnline, player, serverAwards } from './profiles';

type Range = 'week' | 'month' | 'all';
const RANGES: [Range, string][] = [['week', '7 days'], ['month', '30 days'], ['all', 'All time']];
const DAY = 86_400_000;
let range: Range = 'all';

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const when = (t: number, withTime = true) => new Date(t).toLocaleString(undefined, withTime
  ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  : { month: 'short', day: 'numeric' });

/** A round step for the chip axis, so gridlines land on numbers like 2,000 or 25,000. */
function niceStep(span: number, lines: number): number {
  const raw = Math.max(1, span / lines);
  const mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
}

/**
 * The chip graph as SVG. Chips hold steady between changes, so the line steps rather than
 * sloping. Returns the points' screen positions for the hover readout.
 */
function chartSvg(pts: ChipPoint[], w: number, h: number): { svg: string; xs: number[]; ys: number[] } {
  const pad = { l: 56, r: 12, t: 12, b: 26 };
  const t0 = pts[0][0];
  const t1 = Math.max(pts[pts.length - 1][0], t0 + 1);
  let lo = Math.min(...pts.map((p) => p[1]));
  let hi = Math.max(...pts.map((p) => p[1]));
  if (hi === lo) hi = lo + Math.max(100, lo * 0.1);
  const step = niceStep(hi - lo, 4);
  lo = Math.max(0, Math.floor(lo / step) * step);
  hi = Math.ceil(hi / step) * step;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const xs = pts.map((p) => x(p[0]));
  const ys = pts.map((p) => y(p[1]));

  let line = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let k = 1; k < pts.length; k++) line += `H${xs[k].toFixed(1)}V${ys[k].toFixed(1)}`;
  const area = `${line}V${y(lo).toFixed(1)}H${xs[0].toFixed(1)}Z`;

  const grid: string[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid.push(`<line class="cg-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`
      + `<text class="cg-tick" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  const ticks = (w < 420 ? [0, 1] : [0, 0.5, 1]).map((f) => {
    const t = t0 + f * (t1 - t0);
    const anchor = f === 0 ? 'start' : f === 1 ? 'end' : 'middle';
    return `<text class="cg-tick" x="${x(t)}" y="${h - 6}" text-anchor="${anchor}">${esc(when(t, t1 - t0 < 2 * DAY))}</text>`;
  });
  const svg = `<svg class="chip-graph" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Chips over time, from ${fmt(pts[0][1])} to ${fmt(pts[pts.length - 1][1])}">
    <defs><linearGradient id="cg-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--gold)" stop-opacity=".28"/><stop offset="1" stop-color="var(--gold)" stop-opacity="0"/></linearGradient></defs>
    ${grid.join('')}${ticks.join('')}
    <path d="${area}" fill="url(#cg-fill)"/>
    <path class="cg-line" d="${line}"/>
    <line class="cg-cross" id="cg-cross" y1="${pad.t}" y2="${h - pad.b}"/>
    <circle class="cg-dot" id="cg-dot" r="4.5"/>
    <circle class="cg-end" cx="${xs[xs.length - 1]}" cy="${ys[ys.length - 1]}" r="4.5"/>
  </svg>`;
  return { svg, xs, ys };
}

function drawChart(box: HTMLElement, pts: ChipPoint[]) {
  if (pts.length < 2 || pts.every((p) => p[1] === pts[0][1])) {
    box.innerHTML = `<p class="cg-empty">${pts.length >= 2 ? `Steady at <b>${fmt(pts[0][1])}</b> chips over this stretch.` : 'Your chip graph fills in as you play.'} Every hand, cash-out, bonus and refill adds to it.</p>`;
    return;
  }
  const w = Math.max(280, Math.floor(box.clientWidth));
  const h = w < 480 ? 200 : 260;
  const { svg, xs, ys } = chartSvg(pts, w, h);
  box.innerHTML = `${svg}<div class="cg-tip" id="cg-tip" hidden></div>`;
  const svgEl = box.querySelector('svg')!;
  const cross = box.querySelector<SVGLineElement>('#cg-cross')!;
  const dot = box.querySelector<SVGCircleElement>('#cg-dot')!;
  const tip = box.querySelector<HTMLElement>('#cg-tip')!;
  const show = (clientX: number) => {
    const r = svgEl.getBoundingClientRect();
    const mx = ((clientX - r.left) / r.width) * w;
    // The step line holds each value until the next point, so read the last point at or before the pointer.
    let k = 0;
    while (k + 1 < xs.length && xs[k + 1] <= mx) k++;
    const cx = Math.min(Math.max(mx, xs[0]), xs[xs.length - 1]);
    cross.setAttribute('x1', String(cx));
    cross.setAttribute('x2', String(cx));
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(ys[k]));
    box.classList.add('hover');
    const change = k > 0 ? pts[k][1] - pts[k - 1][1] : 0;
    tip.innerHTML = `<span><b>${fmt(pts[k][1])}</b> chips${change ? ` <span class="${change > 0 ? 'up' : 'down'}">${signed(change)}</span>` : ''}</span><span>${esc(when(pts[k][0]))}</span>`;
    tip.hidden = false;
    // Beside the crosshair, on whichever side has room, so it never covers the point.
    const left = (cx / w) * r.width;
    const flip = left + 14 + tip.offsetWidth > r.width;
    tip.style.left = `${flip ? left - 14 - tip.offsetWidth : left + 14}px`;
    tip.style.top = `${Math.max(0, (ys[k] / h) * r.height - tip.offsetHeight - 10)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    box.classList.remove('hover');
  };
  svgEl.addEventListener('pointermove', (e) => show(e.clientX));
  svgEl.addEventListener('pointerdown', (e) => show(e.clientX));
  svgEl.addEventListener('pointerleave', hide);
}

function styleHtml(c: ReturnType<typeof allCounters>): string {
  const s = playingStyle(c);
  const tiles: [string, string, string][] = [
    ['VPIP', pct(s.vpip), 'Hands you chose to put chips in before the flop (third street in stud, before the draw in draw games).'],
    ['Pre-flop raise', pct(s.pfr), 'Hands you bet or raised on that first round.'],
    ['Raise rate', pct(s.raiseRate), 'Of all your decisions, how many were bets or raises.'],
    ['Aggression', s.aggression === null ? '–' : s.aggression.toFixed(1), 'Bets and raises for every call. Above 2 is aggressive.'],
    ['Went to showdown', pct(s.showdowns), 'Hands you were still in when the cards were shown.'],
  ];
  const read = s.label
    ? `<div class="style-read"><span class="sl">Your style</span><b>${s.label}</b><p>${STYLE_NOTES[s.label]}</p></div>`
    : `<div class="style-read"><span class="sl">Your style</span><b>Too early to tell</b><p>${s.hands ? `${fmt(STYLE_MIN_HANDS - s.hands)} more hand${STYLE_MIN_HANDS - s.hands === 1 ? '' : 's'} for a read.` : 'Play a few hands of poker for a read.'}</p></div>`;
  return `<section class="panel stats-style">
    <h2 class="step">How you play<span class="ach-count">${fmt(s.hands)} hand${s.hands === 1 ? '' : 's'}</span></h2>
    ${read}
    <div class="stat-grid">${tiles.map(([label, value, note]) => `<div class="stat"><span class="sl">${label}</span><b>${value}</b><span class="ss">${note}</span></div>`).join('')}</div>
    <p class="fine">Counted from every poker hand ${isOnline() ? 'at bot and online tables' : 'you play'} since this page arrived. Practice tables and rigged hands don't count.</p>
  </section>`;
}

function gamesHtml(c: ReturnType<typeof allCounters>): string {
  const rows = (Object.keys(VARIANTS) as VariantId[])
    .map((id) => ({ id, hands: c[`play.${id}`] ?? 0, wins: c[`win.${id}`] ?? 0 }))
    .filter((r) => r.hands > 0)
    .sort((a, b) => b.hands - a.hands);
  if (!rows.length) return '';
  const most = rows[0].hands;
  return `<section class="panel stats-games">
    <h2 class="step">By game</h2>
    <table class="game-table">
      <thead><tr><th scope="col">Game</th><th scope="col">Hands</th><th scope="col">Won</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <th scope="row">${esc(VARIANTS[r.id].name)}<span class="bar" aria-hidden="true"><i style="width:${(r.hands / most) * 100}%"></i></span></th>
        <td>${fmt(r.hands)}</td><td>${pct(Math.min(1, r.wins / r.hands))}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>`;
}

/** The full stats page, opened from the profile. */
export function renderStats(app: HTMLElement, onBack: () => void) {
  const p = player();
  const c = allCounters(p, serverAwards());
  const now = Date.now();
  const from = range === 'week' ? now - 7 * DAY : range === 'month' ? now - 30 * DAY : p.history[0]?.[0] ?? now;
  const pts = chipsSince(p.history, from, now);
  const chips = chipsOf(p);
  const change = pts.length ? chips - pts[0][1] : 0;
  const peak = pts.length ? Math.max(...pts.map((x) => x[1])) : chips;

  app.innerHTML = `
  <main class="lobby profile-page stats-page">
    <div class="profile-top">
      <button type="button" class="btn" id="back">← Back</button>
    </div>
    <section class="panel stats-chips">
      <div class="stats-head">
        <div class="stats-now">
          <span class="sl">Your chips</span>
          <b>${fmt(chips)}</b>
          <span class="ss"><span class="${change > 0 ? 'up' : change < 0 ? 'down' : ''}">${signed(change)}</span> ${range === 'all' ? 'since your first hand' : `in the last ${range === 'week' ? '7' : '30'} days`} · peak ${fmt(peak)}</span>
        </div>
        <div class="seg" role="group" aria-label="Time range">
          ${RANGES.map(([id, label]) => `<button type="button" data-range="${id}" aria-pressed="${range === id}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="cg-box" id="cg-box"></div>
    </section>
    ${styleHtml(c)}
    ${gamesHtml(c)}
  </main>`;

  document.getElementById('back')!.onclick = () => {
    window.removeEventListener('resize', redraw);
    onBack();
  };
  app.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) => (b.onclick = () => {
    range = b.dataset.range as Range;
    window.removeEventListener('resize', redraw);
    renderStats(app, onBack);
  }));
  const box = document.getElementById('cg-box')!;
  let lastW = 0;
  function redraw() {
    if (!box.isConnected) return window.removeEventListener('resize', redraw);
    if (box.clientWidth === lastW) return;
    lastW = box.clientWidth;
    drawChart(box, pts);
  }
  redraw();
  window.addEventListener('resize', redraw);
}
