// User options, stored in chrome.storage.sync so they follow the user's profile.

// Bump when a default changes in a way saved settings should pick up.
export const SETTINGS_VERSION = 2;

export const DEFAULTS = Object.freeze({
  version: SETTINGS_VERSION,
  layout: 'paged', // 'paged' | 'continuous'
  paper: 'auto', // 'auto' (Letter or A4 by language) | 'a4' | 'letter' | 'legal'
  orientation: 'portrait', // 'portrait' | 'landscape'
  margins: 'small', // 'none' | 'small' | 'normal' (paged only)

  removeTopNav: true,
  removeSideNav: true,
  removeFooter: false,
  removePopups: true,

  scrollToEnd: true,
  scrollMaxSeconds: 60,

  screenStyles: true,
  highResImages: true,
  dpr: 2, // 1 | 2 | 3
  reducedMotion: true,
  tagged: true,

  askWhere: false,
  subfolder: '',
});

const KEY = 'settings';

export async function getSettings() {
  const stored = (await chrome.storage.sync.get(KEY))[KEY] || {};
  return normalize(migrate({ ...DEFAULTS, ...stored, version: stored.version || 1 }));
}

// Version 1 defaulted to one continuous page with no margins, which made very
// long PDFs. Version 2 defaults to normal pages.
export function migrate(s) {
  if (s.version < 2) {
    if (s.layout === 'continuous') s.layout = 'paged';
    if (s.margins === 'none') s.margins = 'small';
    if (s.paper === 'a4') s.paper = 'auto';
  }
  s.version = SETTINGS_VERSION;
  return s;
}

export async function saveSettings(patch) {
  const next = normalize({ ...(await getSettings()), ...patch });
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}

export function normalize(s) {
  const out = { ...s };
  if (!['continuous', 'paged'].includes(out.layout)) out.layout = DEFAULTS.layout;
  if (!['auto', 'a4', 'letter', 'legal'].includes(out.paper)) out.paper = DEFAULTS.paper;
  if (!['portrait', 'landscape'].includes(out.orientation)) out.orientation = DEFAULTS.orientation;
  if (!['none', 'small', 'normal'].includes(out.margins)) out.margins = DEFAULTS.margins;
  out.dpr = [1, 2, 3].includes(Number(out.dpr)) ? Number(out.dpr) : DEFAULTS.dpr;
  const secs = Number(out.scrollMaxSeconds);
  out.scrollMaxSeconds = Number.isFinite(secs) ? Math.min(600, Math.max(5, Math.round(secs))) : DEFAULTS.scrollMaxSeconds;
  out.subfolder = String(out.subfolder || '')
    .split(/[\\/]+/)
    .map((part) => part.replace(/[<>:"|?*\x00-\x1f]/g, '').trim().replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .join('/');
  return out;
}
