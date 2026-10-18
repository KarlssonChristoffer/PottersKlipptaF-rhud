// Clippit's behaviour on screen: the balloon queue, the session overview, acting out what Claude is
// doing, dragging, and telling the main process which pixels are clickable (the rest clicks through).

const bridge = window.clippit || {          // a stand-in so the page also runs in a plain browser (tests)
  platform: 'web', on() {}, ready() {}, shape() {}, hit() {}, drag() {}, dragEnd() {}, menu() {}, hide() {},
  zone() {}, zoneSubmit(id, text) { console.log('zone', id, text); }, zoneDismiss() {}, openPrivacy() {},
  offloadAnswer(id, where) { console.log('offload', id, where); }, offloadCmd(id, cmd) { console.log('offload', id, cmd); },
  focus(id) { console.log('focus', id); },
};

const clippyEl = document.getElementById('clippy');
const sprite = clippyEl.querySelector('.sprite');
const balloon = document.getElementById('balloon');

let state = { sessions: [], settings: { sounds: true, doneSeconds: 30, toolAnimations: true, hidden: false }, dnd: false };
let offloads = [], liveEl = null;
let queue = [], current = null, view = null, dismissTimer = 0, idleTimer = 0, hovering = false, lastAct = 0, hidden = false;

const agent = new Agent(sprite, window.AGENT, { sound: () => state.settings.sounds });
agent.onIdle = () => scheduleIdle();

const GLYPH = { working: '⏳', waiting: '❗', idle: '✓', error: '⚠', ended: '·' };
const KIND_ORDER = { attention: 0, error: 1, waiting: 2, done: 3, info: 4, start: 5 };

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

// ---------------------------------------------------------------- clickable area

function rectOf(e, extraBottom = 0) {
  const r = e.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height + extraBottom };
}

function shape() {
  const rects = [];
  if (!hidden) rects.push(rectOf(clippyEl));
  if (!balloon.hidden) rects.push(rectOf(balloon, 10));     // the tail hangs below the box
  bridge.shape(rects);
}

let lastHit = false;
document.addEventListener('mousemove', e => {   // macOS: the window ignores the mouse except over Clippit
  const over = !!e.target.closest('#clippy, .balloon') && !hidden;
  if (over !== lastHit) { lastHit = over; bridge.hit(over); }
});

// ---------------------------------------------------------------- the balloon

function openBalloon(build, { sticky = false, seconds = 12 } = {}) {
  clearTimeout(dismissTimer);
  balloon.textContent = '';
  const body = el('div', 'scroll', balloon);
  build(body);
  el('div', 'tail', balloon);
  balloon.hidden = false;
  balloon.dataset.sticky = sticky ? '1' : '';
  balloon.dataset.seconds = String(seconds);
  if (!sticky && !hovering) dismissTimer = setTimeout(() => advanceQueue(), seconds * 1000);
  requestAnimationFrame(shape);
}

function closeBalloon() {
  clearTimeout(dismissTimer);
  liveEl = null;
  balloon.hidden = true;
  view = null;
  current = null;
  requestAnimationFrame(shape);
}

function option(parent, label, fn) {
  const o = el('div', 'opt', parent, label);
  o.addEventListener('click', e => { e.stopPropagation(); fn(); });
  return o;
}

balloon.addEventListener('mouseenter', () => { hovering = true; clearTimeout(dismissTimer); });
balloon.addEventListener('mouseleave', () => {
  hovering = false;
  if (!balloon.hidden && !balloon.dataset.sticky) dismissTimer = setTimeout(() => advanceQueue(), 5000);
});
balloon.addEventListener('contextmenu', e => { e.preventDefault(); bridge.menu(); });

function header(parent, a) {
  const hd = el('div', 'hd', parent);
  el('b', null, hd, a.title || 'Claude Code');
  if (a.where) el('small', null, hd, a.where);
}

function statsLine(parent, st) {
  if (!st) return;
  const bits = [];
  if (st.files) bits.push(`✎ ${st.files.length} file${st.files.length === 1 ? '' : 's'} changed`);
  if (st.commands) bits.push(`▸ ${st.commands} command${st.commands === 1 ? '' : 's'}`);
  if (!st.files && !st.commands && st.tools) bits.push(`${st.tools} tool call${st.tools === 1 ? '' : 's'}`);
  if (typeof st.cost === 'number' && st.cost >= 0.005) bits.push(`$${st.cost.toFixed(2)}`);
  if (st.background) bits.push(`${st.background} still running in the background`);
  if (!bits.length) return;
  const line = el('div', 'stats', parent);
  for (const b of bits) el('span', null, line, b);
}

