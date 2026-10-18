// Read a Microsoft Agent 2.0 character file (.acs) and export Clippit's sprite atlas, animation data,
// sounds and icons. The file is only ever read as data.
//
// The image decompressor is a port of agentdpv.dll's FUN_60e52a17 (Windows XP SP3, decompiled with
// REA/Ghidra): literal = 0 + 8 bits; match = 1 + a tiered offset + a unary-prefixed length.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

export function decompress(src, outSize) {
  if (src.length <= 7 || src[0] !== 0 || !src.subarray(-6).every(v => v === 0xff)) throw new Error('not an Agent-compressed block');
  const data = Buffer.concat([src, Buffer.alloc(4)]);
  const out = Buffer.alloc(outSize);
  let n = 0, p = 1, b = 0;                        // output length; byte position of the 32-bit window, bit in it
  for (;;) {
    let word = data.readUInt32LE(p);
    if (!(word >>> b & 1)) {                      // literal byte
      if (n >= outSize) throw new Error('literal past the end');
      out[n++] = word >>> (b + 1) & 0xff;
      b += 9;
    } else {
      let offset, base = 1;
      if (!(word >>> (b + 1) & 1)) { offset = (word >>> (b + 2) & 0x3f) + 1; b += 8; }
      else if (!(word >>> (b + 2) & 1)) { offset = (word >>> (b + 3) & 0x1ff) + 0x41; b += 12; }
      else if (!(word >>> (b + 3) & 1)) { offset = (word >>> (b + 4) & 0xfff) + 0x241; b += 16; }
      else {
        const v = word >>> (b + 4) & 0xfffff;
        if (v === 0xfffff) return out.subarray(0, n);
        offset = v + 0x1241; b += 24; base = 2;
      }
      p += b >> 3; b &= 7;
      word = data.readUInt32LE(p);
      let ones = 0;
      while (word >>> (b + ones) & 1) {
        if (++ones > 11) throw new Error('length prefix too long');
      }
      const length = base + (word >>> (b + ones + 1) & ((1 << ones) - 1)) + (1 << ones);
      b += 1 + 2 * ones;
      if (length > outSize - n || offset > n) throw new Error('match out of range');
      for (let i = 0; i < length; i++, n++) out[n] = out[n - offset];   // may overlap, so byte by byte
    }
    p += b >> 3; b &= 7;
  }
}

class Reader {
  constructor(buf, pos = 0) { this.d = buf; this.p = pos; }
  u8() { return this.d.readUInt8(this.p++); }
  u16() { const v = this.d.readUInt16LE(this.p); this.p += 2; return v; }
  i16() { const v = this.d.readInt16LE(this.p); this.p += 2; return v; }
  u32() { const v = this.d.readUInt32LE(this.p); this.p += 4; return v; }
  i32() { const v = this.d.readInt32LE(this.p); this.p += 4; return v; }
  bytes(n) { const v = this.d.subarray(this.p, this.p + n); this.p += n; return v; }
  string() {
    const n = this.u32();
    if (!n) return '';
    const s = this.d.toString('utf16le', this.p, this.p + 2 * n);
    this.p += 2 * n + 2;                          // and the terminator
    return s;
  }
  locator() { return [this.u32(), this.u32()]; }
  at(offset) { return new Reader(this.d, offset); }
}

