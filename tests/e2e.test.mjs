// End-to-end checks: load the unpacked extension in Chrome for Testing, save
// fixture pages through the service worker, and inspect the PDFs with poppler.
//   npm run test:e2e

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  EXT,
  activeTabId,
  launch,
  openPage,
  pdffonts,
  pdfimages,
  pdfinfo,
  pdftext,
  pdfwords,
  save,
  writeTemp,
} from './harness.mjs';
import { startServer } from './server.mjs';

const FIXTURES = path.join(EXT, 'tests', 'fixtures');
const MARKS = '[data-p2p-style],[data-p2p-attrs],[data-p2p-hide],[data-p2p-expanded],[data-p2p-reveal]';

let srv;
let origin;
let h;

before(async () => {
  ({ server: srv, origin } = await startServer());
  h = await launch();
});

after(async () => {
  await h?.close();
  srv?.close();
});

async function savePdf(fixture, overrides = {}) {
  const page = await openPage(h, `${origin}/${fixture}`);
  const { buf, res } = await save(h, overrides);
  const file = await writeTemp(buf, fixture.replace('.html', '.pdf'));
  return { page, buf, res, file, info: pdfinfo(file), text: pdftext(file) };
}

const word = (file, prefix) => pdfwords(file).find((w) => w.text.startsWith(prefix));
const sha = (b) => createHash('sha256').update(b).digest('hex');

describe('fidelity', () => {
  test('text stays text, links and bookmarks survive, JPEG is embedded unchanged', async () => {
    const { page, buf, file, info, text } = await savePdf('basic.html', { scrollToEnd: false });
    assert.equal(info.pages, 1);
    assert.equal(info.width, 960); // 1280 CSS px
    const fonts = pdffonts(file);
    assert.ok(fonts.length > 0, 'fonts embedded');
    assert.ok(fonts.every((f) => f.emb === 'yes'), 'all fonts embedded');
    assert.match(text, /MAINTOK This paragraph is real text/);
    assert.match(text, /ENDTOK/);
    const raw = buf.toString('latin1');
    assert.match(raw, /\/URI \(https:\/\/example\.com\/linked\)/, 'link annotation kept');
    assert.match(raw, /\/Outlines/, 'bookmarks from headings');
    assert.match(raw, /\/StructTreeRoot/, 'tagged PDF');

    const imgs = pdfimages(file);
    assert.equal(imgs.length, 1);
    assert.deepEqual([imgs[0].width, imgs[0].height, imgs[0].enc], [4000, 3000, 'jpeg']);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-img-'));
    execFileSync('pdfimages', ['-j', file, path.join(dir, 'img')]);
    const extracted = await fs.readFile(path.join(dir, 'img-000.jpg'));
    const original = await fs.readFile(path.join(FIXTURES, 'img/big.jpg'));
    assert.equal(sha(extracted), sha(original), 'JPEG bytes identical to the source file');
    await page.close();
  });

  test('every image is embedded at its largest available resolution', async () => {
    const { page, file, text } = await savePdf('images.html', { scrollToEnd: false });
    const dims = pdfimages(file)
      .filter((i) => i.type === 'image')
      .map((i) => `${i.width}x${i.height}`);
    const expected = {
      'image-set background (2x)': '2000x1000',
      'big JPEG': '4000x3000',
      'PNG with alpha': '1600x1200',
      'WebP': '2400x1600',
      'srcset largest w candidate': '3200x2133',
      'srcset 3x candidate': '600x600',
      'picture WebP source 2400w': '2400x1500',
      'lazy data-src': '2000x1500',
      'identity filter removed': '1600x1066',
    };
    for (const [what, d] of Object.entries(expected)) assert.ok(dims.includes(d), `${what} (${d}) in ${dims.join(', ')}`);
    assert.equal(dims.filter((d) => d === '2000x1500').length, 2, 'lazy and LQIP images both upgraded');
    assert.equal(dims.filter((d) => d === '2400x1600').length, 2, 'native lazy image loaded');
    assert.match(text, /IDFTEXT selectable text/);
    assert.match(text, /IMGEND/);
    await page.close();
  });
});

