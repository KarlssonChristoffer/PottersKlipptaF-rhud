// Tests for everything outside Electron: transcript reading, the event reducer, the local server,
// the hook script end to end, the settings.json installer and the character file decompressor.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeConnection } from '../lib/config.mjs';
import { startServer } from '../lib/server.mjs';
import { Sessions, describeTool } from '../lib/sessions.mjs';
import { gist, readTranscript } from '../lib/transcript.mjs';
import { addHooks, removeHooks, EVENTS } from '../install/install.mjs';
import { decompress } from '../install/acs.mjs';
import { composePrompt } from '../lib/handoff.mjs';
import { summarize, _test as zone } from '../lib/zone.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'clippit-test-'));

function transcript() {
  const f = path.join(tmp, 's1.jsonl');
  const lines = [
    { type: 'user', entrypoint: 'cli', cwd: '/home/u/code/shop', gitBranch: 'main', message: { role: 'user', content: 'Add a cart page' } },
    { type: 'ai-title', aiTitle: 'Shop cart page', sessionId: 's1' },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: '/home/u/code/shop/cart.js' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'cost-state', totalCostUSD: 0.42, totalLinesAdded: 30, totalLinesRemoved: 4 },
    'not json at all',
  ];
  writeFileSync(f, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return f;
}

test('transcript: title, project facts and what the last turn did', () => {
  const t = readTranscript(transcript());
  assert.equal(t.title, 'Shop cart page');
  assert.equal(t.entrypoint, 'cli');
  assert.equal(t.branch, 'main');
  assert.equal(t.cost, 0.42);
  assert.deepEqual(t.turn.files, ['/home/u/code/shop/cart.js']);
  assert.deepEqual(t.turn.commands, ['npm test']);
  assert.equal(readTranscript(path.join(tmp, 'missing.jsonl')).title, undefined);
  assert.equal(gist('Done. I added the cart page and wired the route. Tests pass. More text follows here.', 60),
    'Done. I added the cart page and wired the route.');
});

