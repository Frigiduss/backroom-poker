// Builds the browser game into dist/ (dist/index.html is fully self-contained, plus the
// manifest, icons and service worker that make it installable), the admin
// dashboard into dist/admin.html (published as admin/), and the online table server into supabase/functions/poker-table/index.ts,
// opens the built game in the default browser with --open, serves it for development
// with --serve, or runs the test suite with --test.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const args = process.argv.slice(2);
mkdirSync(dist, { recursive: true });

/**
 * Resolves `import source from 'virtual:bot-worker'` to the bot worker (src/bots/worker.ts),
 * bundled on its own and handed over as a string, so the page can start it from a Blob
 * and still ship as one file.
 */
const botWorker = {
  name: 'bot-worker',
  setup(build) {
    build.onResolve({ filter: /^virtual:bot-worker$/ }, () => ({ path: 'bot-worker', namespace: 'bot-worker' }));
    build.onLoad({ filter: /.*/, namespace: 'bot-worker' }, async () => {
      const result = await esbuild.build({
        entryPoints: [join(root, 'src/bots/worker.ts')],
        bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, metafile: true, absWorkingDir: root, logLevel: 'warning',
      });
      return {
        contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
        loader: 'js',
        watchFiles: Object.keys(result.metafile.inputs).map((f) => join(root, f)),
      };
    });
  },
};

async function bundleTests() {
  const out = join(root, '.test-build');
  const files = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.ts'));
  await esbuild.build({
    entryPoints: files.map((f) => join(root, 'test', f)),
    bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'warning', plugins: [botWorker],
  });
  execFileSync(process.execPath, ['--test', ...files.map((f) => join(out, f.replace(/\.ts$/, '.js')))], { stdio: 'inherit' });
}

/** Tab and home-screen icons, inlined as data URIs so the page stays a single file. */
function icons() {
  const svg = readFileSync(join(root, 'src/ui/icon.svg')).toString('base64');
  const png = readFileSync(join(root, 'src/ui/apple-touch-icon.png')).toString('base64');
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${svg}">\n`
    + `<link rel="apple-touch-icon" href="data:image/png;base64,${png}">`;
}

/** Install-to-home-screen tags. The game registers sw.js only when the manifest link is there. */
const APP_TAGS = '\n<link rel="manifest" href="manifest.webmanifest">'
  + '\n<meta name="apple-mobile-web-app-capable" content="yes">'
  + '\n<meta name="mobile-web-app-capable" content="yes">'
  + '\n<meta name="apple-mobile-web-app-title" content="Back Room">'
  + '\n<meta name="apple-mobile-web-app-status-bar-style" content="black">';
const APP_FILES = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

function page(js, css, template = 'src/ui/index.html', app = false) {
  const html = readFileSync(join(root, template), 'utf8');
  return html
    .replace('<!--__ICONS__-->', () => icons() + (app ? APP_TAGS : ''))
    .replace('/*__CSS__*/', () => css)
    .replace('<script src="game.js"></script>', () => `<script>${js.replace(/<\/script/g, '<\\/script')}</script>`);
}

async function buildOnce() {
  const result = await esbuild.build({
    entryPoints: [join(root, 'src/ui/main.ts')],
    bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, logLevel: 'warning', plugins: [botWorker],
  });
  const js = result.outputFiles[0].text;
  const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
  const html = page(js, css, 'src/ui/index.html', true);
  writeFileSync(join(dist, 'index.html'), html);
  writeAppFiles(html);
  // Same page without the outer document (or the app install tags), for publishing as a hosted page.
  writeFileSync(join(dist, 'fragment.html'), html
    .replace(APP_TAGS, '')
    .replace(/^[\s\S]*?<head>/, '')
    .replace(/<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*/g, '')
    .replace(/<\/head>\s*<body>/, '')
    .replace(/<\/body>\s*<\/html>\s*$/, ''));
  console.log(`Built dist/index.html (${(html.length / 1024).toFixed(0)} KB)`);
  await buildAdmin(css);
  await buildServer();
}

/** The manifest, icons and service worker, whose version changes whenever the page does. */
function writeAppFiles(html) {
  for (const file of APP_FILES) copyFileSync(join(root, 'src/ui', file), join(dist, file));
  const version = createHash('sha256').update(html).update(readFileSync(join(root, 'src/ui/sw.js'))).digest('hex').slice(0, 12);
  writeFileSync(join(dist, 'sw.js'), readFileSync(join(root, 'src/ui/sw.js'), 'utf8').replace('__VERSION__', version));
}

/** The admin dashboard: the developer console and live panels on a page of their own. */
async function buildAdmin(gameCss) {
  const result = await esbuild.build({
    entryPoints: [join(root, 'src/admin/main.ts')],
    bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, logLevel: 'warning', plugins: [botWorker],
  });
  const css = gameCss + readFileSync(join(root, 'src/admin/admin.css'), 'utf8');
  const html = page(result.outputFiles[0].text, css, 'src/admin/index.html');
  writeFileSync(join(dist, 'admin.html'), html);
  console.log(`Built dist/admin.html (${(html.length / 1024).toFixed(0)} KB)`);
}

/** The online table server, as one file Supabase can deploy (or paste into its editor). */
async function buildServer() {
  const dir = join(root, 'supabase/functions/poker-table');
  mkdirSync(dir, { recursive: true });
  const result = await esbuild.build({
    entryPoints: [join(root, 'src/online/edge.ts')],
    bundle: true, minify: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'warning',
    banner: { js: '// @ts-nocheck\n// Generated by scripts/build.mjs from src/online. Edit those files, not this one.' },
  });
  writeFileSync(join(dir, 'index.ts'), result.outputFiles[0].text);
  console.log(`Built supabase/functions/poker-table/index.ts (${(result.outputFiles[0].text.length / 1024).toFixed(0)} KB)`);
}

if (args.includes('--test')) {
  await bundleTests();
} else if (args.includes('--serve')) {
  const ctx = await esbuild.context({
    entryPoints: [join(root, 'src/ui/main.ts')], bundle: true, format: 'iife', sourcemap: true,
    outdir: join(dist, 'dev'), entryNames: 'game', logLevel: 'info', plugins: [botWorker],
  });
  await ctx.watch();
  writeFileSync(join(dist, 'dev', 'index.html'), readFileSync(join(root, 'src/ui/index.html'), 'utf8').replace('<!--__ICONS__-->', icons).replace('/*__CSS__*/', '').replace('</head>', '<link rel="stylesheet" href="styles.css"></head>'));
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