describe('layout', () => {
  test('viewport units keep their on-screen size in a continuous page', async () => {
    const { page, file, info, text, res } = await savePdf('vh.html', { scrollToEnd: false });
    assert.equal(info.pages, 1);
    assert.ok(!text.includes('TALLONLY'), 'height media query did not flip in print');
    assert.ok(res.report.vh[0].frozen >= 5);
    const innerH = await page.evaluate(() => innerHeight);
    const after = word(file, 'AFTERHERO');
    assert.ok(Math.abs(after.y0 - innerH * 0.75) < 6, `hero is ${innerH}px tall in print (AFTERHERO at ${after.y0}pt)`);
    await page.close();
  });

  test('docs layout: fixed top bar, fixed sidebar and sticky TOC removed, content reflowed', async () => {
    const { page, file, text, res } = await savePdf('layout-docs.html', { scrollToEnd: false });
    for (const t of ['NAVTOK', 'SIDETOK', 'TOCTOK']) assert.ok(!text.includes(t), `${t} removed`);
    for (const t of ['MAINTOK', 'MAINEND', 'FOOTTOK']) assert.ok(text.includes(t), `${t} kept`);
    assert.ok(word(file, 'MAINTOK').x0 < 40, 'body padding for the fixed sidebar cleared');
    assert.equal(res.report.hidden.length, 3);
    await page.close();
  });

  test('grid layout: sidebar column removed and the article spans the grid', async () => {
    const { page, file, text } = await savePdf('layout-grid.html', { scrollToEnd: false });
    assert.ok(!text.includes('SIDETOK'));
    assert.ok(!text.includes('NAVTOK'));
    assert.ok(word(file, 'MAINTOK').x0 < 60, 'article moved into the freed column');
    await page.close();
  });

  test('popups, cookie banner, chat widget and modal dialog removed; scroll lock undone', async () => {
    const { page, text, info } = await savePdf('overlays.html', { scrollToEnd: false });
    for (const t of ['COOKIETOK', 'MODALTOK', 'CHATTOK', 'DIALOGTOK']) assert.ok(!text.includes(t), `${t} removed`);
    assert.ok(text.includes('OVEREND'), 'content below the fold printed');
    assert.equal(info.pages, 1);
    await page.close();
  });

  test('everything kept when all removal options are off', async () => {
    const { page, text } = await savePdf('basic.html', {
      scrollToEnd: false,
      removeTopNav: false,
      removeSideNav: false,
      removeFooter: false,
      removePopups: false,
    });
    assert.ok(text.includes('NAVTOK'));
    assert.ok(text.includes('FOOTTOK'));
    await page.close();
  });

  test('footer removed when asked', async () => {
    const { page, text } = await savePdf('basic.html', { scrollToEnd: false, removeFooter: true });
    assert.ok(!text.includes('FOOTTOK'));
    assert.ok(text.includes('ENDTOK'));
    await page.close();
  });

  test('wide content does not shrink the page', async () => {
    const { page, file, info, res } = await savePdf('wide.html', { scrollToEnd: false });
    assert.equal(info.width, 960);
    assert.equal(res.report.overflow.fixed, true);
    const basic = word(file, 'MAINTOK');
    assert.ok(basic.y1 - basic.y0 > 25, 'text kept its size');
    await page.close();
  });

  test('desktop breakpoint kept at screen width', async () => {
    const { page, text, info } = await savePdf('breakpoint.html', { scrollToEnd: false });
    assert.ok(text.includes('WIDETOK'));
    assert.ok(!text.includes('NARROWTOK'));
    assert.equal(info.width, 960);
    await page.close();
  });

  test('strict CSP page: removals still apply and site @page margins are overridden', async () => {
    const { page, file, text } = await savePdf('csp.html', { scrollToEnd: false });
    assert.ok(!text.includes('NAVTOK'));
    // main is 800px wide centered in 1280px: content starts at 260px = 195pt, no extra 3cm.
    assert.ok(Math.abs(word(file, 'MAINTOK').x0 - 195) < 3);
    await page.close();
  });

  test('paged mode produces real paper sizes with the desktop layout scaled', async () => {
    const { page, info, text } = await savePdf('layout-docs.html', {
      scrollToEnd: false,
      layout: 'paged',
      paper: 'letter',
      margins: 'normal',
    });
    assert.equal(info.width, 612);
    assert.equal(info.height, 792);
    assert.ok(info.pages >= 1);
    assert.ok(text.includes('MAINEND'));
    await page.close();
  });

  test('long pages split evenly under 200 inches', async () => {
    const { page, info, text, res } = await savePdf('long.html', { scrollToEnd: false });
    const expected = Math.ceil(res.report.page.cssH / 19200);
    assert.equal(info.pages, expected);
    assert.ok(info.height <= 14400);
    assert.ok(text.includes('LONGTOK199') && text.includes('LONGEND'));
    await page.close();
  });
});

