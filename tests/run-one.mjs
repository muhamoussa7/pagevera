// Dev helper: save one fixture (or any URL) and print what came out.
//   node tests/run-one.mjs basic.html '{"layout":"paged"}' [--headed] [--out file.pdf]

import { copyFile } from 'node:fs/promises';
import { launch, openPage, pdffonts, pdfimages, pdfinfo, save, writeTemp } from './harness.mjs';
import { startServer } from './server.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const positional = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const target = positional[0] || 'basic.html';
const overrides = positional[1] ? JSON.parse(positional[1]) : {};

const { server, origin } = await startServer();
const h = await launch({ headless: !headed });
try {
  const url = /^https?:/.test(target) ? target : `${origin}/${target}`;
  await openPage(h, url);
  const t = Date.now();
  const { buf, res } = await save(h, overrides);
  const file = await writeTemp(buf);
  if (outFile) await copyFile(file, outFile);
  const info = pdfinfo(file);
  console.log(JSON.stringify({ file: outFile || file, ms: Date.now() - t, pages: res.pages, bytes: res.bytes, tagged: res.tagged, params: res.params, info: { pages: info.pages, width: info.width, height: info.height } }, null, 2));
  console.log('report', JSON.stringify(res.report, null, 2));
  console.log('fonts', pdffonts(file).map((f) => `${f.name} emb=${f.emb}`).join('\n      '));
  console.log('images', pdfimages(file).map((i) => `${i.width}x${i.height} ${i.enc} ${i.color}`).join('\n       '));
} finally {
  await h.close();
  server.close();
}
