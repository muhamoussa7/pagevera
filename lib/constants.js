// Shared limits and identifiers for the service worker side.

export const PX_PER_IN = 96;
export const PT_PER_IN = 72;

// Acrobat and most viewers cap a page side at 200 inches (14,400 pt).
export const MAX_PAGE_IN = 200;
export const MAX_PAGE_PX = MAX_PAGE_IN * PX_PER_IN; // 19,200 CSS px

// IO.read chunk size. 4 MiB of bytes is about 5.6 MB of base64 per message.
export const STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

// Scroll-to-end limits.
export const SCROLL_STEP_FRACTION = 0.8;
export const SCROLL_HEIGHT_CAP_PX = 200_000;
export const SCROLL_STABLE_ROUNDS = 3;

// Network quiet detection.
export const NET_QUIET_MS = 500;
export const NET_QUIET_MAX_MS = 2500;
export const NET_STALE_MS = 5000;

// Image waits.
export const IMAGE_WAIT_PER_IMAGE_MS = 15_000;
export const IMAGE_WAIT_TOTAL_MS = 30_000;
export const FONT_WAIT_MS = 5000;

// Tagged PDF builds the accessibility tree, which is slow on huge pages.
export const TAGGED_MAX_ELEMENTS = 50_000;
export const TAGGED_MAX_HEIGHT_PX = 500 * PX_PER_IN;

export const PRINT_TIMEOUT_MS = 180_000;

// In whole 1/300 inch units, which is how Chrome rounds paper sizes. Using the
// same numbers keeps our page-boundary math in step with Chrome's.
export const PAPERS = {
  a4: { w: 2480 / 300, h: 3508 / 300, label: 'A4' },
  letter: { w: 8.5, h: 11, label: 'Letter' },
  legal: { w: 8.5, h: 14, label: 'Legal' },
};

// Paged-mode margins in inches.
export const MARGINS = {
  none: 0,
  small: 0.25,
  normal: 0.5,
};
