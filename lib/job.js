// One save, start to finish: attach, prepare the page, print, undo, download.

import { createAgent } from './agent-host.js';
import { CdpSession } from './cdp.js';
import * as C from './constants.js';
import { sanitizeFilename, startDownload, waitForDownload } from './download.js';
import { createFrameAgents, discoverFrames, expandFrame, paginateFrames } from './frames.js';
import { createNetIdle, sleep } from './net-idle.js';
import { createBlobSink, revokeBlob } from './offscreen-client.js';
import { computePrintParams } from './paper.js';
import { resolvePaper } from './paper-locale.js';
import { readPdfStream } from './pdf-stream.js';
import { checkTab } from './restricted.js';
import { getSettings, normalize } from './settings.js';

const running = new Map(); // tabId -> AbortController
const SCROLL_VIEWPORT_FACTOR = 2;
const PDF_TYPE = 'application/pdf';
const LESSON_FRAME_SHARE = 0.5;

// Refusals the popup and badge already explain. They aren't bugs, so they
// shouldn't land in the extension's error list.
export const EXPECTED_CODES = new Set(['CANCELLED', 'BUSY', 'RESTRICTED', 'FILE_ACCESS', 'PDF_TAB', 'DETACHED']);

export class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isRunning(tabId) {
  return running.has(tabId);
}

export function cancelJob(tabId) {
  running.get(tabId)?.abort(new JobError('CANCELLED', 'Cancelled'));
}

/**
 * @param {number} tabId
 * @param {object} overrides  settings to override for this run only
 * @param {{onProgress?: Function, returnBytes?: boolean}} hooks
 *   returnBytes skips the download and returns the base64 chunks (used by tests)
 */
export async function runJob(tabId, overrides = {}, { onProgress = () => {}, returnBytes = false } = {}) {
  if (running.has(tabId)) throw new JobError('BUSY', 'A save is already running in this tab.');
  const ac = new AbortController();
  running.set(tabId, ac);
  try {
    return await run(tabId, overrides, onProgress, returnBytes, ac);
  } finally {
    running.delete(tabId);
  }
}

