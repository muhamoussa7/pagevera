import assert from 'node:assert/strict';
import test from 'node:test';
import { computePrintParams } from '../../lib/paper.js';

test('continuous width rounds up to whole points', () => {
  const { params } = computePrintParams({ cssW: 1366, cssH: 1000 });
  // 1366 px = 1024.5 pt, rounded up to 1025 pt so the layout can't get narrower.
  assert.equal(params.paperWidth * 72, 1025);
  assert.ok(params.paperWidth * 96 >= 1366);
  assert.equal(params.scale, 1);
  assert.equal(params.marginTop, 0);
});

test('continuous height fits the content on one page', () => {
  const r = computePrintParams({ cssW: 1280, cssH: 5000 });
  assert.equal(r.expectedPages, 1);
  assert.ok(r.params.paperHeight * 96 >= 5000);
  assert.ok(r.params.paperHeight * 96 < 5010);
});

test('continuous pages split evenly under the 200 inch limit', () => {
  const r = computePrintParams({ cssW: 1280, cssH: 40_000 });
  assert.equal(r.expectedPages, 3);
  assert.ok(r.params.paperHeight <= 200);
  assert.ok(r.params.paperHeight * 96 * 3 >= 40_000);
});

test('extra height is added for the retry', () => {
  const a = computePrintParams({ cssW: 1280, cssH: 3000 });
  const b = computePrintParams({ cssW: 1280, cssH: 3000, extraPx: 60 });
  assert.ok(b.params.paperHeight > a.params.paperHeight);
});

test('paged mode scales the desktop width to the printable width', () => {
  const r = computePrintParams({ cssW: 1280, cssH: 3000, layout: 'paged', paper: 'a4', margins: 'small' });
  assert.ok(Math.abs(r.params.paperWidth - 8.2667) < 0.001);
  assert.equal(r.params.marginLeft, 0.25);
  const layoutW = ((2480 / 300 - 0.5) * 96) / r.params.scale;
  assert.ok(layoutW >= 1280 && layoutW < 1282, `layout width ${layoutW}`);
  // Chrome rounds the page height up to whole CSS px; we aim just below a whole number.
  const chromePage = Math.ceil(((3508 / 300 - 0.5) * 96) / r.params.scale);
  assert.equal(chromePage, r.pageCssH);
});

test('continuous page heights are multiples of 8px (exact in Chrome paper units)', () => {
  const r = computePrintParams({ cssW: 1425, cssH: 48_123 });
  assert.equal(r.pageCssH % 8, 0);
  assert.equal(r.params.paperHeight * 72, r.pageCssH * 0.75);
  const fixed = computePrintParams({ cssW: 1425, cssH: 50_000, pageHeightPx: 16_801 });
  assert.equal(fixed.pageCssH, 16_808);
  assert.equal(fixed.expectedPages, 3);
});

test('landscape swaps paper sides and scale is clamped', () => {
  const r = computePrintParams({ cssW: 200, cssH: 500, layout: 'paged', paper: 'letter', orientation: 'landscape' });
  assert.equal(r.params.paperWidth, 11);
  assert.equal(r.params.paperHeight, 8.5);
  assert.ok(r.params.scale <= 2 && r.params.scale > 1.99);
});
