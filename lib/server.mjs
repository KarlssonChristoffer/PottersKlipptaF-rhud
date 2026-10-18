// The local endpoint the Claude Code hook posts to: 127.0.0.1 only, a per-start token, JSON only,
// and no Origin header (so a web page in a browser can't talk to it).

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const PREFERRED_PORT = 41177;
const MAX_BODY = 2 * 1024 * 1024;

function sameToken(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function startServer({ onEvent, token: getToken, port = PREFERRED_PORT }) {
  const server = http.createServer((req, res) => {
    const deny = (code) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(); };
    if (req.headers.origin) return deny(403);
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('clippit');
    }
    if (req.method !== 'POST' || req.url !== '/hook') return deny(404);
    if (!sameToken(req.headers['x-clippit-token'], getToken())) return deny(401);
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return deny(415);
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { deny(413); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return deny(400); }
      res.writeHead(204);
      res.end();
      try { onEvent(payload); } catch (e) { console.error('clippit: event failed', e); }
    });
  });
  return new Promise((resolve, reject) => {
    const listen = p => server.listen(p, '127.0.0.1');
    server.on('error', err => {
      if (err.code === 'EADDRINUSE' && port) { port = 0; listen(0); } else reject(err);
    });
    server.on('listening', () => resolve({ port: server.address().port, close: () => server.close() }));
    listen(port);
  });
}
