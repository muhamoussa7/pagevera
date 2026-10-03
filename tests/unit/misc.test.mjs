import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeFilename } from '../../lib/download.js';
import { createPageCounter } from '../../lib/pdf-stream.js';
import { classifyUrl } from '../../lib/restricted.js';
import { normalize, migrate, DEFAULTS } from '../../lib/settings.js';
import { resolvePaper } from '../../lib/paper-locale.js';

test('sanitizeFilename removes illegal characters and caps length', () => {
  assert.equal(sanitizeFilename('Basic Article: Test Page'), 'Basic Article Test Page.pdf');
  assert.equal(sanitizeFilename('a/b\\c*d?e"f<g>h|i'), 'a b c d e f g h i.pdf');
  assert.equal(sanitizeFilename('  ...hidden.  '), 'hidden.pdf');
  assert.equal(sanitizeFilename('CON'), '_CON.pdf');
  const long = sanitizeFilename('x'.repeat(400));
  assert.equal(long, `${'x'.repeat(150)}.pdf`);
  assert.equal(sanitizeFilename('日本語のタイトル 🎉'), '日本語のタイトル 🎉.pdf');
});

test('sanitizeFilename falls back to host and date', () => {
  const d = new Date('2026-10-02T12:00:00Z');
  assert.equal(sanitizeFilename('', 'https://www.example.com/a', d), 'example.com 2026-10-02.pdf');
  assert.equal(sanitizeFilename('   ', 'not a url', d), 'page 2026-10-02.pdf');
});

test('page counter reads the page tree root and ignores outline counts', () => {
  const c = createPageCounter();
  c.feed('%PDF-1.4\n1 0 obj\n<</Type /Outlines /Count 9>>\nendobj\n2 0 obj\n<</Type /Pa');
  c.feed('ges /Kids [3 0 R 4 0 R] /Count 2>>\nendobj\n5 0 obj\n<</Type /Pages /Count 1 /Parent 2 0 R>>');
  assert.equal(c.count(), 2);
});

test('page counter returns 0 when no page tree is found', () => {
  const c = createPageCounter();
  c.feed('<</Type /Page /Parent 2 0 R>>');
  assert.equal(c.count(), 0);
});

test('classifyUrl blocks restricted pages', () => {
  for (const url of ['chrome://settings', 'chrome-extension://abc/page.html', 'view-source:https://a.com', 'about:blank', 'devtools://devtools/x']) {
    assert.equal(classifyUrl(url).ok, false, url);
  }
  assert.equal(classifyUrl('https://chromewebstore.google.com/detail/x').ok, false);
  assert.equal(classifyUrl('https://chrome.google.com/webstore/detail/x').ok, false);
  assert.deepEqual(classifyUrl('https://example.com/doc.pdf'), { ok: true, isFile: false, looksLikePdf: true });
  assert.equal(classifyUrl('file:///Users/me/a.html').isFile, true);
  assert.equal(classifyUrl(undefined).ok, true);
});

test('settings normalize bad values back to defaults', () => {
  const s = normalize({ ...DEFAULTS, layout: 'weird', dpr: '3', scrollMaxSeconds: 9999, subfolder: '../PDFs//2026:/' });
  assert.equal(s.layout, 'paged');
  assert.equal(s.dpr, 3);
  assert.equal(s.scrollMaxSeconds, 600);
  assert.equal(s.subfolder, 'PDFs/2026');
});

test('settings saved by version 1 move to normal pages', () => {
  const old = migrate({ ...DEFAULTS, version: 1, layout: 'continuous', margins: 'none', paper: 'a4' });
  assert.deepEqual([old.layout, old.margins, old.paper, old.version], ['paged', 'small', 'auto', 2]);
  const chosen = migrate({ ...DEFAULTS, version: 2, layout: 'continuous' });
  assert.equal(chosen.layout, 'continuous', 'a choice made after the change is kept');
});

test('auto paper is Letter in US-style regions and A4 elsewhere', () => {
  assert.equal(resolvePaper('auto', 'en-US'), 'letter');
  assert.equal(resolvePaper('auto', 'en-CA'), 'letter');
  assert.equal(resolvePaper('auto', 'en-GB'), 'a4');
  assert.equal(resolvePaper('auto', 'ar-SA'), 'a4');
  assert.equal(resolvePaper('auto', 'en'), 'letter');
  assert.equal(resolvePaper('a4', 'en-US'), 'a4');
});