async function run(tabId, overrides, onProgress, returnBytes, ac) {
  const signal = ac.signal;
  const settings = normalize({ ...(await getSettings()), ...overrides });
  const report = { timings: {}, warnings: [] };
  const started = Date.now();

  const progress = (phase, pct, message) => onProgress({ phase, pct: Math.round(pct), message });
  const check = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new JobError('CANCELLED', 'Cancelled');
  };
  const abortable = (promise) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  const timed = async (name, fn) => {
    const t = Date.now();
    try {
      return await abortable(fn());
    } finally {
      report.timings[name] = Date.now() - t;
    }
  };

  progress('preflight', 1, 'Checking the page');
  const tab = await chrome.tabs.get(tabId);
  const verdict = await checkTab(tab);
  if (!verdict.ok) throw new JobError(verdict.code, verdict.reason);
  // Background tabs stop rendering, which stalls lazy loaders and animation frames.
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });

  const session = new CdpSession(tabId);
  session.onDetach = (reason) =>
    ac.abort(
      new JobError(
        'DETACHED',
        reason === 'canceled_by_user'
          ? 'Saving stopped because the debugging bar was cancelled.'
          : 'The tab was closed or reloaded during the save.',
      ),
    );

  let agent = null;
  let net = null;
  let info = null;
  let printed = null;
  let frameAgents = [];
  let childSessions = [];
  // The debugging bar shrinks the viewport. Remember the height the user saw so
  // the page can be laid out at that height while the bar is showing.
  const probe = await probeBeforeAttach(tabId);
  const view = { height: probe.height };
  // Refuse a PDF tab before the debugging bar appears. The check after attaching
  // covers tabs this probe can't reach.
  if (probe.contentType === PDF_TYPE) throw pdfTabError();

  try {
    progress('attach', 3, 'Connecting to the page');
    await timed('attach', async () => {
      await session.attach();
      await waitViewportStable(session);
      agent = await createAgent(session);
      info = await agent.call('init');
      ({ frameAgents, childSessions } = await createFrameAgents(session, await discoverFrames(session)));
    });
    report.frames = frameAgents.map((f) => ({
      url: f.frame.url.slice(0, 120),
      depth: f.frame.depth,
      viewport: `${f.m.innerW}x${f.m.innerH}`,
      contentH: f.m.scrollH,
    }));
    // Run a step in every content frame; one broken frame shouldn't fail the save.
    const inFrames = async (fn, { deepestFirst = false } = {}) => {
      const list = deepestFirst ? [...frameAgents].sort((a, b) => b.frame.depth - a.frame.depth) : frameAgents;
      for (const f of list) {
        check();
        try {
          await fn(f);
        } catch (e) {
          report.warnings.push(`Frame ${f.frame.url.slice(0, 60)}: ${e.message}`);
        }
      }
    };
    if (info.contentType === PDF_TYPE) throw pdfTabError();
    if (info.visibility !== 'visible') report.warnings.push('The tab was not visible, so some lazy content may be missing.');
    check();

    await timed('emulate', async () => {
      const features = settings.reducedMotion ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [];
      const media = { media: settings.screenStyles ? 'screen' : '', features };
      await session.send('Emulation.setEmulatedMedia', media);
      for (const sessionId of childSessions) await session.send('Emulation.setEmulatedMedia', media, { sessionId }).catch(() => {});
      await applyViewport(session, settings, view.height);
      net = createNetIdle(session);
      await net.start(childSessions);
    });

    progress('unblock', 7, 'Removing popups and loading lazy content');
    report.unblock = await timed('unblock', () => agent.call('unblock', [{ removePopups: settings.removePopups }]));
    report.lazy = await timed('lazy', () => agent.call('prepassLazy'));
    await inFrames(async (f) => {
      await f.agent.call('unblock', [{ removePopups: settings.removePopups }]);
      await f.agent.call('prepassLazy');
    });
    check();

    if (settings.scrollToEnd) {
      const deadline = Date.now() + settings.scrollMaxSeconds * 1000;
      // Frames scroll inside their own window first; their lazy content loads as it would for a reader.
      report.frameScroll = [];
      await inFrames(
        async (f) => {
          const m = await f.agent.call('measure');
          if (m.scrollH <= m.innerH + 20 && !(await f.agent.call('scrollInit')).inner) return;
          const r = await scrollToEnd(session, f.agent, net, settings, view, check, (frac) => progress('scroll', 10 + frac * 20, 'Scrolling inside the embedded page'), {
            emulate: false,
            deadline,
          });
          report.frameScroll.push({ url: f.frame.url.slice(0, 80), ...r });
        },
        { deepestFirst: true },
      );
      report.scroll = await timed('scroll', () =>
        scrollToEnd(session, agent, net, settings, view, check, (frac, msg) => progress('scroll', 30 + frac * 20, msg), {
          deadline: Math.max(deadline, Date.now() + 5000),
        }),
      );
      // Scrolling often triggers newsletter modals and "back to top" widgets.
      report.unblockAfterScroll = await agent.call('unblock', [{ removePopups: settings.removePopups }]);
      await agent.call('prepassLazy');
    }
    check();

    progress('layout', 52, 'Cleaning up the layout');
    const layoutOpts = {
      removeTopNav: settings.removeTopNav,
      removeSideNav: settings.removeSideNav,
      removeFooter: settings.removeFooter,
      removePopups: settings.removePopups,
      continuous: settings.layout === 'continuous',
    };
    // Innermost frames first: each frame is cleaned up, its images loaded, and
    // then its <iframe> grown to the full content height before its parent's turn.
    report.frameLayout = [];
    report.frameExpansion = [];
    await inFrames(
      async (f) => {
        const lay = await f.agent.call('layout', [layoutOpts]);
        if (settings.highResImages) await f.agent.call('upgradeImages');
        await f.agent.call('waitImages', [{ perImageMs: 10_000, totalMs: 15_000 }], { timeoutMs: 20_000 });
        report.frameLayout.push({ url: f.frame.url.slice(0, 80), ...lay });
        const parent =
          f.frame.parentFrameId === agent.frameId ? agent : frameAgents.find((x) => x.frame.frameId === f.frame.parentFrameId)?.agent;
        if (parent) await expandFrame(session, f, parent, report.frameExpansion);
      },
      { deepestFirst: true },
    );
    report.layout = await timed('layout', () => agent.call('layout', [layoutOpts]));
    // The top-level layout can change a frame's width (a full-window player is
    // laid out at the page width). Measure the frames again so none is cut short.
    await inFrames(
      async (f) => {
        const parent =
          f.frame.parentFrameId === agent.frameId ? agent : frameAgents.find((x) => x.frame.frameId === f.frame.parentFrameId)?.agent;
        if (parent) await expandFrame(session, f, parent, report.frameExpansion);
      },
      { deepestFirst: true },
    );
    check();

    progress('images', 58, 'Loading full-resolution images');
    report.images = await timed('images', async () => {
      const up = settings.highResImages ? await agent.call('upgradeImages') : { upgraded: 0 };
      const wait = [{ perImageMs: C.IMAGE_WAIT_PER_IMAGE_MS, totalMs: C.IMAGE_WAIT_TOTAL_MS }];
      const timeoutMs = C.IMAGE_WAIT_TOTAL_MS + 5000;
      const first = await agent.call('waitImages', wait, { timeoutMs });
      await net.waitQuiet({ quietMs: 500, maxMs: 5000 });
      const fonts = await agent.call('fontsReady', [C.FONT_WAIT_MS]);
      // Layout changes can reveal images that weren't rendered before.
      const lazy = await agent.call('prepassLazy');
      const second = lazy.changed ? await agent.call('waitImages', wait, { timeoutMs }) : null;
      return { ...up, first, second, fonts };
    });
    check();

    progress('measure', 70, 'Measuring the page');
    view.frameAgents = frameAgents;
    const plan = await timed('measure', () => planPrint(session, agent, settings, report, view));
    check();

    progress('print', 78, 'Generating the PDF');
    printed = await timed('print', () => printWithRetry(session, plan, settings, report, returnBytes));
    report.hidden = (await agent.call('report').catch(() => ({}))).hidden || [];
    report.heading = await lessonHeading(frameAgents, info);
  } catch (e) {
    printed?.sink.discard();
    throw e;
  } finally {
    progress('cleanup', 92, 'Restoring the page');
    for (const f of frameAgents) {
      if (!session.attached) break;
      await f.agent.call('revert', [], { timeoutMs: 10_000 }).catch(() => {});
      await f.agent.call('restoreScroll', [f.info.scroll]).catch(() => {});
    }
    await cleanup(session, agent, net, info, tabId);
  }

  const filename = sanitizeFilename(report.heading || info?.title, info?.url);
  report.totalMs = Date.now() - started;
  const base = { filename, pages: printed.pages, bytes: printed.bytes, tagged: printed.tagged, report };

  if (returnBytes) return { ...base, chunks: printed.sink.chunks, params: printed.params };

  progress('save', 96, 'Saving the file');
  const { url, size } = await printed.sink.finish();
  const downloadId = await startDownload({
    url,
    sinkId: printed.sink.id,
    filename,
    subfolder: settings.subfolder,
    saveAs: settings.askWhere,
  });
  await chrome.storage.session.set({ [`dl:${downloadId}`]: { sinkId: printed.sink.id, tabId } });
  if (!settings.askWhere) {
    const done = await waitForDownload(downloadId, 15_000);
    if (done.state === 'interrupted') {
      await chrome.storage.session.remove(`dl:${downloadId}`);
      await revokeBlob(printed.sink.id);
      if (done.error === 'USER_CANCELED') throw new JobError('CANCELLED', 'Cancelled');
      throw new JobError('DOWNLOAD_FAILED', `The download failed (${done.error}).`);
    }
    if (done.state === 'complete') {
      await chrome.storage.session.remove(`dl:${downloadId}`);
      await revokeBlob(printed.sink.id);
    }
  }
  return { ...base, bytes: size, downloadId };
}