test('sessions: a turn from prompt to finished, with who, where and what', () => {
  let now = 1000;
  const s = new Sessions({ now: () => now });
  const base = { session_id: 's1', transcript_path: transcript(), cwd: '/home/u/code/shop' };
  s.handle({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  s.handle({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Add a cart page' });
  assert.equal(s.get('s1').status, 'working');
  const act = s.handle({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x/cart.js' } });
  assert.equal(act.activity.animation, 'Writing');
  const perm = s.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push' } });
  assert.equal(perm.announcement.kind, 'attention');
  assert.match(perm.announcement.body, /run “git push”/);
  const dup = s.handle({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' });
  assert.equal(dup.announcement, undefined, 'the matching Notification is not announced twice');
  now += 134000;
  const done = s.handle({ ...base, hook_event_name: 'Stop', last_assistant_message: 'Added the cart page. Tests pass.' });
  const a = done.announcement;
  assert.equal(a.kind, 'done');
  assert.equal(a.title, 'Shop cart page');
  assert.equal(a.where, 'shop · main');
  assert.equal(a.stats.duration, '2m 14s');
  assert.deepEqual(a.stats.files, ['cart.js']);
  assert.equal(a.body, 'Added the cart page. Tests pass.');
  assert.equal(s.get('s1').status, 'idle');
  assert.equal(s.handle({ ...base, hook_event_name: 'Stop', stop_hook_active: true }).announcement, undefined);
  const err = s.handle({ ...base, hook_event_name: 'StopFailure', error: 'rate_limit' });
  assert.equal(err.announcement.headline, 'hit a rate limit');
  assert.equal(describeTool('mcp__github__create_issue'), 'use github › create_issue');
});

test('server + hook: only the token holder gets in, and the hook delivers the event', async () => {
  const got = [];
  const home = mkdtempSync(path.join(tmp, 'home-'));
  let token = '';
  const srv = await startServer({ onEvent: p => got.push(p), token: () => token, port: 0 });
  token = writeConnection(srv.port, home);
  const post = (headers, body = '{}') => fetch(`http://127.0.0.1:${srv.port}/hook`, { method: 'POST', headers, body }).then(r => r.status);
  assert.equal(await post({ 'content-type': 'application/json' }), 401);
  assert.equal(await post({ 'content-type': 'application/json', 'x-clippit-token': token, origin: 'https://evil.example' }), 403);
  assert.equal(await post({ 'content-type': 'application/json', 'x-clippit-token': token }, '{"ok":1}'), 204);
  const event = { session_id: 'h1', hook_event_name: 'Stop', cwd: '/tmp' };
  const r = spawnSync(process.execPath, [path.join(root, 'hook', 'clippit-hook.mjs')], {
    input: JSON.stringify(event), env: { ...process.env, CLIPPIT_HOME: home, TMUX_PANE: '%3' }, timeout: 5000 });
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout), '', 'the hook prints nothing');
  await new Promise(res => setTimeout(res, 100));
  const last = got[got.length - 1];
  assert.equal(last.event.session_id, 'h1');
  assert.equal(last.origin.env.TMUX_PANE, '%3');
  if (process.platform === 'linux') assert.ok(last.origin.pids.some(p => p.pid === process.pid), 'process chain reaches the caller');
  srv.close();
  const offline = spawnSync(process.execPath, [path.join(root, 'hook', 'clippit-hook.mjs')], {
    input: JSON.stringify(event), env: { ...process.env, CLIPPIT_HOME: home }, timeout: 5000 });
  assert.equal(offline.status, 0, 'exits 0 when Clippit is not running');
});

test('installer: merges with existing hooks, is idempotent, uninstalls only its own', () => {
  const mine = { type: 'command', command: 'prettier --write' };
  const s = { model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } };
  addHooks(s, { node: '/usr/bin/node', hook: '/opt/clippit/hook/clippit-hook.mjs' });
  addHooks(s, { node: '/usr/bin/node', hook: '/opt/clippit/hook/clippit-hook.mjs' });
  assert.equal(Object.keys(s.hooks).length, EVENTS.length);
  assert.equal(s.hooks.Stop.length, 2, 'existing Stop hook kept, ours added once');
  const ours = s.hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(ours, { type: 'command', command: '/usr/bin/node', args: ['/opt/clippit/hook/clippit-hook.mjs'], async: true, timeout: 10 });
  removeHooks(s);
  assert.deepEqual(s, { model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } });
});

test('decompress: Agent literals, an overlapping match and the end marker', () => {
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push(v >> i & 1); };
  const literal = ch => { put(0, 1); put(ch.charCodeAt(0), 8); };
  literal('A');
  literal('B');
  put(1, 1); put(0, 1); put(2 - 1, 6);            // match, short offset 2
  put(1, 1); put(0, 1); put(0, 1);                // length 1 + 0 + 2^1 = 3: copies A, B, A
  put(0xf, 4); put(0xfffff, 20);                  // end of data
  const body = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => { body[i >> 3] |= bit << (i & 7); });
  const block = Buffer.concat([Buffer.from([0]), body, Buffer.alloc(6, 0xff)]);
  assert.equal(decompress(block, 5).toString('latin1'), 'ABABA');
  assert.throws(() => decompress(block, 4), /past the end|out of range/);
  assert.throws(() => decompress(Buffer.from('not compressed!'), 10), /not an Agent-compressed block/);
});

test('zone: local URLs, what to grep for, and the bundle Claude reads', () => {
  for (const h of ['localhost', '127.0.0.1', 'app.localhost', 'shop.test']) assert.ok(zone.LOCAL.test(h), h);
  assert.ok(!zone.LOCAL.test('example.com'));
  assert.deepEqual(zone.grow({ x: 50, y: 50, width: 10, height: 10 }, 100, { x: 0, y: 0, width: 120, height: 1000 }),
    { x: 0, y: 0, width: 120, height: 160 });
  const ctx = { zone: { x: 1, y: 2, width: 300, height: 80 }, images: { zone: 'zone.png', around: null }, notes: ['no URL'],
    front: { appName: 'Google Chrome', windowTitle: 'Shop' }, ocr: { lines: [{ text: 'Spara' }] },
    browser: { url: 'http://localhost:3000/settings', title: 'Settings', dom: { page: { viewport: '1200x800', frameworks: ['React'] },
      elements: [{ kind: 'button', tag: 'button', selector: '[data-testid="save"]', text: 'Spara', testId: 'save',
        component: 'React SaveButton', styles: { color: 'rgb(255, 255, 255)' }, html: '<button>Spara</button>' }] } },
    repo: { path: '/code/shop', how: 'port 3000', branch: 'main', remote: '', stack: ['react@18'], changedFiles: [], recentCommits: [],
      likelySource: [{ needle: 'Spara', matches: ['src/SaveButton.tsx:12:  Spara'] }], sessions: [] } };
  assert.deepEqual(zone.needlesFrom(ctx), ['save', 'Spara']);
  const md = zone.md(ctx, 'Gör knapparna likadana');
  for (const s of ['Gör knapparna likadana', 'localhost:3000/settings', '[data-testid="save"]', 'React SaveButton', 'src/SaveButton.tsx:12', 'no URL']) {
    assert.ok(md.includes(s), s);
  }
  assert.deepEqual(summarize(ctx), ['localhost:3000/settings', '1 button', 'repo: shop (main)', '1 likely source file']);
  const p = composePrompt({ request: 'Gör knapparna likadana', bundleDir: '/z', ctx, extra: 'Use REA.' });
  assert.ok(p.startsWith('Gör knapparna likadana\n') && p.includes('/z/context.md') && p.includes('/z/zone.png') && p.trim().endsWith('Use REA.'));
});

test('browser bridge: only extensions get in, pairing hands out a key once, then Clippit proves itself', async () => {
  const { startBridge, readFrames } = await import('../lib/bridge.mjs');
  const { createHmac } = await import('node:crypto');
  const net = await import('node:net');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clippit-bridge-'));
  const port = 41300 + Math.floor(Math.random() * 500);
  const bridge = startBridge({ dir, port });
  await new Promise(r => setTimeout(r, 100));

  const masked = text => {
    const body = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]);
    return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, Buffer.from(body.map((b, i) => b ^ mask[i & 3]))]);
  };
  function open(origin) {
    return new Promise(resolve => {
      const s = net.connect(port, '127.0.0.1', () => s.write(`GET /ext HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`));
      let buf = Buffer.alloc(0), upgraded = false;
      const got = [];
      s.on('data', d => {
        buf = Buffer.concat([buf, d]);
        if (!upgraded) {
          const end = buf.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = buf.subarray(0, end).toString();
          buf = buf.subarray(end + 4);
          upgraded = true;
          resolve({ status: Number(head.split(' ')[1]), accept: (head.match(/Sec-WebSocket-Accept: (.+)/) || [])[1], s, got,
            send: m => s.write(masked(JSON.stringify(m))), next: () => new Promise(r => { const t = setInterval(() => { if (got.length) { clearInterval(t); r(got.shift()); } }, 10); }) });
        }
        // server frames are unmasked; readFrames handles both
        const r = readFrames(buf);
        buf = r.rest;
        got.push(...r.messages.map(t => JSON.parse(t)));
      });
    });
  }

  const evil = await open('https://evil.example');
  assert.equal(evil.status, 403);
  evil.s.destroy();

  const ext = await open('chrome-extension://abcdefgh');
  assert.equal(ext.status, 101);
  assert.equal(ext.accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');        // RFC 6455's example
  ext.send({ type: 'hello', browser: 'chromium', nonce: 'n1', paired: false });
  const paired = await ext.next();
  assert.equal(paired.type, 'paired');
  assert.match(paired.key, /^[0-9a-f]{64}$/);
  ext.s.destroy();

  const again = await open('chrome-extension://abcdefgh');
  again.send({ type: 'hello', browser: 'chromium', nonce: 'n2', paired: true });
  const proof = await again.next();
  assert.deepEqual(proof, { type: 'proof', nonce: 'n2', hmac: createHmac('sha256', paired.key).update('n2').digest('hex') });
  const answer = bridge.request('chromium', 'probe', { rect: { x: 1 } });
  const req = await again.next();
  assert.equal(req.msg, 'probe');
  again.send({ type: 'reply', id: req.id, data: { url: 'http://localhost:3000/' } });
  assert.deepEqual(await answer, { url: 'http://localhost:3000/' });
  assert.ok(bridge.connected('chromium') && !bridge.connected('safari'));
  again.s.destroy();
  bridge.close();
});

