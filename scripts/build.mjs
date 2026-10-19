// Builds the browser game into dist/ (dist/index.html is fully self-contained),
// opens the built game in the default browser with --open, serves it for development
// with --serve, or runs the test suite with --test.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const args = process.argv.slice(2);
mkdirSync(dist, { recursive: true });

async function bundleTests() {
  const out = join(root, '.test-build');
  const files = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.ts'));
  await esbuild.build({
    entryPoints: files.map((f) => join(root, 'test', f)),
    bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'warning',
  });
  execFileSync(process.execPath, ['--test', ...files.map((f) => join(out, f.replace(/\.ts$/, '.js')))], { stdio: 'inherit' });
}

function page(js, css) {
  const html = readFileSync(join(root, 'src/ui/index.html'), 'utf8');
  return html
    .replace('/*__CSS__*/', () => css)
    .replace('<script src="game.js"></script>', () => `<script>${js.replace(/<\/script/g, '<\\/script')}</script>`);
}

async function buildOnce() {
  const result = await esbuild.build({
    entryPoints: [join(root, 'src/ui/main.ts')],
    bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, logLevel: 'warning',
  });
  const js = result.outputFiles[0].text;
  const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
  const html = page(js, css);
  writeFileSync(join(dist, 'index.html'), html);
  // Same page without the outer document, for publishing as a hosted page.
  writeFileSync(join(dist, 'fragment.html'), html
    .replace(/^[\s\S]*?<head>/, '')
    .replace(/<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*/g, '')
    .replace(/<\/head>\s*<body>/, '')
    .replace(/<\/body>\s*<\/html>\s*$/, ''));
  console.log(`Built dist/index.html (${(html.length / 1024).toFixed(0)} KB)`);
}

if (args.includes('--test')) {
  await bundleTests();
} else if (args.includes('--serve')) {
  const ctx = await esbuild.context({
    entryPoints: [join(root, 'src/ui/main.ts')], bundle: true, format: 'iife', sourcemap: true,
    outdir: join(dist, 'dev'), entryNames: 'game', logLevel: 'info',
  });
  await ctx.watch();
  writeFileSync(join(dist, 'dev', 'index.html'), readFileSync(join(root, 'src/ui/index.html'), 'utf8').replace('/*__CSS__*/', '').replace('</head>', '<link rel="stylesheet" href="styles.css"></head>'));
  writeFileSync(join(dist, 'dev', 'styles.css'), readFileSync(join(root, 'src/ui/styles.css'), 'utf8'));
  const { port } = await ctx.serve({ servedir: join(dist, 'dev'), port: 8000 });
  console.log(`Dev server on http://localhost:${port}`);
} else {
  await buildOnce();
  if (args.includes('--open')) openInBrowser(join(dist, 'index.html'));
}

function openInBrowser(file) {
  const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]]
      : ['xdg-open', [file]];
  const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
  child.on('error', () => console.log(`Open ${file} in your browser to play.`));
  child.unref();
  console.log('Opening Back Room Poker in your browser…');
}
