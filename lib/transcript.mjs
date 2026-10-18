// What a session is about, from its transcript (~/.claude/projects/<dir>/<session>.jsonl).
// The JSONL format is internal to Claude Code and changes between versions (the docs say so), so
// every field here is optional: unknown lines are skipped and missing facts stay undefined.
// Only the first and last part of the file are read; transcripts grow to tens of megabytes.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

const HEAD = 256 * 1024;
const TAIL = 1024 * 1024;

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString('utf8');
}

function lines(text, dropFirst) {
  const out = [];
  const parts = text.split('\n');
  for (let i = dropFirst ? 1 : 0; i < parts.length; i++) {   // a tail chunk starts mid-line
    if (!parts[i]) continue;
    try { out.push(JSON.parse(parts[i])); } catch { /* partial or foreign line */ }
  }
  return out;
}

function textOf(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

// A prompt the person typed, not a tool result, meta line, command wrapper or compaction summary.
function isHumanPrompt(e) {
  if (e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary || e.toolUseResult) return false;
  const t = textOf(e.message).trim();
  return t !== '' && !t.startsWith('<') && !t.startsWith('Caveat:');
}

export function readTranscript(file) {
  const info = { file, title: undefined, aiTitle: undefined, name: undefined, firstPrompt: undefined,
    lastPrompt: undefined, entrypoint: undefined, cwd: undefined, branch: undefined, model: undefined,
    cost: undefined, linesAdded: undefined, linesRemoved: undefined, turn: { tools: {}, files: [], commands: [] } };
  if (!file) return info;
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const head = lines(readRange(fd, 0, Math.min(size, HEAD)), false);
    const tailStart = Math.max(0, size - TAIL);
    const tail = tailStart === 0 ? head : lines(readRange(fd, tailStart, size - tailStart), true);

    for (const e of head) {
      if (!info.entrypoint && e.entrypoint) info.entrypoint = e.entrypoint;
      if (!info.cwd && e.cwd) info.cwd = e.cwd;
      if (!info.firstPrompt && isHumanPrompt(e)) info.firstPrompt = textOf(e.message).trim();
    }
    let turnStart = -1;
    tail.forEach((e, i) => {
      if (e.type === 'ai-title' && e.aiTitle) info.aiTitle = e.aiTitle;
      if (e.type === 'agent-name' && e.agentName) info.name = e.agentName;
      if (e.type === 'custom-title' && e.customTitle) info.name = e.customTitle;
      if (e.type === 'last-prompt' && e.lastPrompt) info.lastPrompt = e.lastPrompt;
      if (e.type === 'cost-state') {
        if (typeof e.totalCostUSD === 'number') info.cost = e.totalCostUSD;
        if (typeof e.totalLinesAdded === 'number') info.linesAdded = e.totalLinesAdded;
        if (typeof e.totalLinesRemoved === 'number') info.linesRemoved = e.totalLinesRemoved;
      }
      if (e.gitBranch) info.branch = e.gitBranch;
      if (e.cwd) info.cwd = e.cwd;
      if (e.entrypoint && !info.entrypoint) info.entrypoint = e.entrypoint;
      if (e.type === 'assistant' && e.message && e.message.model && !e.isSidechain) info.model = e.message.model;
      if (isHumanPrompt(e)) {
        turnStart = i;
        info.lastPrompt = textOf(e.message).trim();
      }
    });
    // What the last turn did: tools by name, files written, commands run.
    for (const e of tail.slice(turnStart + 1)) {
      if (e.type !== 'assistant' || e.isSidechain || !e.message || !Array.isArray(e.message.content)) continue;
      for (const b of e.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        info.turn.tools[b.name] = (info.turn.tools[b.name] || 0) + 1;
        const input = b.input || {};
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name) && (input.file_path || input.notebook_path)) {
          const f = input.file_path || input.notebook_path;
          if (!info.turn.files.includes(f)) info.turn.files.push(f);
        }
        if (b.name === 'Bash' && input.command) info.turn.commands.push(String(input.command));
      }
    }
  } catch {
    /* unreadable transcript: the hook payload alone still says a lot */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  info.title = info.name || info.aiTitle || shorten(info.firstPrompt, 60);
  return info;
}

export function shorten(text, max = 140) {
  if (!text) return undefined;
  const flat = String(text).replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : flat;
}

// The first sentence or two of Claude's final message: what it would say if you asked "so?".
export function gist(text, max = 220) {
  if (!text) return undefined;
  const flat = shorten(text, 2000);
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) || [flat];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > max) break;
    out += s;
  }
  return (out || flat.slice(0, max)).trim();
}

export function projectName(cwd) {
  return cwd ? path.basename(cwd) : undefined;
}
