import { getSettings, saveSettings } from './lib/settings.js';

const $ = (s) => document.querySelector(s);
const form = $('#options');
const saveBtn = $('#save');
const pickBtn = $('#pick');
const cancelBtn = $('#cancel');
const statusBox = $('#status');

const LABELS = {
  popup: 'popup',
  'top-nav': 'top nav',
  'top-nav-spacer': null,
  'side-nav': 'sidebar',
  footer: 'footer',
};

let tab = null;
let port = null;

init();

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  fillForm(await getSettings());
  showShortcut();

  if (tab?.id != null) send({ type: 'hello', tabId: tab.id });

  form.addEventListener('change', onFormChange);
  saveBtn.addEventListener('click', () => send({ type: 'save', tabId: tab.id }));
  pickBtn.addEventListener('click', () => {
    send({ type: 'pick', tabId: tab.id });
    setTimeout(() => window.close(), 150);
  });
  cancelBtn.addEventListener('click', () => send({ type: 'cancel', tabId: tab.id }));
  $('#copy-details').addEventListener('click', copyDetails);
}

// Chrome stops the service worker after about 30 idle seconds, which closes
// this port. Reconnect on the next message; that starts the worker again.
function send(msg) {
  if (port) {
    try {
      port.postMessage(msg);
      return;
    } catch {
      port = null;
    }
  }
  port = chrome.runtime.connect({ name: 'popup' });
  const p = port;
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
  });
  p.postMessage(msg);
}

function onMessage(msg) {
  if (msg.type === 'hello') {
    if (!msg.verdict.ok) showNotice(msg.verdict);
    else if (msg.verdict.looksLikePdf) showPdfNotice();
    if (msg.status && (msg.running || Date.now() - msg.status.ts < 60_000)) renderStatus(msg.status);
  } else if (msg.type === 'status' && msg.status.tabId === tab?.id) {
    renderStatus(msg.status);
  } else if (msg.type === 'error') {
    renderStatus({ state: 'error', message: msg.message });
  }
}

function renderStatus(s) {
  statusBox.hidden = false;
  statusBox.className = `status ${s.state}`;
  $('.fill').style.width = `${s.pct ?? 0}%`;
  $('#msg').textContent = s.state === 'done' ? `Saved ${s.filename}` : s.message || '';
  cancelBtn.hidden = s.state !== 'running';
  const busy = s.state === 'running';
  saveBtn.disabled = busy;
  pickBtn.disabled = busy;
  $('#detail').textContent = s.state === 'done' ? describeResult(s) : '';
  $('#copy-details').hidden = s.state !== 'done' && s.state !== 'error';
  if (s.code === 'PDF_TAB') showPdfNotice();
  if (s.code === 'FILE_ACCESS') showNotice(s);
}

async function copyDetails() {
  const key = `details:${tab.id}`;
  const details = (await chrome.storage.session.get(key))[key];
  const btn = $('#copy-details');
  if (!details) {
    btn.textContent = 'No details yet';
    return;
  }
  await navigator.clipboard.writeText(JSON.stringify(details, null, 2));
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = 'Copy details'), 1500);
}

function describeResult(s) {
  const parts = [];
  if (s.pages) parts.push(`${s.pages} page${s.pages === 1 ? '' : 's'}`);
  if (s.bytes) parts.push(formatBytes(s.bytes));
  const hidden = s.summary?.hidden || {};
  const removed = Object.entries(hidden)
    .filter(([reason]) => LABELS[reason] !== null)
    .map(([reason, n]) => `${n} ${LABELS[reason] || reason}${n === 1 ? '' : 's'}`);
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  if (s.summary?.imagesUpgraded) parts.push(`${s.summary.imagesUpgraded} images upgraded`);
  if (s.summary?.seconds) parts.push(`${s.summary.seconds}s`);
  return parts.join(' · ');
}

function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function showNotice({ code, reason }) {
  $('#notice').hidden = false;
  $('#notice-text').textContent = reason;
  const action = $('#notice-action');
  if (code === 'FILE_ACCESS') {
    action.hidden = false;
    action.textContent = 'Open extension settings';
    action.onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  }
  if (code === 'RESTRICTED' || code === 'FILE_ACCESS') {
    saveBtn.disabled = true;
    pickBtn.disabled = true;
  }
}

function showPdfNotice() {
  $('#notice').hidden = false;
  $('#notice-text').textContent = 'This tab is already a PDF file.';
  const action = $('#notice-action');
  action.hidden = false;
  action.textContent = 'Download original';
  action.onclick = () => chrome.downloads.download({ url: tab.url });
}

function fillForm(s) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === 'checkbox') el.checked = !!s[el.name];
    else if (el.type === 'radio') el.checked = el.value === s[el.name];
    else el.value = s[el.name];
  }
  syncDependent(s);
}

async function onFormChange(e) {
  const el = e.target;
  if (!el.name) return;
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (el.name === 'dpr' || el.name === 'scrollMaxSeconds') value = Number(value);
  const next = await saveSettings({ [el.name]: value });
  if (el.name === 'scrollMaxSeconds' || el.name === 'subfolder') fillForm(next);
  syncDependent(next);
}

function syncDependent(s) {
  $('#paged').hidden = s.layout !== 'paged';
  $('#layout-help').textContent =
    s.layout === 'paged'
      ? 'The desktop layout is scaled to fit the paper. Images and text are kept whole at page breaks.'
      : 'The whole page as one tall page at screen width. Very long pages are split into parts under 200 inches.';
  form.elements.scrollMaxSeconds.disabled = !s.scrollToEnd;
  form.elements.dpr.disabled = !s.highResImages;
}

async function showShortcut() {
  const cmds = await chrome.commands.getAll();
  const save = cmds.find((c) => c.name === 'save-pdf');
  if (save?.shortcut) $('#shortcut').textContent = save.shortcut;
}
