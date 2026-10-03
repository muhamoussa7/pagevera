// Filename cleanup and chrome.downloads helpers.

import { clickDownload } from './offscreen-client.js';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_NAME = 150;

export function sanitizeFilename(title, url, date = new Date()) {
  let name = String(title || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s~]+|[.\s]+$/g, '');

  if (!name) {
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // Not a URL.
    }
    const day = date.toISOString().slice(0, 10);
    name = [host || 'page', day].join(' ');
  }

  // Cap by code points so emoji and CJK titles aren't cut mid-character.
  const chars = [...name];
  if (chars.length > MAX_NAME) name = chars.slice(0, MAX_NAME).join('').trim().replace(/[.\s]+$/g, '');
  if (RESERVED.test(name)) name = `_${name}`;
  return `${name}.pdf`;
}

// chrome.downloads.download puts a filename an extension picks in the default
// download folder, so Chrome's save dialog would always open there. A link click
// in the offscreen document follows Chrome's own settings instead, including the
// last folder the user saved to. A subfolder or a forced dialog still needs the API.
export async function startDownload({ url, sinkId, filename, subfolder = '', saveAs = false }) {
  if (!subfolder && !saveAs && sinkId) {
    const id = await downloadByLink(url, sinkId, filename).catch(() => null);
    if (id != null) return id;
  }
  const path = subfolder ? `${subfolder}/${filename}` : filename;
  return chrome.downloads.download({ url, filename: path, saveAs: !!saveAs, conflictAction: 'uniquify' });
}

function downloadByLink(url, sinkId, filename, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const done = (settle, value) => {
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      settle(value);
    };
    // Chrome creates the download before it shows the save dialog.
    const onCreated = (item) => {
      if (item.url === url) done(resolve, item.id);
    };
    const timer = setTimeout(() => done(reject, new Error('The link download did not start')), timeoutMs);
    chrome.downloads.onCreated.addListener(onCreated);
    clickDownload(sinkId, filename).catch((e) => done(reject, e));
  });
}

export function waitForDownload(id, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      resolve(result);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      const state = delta.state.current;
      if (state === 'complete' || state === 'interrupted') finish({ state, error: delta.error?.current });
    };
    const timer = setTimeout(() => finish({ state: 'timeout' }), timeoutMs);
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        finish({ state: item.state, error: item.error, filename: item.filename });
      }
    });
  });
}