export function parse(data) {
  const r = new Reader(data);
  if (r.u32() !== 0xabcdabc3) throw new Error('not an Agent 2.0 character file');
  const [charLoc, animLoc, imageLoc, audioLoc] = [r.locator(), r.locator(), r.locator(), r.locator()];

  const c = r.at(charLoc[0]);
  const minor = c.u16(), major = c.u16();
  const localized = c.locator();
  c.bytes(16);                                    // GUID
  const width = c.u16(), height = c.u16();
  const transparent = c.u8();
  const flags = c.u32();
  c.u16(); c.u16();                               // animation set version
  if (flags & 0x20) {                             // voice output
    c.bytes(32); c.u32(); c.u16();
    if (c.u8()) { c.u16(); c.string(); c.u16(); c.u16(); c.string(); }
  }
  let balloon = null;
  if (flags & 0x200) {                            // word balloon
    const lines = c.u8(), chars = c.u8();
    const [fg, bg, border] = [c.bytes(4), c.bytes(4), c.bytes(4)];
    const font = c.string();
    const fontHeight = c.i32(), fontWeight = c.i32();
    c.u8(); c.u8();                               // italic, underline
    const hex = q => q.subarray(0, 3).toString('hex');   // COLORREF: R, G, B, 0
    balloon = { lines, chars, font, fontHeight, fontWeight, fg: hex(fg), bg: hex(bg), border: hex(border) };
  }
  const palette = [];
  for (let i = c.u32(); i > 0; i--) palette.push(c.bytes(4));
  if (c.u8()) for (let i = 0; i < 2; i++) c.bytes(c.u32());   // tray icon: mono + colour DIBs
  const states = {};
  for (let i = c.u16(); i > 0; i--) {
    const name = c.string();
    const list = [];
    for (let j = c.u16(); j > 0; j--) list.push(c.string());
    states[name] = list;
  }

  const names = {};
  const lr = r.at(localized[0]);
  for (let i = lr.u16(); i > 0; i--) {
    const lang = lr.u16();
    names[lang] = { name: lr.string(), description: lr.string(), extra: lr.string() };
  }

  const animations = {};
  const ar = r.at(animLoc[0]);
  for (let i = ar.u32(); i > 0; i--) {
    const name = ar.string();
    const a = r.at(ar.locator()[0]);
    a.string();
    const transition = a.u8();
    const ret = a.string();
    const frames = [];
    for (let j = a.u16(); j > 0; j--) {
      const images = [];
      for (let k = a.u16(); k > 0; k--) images.push([a.u32(), a.i16(), a.i16()]);
      const audio = a.u16(), duration = a.u16(), exit = a.i16();
      const branches = [];
      for (let k = a.u8(); k > 0; k--) branches.push([a.u16(), a.u16()]);
      for (let k = a.u8(); k > 0; k--) {          // mouth overlays for lip sync: skipped
        a.u8(); a.u8(); a.u16(); a.u8();
        const hasRegion = a.u8();
        a.i16(); a.i16(); a.u16(); a.u16();
        if (hasRegion) a.bytes(a.u32());
      }
      frames.push({ images, sound: audio === 0xffff ? null : audio, duration: duration * 10, exit, branches });
    }
    animations[name] = { transition, return: ret, frames };
  }

  const images = [];
  const ir = r.at(imageLoc[0]);
  for (let i = ir.u32(); i > 0; i--) {
    const [off] = ir.locator();
    ir.u32();                                     // checksum
    const im = r.at(off);
    im.u8();
    const w = im.u16(), h = im.u16();
    const compressed = im.u8();
    const raw = im.bytes(im.u32());
    const stride = (w + 3) & ~3;
    const pixels = compressed ? decompress(raw, stride * h) : raw;
    if (pixels.length !== stride * h) throw new Error(`image ${images.length}: ${pixels.length} bytes, expected ${stride * h}`);
    images.push({ w, h, stride, pixels });
  }

  const sounds = [];
  const sr = r.at(audioLoc[0]);
  for (let i = sr.u32(); i > 0; i--) {
    const [off, size] = sr.locator();
    sr.u32();                                     // checksum
    sounds.push(data.subarray(off, off + size));
  }

  return { version: `${major}.${minor}`, width, height, transparent, palette, states, names, balloon, animations, images, sounds };
}

// ------------------------------------------------------------------ PNG

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = buf => { let c = -1; for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

// colorType 3 (indexed, with plte and trns) or 6 (RGBA); rows unfiltered.
export function png(width, height, pixels, { colorType, plte, trns }) {
  const bpp = colorType === 6 ? 4 : 1;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width * bpp + 1) + 1, y * width * bpp, (y + 1) * width * bpp);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, colorType, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...(plte ? [chunk('PLTE', plte)] : []), ...(trns ? [chunk('tRNS', trns)] : []),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Resize RGBA with alpha weighting: box average when shrinking, bilinear when growing.
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const taps = [];
      if (dw <= sw) {
        const x0 = Math.floor(x * sw / dw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));
        const y0 = Math.floor(y * sh / dh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) taps.push([xx, yy, 1]);
      } else {
        const fx = Math.max(0, (x + 0.5) * sw / dw - 0.5), fy = Math.max(0, (y + 0.5) * sh / dh - 0.5);
        const x0 = Math.min(sw - 1, Math.floor(fx)), y0 = Math.min(sh - 1, Math.floor(fy));
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
        taps.push([x0, y0, (1 - ax) * (1 - ay)], [x1, y0, ax * (1 - ay)], [x0, y1, (1 - ax) * ay], [x1, y1, ax * ay]);
      }
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (const [xx, yy, wt] of taps) {
        const i = (yy * sw + xx) * 4, wa = wt * src[i + 3];
        r += src[i] * wa; g += src[i + 1] * wa; b += src[i + 2] * wa; a += wa; wsum += wt;
      }
      const o = (y * dw + x) * 4;
      if (a) out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / wsum)], o);
    }
  }
  return out;
}

