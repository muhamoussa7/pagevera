# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PageVera is an MV3 Chrome extension (plain ES modules, no build step, no bundler) that saves the current tab as a PDF, PNG or Markdown file without the print dialog. The README is written as a product case study and `docs/how-it-works.md` holds the full save pipeline and limitations. Read the latter before touching `content/agent.js`.

## Commands

```sh
npm run test:unit                      # node --test tests/unit/*.test.mjs (pass the glob, not the directory)
npm run test:e2e                       # loads the extension in Chrome for Testing, inspects output with poppler
npm test                               # both
node --test --test-concurrency=1 tests/e2e.test.mjs --test-name-pattern="Markdown"   # one e2e test
node tests/run-one.mjs basic.html '{"layout":"paged"}' [--headed] [--out f.pdf]      # save one fixture, print the job report
node tools/make_screenshots.mjs        # regenerate docs/images from docs/demo/article.html
npm run package                        # zip only the files the extension ships
```

E2E needs poppler (`brew install poppler`) and a Chrome for Testing binary. Default path is the Playwright build under `~/Library/Caches/ms-playwright/chromium-1243`; override with `CHROME_PATH`. Branded Chrome ignores `--load-extension`. There is no linter.

To try changes by hand, reload the unpacked extension at `chrome://extensions`.

## Architecture

A save is one `runJob(tabId, overrides, hooks)` in `lib/job.js`. `background.js` (service worker) only routes the popup, shortcut, context menu and picker to it, and registers every listener at top level so a restarted worker still gets them.

- **Debugger, not content scripts.** `lib/cdp.js` attaches `chrome.debugger` and the job drives `Page.printToPDF` / `Page.captureScreenshot`. Page code runs in an isolated world created by `lib/agent-host.js`, which loads `content/agent.js`, `content/markdown.js` (exposed as `__p2p.toMarkdown`) and the selectors as source text. These files are injected, not imported, so they can't use `import` and share state through `__p2p`.
- **Every page mutation must be undoable.** `agent.js` records each change on the element and the job reverts them all after printing. Add new changes through the same recording path.
- **Frames.** `lib/frames.js` discovers all frames (including cross-origin iframes) and creates one agent per frame. Preparation runs in each frame, innermost first. Frame steps are wrapped in try/catch and push to `report.warnings`, because frames can vanish mid-save ("Frame with the given id was not found").
- **Formats.** `settings.format` is `pdf | png | md`. PDF goes through measure/paginate/print. PNG goes through `captureImage()` (device-metrics override, pixel ratio lowered for tall pages, `MAX_IMAGE_SIDE_PX`). Markdown goes through `exportMarkdown()` and skips measuring and printing. Frame pagination is PDF-only.
- **Getting bytes out.** The service worker can't build Blobs for downloads, so data is streamed in base64 chunks to the offscreen document (`lib/offscreen-client.js`, `offscreen.js`), which makes a blob URL with the right mime type. `lib/download.js` names the file and starts the download. When `returnBytes` is set (tests), chunks go to `memorySink` instead and the download is skipped.
- **Settings.** `lib/settings.js` normalizes everything read from storage or passed as overrides. Add a setting there first, then to `popup.html`/`popup.js`. Popup visibility rules per format live in `syncDependent` in `popup.js` and in `data-formats` attributes in `popup.html`.
- **Picker.** `content/picker.js` is the click-to-remove toolbar. It runs in the page and talks to the worker through messages.

## Tests

E2E tests call `self.p2p.runJob(...)` directly in the service worker with `returnBytes: true` (see `tests/harness.mjs`), against fixtures served by `tests/server.mjs`. They assert on real PDF/PNG/Markdown output. The harness defaults `layout` to `continuous`. Fixtures in `tests/fixtures` are committed. `npm run fixtures` regenerates the images and needs Python 3 with Pillow and numpy.

## Repository rules

- This is a public portfolio repo. Keep the README a product case study with an accurate "My role" section, and keep personal contact details out of it.
- Keep the name of the user's former workspace folder and employer out of every file and commit message. The user's memory notes name the word to avoid.
- Commit as Muhammad Moussa <62445665+muhamoussa7@users.noreply.github.com>. Commit and push only when asked.
- Product names must be unique.
