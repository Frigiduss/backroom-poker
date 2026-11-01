// Catches errors the game hits and sends them to the admin dashboard's crash reports
// (supabase/crashes.sql), with what the player was doing, their browser and the build.
// It's set up before anything else runs, keeps errors that happen before sign-in is ready,
// sends at most a handful per visit, and leaves out page addresses' query and #fragment,
// which can hold a sign-in link's tokens.
import { CrashInfo, OnlineAuth, OnlineError, sendCrash } from '../accounts';

declare const __BUILD__: string;
/** Which deploy this is: the commit it was built from, set by scripts/build.mjs. */
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

/** Reports sent from one visit, at most. The server has its own limits as well. */
const MAX_PER_VISIT = 5;

/** "Chrome 130 · Windows", "Safari 18 · iPhone", with " · app" when installed to the home screen. */
export function browserName(ua: string, touchPoints = 0, standalone = false): string {
  const v = (re: RegExp) => ua.match(re)?.[1];
  let name = 'Other browser';
  let n: string | undefined;
  if ((n = v(/Edg(?:e|A|iOS)?\/(\d+)/))) name = `Edge ${n}`;
  else if ((n = v(/OPR\/(\d+)/))) name = `Opera ${n}`;
  else if ((n = v(/SamsungBrowser\/(\d+)/))) name = `Samsung Internet ${n}`;
  else if ((n = v(/(?:Firefox|FxiOS)\/(\d+)/))) name = `Firefox ${n}`;
  else if ((n = v(/(?:Chrome|CriOS)\/(\d+)/))) name = `Chrome ${n}`;
  else if ((n = v(/Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari/))) name = `Safari ${n}`;
  const os = /iPhone|iPod/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /CrOS/.test(ua) ? 'ChromeOS'
          : /Windows/.test(ua) ? 'Windows'
            : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
              : /Linux/.test(ua) ? 'Linux' : 'other';
  return `${name} · ${os}${standalone ? ' · app' : ''}`;
}

/** Shortens the page's own address in a stack trace and drops every address's query and #fragment. */
export function cleanStack(stack: string, origin = ''): string {
  const s = stack.replace(/(?:https?|blob):[^\s)]+/g, (url) => {
    const end = url.match(/(?::\d+)+$/)?.[0] ?? '';
    let base = url.slice(0, url.length - end.length).replace(/[?#].*$/, '');
    if (base.startsWith('blob:')) base = 'worker';
    else if (origin && base.startsWith(origin)) base = base.slice(origin.length);
    return base + end;
  });
  return s.slice(0, 2000);
}

/** Errors that aren't the game's fault: lost connections, browser extensions, browser noise. */
export function ignorable(message: string, file = '', origin = ''): boolean {
  if (!message.trim() || /^Script error\.?$/i.test(message)) return true;
  if (/ResizeObserver loop|Failed to fetch|NetworkError|Load failed|The network connection was lost|AbortError|The operation was aborted/i.test(message)) return true;
  // Errors from extensions and other sites' scripts carry their own address.
  if (file && !file.startsWith('blob:') && !(origin && file.startsWith(origin)) && /^[a-z-]+:/i.test(file)) return true;
  return false;
}

let auth: OnlineAuth | null = null;
let authReady = false;
let where: () => string = () => '';
const waiting: CrashInfo[] = [];
const seen = new Set<string>();
let sent = 0;

function report(error: unknown, file = '') {
  try {
    if (error instanceof OnlineError) return;
    const err = error instanceof Error ? error : null;
    const message = (err ? `${err.name && !err.message.startsWith(err.name) ? `${err.name}: ` : ''}${err.message}` : typeof error === 'string' ? error : (() => {
      try {
        return JSON.stringify(error) ?? String(error);
      } catch {
        return String(error);
      }
    })()).slice(0, 300);
    if (ignorable(message, file, location.origin)) return;
    const stack = cleanStack(err?.stack ?? '', location.origin);
    const key = `${message}\n${stack.split('\n').find((l) => / at |@/.test(l)) ?? ''}`;
    if (seen.has(key) || seen.size >= MAX_PER_VISIT) return;
    seen.add(key);
    let game = '';
    try {
      game = where();
    } catch {
      game = 'unknown';
    }
    const standalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
    const info: CrashInfo = { message, stack, game: game.slice(0, 60), browser: browserName(navigator.userAgent, navigator.maxTouchPoints ?? 0, standalone), build: BUILD };
    if (authReady) send(info);
    else waiting.push(info);
  } catch {
    /* reporting must never cause another error */
  }
}

function send(info: CrashInfo) {
  if (!auth || sent >= MAX_PER_VISIT) return;
  sent++;
  void sendCrash(auth, info);
}

/** Starts listening for errors. Call it before anything else runs. */
export function installCrashReporter(whereNow: () => string) {
  where = whereNow;
  window.addEventListener('error', (e) => {
    // Failed image or sound loads come through here too, without an error.
    if (!(e instanceof ErrorEvent)) return;
    report(e.error ?? e.message, e.filename);
  });
  window.addEventListener('unhandledrejection', (e) => report(e.reason));
}

/** Sign-in is ready: send what was kept until now. With online accounts off, reports go nowhere. */
export function setCrashAuth(a: OnlineAuth | null) {
  auth = a;
  authReady = true;
  for (const info of waiting.splice(0)) send(info);
}

/** For the console: send a test report. */
export function testCrash() {
  report(new Error(`Test crash report from the console (${new Date().toISOString().slice(0, 16)})`));
}
