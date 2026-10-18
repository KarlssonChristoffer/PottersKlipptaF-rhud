// Mark a zone, inside the browser tab: the extension runs this in the active tab when Clippit asks over
// the bridge (lib/bridge.mjs), after you marked a zone on screen. Given the marked zone in screen
// points, it finds the page elements inside it and returns them as a JSON string: what they are, how to
// select them, how they look (computed styles), their HTML, and, in development builds, which component
// and source file rendered them. Read only: it changes nothing on the page.
export default function clippitProbe(R) {
  var sideChrome = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  var topChrome = Math.max(0, window.outerHeight - window.innerHeight - sideChrome);
  var zoom = window.visualViewport ? window.visualViewport.scale : 1;
  var z = { left: R.x - window.screenX - sideChrome, top: R.y - window.screenY - topChrome };
  z.right = z.left + R.width; z.bottom = z.top + R.height;

  var INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[onclick],[tabindex]';
  var STYLE_KEYS = ['display', 'position', 'width', 'height', 'color', 'background-color', 'background-image', 'font-family',
    'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'padding', 'margin', 'border', 'border-radius',
    'box-shadow', 'gap', 'justify-content', 'align-items', 'cursor', 'opacity', 'transition'];

  function inside(r) {
    if (r.width < 2 || r.height < 2) return false;
    var w = Math.min(r.right, z.right) - Math.max(r.left, z.left), h = Math.min(r.bottom, z.bottom) - Math.max(r.top, z.top);
    return w > 0 && h > 0 && (w * h) / (r.width * r.height) >= 0.6;
  }
  function visible(el) {
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  function ownText(el) {
    var t = '';
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  }
  function kind(el) {
    var tag = el.tagName.toLowerCase(), role = el.getAttribute('role');
    if (tag === 'button' || role === 'button' || (tag === 'input' && /^(button|submit|reset)$/.test(el.type))) return 'button';
    if (tag === 'a' || role === 'link') return 'link';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input';
    if (tag === 'img' || tag === 'svg' || tag === 'picture' || tag === 'video' || tag === 'canvas') return 'image';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (el.matches(INTERACTIVE)) return 'control';
    return 'text';
  }
  function selector(el) {
    var parts = [];
    for (var e = el, i = 0; e && e.nodeType === 1 && e !== document.body && i < 6; e = e.parentElement, i++) {
      if (e.id && !/\d{3,}|:/.test(e.id)) { parts.unshift('#' + CSS.escape(e.id)); break; }
      var tid = e.getAttribute('data-testid') || e.getAttribute('data-test');
      if (tid) { parts.unshift('[data-testid="' + tid + '"]'); break; }
      var p = e.tagName.toLowerCase();
      var cls = Array.prototype.filter.call(e.classList, function (c) { return c.length < 40 && !/^(css|sc|jsx|emotion)-|\d{4,}/.test(c); }).slice(0, 3);
      if (cls.length) p += '.' + cls.map(function (c) { return CSS.escape(c); }).join('.');
      var parent = e.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === e.tagName; });
        if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
      }
      parts.unshift(p);
    }
    return parts.join(' > ');
  }
  function component(el) {
    var key = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
    if (key) {
      var names = [], source = null;
      for (var f = el[key]; f && names.length < 4; f = f.return) {
        if (!source && f._debugSource) source = f._debugSource.fileName + ':' + f._debugSource.lineNumber;
        var t = f.type;
        if (typeof t === 'function' || (t && typeof t === 'object')) {
          var n = (t && (t.displayName || t.name)) || (t && t.render && (t.render.displayName || t.render.name));
          if (n && names.indexOf(n) < 0) names.push(n);
        }
      }
      if (names.length) return { component: 'React ' + names.join(' ← '), source: source };
    }
    var v = el.__vueParentComponent;
    if (v && v.type) return { component: 'Vue ' + (v.type.name || v.type.__name || ''), source: v.type.__file || null };
    if (el.__svelte_meta && el.__svelte_meta.loc) return { component: 'Svelte', source: el.__svelte_meta.loc.file + ':' + el.__svelte_meta.loc.line };
    return {};
  }
  function styles(el) {
    var s = getComputedStyle(el), out = {};
    STYLE_KEYS.forEach(function (k) {
      var v = s.getPropertyValue(k);
      if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') out[k] = v;
    });
    return out;
  }
  function html(el, max) {
    var h = el.outerHTML.replace(/\s+/g, ' ');
    return h.length > max ? h.slice(0, max) + '…' : h;
  }

  var all = document.querySelectorAll('body *'), hits = [];
  for (var i = 0; i < all.length && i < 8000; i++) {
    var el = all[i], r = el.getBoundingClientRect();
    if (!inside(r) || !visible(el)) continue;
    var k = kind(el);
    if (k === 'text' && !ownText(el)) continue;
    hits.push({ el: el, kind: k, rect: r });
  }
  // Keep the outermost interactive element (the button, not the span inside it), and leaf text otherwise.
  hits = hits.filter(function (h) {
    return !hits.some(function (o) { return o !== h && o.kind !== 'text' && o.el.contains(h.el); });
  }).slice(0, 25);

  var elements = hits.map(function (h) {
    var el = h.el, c = component(el);
    return {
      kind: h.kind, tag: el.tagName.toLowerCase(), selector: selector(el),
      text: (el.innerText || el.value || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      id: el.id || undefined, classes: el.getAttribute('class') || undefined,
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
      role: el.getAttribute('role') || undefined, ariaLabel: el.getAttribute('aria-label') || undefined,
      href: el.getAttribute('href') || undefined, type: el.getAttribute('type') || undefined,
      disabled: el.disabled || undefined,
      rect: { x: Math.round(h.rect.left), y: Math.round(h.rect.top), w: Math.round(h.rect.width), h: Math.round(h.rect.height) },
      component: c.component, source: c.source || undefined,
      styles: styles(el), html: html(el, 700),
    };
  });

  var container = null;
  if (hits.length > 1) {
    var anc = hits[0].el.parentElement;
    while (anc && !hits.every(function (h) { return anc.contains(h.el); })) anc = anc.parentElement;
    if (anc && anc !== document.body) container = { selector: selector(anc), html: html(anc, 3000) };
  }

  var fw = [];
  if (window.__NEXT_DATA__ || document.getElementById('__next')) fw.push('Next.js');
  if (window.__NUXT__) fw.push('Nuxt');
  if (document.querySelector('[ng-version]')) fw.push('Angular ' + document.querySelector('[ng-version]').getAttribute('ng-version'));
  if (Object.keys(document.querySelector('body *') || {}).some(function (k) { return k.indexOf('__react') === 0; }) || document.querySelector('[data-reactroot]')) fw.push('React');
  if (document.querySelector('[data-v-app]') || window.__VUE__) fw.push('Vue');
  if (document.querySelector('[class*="svelte-"]')) fw.push('Svelte');
  if (document.querySelector('[class*=" px-"],[class^="px-"],[class*=" bg-"],[class^="bg-"]')) fw.push('Tailwind-like classes');

  return JSON.stringify({
    page: { url: location.href, title: document.title, viewport: window.innerWidth + 'x' + window.innerHeight, zoom: zoom, frameworks: fw },
    zoneInViewport: { x: Math.round(z.left), y: Math.round(z.top), w: R.width, h: R.height },
    elements: elements, container: container,
  });
}
