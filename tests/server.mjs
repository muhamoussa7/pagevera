// Static fixture server. Extras:
//   ?delay=ms        delays any response
//   csp.html         served with a strict Content-Security-Policy
//   /api/batch?n=N   returns batch N of the infinite-scroll fixture after 300 ms

import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};

export function startServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const delay = Number(url.searchParams.get('delay') || 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));

    if (url.pathname === '/api/batch') {
      const n = Number(url.searchParams.get('n') || 0);
      await new Promise((r) => setTimeout(r, 300));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ n, items: Array.from({ length: 8 }, (_, i) => `Batch ${n} item ${i}`) }));
      return;
    }

    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size };
    if (path.basename(file) === 'csp.html') {
      headers['content-security-policy'] = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'";
    }
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '::', () => {
      const p = server.address().port;
      resolve({ server, origin: `http://127.0.0.1:${p}`, alt: `http://localhost:${p}`, alt2: `http://[::1]:${p}` });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startServer(Number(process.env.PORT || 8765));
  console.log(`Serving fixtures at ${origin}`);
}
