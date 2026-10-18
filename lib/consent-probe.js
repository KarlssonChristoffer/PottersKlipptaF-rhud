// Runs inside the page in front (Chrome via Apple Events, Safari via "do JavaScript"): finds a cookie
// or consent popup and says no to it. Known consent managers first, by their own buttons or APIs; then
// any dialog-like box that talks about cookies and has a reject / "only necessary" button; then, when a
// box only offers settings, the settings pane with every optional purpose switched off. If there is no
// way to say no, the box is closed or hidden and the page is scrollable again. It never clicks accept.
//
// clippitConsent() returns a JSON string: {action: 'rejected'|'closed'|'hidden'|'step'|'none', how, host}.
// State lives on window.__clippitConsent, so a page is handled once and stops being scanned after a minute.

function clippitConsent() {
  const W = window, D = document;
  const host = location.hostname.replace(/^www\./, '');
  const out = (action, how) => JSON.stringify({ action, how: how || '', host });
  if (!/^https?:$/.test(location.protocol)) return out('none', 'not a web page');

  let st = W.__clippitConsent;
  if (!st || st.href !== location.href) st = W.__clippitConsent = { href: location.href, t0: Date.now(), done: false, steps: 0 };
  if (st.done) return out('none', 'already handled');
  if (Date.now() - st.t0 > 60000) return out('none', 'nothing found on this page');

  // ---------------------------------------------------------------- helpers

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = e => {
    if (!e || !e.getClientRects) return false;
    // display: contents (Reddit's dialog draws everything from its shadow root and slots)
    if (!e.getClientRects().length) return getComputedStyle(e).display === 'contents' && [...e.children, ...(e.shadowRoot ? e.shadowRoot.children : [])].some(visible);
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(e);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const label = e => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.title || '');
  // What a box says in its own words, not in its links and buttons (so a header with a "Cookies" link
  // isn't a cookie popup), shadow roots included (Reddit keeps its words in one).
  const prose = (e, acc = { t: '' }) => {
    const w = D.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()) && acc.t.length < 6000;) {
      const p = n.parentElement;
      if (p && !p.closest('a, button, [role="button"], script, style, noscript')) acc.t += n.data + ' ';
    }
    for (const h of e.querySelectorAll('*')) if (h.shadowRoot) prose(h.shadowRoot, acc);
    return acc.t;
  };
  const onScreen = e => [...e.getClientRects(), ...(e.getClientRects().length ? [] : [...e.children].map(c => c.getBoundingClientRect()))]
    .some(r => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth);
  const describe = e => (e.id ? `#${e.id}` : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : ''));

  // Every element, through open shadow roots too (Usercentrics and friends live in one).
  function all(root, sel, acc = []) {
    root.querySelectorAll(sel).forEach(e => acc.push(e));
    root.querySelectorAll('*').forEach(e => { if (e.shadowRoot) all(e.shadowRoot, sel, acc); });
    return acc;
  }
  const first = sel => all(D, sel).find(visible);
  const click = (e, how) => { e.click(); return how; };

  const finish = (action, how) => { st.done = true; return out(action, how); };

  // ---------------------------------------------------------------- 1. known consent managers

  const KNOWN = [
    ['OneTrust', '#onetrust-reject-all-handler, .ot-pc-refuse-all-handler'],
    ['Cookiebot', '#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'],
    ['Didomi', '#didomi-notice-disagree-button, .didomi-continue-without-agreeing'],
    ['Usercentrics', '[data-testid="uc-deny-all-button"]'],
    ['Google', '.fc-cta-do-not-consent'],
    ['CookieYes', '.cky-btn-reject'],
    ['Complianz', '.cmplz-deny'],
    ['iubenda', '.iubenda-cs-reject-btn'],
    ['Osano', '.osano-cm-denyAll'],
    ['Termly', '[data-tid="banner-decline"]'],
    ['Klaro', '.cm-btn-decline, .cn-decline'],
    ['Axeptio', '#axeptio_btn_dismiss'],
    ['CookieConsent', '.cc-deny, .cm__btn[data-role="necessary"]'],
    ['Borlabs', '[data-cookie-refuse], a._brlbs-refuse-btn'],
    ['TrustArc', '#truste-consent-required'],
    ['Shopify', '#shopify-pc__banner__btn-decline'],
    ['HubSpot', '#hs-eu-decline-button'],
    ['Ketch', '#ketch-banner-button-secondary'],
    ['Cookie Information', '#declineButton, .coi-banner__decline'],
  ];
  for (const [name, sel] of KNOWN) {
    const b = first(sel);
    if (b) return finish('rejected', click(b, name));
  }
  // Consent managers that take a "no" through their own API.
  try { if (W.Didomi && W.Didomi.notice && W.Didomi.notice.isVisible()) { W.Didomi.setUserDisagreeToAll(); return finish('rejected', 'Didomi'); } } catch { /* not this one */ }
  try { if (W.UC_UI && W.UC_UI.isConsentRequired && W.UC_UI.isConsentRequired()) { W.UC_UI.denyAllConsents(); W.UC_UI.closeCMP && W.UC_UI.closeCMP(); return finish('rejected', 'Usercentrics'); } } catch { /* not this one */ }

  // ---------------------------------------------------------------- 2. anything that looks like a cookie box

  const TOPIC = /cookie|kakor|samtyck|consent|gdpr/i;
  const REJECT = [
    /^(reject|decline|deny|refuse|disagree)( all| all cookies| cookies| optional cookies| additional cookies| non-essential cookies)?$/,
    /^(only|use only|allow only|accept only|use|allow|accept) (strictly )?(necessary|essential|required)( cookies)?( only)?$/,
    /^(strictly )?(necessary|essential|required) (cookies )?only$/,
    /^continue without (accepting|agreeing|consent)/,
    /^(i )?do not (accept|agree|consent)/, /^no,? thanks$/,
    /^(avvisa|neka|avböj|avslå)( alla| alla cookies| cookies| kakor| valfria cookies| valfria kakor| ytterligare cookies| icke nödvändiga( cookies| kakor)?)?$/,
    /^(godkänn|acceptera|tillåt|använd|spara) (bara |endast |enbart )?(strikt )?(nödvändiga|nödvändig|obligatoriska)( cookies| kakor)?$/,
    /^(bara|endast|enbart) (nödvändiga|nödvändig|obligatoriska)( cookies| kakor)?$/,
    /^(nödvändiga|nödvändig) (cookies|kakor) (bara|endast)$/, /^fortsätt utan att (godkänna|acceptera)/,
    /^(afvis|afvis alle|avvis|avvis alle|avslå alle|hylkää|hylkää kaikki|kiellä)$/,
    /^(alle )?ablehnen$|^nur (notwendige|essenzielle|erforderliche)/, /^(tout )?refuser|^continuer sans accepter/,
    /^rechazar|^rifiuta|^(alles )?(afwijzen|weigeren)/,
  ];
  const ACCEPT = /accept|agree|allow all|godkänn|acceptera|tillåt|jag förstår|ok$|got it|akzeptieren|accepter/;
  const NECESSARY = /necessary|essential|required|nödvändig|obligatorisk|notwendig/;
  const isReject = t => t && t.length < 60 && REJECT.some(r => r.test(t)) && !(ACCEPT.test(t) && !NECESSARY.test(t));
  const SETTINGS = /^(cookie )?(settings|preferences|options|customi[sz]e|manage( cookies| options| preferences| settings)?|more options|let me choose|(manage|customi[sz]e) or reject)$|^show purposes$|^(inställningar|cookie-?inställningar|(anpassa|hantera)( cookies| kakor| inställningar| val| mina val| eller avvisa)?|fler alternativ|visa (detaljer|alternativ|syften|ändamål)|välj själv)$/;
  const SAVE = /^(save|confirm|submit)( my)?( choices| preferences| settings| selection)?( and close| & close| & exit)?$|^(spara|bekräfta)( mina)?( val| inställningar| urval)?( och stäng)?$/;
  const CLOSE = /^(close|stäng|dismiss|×|✕|✖|x)$|close|stäng/;

  const BUTTONS = 'button, a, [role="button"], input[type="button"], input[type="submit"], [tabindex="0"]';

  // The boxes: dialogs, banners pinned to the screen, consent-ish ids, that mention cookies.
  function boxes() {
    const found = new Set();
    for (const e of all(D, '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="cmp" i]')) {
      if (visible(e) && onScreen(e)) found.add(e);
    }
    for (const e of all(D, '*')) {
      if (found.size > 40) break;
      if (e === D.documentElement || e === D.head || e === D.body || e.closest('head')) continue;
      const p = getComputedStyle(e).position;
      if ((p === 'fixed' || p === 'sticky') && visible(e) && onScreen(e)) found.add(e);
    }
    return [...found]
      .filter(e => e !== D.body && e !== D.documentElement && TOPIC.test(prose(e)))
      .filter(e => all(e, BUTTONS).some(visible) || e.matches('[class*="cookie" i], [id*="cookie" i]'))
      // the outermost box wins, so hiding it takes the whole popup and its backdrop
      .filter((e, _i, arr) => !arr.some(o => o !== e && o.contains(e)));
  }

  // Floating: a dialog, or pinned to the screen. Only those get their settings opened, or get closed or
  // hidden; a "cookie settings" link in a footer is left alone.
  function floating(e) {
    for (let n = e; n && n !== D.body && n !== D.documentElement; n = n.parentElement || (n.getRootNode().host || null)) {
      if (n.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog')) return true;
      if (n.shadowRoot && n.shadowRoot.querySelector('dialog[open]')) return true;
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') return true;
    }
    return false;
  }

  let list = boxes();
  // consent.google.com, consent.youtube.com and the like: the whole page is the question.
  if (/^consent\./.test(location.hostname) && D.body) list.push(D.body);
  // Sourcepoint, TrustArc and Google draw their box in an iframe we can't reach: only hiding works there.
  const framed = all(D, '[id^="sp_message_container"], .truste_overlay, .truste_box_overlay, #truste-consent-track, .fc-consent-root').filter(visible);
  if (!list.length && !framed.length) return out('none', 'no popup');

  for (const box of list) {
    const btns = all(box, BUTTONS).filter(visible);
    const no = btns.find(b => isReject(label(b)));
    if (no) return finish('rejected', click(no, `"${label(no)}"`));
  }

  // From here on Clippit opens settings, closes or hides, so only for a box that is really asking: it floats
  // and has an accept button. A "cookie settings" link in a footer, or the little cookie badge some sites
  // leave in a corner after you've chosen, stays put.
  const asking = box => floating(box) && all(box, BUTTONS).filter(visible).some(b => { const t = label(b); return t.length < 60 && ACCEPT.test(t) && !NECESSARY.test(t); });
  // Second layer: we opened the settings last time; switch every optional purpose off and save.
  // (A settings pane often has no accept button of its own, so any floating box will do here.)
  if (st.steps > 0) {
    for (const box of list.filter(floating)) {
      let flipped = 0;
      for (const c of all(box, 'input[type="checkbox"]:checked:not(:disabled)')) { c.click(); flipped++; }
      for (const s of all(box, '[role="switch"][aria-checked="true"]:not([aria-disabled="true"])')) { s.click(); flipped++; }
      const save = all(box, BUTTONS).filter(visible).find(b => SAVE.test(label(b)));
      if (save) return finish('rejected', click(save, `turned off ${flipped} and pressed "${label(save)}"`));
    }
  }

  list = list.filter(asking).concat(framed);
  if (!list.length) return out(st.steps ? 'step' : 'none', st.steps ? 'waiting for the settings' : 'no popup');

  // Only "accept" and "settings" on offer: open the settings once and come back next round.
  if (st.steps < 1) {
    for (const box of list) {
      const s = all(box, BUTTONS).filter(visible).find(b => SETTINGS.test(label(b)));
      if (s) { st.steps++; click(s, ''); return out('step', `opened "${label(s)}"`); }
    }
  }

  // No way to say no: close the box, or hide it, and let the page scroll again.
  for (const box of list) {
    const x = all(box, BUTTONS).filter(visible).find(b => {
      const t = norm(b.getAttribute('aria-label') || b.title || b.innerText || b.value || '');
      return t.length < 30 && CLOSE.test(t) && !ACCEPT.test(norm(b.innerText));
    });
    if (x) { x.click(); unlock(); return finish('closed', `"${label(x) || 'close'}"`); }
  }
  for (const box of list) box.style.setProperty('display', 'none', 'important');
  // backdrops left behind: full-screen fixed layers with nothing to read
  for (const e of D.body.querySelectorAll('*')) {
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    if (cs.position === 'fixed' && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9 && !(e.innerText || '').trim()) e.style.setProperty('display', 'none', 'important');
  }
  unlock();
  return finish('hidden', list.map(describe).join(', '));

  function unlock() {
    for (const e of [D.documentElement, D.body]) {
      if (!e) continue;
      const cs = getComputedStyle(e);
      if (cs.overflowY === 'hidden') e.style.setProperty('overflow-y', 'auto', 'important');
      if (cs.position === 'fixed') e.style.setProperty('position', 'static', 'important');
    }
  }
}
