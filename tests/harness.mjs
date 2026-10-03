// Launches Chrome for Testing with the unpacked extension and runs saves through
// the service worker's test hook. Shared by e2e tests and tests/run-one.mjs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHROME =
  process.env.CHROME_PATH ||
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );

export async function launch({ headless = true, extPath = EXT, width = 1280, height = 900 } = {}) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-profile-'));
  // viewport: null so Playwright doesn't add its own device-metrics emulation.
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless,
    viewport: null,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  return {
    ctx,
    sw,
    async close() {
      await ctx.close();
      await fs.rm(userDataDir, { recursive: true, force: true });
    },
  };
}

export async function openPage(h, url) {
  const page = await h.ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.bringToFront();
  return page;
}

export async function activeTabId(h) {
  return h.sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab.id;
  });
}

// Runs a save on the active tab and returns the PDF bytes plus the job report.
// Tests were written against one long page; ask for it unless a test says otherwise.
export async function save(h, overrides = {}) {
  overrides = { layout: 'continuous', ...overrides };
  const tabId = await activeTabId(h);
  const res = await h.sw.evaluate(
    async ({ tabId, overrides }) => {
      try {
        return await self.p2p.runJob(tabId, overrides, { returnBytes: true });
      } catch (e) {
        return { error: e.message, code: e.code, stack: e.stack };
      }
    },
    { tabId, overrides },
  );
  if (res.error) throw new Error(`Save failed: ${res.error} (${res.code})\n${res.stack}`);
  const buf = Buffer.concat(res.chunks.map((c) => Buffer.from(c, 'base64')));
  delete res.chunks;
  return { buf, res };
}

export async function writeTemp(buf, name = 'out.pdf') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-pdf-'));
  const file = path.join(dir, name);
  await fs.writeFile(file, buf);
  return file;
}

export function pdfinfo(file) {
  const out = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  const pages = Number(/Pages:\s+(\d+)/.exec(out)?.[1]);
  const m = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(out);
  return { pages, width: m ? Number(m[1]) : null, height: m ? Number(m[2]) : null, raw: out };
}

export function pdftext(file) {
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function pdffonts(file) {
  const out = execFileSync('pdffonts', [file], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(2)
    .filter(Boolean)
    .map((line) => {
      const cols = line.trim().split(/\s+/);
      // name type... emb sub uni object ID
      return { name: cols[0], emb: cols.at(-5), sub: cols.at(-4), raw: line };
    });
}

export function pdfimages(file) {
  const out = execFileSync('pdfimages', ['-list', file], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(2)
    .filter(Boolean)
    .map((line) => {
      const c = line.trim().split(/\s+/);
      return { page: +c[0], num: +c[1], type: c[2], width: +c[3], height: +c[4], color: c[5], enc: c[8], raw: line };
    });
}

// Words with their positions, from pdftotext -bbox.
export function pdfwords(file) {
  const html = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const words = [];
  let page = 0;
  for (const line of html.split('\n')) {
    if (line.includes('<page ')) page++;
    const m = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/.exec(line);
    if (m) words.push({ page, x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: m[5] });
  }
  return words;
}