describe('embedded course player (LMS with cross-origin iframes)', () => {
  async function saveLms(query) {
    const page = await openPage(h, `${origin}/lms-course.html${query}`);
    await page.waitForTimeout(1500); // nested frames load after the page
    const { buf, res } = await save(h);
    const file = await writeTemp(buf, 'lms.pdf');
    return { page, res, file, info: pdfinfo(file), text: pdftext(file) };
  }

  test('course page: outline column removed, clipped content printed', async () => {
    const { page, text, res } = await saveLms('');
    assert.ok(!text.includes('SYLLABUSTOK'), 'Course Materials column removed');
    assert.ok(!text.includes('NAVTOK'), 'app header removed');
    for (const t of ['BEHINDTOK', 'REVIEWEDTOK', 'DETAILSTOK']) assert.ok(text.includes(t), `${t} printed`);
    assert.ok(res.report.hidden.some((x) => x.reason === 'side-nav'));
    assert.equal(res.filename, 'Data Analysis - Cleaning Data.pdf', 'no lesson frame, so the page title');
    await page.close();
  });

  test('open player: the whole lesson inside nested cross-origin frames prints', async () => {
    const { page, text, file, info, res } = await saveLms('?player=1');
    for (const t of ['RISETITLE', 'RISETOK', 'RISEBODY paragraph 20', 'RISEEND']) assert.ok(text.includes(t), `${t} printed`);
    assert.ok(!text.includes('RISESIDE'), "lesson's own sidebar removed");
    assert.ok(!text.includes('BEHINDTOK') && !text.includes('SYLLABUSTOK'), 'page behind the dialog left out');
    assert.equal(info.pages, 1);
    assert.equal(res.report.frames.length, 2);
    assert.ok(res.report.frameExpansion.some((e) => e.to > 6000), 'lesson frame grown to its content height');
    const lazy = pdfimages(file).filter((i) => i.width === 2000 && i.height === 1500);
    assert.equal(lazy.length, 5, 'lazy images inside the frame loaded at full size');
    assert.equal(res.filename, 'RISETITLE Finding Outliers.pdf', 'named after the lesson, not the module');
    await page.close();
  });
});

describe('page breaks inside an embedded lesson', () => {
  // A 150-block lesson with 30 slides, two cross-origin frames deep in a modal player.
  async function saveLong(overrides) {
    const page = await openPage(h, `${origin}/lms-course.html?player=1&long=1`);
    await page.waitForTimeout(2000);
    const { buf, res } = await save(h, overrides);
    const file = await writeTemp(buf, 'long.pdf');
    await page.close();
    const info = pdfinfo(file);
    const textPerPage = [];
    for (let p = 1; p <= info.pages; p++) {
      textPerPage.push(execFileSync('pdftotext', ['-f', String(p), '-l', String(p), file, '-'], { encoding: 'utf8' }).trim().length);
    }
    // A slide cut by a page break shows up on two pages.
    const pagesByImage = new Map();
    for (const img of pdfimages(file).filter((i) => i.type === 'image' && i.width === 2000)) {
      const id = img.raw.trim().split(/\s+/)[10];
      if (!pagesByImage.has(id)) pagesByImage.set(id, new Set());
      pagesByImage.get(id).add(img.page);
    }
    const split = [...pagesByImage.values()].filter((p) => p.size > 1).length;
    return { info, textPerPage, split, slides: pagesByImage.size, res };
  }

  for (const [name, overrides] of [
    ['Letter pages', { layout: 'paged', paper: 'letter', margins: 'small' }],
    ['A4 pages, normal margins', { layout: 'paged', paper: 'a4', margins: 'normal' }],
    ['one long page', { layout: 'continuous' }],
  ]) {
    test(`${name}: no blank first page, no slide cut in half, no empty last page`, async () => {
      const { info, textPerPage, split, slides } = await saveLong(overrides);
      assert.ok(info.pages > 1, 'spans several pages');
      assert.ok(textPerPage[0] > 1000, `page 1 starts with the lesson (${textPerPage[0]} chars)`);
      assert.ok(textPerPage.every((n) => n > 0), `no empty page: ${textPerPage}`);
      assert.equal(slides, 30, 'every slide printed');
      assert.equal(split, 0, 'no slide split across pages');
    });
  }
});

