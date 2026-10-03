// Pure helpers from content/agent.js (it only touches the DOM inside functions).
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.__p2pSelectors = {};
await import('../../content/agent.js');
const { parseSrcset, isIdentityFilter } = globalThis.__p2p;

test('parseSrcset reads w and x descriptors', () => {
  assert.deepEqual(parseSrcset('a.jpg 400w, b.jpg 800w'), [
    { url: 'a.jpg', w: 400, x: null },
    { url: 'b.jpg', w: 800, x: null },
  ]);
  assert.deepEqual(parseSrcset('a.png, b.png 2x,c.png 3x'), [
    { url: 'a.png', w: null, x: null },
    { url: 'b.png', w: null, x: 2 },
    { url: 'c.png', w: null, x: 3 },
  ]);
});

test('parseSrcset keeps commas inside URLs', () => {
  const r = parseSrcset(
    'https://res.cloudinary.com/x/image/upload/w_400,h_300,c_fill/p.jpg 400w, https://res.cloudinary.com/x/image/upload/w_1600,h_1200,c_fill/p.jpg 1600w',
  );
  assert.equal(r.length, 2);
  assert.equal(r[1].url, 'https://res.cloudinary.com/x/image/upload/w_1600,h_1200,c_fill/p.jpg');
  assert.equal(r[1].w, 1600);
});

test('parseSrcset handles data URLs and odd spacing', () => {
  const r = parseSrcset('  data:image/gif;base64,R0lGOD 1x ,  big.jpg   2x  ');
  assert.equal(r.length, 2);
  assert.equal(r[0].url, 'data:image/gif;base64,R0lGOD');
  assert.equal(r[1].x, 2);
});

test('isIdentityFilter only matches filters that change nothing', () => {
  assert.equal(isIdentityFilter('brightness(1)'), true);
  assert.equal(isIdentityFilter('brightness(1) contrast(100%) blur(0px)'), true);
  assert.equal(isIdentityFilter('hue-rotate(0deg) saturate(1)'), true);
  assert.equal(isIdentityFilter('blur(2px)'), false);
  assert.equal(isIdentityFilter('drop-shadow(0 0 2px black)'), false);
  assert.equal(isIdentityFilter('none'), false);
  assert.equal(isIdentityFilter('url(#f)'), false);
});
