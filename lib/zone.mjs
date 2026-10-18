// "Mark a zone": everything Clippit can find out, deterministically, about a rectangle you drew on the
// screen, before Claude sees a word of your prompt. Each collector is best effort and independent: one
// that can't run (no permission, not a browser, not a git repo) leaves its field empty and says why in
// `notes`, so the rest still arrives. macOS first; the other platforms get the screenshot and the repo.
//
//   frontApp()                 which app and window you were looking at (read before the overlay opens)
//   gatherZone(rect, opts)     screenshots, OCR, browser URL and the DOM under the zone, the repo behind it
//   writeBundle(dir, ctx)      context.json + context.md next to the screenshots, for Claude to read

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const IS_MAC = process.platform === 'darwin';

function run(cmd, args, { timeout = 4000, cwd, input } = {}) {
  return new Promise(resolve => {
    const child = execFile(cmd, args, { timeout, cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: err ? String(stderr || err.message).trim() : '' });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const osa = (script, timeout = 4000) => run('osascript', ['-'], { input: script, timeout });
const asString = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// ---------------------------------------------------------------- which app, which window

const CHROMIUM = { 'com.google.Chrome': 'Google Chrome', 'com.google.Chrome.canary': 'Google Chrome Canary',
  'com.brave.Browser': 'Brave Browser', 'com.microsoft.edgemac': 'Microsoft Edge', 'company.thebrowser.Browser': 'Arc',
  'com.vivaldi.Vivaldi': 'Vivaldi', 'com.operasoftware.Opera': 'Opera', 'org.chromium.Chromium': 'Chromium' };
const SAFARI = { 'com.apple.Safari': 'Safari', 'com.apple.SafariTechnologyPreview': 'Safari Technology Preview' };

function parseLsappinfo(out) {
  const get = k => { const m = out.match(new RegExp(`"${k}"=("?)([^"\\n]*)\\1`)); return m ? m[2] : undefined; };
  const pid = Number(get('pid'));
  return { name: get('LSDisplayName'), bundleId: get('CFBundleIdentifier'), pid: pid || undefined };
}

// The app in front, skipping Clippit itself (opening his menu brings him forward).
export async function frontApp({ skipPid = process.pid, dir = configDir() } = {}) {
  if (!IS_MAC) return null;
  const list = await run('lsappinfo', ['visibleProcessList'], { timeout: 1500 });
  const asns = (list.out.match(/ASN:0x[0-9a-f]+-0x[0-9a-f]+/gi) || []).slice(0, 6).map(a => `${a}:`);
  for (const asn of asns.length ? asns : ['front']) {
    const q = asn === 'front' ? (await run('lsappinfo', ['front'])).out.trim() : asn;
    const info = parseLsappinfo((await run('lsappinfo', ['info', '-only', 'name,bundleid,pid', q], { timeout: 1500 })).out);
    if (!info.pid || info.pid === skipPid || /electron|clippit/i.test(info.name || '')) continue;
    // Title and frame from the window list (Screen Recording, which the screenshot needs anyway), not
    // from System Events, which would need Accessibility too.
    const bin = await helper('window', dir);
    const w = bin ? await run(bin, [String(info.pid)], { timeout: 1500 }) : { ok: false };
    if (w.ok) {
      const [frame, ...title] = w.out.trim().split('\t');
      const [x, y, width, height] = frame.split(',').map(Number);
      if (title.join('\t')) info.windowTitle = title.join('\t');
      if ([x, y, width, height].every(Number.isFinite)) info.windowBounds = { x, y, width, height };
    }
    info.browser = CHROMIUM[info.bundleId] ? 'chromium' : SAFARI[info.bundleId] ? 'safari' : null;
    info.appName = CHROMIUM[info.bundleId] || SAFARI[info.bundleId] || info.name;
    return info;
  }
  return null;
}

// ---------------------------------------------------------------- screenshots

function grow(r, by, bounds) {
  const x = Math.max(bounds.x, r.x - by), y = Math.max(bounds.y, r.y - by);
  const right = Math.min(bounds.x + bounds.width, r.x + r.width + by), bottom = Math.min(bounds.y + bounds.height, r.y + r.height + by);
  return { x, y, width: right - x, height: bottom - y };
}

async function capture(r, file) {
  if (IS_MAC) {
    const res = await run('screencapture', ['-x', '-t', 'png', '-R', [r.x, r.y, r.width, r.height].map(Math.round).join(','), file], { timeout: 8000 });
    return res.ok && existsSync(file) && statSync(file).size > 0;
  }
  return false;
}

// ---------------------------------------------------------------- text in the zone (macOS Vision)

// Small Swift helpers (lib/zone-<name>.swift), compiled once into Clippit's config folder.
const building = new Map();
function helper(name, dir) {
  if (!IS_MAC) return Promise.resolve(null);
  const src = path.join(here, `zone-${name}.swift`), bin = path.join(dir, 'bin', `clippit-${name}`);
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return Promise.resolve(bin);
  if (!building.has(bin)) {
    mkdirSync(path.dirname(bin), { recursive: true });
    building.set(bin, run('swiftc', ['-O', src, '-o', bin], { timeout: 180000 }).then(r => { building.delete(bin); return r.ok ? bin : null; }));
  }
  return building.get(bin);
}

// Built at startup, so the first zone doesn't wait for the compiler.
export const prepareHelpers = (dir = configDir()) => Promise.all([helper('window', dir), helper('ocr', dir)]);

async function ocr(file, dir) {
  if (!IS_MAC) return { lines: [], note: 'text recognition is macOS only for now' };
  const bin = await helper('ocr', dir);
  if (!bin) return { lines: [], note: 'could not build the text recogniser (swiftc missing?)' };
  const r = await run(bin, [file], { timeout: 20000 });
  if (!r.ok) return { lines: [], note: `text recognition failed: ${r.err.slice(0, 120)}` };
  const lines = r.out.split('\n').filter(Boolean).map(l => {
    const [box, ...text] = l.split('\t');
    const [x, y, w, h] = box.split(' ').map(Number);
    return { text: text.join('\t'), box: { x, y, w, h } };
  });
  return { lines };
}

// ---------------------------------------------------------------- the browser: URL and the DOM under the zone

// The page's elements come from Clippit's browser extension (lib/bridge.mjs), not from JavaScript sent
// over Apple Events: that needed a browser setting that let any app run code in your logged-in tabs.
// The extension also gives the URL and title, so with it no Automation permission is needed; only
// without it does Clippit ask the browser over Apple Events (macOS asks you once).
async function browser(front, rect, bridge) {
  const out = { notes: [] };
  const hasExtension = bridge && bridge.connected(front.browser);
  if (hasExtension) {
    try {
      const r = await bridge.request(front.browser, 'probe', { rect });
      out.dom = JSON.parse(r.dom);
      out.url = r.url || (out.dom.page && out.dom.page.url);
      out.title = r.title || (out.dom.page && out.dom.page.title);
    } catch (e) {
      out.notes.push(`couldn't look at the page's elements (${e.message})`);
    }
  } else out.notes.push(`couldn't look at the page's elements: add the Clippit Says No extension to ${front.appName} (extension/README.md)`);
  if (!out.url) {
    const app = asString(front.appName);
    const meta = front.browser === 'safari'
      ? await osa(`tell application ${app} to return (URL of front document) & linefeed & (name of front document)`)
      : await osa(`tell application ${app} to return (URL of active tab of front window) & linefeed & (title of active tab of front window)`);
    if (meta.ok) { const [url, ...t] = meta.out.trim().split('\n'); out.url = url; out.title = t.join(' '); }
    else if (!hasExtension) out.notes.push(`couldn't read the URL either (the extension gives it without any permission)`);
  }
  return out;
}

// Websites that aren't yours (feber.se, not localhost) get a scratch project to build in.
export function sandboxFor(url, base) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || LOCAL.test(u.hostname)) return null;
  const host = u.hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  return { path: path.join(base, host), host, url: u.href };
}

export function sandboxBase(setting) {
  if (setting) return setting.replace(/^~(?=\/|$)/, os.homedir());
  const dev = path.join(os.homedir(), 'Developer');
  return path.join(existsSync(dev) ? dev : os.homedir(), 'clippit-sandbox');
}

// ---------------------------------------------------------------- which repo is behind it

export async function gitTop(dir) {
  if (!dir) return null;
  const r = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 2000 });
  return r.ok ? r.out.trim() : null;
}

