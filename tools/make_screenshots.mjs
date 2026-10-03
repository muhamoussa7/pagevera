// Builds the README images from docs/demo/article.html: the page as Chrome shows
// it next to page 1 of the PDF the extension makes, and the popup.
// Usage: node tools/make_screenshots.mjs (needs poppler's pdftoppm)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeTabId, launch, openPage, save, writeTemp } from '../tests/harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/images');

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

// Captures the whole page at 2x by sizing the viewport to the content.
async function shoot(cdp, page, file, width) {
  const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().bottom));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(file, Buffer.from(data, 'base64'));
}

const h = await launch({ width: 1280, height: 820 });
let big = null;
try {
  await fs.mkdir(OUT, { recursive: true });

  const page = await openPage(h, url);
  const before = await page.screenshot();
  await activeTabId(h);
  const { buf } = await save(h, { layout: 'paged', scrollToEnd: false });
  const pdf = await writeTemp(buf, 'demo.pdf');
  const prefix = pdf.replace(/\.pdf$/, '');
  execFileSync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', '-singlefile', pdf, prefix]);
  const after = await fs.readFile(`${prefix}.png`);

  // A capture larger than the window comes out tiled, so lay the images out in a
  // window big enough for them.
  big = await launch({ width: 1600, height: 1400 });
  const composite = await big.ctx.newPage();
  const cdp = await composite.context().newCDPSession(composite);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 700, deviceScaleFactor: 2, mobile: false });
  await composite.setContent(`<!doctype html><html><body style="margin:0;background:#eef1f6;font:600 18px system-ui,sans-serif;color:#1d2433">
    <div style="display:flex;gap:48px;align-items:flex-start;justify-content:center;padding:36px 40px">
      <div style="width:860px">
        <div style="margin:0 0 12px 4px">The page in Chrome</div>
        <div style="border-radius:10px;overflow:hidden;box-shadow:0 8px 28px rgba(29,36,51,.18);background:#fff">
          <div style="height:30px;background:#dfe3ea;display:flex;align-items:center;gap:7px;padding:0 12px">
            <i style="width:11px;height:11px;border-radius:50%;background:#ff5f57"></i><i style="width:11px;height:11px;border-radius:50%;background:#febc2e"></i><i style="width:11px;height:11px;border-radius:50%;background:#28c840"></i>
          </div>
          <img src="data:image/png;base64,${before.toString('base64')}" style="display:block;width:100%">
        </div>
      </div>
      <div style="width:440px">
        <div style="margin:0 0 12px 4px">Page 1 of the saved PDF</div>
        <img src="data:image/png;base64,${after.toString('base64')}" style="display:block;width:100%;box-shadow:0 8px 28px rgba(29,36,51,.18);background:#fff">
      </div>
    </div></body></html>`);
  await shoot(cdp, composite, path.join(OUT, 'before-after.png'), 1440);

  const extId = new URL(h.sw.url()).host;
  const popup = await h.ctx.newPage();
  const pcdp = await popup.context().newCDPSession(popup);
  await pcdp.send('Emulation.setDeviceMetricsOverride', { width: 340, height: 600, deviceScaleFactor: 2, mobile: false });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForTimeout(500);
  await shoot(pcdp, popup, path.join(OUT, 'popup.png'), 340);
  console.log('Wrote docs/images/before-after.png and docs/images/popup.png');
} finally {
  await h.close();
  await big?.close();
  server.close();
}