describe('scroll to end', () => {
  test('infinite feed loads every batch and reveal animations end visible', async () => {
    const { page, text, res } = await savePdf('infinite.html');
    for (const t of ['Initial item A', 'Batch 0 item 0', 'Batch 3 item 4', 'Batch 5 item 7', 'LASTTOK']) {
      assert.ok(text.includes(t), `${t} printed`);
    }
    assert.equal(res.report.scroll.reason, 'bottom');
    await page.close();
  });

  test('app shell: inner scroller is scrolled and expanded', async () => {
    const { page, text, res } = await savePdf('app-shell.html');
    assert.ok(text.includes('BOTTOMTOK'));
    assert.ok(!text.includes('RAILTOK'));
    assert.equal(res.report.scroll.innerScroller, true);
    await page.close();
  });

  test('endless feed stops at the time limit', async () => {
    const { page, res } = await savePdf('endless.html', { scrollMaxSeconds: 5 });
    assert.equal(res.report.scroll.reason, 'time limit');
    await page.close();
  });
});

describe('page state', () => {
  test('page is restored after saving', async () => {
    const page = await openPage(h, `${origin}/layout-docs.html`);
    await page.evaluate(() => window.scrollTo(0, 600));
    const before = await page.evaluate(() => document.body.outerHTML);
    await save(h, { scrollToEnd: false });
    const state = await page.evaluate((marks) => ({
      html: document.body.outerHTML,
      marks: document.querySelectorAll(marks).length,
      y: scrollY,
      sheets: document.adoptedStyleSheets.length,
    }), MARKS);
    assert.equal(state.marks, 0);
    assert.equal(state.html, before);
    assert.equal(state.y, 600);
    assert.equal(state.sheets, 0);
    await page.close();
  });

  test('restricted pages fail with a clear message', async () => {
    const page = await h.ctx.newPage();
    await page.goto('chrome://version');
    await page.bringToFront();
    await assert.rejects(save(h), /doesn't allow/);
    await page.close();
  });

  test('a tab showing a PDF is refused without logging an error', async () => {
    const page = await openPage(h, `${origin}/sample.pdf`);
    const tabId = await activeTabId(h);
    const { status, errors } = await h.sw.evaluate(async ({ tabId }) => {
      const errors = [];
      const orig = console.error;
      console.error = (...args) => errors.push(args.map(String).join(' '));
      try {
        await self.p2p.startJob(tabId);
      } finally {
        console.error = orig;
      }
      return { status: (await chrome.storage.session.get(`job:${tabId}`))[`job:${tabId}`], errors };
    }, { tabId });
    assert.equal(status.state, 'error');
    assert.equal(status.code, 'PDF_TAB');
    assert.deepEqual(errors, [], 'expected refusals stay out of chrome://extensions errors');
    await page.close();
  });

  test('popup reconnects after the service worker drops its port', async () => {
    const extId = new URL(h.sw.url()).host;
    const page = await h.ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const popupPorts = async () => {
      for (let i = 0; i < 30; i++) {
        const n = await h.sw.evaluate(() => self.p2p.popupPorts.size);
        if (n) return n;
        await new Promise((r) => setTimeout(r, 100));
      }
      return 0;
    };
    await page.goto(`chrome-extension://${extId}/popup.html`);
    assert.equal(await popupPorts(), 1, 'popup connected on open');
    // What happens when Chrome stops the idle worker.
    await h.sw.evaluate(() => {
      for (const p of self.p2p.popupPorts) p.disconnect();
      self.p2p.popupPorts.clear();
    });
    await page.evaluate(() => {
      const b = document.querySelector('#cancel');
      b.hidden = false;
      b.click();
    });
    assert.equal(await popupPorts(), 1, 'popup opened a new port');
    assert.deepEqual(pageErrors, []);
    await page.close();
  });

  test('real download path writes a valid PDF named after the page title', async () => {
    const page = await openPage(h, `${origin}/basic.html`);
    const tabId = await activeTabId(h);
    await h.sw.evaluate(async ({ tabId }) => {
      await self.p2p.saveSettings({ scrollToEnd: false });
      await self.p2p.startJob(tabId);
    }, { tabId });
    const status = await h.sw.evaluate(async ({ tabId }) => (await chrome.storage.session.get(`job:${tabId}`))[`job:${tabId}`], { tabId });
    assert.equal(status.state, 'done', status.message);
    assert.equal(status.filename, 'Basic Article Test Page.pdf');
    const details = await h.sw.evaluate(async ({ tabId }) => (await chrome.storage.session.get(`details:${tabId}`))[`details:${tabId}`], { tabId });
    assert.equal(details.ok, true, 'details saved for "Copy details"');
    assert.ok(details.report?.timings && details.settings?.layout);
    const item = await h.sw.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))[0]);
    assert.equal(item.state, 'complete');
    assert.ok(item.fileSize > 100_000);
    // A link download, so Chrome's save dialog starts in the last folder used.
    assert.equal(item.byExtensionId, undefined, 'saved through a link, not chrome.downloads');
    const file = item.filename;
    const head = (await fs.readFile(file)).subarray(0, 5).toString();
    assert.equal(head, '%PDF-');
    assert.equal(pdfinfo(file).pages, 1);

    // A second save right away isn't held back as a burst of automatic downloads.
    await h.sw.evaluate(({ tabId }) => self.p2p.startJob(tabId), { tabId });
    const [second, first] = await h.sw.evaluate(async () => chrome.downloads.search({ orderBy: ['-startTime'], limit: 2 }));
    assert.equal(first.id, item.id);
    assert.equal(second.state, 'complete');
    assert.equal(second.byExtensionId, undefined);
    await h.sw.evaluate(() => self.p2p.saveSettings({ scrollToEnd: true }));
    await page.close();
  });

  test('a downloads subfolder still saves through chrome.downloads', async () => {
    const page = await openPage(h, `${origin}/basic.html`);
    const tabId = await activeTabId(h);
    await h.sw.evaluate(async ({ tabId }) => {
      await self.p2p.saveSettings({ scrollToEnd: false, subfolder: 'PDFs' });
      await self.p2p.startJob(tabId);
    }, { tabId });
    const status = await h.sw.evaluate(async ({ tabId }) => (await chrome.storage.session.get(`job:${tabId}`))[`job:${tabId}`], { tabId });
    assert.equal(status.state, 'done', status.message);
    const item = await h.sw.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))[0]);
    assert.equal(item.state, 'complete');
    assert.equal(item.byExtensionId, new URL(h.sw.url()).host);
    await h.sw.evaluate(() => self.p2p.saveSettings({ scrollToEnd: true, subfolder: '' }));
    await page.close();
  });
});