async function cwdOfPid(pid) {
  const r = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 });
  const m = r.out.match(/^n(.+)$/m);
  return m ? m[1] : null;
}

const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost|[\w.-]+\.test)$/i;

// localhost:3000 → the process listening on 3000 → the folder it runs in → that folder's git repo.
export async function repoFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!LOCAL.test(u.hostname)) return null;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 3000 });
  for (const pid of [...new Set(r.out.split('\n').filter(Boolean))]) {
    const cwd = await cwdOfPid(pid);
    const top = await gitTop(cwd);
    if (top) return { path: top, how: `${u.host} is served by pid ${pid}, running in ${cwd}` };
    if (cwd && cwd !== '/') return { path: cwd, how: `${u.host} is served by pid ${pid}, running in ${cwd} (not a git repo)` };
  }
  return null;
}

async function repoFromSessions(front, sessions) {
  const dirs = [...new Set(sessions.map(s => s.cwd).filter(Boolean))];
  const title = `${front && front.windowTitle || ''}`.toLowerCase();
  for (const d of dirs) {
    if (title && title.includes(path.basename(d).toLowerCase())) {
      return { path: (await gitTop(d)) || d, how: `the window title mentions ${path.basename(d)}, where a Claude session runs` };
    }
  }
  return null;
}