function lead(a) {
  if (a.kind === 'done') return `Finished${a.stats && a.stats.duration ? ` in ${a.stats.duration}` : ''}`;
  if (a.kind === 'attention') return a.headline === 'needs your OK' ? 'Needs your OK' : cap(a.headline);
  return cap(a.headline);
}

function renderAnnouncement(a) {
  openBalloon(body => {
    header(body, a);
    const l = lead(a);
    if (l) el('p', 'lead', body, l);
    if (a.body) el('p', null, body, a.body);
    statsLine(body, a.stats);
    if (a.actions) {               // a run on your server: its own buttons instead of Show me
      if (a.live) {
        const o = offloads.find(x => x.id === a.offload);
        liveEl = el('p', 'stats live', body, o ? `⏳ ${o.line}` : '⏳ getting ready');
      }
      for (const act of a.actions) {
        option(body, act.label, () => {
          if (act.cmd !== 'ok') bridge.offloadCmd(a.offload, act.cmd);
          if (act.cmd !== 'open') advanceQueue();
        });
      }
      return;
    }
    if (a.sessionId) option(body, 'Show me', () => { bridge.focus(a.sessionId); advanceQueue(); });
    if (a.kind === 'done' && (a.reply || a.prompt || (a.stats && a.stats.files) || (a.commandList && a.commandList.length))) {
      option(body, 'What did it do?', () => details(a));
    }
    option(body, queue.length ? `Next (${queue.length} more)` : 'OK', () => advanceQueue());
  }, { sticky: !!a.sticky, seconds: a.kind === 'done' ? state.settings.doneSeconds || 30 : 15 });
}

function details(a) {
  view = 'details';
  openBalloon(body => {
    header(body, a);
    if (a.prompt) { el('p', 'lead', body, 'You asked'); el('div', 'quote', body, a.prompt); }
    if (a.reply) { el('p', 'lead', body, 'Claude said'); el('div', 'quote', body, a.reply); }
    if (a.stats && a.stats.files) {
      el('p', 'lead', body, 'Changed');
      const ul = el('ul', 'list', body);
      for (const f of a.stats.files.slice(0, 12)) el('li', null, ul, `✎ ${f}`);
      if (a.stats.files.length > 12) el('li', null, ul, `… and ${a.stats.files.length - 12} more`);
    }
    if (a.commandList && a.commandList.length) {
      el('p', 'lead', body, 'Ran');
      const ul = el('ul', 'list', body);
      for (const c of a.commandList) el('code', null, el('li', null, ul), c);
    }
    option(body, 'Show me', () => { bridge.focus(a.sessionId); advanceQueue(); });
    option(body, 'OK', () => advanceQueue());
  }, { sticky: true });
}

function enqueue(a) {
  if (!a) return;
  if (view === 'zone' || view === 'ask') { queue.push(a); return; }     // don't interrupt someone typing or choosing
  queue = queue.filter(q => !(q.sessionId === a.sessionId && q.kind === a.kind));
  if (current && view === 'announce' && current.sessionId === a.sessionId) current = null;  // replace what's showing
  queue.push(a);
  queue.sort((x, y) => (KIND_ORDER[x.kind] ?? 9) - (KIND_ORDER[y.kind] ?? 9));
  if (hidden) return;
  if (!current || view !== 'announce' || (KIND_ORDER[a.kind] ?? 9) < (KIND_ORDER[current.kind] ?? 9)) advanceQueue();
  else renderAnnouncement(current);   // refresh the "Next (n more)" count
}

function advanceQueue() {
  liveEl = null;
  current = queue.shift() || null;
  if (!current) { closeBalloon(); return; }
  view = 'announce';
  renderAnnouncement(current);
  if (current.animation) agent.play(current.animation);
}

// ---------------------------------------------------------------- the overview (click on Clippit)

