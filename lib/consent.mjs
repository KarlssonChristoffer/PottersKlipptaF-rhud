// "Say no to cookies": while a browser is the app in front, Clippit looks at its active tab every couple
// of seconds and turns down any cookie or consent popup there (lib/consent-probe.js does the looking and
// clicking inside the page). macOS only: it reaches the page the same way Mark a zone does, through
// Apple Events, so the browser needs "Allow JavaScript from Apple Events" turned on.
//
//   watchConsent({ enabled, onHandled, onBlocked })   starts the loop; returns { stop() }

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = readFileSync(path.join(here, 'consent-probe.js'), 'utf8');

const CHROMIUM = { 'com.google.Chrome': 'Google Chrome', 'com.google.Chrome.canary': 'Google Chrome Canary',
  'com.brave.Browser': 'Brave Browser', 'com.microsoft.edgemac': 'Microsoft Edge', 'company.thebrowser.Browser': 'Arc',
  'com.vivaldi.Vivaldi': 'Vivaldi', 'com.operasoftware.Opera': 'Opera', 'org.chromium.Chromium': 'Chromium' };
const SAFARI = { 'com.apple.Safari': 'Safari', 'com.apple.SafariTechnologyPreview': 'Safari Technology Preview' };

function run(cmd, args, { timeout = 3000, input } = {}) {
  return new Promise(resolve => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: err ? String(stderr || err.message).trim() : '' });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const asString = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// The browser in front, if the app in front is one. lsappinfo is cheap and needs no permission.
export async function frontBrowser() {
  const front = (await run('lsappinfo', ['front'], { timeout: 1000 })).out.trim();
  if (!front) return null;
  const info = (await run('lsappinfo', ['info', '-only', 'bundleid', front], { timeout: 1000 })).out;
  const m = info.match(/"CFBundleIdentifier"="([^"]+)"/);
  const id = m && m[1];
  if (CHROMIUM[id]) return { app: CHROMIUM[id], kind: 'chromium' };
  if (SAFARI[id]) return { app: SAFARI[id], kind: 'safari' };
  return null;
}

export function consentScript(b) {
  const js = `${PROBE}\n;clippitConsent()`;
  return b.kind === 'safari'
    ? `tell application ${asString(b.app)} to do JavaScript ${asString(js)} in front document`
    : `tell application ${asString(b.app)} to execute active tab of front window javascript ${asString(js)}`;
}

// What to tell you when the browser won't let Clippit run JavaScript in its pages.
export function blockedHint(b) {
  return b.kind === 'safari'
    ? 'Safari → Settings → Advanced → "Show features for web developers", then Develop → "Allow JavaScript from Apple Events"'
    : `${b.app} → View → Developer → "Allow JavaScript from Apple Events"`;
}

// JavaScript turned off for Apple Events reads like this in both browsers; anything else (no window,
// a chrome:// page, a page still loading) is just skipped.
const isBlocked = err => /allow javascript from apple events|javascript.*(turned off|disabled|not allowed)|-1743|not authori[sz]ed/i.test(err);

export function watchConsent({ enabled, onHandled, onBlocked, every = 2000 }) {
  if (process.platform !== 'darwin') return { stop() {} };
  let timer = null, busy = false;
  const blocked = new Set();     // browsers we already told you about this run
  async function tick() {
    if (busy || !enabled()) return;
    busy = true;
    try {
      const b = await frontBrowser();
      if (!b) return;
      const r = await run('osascript', ['-'], { input: consentScript(b), timeout: 6000 });
      if (!r.ok) {
        if (isBlocked(r.err) && !blocked.has(b.app)) { blocked.add(b.app); onBlocked && onBlocked(b, r.err); }
        return;
      }
      blocked.delete(b.app);
      let res;
      try { res = JSON.parse(r.out.trim()); } catch { return; }
      if (res && ['rejected', 'closed', 'hidden'].includes(res.action)) onHandled && onHandled(res, b);
    } finally { busy = false; }
  }
  timer = setInterval(() => { tick().catch(e => console.error('clippit: consent', e)); }, every);
  return { stop() { clearInterval(timer); } };
}

export const _test = { isBlocked, PROBE };
