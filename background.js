// Service worker: routes popup, shortcut, context menu and picker requests to jobs.
// All listeners are registered at the top level so a restarted worker still gets them.

import { cancelJob, EXPECTED_CODES, isRunning, runJob } from './lib/job.js';
import { onOffscreenConnect, revokeBlob } from './lib/offscreen-client.js';
import { checkTab } from './lib/restricted.js';
import { getSettings, saveSettings } from './lib/settings.js';

const popupPorts = new Set();
const pickerTabs = new Set();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'selection', 'link', 'image', 'video', 'frame'];
    chrome.contextMenus.create({ id: 'save-pdf', title: 'Save page as PDF', contexts });
    chrome.contextMenus.create({ id: 'pick-and-save', title: 'Save page as PDF, picking what to remove…', contexts });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || tab.id < 0) return;
  if (info.menuItemId === 'save-pdf') startJob(tab.id);
  else if (info.menuItemId === 'pick-and-save') startPicker(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab?.id || tab.id < 0) return;
  if (command === 'save-pdf') startJob(tab.id);
  else if (command === 'pick-and-save') startPicker(tab.id);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen') {
    onOffscreenConnect(port);
    return;
  }
  if (port.name !== 'popup') return;
  popupPorts.add(port);
  port.onDisconnect.addListener(() => popupPorts.delete(port));
  port.onMessage.addListener((msg) =>
    handlePopup(msg, port).catch((e) => post(port, { type: 'error', message: e.message })),
  );
});

// The popup can close while a reply is on its way.
function post(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    popupPorts.delete(port);
  }
}

async function handlePopup(msg, port) {
  switch (msg.type) {
    case 'hello': {
      const tab = await chrome.tabs.get(msg.tabId);
      const verdict = await checkTab(tab);
      const key = `job:${msg.tabId}`;
      const status = (await chrome.storage.session.get(key))[key] || null;
      post(port, { type: 'hello', verdict, status, running: isRunning(msg.tabId) });
      break;
    }
    case 'save':
      startJob(msg.tabId);
      break;
    case 'cancel':
      cancelJob(msg.tabId);
      break;
    case 'pick':
      await startPicker(msg.tabId);
      break;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId == null || !msg?.type) return;
  if (msg.type === 'picker-save') {
    pickerTabs.add(tabId);
    startJob(tabId);
    sendResponse({ ok: true });
  } else if (msg.type === 'picker-closed') {
    pickerTabs.delete(tabId);
  }
});

// Revoke the blob URL once Chrome has finished writing the file.
chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const key = `dl:${delta.id}`;
  const entry = (await chrome.storage.session.get(key))[key];
  if (!entry) return;
  await chrome.storage.session.remove(key);
  await revokeBlob(entry.sinkId);
  if (state === 'interrupted' && entry.tabId != null) {
    setStatus(entry.tabId, { state: 'error', message: `The download failed (${delta.error?.current || 'interrupted'}).` });
  }
});

async function startJob(tabId) {
  if (isRunning(tabId)) return;
  setStatus(tabId, { state: 'running', phase: 'start', pct: 0, message: 'Starting' });
  try {
    const result = await runJob(tabId, {}, { onProgress: (p) => setStatus(tabId, { state: 'running', ...p }) });
    await saveDetails(tabId, { ok: true, filename: result.filename, pages: result.pages, bytes: result.bytes, report: result.report });
    setStatus(tabId, {
      state: 'done',
      pct: 100,
      message: `Saved ${result.filename}`,
      filename: result.filename,
      pages: result.pages,
      bytes: result.bytes,
      summary: summarize(result.report),
    });
    return result;
  } catch (e) {
    const cancelled = e?.code === 'CANCELLED';
    await saveDetails(tabId, { ok: false, error: e?.message || String(e), code: e?.code, stack: e?.stack });
    setStatus(tabId, {
      state: cancelled ? 'cancelled' : 'error',
      message: cancelled ? 'Cancelled' : e?.message || String(e),
      code: e?.code,
    });
    if (!EXPECTED_CODES.has(e?.code)) console.error('Page to PDF failed:', e);
  }
}

// What the last save on this tab did, for the popup's "Copy details" link.
async function saveDetails(tabId, details) {
  const manifest = chrome.runtime.getManifest();
  const entry = {
    extension: `${manifest.name} ${manifest.version}`,
    chrome: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0],
    at: new Date().toISOString(),
    settings: await getSettings(),
    ...details,
  };
  await chrome.storage.session.set({ [`details:${tabId}`]: entry }).catch(() => {});
}

async function startPicker(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const verdict = await checkTab(tab);
  if (!verdict.ok) {
    setStatus(tabId, { state: 'error', message: verdict.reason, code: verdict.code });
    return;
  }
  const settings = await getSettings();
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/selectors.js', 'content/agent.js', 'content/picker.js'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (s) => globalThis.__p2pPicker.start(s),
    args: [settings],
  });
  pickerTabs.add(tabId);
}

function summarize(report) {
  const hidden = {};
  for (const h of report?.hidden || []) hidden[h.reason] = (hidden[h.reason] || 0) + 1;
  return {
    hidden,
    imagesUpgraded: report?.images?.upgraded || 0,
    warnings: report?.warnings || [],
    seconds: Math.round((report?.totalMs || 0) / 100) / 10,
  };
}

function setStatus(tabId, status) {
  const s = { ...status, tabId, ts: Date.now() };
  chrome.storage.session.set({ [`job:${tabId}`]: s }).catch(() => {});
  for (const p of popupPorts) post(p, { type: 'status', status: s });
  if (pickerTabs.has(tabId)) chrome.tabs.sendMessage(tabId, { type: 'p2p-status', status: s }).catch(() => {});
  updateBadge(tabId, s);
}

function updateBadge(tabId, s) {
  const colors = { running: '#2563eb', done: '#16a34a', error: '#dc2626', cancelled: '#6b7280' };
  const text = s.state === 'running' ? String(Math.min(99, s.pct || 0)) : s.state === 'done' ? '✓' : s.state === 'error' ? '!' : '';
  chrome.action.setBadgeBackgroundColor({ tabId, color: colors[s.state] || '#6b7280' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (s.state === 'done' || s.state === 'cancelled') {
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 6000);
  }
}

// Test hook: Playwright drives jobs through the service worker.
self.p2p = { runJob, startJob, startPicker, getSettings, saveSettings, popupPorts };
