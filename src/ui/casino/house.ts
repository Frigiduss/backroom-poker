// What the roulette, baccarat and video poker tables share: the lobby card's frame, the chip rack, the
// top bar and the settings modal. These games are the player alone against the house, with
// bets taken straight from the chip bank like blackjack.
import { takeUnlocks } from '../../accounts';
import { announce } from '../player/achievements';
import { bindConsoleButton, consoleEnabled, toggleConsole } from '../console';
import { fmt } from '../dom';
import { GUIDE_ICON, openGuide } from '../guides/guide';
import type { HouseGame } from '../picker';
import { player, savePlayer, serverAwards } from '../player/profiles';
import { play, setVolume } from '../sound';
import type { BjPrefs } from './blackjack';

export type HouseLimits = 'low' | 'mid' | 'high';

export interface HouseHooks<S> {
  app: HTMLElement;
  setup: S;
  prefs: BjPrefs;
  /** Saves the setup and prefs. */
  save: () => void;
  /** Back to the lobby. */
  leave: () => void;
}

export const seg = (name: string, items: [string, string][], current: string) =>
  `<div class="seg" role="group">${items.map(([v, l]) => `<button type="button" data-${name}="${v}" aria-pressed="${v === current}">${l}</button>`).join('')}</div>`;

/** The "Your table" card in the lobby for a game against the house. */
export function houseCardHtml(o: { name: string; rules: string; fields: string; min: number; bank: number; refillable: boolean }): string {
  const ok = o.bank >= o.min;
  return `<aside class="panel setup-card" aria-label="Your table">
    <div class="ticket">
      <span class="eyebrow">Your table</span>
      <b>${o.name}</b>
      <span>${o.rules}</span>
    </div>
    <div class="options">${o.fields}</div>
    <div class="deal-box">
      <span class="${ok ? 'cost' : 'cost short'}">${ok ? `Bets come straight from your bank of <b>${fmt(o.bank)}</b>` : `The minimum bet is ${fmt(o.min)} and your bank has ${fmt(o.bank)}.`}</span>
      ${!ok && o.refillable ? '<button type="button" class="btn btn-lg" id="refill">Refill bank</button>' : ''}
      <button type="button" class="btn btn-primary btn-lg" id="deal" ${ok ? '' : 'disabled'}>Take a seat</button>
    </div>
  </aside>`;
}

export const chipLabel = (v: number) => (v >= 1000 ? `${v / 1000}K` : String(v));

/** Chip buttons to pick which chip a click on the layout puts down. */
export function chipRackHtml(chips: number[], selected: number, room: number): string {
  return `<div class="bj-chips house-chips" role="group" aria-label="Chip to place">${chips.map((v) => `<button type="button" class="bj-chip v${v}" data-chip="${v}" aria-pressed="${v === selected}" ${v > room ? 'disabled' : ''} title="Place ${fmt(v)} chips"><span>${chipLabel(v)}</span></button>`).join('')}</div>`;
}

const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

/** The table's frame: top bar, settings, sounds, keys and the end of a sitting. */
export abstract class HouseTable<S extends { chip: number }> {
  protected readonly profile = player();
  protected modal: 'none' | 'settings' = 'none';
  protected stopped = false;
  private keyHandler = (e: KeyboardEvent) => this.onKeyDown(e);

  constructor(protected readonly h: HouseHooks<S>) {}

  protected abstract readonly title: string;
  protected abstract readonly cls: string;
  /** Which game's how to play guide the Rules button opens. */
  protected abstract readonly guideId: HouseGame;
  /** The chips this table's limits use. */
  protected abstract get chips(): number[];
  protected abstract infoHtml(): string;
  protected abstract feltHtml(): string;
  protected abstract dockHtml(): string;
  protected abstract bindGame(): void;
  protected abstract onKey(k: string, e: KeyboardEvent): void;
  /** Settles anything still in play when the player walks away. */
  protected abstract finish(): void;
  /** Whether the number keys pick a chip from the rack; a table can take them for itself. */
  protected readonly numberKeysPickChips: boolean = true;
  /** Extra toggles for the settings modal. */
  protected settingsExtraHtml(): string {
    return '';
  }

  protected get bank(): number {
    return this.profile.bank;
  }

  start() {
    document.addEventListener('keydown', this.keyHandler);
    if (!this.chips.includes(this.h.setup.chip)) this.h.setup.chip = this.chips[0];
    this.render();
  }

  stop() {
    if (this.stopped) return;
    this.finish();
    this.stopped = true;
    document.removeEventListener('keydown', this.keyHandler);
    announce(takeUnlocks(this.profile, serverAwards()));
    void savePlayer();
  }

