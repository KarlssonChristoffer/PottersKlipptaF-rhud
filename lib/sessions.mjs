// Turns Claude Code hook events into per-session state and into what Clippit should say.
// Pure apart from reading transcripts (injectable), so it is tested without Electron.

import path from 'node:path';
import { gist, projectName, readTranscript, shorten } from './transcript.mjs';

const ERRORS = {
  rate_limit: 'hit a rate limit', overloaded: 'found the API overloaded', authentication_failed: 'lost its login',
  billing_error: 'ran into a billing problem', invalid_request: 'sent a request the API refused',
  server_error: 'got a server error', max_output_tokens: 'ran out of output tokens',
};

let seq = 0;

export function describeTool(name, input = {}) {
  const base = p => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash': return `run ${quote(shorten(input.command, 90))}`;
    case 'Edit': case 'MultiEdit': return `edit ${base(input.file_path)}`;
    case 'Write': return `write ${base(input.file_path)}`;
    case 'NotebookEdit': return `edit ${base(input.notebook_path)}`;
    case 'Read': return `read ${base(input.file_path)}`;
    case 'WebFetch': return `fetch ${shorten(input.url, 70)}`;
    case 'WebSearch': return `search the web for ${quote(shorten(input.query, 60))}`;
    case 'Glob': case 'Grep': return `search files for ${quote(shorten(input.pattern, 50))}`;
    case 'Task': case 'Agent': return `start an agent: ${shorten(input.description || input.prompt, 60)}`;
    default:
      if (name && name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return `use ${server} › ${tool}`;
      }
      return `use ${name}`;
  }
}

function quote(s) { return s ? `“${s}”` : ''; }

// What Clippit acts out while Claude works, by tool.
export function animationFor(tool) {
  if (!tool) return 'Thinking';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'Writing';
  if (/^(WebSearch|WebFetch|Grep|Glob)$/.test(tool)) return 'Searching';
  if (tool === 'Bash') return 'GetTechy';
  if (tool === 'Read') return 'CheckingSomething';
  if (/^(Task|Agent)$/.test(tool)) return 'GetWizardy';
  if (tool.startsWith('mcp__')) return 'Processing';
  return 'Thinking';
}