// ------------------------------------------------------------------ phases


async function waitViewportStable(session) {
  // The "started debugging" bar shrinks the viewport right after attach.
  const start = Date.now();
  let last = null;
  let stableSince = Date.now();
  while (Date.now() - start < 1500) {
    const m = await session.send('Page.getLayoutMetrics');
    const h = m.cssLayoutViewport?.clientHeight;
    if (h !== last) {
      last = h;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 300 && Date.now() - start >= 400) {
      return;
    }
    await sleep(100);
  }
}

// Course players show the lesson in a frame that fills most of the window, while
// the page title names the course or module. Name the file after the lesson.
async function lessonHeading(frameAgents, info) {
  const viewArea = (info?.viewW || 0) * (info?.viewH || 0);
  if (!viewArea) return '';
  const lessons = frameAgents
    .filter((f) => f.m.innerW * f.m.innerH >= viewArea * LESSON_FRAME_SHARE)
    .sort((a, b) => b.frame.depth - a.frame.depth);
  for (const f of lessons) {
    const text = await f.agent.call('heading').catch(() => '');
    if (text) return text;
  }
  return '';
}

async function probeBeforeAttach(tabId) {
  // Needs activeTab or host access, which every real entry point grants.
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ height: innerHeight, contentType: document.contentType }),
    });
    return { height: Number(r?.result?.height) || 0, contentType: r?.result?.contentType || '' };
  } catch {
    return { height: 0, contentType: '' };
  }
}

