// Runs a Claude task on your own server instead of this computer, only when you say yes to it.
//
// One run, start to finish, over plain ssh (your ~/.ssh/config alias, keys only, never a password):
//   1. upload   a copy of the repo (tracked and untracked files, not ignored ones) and the zone bundle
//               into a fresh /tmp/clippit-offload-<id> on the server
//   2. run      `claude -p` headless in that copy, streaming its events back for Clippit's balloon
//   3. fetch    what it changed, as a git patch you can apply here or throw away
//   4. close    always, whether it finished, failed, was stopped or timed out: kill its process group,
//               delete the folder, and check that nothing of it is left. Nothing stays open or idles.
//
// Three guards make sure of step 4: the remote run dies with the ssh connection (a watchdog on its
// stdin), it has a hard time limit there (`timeout`) and here, and a journal file here remembers every
// run until its cleanup is confirmed, so a crash or a lost network is cleaned up on the next start.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const CLEAN = 'CLIPPIT-OFFLOAD-CLEAN';

export const configured = settings => !!(settings && String(settings.offloadHost || '').trim());

// No RemoteCommand or TTY from the alias (`tars`-style entries start tmux), no prompts, and a dead
// connection is noticed within a minute.
export function sshArgs(host) {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', host, '--'];
}

function run(cmd, args, { input, stdin = 'pipe', timeout = 0, env } = {}) {
  return new Promise(resolve => {
    let out = '', err = '', done = false;
    const p = spawn(cmd, args, { stdio: [stdin, 'pipe', 'pipe'], env: env || process.env });
    const t = timeout ? setTimeout(() => p.kill('SIGKILL'), timeout) : null;
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    const finish = code => { if (done) return; done = true; clearTimeout(t); resolve({ ok: code === 0, code, out, err }); };
    p.on('error', e => { err += e.message; finish(-1); });
    p.on('close', finish);
    if (p.stdin) { if (input !== undefined) p.stdin.end(input); else if (stdin === 'pipe') p.stdin.end(); }
  });
}

