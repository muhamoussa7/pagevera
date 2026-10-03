// Which paper 'auto' means for this browser language.

// US-style regions use Letter, everyone else A4, like Chrome's own default.
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'PR', 'GT', 'CR', 'PA', 'DO', 'SV', 'NI', 'HN', 'BZ']);
export function resolvePaper(paper, lang = globalThis.navigator?.language || 'en-US') {
  if (paper !== 'auto') return paper;
  const region = (lang.split(/[-_]/)[1] || (lang.toLowerCase().startsWith('en') ? 'US' : '')).toUpperCase();
  return LETTER_REGIONS.has(region) ? 'letter' : 'a4';
}
