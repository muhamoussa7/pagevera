// Turns the prepared page into Markdown. Loaded after agent.js in the same world,
// so by the time this runs the removals have been applied and hidden elements
// have display: none, which is how they are skipped here.
(() => {
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed',
    'button', 'select', 'input', 'textarea', 'dialog', 'head', 'meta', 'link',
  ]);

  function skip(el) {
    if (SKIP_TAGS.has(el.localName) || el.hidden || el.closest('[data-p2p-ui]')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse';
  }

  const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ').trim();

  // Keeps the spaces around the text outside the markers, so "a <b>b</b> c" stays valid.
  function wrap(s, mark) {
    const t = s.trim();
    if (!t) return s;
    return `${s.slice(0, s.indexOf(t))}${mark}${oneLine(t)}${mark}${s.slice(s.indexOf(t) + t.length)}`;
  }

  function absolute(url) {
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return '';
    }
  }

  function list(el, ctx) {
    const ordered = el.localName === 'ol';
    const start = Number(el.getAttribute('start')) || 1;
    const items = [...el.children].filter((c) => c.localName === 'li' && !skip(c));
    const lines = items.map((li, i) => {
      const marker = ordered ? `${start + i}.` : '-';
      const body = kids(li, { ...ctx, depth: ctx.depth + 1 }).trim().replace(/\n{2,}/g, '\n');
      return `${marker} ${body.replace(/\n/g, `\n${' '.repeat(marker.length + 1)}`)}`;
    });
    return lines.length ? `\n\n${lines.join('\n')}\n\n` : '';
  }

  function table(el, ctx) {
    const rows = [...el.querySelectorAll('tr')].filter((r) => r.closest('table') === el && !skip(r));
    const cells = rows
      .map((r) =>
        [...r.children]
          .filter((c) => /^(td|th)$/.test(c.localName) && !skip(c))
          .map((c) => oneLine(kids(c, ctx)).replace(/\|/g, '\\|')),
      )
      .filter((r) => r.length);
    if (!cells.length) return '';
    const cols = Math.max(...cells.map((r) => r.length));
    const row = (r) => `| ${Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ')} |`;
    const [head, ...body] = cells;
    return `\n\n${[row(head), row(Array(cols).fill('---')), ...body.map(row)].join('\n')}\n\n`;
  }

  function code(el) {
    const lang = (el.querySelector('code')?.className || el.className || '').match(/(?:language|lang)-([\w+#-]+)/)?.[1] || '';
    const text = el.textContent.replace(/\n$/, '');
    const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((m) => m.length + 1)));
    return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
  }

  function kids(el, ctx) {
    let out = '';
    for (const n of el.childNodes) out += render(n, ctx);
    return out;
  }

  function render(node, ctx) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
    if (node.nodeType !== 1 || skip(node)) return '';
    const el = node;
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) {
      const text = oneLine(kids(el, ctx));
      return text ? `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n` : '';
    }
    switch (tag) {
      case 'p':
        return `\n\n${kids(el, ctx).trim()}\n\n`;
      case 'br':
        return '  \n';
      case 'hr':
        return '\n\n---\n\n';
      case 'strong':
      case 'b':
        return wrap(kids(el, ctx), '**');
      case 'em':
      case 'i':
        return wrap(kids(el, ctx), '*');
      case 'del':
      case 's':
        return wrap(kids(el, ctx), '~~');
      case 'code': {
        const t = el.textContent;
        return t.trim() ? `\`${t.replace(/\s+/g, ' ')}\`` : '';
      }
      case 'pre':
        return code(el);
      case 'a': {
        const text = oneLine(kids(el, ctx));
        const href = el.getAttribute('href');
        if (!text || !href || href.startsWith('#') || /^javascript:/i.test(href)) return text;
        return `[${text}](${absolute(href)})`;
      }
      case 'img': {
        const src = el.currentSrc || el.src;
        // A data: URI would put the whole picture inside the Markdown text.
        if (!src || src.startsWith('data:')) return '';
        return `![${oneLine(el.alt || '').replace(/[[\]]/g, '')}](${absolute(src)})`;
      }
      case 'ul':
      case 'ol':
        return list(el, ctx);
      case 'blockquote': {
        const body = kids(el, ctx).trim().replace(/\n{3,}/g, '\n\n');
        return body ? `\n\n${body.replace(/^/gm, '> ')}\n\n` : '';
      }
      case 'table':
        return table(el, ctx);
      case 'figcaption': {
        const t = oneLine(kids(el, ctx));
        return t ? `\n\n*${t}*\n\n` : '';
      }
    }
    const display = getComputedStyle(el).display;
    const inline = display.startsWith('inline') || display === 'contents';
    return inline ? kids(el, ctx) : `\n\n${kids(el, ctx)}\n\n`;
  }

  function toMarkdown() {
    const text = kids(document.body, { depth: 0 })
      .replace(/^[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { markdown: text, images: (text.match(/!\[[^\]]*\]\(/g) || []).length };
  }

  Object.assign(globalThis.__p2p, { toMarkdown });
})();