describe('picker', () => {
  let ph;
  before(async () => {
    // The picker is injected with chrome.scripting, which needs activeTab in real
    // use. Automation can't grant activeTab, so test a copy with host access.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-ext-'));
    await fs.cp(EXT, dir, { recursive: true, filter: (src) => !/node_modules|[/\\]tests([/\\]|$)/.test(src) });
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['http://127.0.0.1/*'];
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    ph = await launch({ extPath: dir });
  });
  after(async () => ph?.close());

  test('a PDF tab is refused before the debugging bar appears', async () => {
    const page = await openPage(ph, `${origin}/sample.pdf`);
    const tabId = await activeTabId(ph);
    const r = await ph.sw.evaluate(async ({ tabId }) => {
      const orig = chrome.debugger.attach;
      let attaches = 0;
      chrome.debugger.attach = (...args) => (attaches++, orig.apply(chrome.debugger, args));
      try {
        await self.p2p.runJob(tabId, {}, { returnBytes: true });
        return { attaches };
      } catch (e) {
        return { attaches, code: e.code };
      } finally {
        chrome.debugger.attach = orig;
      }
    }, { tabId });
    assert.equal(r.code, 'PDF_TAB');
    assert.equal(r.attaches, 0);
    await page.close();
  });

  test('clicked elements are left out of the PDF', async () => {
    const page = await openPage(ph, `${origin}/basic.html`);
    const tabId = await activeTabId(ph);
    await ph.sw.evaluate(async ({ tabId }) => {
      await self.p2p.saveSettings({ scrollToEnd: false });
      await self.p2p.startPicker(tabId);
    }, { tabId });
    const box = await page.evaluate(() => {
      const r = document.querySelector('img').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: Math.min(r.top + 50, innerHeight - 100) };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.click(box.x, box.y);
    assert.equal(await page.evaluate(() => document.querySelector('img').hasAttribute('data-p2p-picked')), true);

    // Undo and redo with the keyboard.
    await page.keyboard.press('Backspace');
    assert.equal(await page.evaluate(() => document.querySelector('img').hasAttribute('data-p2p-picked')), false);
    await page.mouse.move(box.x, box.y + 1);
    await page.mouse.click(box.x, box.y + 1);

    await page.keyboard.press('Enter');
    let status;
    for (let i = 0; i < 60; i++) {
      status = await ph.sw.evaluate(async ({ tabId }) => (await chrome.storage.session.get(`job:${tabId}`))[`job:${tabId}`], { tabId });
      if (status && status.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(status.state, 'done', status?.message);
    const item = await ph.sw.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))[0]);
    assert.equal(pdfimages(item.filename).length, 0, 'picked image not in the PDF');
    assert.match(pdftext(item.filename), /MAINTOK/);
    // Picker hides stay until the user restores the page.
    assert.equal(await page.evaluate(() => document.querySelector('img').hasAttribute('data-p2p-picked')), true);
    await page.close();
  });
});