function overview() {
  view = 'overview';
  current = null;
  const list = state.sessions.filter(s => s.status !== 'ended');
  openBalloon(body => {
    if (!list.length && offloads.length) {
      header(body, { title: `Running on your ${offloads[0].name}` });
    } else if (!list.length) {
      header(body, { title: 'No Claude Code sessions yet' });
      el('p', null, body, "Start claude in a terminal and I'll tell you when it finishes, needs your OK or runs into trouble.");
    } else {
      const c = { working: 0, waiting: 0, idle: 0 };
      list.forEach(s => { if (c[s.status] !== undefined) c[s.status] += 1; });
      header(body, { title: `${list.length} Claude Code session${list.length === 1 ? '' : 's'}`,
        where: [c.waiting && `${c.waiting} waiting for you`, c.working && `${c.working} working`, c.idle && `${c.idle} idle`].filter(Boolean).join(' · ') });
      for (const s of list) {
        const row = el('div', 'sess', body);
        el('span', `st ${s.status}`, row, GLYPH[s.status] || '·');
        el('b', null, row, s.title);
        const what = s.status === 'waiting' ? `waiting: ${s.waitingFor || 'your reply'}`
          : s.status === 'working' ? (s.lastToolText ? `working: ${s.lastToolText}` : 'working')
          : s.status === 'error' ? 'stopped with an error' : `idle, ${ago(s.lastActivity)}`;
        el('small', null, row, [s.where, what].filter(Boolean).join(' · '));
        row.addEventListener('click', () => { bridge.focus(s.id); closeBalloon(); });
      }
    }
    for (const o of offloads) {
      const row = el('div', 'sess', body);
      el('span', 'st working', row, '⏳');
      el('b', null, row, `${o.repo} on your ${o.name}`);
      el('small', null, row, o.line);
    }
    for (const o of offloads) option(body, `Stop ${o.repo} on the ${o.name}`, () => { bridge.offloadCmd(o.id, 'stop'); closeBalloon(); });
    if (state.dnd) el('p', 'stats', body, 'Do Not Disturb is on.');
    option(body, 'Mark a zone…', () => { closeBalloon(); bridge.zone(); });
    option(body, 'Animate!', () => { closeBalloon(); animate(); });
    option(body, 'Options…', () => bridge.menu());
    option(body, 'Hide Clippit', () => bridge.hide());
  }, { seconds: 20 });
}

// ---------------------------------------------------------------- mark a zone: what should I do with it?

let zoneState = null;

function zonePrompt(z) {
  zoneState = { id: z.id, summary: z.summary || [], notes: [], images: true, text: '' };
  view = 'zone';
  current = null;
  agent.play('GetAttention');
  openBalloon(body => {
    header(body, { title: 'What should I do with this?' });
    zoneState.whereEl = body.querySelector('.hd small') || el('small', null, body.querySelector('.hd'));
    zoneState.whereEl.textContent = zoneState.summary.join(' · ');
    const ta = el('textarea', 'ask', body);
    ta.placeholder = 'e.g. Make these two buttons look and behave like the ones on the settings page';
    ta.rows = 4;
    ta.addEventListener('input', () => { zoneState.text = ta.value; });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitZone(); }
      if (e.key === 'Escape') { e.preventDefault(); dismissZone(); }
    });
    zoneState.notesEl = el('ul', 'list notes', body);
    option(body, 'Send to Claude  (↩, ⇧↩ for a new line)', submitZone);
    option(body, 'Never mind', dismissZone);
    setTimeout(() => ta.focus(), 60);
  }, { sticky: true });
}

function zoneContext(c) {
  if (!zoneState || c.id !== zoneState.id || view !== 'zone') return;
  zoneState.summary = c.summary || [];
  zoneState.whereEl.textContent = zoneState.summary.join(' · ') || 'I found nothing beyond the picture';
  zoneState.notesEl.textContent = '';
  for (const n of (c.notes || []).slice(0, 3)) el('li', null, zoneState.notesEl, `⚠ ${n}`);
  if (!c.images) option(zoneState.notesEl, 'Open Screen Recording settings', () => bridge.openPrivacy('screen'));
  requestAnimationFrame(shape);
}

function submitZone() {
  if (!zoneState || !zoneState.text.trim()) return;
  bridge.zoneSubmit(zoneState.id, zoneState.text);
  zoneState = null;
  closeBalloon();
  agent.play('Writing');
  if (queue.length) advanceQueue();
}

function dismissZone() {
  zoneState = null;
  bridge.zoneDismiss();
  closeBalloon();
  if (queue.length) advanceQueue();
}

// ---------------------------------------------------------------- run it here or on your server?

function offloadAsk(q) {
  view = 'ask';
  current = null;
  agent.play('GetAttention');
  const answer = where => { bridge.offloadAnswer(q.id, where); closeBalloon(); if (where !== 'cancel') agent.play('Writing'); if (queue.length) advanceQueue(); };
  openBalloon(body => {
    header(body, { title: `Do you want to launch this on your ${q.name}?` });
    el('p', null, body, `Claude would run there on its own, in a copy of ${q.repo}. The changes come back here for you to apply, `
      + `and everything on the ${q.name} is closed when it's done.`);
    option(body, `Yes, launch it on the ${q.name}`, () => answer('server'));
    option(body, 'No, run it here on my Mac', () => answer('here'));
    option(body, 'Cancel', () => answer('cancel'));
  }, { sticky: true });
}

