// Pages Chrome won't let extensions touch, checked up front so the user gets a
// clear message instead of a debugger error.

const BLOCKED_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'view-source:',
  'about:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
  'javascript:',
]);

const STORE_PATTERNS = [/^https:\/\/chromewebstore\.google\.com(\/|$)/i, /^https:\/\/chrome\.google\.com\/webstore/i];

// Pure part, unit tested in Node.
export function classifyUrl(url) {
  if (!url) return { ok: true };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: true };
  }
  if (BLOCKED_SCHEMES.has(u.protocol)) {
    return { ok: false, code: 'RESTRICTED', reason: "Chrome doesn't allow extensions to save this kind of page." };
  }
  if (STORE_PATTERNS.some((re) => re.test(url))) {
    return { ok: false, code: 'RESTRICTED', reason: "Chrome doesn't allow extensions to run on the Chrome Web Store." };
  }
  return {
    ok: true,
    isFile: u.protocol === 'file:',
    looksLikePdf: /\.pdf$/i.test(u.pathname),
  };
}

export async function checkTab(tab) {
  const result = classifyUrl(tab?.url || tab?.pendingUrl);
  if (!result.ok) return result;
  if (result.isFile && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return {
      ok: false,
      code: 'FILE_ACCESS',
      reason: 'To save local files, turn on "Allow access to file URLs" for PageVera.',
    };
  }
  return result;
}
