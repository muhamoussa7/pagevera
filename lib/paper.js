// Turns the page's CSS size and the user's layout choice into printToPDF params.
// Pure functions so they can be unit tested in Node.

import { MARGINS, MAX_PAGE_PX, PAPERS, PT_PER_IN, PX_PER_IN } from './constants.js';

// A few px of slack so sub-pixel rounding never spills onto an extra page.
const CONTINUOUS_SLACK_PX = 2;
// Chrome rounds paper sizes to 1/300 inch and lays pages out in whole CSS px.
// 8 px = 6 pt = 25/300 inch, so page heights that are multiples of 8 px come
// out exactly as requested and page boundaries land where we expect them.
const PAGE_STEP_PX = 8;

export function computePrintParams({
  cssW,
  cssH,
  layout = 'continuous',
  paper = 'a4',
  orientation = 'portrait',
  margins = 'none',
  extraPx = 0,
  pageHeightPx = 0, // continuous: keep this page height (content was paginated for it)
}) {
  cssW = Math.max(1, Math.ceil(cssW));
  cssH = Math.max(1, Math.ceil(cssH));

  if (layout === 'continuous') {
    // Round up to whole points so the print width is never narrower than the screen
    // (a narrower width could cross a min-width breakpoint).
    const widthPt = Math.ceil(cssW * (PT_PER_IN / PX_PER_IN));
    const totalPx = cssH + extraPx;
    const pages = pageHeightPx ? Math.max(1, Math.ceil(totalPx / pageHeightPx)) : Math.max(1, Math.ceil(totalPx / MAX_PAGE_PX));
    const pagePx = Math.min(MAX_PAGE_PX, roundUp(pageHeightPx || Math.ceil(totalPx / pages) + CONTINUOUS_SLACK_PX, PAGE_STEP_PX));
    const heightPt = pagePx * (PT_PER_IN / PX_PER_IN);
    return {
      params: {
        paperWidth: widthPt / PT_PER_IN,
        paperHeight: heightPt / PT_PER_IN,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
        scale: 1,
        landscape: false,
      },
      marginIn: 0,
      expectedPages: pages,
      // vh in print resolves against the page area height, in CSS px.
      probeH: pagePx,
      pageCssH: pagePx,
    };
  }

  const p = PAPERS[paper] || PAPERS.a4;
  let w = p.w;
  let h = p.h;
  if (orientation === 'landscape') [w, h] = [h, w];
  const m = MARGINS[margins] ?? 0;
  const printableWpx = (w - 2 * m) * PX_PER_IN;
  const printableHpx = (h - 2 * m) * PX_PER_IN;
  // Scale so the desktop layout width fits the paper instead of reflowing to a
  // narrow one. Chrome rounds the page height in CSS px up to a whole number, so
  // aim a quarter px below a whole number N: Chrome lands on exactly N and our
  // page-boundary math matches. The layout gets at most ~1px wider.
  const fit = clamp(printableWpx / cssW, 0.1, 2);
  const pageCssH = Math.ceil(printableHpx / fit + 0.25);
  const scale = printableHpx / (pageCssH - 0.25);
  return {
    params: {
      paperWidth: w,
      paperHeight: h,
      marginTop: m,
      marginBottom: m,
      marginLeft: m,
      marginRight: m,
      scale,
      landscape: false,
    },
    marginIn: m,
    expectedPages: Math.max(1, Math.ceil(cssH / pageCssH)),
    probeH: Math.round(pageCssH),
    pageCssH,
  };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function roundUp(v, step) {
  return Math.ceil(v / step) * step;
}
