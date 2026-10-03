// Rebuilds PDF bytes from base64 chunks sent by the service worker and returns
// a blob URL the service worker can pass to chrome.downloads.

const port = chrome.runtime.connect({ name: 'offscreen' });
const parts = new Map(); // id -> Uint8Array[]
const urls = new Map(); // id -> blob URL

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'begin':
      parts.set(msg.id, []);
      break;
    case 'chunk':
      parts.get(msg.id)?.push(decode(msg.data));
      break;
    case 'finish': {
      const chunks = parts.get(msg.id);
      parts.delete(msg.id);
      if (!chunks) {
        reply({ id: msg.id, error: 'Unknown PDF id' });
        break;
      }
      const blob = new Blob(chunks, { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      urls.set(msg.id, url);
      reply({ id: msg.id, url, size: blob.size });
      break;
    }
    case 'click': {
      // A link click is an ordinary page download, so Chrome's "Ask where to
      // save" dialog opens in the last folder the user picked.
      const url = urls.get(msg.sinkId);
      if (!url) {
        reply({ id: msg.id, error: 'Unknown PDF id' });
        break;
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = msg.filename;
      a.click();
      reply({ id: msg.id });
      break;
    }
    case 'discard':
      parts.delete(msg.id);
      break;
    case 'revoke': {
      const url = urls.get(msg.id);
      if (url) URL.revokeObjectURL(url);
      urls.delete(msg.id);
      break;
    }
  }
});

// The service worker may have stopped since it asked. It recreates this document
// when it needs it again.
function reply(msg) {
  try {
    port.postMessage(msg);
  } catch {}
}

function decode(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
