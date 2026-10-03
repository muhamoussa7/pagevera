# How it works

The technical side of [PageVera](../README.md): how a save works, what Chrome's PDF engine can and can't do, and how to run the tests.

## The save pipeline

The extension attaches Chrome's debugger to the tab and calls the DevTools command `Page.printToPDF`. That is the same PDF engine as Print → Save as PDF, without the dialog. In that engine:

- Text is written as text with embedded font subsets.
- JPEG images are embedded byte for byte. PNG, WebP and AVIF are stored losslessly.
- Images are drawn from the full source file, not resampled to their display size.

The quality gains come from preparing the page first:

1. Find every frame on the page, including cross-origin iframes such as embedded course players (SCORM, Articulate Rise) and document viewers, and run the same preparation inside each one.
2. Remove popups and scroll locks, and switch lazy-loading images and iframes to load right away.
3. Optionally scroll to the end, inside embedded frames first and then the page, waiting for network requests to settle after each step.
4. Remove the chosen navigation, footer and popups, in each frame and on the page. Convert sticky and fixed elements so they print once instead of repeating. Let fixed-height panels and inner scroll areas grow so their whole content prints.
5. Grow each embedded frame to its full content height, innermost first. If the content sits in a full-window dialog (a course or document player), print that dialog on its own and leave out the page behind it, with the lesson starting at the top of page 1.
6. Chrome prints an embedded frame as one picture cut at every page break. Since the page height is known, the extension moves any image or text block that would straddle a break down to the next page inside the frame first.
7. Pin every responsive image to its largest candidate and wait until all images and fonts have loaded.
8. In print, `vh` units are measured against the paper height, which would make a full-screen hero section as tall as the whole PDF. The extension briefly emulates a viewport as tall as the paper, finds every style that changes, and pins it to its on-screen value.
9. Print, then undo every change to the page and restore your scroll position.

## Limitations

- Content drawn on a `<canvas>` (Google Docs, Sheets, Figma, maps) comes out as an image, not text.
- Elements with a CSS `filter`, `backdrop-filter` or blurred shadow are rasterized at 300 DPI by Chrome's PDF engine. Do-nothing filters such as `brightness(1)` are removed automatically, and so are filters and shadows on boxes taller than two screens, where they would turn into huge images.
- Virtualized feeds that remove off-screen items (X, Slack, Gmail) only include what is rendered when the PDF is made.
- Videos print as their current frame. Course content hidden behind "Continue" buttons only prints after you've clicked through it.
- Horizontally scrolling code blocks and tables only print their visible part.
- Pages with many PNG, WebP or AVIF images produce large files, because those pixels are stored losslessly.
- Chrome blocks extensions on `chrome://` pages, the Chrome Web Store and other extensions' pages. If the tab is already showing a PDF, the popup offers to download the original file.

## Development

Requirements: Node 22, Python 3 with Pillow and numpy, and poppler (`brew install poppler`) for the PDF checks.

```sh
npm install          # playwright-core, used only by the tests
npm run fixtures     # generate test images (already committed)
npm run icons        # redraw the icons
node tools/make_screenshots.mjs   # redraw the README images from docs/demo/article.html
npm test             # unit tests + end-to-end tests
npm run package      # zip only the files the extension needs
```

The end-to-end tests launch Chrome for Testing with the unpacked extension (branded Chrome ignores `--load-extension`). By default they use the Playwright build at `~/Library/Caches/ms-playwright/chromium-1243`. Set `CHROME_PATH` to use another Chrome for Testing binary.

`node tests/run-one.mjs <fixture.html | URL> '{"layout":"paged"}' [--headed] [--out file.pdf]` saves one page and prints the job report, embedded fonts and embedded image sizes.

Code layout:

- `background.js`: service worker. Routes popup, shortcut, context menu and picker requests.
- `lib/job.js`: one save from start to finish.
- `lib/cdp.js`, `lib/agent-host.js`: debugger session and the isolated world the page script runs in.
- `content/agent.js`: page preparation. Every change is recorded on the element so it can be undone.
- `content/picker.js`: the click-to-remove toolbar.
- `lib/paper.js`, `lib/pdf-stream.js`, `lib/offscreen-client.js`, `offscreen.js`, `lib/download.js`: paper size math, reading the PDF stream, and turning it into a downloaded file.
