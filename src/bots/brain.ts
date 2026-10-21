import { createRng } from '../engine/cards';
import { BotStyle, Difficulty } from '../engine/table';
import { VARIANTS } from '../engine/variants';
import { Bot, Decision } from './bot';
import { EquitySpec, simulateEquity } from './equity';
import { PlayerView } from './view';

/** A question for the bot thread: a seat's decision, or a pot share for the odds meter. */
export type BrainRequest =
  | { id: number; kind: 'think'; bot: number; difficulty: Difficulty; style: BotStyle; view: PlayerView }
  | { id: number; kind: 'equity'; spec: EquitySpec; iterations: number; timeBudgetMs?: number };

export type BrainReply =
  | { id: number; decision: Decision }
  | { id: number; equity: number }
  | { id: number; error: string };

/** Bots kept alive per caller, so each seat's random stream carries on between turns. */
const KEEP = 64;

/**
 * Answers BrainRequests. It runs inside the bot worker, and is plain code with no DOM
 * so tests (and the fallback when workers are unavailable) can call it directly.
 */
export function createBrain(): (req: BrainRequest) => BrainReply {
  const bots = new Map<number, Bot>();
  return (req) => {
    try {
      if (req.kind === 'equity') {
        const spec = { ...req.spec, variant: VARIANTS[req.spec.variant.id] ?? req.spec.variant };
        return { id: req.id, equity: simulateEquity(spec, { iterations: req.iterations, rng: createRng(), timeBudgetMs: req.timeBudgetMs }) };
      }
      let bot = bots.get(req.bot);
      if (!bot) {
        bot = new Bot(req.difficulty, req.style);
        bots.set(req.bot, bot);
        if (bots.size > KEEP) bots.delete(bots.keys().next().value!);
      }
      const view = { ...req.view, variant: VARIANTS[req.view.variant.id] ?? req.view.variant };
      return { id: req.id, decision: bot.think(view) };
    } catch (e) {
      return { id: req.id, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
