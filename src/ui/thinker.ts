import workerSource from 'virtual:bot-worker';
import { Bot, Decision } from '../bots/bot';
import { BrainReply, BrainRequest } from '../bots/brain';
import { EquitySpec, simulateEquity } from '../bots/equity';
import { PlayerView } from '../bots/view';
import { createRng } from '../engine/cards';

// Bot decisions and odds run in a worker so a deep Monte Carlo never freezes the table.
// If the browser can't start one (old browser, locked-down iframe) or it stops answering,
// everything quietly falls back to thinking on the page like before.

/** Longer than any bot's time budget by a wide margin; past this the worker counts as stuck. */
const TIMEOUT_MS = 4000;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type Pending = { resolve(r: BrainReply): void; fallback(): void; timer: number };

let worker: Worker | null = null;
let broken = typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL;
let nextId = 1;
const pending = new Map<number, Pending>();
const botIds = new WeakMap<Bot, number>();

function giveUp() {
  broken = true;
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.fallback();
  }
  pending.clear();
}

function start(): Worker | null {
  if (worker || broken) return worker;
  try {
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = (e: MessageEvent<BrainReply>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      clearTimeout(p.timer);
      if ('error' in e.data) p.fallback();
      else p.resolve(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      giveUp();
    };
    worker.onmessageerror = giveUp;
  } catch {
    giveUp();
  }
  return worker;
}

function ask<T>(req: WithoutId<BrainRequest>, pick: (r: BrainReply) => T, local: () => T): Promise<T> {
  return new Promise((resolve) => {
    const fallback = () => resolve(local());
    const w = start();
    if (!w) return fallback();
    const id = nextId++;
    const timer = window.setTimeout(giveUp, TIMEOUT_MS);
    pending.set(id, { resolve: (r) => resolve(pick(r)), fallback, timer });
    try {
      w.postMessage({ ...req, id });
    } catch {
      giveUp();
    }
  });
}

/** What this bot would do from this view, worked out off the main thread when possible. */
export function think(bot: Bot, view: PlayerView): Promise<Decision> {
  let botId = botIds.get(bot);
  if (botId === undefined) botIds.set(bot, (botId = nextId++));
  return ask({ kind: 'think', bot: botId, difficulty: bot.difficulty, style: bot.style, view },
    (r) => ('decision' in r ? r.decision : bot.think(view)), () => bot.think(view));
}

/** Monte Carlo pot share for the odds meter, worked out off the main thread when possible. */
export function equity(spec: EquitySpec, iterations: number, timeBudgetMs?: number): Promise<number> {
  const local = () => simulateEquity(spec, { iterations, rng: createRng(), timeBudgetMs });
  return ask({ kind: 'equity', spec, iterations, timeBudgetMs }, (r) => ('equity' in r ? r.equity : local()), local);
}
