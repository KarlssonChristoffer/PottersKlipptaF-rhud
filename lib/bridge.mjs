// The bridge to Clippit's browser extension (extension/, "Clippit Says No"): a tiny WebSocket server on
// 127.0.0.1 that only browser extensions can open (their Origin can't be sent by a web page). It replaces
// "Allow JavaScript from Apple Events", which let any app with Automation rights run JavaScript in every
// logged-in tab.
//
// Pairing, trust on first use: the first time an extension connects, Clippit gives it a random key. On
// every later connection the extension sends a fresh nonce and Clippit must answer with
// HMAC(key, nonce), so another program squatting on the port can't make the extension read pages.
//
//   startBridge({ dir, onEvent })   → { request(kind, msg, data), connected(kind), close() }
//   kind is 'safari' or 'chromium'; request() resolves with the extension's answer or rejects on timeout.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { saveJSON } from './config.mjs';

export const BRIDGE_PORT = 41178;
const EXTENSION_ORIGIN = /^(safari-web-extension|chrome-extension|moz-extension):\/\/[\w.-]+$/;
const MAX_FRAME = 8 * 1024 * 1024;

// ---------------------------------------------------------------- WebSocket, the small part we need

function frame(text) {
  const body = Buffer.from(text, 'utf8');
  const head = body.length < 126 ? Buffer.from([0x81, body.length])
    : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(body.length); return b; })()]);
  return Buffer.concat([head, body]);
}

// Reads complete client frames (always masked) off a buffer; returns { messages, rest, close }.
export function readFrames(buf) {
  const messages = [];
  let close = false, partial = [];
  for (;;) {
    if (buf.length < 2) break;
    const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
    let len = buf[1] & 0x7f, at = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); at = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(6); at = 10; }
    if (len > MAX_FRAME) { close = true; break; }
    const need = at + (masked ? 4 : 0) + len;
    if (buf.length < need) break;
    let data = buf.subarray(at + (masked ? 4 : 0), need);
    if (masked) { const m = buf.subarray(at, at + 4); data = Buffer.from(data.map((b, i) => b ^ m[i & 3])); }
    buf = buf.subarray(need);
    if (op === 0x8) { close = true; break; }
    if (op === 0x1 || op === 0x0) { partial.push(data); if (fin) { messages.push(Buffer.concat(partial).toString('utf8')); partial = []; } }
    // pings and pongs need nothing from us
  }
  return { messages, rest: buf, close };
}

// ---------------------------------------------------------------- the bridge

export function startBridge({ dir, onEvent = () => {}, port = BRIDGE_PORT }) {
  const keysFile = path.join(dir, 'extension-keys.json');
  let keys = {};
  try { keys = JSON.parse(readFileSync(keysFile, 'utf8')); } catch { /* none paired yet */ }
  const conns = new Set();
  const pending = new Map();
  let nextId = 1;

  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket) => {
    const origin = req.headers.origin || '';
    if (req.url !== '/ext' || !EXTENSION_ORIGIN.test(origin) || !req.headers['sec-websocket-key']) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { socket, origin, kind: null, ready: false, send: m => socket.write(frame(JSON.stringify(m))) };
    let buf = Buffer.alloc(0);
    socket.on('data', d => {
      buf = Buffer.concat([buf, d]);
      const r = readFrames(buf);
      buf = r.rest;
      for (const text of r.messages) { try { handle(conn, JSON.parse(text)); } catch (e) { console.warn('clippit: bridge', e.message); } }
      if (r.close) socket.end();
    });
    socket.on('error', () => {});
    socket.on('close', () => conns.delete(conn));
  });

  function handle(conn, m) {
    if (m.type === 'hello') {
      conn.kind = m.browser === 'safari' ? 'safari' : 'chromium';
      let key = keys[conn.origin];
      if (!key || !m.paired) {                      // first time (or the extension forgot us): pair it.
        // The extension only accepts a new key when it has none; it checks our proof otherwise.
        key = keys[conn.origin] = randomBytes(32).toString('hex');
        saveJSON(keysFile, keys, 0o600);
        conn.send({ type: 'paired', key });
      } else {
        conn.send({ type: 'proof', nonce: m.nonce, hmac: createHmac('sha256', key).update(String(m.nonce || '')).digest('hex') });
      }
      conn.ready = true;
      conns.add(conn);
      return;
    }
    if (m.type === 'reply' && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.data);
      return;
    }
    if (m.type === 'event') onEvent(m, conn.kind);
  }

  const pick = kind => [...conns].reverse().find(c => c.ready && (!kind || c.kind === kind));

  function request(kind, msg, data = {}, timeout = 5000) {
    const conn = pick(kind);
    if (!conn) return Promise.reject(new Error('not connected'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('the extension did not answer')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      conn.send({ type: 'request', id, msg, data });
    });
  }

  const ping = setInterval(() => { for (const c of conns) c.send({ type: 'ping' }); }, 20000);
  server.on('error', e => console.warn(`clippit: browser bridge not started (${e.code || e.message})`));
  server.listen(port, '127.0.0.1');
  return {
    request,
    connected: kind => !!pick(kind),
    close: () => { clearInterval(ping); for (const c of conns) c.socket.destroy(); server.close(); },
  };
}

export const _test = { frame };
