// Entry point of the bot worker. scripts/build.mjs bundles this file on its own and inlines
// it into the page as a string (see src/ui/thinker.ts), so the game stays a single HTML file.
import { BrainRequest, createBrain } from './brain';

const scope = self as unknown as { onmessage: ((e: MessageEvent<BrainRequest>) => void) | null; postMessage(m: unknown): void };
const answer = createBrain();
scope.onmessage = (e) => scope.postMessage(answer(e.data));