// `a | b`, both spawned directly; ok only if both exit 0.
function pipe([c1, a1, o1 = {}], [c2, a2]) {
  return new Promise(resolve => {
    const p1 = spawn(c1, a1, { stdio: ['ignore', 'pipe', 'pipe'], cwd: o1.cwd, env: o1.env || process.env });
    const p2 = spawn(c2, a2, { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '', codes = [null, null];
    p1.stderr.on('data', d => { err += d; });
    p2.stderr.on('data', d => { err += d; });
    p2.stdout.resume();
    p1.stdout.pipe(p2.stdin);
    p2.stdin.on('error', () => {});
    const end = () => { if (codes.every(c => c !== null)) resolve({ ok: codes[0] === 0 && codes[1] === 0, err: err.trim() }); };
    p1.on('error', e => { err += e.message; codes[0] = -1; p2.stdin.end(); end(); });
    p2.on('error', e => { err += e.message; codes[1] = -1; end(); });
    p1.on('close', c => { codes[0] ??= c; end(); });
    p2.on('close', c => { codes[1] ??= c; end(); });
  });
}

// The files a copy needs: what git tracks or would track, minus deleted ones. Not a git repo: everything
// except the usual heavy folders.
async function fileList(repo) {
  const r = await run('git', ['-C', repo, 'ls-files', '-z', '-co', '--exclude-standard'], { timeout: 15000 });
  if (r.ok) {
    return r.out.split('\0').filter(f => f && (() => { try { lstatSync(path.join(repo, f)); return true; } catch { return false; } })());
  }
  return null;
}

// What runs on the server. It is uploaded as run.sh next to the copy, so nothing needs quoting.
export function remoteScript({ dir, minutes, claudeArgs }) {
  const args = claudeArgs.map(sq).join(' ');
  return `#!/usr/bin/env bash
# Clippit offload run. Everything lives in ${dir} and is deleted by Clippit afterwards.
set -u
exec 3<&0                     # ssh's stdin, for the watchdog below (background jobs get /dev/null)
D=${sq(dir)}
say() { printf '{"type":"clippit","%s":%s}\\n' "$1" "$2"; }
cd "$D/work" || { say error '"the upload is missing on the server"'; exit 90; }
command -v claude >/dev/null 2>&1 || { say error '"claude is not installed on the server (or not on PATH for this user)"'; exit 91; }
git init -q . && git add -A && git -c user.email=clippit@localhost -c user.name=Clippit commit -q --no-verify --allow-empty -m base
TO=""; command -v timeout >/dev/null 2>&1 && TO="timeout --kill-after=15 ${Math.max(1, Math.round(minutes * 60))}"
set -m                        # job control: claude gets its own process group, so it can be killed whole
$TO claude -p --output-format stream-json --verbose ${args} < "$D/prompt.md" 3<&- &
pid=$!
echo "$pid" > "$D/pid"
echo "$pid" > "$D/pgid"
# If Clippit or the network goes away, ssh closes our stdin: stop everything at once.
( cat <&3 > /dev/null; kill -TERM -- -"$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null ) > /dev/null 2>&1 &
w=$!
wait "$pid"; rc=$?
pkill -P "$w" 2>/dev/null; kill "$w" 2>/dev/null
# Anything claude left running in the background goes too.
kill -TERM -- -"$pid" 2>/dev/null
git add -A && git diff --cached --binary HEAD > "$D/result.patch"
say exit "$rc"
`;
}

// Kill whatever is left of the run, delete its folder, and say CLEAN only when both are true.
export function cleanupCommand(dir) {
  const D = sq(dir);
  return `D=${D}; g=""; [ -f "$D/pgid" ] && g=$(cat "$D/pgid"); p=""; [ -f "$D/pid" ] && p=$(cat "$D/pid"); `
    + `if [ -n "$g" ]; then kill -TERM -- -"$g" 2>/dev/null; sleep 1; kill -KILL -- -"$g" 2>/dev/null; fi; `
    + `if [ -n "$p" ]; then kill -KILL "$p" 2>/dev/null; fi; rm -rf "$D"; left=0; `
    + `if [ -n "$g" ] && pgrep -g "$g" >/dev/null 2>&1; then left=1; fi; `
    + `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then left=1; fi; `
    + `if [ ! -e "$D" ] && [ "$left" = 0 ]; then echo ${CLEAN}; fi`;
}

// A short line for the balloon from one stream-json event, or null.
export function describe(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'system' && ev.subtype === 'init') return { line: `Claude started${ev.model ? ` (${ev.model})` : ''}` };
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const tool = ev.message.content.filter(c => c.type === 'tool_use').pop();
    if (tool) {
      const i = tool.input || {};
      const what = i.command || i.file_path || i.pattern || i.path || i.description || '';
      return { line: `${tool.name}${what ? `: ${String(what).split('\n')[0].slice(0, 90)}` : ''}`, tool: tool.name };
    }
    const text = ev.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
    if (text) return { line: text.split('\n')[0].slice(0, 120) };
  }
  if (ev.type === 'result') {
    return { result: { ok: !ev.is_error && ev.subtype === 'success', text: String(ev.result || '').trim(),
      cost: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null, turns: ev.num_turns || 0,
      seconds: ev.duration_ms ? Math.round(ev.duration_ms / 1000) : 0, subtype: ev.subtype } };
  }
  if (ev.type === 'clippit' && ev.error) return { error: ev.error };
  if (ev.type === 'clippit' && 'exit' in ev) return { exit: Number(ev.exit) };
  return null;
}

// ---------------------------------------------------------------- the journal of runs not yet closed

const journalDir = configDir => path.join(configDir, 'offload');

function journal(configDir, id, data) {
  mkdirSync(journalDir(configDir), { recursive: true });
  writeFileSync(path.join(journalDir(configDir), `${id}.json`), JSON.stringify(data, null, 2) + '\n');
}

function unjournal(configDir, id) { rmSync(path.join(journalDir(configDir), `${id}.json`), { force: true }); }

export function leftovers(configDir) {
  const d = journalDir(configDir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.json')).map(f => {
    try { return { id: f.slice(0, -5), ...JSON.parse(readFileSync(path.join(d, f), 'utf8')) }; } catch { return null; }
  }).filter(Boolean);
}

