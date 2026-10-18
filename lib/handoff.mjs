// Hands a marked zone to Claude Code: a new interactive `claude` in the repo, in a terminal you can
// watch and answer, with your request and the context bundle as its first prompt. Clippit's own hooks
// then follow that session like any other.

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchClaudeWindow } from './win.mjs';

const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function composePrompt({ request, bundleDir, ctx, extra = '', platform = process.platform }) {
  const opener = platform === 'win32' ? 'start index.html' : platform === 'darwin' ? 'open index.html' : 'xdg-open index.html';
  const imgs = [ctx.images.zone && 'zone.png', ctx.images.around && 'around.png'].filter(Boolean);
  return [
    request.trim(),
    '',
    `I marked a zone on my screen for this. Clippit collected what it could about it in ${bundleDir}:`,
    `read ${path.join(bundleDir, 'context.md')} first${imgs.length ? `, then look at ${imgs.map(f => path.join(bundleDir, f)).join(' and ')}` : ''}.`,
    'It lists the page elements inside the zone (selectors, computed styles, HTML, components) and the files where their texts and ids appear, so start from those instead of searching blind.',
    ctx.sandbox ? [
      '',
      `The page is ${ctx.sandbox.url}, a website that isn't my code, so you're in a scratch folder Clippit made for it.`,
      'Build what I ask here as a small, self-contained test page (index.html with its CSS and JS, no build step unless it really needs one),',
      `recreating the marked part from the elements, styles and screenshots in the bundle. When it works, run \`${opener}\` so I can see it.`,
    ].join('\n') : '',
    extra.trim(),
  ].filter((l, i, a) => l || (i > 0 && a[i - 1])).join('\n').trim() + '\n';
}

// Opens Terminal.app (always present) with claude reading the prompt file, so nothing needs quoting.
// On Windows a new console window does the same (lib/win.mjs).
export function launchClaude({ repo, promptFile }) {
  if (process.platform === 'win32') return launchClaudeWindow({ repo, promptFile, title: `Claude - ${path.basename(repo)}` });
  const cmd = `cd ${sq(repo)} && claude "$(cat ${sq(promptFile)})"`;
  const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Terminal"\n  activate\n  do script "${esc}"\nend tell`;
  return new Promise(resolve => {
    if (process.platform !== 'darwin') { resolve({ ok: false, how: `run this yourself: ${cmd}` }); return; }
    execFile('osascript', ['-e', script], { timeout: 8000 }, err => resolve({ ok: !err, how: err ? String(err.message) : 'Terminal' }));
  });
}

export function writePrompt(bundleDir, text) {
  const file = path.join(bundleDir, 'prompt.md');
  writeFileSync(file, text);
  return file;
}
