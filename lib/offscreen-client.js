// The service worker can't create blob URLs, so an offscreen document assembles
// the PDF bytes into a Blob and hands back an object URL for chrome.downloads.

const OFFSCREEN_URL = 'offscreen.html';

let port = null;
let portWaiters = [];
let creating = null;
const pending = new Map(); // request id -> {resolve, reject}
const liveUrls = new Set(); // sink ids whose blob URL is still alive

export function onOffscreenConnect(p) {
  port = p;
  p.onMessage.addListener((msg) => {
    const req = pending.get(msg.id);
    if (!req) return;
    pending.delete(msg.id);
    if (msg.error) req.reject(new Error(msg.error));
    else req.resolve(msg);
  });
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    for (const req of pending.values()) req.reject(new Error('Offscreen document closed'));
    pending.clear();
  });
  portWaiters.forEach((resolve) => resolve(p));
  portWaiters = [];
}

async function ensurePort() {
  if (port) return port;
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  const waitForPort = new Promise((resolve, reject) => {
    portWaiters.push(resolve);
    setTimeout(() => reject(new Error('Offscreen document did not connect')), 10_000);
  });
  if (existing.length) {
    // The document outlived a service worker restart and lost its port. Recreate it.
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Builds the generated PDF into a file so it can be downloaded.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
  return waitForPort;
}

export async function createBlobSink() {
  const p = await ensurePort();
  const id = crypto.randomUUID();
  p.postMessage({ type: 'begin', id });
  return {
    id,
    append(b64) {
      if (!port) throw new Error('Offscreen document closed during save');
      port.postMessage({ type: 'chunk', id, data: b64 });
    },
    finish() {
      return new Promise((resolve, reject) => {
        pending.set(id, {
          resolve: (msg) => {
            liveUrls.add(id);
            resolve({ url: msg.url, size: msg.size });
          },
          reject,
        });
        port.postMessage({ type: 'finish', id });
      });
    },
    discard() {
      postQuietly({ type: 'discard', id });
    },
  };
}

// Downloads a finished PDF by clicking a link to it in the offscreen document.
export function clickDownload(sinkId, filename) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('Offscreen document closed during save'));
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    port.postMessage({ type: 'click', id, sinkId, filename });
  });
}

export async function revokeBlob(id) {
  liveUrls.delete(id);
  postQuietly({ type: 'revoke', id });
  await closeIfIdle();
}

// For messages that don't matter once the document is gone.
function postQuietly(msg) {
  try {
    port?.postMessage(msg);
  } catch {}
}

export async function closeIfIdle() {
  if (liveUrls.size || pending.size || creating) return;
  port = null;
  await chrome.offscreen.closeDocument().catch(() => {});
}