export async function resolveRepo({ url, front, sessions = [] }) {
  if (url) { const r = await repoFromUrl(url); if (r) return r; }
  if (front && front.pid && !front.browser) {     // an editor or terminal: the folder it runs in
    const top = await gitTop(await cwdOfPid(front.pid));
    if (top && top !== os.homedir()) return { path: top, how: `${front.appName} runs in ${top}` };
  }
  return repoFromSessions(front, sessions);
}

// What a reader of the repo would want to know first: where it stands and what it is built with.
async function repoFacts(repo) {
  const g = (...a) => run('git', ['-C', repo, ...a], { timeout: 3000 }).then(r => (r.ok ? r.out.trim() : ''));
  const [branch, status, log, remote] = await Promise.all([g('rev-parse', '--abbrev-ref', 'HEAD'),
    g('status', '--short'), g('log', '--oneline', '-5'), g('remote', 'get-url', 'origin')]);
  const facts = { path: repo, branch, remote, recentCommits: log ? log.split('\n') : [],
    changedFiles: status ? status.split('\n').slice(0, 30) : [] };
  try {
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const known = ['next', 'react', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', '@angular/core', 'solid-js', 'astro', 'vite',
      'tailwindcss', 'styled-components', '@emotion/react', '@mui/material', '@chakra-ui/react', 'bootstrap', 'sass'];
    facts.stack = known.filter(k => deps[k]).map(k => `${k}@${deps[k]}`);
    facts.packageName = pkg.name;
  } catch { /* not a JS project */ }
  return facts;
}

// The texts, ids and test ids we saw, looked up in the repo's tracked files: where the code most likely is.
async function findInRepo(repo, needles) {
  const hits = [];
  for (const n of needles.slice(0, 10)) {
    const r = await run('git', ['-C', repo, 'grep', '-n', '-I', '-F', '--max-count=3', '-e', n, '--', ':!*.lock', ':!*lock.json', ':!*.min.*', ':!dist', ':!build'], { timeout: 4000 });
    const lines = r.out.split('\n').filter(Boolean).slice(0, 8);
    if (lines.length) hits.push({ needle: n, matches: lines.map(l => l.length > 220 ? `${l.slice(0, 220)}…` : l) });
  }
  return hits;
}

function needlesFrom(ctx) {
  const out = new Set();
  const els = (ctx.browser && ctx.browser.dom && ctx.browser.dom.elements) || [];
  for (const e of els) {
    if (e.testId) out.add(e.testId);
    if (e.id) out.add(e.id);
    if (e.text && e.text.length >= 2 && e.text.length <= 60) out.add(e.text);
    if (e.ariaLabel) out.add(e.ariaLabel);
  }
  if (!els.length) for (const l of (ctx.ocr && ctx.ocr.lines) || []) if (l.text.length >= 3 && l.text.length <= 60) out.add(l.text);
  return [...out];
}