export function duration(ms) {
  if (!(ms > 0)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export class Sessions {
  constructor({ read = readTranscript, now = () => Date.now() } = {}) {
    this.map = new Map();
    this.read = read;
    this.now = now;
  }

  list() {
    const cutoff = this.now() - 10 * 60 * 1000;
    return [...this.map.values()]
      .filter(s => s.status !== 'ended' || s.lastActivity > cutoff)
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  get(id) { return this.map.get(id); }

  session(ev, origin) {
    let s = this.map.get(ev.session_id);
    if (!s) {
      s = { id: ev.session_id, status: 'idle', started: this.now(), lastActivity: this.now(), toolCount: 0,
        turnStarted: 0, turnCost: undefined, title: undefined, origin: undefined };
      this.map.set(ev.session_id, s);
    }
    if (origin && (origin.pids || origin.env)) s.origin = origin;
    if (ev.transcript_path) s.transcript = ev.transcript_path;
    if (ev.cwd) { s.cwd = ev.cwd; s.project = projectName(ev.cwd); }
    if (ev.session_title) s.title = ev.session_title;
    if (ev.model) s.model = typeof ev.model === 'string' ? ev.model : ev.model.id || ev.model.display_name;
    s.lastActivity = this.now();
    return s;
  }

  // Facts from the transcript: title, branch, entrypoint, cost and what the last turn did.
  refresh(s) {
    const t = this.read(s.transcript);
    if (t.title && !s.customTitle) s.title = t.name || t.aiTitle || s.title || t.title;
    if (t.name) s.customTitle = true;
    s.branch = t.branch || s.branch;
    s.entrypoint = t.entrypoint || s.entrypoint;
    s.headless = !!(s.entrypoint && /^sdk|headless|print/i.test(s.entrypoint));
    if (t.cwd && !s.cwd) { s.cwd = t.cwd; s.project = projectName(t.cwd); }
    s.model = s.model || t.model;
    s.cost = t.cost;
    s.linesAdded = t.linesAdded;
    s.linesRemoved = t.linesRemoved;
    s.firstPrompt = s.firstPrompt || t.firstPrompt;
    s.lastPrompt = s.lastPrompt || t.lastPrompt;
    return t;
  }

  label(s) {
    return s.title || shorten(s.lastPrompt || s.firstPrompt, 60) || s.project || 'Claude';
  }

  where(s) {
    return [s.project, s.branch && s.branch !== 'HEAD' ? s.branch : null].filter(Boolean).join(' · ');
  }

  announce(s, kind, fields) {
    return { id: `a${++seq}`, kind, sessionId: s.id, time: this.now(), title: this.label(s), where: this.where(s),
      sticky: kind === 'attention' || kind === 'error', ...fields };
  }

  // Returns {session, announcement?, activity?} for one hook event.
  handle(ev, origin) {
    if (!ev || !ev.session_id || !ev.hook_event_name) return {};
    const s = this.session(ev, origin);
    const name = ev.hook_event_name;
    const out = { session: s };

    if (name === 'SessionStart') {
      this.refresh(s);
      if (s.status === 'ended') s.status = 'idle';
      s.source = ev.source;
      if (ev.source === 'startup' || ev.source === 'resume' || ev.source === 'fork') {
        out.announcement = this.announce(s, 'start', {
          headline: ev.source === 'resume' ? 'Resumed a session' : 'New Claude Code session',
          body: s.title ? `“${s.title}”` : `in ${s.project || s.cwd}`, quiet: true, animation: 'Greeting' });
      }
    } else if (name === 'UserPromptSubmit') {
      if (s.transcript && !s.title) this.refresh(s);
      s.status = 'working';
      s.turnStarted = this.now();
      s.turnCost = s.cost;
      s.lastPrompt = ev.prompt || s.lastPrompt;
      s.waitingFor = undefined;
      s.toolCount = 0;
      out.activity = { animation: 'Thinking', reason: 'prompt' };
    } else if (name === 'PreToolUse') {
      s.status = 'working';
      s.waitingFor = undefined;
      s.lastTool = ev.tool_name;
      s.lastToolText = describeTool(ev.tool_name, ev.tool_input);
      s.toolCount += 1;
      out.activity = { animation: animationFor(ev.tool_name), reason: 'tool', tool: ev.tool_name };
    } else if (name === 'PermissionRequest') {
      s.status = 'waiting';
      s.waitingFor = describeTool(ev.tool_name, ev.tool_input);
      s.permissionAt = this.now();
      out.announcement = this.announce(s, 'attention', {
        headline: 'needs your OK', body: `Claude wants to ${s.waitingFor}.`, animation: 'GetAttention' });
    } else if (name === 'Notification') {
      const type = ev.notification_type || '';
      if (type === 'permission_prompt' || (!type && /permission/i.test(ev.message || ''))) {
        s.status = 'waiting';
        // PermissionRequest already said exactly what; only speak if it didn't.
        if (!(s.permissionAt && this.now() - s.permissionAt < 5000)) {
          out.announcement = this.announce(s, 'attention', {
            headline: 'needs your OK', body: ev.message || 'Claude needs your permission.', animation: 'GetAttention' });
        }
      } else if (type === 'idle_prompt') {
        s.status = 'idle';
        out.announcement = this.announce(s, 'waiting', {
          headline: 'is waiting for you', body: ev.message || 'Claude is waiting for your input.', animation: 'Alert' });
      } else if (type === 'agent_needs_input' || type.startsWith('elicitation_dialog') || type === 'elicitation_url_dialog') {
        s.status = 'waiting';
        out.announcement = this.announce(s, 'attention', {
          headline: 'has a question', body: ev.message || 'Claude needs your input.', animation: 'GetAttention' });
      } else if (type === 'agent_completed') {
        out.announcement = this.announce(s, 'info', { headline: 'agent finished', body: ev.message, animation: 'Congratulate' });
      }
    } else if (name === 'Stop') {
      if (ev.stop_hook_active) return out;          // another Stop hook kept Claude going
      const t = this.refresh(s);
      const took = s.turnStarted ? this.now() - s.turnStarted : 0;
      s.status = 'idle';
      s.lastReply = ev.last_assistant_message || s.lastReply;
      s.waitingFor = undefined;
      const files = t.turn.files.map(f => path.basename(f));
      const stats = {
        duration: duration(took),
        files: files.length ? files : undefined,
        commands: t.turn.commands.length || undefined,
        tools: Object.values(t.turn.tools).reduce((a, b) => a + b, 0) || s.toolCount || undefined,
        cost: typeof s.cost === 'number' && typeof s.turnCost === 'number' && s.cost > s.turnCost
          ? s.cost - s.turnCost : undefined,
        background: Array.isArray(ev.background_tasks) && ev.background_tasks.length ? ev.background_tasks.length : undefined,
      };
      out.announcement = this.announce(s, 'done', {
        headline: 'is done', body: gist(s.lastReply) || 'Claude finished.', reply: shorten(s.lastReply, 1200),
        prompt: shorten(s.lastPrompt, 160), stats, commandList: t.turn.commands.slice(-6).map(c => shorten(c, 80)),
        animation: 'Congratulate' });
      s.turnStarted = 0;
    } else if (name === 'StopFailure') {
      s.status = 'error';
      out.announcement = this.announce(s, 'error', {
        headline: ERRORS[ev.error] || 'stopped with an error', body: shorten(ev.error_details || ev.last_assistant_message, 200)
          || `The turn ended early (${ev.error || 'unknown error'}).`, animation: 'Alert' });
    } else if (name === 'SubagentStart') {
      out.activity = { animation: 'GetWizardy', reason: 'agent' };
    } else if (name === 'PreCompact') {
      s.status = 'working';
      out.activity = { animation: 'Save', reason: 'compact' };
    } else if (name === 'SessionEnd') {
      s.status = 'ended';
      s.waitingFor = undefined;
    }
    return out;
  }

  counts() {
    const c = { working: 0, waiting: 0, idle: 0 };
    for (const s of this.list()) if (c[s.status] !== undefined) c[s.status] += 1;
    return c;
  }
}