test('voice: phrases with slots, Swedish, dry run, and nothing listens unless turned on', async () => {
  const { VoiceCommands, startVoice, registerProvider, manualProvider, normalize } = await import('../lib/voice.mjs');
  const c = new VoiceCommands();
  const ran = [];
  c.register({ id: 'focus', describe: 'Bring a session forward', phrases: ['focus {session}', 'gå till {session}'], run: a => { ran.push(a.session); return 'ok'; } });
  c.register({ id: 'hide', phrases: ['hide', 'göm dig'], run: () => ran.push('hide') });
  assert.equal(normalize('  Hey, Clippit! Göm dig.'), 'hey clippit göm dig');
  assert.deepEqual(c.match('Focus the shop cart page').args, { session: 'the shop cart page' });
  assert.equal(c.match('Hey Clippy, gå till shop').args.session, 'shop');
  assert.equal(c.match('göm dig tack').id, 'hide');
  assert.equal(c.match('hide the bodies'), null);
  assert.equal((await c.dispatch('focus shop', { dryRun: true })).dryRun, true);
  assert.deepEqual(ran, []);
  assert.equal((await c.dispatch('focus shop')).result, 'ok');
  assert.deepEqual(ran, ['shop']);
  assert.equal((await c.dispatch('sing a song')).reason, 'no-match');

  const quiet = { warn() {} };
  assert.equal(startVoice({ commands: c, settings: {} }).running, false);
  assert.equal(startVoice({ commands: c, settings: { enabled: true, provider: 'nope' }, log: quiet }).running, false);
  const mic = manualProvider();
  registerProvider('manual', () => mic);
  const results = [];
  const v = startVoice({ commands: c, settings: { enabled: true, provider: 'manual', minConfidence: 0.5 }, onResult: r => results.push(r) });
  assert.equal(v.running, true);
  await mic.say('hide');                                   // dry run unless dryRun is false
  await mic.say('hide', { confidence: 0.2 });
  await mic.say('hid', { final: false });
  assert.deepEqual(results.map(r => r.dryRun || r.reason), [true, 'unsure']);
  assert.deepEqual(ran, ['shop']);
  v.stop();
});