function pdfTabError() {
  return new JobError('PDF_TAB', 'This tab is already a PDF file. Use "Download original" to save it.');
}

// width 0 keeps the real width; height 0 keeps the real height; scale 0 keeps
// the real pixel ratio. Layout width never changes.
async function applyViewport(session, settings, height = 0) {
  const dpr = settings.highResImages && settings.dpr > 1 ? settings.dpr : 0;
  if (!dpr && !height) {
    await session.send('Emulation.clearDeviceMetricsOverride');
    return;
  }
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 0,
    height,
    deviceScaleFactor: dpr,
    mobile: false,
  });
}

async function scrollToEnd(session, agent, net, settings, view, check, onFraction, { emulate = true, deadline } = {}) {
  deadline ??= Date.now() + settings.scrollMaxSeconds * 1000;
  // A taller emulated viewport halves the number of steps, and lazy loaders
  // see more of the page at once. Restored before the layout phase. Frames
  // can't be resized this way; they scroll in their own window.
  if (emulate) {
    const baseH = view.height || (await agent.call('measure')).innerH;
    await applyViewport(session, settings, baseH * SCROLL_VIEWPORT_FACTOR);
    await agent.call('settle', [1]);
  }
  let m = await agent.call('scrollInit');
  let lastHeight = m.scrollHeight;
  let stable = 0;
  let steps = 0;
  let reason = 'time limit';
  while (Date.now() < deadline) {
    check();
    await agent.call('scrollStep', [C.SCROLL_STEP_FRACTION]);
    steps++;
    await net.waitQuiet({ quietMs: 300, maxMs: C.NET_QUIET_MAX_MS });
    await agent.call('settle', [1]);
    m = await agent.call('scrollMetrics');
    onFraction(Math.min(1, (m.scrollTop + m.clientHeight) / Math.max(1, m.scrollHeight)), 'Scrolling to the end');
    if (m.scrollHeight >= C.SCROLL_HEIGHT_CAP_PX) {
      reason = 'height limit';
      break;
    }
    if (m.atBottom) {
      stable = m.scrollHeight === lastHeight ? stable + 1 : 0;
      if (stable >= C.SCROLL_STABLE_ROUNDS) {
        reason = 'bottom';
        break;
      }
    } else {
      stable = 0;
    }
    lastHeight = m.scrollHeight;
  }
  await agent.call('scrollToTop');
  if (emulate) await applyViewport(session, settings, view.height);
  await agent.call('settle', [2]);
  await net.waitQuiet();
  return { steps, reason, height: m.scrollHeight, innerScroller: m.inner };
}

async function measureHeight(session, agent) {
  const m = await agent.call('measure');
  const lm = await session.send('Page.getLayoutMetrics');
  return { m, cssH: Math.max(m.scrollH, Math.ceil(lm.cssContentSize?.height || 0)) };
}

async function planPrint(session, agent, settings, report, view) {
  let { m, cssH } = await measureHeight(session, agent);
  const cssW = m.cssW;
  let fixedPageH = 0;
  const paramsFor = (h, extraPx = 0) =>
    computePrintParams({
      cssW,
      cssH: h,
      layout: settings.layout,
      paper: resolvePaper(settings.paper),
      orientation: settings.orientation,
      margins: settings.margins,
      extraPx,
      pageHeightPx: fixedPageH,
    });
  let print = paramsFor(cssH);

  // In print, vh resolves against the page height. Emulate a viewport that tall,
  // see which styles move, and pin them to their on-screen values.
  report.vh = [];
  await agent.call('vhSnapshot', [], { timeoutMs: 90_000 });
  for (let round = 0; round < 2; round++) {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 0,
      height: print.probeH,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await agent.call('settle', [2]);
    const frozen = await agent.call('vhFreeze', [], { timeoutMs: 90_000 });
    await applyViewport(session, settings, view.height);
    await agent.call('settle', [2]);
    const next = await measureHeight(session, agent);
    report.vh.push({
      probeH: print.probeH,
      probeViewport: frozen.viewport,
      frozen: frozen.frozen,
      sample: frozen.sample,
      heightBefore: cssH,
      heightAfter: next.cssH,
    });
    const moved = Math.abs(next.cssH - cssH) > 4;
    cssH = next.cssH;
    m = next.m;
    print = paramsFor(cssH);
    if (!moved) break;
  }

  report.overflow = await agent.call('fixHorizontalOverflow');
  if (report.overflow.fixed) {
    ({ cssH, m } = await measureHeight(session, agent));
    print = paramsFor(cssH);
  }

  // Embedded frames print as one picture sliced at each page boundary. Move
  // their content off the boundaries so no slide or line of text is cut.
  const frames = view.frameAgents || [];
  let pageH = settings.layout === 'paged' ? print.pageCssH : 0;
  if (settings.layout === 'continuous' && cssH > C.MAX_PAGE_PX) {
    // Leave room for the space pagination adds, and keep this page height after.
    const n = Math.ceil((cssH * 1.06) / C.MAX_PAGE_PX);
    pageH = Math.min(C.MAX_PAGE_PX, Math.ceil((cssH * 1.06) / n / 8) * 8);
  }
  if (frames.length && pageH && settings.paginateFrames !== false) {
    report.pagination = [];
    const pushed = await paginateFrames(session, agent, frames, pageH, report.pagination);
    if (settings.layout === 'continuous') fixedPageH = pageH;
    if (pushed) ({ cssH, m } = await measureHeight(session, agent));
    print = paramsFor(cssH);
  }
  // Site @page margins would otherwise override ours.
  await agent.call('injectPageRule', [print.marginIn]);
  report.finalize = await agent.call('finalize');
  for (const f of view.frameAgents || []) await f.agent.call('finalize').catch(() => {});
  report.page = { cssW, cssH, elements: m.elementCount };
  return { print, cssW, cssH, elementCount: m.elementCount, paramsFor };
}

