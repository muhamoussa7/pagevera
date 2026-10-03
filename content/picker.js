// Click-to-remove picker. Injected with chrome.scripting into the content-script
// world, after selectors.js and agent.js (used for the auto-removal preview).
(() => {
  if (globalThis.__p2pPicker) return;

  const A_PICKED = 'data-p2p-picked';
  const A_PSTYLE = 'data-p2p-pstyle';
  const A_KEEP = 'data-p2p-keep';
  const NONE = '\u0000none';
  const REASONS = { popup: 'Popup', 'top-nav': 'Top nav', 'side-nav': 'Side nav', footer: 'Footer' };

  let host = null;
  let ui = null;
  let settings = {};
  let current = null;
  let downStack = [];
  let history = [];
  let mode = 'off'; // off | pick | saving | result
  let preview = [];
  let raf = 0;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root { position: fixed; inset: 0; pointer-events: none; font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #f4f4f5; }
    .root.probe, .root.probe * { pointer-events: none !important; }
    .layer { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: transparent; }
    .preview { position: fixed; inset: 0; pointer-events: none; }
    .pv { position: fixed; pointer-events: auto; cursor: pointer; border: 2px dashed #f97316;
          background: repeating-linear-gradient(135deg, rgba(249,115,22,.16) 0 8px, rgba(249,115,22,.05) 8px 16px); }
    .pv.kept { border-color: #22c55e; background: rgba(34,197,94,.08); }
    .pv span { position: absolute; top: 0; left: 0; background: #f97316; color: #111; font-size: 11px; font-weight: 600; padding: 2px 6px; }
    .pv.kept span { background: #22c55e; }
    .hl { position: fixed; pointer-events: none; border: 2px solid #ef4444; background: rgba(239,68,68,.14); border-radius: 2px; display: none; }
    .hl .label { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; background: #18181b; color: #fafafa;
                 font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
    .hl.below .label { bottom: auto; top: 100%; margin: 4px 0 0; }
    .bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); pointer-events: auto; display: flex; align-items: center; gap: 8px;
           background: rgba(24,24,27,.96); border: 1px solid rgba(255,255,255,.1); border-radius: 12px; padding: 8px 8px 8px 14px;
           box-shadow: 0 12px 32px rgba(0,0,0,.35); max-width: calc(100vw - 24px); flex-wrap: wrap; }
    .title { font-weight: 600; }
    .count { color: #a1a1aa; min-width: 64px; }
    .toggle { display: flex; align-items: center; gap: 6px; color: #d4d4d8; cursor: pointer; user-select: none; }
    .toggle input { accent-color: #f97316; margin: 0; }
    button { font: inherit; border: 0; border-radius: 8px; padding: 6px 12px; cursor: pointer; background: #3f3f46; color: #fafafa; }
    button:hover { background: #52525b; }
    button.primary { background: #2563eb; }
    button.primary:hover { background: #1d4ed8; }
    button:disabled { opacity: .45; cursor: default; }
    .hint { position: fixed; left: 50%; bottom: 70px; transform: translateX(-50%); color: #e4e4e7; background: rgba(24,24,27,.85);
            font-size: 11px; padding: 3px 10px; border-radius: 999px; pointer-events: none; white-space: nowrap; }
    .msg { max-width: 420px; }
    .msg.error { color: #fca5a5; }
    .hidden { display: none !important; }
  `;

  function build() {
    host = document.createElement('div');
    host.setAttribute('data-p2p-ui', '');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="root">
        <div class="layer"></div>
        <div class="preview"></div>
        <div class="hl"><div class="label"></div></div>
        <div class="hint">Click to remove · ↑ parent · ↓ child · ⌫ undo · Enter save · Esc cancel</div>
        <div class="bar pick">
          <span class="title">Click what to remove</span>
          <span class="count">0 removed</span>
          <label class="toggle"><input type="checkbox" class="pv-toggle"> Show automatic removals</label>
          <button class="undo" disabled>Undo</button>
          <button class="cancel">Cancel</button>
          <button class="save primary">Save PDF</button>
        </div>
        <div class="bar result hidden">
          <span class="msg"></span>
          <button class="edit">Keep editing</button>
          <button class="restore">Restore page</button>
          <button class="close">Close</button>
        </div>
      </div>`;
    const $ = (s) => shadow.querySelector(s);
    ui = {
      root: $('.root'),
      layer: $('.layer'),
      preview: $('.preview'),
      hl: $('.hl'),
      label: $('.label'),
      hint: $('.hint'),
      pickBar: $('.bar.pick'),
      resultBar: $('.bar.result'),
      count: $('.count'),
      undo: $('.undo'),
      msg: $('.msg'),
      pvToggle: $('.pv-toggle'),
    };
    ui.layer.addEventListener('mousemove', (e) => setCurrent(pick(e.clientX, e.clientY)));
    ui.layer.addEventListener('mouseleave', () => setCurrent(null));
    ui.layer.addEventListener('click', onClick);
    ui.layer.addEventListener('wheel', onWheel, { passive: false });
    ui.undo.addEventListener('click', undo);
    $('.cancel').addEventListener('click', cancel);
    $('.save').addEventListener('click', save);
    $('.edit').addEventListener('click', () => setMode('pick'));
    $('.restore').addEventListener('click', () => {
      restoreAll();
      teardown();
    });
    $('.close').addEventListener('click', teardown);
    ui.pvToggle.addEventListener('change', () => (ui.pvToggle.checked ? showPreview() : clearPreview()));
    document.documentElement.appendChild(host);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
  }

  function setMode(next) {
    mode = next;
    if (!host) return;
    host.style.display = next === 'saving' ? 'none' : '';
    const picking = next === 'pick';
    ui.layer.classList.toggle('hidden', !picking);
    ui.hint.classList.toggle('hidden', !picking);
    ui.pickBar.classList.toggle('hidden', !picking);
    ui.resultBar.classList.toggle('hidden', next !== 'result');
    ui.preview.classList.toggle('hidden', !picking);
    if (!picking) setCurrent(null);
    updateCount();
  }

  // ------------------------------------------------------------- picking

  function pick(x, y) {
    ui.root.classList.add('probe');
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    ui.root.classList.remove('probe');
    if (!el || el === host || el === document.documentElement || el === document.body) return null;
    return el;
  }

  function describe(el) {
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
    const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}${id}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function setCurrent(el) {
    if (el !== current) downStack = [];
    current = el;
    positionHighlight();
  }

  function positionHighlight() {
    if (!ui) return;
    if (!current || !current.isConnected || mode !== 'pick') {
      ui.hl.style.display = 'none';
      return;
    }
    const r = current.getBoundingClientRect();
    Object.assign(ui.hl.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    ui.hl.classList.toggle('below', r.top < 24);
    ui.label.textContent = describe(current);
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = current || pick(e.clientX, e.clientY);
    if (!el) return;
    hideEl(el);
    setCurrent(pick(e.clientX, e.clientY));
    refreshPreview();
  }

  function onWheel(e) {
    e.preventDefault();
    const under = pick(e.clientX, e.clientY);
    let target = null;
    for (let el = under; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        target = el;
        break;
      }
    }
    (target || document.scrollingElement || document.documentElement).scrollBy({
      top: e.deltaY,
      left: e.deltaX,
      behavior: 'instant',
    });
    requestAnimationFrame(() => setCurrent(pick(e.clientX, e.clientY)));
  }

  function onKey(e) {
    if (mode !== 'pick') return;
    const k = e.key;
    let handled = true;
    if (k === 'Escape') cancel();
    else if (k === 'Enter') save();
    else if (k === 'Backspace' || k === 'Delete' || ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z')) undo();
    else if (k === 'ArrowUp' && current) {
      const p = current.parentElement;
      if (p && p !== document.body && p !== document.documentElement) {
        const stack = [...downStack, current];
        current = p;
        downStack = stack;
        positionHighlight();
      }
    } else if (k === 'ArrowDown' && current) {
      const next = downStack.pop() || [...current.children].find((c) => c.getClientRects().length);
      if (next) {
        current = next;
        positionHighlight();
      }
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  // ------------------------------------------------------ hiding & undo

  function hideEl(el) {
    if (!el.hasAttribute(A_PSTYLE)) el.setAttribute(A_PSTYLE, el.getAttribute('style') ?? NONE);
    el.style.setProperty('display', 'none', 'important');
    el.setAttribute(A_PICKED, '1');
    history.push(el);
    updateCount();
  }

  function unhideEl(el) {
    const orig = el.getAttribute(A_PSTYLE);
    el.removeAttribute(A_PSTYLE);
    el.removeAttribute(A_PICKED);
    if (orig === null || orig === NONE) el.removeAttribute('style');
    else el.style.cssText = orig;
  }

  function undo() {
    const el = history.pop();
    if (el) unhideEl(el);
    updateCount();
    refreshPreview();
  }

  function restoreAll() {
    for (const el of document.querySelectorAll(`[${A_PICKED}]`)) unhideEl(el);
    for (const el of document.querySelectorAll(`[${A_KEEP}]`)) el.removeAttribute(A_KEEP);
    history = [];
  }

  function updateCount() {
    if (!ui) return;
    const n = document.querySelectorAll(`[${A_PICKED}]`).length;
    ui.count.textContent = `${n} removed`;
    ui.undo.disabled = history.length === 0;
  }

  // ----------------------------------------------------------- preview

  function showPreview() {
    clearPreview();
    let items = [];
    try {
      items = globalThis.__p2p?.detect(settings) || [];
    } catch (e) {
      console.warn('PageVera preview failed', e);
    }
    preview = items.map(({ el, reason }) => {
      const box = document.createElement('div');
      box.className = 'pv';
      box.title = 'Click to keep this element';
      const tag = document.createElement('span');
      box.appendChild(tag);
      const item = { el, reason, box, tag };
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.hasAttribute(A_KEEP)) el.removeAttribute(A_KEEP);
        else el.setAttribute(A_KEEP, '1');
        paintPreviewItem(item);
      });
      ui.preview.appendChild(box);
      paintPreviewItem(item);
      return item;
    });
    positionPreview();
  }

  function paintPreviewItem(item) {
    const kept = item.el.hasAttribute(A_KEEP);
    item.box.classList.toggle('kept', kept);
    item.tag.textContent = `${REASONS[item.reason] || item.reason}${kept ? ' · kept' : ' · will be removed'}`;
  }

  function positionPreview() {
    for (const { el, box } of preview) {
      const r = el.getBoundingClientRect();
      const visible = el.isConnected && r.width > 0 && r.height > 0 && !el.hasAttribute(A_PICKED);
      box.style.display = visible ? 'block' : 'none';
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }
  }

  function clearPreview() {
    preview.forEach((p) => p.box.remove());
    preview = [];
  }

  function refreshPreview() {
    if (ui?.pvToggle.checked) showPreview();
  }

  function schedule() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      positionHighlight();
      positionPreview();
    });
  }

  // ------------------------------------------------------------ actions

  function save() {
    if (mode !== 'pick') return;
    clearPreview();
    ui.pvToggle.checked = false;
    setMode('saving');
    chrome.runtime.sendMessage({ type: 'picker-save' }).catch((e) => showResult(false, e.message));
  }

  function cancel() {
    restoreAll();
    teardown();
  }

  function showResult(ok, text) {
    setMode('result');
    ui.msg.textContent = text;
    ui.msg.classList.toggle('error', !ok);
  }

  function teardown() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    clearPreview();
    host?.remove();
    host = null;
    ui = null;
    current = null;
    mode = 'off';
    chrome.runtime.sendMessage({ type: 'picker-closed' }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'p2p-status' || mode !== 'saving') return;
    const s = msg.status;
    if (s.state === 'done') showResult(true, `Saved ${s.filename || 'PDF'}.`);
    else if (s.state === 'error') showResult(false, s.message || 'Saving failed.');
    else if (s.state === 'cancelled') setMode('pick');
  });

  globalThis.__p2pPicker = {
    start(s) {
      settings = s || {};
      if (!host) build();
      setMode('pick');
    },
    get mode() {
      return mode;
    },
    stop: teardown,
  };
})();