  render() {
    if (this.stopped) return;
    const sound = this.h.prefs.sound;
    this.h.app.innerHTML = `
    <div class="game house ${this.cls} ${this.h.prefs.fourColor ? 'four-color' : ''}">
      <header class="topbar">
        <div class="tb-game">
          <span class="title">${this.title}</span>
          <span class="chip-info">${this.infoHtml()} · Bank <b>${fmt(this.bank)}</b></span>
        </div>
        <div class="tb-actions">
          ${consoleEnabled() ? `<button type="button" class="icon-btn" id="dev-toggle" title="Developer console (\`)">${icon('m5 7 5 5-5 5M12 18h7')}<span>Console</span></button>` : ''}
<button type="button" class="icon-btn" id="open-guide" title="How to play">${icon(GUIDE_ICON)}<span>Rules</span></button>
          <button type="button" class="icon-btn" id="sound-toggle" aria-pressed="${sound}" title="${sound ? 'Mute sounds (M)' : 'Turn sounds on (M)'}">${icon(sound ? 'M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z' : 'M4 9v6h4l5 4V5L8 9H4Zm12 .5 5 5m0-5-5 5')}<span>${sound ? 'Sound' : 'Muted'}</span></button>
          <button type="button" class="icon-btn" id="open-settings" title="Settings">${icon('M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.5a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.4 2.5h4l.4-2.5c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6Z')}<span>Settings</span></button>
          <button type="button" class="icon-btn" id="leave" title="Leave table">${icon('M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11')}<span>Leave</span></button>
        </div>
      </header>
      <div class="table-wrap">${this.feltHtml()}</div>
      <div class="actionbar">${this.dockHtml()}</div>
    </div>
    ${this.modal === 'settings' ? this.settingsHtml() : ''}`;
    this.bind();
  }

  private settingsHtml(): string {
    const p = this.h.prefs;
    const speeds: [BjPrefs['speed'], string][] = [['relaxed', 'Relaxed'], ['normal', 'Normal'], ['fast', 'Fast']];
    return `<div class="overlay"><div class="modal" role="dialog" aria-labelledby="set-title">
      <h2 id="set-title">Table settings</h2>
      <div class="field"><span class="flabel">Dealer speed</span><div class="seg">${speeds.map(([s, l]) => `<button type="button" data-speed="${s}" aria-pressed="${p.speed === s}">${l}</button>`).join('')}</div></div>
      <div class="field"><label for="pref-volume">Sound volume <output id="vol-out">${p.sound ? `${Math.round(p.volume * 100)}%` : 'Muted'}</output></label>
        <input id="pref-volume" class="slider" type="range" min="0" max="100" step="5" value="${Math.round(p.volume * 100)}"></div>
      <label class="toggle"><input type="checkbox" id="pref-sound" ${p.sound ? 'checked' : ''}> Play table sounds</label>
      ${this.settingsExtraHtml()}
      <div class="row"><button type="button" class="btn btn-primary" id="close-modal">Done</button></div>
    </div></div>`;
  }

  protected on(id: string, fn: () => void) {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  }

  private bind() {
    this.on('dev-toggle', toggleConsole);
    bindConsoleButton();
    this.on('sound-toggle', () => this.toggleSound());
    this.on('open-guide', () => openGuide(this.guideId));
    this.on('open-settings', () => {
      this.modal = 'settings';
      this.render();
    });
    this.on('leave', () => this.h.leave());
    this.on('close-modal', () => {
      this.modal = 'none';
      this.render();
    });
    document.querySelectorAll<HTMLButtonElement>('[data-chip]').forEach((b) => (b.onclick = () => {
      this.h.setup.chip = Number(b.dataset.chip);
      this.h.save();
      play('chips');
      this.render();
    }));
    document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => (b.onclick = () => {
      this.h.prefs.speed = b.dataset.speed as BjPrefs['speed'];
      this.h.save();
      this.render();
    }));
    document.querySelectorAll<HTMLInputElement>('.modal input[type=checkbox][data-pref]').forEach((el) => (el.onchange = () => {
      (this.h.prefs as unknown as Record<string, boolean>)[el.dataset.pref!] = el.checked;
      this.h.save();
      this.render();
    }));
    const sound = document.getElementById('pref-sound') as HTMLInputElement | null;
    if (sound) sound.onchange = () => {
      this.h.prefs.sound = sound.checked;
      this.h.save();
      setVolume(this.h.prefs.volume, !this.h.prefs.sound);
      this.render();
    };
    const vol = document.getElementById('pref-volume') as HTMLInputElement | null;
    if (vol) {
      vol.oninput = () => {
        this.h.prefs.volume = Number(vol.value) / 100;
        if (this.h.prefs.volume > 0) this.h.prefs.sound = true;
        setVolume(this.h.prefs.volume, !this.h.prefs.sound);
        document.getElementById('vol-out')!.textContent = `${vol.value}%`;
        if (sound) sound.checked = this.h.prefs.sound;
      };
      vol.onchange = () => {
        this.h.save();
        play('chips');
      };
    }
    this.bindGame();
  }

  private toggleSound() {
    this.h.prefs.sound = !this.h.prefs.sound;
    this.h.save();
    setVolume(this.h.prefs.volume, !this.h.prefs.sound);
    this.render();
    play('chips');
  }

  private onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    if (this.modal !== 'none') {
      if (e.key === 'Escape') {
        this.modal = 'none';
        this.render();
      }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'm') {
      e.preventDefault();
      this.toggleSound();
      return;
    }
    // Number keys pick a chip from the rack.
    const n = Number(k);
    if (this.numberKeysPickChips && n >= 1 && n <= this.chips.length) {
      document.querySelector<HTMLButtonElement>(`[data-chip="${this.chips[n - 1]}"]`)?.click();
      return;
    }
    this.onKey(k, e);
  }

  /** Clicks a button by id if it's there and enabled (for keyboard shortcuts). */
  protected click(id: string, e: KeyboardEvent) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el && !el.disabled) {
      e.preventDefault();
      el.click();
    }
  }
}
