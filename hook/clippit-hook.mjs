#!/usr/bin/env node
// Claude Code hook → Clippit. Registered with "async": true for each event, so it can never block or
// change Claude: it reads the hook JSON from stdin, adds where the session runs (process chain,
// terminal), posts it to the running Clippit app and exits 0 quietly, whatever happens.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { configDir, readConnection } from '../lib/config.mjs';

const ENV_KEYS = ['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM', 'KITTY_WINDOW_ID', 'KITTY_PID', 'KITTY_LISTEN_ON',
  'TMUX', 'TMUX_PANE', 'WEZTERM_PANE', 'ALACRITTY_WINDOW_ID', 'WINDOWID', 'WT_SESSION', 'ZELLIJ', 'ZELLIJ_SESSION_NAME',
  'VSCODE_PID', 'TERMINAL_EMULATOR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_REMOTE', 'SSH_CONNECTION',
  'CLAUDE_CODE_HOST_SESSION_ID', '__CFBundleIdentifier'];

function linuxChain(start) {
  const chain = [];
  for (let pid = start, i = 0; pid > 1 && i < 16; i++) {
    let stat;
    try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { break; }
    const close = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    chain.push({ pid, comm });
    pid = Number(stat.slice(close + 2).split(' ')[1]);
  }
  return chain;
}

function macChain(start) {
  const chain = [];
  let tty;
  for (let pid = start, i = 0; pid > 1 && i < 16; i++) {
    let out;
    try { out = execFileSync('ps', ['-o', 'ppid=,tty=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 500 }).trim(); }
    catch { break; }
    const m = out.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) break;
    chain.push({ pid, comm: m[3].split('/').pop() });
    if (!tty && m[2] && m[2] !== '??') tty = `/dev/${m[2].startsWith('tty') ? m[2] : `tty${m[2]}`}`;
    pid = Number(m[1]);
  }
  return { chain, tty };
}

async function main() {
  if (process.env.CLIPPIT_INTERNAL) return;               // Clippit's own `claude -p` calls
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let event;
  try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
  const conn = readConnection(configDir());
  if (!conn || !conn.port || !conn.token) return;

  const origin = { platform: process.platform, time: Date.now(), env: {} };
  for (const k of ENV_KEYS) if (process.env[k]) origin.env[k] = process.env[k];
  if (process.platform === 'linux') origin.pids = linuxChain(process.ppid);
  else if (process.platform === 'darwin') {
    const { chain, tty } = macChain(process.ppid);
    origin.pids = chain;
    origin.tty = tty;
  } else origin.pids = [{ pid: process.ppid }];

  const body = JSON.stringify({ event, origin });
  await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: conn.port, path: '/hook', method: 'POST', timeout: 1500,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-clippit-token': conn.token } },
    res => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', resolve);                              // Clippit isn't running: nothing to do
    req.end(body);
  });
}

main().catch(() => {}).finally(() => process.exit(0));
