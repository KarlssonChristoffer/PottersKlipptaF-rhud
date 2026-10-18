// The offload runner against a fake "server": a fake ssh that runs the remote command here with bash,
// and a fake claude on its PATH. Checks the whole round trip and, above all, that nothing is left
// behind on the "server" after a finish, a failure, a stop or a timeout.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describe, leftovers, patchFiles, startOffload, sweep } from '../lib/offload.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'clippit-offload-test-'));
const bin = path.join(tmp, 'bin');
mkdirSync(bin);

// ssh <options...> host -- command  →  bash -c command, with the fake claude first on PATH
const ssh = path.join(bin, 'fake-ssh');
writeFileSync(ssh, `#!/bin/bash
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift
export PATH=${JSON.stringify(bin)}:$PATH
exec bash -c "$*"
`);
// FAKE_MODE: ok (edits a file), fail (error result), hang (sleeps until killed, with a child)
writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
mode=$(cat "$CLIPPIT_FAKE_MODE_FILE" 2>/dev/null || echo ok)
echo '{"type":"system","subtype":"init","model":"fake"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/a.txt"}}]}}'
if [ "$mode" = hang ]; then sleep 300 & sleep 300; exit 0; fi
if [ "$mode" = fail ]; then echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"nope"}'; exit 1; fi
echo changed > src/a.txt; echo new > src/b.txt
echo '{"type":"result","subtype":"success","is_error":false,"result":"Did it.","total_cost_usd":0.12,"num_turns":3,"duration_ms":4000}'
`);
chmodSync(ssh, 0o755);
chmodSync(path.join(bin, 'claude'), 0o755);
const modeFile = path.join(tmp, 'mode');
process.env.CLIPPIT_FAKE_MODE_FILE = modeFile;

function repo() {
  const r = mkdtempSync(path.join(tmp, 'repo-'));
  mkdirSync(path.join(r, 'src'));
  writeFileSync(path.join(r, 'src', 'a.txt'), 'original\n');
  writeFileSync(path.join(r, '.gitignore'), 'secret.txt\n');
  writeFileSync(path.join(r, 'secret.txt'), 'do not upload\n');
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'pipe' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(path.join(r, 'untracked.txt'), 'comes along\n');
  return r;
}

function opts(over = {}) {
  const bundleDir = mkdtempSync(path.join(tmp, 'bundle-'));
  writeFileSync(path.join(bundleDir, 'context.md'), '# zone\n');
  return { host: 'fake', repo: repo(), bundleDir, prompt: 'do the thing\n', minutes: 1, claudeArgs: ['--permission-mode', 'acceptEdits'],
    configDir: mkdtempSync(path.join(tmp, 'cfg-')), ssh, ...over };
}

test('a finished run brings back a patch and leaves nothing on the server', async () => {
  writeFileSync(modeFile, 'ok');
  const o = opts();
  const seen = [];
  const run = startOffload({ ...o, onStatus: s => seen.push(s.phase + ':' + s.line) });
  const out = await run.done;
  assert.equal(out.ok, true, out.error);
  assert.equal(out.result.text, 'Did it.');
  assert.deepEqual(patchFiles(out.patch).sort(), ['src/a.txt', 'src/b.txt']);
  assert.ok(!out.patch.includes('secret'), 'ignored files are not uploaded');
  assert.ok(seen.some(l => l.includes('Edit: src/a.txt')));
  assert.equal(out.closed.ok, true);
  assert.equal(existsSync(run.dir), false);
  assert.deepEqual(leftovers(o.configDir), []);
  assert.ok(readFileSync(out.patchFile, 'utf8').includes('+changed'));
});

test('a failed run is still closed', async () => {
  writeFileSync(modeFile, 'fail');
  const o = opts();
  const run = startOffload(o);
  const out = await run.done;
  assert.equal(out.ok, false);
  assert.equal(out.closed.ok, true);
  assert.equal(existsSync(run.dir), false);
  assert.deepEqual(leftovers(o.configDir), []);
});

test('stopping a run kills claude and everything it started there', async () => {
  writeFileSync(modeFile, 'hang');
  const o = opts();
  let running = false;
  const run = startOffload({ ...o, onStatus: s => { if (s.line && s.line.startsWith('Edit')) running = true; } });
  while (!running) await new Promise(r => setTimeout(r, 50));
  const pid = Number(readFileSync(path.join(run.dir, 'pid'), 'utf8'));
  run.cancel();
  const out = await run.done;
  assert.equal(out.cancelled, 'stopped');
  assert.equal(out.closed.ok, true);
  assert.equal(existsSync(run.dir), false);
  assert.throws(() => process.kill(pid, 0), 'claude is gone');
  assert.equal(execFileSync('bash', ['-c', `pgrep -f '[s]leep 300' || true`]).toString().trim(), '', 'its children are gone');
});

test('a run that takes too long is stopped and closed', async () => {
  writeFileSync(modeFile, 'hang');
  const o = opts({ minutes: 0.02, grace: 1 });
  const run = startOffload(o);
  const out = await run.done;
  assert.equal(out.cancelled, 'timed out');
  assert.equal(out.closed.ok, true);
  assert.equal(existsSync(run.dir), false);
  assert.deepEqual(leftovers(o.configDir), []);
  assert.equal(execFileSync('bash', ['-c', `pgrep -f '[s]leep 300' || true`]).toString().trim(), '');
});

test('a run left by a crash is closed at the next start', async () => {
  const configDir = mkdtempSync(path.join(tmp, 'cfg-'));
  const dir = path.join(tmp, 'clippit-offload-crashed');
  mkdirSync(path.join(dir, 'work'), { recursive: true });
  mkdirSync(path.join(configDir, 'offload'));
  writeFileSync(path.join(configDir, 'offload', 'abc.json'), JSON.stringify({ host: 'fake', dir }));
  const r = await sweep({ configDir, ssh });
  assert.equal(r[0].ok, true);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(leftovers(configDir), []);
});

test('describe turns stream-json into balloon lines', () => {
  assert.equal(describe({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\nmore' } }] } }).line, 'Bash: npm test');
  assert.equal(describe({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.5 }).result.cost, 0.5);
  assert.equal(describe({ type: 'user' }), null);
});
