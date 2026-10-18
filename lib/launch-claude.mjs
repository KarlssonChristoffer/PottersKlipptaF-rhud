// Runs in the console window Clippit opens on Windows (lib/win.mjs): reads the prompt file and starts an
// interactive claude with it, so the prompt never passes through cmd's quoting.
//
//   node lib/launch-claude.mjs <prompt file>

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
let prompt = '';
try { prompt = readFileSync(file, 'utf8'); } catch (e) { console.error(`clippit: can't read ${file}: ${e.message}`); }

// A Clippit started from inside a Claude session would otherwise make this claude think it is a child of it.
const env = { ...process.env };
for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'ELECTRON_RUN_AS_NODE') delete env[k];

const child = spawn('claude', prompt ? [prompt] : [], { stdio: 'inherit', env });
child.on('error', e => {
  console.error(`\nclippit: couldn't start claude (${e.message}). Is Claude Code installed and on PATH?`);
  console.error(`The prompt is in ${file}.`);
  setTimeout(() => process.exit(1), 60000);
});
child.on('exit', code => process.exit(code ?? 0));
