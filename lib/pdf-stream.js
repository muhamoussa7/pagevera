// Reads the printToPDF stream in chunks and counts pages on the way through.

import { STREAM_CHUNK_BYTES } from './constants.js';

export async function readPdfStream(session, handle, onChunk, { chunkSize = STREAM_CHUNK_BYTES } = {}) {
  const counter = createPageCounter();
  let bytes = 0;
  try {
    for (;;) {
      const r = await session.send('IO.read', { handle, size: chunkSize }, { timeoutMs: 60_000 });
      if (r.data) {
        const b64 = r.base64Encoded ? r.data : latin1ToBase64(r.data);
        const bin = atob(b64);
        counter.feed(bin);
        bytes += bin.length;
        await onChunk(b64);
      }
      if (r.eof) break;
    }
  } finally {
    session.send('IO.close', { handle }).catch(() => {});
  }
  return { pages: counter.count(), bytes };
}

function latin1ToBase64(s) {
  try {
    return btoa(s);
  } catch {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
}

// Finds the page tree root's /Count. Only dictionaries with /Type /Pages count;
// outline dictionaries also carry /Count. Takes the max because nested page tree
// nodes hold partial counts. Safe across chunk boundaries via a carried tail.
export function createPageCounter() {
  let tail = '';
  let max = 0;
  return {
    feed(bin) {
      const s = tail + bin;
      const re = /\/Type\s*\/Pages(?![A-Za-z0-9])/g;
      let m;
      while ((m = re.exec(s))) {
        const start = s.lastIndexOf('<<', m.index);
        const end = s.indexOf('>>', m.index);
        if (start < 0 || end < 0) continue;
        const c = /\/Count\s+(\d+)/.exec(s.slice(start, end));
        if (c) max = Math.max(max, Number(c[1]));
      }
      tail = s.slice(-4096);
    },
    count() {
      return max;
    },
  };
}