function offloadStatus(o) {
  const i = offloads.findIndex(x => x.id === o.id);
  if (o.running) { if (i >= 0) offloads[i] = o; else offloads.push(o); }
  if (liveEl && current && current.offload === o.id) { liveEl.textContent = `⏳ ${o.line}`; requestAnimationFrame(shape); }
}

// ---------------------------------------------------------------- acting

const RANDOM = ['Congratulate', 'GetArtsy', 'GetTechy', 'GetWizardy', 'GetAttention', 'CheckingSomething', 'Print', 'Save',
  'Searching', 'SendMail', 'Thinking', 'Writing', 'Wave', 'Explain', 'Processing', 'EmptyTrash', 'Alert', 'IdleAtom',
  'IdleRopePile', 'IdleHeadScratch', 'IdleFingerTap', 'IdleSideToSide'];

function animate() { agent.playFor(RANDOM[Math.floor(Math.random() * RANDOM.length)], 5000); }

function activity(act) {
  if (hidden || !act || view === 'announce' || view === 'details') return;
  if (agent.anim || Date.now() - lastAct < 6000) return;
  lastAct = Date.now();
  agent.playFor(act.animation, 3800);
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  if (hidden) return;
  idleTimer = setTimeout(() => {
    if (agent.anim || hidden) return scheduleIdle();
    const working = state.sessions.some(s => s.status === 'working') || offloads.length > 0;
    if (working && state.settings.toolAnimations) { agent.playFor(Math.random() < 0.5 ? 'Processing' : 'Thinking', 4000); return; }
    const level = Math.random() < 0.7 ? 'IDLINGLEVEL1' : 'IDLINGLEVEL2';
    const list = window.AGENT.states[level] || window.AGENT.states.IDLINGLEVEL1;
    agent.playFor(list[Math.floor(Math.random() * list.length)], 8000);
  }, 9000 + Math.random() * 12000);
}

function hide() {
  closeBalloon();
  agent.play('Hide', () => { hidden = true; clippyEl.classList.add('gone'); shape(); });
}

function show() {
  hidden = false;
  clippyEl.classList.remove('gone');
  agent.show(null);
  agent.play('Show', () => { if (queue.length) advanceQueue(); });
  shape();
}

// ---------------------------------------------------------------- dragging and clicking Clippit

let drag = null;
clippyEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  clippyEl.setPointerCapture(e.pointerId);
  drag = { x: e.screenX, y: e.screenY, moved: false };
});
clippyEl.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  bridge.drag({ dx, dy });
});
clippyEl.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.moved) { bridge.dragEnd(); return; }
  if (view === 'zone' || view === 'ask') return;     // keep the half-typed request / the open question
  if (!balloon.hidden) { if (view === 'announce' && queue.length) advanceQueue(); else closeBalloon(); }
  else if (queue.length) advanceQueue();
  else overview();
});
clippyEl.addEventListener('dblclick', () => animate());
clippyEl.addEventListener('contextmenu', e => { e.preventDefault(); bridge.menu(); });

// ---------------------------------------------------------------- from the main process

function setState(s) {
  state = { ...state, ...s, settings: { ...state.settings, ...(s && s.settings) } };
  if (view === 'overview' && !balloon.hidden) overview();
}

bridge.on('state', setState);
bridge.on('announce', enqueue);
bridge.on('activity', activity);
bridge.on('animate', () => animate());
bridge.on('hide', hide);
bridge.on('show', show);
bridge.on('zone-prompt', zonePrompt);
bridge.on('zone-context', zoneContext);
bridge.on('offload-ask', offloadAsk);
bridge.on('offload-status', offloadStatus);
bridge.on('offloads', list => {
  offloads = Array.isArray(list) ? list : [];
  if (view === 'overview' && !balloon.hidden) overview();
});

window.clippitUI = { enqueue, setState, overview, activity, animate, hide, show, details, offloadAsk, offloadStatus };

function start() {
  if (state.settings.hidden) { hidden = true; clippyEl.classList.add('gone'); shape(); return; }
  agent.show(null);
  agent.play('Show', () => {
    let greeted = false;
    try { greeted = localStorage.getItem('clippit-greeted') === '1'; localStorage.setItem('clippit-greeted', '1'); } catch { /* storage off */ }
    if (!greeted) {
      agent.play('Greeting');
      openBalloon(body => {
        header(body, { title: "Hi! I'm Clippit." });
        el('p', null, body, "I'll keep an eye on your Claude Code sessions and tell you which one finished, what it did, and when one needs your OK.");
        el('p', null, body, 'Click me for an overview, right-click for options.');
        option(body, 'Sounds good', () => closeBalloon());
      }, { seconds: 25 });
    }
  });
  shape();
}

bridge.ready();
setTimeout(start, 300);
