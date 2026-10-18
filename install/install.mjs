// Registers Clippit's hook with Claude Code (user settings), or removes it with --uninstall.
//
//   node install/install.mjs [--uninstall] [--settings <path>] [--no-link]
//
// Every hook is async (it can never block or change Claude) and in exec form (no shell). Existing
// hooks are kept; Clippit's own entries are recognised by the hook script path, so running this
// again changes nothing and --uninstall removes only what it added. settings.json is backed up first.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ready } from './setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK = path.join(root, 'hook', 'clippit-hook.mjs');
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop',
  'StopFailure', 'SubagentStart', 'PreCompact', 'SessionEnd'];

const isOurs = h => h && h.type === 'command' && [h.command, ...(h.args || [])].some(a => String(a).endsWith('clippit-hook.mjs'));

export function removeHooks(settings) {
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = hooks[ev]
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) }))
      .filter(g => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

export function addHooks(settings, { node = process.execPath, hook = HOOK } = {}) {
  removeHooks(settings);
  settings.hooks = settings.hooks || {};
  for (const ev of EVENTS) {
    const entry = { type: 'command', command: node, args: [hook], async: true, timeout: 10 };
    (settings.hooks[ev] = settings.hooks[ev] || []).push({ hooks: [entry] });
  }
  return settings;
}

// Windows has no symlinks without admin rights: a one-line clippit.cmd in a folder on PATH calls ours.
const WIN_MARK = 'rem clippit launcher';
function windowsLauncher(uninstall) {
  const onPath = String(process.env.PATH || '').split(';').map(d => path.resolve(d.replace(/"/g, '')).toLowerCase());
  const dirs = [path.join(os.homedir(), '.local', 'bin'), path.join(process.env.APPDATA || '', 'npm')];
  for (const d of dirs) {
    const f = path.join(d, 'clippit.cmd');
    let current = null;
    try { current = readFileSync(f, 'utf8'); } catch { /* none yet */ }
    if (uninstall) { if (current && current.includes(WIN_MARK)) rmSync(f); continue; }
    if (current && !current.includes(WIN_MARK)) return null;     // never replace a file we didn't make
    if (!onPath.includes(path.resolve(d).toLowerCase())) continue;
    writeFileSync(f, `@echo off\r\n${WIN_MARK} (npm run install-hooks wrote this)\r\ncall "${path.join(root, 'bin', 'clippit.cmd')}" %*\r\n`);
    return f;
  }
  return null;
}

function linkLauncher(uninstall) {
  if (process.platform === 'win32') return windowsLauncher(uninstall);
  const link = path.join(os.homedir(), '.local', 'bin', 'clippit');
  let current = null;
  try { current = lstatSync(link); } catch { /* none yet */ }
  if (uninstall) {
    if (current && current.isSymbolicLink()) rmSync(link);
    return null;
  }
  if (current) return current.isSymbolicLink() ? link : null;     // never replace a file we didn't make
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(path.join(root, 'bin', 'clippit'), link);
  return link;
}

function main(argv) {
  const uninstall = argv.includes('--uninstall');
  const at = argv.indexOf('--settings');
  const file = at >= 0 ? path.resolve(argv[at + 1])
    : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  let settings = {};
  if (existsSync(file)) {
    try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      console.error(`clippit: ${file} is not valid JSON (${e.message}); fix it first, nothing was changed.`);
      process.exit(1);
    }
    const backup = `${file}.clippit-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
    console.log(`backed up ${file} → ${backup}`);
  }
  if (uninstall) removeHooks(settings); else addHooks(settings);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.clippit-tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, file);
  console.log(uninstall ? `removed Clippit's hooks from ${file}` : `added Clippit's hook for ${EVENTS.length} events to ${file}`);
  if (!argv.includes('--no-link')) {
    const link = linkLauncher(uninstall);
    if (link) console.log(`launcher: ${link}`);
  }
  if (!uninstall) {
    if (!ready()) console.log('\nClippit still needs his frames and sounds: run `npm run setup` once.');
    console.log(process.platform === 'win32'
      ? '\nStart Clippit with `clippit` (or bin\\clippit.cmd); after the first start he is also in the Start menu.'
      : '\nStart Clippit with `clippit` (Linux/macOS) or bin\\clippit.cmd (Windows).');
    console.log('Running Claude Code sessions pick up the hooks after /hooks or a restart.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
