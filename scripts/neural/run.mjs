// Retrains the Master bot: self-play on every core, train, then a duplicate match against Expert.
//   node scripts/neural/run.mjs [--minutes 25] [--keep]     (data goes in .neural/, kept with --keep)
//   node scripts/neural/run.mjs --match-only [--hands 4000] [--opponents hard,expert]
import { execFileSync, spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = join(root, '.neural');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const workers = Math.max(1, cpus().length);
mkdirSync(join(work, 'data'), { recursive: true });

for (const f of ['selfplay', 'train', 'match']) {
  await build({ entryPoints: [join(root, 'scripts/neural', `${f}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(work, `${f}.mjs`), logLevel: 'warning' });
}
const runAll = (script, argsFor) => Promise.all(Array.from({ length: workers }, (_, i) => new Promise((ok, fail) => {
  let out = '';
  const p = spawn(process.execPath, [join(work, script), ...argsFor(i)], { stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => (out += d));
  p.on('exit', (code) => (code ? fail(new Error(`${script} exited ${code}`)) : ok(out.trim())));
})));

if (!args.includes('--match-only')) {
  if (!args.includes('--keep') && existsSync(join(work, 'data'))) { rmSync(join(work, 'data'), { recursive: true }); mkdirSync(join(work, 'data')); }
  const seconds = Number(opt('minutes', 25)) * 60;
  console.log(`self-play on ${workers} cores for ${seconds / 60} minutes...`);
  const stamp = Date.now();
  for (const line of await runAll('selfplay.mjs', (i) => [join(work, 'data', `sp-${stamp}-${i}.jsonl`), String(stamp + i), String(seconds)])) console.log(line);
  execFileSync(process.execPath, [join(work, 'train.mjs'), join(work, 'data'), join(root, 'src/bots/neural-weights.ts')], { stdio: 'inherit' });
  // The match below bundles the new weights.
  await build({ entryPoints: [join(root, 'scripts/neural/match.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'match.mjs'), logLevel: 'warning' });
}

const hands = Math.ceil(Number(opt('hands', 4000)) / workers);
const opponents = opt('opponents', 'hard,expert');
const results = (await runAll('match.mjs', (i) => [String(1000 + i), String(hands), opponents])).map((l) => JSON.parse(l));
const t = results.reduce((a, r) => ({ n: a.n + r.n, sum: a.sum + r.sum, sum2: a.sum2 + r.sum2, e: a.e + r.expertTotal, m: a.m + r.masterTotal }), { n: 0, sum: 0, sum2: 0, e: 0, m: 0 });
const mean = t.sum / t.n, se = Math.sqrt(t.sum2 / t.n - mean * mean) / Math.sqrt(t.n);
console.log(`vs ${opponents}, ${t.n} duplicate hands: Master ${(100 * t.m / t.n).toFixed(1)} bb/100, Expert ${(100 * t.e / t.n).toFixed(1)} bb/100`);
console.log(`Master minus Expert: ${(100 * mean).toFixed(1)} ± ${(196 * se).toFixed(1)} bb/100 (95%)`);