// ---------------------------------------------------------------- all of it

// rect is in screen points; display is Electron's display under it; dir is where the bundle goes.
export async function gatherZone(rect, { display, front, sessions = [], dir, configDir: cfg, bridge, sandbox }) {
  mkdirSync(dir, { recursive: true });
  const ctx = { version: 1, time: new Date().toISOString(), zone: rect, notes: [],
    display: display ? { bounds: display.bounds, scaleFactor: display.scaleFactor } : null, front: front || null };

  const zoneFile = path.join(dir, 'zone.png'), aroundFile = path.join(dir, 'around.png');
  const bounds = display ? display.bounds : { x: 0, y: 0, width: 1e5, height: 1e5 };
  const around = grow(rect, Math.max(160, Math.round(Math.max(rect.width, rect.height) * 0.75)), bounds);
  const [z, a] = [await capture(rect, zoneFile), await capture(around, aroundFile)];
  ctx.images = { zone: z ? 'zone.png' : null, around: a ? 'around.png' : null, aroundRect: around };
  if (!z) ctx.notes.push('no screenshot: give Clippit (Electron while in development) Screen Recording permission in System Settings → Privacy & Security');

  const [text, web] = await Promise.all([
    z ? ocr(zoneFile, cfg) : Promise.resolve({ lines: [] }),
    front && front.browser ? browser(front, rect, bridge) : Promise.resolve(null),
  ]);
  ctx.ocr = { lines: text.lines };
  if (text.note) ctx.notes.push(text.note);
  if (web) { ctx.browser = { url: web.url, title: web.title, dom: web.dom }; ctx.notes.push(...web.notes); }

  const repo = await resolveRepo({ url: web && web.url, front, sessions });
  if (repo) await addRepo(ctx, repo.path, repo.how, sessions);
  else if (web && (ctx.sandbox = sandboxFor(web.url, sandboxBase(sandbox)))) { /* built in a scratch folder on send */ }
  else ctx.notes.push("couldn't tell which project this is; I'll ask when you send it");
  return ctx;
}

// Also used when you pick the folder yourself.
export async function addRepo(ctx, repoPath, how, sessions = []) {
  const top = (await gitTop(repoPath)) || repoPath;
  ctx.repo = { ...(await repoFacts(top)), how };
  ctx.repo.likelySource = await findInRepo(top, needlesFrom(ctx));
  ctx.repo.sessions = sessions.filter(s => s.cwd && s.cwd.startsWith(top)).map(s => ({ title: s.title, status: s.status }));
  return ctx;
}

