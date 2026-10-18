// One-time setup. Clippit's frames and sounds are Microsoft's artwork, so they aren't in this repository:
// this downloads the original Microsoft Agent character file (or takes yours), checks it, and decodes it
// into app/assets/clippy/ and app/renderer/agent-data.js. Nothing is installed or run from the file.
//
//   node install/setup.mjs [path/to/CLIPPIT.ACS] [--force] [--out DIR]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCharacter, parse } from './acs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ACS_URL = 'https://tmafe.com/classic-ms-agents/CLIPPIT.ACS';
export const ACS_SHA256 = '0ed1ab3ee8f349d0c2b5446029049be1d64c2294b2b72343ddd5e69e62e08e5f';

export const ready = (app = path.join(root, 'app')) =>
  existsSync(path.join(app, 'assets', 'clippy', 'atlas.png')) && existsSync(path.join(app, 'renderer', 'agent-data.js'));

// npm 11 can skip install scripts, which leaves the electron package without Electron itself.
function ensureElectron() {
  const pkg = path.join(root, 'node_modules', 'electron');
  if (!existsSync(path.join(pkg, 'install.js')) || existsSync(path.join(pkg, 'path.txt'))) return;
  console.log('Downloading Electron (npm skipped its install script)');
  execFileSync(process.execPath, [path.join(pkg, 'install.js')], { cwd: pkg, stdio: 'inherit' });
}

async function main(argv) {
  ensureElectron();
  const at = argv.indexOf('--out');
  const app = at >= 0 ? path.resolve(argv[at + 1]) : path.join(root, 'app');
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
  if (ready(app) && !argv.includes('--force')) {
    console.log('Clippit is already set up (use --force to decode again).');
    return;
  }
  let data;
  if (file) {
    data = readFileSync(file);
  } else {
    console.log(`Downloading ${ACS_URL}`);
    const res = await fetch(ACS_URL);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}. Get CLIPPIT.ACS elsewhere and run: npm run setup -- path/to/CLIPPIT.ACS`);
    data = Buffer.from(await res.arrayBuffer());
    const sum = createHash('sha256').update(data).digest('hex');
    if (sum !== ACS_SHA256) throw new Error(`the download isn't the expected CLIPPIT.ACS (sha256 ${sum}); nothing was written`);
  }
  const meta = exportCharacter(parse(data), path.join(app, 'assets', 'clippy'), path.join(app, 'renderer', 'agent-data.js'));
  console.log(`Clippit decoded: ${meta.tiles} frames, ${Object.keys(meta.animations).length} animations, ${meta.sounds} sounds.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(`clippit setup: ${e.message}`); process.exit(1); });
}
