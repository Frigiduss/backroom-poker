// Table chat and emotes at online tables. The dock lives outside the table screen, which
// redraws on every update, so a half-typed line and the scroll position survive. Each new
// line also floats up over the speaker's seat for a few seconds.
import { CHAT_MAX, ChatLineView, EMOTES, EmoteId, TableView } from '../online/protocol';
import { esc } from './dom';
import { play } from './sound';
import { floatOver } from './talk';

export interface ChatHooks {
  /** Sends a line or an emote; resolves once the server has it. */
  say(msg: { text?: string; emote?: EmoteId }): Promise<void>;
  sound(): boolean;
}

const QUICK = ['Nice hand', 'Good luck', 'Unlucky', 'Thanks', 'gg'];
const OPEN_KEY = 'backroom-poker-chat-open';

const readOpen = (): boolean => {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

export class ChatDock {
  private el: HTMLElement;
  private open = readOpen();
  private lines: ChatLineView[] = [];
  private muted = false;
  /** Highest line id already shown, so only new ones float and count as unread. */
  private seen = -1;
  private unread = 0;
  private sending = false;
  private error = '';
  private errorTimer: number | undefined;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

  constructor(private readonly h: ChatHooks) {
    this.el = document.createElement('div');
    this.el.className = 'chat-dock';
    document.body.append(this.el);
    document.addEventListener('keydown', this.keyHandler);
    this.draw();
  }

  destroy() {
    document.removeEventListener('keydown', this.keyHandler);
    clearTimeout(this.errorTimer);
    this.el.remove();
  }

  /** Takes the chat from a fresh table view. */
  update(v: TableView) {
    const lines = v.chat ?? [];
    const first = this.seen < 0;
    const fresh = first ? [] : lines.filter((l) => l.id > this.seen);
    const changed = this.muted !== !!v.chatMuted || lines.length !== this.lines.length || lines.at(-1)?.id !== this.lines.at(-1)?.id;
    this.lines = lines;
    this.muted = !!v.chatMuted;
    this.seen = Math.max(this.seen, lines.at(-1)?.id ?? 0);
    if (!changed) return;
    const theirs = fresh.filter((l) => !l.you && !l.system);
    if (!this.open) this.unread += theirs.length;
    if (theirs.length && this.h.sound()) play('chat');
    this.draw();
    // Let the table finish drawing before looking for the seats.
    requestAnimationFrame(() => fresh.forEach((l, i) => this.float(l, i)));
  }

  private float(l: ChatLineView, i: number) {
    if (!l.seat) return;
    floatOver(l.seat, l.emote ? EMOTES[l.emote] : l.text ?? '', { emote: !!l.emote, delay: i * 0.15 });
  }

  private setOpen(on: boolean) {
    this.open = on;
    if (on) this.unread = 0;
    try {
      localStorage.setItem(OPEN_KEY, on ? '1' : '0');
    } catch {
      /* not kept */
    }
    this.draw();
    if (on) this.input()?.focus({ preventScroll: true });
  }

  private input = () => this.el.querySelector<HTMLInputElement>('.chat-input');

  private async say(msg: { text?: string; emote?: EmoteId }) {
    if (this.sending || this.muted) return;
    this.sending = true;
    this.draw();
    try {
      await this.h.say(msg);
      if (msg.text !== undefined) {
        const box = this.input();
        if (box) box.value = '';
      }
    } catch (e) {
      this.showError((e as Error).message);
    }
    this.sending = false;
    this.draw();
  }

  private showError(msg: string) {
    this.error = msg;
    clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => {
      this.error = '';
      this.draw();
    }, 4000);
  }

  private lineHtml(l: ChatLineView): string {
    if (l.system) return `<li class="sys">${esc(l.text ?? '')}</li>`;
    const who = `<b class="${l.you ? 'you' : ''}">${esc(l.you ? 'You' : l.name)}</b>`;
    return l.emote
      ? `<li>${who} <span class="emo" title="${esc(l.emote)}">${EMOTES[l.emote]}</span></li>`
      : `<li>${who} ${esc(l.text ?? '')}</li>`;
  }

  private draw() {
    const box = this.input();
    const draft = box?.value ?? '';
    const focused = !!box && document.activeElement === box;
    const caret = box?.selectionStart ?? null;
    const list = this.el.querySelector('.chat-lines');
    const atBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 30;
    const off = this.sending || this.muted ? 'disabled' : '';
    this.el.classList.toggle('open', this.open);
    this.el.innerHTML = this.open
      ? `<section class="chat-panel" aria-label="Table chat">
          <header><h2>Table chat</h2><button type="button" class="icon-btn chat-close" aria-label="Close chat">✕</button></header>
          <ol class="chat-lines" aria-live="polite">${this.lines.length ? this.lines.map((l) => this.lineHtml(l)).join('') : '<li class="sys">Say hello to the table.</li>'}</ol>
          <div class="chat-emotes">${(Object.keys(EMOTES) as EmoteId[]).map((id) => `<button type="button" data-emote="${id}" aria-label="${id}" ${off}>${EMOTES[id]}</button>`).join('')}</div>
          <div class="chat-quick">${QUICK.map((q) => `<button type="button" data-quick="${esc(q)}" ${off}>${esc(q)}</button>`).join('')}</div>
          <form class="chat-form">
            <input class="text-input chat-input" maxlength="${CHAT_MAX}" autocomplete="off" placeholder="${this.muted ? 'The table admin muted your chat' : 'Say something…'}" aria-label="Chat message" ${this.muted ? 'disabled' : ''}>
            <button type="submit" class="btn btn-sm btn-primary" ${off}>Send</button>
          </form>
          ${this.error ? `<p class="chat-error" role="alert">${esc(this.error)}</p>` : ''}
        </section>`
      : `<button type="button" class="chat-toggle" aria-label="Open table chat${this.unread ? `, ${this.unread} new` : ''}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z"/></svg><span>Chat</span>${this.unread ? `<b class="chat-badge">${this.unread > 9 ? '9+' : this.unread}</b>` : ''}
        </button>`;
    const nb = this.input();
    if (nb) {
      nb.value = draft;
      if (focused) {
        nb.focus({ preventScroll: true });
        if (caret !== null) nb.setSelectionRange(caret, caret);
      }
    }
    const ol = this.el.querySelector('.chat-lines');
    if (ol) ol.scrollTop = atBottom ? ol.scrollHeight : (list?.scrollTop ?? ol.scrollHeight);
    this.el.querySelector<HTMLButtonElement>('.chat-toggle')?.addEventListener('click', () => this.setOpen(true));
    this.el.querySelector<HTMLButtonElement>('.chat-close')?.addEventListener('click', () => this.setOpen(false));
    this.el.querySelectorAll<HTMLButtonElement>('[data-emote]').forEach((b) => (b.onclick = () => void this.say({ emote: b.dataset.emote as EmoteId })));
    this.el.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach((b) => (b.onclick = () => void this.say({ text: b.dataset.quick })));
    const form = this.el.querySelector<HTMLFormElement>('.chat-form');
    if (form) form.onsubmit = (e) => {
      e.preventDefault();
      const text = this.input()?.value.trim() ?? '';
      if (text) void this.say({ text });
    };
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (e.key === 'Escape' && t?.classList.contains('chat-input')) {
      e.preventDefault();
      this.setOpen(false);
      return;
    }
    // Enter starts a chat line, unless it is pressing a button or something else is being typed in.
    if (e.key !== 'Enter' || typing || t?.tagName === 'BUTTON' || document.querySelector('.overlay')) return;
    e.preventDefault();
    if (this.open) this.input()?.focus();
    else this.setOpen(true);
  }
}
