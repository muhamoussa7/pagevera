// Page-side preparation for printing. Runs in an isolated world (created through
// CDP for saves, or the extension content-script world for the picker preview).
// Every change is recorded on the element itself (data-p2p-* attributes) so any
// world can undo it, even after the debugger session is gone.
(() => {
  const SEL = globalThis.__p2pSelectors;
  const UI = '[data-p2p-ui]';
  const A_STYLE = 'data-p2p-style'; // original style attribute
  const A_ATTRS = 'data-p2p-attrs'; // JSON of original attribute values
  const A_HIDE = 'data-p2p-hide'; // why we hid it
  const A_KEEP = 'data-p2p-keep'; // user said keep (picker preview)
  const A_PICKED = 'data-p2p-picked'; // user hid it with the picker
  const A_EXPANDED = 'data-p2p-expanded';
  const A_REVEAL = 'data-p2p-reveal'; // forced visible (reveal-on-scroll content)
  const A_FOCUS = 'data-p2p-focus'; // modal that holds the content, printed on its own
  const A_FRAME = 'data-p2p-frame'; // iframe resized to its content height
  const A_GRID = 'data-p2p-grid'; // grid whose rows were relaxed after hiding a child
  const A_TRACK = 'data-p2p-track'; // carousel row laid out so every slide prints
  const A_SLIDE = 'data-p2p-slide'; // carousel slide shown in place
  const A_CAROUSEL_BOX = 'data-p2p-carousel-box'; // box around a carousel row, grown to fit every slide
  const NONE = '\u0000none';

  // Stylesheet !important beats inline styles that page scripts assign later
  // (el.style.opacity = '0' would replace an inline !important value).
  // Carousel scripts keep moving the row and its slides on timers and resizes.
  const FORCE_CSS = `
    [${A_HIDE}], [${A_PICKED}] { display: none !important; }
    [${A_REVEAL}] { opacity: 1 !important; visibility: visible !important; }
    [${A_REVEAL}~="transform"] { transform: none !important; translate: none !important; }
    [${A_REVEAL}~="filter"] { filter: none !important; }
    [${A_FOCUS}]::backdrop { display: none !important; }
    [${A_TRACK}] {
      position: relative !important; inset: auto !important; transform: none !important; translate: none !important;
      width: auto !important; max-width: 100% !important; height: auto !important; max-height: none !important;
      overflow: visible !important; scroll-snap-type: none !important; transition: none !important;
    }
    [${A_TRACK}]::before, [${A_TRACK}]::after { display: none !important; }
    [${A_CAROUSEL_BOX}] {
      height: auto !important; max-height: none !important; aspect-ratio: auto !important;
      overflow-y: visible !important; overflow-x: clip !important;
    }
    [${A_SLIDE}] {
      position: relative !important; inset: auto !important; transform: none !important; translate: none !important;
      opacity: 1 !important; visibility: visible !important; transition: none !important;
    }
    [${A_SLIDE}][hidden] { display: block !important; }
  `;

  const VH_PROPS = [
    'height',
    'min-height',
    'max-height',
    'width',
    'min-width',
    'max-width',
    'padding-top',
    'padding-bottom',
    'margin-top',
    'margin-bottom',
    'top',
    'bottom',
    'font-size',
    'line-height',
    'row-gap',
    'flex-basis',
    'grid-template-rows',
    'grid-auto-rows',
    'transform',
    'display',
    'position',
  ];
  const VH_MAX_ELEMENTS = 80_000;

  const BREAK_VALUES = new Set(['page', 'left', 'right', 'recto', 'verso', 'always']);
  const FILTER_IDENTITY = {
    brightness: 1,
    contrast: 1,
    saturate: 1,
    opacity: 1,
    grayscale: 0,
    sepia: 0,
    invert: 0,
    blur: 0,
    'hue-rotate': 0,
  };

  let state = freshState();

  function freshState() {
    return {
      modified: new Set(),
      hidden: [],
      warnings: [],
      scroller: null,
      scrollerTop: 0,
      paused: [],
      sheets: [],
      snapshot: null,
      main: null,
      mainH1: null,
      bodyTextLen: null,
      forceSheet: false,
      colorsForced: false,
    };
  }

  // ---------------------------------------------------------------- helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vw = () => document.documentElement.clientWidth || innerWidth;
  const vh = () => innerHeight;
  const camel = (p) => p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  function rendered(el) {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility) return el.checkVisibility();
    return el.getClientRects().length > 0;
  }

  function allElements(root = document.documentElement, out = []) {
    if (!root) return out;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.hasAttribute('data-p2p-ui') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    if (root.nodeType === 1) {
      if (root.hasAttribute('data-p2p-ui')) return out;
      out.push(root);
      if (root.shadowRoot) allElements(root.shadowRoot, out);
    }
    let n;
    while ((n = tw.nextNode())) {
      out.push(n);
      if (n.shadowRoot) allElements(n.shadowRoot, out);
    }
    return out;
  }

  function deepQuery(selector, root = document, out = []) {
    try {
      out.push(...root.querySelectorAll(selector));
    } catch {
      return out;
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepQuery(selector, el.shadowRoot, out);
    return out;
  }

  function isContents(el) {
    return getComputedStyle(el).display === 'contents';
  }

  // Children as laid out: display:contents wrappers are see-through.
  function layoutChildren(p, out = []) {
    for (const c of p.children) {
      if (c.hasAttribute('data-p2p-ui')) continue;
      if (isContents(c)) layoutChildren(c, out);
      else out.push(c);
    }
    return out;
  }

  function layoutParent(el) {
    let p = parentOf(el);
    while (p && p !== document.documentElement && isContents(p)) p = parentOf(p);
    return p;
  }

  function parentOf(el) {
    return el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  }

  function describe(el) {
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
    const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}${id}${cls} ${Math.round(r.width)}x${Math.round(r.height)}`;
  }

  function textLen(el) {
    return (el.innerText || '').length;
  }

  function bodyTextLen() {
    state.bodyTextLen ??= Math.max(1, textLen(document.body || document.documentElement));
    return state.bodyTextLen;
  }

  function linkCount(el) {
    return el.querySelectorAll('a[href], button').length;
  }

  function posOf(el) {
    return getComputedStyle(el).position;
  }

  function isPinned(el) {
    const p = posOf(el);
    return p === 'fixed' || p === 'sticky';
  }

  function outermost(list) {
    const set = new Set(list);
    return list.filter((el) => {
      for (let p = parentOf(el); p; p = parentOf(p)) if (set.has(p)) return false;
      return true;
    });
  }

  // ------------------------------------------------------- recorded changes

  function saveStyle(el) {
    if (!el.hasAttribute(A_STYLE)) {
      const orig = el.getAttribute('style');
      el.setAttribute(A_STYLE, orig === null ? NONE : orig);
    }
    state.modified.add(el);
  }

  function setStyle(el, prop, value) {
    saveStyle(el);
    el.style.setProperty(prop, value, 'important');
  }

  function saveAttr(el, name) {
    let saved = {};
    try {
      saved = JSON.parse(el.getAttribute(A_ATTRS) || '{}');
    } catch {
      saved = {};
    }
    if (!(name in saved)) {
      saved[name] = el.hasAttribute(name) ? el.getAttribute(name) : null;
      el.setAttribute(A_ATTRS, JSON.stringify(saved));
    }
    state.modified.add(el);
  }

  function setAttr(el, name, value) {
    saveAttr(el, name);
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }

  function removeClasses(el, classes) {
    const present = classes.filter((c) => el.classList.contains(c));
    if (!present.length) return 0;
    saveAttr(el, 'class');
    el.classList.remove(...present);
    return present.length;
  }

  function addClass(el, c) {
    if (el.classList.contains(c)) return;
    saveAttr(el, 'class');
    el.classList.add(c);
  }

  function ensureForceSheet() {
    if (state.forceSheet) return;
    state.forceSheet = true;
    injectStyle(FORCE_CSS);
  }

  function hide(el, reason) {
    if (el.hasAttribute(A_HIDE)) return false;
    ensureForceSheet();
    const desc = describe(el);
    // Auto-placed siblings move into the freed grid cell, which may be a short
    // fixed-height row. Let the rows size to their content instead.
    const p = layoutParent(el);
    if (p && p !== document.documentElement && /grid/.test(getComputedStyle(p).display) && !p.hasAttribute(A_GRID)) {
      setStyle(p, 'grid-template-rows', 'none');
      setStyle(p, 'grid-auto-rows', 'auto');
      setAttr(p, A_GRID, '');
    }
    setStyle(el, 'display', 'none');
    el.setAttribute(A_HIDE, reason);
    state.hidden.push({ reason, el: desc });
    return true;
  }

  function injectStyle(css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      state.sheets.push({ sheet });
      return 'adopted';
    } catch {
      const style = document.createElement('style');
      style.setAttribute('data-p2p-style-el', '');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      state.sheets.push({ el: style });
      return 'element';
    }
  }

  function revert() {
    const els = new Set(state.modified);
    for (const el of deepQuery(`[${A_STYLE}], [${A_ATTRS}], [${A_HIDE}]`)) els.add(el);
    let restored = 0;
    for (const el of els) {
      if (el.hasAttribute(A_STYLE)) {
        const orig = el.getAttribute(A_STYLE);
        el.removeAttribute(A_STYLE);
        if (orig === NONE) el.removeAttribute('style');
        else el.style.cssText = orig;
        restored++;
      }
      if (el.hasAttribute(A_ATTRS)) {
        let saved = {};
        try {
          saved = JSON.parse(el.getAttribute(A_ATTRS));
        } catch {
          saved = {};
        }
        el.removeAttribute(A_ATTRS);
        for (const [name, value] of Object.entries(saved)) {
          if (value === null) el.removeAttribute(name);
          else el.setAttribute(name, value);
        }
      }
      el.removeAttribute(A_HIDE);
    }
    for (const a of state.paused) {
      try {
        a.play();
      } catch {
        // Animation was removed.
      }
    }
    for (const s of state.sheets) {
      if (s.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s.sheet);
      s.el?.remove();
    }
    document.querySelectorAll('style[data-p2p-style-el]').forEach((s) => s.remove());
    const scroller = state.scroller;
    const scrollerTop = state.scrollerTop;
    state = freshState();
    if (scroller?.isConnected) scroller.scrollTop = scrollerTop;
    return { restored };
  }

  // ---------------------------------------------------- main content finder

  function detectMain() {
    const body = document.body;
    if (!body) return null;
    const scores = new Map();
    let total = 0;
    const W0 = vw();
    for (const el of body.querySelectorAll('p, pre, blockquote, li, dd, td, figcaption, h2, h3')) {
      if (el.closest(UI)) continue;
      const len = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
      if (len < 30 || !rendered(el)) continue;
      // Off-canvas panels ("What's new", collapsed drawers) aren't the page.
      const er = el.getBoundingClientRect();
      if (er.right <= 0 || er.left >= W0) continue;
      let linkText = 0;
      for (const a of el.querySelectorAll('a')) linkText += (a.textContent || '').length;
      if (linkText > 0.6 * len) continue; // link lists are navigation
      const w = /^(LI|TD|DD)$/.test(el.tagName) ? len * 0.6 : len;
      total += w;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        scores.set(a, (scores.get(a) || 0) + w);
      }
    }
    // A large embedded frame (course player, document viewer) or video is content
    // too, even though its text isn't visible from here. About 1 char per 100 px².
    const W = vw();
    const H = vh();
    for (const el of body.querySelectorAll('iframe, video, embed, object')) {
      if (el.closest(UI) || !rendered(el)) continue;
      if (el.tagName === 'VIDEO' && el.muted && el.autoplay && !el.controls) continue; // background video
      const r = el.getBoundingClientRect();
      if (r.width < 0.3 * W || r.width * r.height < 0.15 * W * H) continue;
      const w = (r.width * r.height) / 100;
      total += w;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        scores.set(a, (scores.get(a) || 0) + w);
      }
    }
    // Walk down from body while one child holds at least 60% of the content.
    let walk = body;
    if (total > 0) {
      for (;;) {
        let best = null;
        let bestScore = 0;
        for (const c of walk.children) {
          const s = scores.get(c) || 0;
          if (s > bestScore) {
            best = c;
            bestScore = s;
          }
        }
        if (best && bestScore >= 0.6 * total) walk = best;
        else break;
      }
    }
    const semantic = [...body.querySelectorAll('main, [role="main"]')]
      .filter(rendered)
      .sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0))[0];
    // Too little paragraph text to judge (app screens): trust the page's <main>.
    if (total < 150) return semantic || body;
    if (semantic && (walk === body || walk.contains(semantic))) return semantic;
    return walk;
  }

  function detectH1(main) {
    const siteChrome = 'header, nav, [role="banner"], [role="navigation"]';
    const h1s = [...document.querySelectorAll('h1')].filter((h) => !h.closest(UI) && rendered(h));
    const isLogo = (h) => {
      const t = (h.textContent || '').trim();
      if (!t) return true;
      if (!h.closest(siteChrome)) return false;
      const a = h.querySelector('a');
      if (a && (a.textContent || '').trim() === t) return true;
      return !!h.querySelector('img, svg') && t.length < 40;
    };
    const real = h1s.filter((h) => !isLogo(h));
    if (main && main !== document.body) {
      const inMain = real.find((h) => main.contains(h));
      if (inMain) return inMain;
    }
    if (!real.length) return null;
    return real.sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize))[0];
  }

  function ensureMain() {
    if (!state.main || !state.main.isConnected) {
      state.main = detectMain();
      state.mainH1 = detectH1(state.main);
    }
    return state.main;
  }

  function isProtected(el) {
    if (!el || el === document.documentElement || el === document.body || el === document.head) return true;
    if (el.closest(UI)) return true;
    const main = state.main;
    if (main && main !== document.body && (el === main || el.contains(main))) return true;
    if (state.mainH1 && el.contains(state.mainH1)) return true;
    if (el.closest(`[${A_KEEP}]`) || el.querySelector(`[${A_KEEP}]`)) return true;
    // Holds most of the page's text: probably content the main finder missed.
    // Link lists (menus, course outlines) don't count; on sparse pages they can
    // hold most of the text.
    const total = bodyTextLen();
    const len = textLen(el);
    if (total > 200 && len > 0.4 * total) {
      let linkText = 0;
      for (const a of el.querySelectorAll('a, button, [role="link"], [role="button"]')) linkText += (a.innerText || '').length;
      if (linkText < 0.5 * len) return true;
    }
    return false;
  }

  function canHide(el) {
    return rendered(el) && !el.hasAttribute(A_HIDE) && !el.hasAttribute(A_PICKED) && !isProtected(el);
  }

  // ---------------------------------------------------------- style scan

  function scanStyles() {
    const out = { fixed: [], sticky: [], cvAuto: [], filters: [], breaks: [], scrollables: [], shadows: [] };
    for (const el of allElements()) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      if (cs.position === 'fixed') out.fixed.push(el);
      else if (cs.position === 'sticky' || cs.position === '-webkit-sticky') out.sticky.push(el);
      if (cs.contentVisibility === 'auto') out.cvAuto.push(el);
      if ((cs.filter && cs.filter !== 'none') || (cs.backdropFilter && cs.backdropFilter !== 'none')) out.filters.push(el);
      if (cs.boxShadow && cs.boxShadow !== 'none') out.shadows.push(el);
      if (BREAK_VALUES.has(cs.breakBefore) || BREAK_VALUES.has(cs.breakAfter)) out.breaks.push(el);
      const oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 40) {
        out.scrollables.push(el);
      }
    }
    return out;
  }

  // ------------------------------------------------------- popups & locks

  function findOverlays() {
    const W = vw();
    const H = vh();
    const found = new Set();
    for (const el of deepQuery([...SEL.consent, ...SEL.chat].join(','))) {
      if (canHide(el)) found.add(el);
    }
    for (const el of scanStyles().fixed) {
      if (found.has(el) || !canHide(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const visW = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
      const isTopBar = r.top <= 4 && r.width >= 0.6 * W && r.height <= 0.4 * H;
      const isSideBar = r.height >= 0.6 * H && r.width <= 0.4 * W && (r.left <= 4 || r.right >= W - 4);
      if (isTopBar || isSideBar) continue; // handled by the nav options
      const cs = getComputedStyle(el);
      const z = parseInt(cs.zIndex, 10) || 0;
      // Modals block clicks; full-screen layers that don't are decoration.
      const isFull = visW * visH >= 0.5 * W * H && z >= 0 && cs.pointerEvents !== 'none';
      const isBottomBar = r.bottom >= H - 4 && r.height <= 0.5 * H && r.width >= 0.5 * W;
      const nearCorner = (r.right >= W - 200 || r.left <= 200) && (r.bottom >= H - 200 || r.top <= 200);
      const isWidget = r.width <= 0.4 * W && r.height <= 0.7 * H && nearCorner;
      const isDialog =
        el.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"]') ||
        !!el.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      // Small floating buttons: menu toggles, back-to-top, share, chat bubbles.
      const isControl =
        r.width <= 80 && r.height <= 80 && (el.matches('button, a, [role="button"]') || !!el.querySelector('button, a, [role="button"]'));
      if (isFull || isBottomBar || isWidget || isDialog || isControl) found.add(el);
    }
    for (const el of document.querySelectorAll('dialog')) {
      try {
        if (el.matches(':modal') && canHide(el)) found.add(el);
      } catch {
        // :modal unsupported.
      }
    }
    for (const el of document.querySelectorAll('[popover]')) {
      try {
        if (el.matches(':popover-open') && canHide(el)) found.add(el);
      } catch {
        // :popover-open unsupported.
      }
    }
    return outermost([...found]);
  }

  function unblock({ removePopups = true } = {}) {
    ensureMain();
    let unlocked = 0;
    let hidden = 0;
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowY === 'hidden' || cs.overflowY === 'clip') {
        setStyle(el, 'overflow-y', 'visible');
        unlocked++;
      }
      unlocked += removeClasses(el, SEL.lockClasses);
    }
    const body = document.body;
    if (body && getComputedStyle(body).position === 'fixed') {
      setStyle(body, 'position', 'static');
      setStyle(body, 'top', 'auto');
      unlocked++;
    }
    if (removePopups) {
      for (const el of findOverlays()) if (hide(el, 'popup')) hidden++;
    }
    return { unlocked, hidden };
  }

  // ------------------------------------------------------------ lazy load

  function looksLikeUrl(v) {
    v = String(v || '').trim();
    return !!v && !/\s/.test(v) && !/^javascript:/i.test(v) && !/^[{[]/.test(v);
  }

  function shouldReplaceSrc(img) {
    const cur = img.getAttribute('src');
    if (!cur || cur.startsWith('data:')) return true;
    if (img.complete && img.naturalWidth <= 2) return true;
    if (/placeholder|blank|spacer|lazy|loading|transparent|1x1|pixel/i.test(cur)) return true;
    // Low-quality placeholder: the loaded file is smaller than its display size.
    const r = img.getBoundingClientRect();
    return img.complete && img.naturalWidth > 0 && r.width > 0 && img.naturalWidth < r.width * 0.9;
  }

  function lockRenderedSize(img) {
    if (!img.complete || img.naturalWidth <= 2) return;
    const r = img.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    // Not recorded for undo: the upgraded image stays, so its box must stay too.
    img.style.setProperty('width', `${r.width}px`);
    img.style.setProperty('height', `${r.height}px`);
  }

  function prepassLazy() {
    let changed = 0;
    for (const img of document.querySelectorAll('img')) {
      if (img.closest(UI)) continue;
      if (img.loading === 'lazy') {
        img.loading = 'eager';
        changed++;
      }
      for (const a of SEL.lazySrcset) {
        const v = img.getAttribute(a);
        if (v && img.getAttribute('srcset') !== v) {
          img.setAttribute('srcset', v);
          changed++;
          break;
        }
      }
      for (const a of SEL.lazySrc) {
        const v = img.getAttribute(a);
        if (v && looksLikeUrl(v) && v !== img.getAttribute('src') && shouldReplaceSrc(img)) {
          lockRenderedSize(img);
          img.setAttribute('src', v);
          changed++;
          break;
        }
      }
    }
    for (const source of document.querySelectorAll('picture > source')) {
      for (const a of SEL.lazySrcset) {
        const v = source.getAttribute(a);
        if (v && source.getAttribute('srcset') !== v) {
          source.setAttribute('srcset', v);
          changed++;
          break;
        }
      }
    }
    for (const f of document.querySelectorAll('iframe')) {
      if (f.loading === 'lazy') {
        f.loading = 'eager';
        changed++;
      }
      const ds = f.getAttribute('data-src');
      const cur = f.getAttribute('src');
      if (ds && looksLikeUrl(ds) && (!cur || cur === 'about:blank')) {
        f.setAttribute('src', ds);
        changed++;
      }
    }
    const bgSel = SEL.lazyBg.map((a) => `[${a}]`).join(',');
    for (const el of document.querySelectorAll(bgSel)) {
      if (/url\(/.test(el.style.backgroundImage)) continue;
      for (const a of SEL.lazyBg) {
        const v = el.getAttribute(a);
        if (v && looksLikeUrl(v)) {
          el.style.setProperty('background-image', `url("${v.replace(/"/g, '%22')}")`);
          changed++;
          break;
        }
      }
    }
    return { changed };
  }

  // ------------------------------------------------------------- scrolling

  function findMainScroller() {
    const se = document.scrollingElement || document.documentElement;
    const docScrolls = se.scrollHeight > vh() * 1.05 + 10;
    let best = null;
    let bestArea = 0;
    for (const el of scanStyles().scrollables) {
      if (!rendered(el) || el === se || el === document.body) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 0.4 * vw() || r.height < 0.4 * vh()) continue;
      const area = r.width * Math.min(r.height, vh());
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    if (!best) return null;
    if (!docScrolls) return best;
    const main = ensureMain();
    if (main && best.contains(main) && bestArea >= 0.4 * vw() * vh()) return best;
    return null;
  }

  function scrollTarget() {
    return state.scroller || document.scrollingElement || document.documentElement;
  }

  function metrics(t = scrollTarget()) {
    const isDoc = t === document.scrollingElement || t === document.documentElement;
    const clientHeight = isDoc ? vh() : t.clientHeight;
    return {
      inner: !isDoc,
      scrollTop: Math.round(t.scrollTop),
      scrollHeight: t.scrollHeight,
      clientHeight,
      atBottom: t.scrollTop + clientHeight >= t.scrollHeight - 4,
    };
  }

  function scrollInit() {
    ensureMain();
    state.scroller = findMainScroller();
    state.scrollerTop = state.scroller ? state.scroller.scrollTop : 0;
    return metrics();
  }

  function scrollStep(fraction = 0.8) {
    const t = scrollTarget();
    const m = metrics(t);
    t.scrollTo({ top: t.scrollTop + m.clientHeight * fraction, behavior: 'instant' });
    return metrics(t);
  }

  function scrollMetrics() {
    return metrics();
  }

  function scrollToTop() {
    const t = scrollTarget();
    t.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    return metrics(t);
  }

  function restoreScroll(pos) {
    if (pos) window.scrollTo({ left: pos.x || 0, top: pos.y || 0, behavior: 'instant' });
    return true;
  }

  // ------------------------------------------------------------ navigation

  function findTopNav(round = 0) {
    const main = ensureMain();
    const W = vw();
    const H = vh();
    const scan = scanStyles();
    const candidates = new Set([...deepQuery(SEL.topNav.join(',')), ...scan.fixed, ...scan.sticky]);
    const out = [];
    for (const el of candidates) {
      if (!canHide(el)) continue;
      const r = el.getBoundingClientRect();
      const docTop = r.top + scrollY;
      const pos = posOf(el);
      const pinned = pos === 'fixed' || pos === 'sticky';
      if (pos === 'fixed' ? r.top > 4 : docTop > Math.max(200, 0.3 * H)) continue;
      if (r.width < 0.6 * W || r.height < 8 || r.height > Math.max(0.4 * H, 240)) continue;
      if (!pinned && el.closest('article')) continue;
      if (main && main !== document.body) {
        if (main.contains(el) && !pinned) {
          const strong = el.matches('header, [role="banner"], nav, [role="navigation"]');
          if (!strong || linkCount(el) < 3) continue;
        }
        // Site headers come before the content.
        if (!main.contains(el) && !(el.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING) && !pinned) {
          continue;
        }
      }
      const semantic = el.matches('header, [role="banner"], nav, [role="navigation"]');
      const navLike = pinned || semantic || !!el.querySelector('nav, [role="navigation"]') || linkCount(el) >= 2;
      if (!navLike) continue;
      // After the first bar is gone, content moves up into the top zone. Only
      // take further bars that are clearly navigation spanning the page.
      if (round > 0 && !((pinned || semantic) && r.width >= 0.85 * W)) continue;
      out.push(climbWrappers(el));
    }
    return outermost([...new Set(out)]);
  }

  // Prefer a wrapper whose only real content is this bar, so its box and spacing go too.
  function climbWrappers(el) {
    let cur = el;
    for (let i = 0; i < 4; i++) {
      const p = cur.parentElement;
      if (!p || p === document.body || p === document.documentElement || isProtected(p)) break;
      const pr = p.getBoundingClientRect();
      const cr = cur.getBoundingClientRect();
      if (pr.height > cr.height + 24 || pr.width < cr.width - 2) break;
      const others = [...p.children].filter((c) => c !== cur && rendered(c));
      const otherHasContent = others.some(
        (c) => (c.textContent || '').trim().length > 20 || c.querySelector('img, video, canvas, iframe'),
      );
      if (otherHasContent) break;
      cur = p;
    }
    return cur;
  }

  function removeTopNav() {
    const bars = [];
    for (let round = 0; round < 3; round++) {
      const found = findTopNav(round);
      if (!found.length) break;
      for (const el of found) {
        const rect = el.getBoundingClientRect();
        const pos = posOf(el);
        if (hide(el, 'top-nav')) bars.push({ el, rect, pos });
      }
    }
    compensateTopBars(bars);
    return bars.length;
  }

  // Undo padding or spacer elements that reserved room for a removed fixed header.
  function compensateTopBars(bars) {
    const fixed = bars.filter((b) => b.pos === 'fixed');
    if (!fixed.length) return;
    const total = fixed.reduce((s, b) => s + b.rect.height, 0);
    const heights = [total, ...fixed.map((b) => b.rect.height)];
    const chain = [document.documentElement, document.body];
    for (let a = state.main; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      chain.push(a);
    }
    for (const a of chain) {
      if (!a) continue;
      const cs = getComputedStyle(a);
      for (const prop of ['padding-top', 'margin-top']) {
        const v = parseFloat(cs[camel(prop)]) || 0;
        if (v >= 10 && heights.some((h) => Math.abs(v - h) <= 8)) setStyle(a, prop, '0px');
      }
    }
    for (const b of fixed) {
      let sib = b.el.nextElementSibling;
      for (let i = 0; sib && i < 2; i++, sib = sib.nextElementSibling) {
        const r = sib.getBoundingClientRect();
        const empty =
          !(sib.textContent || '').trim() && !sib.querySelector('img, svg, video, canvas, iframe, picture');
        if (empty && r.height >= 10 && Math.abs(r.height - b.rect.height) <= 8 && !isProtected(sib)) {
          hide(sib, 'top-nav-spacer');
        }
      }
    }
  }

  function sideNavCandidate(el, main) {
    const mainRect = main && main !== document.body && !main.contains(el) ? main.getBoundingClientRect() : null;
    if (!canHide(el)) return false;
    const W = vw();
    const H = vh();
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.width > 0.4 * W) return false;
    const pinned = isPinned(el);
    if (!pinned && r.height < 1.2 * r.width && r.height < 0.5 * H) return false;
    const atEdge = r.left <= 0.3 * W || r.right >= 0.7 * W;
    if (!atEdge) return false;
    if (mainRect) {
      const vOverlap = Math.min(r.bottom, mainRect.bottom) - Math.max(r.top, mainRect.top);
      if (vOverlap > 0) {
        // Side by side with the main content: must not cover it.
        const overlap = Math.max(0, Math.min(r.right, mainRect.right) - Math.max(r.left, mainRect.left));
        return overlap <= 0.2 * Math.min(r.width, mainRect.width);
      }
    }
    // Main content is above or below: a sidebar still has wider content beside it.
    return hasWiderRowNeighbor(el, r);
  }

  function hasWiderRowNeighbor(el, r) {
    let cur = el;
    for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
      const p = layoutParent(cur);
      if (!p || p === document.documentElement) break;
      for (const sib of layoutChildren(p)) {
        if (sib === cur || sib.contains(el) || !rendered(sib)) continue;
        const s = sib.getBoundingClientRect();
        if (s.width < 1.5 * r.width || s.height < 40) continue;
        const vOverlap = Math.min(s.bottom, r.bottom) - Math.max(s.top, r.top);
        if (vOverlap < 0.3 * Math.min(s.height, r.height)) continue;
        if (s.left >= r.right - 4 || s.right <= r.left + 4) return true;
      }
      cur = p;
    }
    return false;
  }

  // Columns next to the main content's ancestors, whatever their tag or class.
  function sideColumns(main) {
    const out = [];
    if (!main || main === document.body) return out;
    for (let a = main; a && a !== document.body && a !== document.documentElement; a = layoutParent(a)) {
      const p = layoutParent(a);
      if (!p || p === document.documentElement) break;
      for (const sib of layoutChildren(p)) if (sib !== a && !sib.contains(a)) out.push(sib);
    }
    return out;
  }

  function hasLargeMedia(el) {
    const r = el.getBoundingClientRect();
    for (const m of el.querySelectorAll('img, video, iframe, canvas, picture')) {
      const mr = m.getBoundingClientRect();
      if (mr.width * mr.height >= 0.4 * r.width * r.height) return true;
    }
    return false;
  }

  function findSideNav() {
    const main = ensureMain();
    const candidates = new Set(deepQuery(SEL.sideNav.join(',')));
    const scan = scanStyles();
    for (const el of [...scan.fixed, ...scan.sticky, ...sideColumns(main)]) candidates.add(el);
    const out = [];
    for (const el of candidates) {
      if (isContents(el) || !sideNavCandidate(el, main)) continue;
      const navLike =
        isPinned(el) ||
        el.matches(SEL.sideNav.join(',')) ||
        !!el.querySelector('nav, [role="navigation"], [role="tree"]') ||
        (linkCount(el) >= 3 &&
          [...el.querySelectorAll('a, button')].reduce((n, a) => n + (a.textContent || '').length, 0) >= 0.5 * textLen(el));
      if (!navLike || hasLargeMedia(el)) continue;
      // Climb to the column wrapper that holds only this sidebar.
      let cur = el;
      for (let p = layoutParent(cur); p && p !== document.documentElement && sideNavCandidate(p, main); p = layoutParent(p)) {
        cur = p;
      }
      out.push(cur);
    }
    return outermost([...new Set(out)]);
  }

  function removeSideNav() {
    const removed = [];
    for (const el of findSideNav()) {
      const rect = el.getBoundingClientRect();
      const side = rect.left + rect.width / 2 < vw() / 2 ? 'left' : 'right';
      if (hide(el, 'side-nav')) removed.push({ el, rect, side });
    }
    if (removed.length) reflowAfterSidebars(removed);
    return removed.length;
  }

  // Let the content use the space a removed sidebar leaves behind.
  function reflowAfterSidebars(removed) {
    for (const r of removed) reflowRow(r);
    const main = state.main;
    if (!main || main === document.body) return;
    for (let a = main; a && a !== document.body; a = a.parentElement) {
      const p = a.parentElement;
      if (!p) break;
      if (!removed.some((r) => p.contains(r.el)) || removed.some((r) => a.contains(r.el))) continue;
      const ps = getComputedStyle(p);
      const pr = p.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      if (ar.width >= pr.width - 8) continue;
      if (/grid/.test(ps.display)) {
        setStyle(a, 'grid-column', '1 / -1');
      } else if (/flex/.test(ps.display) && !/column/.test(ps.flexDirection)) {
        if (getComputedStyle(a).flexGrow === '0') setStyle(a, 'flex-grow', '1');
      }
    }
    for (const r of removed) {
      const W = r.rect.width;
      const chain = [];
      for (let a = main; a && a !== document.documentElement; a = a.parentElement) {
        chain.push(a);
        if (a.contains(r.el)) break;
      }
      for (const a of chain) {
        let map = null;
        try {
          map = a.computedStyleMap();
        } catch {
          map = null;
        }
        const cs = getComputedStyle(a);
        for (const box of ['margin', 'padding']) {
          const prop = `${box}-${r.side}`;
          if (map && String(map.get(prop)) === 'auto') continue;
          const v = parseFloat(cs[camel(prop)]) || 0;
          if (v >= 40 && Math.abs(v - W) <= Math.max(12, W * 0.15)) setStyle(a, prop, '0px');
        }
      }
    }
  }

  // The removed sidebar's own row: grid items beside it span the freed column,
  // and in a flex row the widest item grows into the space.
  function reflowRow(r) {
    const p = layoutParent(r.el);
    if (!p || p === document.documentElement) return;
    const ps = getComputedStyle(p);
    const pr = p.getBoundingClientRect();
    const neighbors = layoutChildren(p).filter((c) => c !== r.el && !c.contains(r.el) && rendered(c));
    const beside = neighbors.filter((c) => {
      const cr = c.getBoundingClientRect();
      return Math.min(cr.bottom, r.rect.bottom) - Math.max(cr.top, r.rect.top) > 0 && cr.width < pr.width - 8;
    });
    if (/grid/.test(ps.display)) {
      for (const c of beside) setStyle(c, 'grid-column', '1 / -1');
    } else if (/flex/.test(ps.display) && !/column/.test(ps.flexDirection)) {
      const widest = beside.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
      if (widest && getComputedStyle(widest).flexGrow === '0') setStyle(widest, 'flex-grow', '1');
    }
    for (const c of beside) {
      const cs = getComputedStyle(c);
      for (const box of ['margin', 'padding']) {
        const prop = `${box}-${r.side}`;
        const v = parseFloat(cs[camel(prop)]) || 0;
        if (v >= 40 && Math.abs(v - r.rect.width) <= Math.max(12, r.rect.width * 0.15)) setStyle(c, prop, '0px');
      }
    }
  }

  function findFooter() {
    ensureMain();
    const docH = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const out = [];
    for (const el of deepQuery(SEL.footer.join(','))) {
      if (!canHide(el) || el.closest('article')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 0.5 * vw()) continue;
      if (r.top + scrollY < 0.5 * docH) continue;
      out.push(el);
    }
    return outermost(out);
  }

  // ------------------------------------------------------- layout fixes

  function expandScroller() {
    const sc = state.scroller || findMainScroller();
    if (!sc || sc === document.scrollingElement || sc === document.body || sc === document.documentElement) {
      return false;
    }
    state.scroller = sc;
    sc.scrollTop = 0;
    for (let el = sc; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
        setStyle(el, 'overflow-y', 'visible');
        setStyle(el, 'overflow-x', cs.overflowX === 'visible' ? 'visible' : 'clip');
      }
      setStyle(el, 'height', 'auto');
      setStyle(el, 'max-height', 'none');
      if (cs.position === 'fixed') setStyle(el, 'position', 'absolute');
      if (cs.position === 'fixed' || cs.position === 'absolute') setStyle(el, 'bottom', 'auto');
      setAttr(el, A_EXPANDED, '');
    }
    for (const el of [document.documentElement, document.body]) {
      setStyle(el, 'height', 'auto');
      setStyle(el, 'overflow-y', 'visible');
    }
    return true;
  }

  // A modal dialog that holds the main content (a course or document player) is
  // the page the user is looking at. Print it alone and in normal flow.
  function focusContainer(main) {
    if (!main || main === document.body) return null;
    for (let a = main; a && a !== document.body && a !== document.documentElement; a = parentOf(a)) {
      let modal = a.matches('[aria-modal="true"], [role="dialog"]');
      if (a.tagName === 'DIALOG' && a.open) {
        try {
          modal = modal || a.matches(':modal');
        } catch {
          modal = true;
        }
      }
      if (!modal || isContents(a)) continue;
      const r = a.getBoundingClientRect();
      if (r.width * r.height >= 0.6 * vw() * vh()) return a;
    }
    return null;
  }

  function applyFocus(container) {
    let hidden = 0;
    for (let a = container; a && a !== document.documentElement; a = a.parentElement) {
      const p = a.parentElement;
      if (!p) break;
      for (const sib of p.children) {
        if (sib === a || sib.contains(a) || sib.hasAttribute('data-p2p-ui')) continue;
        if (/^(SCRIPT|STYLE|LINK|META|TEMPLATE)$/.test(sib.tagName) || !rendered(sib)) continue;
        if (hide(sib, 'behind-dialog')) hidden++;
      }
    }
    setAttr(container, A_FOCUS, '');
    for (const [prop, value] of [
      ['position', 'absolute'],
      ['top', '0px'],
      ['left', '0px'],
      ['right', 'auto'],
      ['bottom', 'auto'],
      ['width', '100%'],
      ['max-width', 'none'],
      ['height', 'auto'],
      ['max-height', 'none'],
      ['margin', '0px'],
      ['transform', 'none'],
      ['overflow', 'visible'],
    ]) {
      setStyle(container, prop, value);
    }
    return hidden;
  }

  // An iframe sized as a percentage of its box (height: 100%, or stretched by
  // inset: 0 or a grid row) collapses to 150px once that box becomes height:auto.
  // Pin frames we didn't expand to their on-screen height first.
  function lockFrameHeights() {
    let n = 0;
    for (const el of document.querySelectorAll('iframe, embed, object')) {
      if (el.hasAttribute(A_FRAME) || el.closest(UI) || !rendered(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      let h = '';
      try {
        h = String(el.computedStyleMap().get('height'));
      } catch {
        h = '';
      }
      const cs = getComputedStyle(el);
      const stretched = (cs.position === 'absolute' || cs.position === 'fixed') && cs.top !== 'auto' && cs.bottom !== 'auto';
      if (!h.endsWith('%') && h !== 'auto' && !stretched) continue;
      setStyle(el, 'height', `${r.height}px`);
      setStyle(el, 'width', `${r.width}px`);
      n++;
    }
    return n;
  }

  // Chrome won't split an iframe at a page break: if it doesn't start at the top
  // of a page and doesn't fit, it moves to the next page and leaves a blank one.
  // In a full-window player, drop what sits above the lesson frame.
  function clearAbove(el, stop) {
    let n = 0;
    for (let a = el; a && a !== stop && a !== document.body; a = parentOf(a)) {
      const p = layoutParent(a);
      if (!p || p === document.documentElement) break;
      const before = a.getBoundingClientRect();
      for (const sib of layoutChildren(p)) {
        if (sib === a || sib.contains(a)) break;
        if (!rendered(sib)) continue;
        // Only what sits above. Side-by-side columns (even collapsed, 0px wide
        // ones) stay: removing a grid item re-flows the grid.
        const sr = sib.getBoundingClientRect();
        if (sr.height <= 0 || sr.width <= 0 || sr.bottom > before.top + 2) continue;
        if (hide(sib, 'above-content')) n++;
      }
      const cs = getComputedStyle(a);
      for (const prop of ['margin-top', 'padding-top', 'border-top-width']) {
        if ((parseFloat(cs[camel(prop)]) || 0) > 0) setStyle(a, prop, '0px');
      }
      if (/grid/.test(getComputedStyle(p).display) && a.getBoundingClientRect().width < before.width - 2) {
        setStyle(a, 'grid-column', '1 / -1');
      }
    }
    return n;
  }

  function unclip(el) {
    const cs = getComputedStyle(el);
    if (cs.overflowY !== 'visible') setStyle(el, 'overflow-y', 'visible');
    if (cs.overflowX !== 'visible') setStyle(el, 'overflow-x', 'clip');
    setStyle(el, 'height', 'auto');
    setStyle(el, 'max-height', 'none');
    if (cs.position === 'fixed') setStyle(el, 'position', 'absolute');
    if (cs.position === 'fixed' || cs.position === 'absolute') setStyle(el, 'bottom', 'auto');
  }

  // Fixed-height boxes with overflow hidden or auto cut content off in print.
  // Let every box from `start` up to the root grow to fit what's inside it.
  function unclipChain(start) {
    let n = 0;
    for (let a = start; a && a !== document.body && a !== document.documentElement; a = parentOf(a)) {
      if (a.hasAttribute(A_HIDE) || isContents(a)) continue;
      if (a.scrollHeight > a.clientHeight + 4) {
        unclip(a);
        n++;
      }
    }
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      const clips = cs.overflowY !== 'visible';
      // documentElement's client height is the viewport, so only body is size-checked.
      const overflowing = el === document.body ? el.scrollHeight > el.clientHeight + 4 : true;
      if (clips && overflowing) {
        setStyle(el, 'overflow-y', 'visible');
        n++;
      }
      if (cs.height !== 'auto' && el.scrollHeight > el.clientHeight + 4) setStyle(el, 'height', 'auto');
    }
    return n;
  }

  // Scroll boxes (lesson panels, long code blocks, inner lists) only print their
  // visible part. Grow the ones that hide text, and their ancestors with them.
  function unclipScrollBoxes() {
    let n = 0;
    for (const el of scanStyles().scrollables) {
      if (!rendered(el) || el.closest(`[${A_HIDE}], [${A_PICKED}]`) || /^(TEXTAREA|SELECT)$/.test(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 0.25 * vw() || textLen(el) < 100) continue;
      n += unclipChain(el);
    }
    return n;
  }

  // ------------------------------------------------------------- carousels

  // A carousel shows one slide and keeps the others beside it (clipped by the
  // row's box), stacked under it, or hidden. In print only that slide comes out.
  // Lay the slides out one after another instead, without the clones that
  // looping carousels add and without the arrows and dots.
  const STATE_CLASS = /active|current|selected|visible|hidden|clone|duplicate|prev|next|^(is|has)-/i;
  const CLONE_CLASS = /clone|duplicate/i;
  const CONTROL_CLASS =
    /(^|[\s_-])(prev|previous|next|arrows?|dots?|bullets?|pagination|pager|indicators?|controls?|nav|counter|fraction|play|pause|autoplay|thumbs?)([\s_-]|$)/i;
  const CONTROL_LABEL = /previous|next|slide|go to|play|pause/i;
  const NOT_CAROUSEL = 'nav, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], [role="listbox"]';
  const TRACK_SEARCH_DEPTH = 6;

  const classOf = (el) => (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '');

  // The largest group of children that look alike: same tag and a shared class
  // that isn't a state like "active" (or no classes at all).
  function alikeChildren(kids) {
    const byTag = new Map();
    for (const c of kids) byTag.set(c.tagName, [...(byTag.get(c.tagName) || []), c]);
    const group = [...byTag.values()].reduce((a, b) => (b.length > a.length ? b : a));
    if (group.length < 2) return null;
    const tokens = group.map((c) => classOf(c).split(/\s+/).filter((t) => t && !STATE_CLASS.test(t)));
    if (tokens.every((t) => !t.length)) return group;
    return tokens[0].some((t) => tokens.every((ts) => ts.includes(t))) ? group : null;
  }

  // The nearest box that clips sideways; slides outside it don't show.
  function clipBox(el) {
    for (let a = el; a && a !== document.documentElement; a = parentOf(a)) {
      if (getComputedStyle(a).overflowX !== 'visible') {
        const r = a.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }
    }
    return { left: 0, right: vw() };
  }

  function slideOffView(slide, box) {
    if (slide.hasAttribute('hidden')) return true;
    const cs = getComputedStyle(slide);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) return true;
    const r = slide.getBoundingClientRect();
    return r.width > 0 && (r.right <= box.left + 2 || r.left >= box.right - 2);
  }

  // `p` holds a carousel's slides when two or more children look alike, are big
  // enough to be slides, and at least one of them is hidden or out of view.
  function slideRow(p) {
    const kids = layoutChildren(p).filter(
      (c) => !/^(SCRIPT|STYLE|TEMPLATE|LINK|BR)$/.test(c.tagName) && !c.hasAttribute(A_HIDE) && !c.hasAttribute(A_PICKED),
    );
    if (kids.length < 2) return null;
    let group = kids.filter((c) => /^slide$/i.test(c.getAttribute('aria-roledescription') || ''));
    if (group.length < 2) group = alikeChildren(kids);
    if (!group) return null;
    const slides = group.filter((s) => !CLONE_CLASS.test(classOf(s)));
    if (slides.length < 2) return null;
    const shown = slides.filter((s) => s.getClientRects().length).map((s) => s.getBoundingClientRect());
    if (!shown.length || Math.max(...shown.map((r) => r.width)) < 100 || Math.max(...shown.map((r) => r.height)) < 40) {
      return null;
    }
    const box = clipBox(p);
    if (!slides.some((s) => slideOffView(s, box)) || p.closest(NOT_CAROUSEL)) return null;
    return { track: p, slides, clones: group.filter((s) => !slides.includes(s)) };
  }

  // The row with the most slides within a few levels of the carousel's root.
  function findSlideRow(root, rows) {
    let best = null;
    const visit = (p, depth) => {
      if (p.hasAttribute(A_HIDE) || p.hasAttribute(A_PICKED) || p.hasAttribute(A_TRACK) || p.hasAttribute('data-p2p-ui')) return;
      if (!rows.has(p)) rows.set(p, slideRow(p));
      const row = rows.get(p);
      if (row && (!best || row.slides.length > best.slides.length)) best = row;
      if (depth < TRACK_SEARCH_DEPTH) for (const c of p.children) visit(c, depth + 1);
    };
    visit(root, 0);
    return best;
  }

  function unrollRow({ track, slides, clones }) {
    ensureForceSheet();
    for (const c of clones) hide(c, 'carousel-clone');
    const shown = slides.find((s) => s.getClientRects().length);
    const display = shown ? getComputedStyle(shown).display : 'block';
    const width = Math.max(...slides.map((s) => s.getBoundingClientRect().width));
    const height = Math.max(...slides.map((s) => s.getBoundingClientRect().height));
    const cs = getComputedStyle(track);
    const margin = Math.max(...slides.map((s) => parseFloat(getComputedStyle(s).marginRight) || 0));
    const gap = Math.max(16, parseFloat(cs.columnGap) || 0, margin);
    // Looping Swiper moves slides around in the DOM; keep them in slide order.
    const order = slides.map((s) => s.getAttribute('data-swiper-slide-index'));
    const ordered = order.every((v) => v !== null && /^\d+$/.test(v));
    setAttr(track, A_TRACK, '');
    setStyle(track, 'display', 'flex');
    setStyle(track, 'flex-flow', 'row wrap');
    setStyle(track, 'gap', `${gap}px`);
    slides.forEach((s, i) => {
      if (s.hasAttribute('hidden')) setAttr(s, 'hidden', null);
      if (getComputedStyle(s).display === 'none') setStyle(s, 'display', display === 'none' ? 'block' : display);
      setAttr(s, A_SLIDE, '');
      setStyle(s, 'flex', '0 0 auto');
      setStyle(s, 'box-sizing', 'border-box');
      setStyle(s, 'width', `${width}px`);
      setStyle(s, 'max-width', '100%');
      setStyle(s, 'margin-left', '0px');
      setStyle(s, 'margin-right', '0px');
      if (ordered) setStyle(s, 'order', order[i]);
    });
    for (const s of slides) {
      // A fixed height that the row's clipping used to hide would now spill
      // into the next slide.
      if (s.scrollHeight > s.clientHeight + 4) setStyle(s, 'height', 'auto');
      // A slide sized as 100% of a fixed-height box collapses once that box
      // grows to fit all the slides (hero banners with a background image).
      if (s.getBoundingClientRect().height < height * 0.5) setStyle(s, 'min-height', `${height}px`);
    }
  }

  // The carousel's own box. Arrows often sit just outside the root, so take the
  // parent too while it adds no text or images of its own.
  function carouselScope(track, root) {
    let scope = root.contains(track) ? root : track;
    const mediaSel = 'img, video, iframe, canvas, picture';
    for (let i = 0; i < 3; i++) {
      const p = parentOf(scope);
      if (!p || p === document.body || p === document.documentElement || isProtected(p)) break;
      const extraText = textLen(p) - textLen(scope);
      const extraMedia = p.querySelectorAll(mediaSel).length - scope.querySelectorAll(mediaSel).length;
      if (extraText > 40 || extraMedia > 0) break;
      scope = p;
    }
    return scope;
  }

  function isCarouselControl(el) {
    if (el.matches(SEL.carouselControls.join(',')) || CONTROL_CLASS.test(classOf(el))) return true;
    if (!el.matches('button, [role="button"], [role="tab"], a')) return false;
    const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
    return CONTROL_LABEL.test(label) || (el.innerText || '').trim().length <= 3;
  }

  function hideCarouselControls(scope, track) {
    const found = [];
    for (const el of scope.querySelectorAll('*')) {
      if (el.contains(track) || track.contains(el) || !rendered(el)) continue;
      if (isCarouselControl(el)) found.push(el);
    }
    let n = 0;
    for (const el of outermost(found)) if (canHide(el) && hide(el, 'carousel-controls')) n++;
    return n;
  }

  // Roots come in document order, so an outer carousel is unrolled before the
  // ones nested in its slides, and its scope is the outermost matching box.
  function unrollCarousels() {
    let carousels = 0;
    let slides = 0;
    let controls = 0;
    // Roots nest (".carousel" holds ".carousel-slides" holds ".carousel-slide"),
    // so the same elements come up from several roots.
    const rows = new Map();
    for (const root of deepQuery(SEL.carouselRoots.join(','))) {
      if (root === document.body || root === document.documentElement || root.closest(UI) || !rendered(root)) continue;
      if (root.closest(`[${A_HIDE}], [${A_PICKED}]`)) continue;
      const row = findSlideRow(root, rows);
      if (!row) continue;
      unrollRow(row);
      const scope = carouselScope(row.track, root);
      controls += hideCarouselControls(scope, row.track);
      // The slides are taller than the box that held one of them. Scripts reset
      // that box's height on every slide change, so the stylesheet holds it.
      for (let a = parentOf(row.track); a && a !== document.body && a !== document.documentElement; a = parentOf(a)) {
        if (!isContents(a) && a.scrollHeight > a.clientHeight + 4) {
          setAttr(a, A_CAROUSEL_BOX, '');
          if (/^(absolute|fixed)$/.test(getComputedStyle(a).position)) {
            setStyle(a, 'position', 'relative');
            for (const p of ['top', 'left', 'right', 'bottom']) setStyle(a, p, 'auto');
          }
        }
        if (a === scope) break;
      }
      unclipChain(parentOf(scope));
      rows.clear(); // positions changed
      carousels++;
      slides += row.slides.length;
    }
    return { carousels, slides, controls };
  }

  // Bottom of the last thing that actually shows: text, media, or a box with a
  // background or border. Padding and margins below it print as an empty page.
  function contentBottom() {
    let bottom = 0;
    for (const el of allElements(document.body || document.documentElement)) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || r.width <= 0) continue;
      const b = r.bottom + scrollY;
      if (b <= bottom) continue;
      let shows = /^(IMG|SVG|VIDEO|CANVAS|IFRAME|EMBED|OBJECT|INPUT|TEXTAREA|SELECT|BUTTON|PICTURE)$/i.test(el.tagName);
      if (!shows) {
        for (const n of el.childNodes) {
          if (n.nodeType === 3 && n.textContent.trim()) {
            shows = true;
            break;
          }
        }
      }
      if (!shows) {
        const cs = getComputedStyle(el);
        shows =
          cs.backgroundImage !== 'none' ||
          (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent' && el !== document.body) ||
          parseFloat(cs.borderBottomWidth) > 0;
      }
      if (shows && rendered(el)) bottom = b;
    }
    return Math.ceil(bottom);
  }

  function nodeBox(el) {
    const r = el.getBoundingClientRect();
    return { top: r.top + scrollY, height: r.height };
  }

  // An iframe prints as one picture sliced at every page boundary, so a slide or
  // a line of text can be cut in half. Inside the frame we know where those
  // boundaries fall (pageH apart, starting `offset` px into a page), so push
  // anything that would straddle one down to the next page.
  const MEDIA_TAGS = /^(IMG|PICTURE|VIDEO|CANVAS|SVG|IFRAME|EMBED|OBJECT|FIGURE)$/i;
  const CLEARANCE = 4;

  function paginate({ pageH, offset = 0, dryRun = false }) {
    if (!(pageH > 200) || !document.body) return { pushed: 0, cut: 0 };
    // Fade-in and slide-in transitions still running would move blocks after
    // they've been placed. Finish them so positions are final.
    for (const a of document.getAnimations()) {
      try {
        const t = a.effect?.getComputedTiming?.();
        if (t && t.iterations !== Infinity && Number.isFinite(t.endTime)) a.finish();
      } catch {
        // Not finishable.
      }
    }
    let pushed = 0;
    let cut = 0;
    const straddling = [];
    const boundaryAfter = (y) => (Math.floor((y + offset) / pageH) + 1) * pageH - offset;
    const visit = (el, depth) => {
      for (const child of [...el.children]) {
        if (child.hasAttribute('data-p2p-ui')) continue;
        const cs = getComputedStyle(child);
        if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
        if (cs.display === 'contents') {
          visit(child, depth);
          continue;
        }
        const r = child.getBoundingClientRect();
        if (r.height <= 0) continue;
        const top = r.top + scrollY;
        const boundary = boundaryAfter(top);
        if (top + r.height <= boundary - CLEARANCE) continue;
        // Media stays whole if it fits on a page; text blocks up to 60% of a page
        // move as a unit so no line is cut, bigger ones are looked into.
        const limit = MEDIA_TAGS.test(child.tagName) ? 0.97 * pageH : 0.6 * pageH;
        const movable = !/^(TR|TD|TH|TBODY|THEAD|TFOOT)$/.test(child.tagName);
        if (movable && r.height <= limit) {
          if (dryRun) {
            if (straddling.length < 10) straddling.push(`${describe(child)} at ${Math.round(top)} (page edge ${Math.round(boundary)})`);
          } else {
            pushDown(child, boundary - top);
          }
          pushed++;
        } else if (child.children.length && depth < 60) {
          visit(child, depth + 1);
        } else {
          cut++;
        }
      }
    };
    visit(document.body, 0);
    return dryRun ? { straddling: pushed, examples: straddling } : { pushed, cut };
  }

  function pushDown(el, amount) {
    // Land clear of the edge: layout snaps to 1/64 px, and a box starting a
    // hair above the edge still leaves a sliver on the previous page.
    amount += 1;
    const before = el.getBoundingClientRect().top;
    const mt = parseFloat(getComputedStyle(el).marginTop) || 0;
    // The new margin collapses with the previous sibling's bottom margin, so a
    // small one changes nothing. Start from the gap that's actually there.
    const prev = el.previousElementSibling;
    let gap = mt;
    if (prev) {
      const ps = getComputedStyle(prev);
      if (ps.display !== 'none' && (ps.position === 'static' || ps.position === 'relative')) {
        gap = Math.max(mt, before - prev.getBoundingClientRect().bottom);
      }
    }
    let next = gap + amount;
    setStyle(el, 'margin-top', `${next}px`);
    for (let i = 0; i < 6; i++) {
      const moved = el.getBoundingClientRect().top - before;
      if (moved >= amount - 0.25) break;
      next += amount - moved;
      setStyle(el, 'margin-top', `${next}px`);
    }
  }

  // Called through CDP on the <iframe> element that hosts a child frame, once the
  // child has reported its full content height.
  function expandFrameOwner(frame, height) {
    const r = frame.getBoundingClientRect();
    const cs = getComputedStyle(frame);
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      setStyle(frame, 'position', 'relative');
      for (const p of ['top', 'left', 'right', 'bottom']) setStyle(frame, p, 'auto');
    }
    // The content height was measured at this width. If the frame got narrower
    // (or collapsed when a grid re-flows) its text would rewrap and be cut off.
    if (!frame.hasAttribute(A_FRAME) && r.width > 0) {
      setStyle(frame, 'width', `${r.width}px`);
      setStyle(frame, 'min-width', `${r.width}px`);
      setStyle(frame, 'max-width', 'none');
    }
    setStyle(frame, 'height', `${height}px`);
    setStyle(frame, 'min-height', `${height}px`);
    setStyle(frame, 'vertical-align', 'top'); // no baseline gap below an inline iframe
    setStyle(frame, 'max-height', 'none');
    setAttr(frame, A_FRAME, '');
    const unclipped = unclipChain(parentOf(frame));
    return { before: Math.round(r.height), after: height, unclipped };
  }

  function neutralizePinned() {
    const { fixed, sticky } = scanStyles();
    const fixedSet = new Set(
      fixed.filter((el) => rendered(el) && !el.hasAttribute(A_EXPANDED) && !el.closest(`[${A_EXPANDED}]`)),
    );
    let n = 0;
    // Outermost first: nested fixed elements move with their parent.
    for (const el of outermost([...fixedSet])) {
      const before = el.getBoundingClientRect();
      let stretchedV = false;
      try {
        const map = el.computedStyleMap();
        stretchedV = String(map.get('top')) !== 'auto' && String(map.get('bottom')) !== 'auto';
      } catch {
        stretchedV = false;
      }
      setStyle(el, 'position', 'absolute');
      setStyle(el, 'width', `${before.width}px`);
      if (stretchedV) setStyle(el, 'height', `${before.height}px`);
      setStyle(el, 'right', 'auto');
      setStyle(el, 'bottom', 'auto');
      setStyle(el, 'top', '0px');
      setStyle(el, 'left', '0px');
      const after = el.getBoundingClientRect();
      setStyle(el, 'top', `${before.top - after.top}px`);
      setStyle(el, 'left', `${before.left - after.left}px`);
      n++;
    }
    for (const el of sticky) {
      if (!rendered(el)) continue;
      setStyle(el, 'position', 'relative');
      for (const p of ['top', 'bottom', 'left', 'right']) setStyle(el, p, 'auto');
      n++;
    }
    return n;
  }

  function settleAnimations() {
    let finished = 0;
    let paused = 0;
    for (const a of document.getAnimations()) {
      try {
        const t = a.effect?.getComputedTiming?.();
        if (t && t.iterations !== Infinity && Number.isFinite(t.endTime)) {
          a.finish();
          finished++;
        } else if (a.playState === 'running') {
          a.pause();
          state.paused.push(a);
          paused++;
        }
      } catch {
        // Some animations can't be finished (e.g. scroll-driven).
      }
    }
    // AOS keeps content at opacity 0 until it adds .aos-animate.
    for (const el of document.querySelectorAll('[data-aos]:not(.aos-animate)')) addClass(el, 'aos-animate');
    // WOW.js and ScrollReveal hide elements until they scroll into view.
    for (const el of document.querySelectorAll('.wow, [data-sr-id], [data-scroll-reveal]')) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
        setStyle(el, 'animation-name', 'none');
        reveal(el, ['transform']);
      }
    }
    // Framer Motion / GSAP leave inline opacity:0 plus a transform on content that
    // scrolled out of view again. Inside a carousel that's slide state, unless
    // the slides were laid out to print: then it's a caption that animates in
    // when its slide becomes current.
    const main = state.main || document.body;
    const skip = [...SEL.carousel, ...SEL.transient].join(',');
    let revealed = 0;
    for (const el of document.querySelectorAll('[style*="opacity"]')) {
      const s = el.style;
      if (s.opacity !== '0' || !(s.transform || s.translate || s.visibility || s.willChange || s.filter)) continue;
      if (!main.contains(el) || el.closest(UI)) continue;
      const slide = el.closest(`[${A_SLIDE}]`);
      if (slide) {
        // Carousels mark slides that aren't current aria-hidden; only menus and
        // tooltips inside the slide keep their hidden state.
        const t = el.closest(SEL.transient.join(','));
        if (t && t !== slide && slide.contains(t)) continue;
      } else if (el.closest(skip)) {
        continue;
      }
      if (el.hasAttribute(A_HIDE) || el.hasAttribute(A_PICKED) || el.hasAttribute(A_REVEAL)) continue;
      const parts = [];
      if (s.transform || s.translate) parts.push('transform');
      if (/blur/.test(s.filter)) parts.push('filter');
      reveal(el, parts);
      revealed++;
    }
    return { finished, paused, revealed };
  }

  function reveal(el, parts) {
    ensureForceSheet();
    setStyle(el, 'opacity', '1');
    setStyle(el, 'visibility', 'visible');
    if (parts.includes('transform')) setStyle(el, 'transform', 'none');
    if (parts.includes('filter')) setStyle(el, 'filter', 'none');
    setAttr(el, A_REVEAL, ['on', ...parts].join(' '));
  }

  // Last pass right before printing: page scripts may have reacted to the
  // viewport probe and hidden reveal-on-scroll content again.
  // Also forces background colors and images to print. printToPDF's
  // printBackground doesn't reach out-of-process frames.
  function finalize() {
    if (!state.colorsForced) {
      state.colorsForced = true;
      injectStyle(`html, html *, html *::before, html *::after {
        -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }`);
    }
    return settleAnimations();
  }

  function isIdentityFilter(v) {
    if (!v || v === 'none') return false;
    const fns = [...v.matchAll(/([a-z-]+)\(([^)]*)\)/g)];
    if (!fns.length) return false;
    return fns.every(([, name, arg]) => {
      if (!(name in FILTER_IDENTITY)) return false;
      let n = parseFloat(arg);
      if (/%/.test(arg)) n /= 100;
      return n === FILTER_IDENTITY[name];
    });
  }

  function layoutFixes({ continuous }) {
    const scan = scanStyles();
    let cv = 0;
    for (const el of scan.cvAuto) {
      setStyle(el, 'content-visibility', 'visible');
      cv++;
    }
    // Chrome rasterizes filters and blurred shadows. On a box taller than a
    // couple of screens that means a huge image, and a filter also turns all the
    // text inside it into pixels. Drop them there; elsewhere drop only the ones
    // that change nothing.
    const tall = (el) => el.getBoundingClientRect().height > 2 * vh();
    let filters = 0;
    for (const el of scan.filters) {
      const cs = getComputedStyle(el);
      const big = tall(el);
      if (big || isIdentityFilter(cs.filter)) {
        if (cs.filter !== 'none') setStyle(el, 'filter', 'none');
        filters++;
      }
      if (big || isIdentityFilter(cs.backdropFilter)) {
        if (cs.backdropFilter && cs.backdropFilter !== 'none') setStyle(el, 'backdrop-filter', 'none');
        filters++;
      }
    }
    let shadows = 0;
    for (const el of scan.shadows) {
      if (!tall(el)) continue;
      setStyle(el, 'box-shadow', 'none');
      shadows++;
    }
    let breaks = 0;
    if (continuous) {
      for (const el of scan.breaks) {
        setStyle(el, 'break-before', 'auto');
        setStyle(el, 'break-after', 'auto');
        breaks++;
      }
    }
    return { contentVisibility: cv, filters, tallShadows: shadows, forcedBreaks: breaks };
  }

  function layout(opts = {}) {
    scrollToTop();
    state.main = detectMain();
    state.mainH1 = detectH1(state.main);
    state.bodyTextLen = null;
    const result = { main: state.main ? describe(state.main) : null };
    result.lockedFrames = lockFrameHeights();
    const focus = focusContainer(state.main);
    if (focus) {
      result.focus = describe(focus);
      result.behindDialog = applyFocus(focus);
      const frame = state.main && (state.main.matches(`[${A_FRAME}]`) ? state.main : state.main.querySelector(`[${A_FRAME}]`));
      if (frame) result.clearedAbove = clearAbove(frame, focus);
    }
    if (opts.removePopups) {
      let n = 0;
      for (const el of findOverlays()) if (hide(el, 'popup')) n++;
      result.popups = n;
    }
    if (opts.removeTopNav) result.topNav = removeTopNav();
    if (opts.removeSideNav) result.sideNav = removeSideNav();
    if (opts.removeFooter) {
      let n = 0;
      for (const el of findFooter()) if (hide(el, 'footer')) n++;
      result.footer = n;
    }
    result.carousels = unrollCarousels();
    result.expandedScroller = expandScroller();
    result.unclipped = unclipChain(state.main) + unclipScrollBoxes();
    result.pinned = neutralizePinned();
    result.animations = settleAnimations();
    Object.assign(result, layoutFixes(opts));
    scrollToTop();
    return result;
  }

  // Dry run for the picker preview: what would the toggles remove right now?
  function detect(opts = {}) {
    state.main = detectMain();
    state.mainH1 = detectH1(state.main);
    state.bodyTextLen = null;
    const out = [];
    const add = (els, reason) => els.forEach((el) => out.push({ el, reason }));
    if (opts.removePopups) add(findOverlays(), 'popup');
    if (opts.removeTopNav) add(findTopNav(), 'top-nav');
    if (opts.removeSideNav) add(findSideNav(), 'side-nav');
    if (opts.removeFooter) add(findFooter(), 'footer');
    const seen = new Set();
    return out.filter(({ el }) => !seen.has(el) && seen.add(el));
  }

  // --------------------------------------------------------------- images

  function parseSrcset(input) {
    const out = [];
    const s = String(input || '');
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (i >= s.length) break;
      let start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let desc = '';
      if (/,+$/.test(url)) {
        url = url.replace(/,+$/, '');
      } else {
        start = i;
        let depth = 0;
        while (i < s.length) {
          const c = s[i];
          if (c === '(') depth++;
          else if (c === ')') depth = Math.max(0, depth - 1);
          else if (c === ',' && depth === 0) break;
          i++;
        }
        desc = s.slice(start, i).trim();
        i++;
      }
      if (!url) continue;
      const cand = { url, w: null, x: null };
      for (const d of desc.split(/\s+/).filter(Boolean)) {
        const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(d);
        if (!m) continue;
        if (m[2].toLowerCase() === 'w') cand.w = Number(m[1]);
        else cand.x = Number(m[1]);
      }
      out.push(cand);
    }
    return out;
  }

  function pickLargest(cands) {
    const ws = cands.filter((c) => c.w);
    if (ws.length) return ws.reduce((a, b) => (b.w > a.w ? b : a));
    return cands.reduce((a, b) => ((b.x || 1) > (a.x || 1) ? b : a));
  }

  function descriptorOf(c) {
    if (c.w) return `${c.w}w`;
    if (c.x && c.x !== 1) return `${c.x}x`;
    return '';
  }

  function splitTopLevel(s) {
    const out = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        out.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(s.slice(start).trim());
    return out.filter(Boolean);
  }

  // image-set(url(a) 1x, url(b) 2x) -> image-set(url(b) 2x). Print picks from
  // image-set at its own density, so leave it only one choice.
  function pinImageSet(layer) {
    const m = /^(?:-webkit-)?image-set\(([\s\S]*)\)$/i.exec(layer.trim());
    if (!m) return null;
    const cands = [];
    for (const opt of splitTopLevel(m[1])) {
      const um = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/i.exec(opt);
      if (!um) continue;
      const url = um[1] ?? um[2] ?? um[3];
      const rm = /(\d*\.?\d+)(x|dppx|dpi|dpcm)\b/i.exec(opt.replace(um[0], ''));
      let res = 1;
      if (rm) {
        const v = parseFloat(rm[1]);
        const unit = rm[2].toLowerCase();
        res = unit === 'dpi' ? v / 96 : unit === 'dpcm' ? (v * 2.54) / 96 : v;
      }
      cands.push({ url, res });
    }
    if (cands.length < 2) return null;
    const best = cands.reduce((a, b) => (b.res > a.res ? b : a));
    return { css: `image-set(url("${best.url.replace(/"/g, '\\"')}") ${best.res}x)`, url: best.url };
  }

  function upgradeBackgrounds() {
    const urls = [];
    for (const el of allElements()) {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || !/image-set\(/i.test(bg)) continue;
      let changed = false;
      const layers = splitTopLevel(bg).map((layer) => {
        const pinned = pinImageSet(layer);
        if (!pinned) return layer;
        changed = true;
        urls.push(pinned.url);
        return pinned.css;
      });
      if (changed) setStyle(el, 'background-image', layers.join(', '));
    }
    return urls;
  }

  function preload(urls, ms) {
    return Promise.all(
      [...new Set(urls)].map(
        (url) =>
          new Promise((resolve) => {
            const img = new Image();
            const timer = setTimeout(resolve, ms);
            img.onload = img.onerror = () => {
              clearTimeout(timer);
              resolve();
            };
            img.src = url;
          }),
      ),
    );
  }

  // Pin srcset to its single largest candidate, keeping the descriptor so the
  // layout size stays the same and print can't fall back to a smaller file.
  async function upgradeImages() {
    let upgraded = 0;
    const pin = (el) => {
      const ss = el.getAttribute('srcset');
      if (!ss) return;
      const cands = parseSrcset(ss);
      if (cands.length < 2) return;
      const best = pickLargest(cands);
      const value = `${best.url} ${descriptorOf(best)}`.trim();
      if (value === ss.trim()) return;
      el.setAttribute('srcset', value);
      upgraded++;
    };
    for (const img of document.querySelectorAll('img[srcset]')) if (!img.closest(UI)) pin(img);
    for (const source of document.querySelectorAll('picture > source[srcset]')) pin(source);
    const bgUrls = upgradeBackgrounds();
    await preload(bgUrls, 15_000);
    return { upgraded: upgraded + bgUrls.length, backgrounds: bgUrls.length };
  }

  async function waitImages({ perImageMs = 15_000, totalMs = 30_000 } = {}) {
    const imgs = [...document.images].filter((img) => !img.closest(UI) && rendered(img));
    const t0 = performance.now();
    const stats = { total: imgs.length, done: 0, failed: 0, timedOut: 0 };
    const one = (img) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          stats.timedOut++;
          resolve();
        }, perImageMs);
        img.decode().then(
          () => {
            clearTimeout(timer);
            stats.done++;
            resolve();
          },
          () => {
            clearTimeout(timer);
            if (img.naturalWidth > 0) stats.done++;
            else stats.failed++;
            resolve();
          },
        );
      });
    await Promise.race([Promise.all(imgs.map(one)), sleep(totalMs)]);
    stats.ms = Math.round(performance.now() - t0);
    return stats;
  }

  async function fontsReady(ms = 5000) {
    await Promise.race([document.fonts?.ready, sleep(ms)]);
    return document.fonts?.status || 'unknown';
  }

  // ------------------------------------------------- viewport-unit freeze

  function vhSnapshot() {
    const snap = new Map();
    const els = allElements();
    for (const el of els) {
      if (snap.size >= VH_MAX_ELEMENTS) {
        state.warnings.push(`Viewport-unit check limited to ${VH_MAX_ELEMENTS} elements`);
        break;
      }
      if (!el.computedStyleMap) continue;
      let map;
      try {
        map = el.computedStyleMap();
      } catch {
        continue;
      }
      // Hidden elements only need their display tracked: a height media query
      // could reveal them in print.
      if (String(map.get('display')) === 'none') {
        snap.set(
          el,
          VH_PROPS.map((p) => (p === 'display' ? 'none' : '')),
        );
        continue;
      }
      snap.set(
        el,
        VH_PROPS.map((p) => {
          try {
            return String(map.get(p));
          } catch {
            return '';
          }
        }),
      );
    }
    state.snapshot = snap;
    return { count: snap.size, viewport: { w: innerWidth, h: innerHeight } };
  }

  // Called while the viewport is emulated at the print page height: anything that
  // changed depends on the viewport height, so pin it back to the screen value.
  function vhFreeze() {
    const snap = state.snapshot;
    if (!snap) return { frozen: 0 };
    const changes = [];
    for (const [el, vals] of snap) {
      if (!el.isConnected) continue;
      let map;
      try {
        map = el.computedStyleMap();
      } catch {
        continue;
      }
      for (let i = 0; i < VH_PROPS.length; i++) {
        if (!vals[i]) continue;
        let now;
        try {
          now = String(map.get(VH_PROPS[i]));
        } catch {
          continue;
        }
        if (now !== vals[i]) changes.push([el, VH_PROPS[i], vals[i]]);
      }
    }
    for (const [el, prop, val] of changes) setStyle(el, prop, val);
    return {
      frozen: changes.length,
      viewport: { w: innerWidth, h: innerHeight },
      sample: changes.slice(0, 8).map(([el, p, v]) => `${describe(el)} ${p}=${v}`),
    };
  }

  async function settle(frames = 2) {
    for (let i = 0; i < frames; i++) {
      await Promise.race([new Promise((r) => requestAnimationFrame(() => r())), sleep(200)]);
    }
    await sleep(50);
    return true;
  }

  // ---------------------------------------------------- print-time fixes

  // Content wider than the page makes Chrome shrink the whole print. Clip it.
  function fixHorizontalOverflow() {
    const de = document.documentElement;
    const body = document.body;
    const cw = de.clientWidth;
    const widest = () => Math.max(de.scrollWidth, body ? body.scrollWidth : 0);
    const before = widest();
    if (before <= cw + 1) return { fixed: false, before, cw };
    setStyle(de, 'overflow-x', 'clip');
    if (body) setStyle(body, 'overflow-x', 'clip');
    return { fixed: true, before, cw };
  }

  function injectPageRule(marginIn) {
    const m = Number(marginIn) || 0;
    return injectStyle(`@page { margin: ${m}in !important; }`);
  }

  function measure() {
    const de = document.documentElement;
    const se = document.scrollingElement || de;
    const b = document.body;
    return {
      cssW: de.clientWidth,
      innerW: innerWidth,
      innerH: innerHeight,
      scrollH: Math.max(se.scrollHeight, de.scrollHeight, b ? b.scrollHeight : 0),
      contentBottom: contentBottom(),
      scrollW: Math.max(se.scrollWidth, de.scrollWidth),
      dpr: devicePixelRatio,
      elementCount: document.getElementsByTagName('*').length,
      screenMedia: matchMedia('screen').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  }

  function init() {
    state = freshState();
    return {
      title: document.title,
      url: location.href,
      contentType: document.contentType,
      viewW: innerWidth,
      viewH: innerHeight,
      visibility: document.visibilityState,
      scroll: { x: scrollX, y: scrollY },
      elementCount: document.getElementsByTagName('*').length,
    };
  }

  function report() {
    return { hidden: state.hidden, warnings: state.warnings };
  }

  // The main heading's text, for naming the file.
  function heading() {
    ensureMain();
    const h = state.mainH1;
    return h ? (h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  }

  globalThis.__p2p = {
    init,
    heading,
    unblock,
    prepassLazy,
    scrollInit,
    scrollStep,
    scrollMetrics,
    scrollToTop,
    restoreScroll,
    layout,
    detect,
    upgradeImages,
    waitImages,
    fontsReady,
    vhSnapshot,
    vhFreeze,
    settle,
    finalize,
    expandFrameOwner,
    nodeBox,
    paginate,
    fixHorizontalOverflow,
    injectPageRule,
    measure,
    revert,
    report,
    parseSrcset,
    isIdentityFilter,
  };
})();