// ------------------------------------------------------------------ export

// Writes atlas.png, sound<n>.wav, icon-<n>.png and tray.png to assetDir and the animation data to dataFile.
export function exportCharacter(char, assetDir, dataFile) {
  mkdirSync(assetDir, { recursive: true });
  const W = char.width, H = char.height, t = char.transparent;

  // Compose every frame (images are layered last to first) and dedupe identical results.
  const tiles = [], seen = new Map();
  for (const anim of Object.values(char.animations)) {
    for (const f of anim.frames) {
      if (!f.images.length) { f.tile = null; continue; }
      const canvas = Buffer.alloc(W * H, t);
      for (const [index, x, y] of [...f.images].reverse()) {
        const { w, h, stride, pixels } = char.images[index];
        for (let yy = 0; yy < h; yy++) {
          const dy = y + yy;
          if (dy < 0 || dy >= H) continue;
          const row = (h - 1 - yy) * stride;      // bottom-up rows
          for (let xx = 0; xx < w; xx++) {
            const dx = x + xx, v = pixels[row + xx];
            if (dx >= 0 && dx < W && v !== t) canvas[dy * W + dx] = v;
          }
        }
      }
      const key = createHash('sha1').update(canvas).digest('hex');
      if (!seen.has(key)) { seen.set(key, tiles.length); tiles.push(canvas); }
      f.tile = seen.get(key);
      delete f.images;
    }
  }

  const cols = 16, rows = Math.ceil(tiles.length / cols);
  const atlas = Buffer.alloc(cols * W * rows * H, t);
  tiles.forEach((tile, i) => {
    const ox = (i % cols) * W, oy = Math.floor(i / cols) * H;
    for (let y = 0; y < H; y++) tile.copy(atlas, (oy + y) * cols * W + ox, y * W, (y + 1) * W);
  });
  const rgb = char.palette.map(q => [q[2], q[1], q[0]]);          // RGBQUAD is B, G, R, reserved
  const trns = Buffer.alloc(t + 1, 255);
  trns[t] = 0;
  writeFileSync(path.join(assetDir, 'atlas.png'), png(cols * W, rows * H, atlas, { colorType: 3, plte: Buffer.from(rgb.flat()), trns }));
  char.sounds.forEach((wav, i) => writeFileSync(path.join(assetDir, `sound${i}.wav`), wav));

  // Icons: the rest pose, cropped to Clippit and his paper and centred on a transparent square.
  const rest = tiles[char.animations.RestPose.frames[0].tile];
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (rest[y * W + x] !== t) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  const side = Math.max(x1 - x0, y1 - y0) + 3;
  const square = Buffer.alloc(side * side * 4);
  const ox = Math.floor((side - (x1 - x0 + 1)) / 2), oy = Math.floor((side - (y1 - y0 + 1)) / 2);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const v = rest[y * W + x];
    if (v !== t) square.set([...rgb[v], 255], ((oy + y - y0) * side + ox + x - x0) * 4);
  }
  for (const [name, size] of [['icon-256', 256], ['icon-64', 64], ['icon-32', 32], ['tray', 16]]) {
    writeFileSync(path.join(assetDir, `${name}.png`), png(size, size, resize(square, side, side, size, size), { colorType: 6 }));
  }

  const meta = { version: char.version, width: W, height: H, states: char.states, names: char.names, balloon: char.balloon,
    animations: char.animations, columns: cols, tiles: tiles.length, sounds: char.sounds.length };
  mkdirSync(path.dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, '// Clippit from CLIPPIT.ACS (frames, timings, branches, sounds), decoded by install/acs.mjs.\n' +
    `window.AGENT = ${JSON.stringify(meta)};\n`);
  return meta;
}