// Closes one run on the server. Retries a few times: a run must never stay open because of one hiccup.
export async function closeRemote({ host, dir, ssh = 'ssh', tries = 3 }) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    const r = await run(ssh, [...sshArgs(host), cleanupCommand(dir)], { timeout: 30000 });
    if (r.out.includes(CLEAN)) return { ok: true };
    last = (r.err || r.out).trim().split('\n').pop() || `exit ${r.code}`;
    await new Promise(res => setTimeout(res, 1500 * (i + 1)));
  }
  return { ok: false, why: last };
}

// Startup: close what an earlier Clippit left (it crashed, or the Mac slept through the cleanup).
export async function sweep({ configDir, ssh = 'ssh' }) {
  const out = [];
  for (const j of leftovers(configDir)) {
    const r = await closeRemote({ host: j.host, dir: j.dir, ssh });
    if (r.ok) unjournal(configDir, j.id);
    out.push({ ...j, ...r });
  }
  return out;
}

// ---------------------------------------------------------------- one run

// `prompt` is the text, or a function of the server folder (the bundle lands in <dir>/zone there).
// Returns { id, cancel(), done } at once; `done` resolves to the outcome after the server is closed.
// onStatus({ phase, line }) is called along the way: upload, running (with what Claude does), fetch, close.
export function startOffload({ host, repo, bundleDir, prompt, minutes = 30, claudeArgs = [], configDir, ssh = 'ssh',
  grace = 60, onStatus = () => {} }) {
  const id = randomBytes(6).toString('hex');
  const dir = `/tmp/clippit-offload-${id}`;
  let child = null, cancelled = null, timer = null;
  const S = (phase, line) => { try { onStatus({ id, phase, line }); } catch { /* the UI's problem */ } };
  const R = cmd => [...sshArgs(host), cmd];

  const cancel = (why = 'stopped') => {
    if (cancelled) return;
    cancelled = why;
    if (child) child.kill('SIGTERM');       // closes ssh, so the watchdog on the server stops claude
  };

  const work = async () => {
    const outcome = { id, host, dir, ok: false, cancelled: null, error: null, result: null, patch: null, patchFile: null, closed: null };
    journal(configDir, id, { host, dir, repo, started: Date.now() });
    try {
      // 1. upload: the repo copy, then the bundle + prompt + run.sh
      S('upload', `copying ${path.basename(repo)} to the server`);
      const files = await fileList(repo);
      const listFile = path.join(bundleDir, 'offload-files.txt');
      const tarArgs = files ? ['-czf', '-', '--null', '-T', listFile] : ['-czf', '-', '--exclude=node_modules', '--exclude=.git', '.'];
      if (files) writeFileSync(listFile, files.join('\0'));
      const env = { ...process.env, COPYFILE_DISABLE: '1' };        // no ._ AppleDouble files from macOS tar
      const up = await pipe(['tar', tarArgs, { cwd: repo, env }],
        [ssh, R(`umask 077 && mkdir -p ${sq(dir)}/work ${sq(dir)}/zone && tar -xzf - -C ${sq(dir)}/work 2>/dev/null; test -d ${sq(dir)}/work`)]);
      if (!up.ok) throw new Error(`couldn't copy the project to the server: ${up.err.split('\n').pop() || 'ssh failed'}`);
      if (cancelled) throw new Error('stopped');
      writeFileSync(path.join(bundleDir, 'prompt.md'), typeof prompt === 'function' ? prompt(dir) : prompt);
      writeFileSync(path.join(bundleDir, 'run.sh'), remoteScript({ dir, minutes, claudeArgs }));
      const up2 = await pipe(['tar', ['-czf', '-', '--exclude=offload-files.txt', '--exclude=server.patch', '.'], { cwd: bundleDir, env }],
        [ssh, R(`tar -xzf - -C ${sq(dir)}/zone 2>/dev/null && mv ${sq(dir)}/zone/prompt.md ${sq(dir)}/zone/run.sh ${sq(dir)}/`)]);
      if (!up2.ok) throw new Error(`couldn't copy the request to the server: ${up2.err.split('\n').pop() || 'ssh failed'}`);
      if (cancelled) throw new Error('stopped');

      // 2. run, with stdin held open: closing it (cancel, crash, lost network) stops claude there
      S('running', 'Claude is starting on the server');
      timer = setTimeout(() => cancel('timed out'), (minutes * 60 + grace) * 1000);
      const ran = await new Promise(resolve => {
        child = spawn(ssh, R(`bash ${sq(dir)}/run.sh`), { stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '', err = '', exit = null, error = null;
        child.stdin.on('error', () => {});
        child.stdout.on('data', d => {
          buf += d;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            let ev = null;
            try { ev = JSON.parse(line); } catch { continue; }
            const d2 = describe(ev);
            if (!d2) continue;
            if (d2.result) outcome.result = d2.result;
            else if (d2.error) error = d2.error;
            else if ('exit' in d2) exit = d2.exit;
            else if (d2.line) S('running', d2.line);
          }
        });
        child.stderr.on('data', d => { err += d; });
        child.on('error', e => resolve({ exit: -1, error: e.message }));
        child.on('close', code => resolve({ exit: exit ?? code, error, err: err.trim() }));
      });
      child = null;
      clearTimeout(timer);
      if (cancelled) throw new Error(cancelled);
      if (ran.error) throw new Error(ran.error);
      if (ran.exit !== 0 && !outcome.result) throw new Error(`claude stopped on the server (exit ${ran.exit})${ran.err ? `: ${ran.err.split('\n').pop()}` : ''}`);

      // 3. fetch the changes
      S('fetch', 'bringing the changes back');
      const p = await run(ssh, R(`cat ${sq(dir)}/result.patch`), { timeout: 60000 });
      if (p.ok) {
        outcome.patch = p.out;
        if (p.out.trim()) {
          outcome.patchFile = path.join(bundleDir, 'server.patch');
          writeFileSync(outcome.patchFile, p.out);
        }
      }
      outcome.ok = !!(outcome.result && outcome.result.ok);
      if (!outcome.ok && !outcome.error) outcome.error = outcome.result ? `Claude ended with ${outcome.result.subtype || 'an error'}` : 'no result from Claude';
    } catch (e) {
      outcome.error = e.message;
      outcome.cancelled = cancelled;
    } finally {
      clearTimeout(timer);
      if (child) child.kill('SIGTERM');
      // 4. close, always
      S('close', 'closing everything on the server');
      outcome.closed = await closeRemote({ host, dir, ssh });
      if (outcome.closed.ok) unjournal(configDir, id);
    }
    return outcome;
  };

  return { id, dir, cancel, done: work() };
}

// Applies a fetched patch to the repo here. `git apply --3way` keeps your own edits since the upload.
export async function applyPatch(repo, patchFile) {
  const r = await run('git', ['-C', repo, 'apply', '--3way', '--whitespace=nowarn', patchFile], { timeout: 20000 });
  return { ok: r.ok, why: (r.err || r.out).trim().split('\n').slice(-2).join(' ') };
}

export function patchFiles(patch) {
  return [...String(patch || '').matchAll(/^diff --git a\/(.+?) b\//gm)].map(m => m[1]);
}

// Is the server there? Reads the alias with `ssh -G` (local, contacts nothing) and opens a TCP connection
// to its ssh port. Logs in to nothing and runs nothing on the server.
export async function reachable(host, { ssh = 'ssh' } = {}) {
  const g = await run(ssh, ['-G', host], { timeout: 5000 });
  const conf = Object.fromEntries(g.out.split('\n').map(l => l.trim().split(/\s+/)).filter(a => a.length >= 2).map(([k, ...v]) => [k.toLowerCase(), v.join(' ')]));
  const hostname = conf.hostname || host, port = Number(conf.port) || 22;
  const { connect } = await import('node:net');
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = connect({ host: hostname, port, timeout: 5000 });
    const end = (ok, why) => { sock.destroy(); resolve({ ok, hostname, port, ms: Date.now() - t0, why }); };
    sock.once('connect', () => end(true));
    sock.once('timeout', () => end(false, 'no answer within 5 seconds'));
    sock.once('error', e => end(false, e.code || e.message));
  });
}
