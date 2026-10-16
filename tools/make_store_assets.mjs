// Builds the Chrome Web Store images in store/: three 1280x800 screenshots and
// a 440x280 promo tile. Reuses docs/images and a real Markdown save of docs/demo/article.html.
// Usage: node tools/make_store_assets.mjs (needs Python 3 with Pillow, to drop the alpha channel)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, save } from '../tests/harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store');
const b64 = async (f) => (await fs.readFile(path.join(ROOT, f))).toString('base64');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const server = http.createServer(async (req, res) => {
  try {
    const body = await fs.readFile(path.join(ROOT, 'docs/demo', path.basename(new URL(req.url, 'http://x').pathname)));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/article.html`;

const h = await launch({ width: 1280, height: 820 });
let big = null;
try {
  await fs.mkdir(OUT, { recursive: true });
  const page = await openPage(h, url);
  const pagePng = (await page.screenshot()).toString('base64');
  const { buf } = await save(h, { format: 'md', scrollToEnd: false });
  const md = buf
    .toString('utf8')
    .replace(/http:\/\/127\.0\.0\.1:\d+\/article\.html/, 'https://example.com/product-brief')
    .split('\n')
    .slice(0, 15)
    .join('\n');

  const css = `*{box-sizing:border-box}html{min-height:100%;background:linear-gradient(135deg,#eaf0ff,#f6f8fc) fixed}body{margin:0;min-height:100vh;font-family:system-ui,-apple-system,sans-serif;color:#1d2433;overflow:hidden}
    h1{font-size:40px;line-height:1.15;margin:0 0 14px;font-weight:700}p.sub{font-size:21px;line-height:1.4;margin:0;color:#4a5568}
    .card{border-radius:12px;overflow:hidden;box-shadow:0 12px 34px rgba(29,36,51,.2);background:#fff}`;
  const shots = {
    'screenshot-1.png': { w: 1280, h: 800, html: `<div style="padding:44px 40px;text-align:center"><h1>Save a page without the clutter</h1>
      <p class="sub">Menus, sidebars, cookie banners and chat bubbles stay out. The text stays real text.</p></div>
      <div class="card" style="width:1200px;margin:6px auto 0"><img src="data:image/png;base64,${await b64('docs/images/before-after.png')}" style="display:block;width:100%"></div>` },
    'screenshot-2.png': { w: 1280, h: 800, html: `<div style="display:flex;align-items:center;gap:70px;padding:50px 90px;height:800px">
      <div style="flex:1"><h1>One click, three formats</h1><p class="sub">Pick PDF, PNG or Markdown. Choose what to leave out, scroll to the end first, and save with no print dialog.</p></div>
      <div class="card" style="width:352px;height:700px"><img src="data:image/png;base64,${await b64('docs/images/popup.png')}" style="display:block;width:100%"></div></div>` },
    'screenshot-3.png': { w: 1280, h: 800, html: `<div style="padding:40px 40px 22px;text-align:center"><h1>Or keep just the text as Markdown</h1>
      <p class="sub">Headings, lists, tables, code and links come through. Images become links.</p></div>
      <div style="display:flex;gap:28px;padding:50px 40px 0;align-items:flex-start">
        <div class="card" style="flex:1.25"><img src="data:image/png;base64,${pagePng}" style="display:block;width:100%"></div>
        <pre class="card" style="flex:1;height:452px;margin:0;padding:22px;font:16px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;overflow:hidden">${esc(md)}</pre></div>` },
    'promo-small.png': { w: 440, h: 280, html: `<div style="height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 24px">
      <img src="data:image/png;base64,${await b64('icons/icon128.png')}" width="84" height="84">
      <div style="font-size:38px;font-weight:700;margin-top:10px">PageVera</div>
      <div style="font-size:19px;color:#4a5568;margin-top:6px">Save any page as a clean PDF, PNG or Markdown file</div></div>` },
  };

  big = await launch({ width: 1400, height: 1000 });
  const p = await big.ctx.newPage();
  const cdp = await p.context().newCDPSession(p);
  for (const [name, s] of Object.entries(shots)) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
    await p.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${s.html}</body></html>`);
    await p.waitForTimeout(300);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(OUT, name), Buffer.from(data, 'base64'));
  }
  execFileSync('python3', ['-I', '-c', `import glob
from PIL import Image
for f in glob.glob(${JSON.stringify(OUT)} + '/*.png'):
    Image.open(f).convert('RGB').save(f)`]);
  console.log('Wrote', Object.keys(shots).join(', '), 'to store/');
} finally {
  await h.close();
  await big?.close();
  server.close();
}