async function printWithRetry(session, plan, settings, report, returnBytes) {
  let print = plan.print;
  for (let attempt = 0; ; attempt++) {
    const out = await printOnce(session, print, plan, settings, report, returnBytes);
    const tooMany = settings.layout === 'continuous' && out.pages > print.expectedPages;
    if (!tooMany || attempt >= 1) {
      if (tooMany) report.warnings.push(`Expected ${print.expectedPages} page(s) but got ${out.pages}.`);
      return { ...out, params: print.params };
    }
    // Something still grew in print layout. Try once with extra height.
    out.sink.discard();
    print = plan.paramsFor(plan.cssH, Math.max(24, Math.round(plan.cssH * 0.02)));
  }
}

async function printOnce(session, print, plan, settings, report, returnBytes) {
  const tagged =
    settings.tagged && plan.elementCount <= C.TAGGED_MAX_ELEMENTS && plan.cssH <= C.TAGGED_MAX_HEIGHT_PX;
  const base = {
    ...print.params,
    printBackground: true,
    preferCSSPageSize: false,
    displayHeaderFooter: false,
    transferMode: 'ReturnAsStream',
  };
  let res;
  let usedTags = tagged;
  try {
    res = await session.send(
      'Page.printToPDF',
      { ...base, generateTaggedPDF: tagged, generateDocumentOutline: tagged },
      { timeoutMs: C.PRINT_TIMEOUT_MS },
    );
  } catch (e) {
    if (!tagged || !session.attached) throw e;
    report.warnings.push(`Tagged PDF failed (${e.message}); saved without tags.`);
    usedTags = false;
    res = await session.send(
      'Page.printToPDF',
      { ...base, generateTaggedPDF: false, generateDocumentOutline: false },
      { timeoutMs: C.PRINT_TIMEOUT_MS },
    );
  }
  const sink = returnBytes ? memorySink() : await createBlobSink();
  try {
    const r = await readPdfStream(session, res.stream, (b64) => sink.append(b64));
    return { ...r, sink, tagged: usedTags };
  } catch (e) {
    sink.discard();
    throw e;
  }
}

function memorySink() {
  const chunks = [];
  return {
    id: null,
    chunks,
    append: (b64) => chunks.push(b64),
    discard: () => {
      chunks.length = 0;
    },
  };
}

async function cleanup(session, agent, net, info, tabId) {
  const wasAttached = session.attached;
  if (wasAttached && agent) {
    await agent.call('revert', [], { timeoutMs: 15_000 }).catch((e) => console.warn('revert failed', e));
    if (info?.scroll) await agent.call('restoreScroll', [info.scroll]).catch(() => {});
  }
  await net?.stop().catch(() => {});
  if (session.attached) {
    await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await session.send('Emulation.setEmulatedMedia', { media: '', features: [] }).catch(() => {});
  }
  await session.detach();
  if (!wasAttached && agent) await revertViaScripting(tabId);
}

// The debugger went away mid-save. Changes are recorded in data attributes, so a
// content script can undo them (works when activeTab or host access is granted).
async function revertViaScripting(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/selectors.js', 'content/agent.js'],
    });
    await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__p2p?.revert() });
  } catch (e) {
    console.warn('Could not undo page changes. Reloading the page restores it.', e);
  }
}
