// Voice commands, prepared but off: a speech provider turns what you say into text, a command
// registry turns that text into one of Clippit's commands, and Clippit runs it. No provider ships yet,
// and with settings.voice.enabled false (the default) nothing listens at all.
//
// A provider is any object with
//   name                      a short id, e.g. 'macos-speech' or 'whisper-local'
//   start(onUtterance)        begin listening; call onUtterance({ text, final, confidence, lang })
//   stop()                    stop listening and release the microphone
// and is registered with registerProvider(name, options => provider). Partial results (final: false)
// are ignored; only final utterances are matched.
//
// A command is { id, phrases, describe, run }. Phrases are lowercase patterns where {name} captures
// words, e.g. 'focus {session}' or 'fokusera {session}'. run(args, utterance) does the work.

const providers = new Map();

export function registerProvider(name, factory) {
  providers.set(name, factory);
}

export function providerNames() {
  return [...providers.keys()];
}

// Lowercase, no punctuation, single spaces; letters of any language (å, ä, ö) are kept.
export function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function compile(phrase) {
  const slots = [];
  const src = normalize(phrase.replace(/\{(\w+)\}/g, (_m, s) => { slots.push(s); return ` slot${slots.length - 1}slot `; }))
    .split(' ').map(w => (/^slot\d+slot$/.test(w) ? '(.+?)' : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join(' ');
  return { phrase, slots, re: new RegExp(`^(?:hey )?(?:clippit |clippy )?${src}(?: please| tack)?$`, 'u') };
}

export class VoiceCommands {
  constructor() { this.commands = new Map(); }

  register({ id, phrases, describe = '', run }) {
    if (!id || !Array.isArray(phrases) || !phrases.length || typeof run !== 'function') throw new Error(`voice: bad command ${id}`);
    this.commands.set(id, { id, describe, run, patterns: phrases.map(compile) });
    return () => this.commands.delete(id);
  }

  list() {
    return [...this.commands.values()].map(c => ({ id: c.id, describe: c.describe, phrases: c.patterns.map(p => p.phrase) }));
  }

  // The first command whose pattern matches the whole utterance, with its captured slots.
  match(text) {
    const said = normalize(text);
    if (!said) return null;
    for (const c of this.commands.values()) {
      for (const p of c.patterns) {
        const m = p.re.exec(said);
        if (m) return { id: c.id, describe: c.describe, args: Object.fromEntries(p.slots.map((s, i) => [s, m[i + 1]])), said };
      }
    }
    return null;
  }

  async dispatch(utterance, { dryRun = false } = {}) {
    const u = typeof utterance === 'string' ? { text: utterance, final: true } : utterance;
    const hit = this.match(u.text);
    if (!hit) return { ok: false, reason: 'no-match', said: normalize(u.text) };
    if (dryRun) return { ok: true, dryRun: true, ...hit };
    try {
      return { ok: true, ...hit, result: await this.commands.get(hit.id).run(hit.args, u) };
    } catch (e) {
      return { ok: false, reason: 'failed', error: e.message, ...hit };
    }
  }
}

// Ties a provider to the registry. Stays idle unless enabled and a known provider is configured.
// settings: { enabled, provider, dryRun, minConfidence }. onResult sees every dispatch outcome, so
// Clippit can say what it heard (and in dry run, what it would have done).
export function startVoice({ commands, settings = {}, onResult = () => {}, log = console }) {
  const off = { running: false, stop() {} };
  if (!settings.enabled) return off;
  const factory = providers.get(settings.provider);
  if (!factory) {
    log.warn(`clippit: voice commands are on but no speech provider "${settings.provider || ''}" is installed (have: ${providerNames().join(', ') || 'none'})`);
    return off;
  }
  const provider = factory(settings);
  const min = Number(settings.minConfidence) || 0;
  provider.start(async u => {
    if (!u || !u.final || !String(u.text || '').trim()) return;
    if (typeof u.confidence === 'number' && u.confidence < min) { onResult({ ok: false, reason: 'unsure', said: normalize(u.text) }); return; }
    onResult(await commands.dispatch(u, { dryRun: settings.dryRun !== false }));
  });
  return { running: true, provider: provider.name, stop: () => provider.stop() };
}

// A provider fed by hand, for tests and for trying commands without a microphone.
export function manualProvider() {
  let listener = null;
  return {
    name: 'manual',
    start(cb) { listener = cb; },
    stop() { listener = null; },
    say(text, extra = {}) { return listener ? listener({ text, final: true, ...extra }) : undefined; },
  };
}