// A few words for the balloon: what Clippit found, so you can see he understood before you type.
export function summarize(ctx) {
  const bits = [];
  if (ctx.browser && ctx.browser.url) bits.push(ctx.browser.url.replace(/^https?:\/\//, '').slice(0, 60));
  else if (ctx.front && ctx.front.appName) bits.push(ctx.front.appName + (ctx.front.windowTitle ? ` — ${ctx.front.windowTitle}`.slice(0, 50) : ''));
  const els = ctx.browser && ctx.browser.dom && ctx.browser.dom.elements;
  if (els && els.length) {
    const kinds = {};
    for (const e of els) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    bits.push(Object.entries(kinds).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', '));
  } else if (ctx.ocr && ctx.ocr.lines.length) bits.push(`text: “${ctx.ocr.lines.map(l => l.text).join(' ').slice(0, 50)}”`);
  if (ctx.repo) bits.push(`repo: ${path.basename(ctx.repo.path)}${ctx.repo.branch ? ` (${ctx.repo.branch})` : ''}`);
  else if (ctx.sandbox) bits.push(`not your code, so I'll build in clippit-sandbox/${ctx.sandbox.host}`);
  if (ctx.repo && ctx.repo.likelySource && ctx.repo.likelySource.length) {
    const files = new Set(ctx.repo.likelySource.flatMap(h => h.matches.map(m => m.split(':')[0])));
    bits.push(`${files.size} likely source file${files.size === 1 ? '' : 's'}`);
  }
  return bits;
}

// ---------------------------------------------------------------- the bundle Claude reads

function md(ctx, request) {
  const L = [];
  L.push('# Marked zone', '');
  if (request) L.push('## What the user asked', '', request, '');
  L.push('## What was marked', '');
  L.push(`- Zone on screen: ${ctx.zone.width}×${ctx.zone.height} pt at (${ctx.zone.x}, ${ctx.zone.y})`);
  if (ctx.images.zone) L.push('- Screenshot of exactly the zone: `zone.png`');
  if (ctx.images.around) L.push('- The zone with its surroundings: `around.png`');
  if (ctx.front) L.push(`- App: ${ctx.front.appName}${ctx.front.windowTitle ? `, window “${ctx.front.windowTitle}”` : ''}`);
  if (ctx.browser) L.push(`- Page: ${ctx.browser.url || '?'}${ctx.browser.title ? ` (“${ctx.browser.title}”)` : ''}`);
  L.push('');
  if (ctx.ocr.lines.length) {
    L.push('## Text visible in the zone (OCR)', '');
    for (const l of ctx.ocr.lines) L.push(`- “${l.text}”`);
    L.push('');
  }
  const dom = ctx.browser && ctx.browser.dom;
  if (dom) {
    L.push('## Page elements inside the zone', '');
    if (dom.page) L.push(`Page: viewport ${dom.page.viewport}, frameworks seen: ${dom.page.frameworks.join(', ') || 'none detected'}`, '');
    for (const e of dom.elements || []) {
      L.push(`### ${e.kind}: ${e.text ? `“${e.text}”` : e.tag}`, '');
      L.push(`- selector: \`${e.selector}\``);
      if (e.component) L.push(`- component: ${e.component}${e.source ? ` (${e.source})` : ''}`);
      if (e.classes) L.push(`- classes: \`${e.classes}\``);
      for (const k of ['id', 'testId', 'role', 'ariaLabel', 'href', 'type', 'disabled']) if (e[k] !== undefined && e[k] !== '') L.push(`- ${k}: ${e[k]}`);
      if (e.styles) L.push(`- computed styles: ${Object.entries(e.styles).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
      if (e.html) L.push('', '```html', e.html, '```');
      L.push('');
    }
    if (dom.container) {
      L.push('### Closest common container', '', `- selector: \`${dom.container.selector}\``, '', '```html', dom.container.html, '```', '');
    }
  }
  if (ctx.repo) {
    const r = ctx.repo;
    L.push('## Repository', '');
    L.push(`- Path: ${r.path}`, `- Found because: ${r.how}`);
    if (r.branch) L.push(`- Branch: ${r.branch}`);
    if (r.remote) L.push(`- Remote: ${r.remote}`);
    if (r.stack && r.stack.length) L.push(`- Stack: ${r.stack.join(', ')}`);
    if (r.changedFiles.length) L.push(`- Uncommitted changes: ${r.changedFiles.length} file(s)`);
    if (r.recentCommits.length) L.push('- Recent commits:', ...r.recentCommits.map(c => `  - ${c}`));
    if (r.sessions && r.sessions.length) L.push(`- Other Claude sessions in this repo: ${r.sessions.map(s => `${s.title} (${s.status})`).join('; ')}`);
    L.push('');
    if (r.likelySource && r.likelySource.length) {
      L.push('## Where the marked things probably live (git grep for texts/ids seen in the zone)', '');
      for (const h of r.likelySource) L.push(`- “${h.needle}”`, ...h.matches.map(m => `  - \`${m}\``));
      L.push('');
    }
  }
  if (ctx.notes.length) L.push('## What Clippit could not collect', '', ...ctx.notes.map(n => `- ${n}`), '');
  return L.join('\n');
}

export function writeBundle(dir, ctx, request = '') {
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify({ ...ctx, request }, null, 2) + '\n');
  writeFileSync(path.join(dir, 'context.md'), md(ctx, request));
  return path.join(dir, 'context.md');
}

export const _test = { parseLsappinfo, grow, needlesFrom, md, LOCAL };
