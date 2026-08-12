# pdf-next

A small, fast PDF and image viewer that **reloads the moment the file changes** — built for
the LaTeX and Typst compile loop, where you rebuild and want to see the result without
touching anything.

[![CI](https://github.com/ricardofrantz/pdf-next/actions/workflows/ci.yml/badge.svg)](https://github.com/ricardofrantz/pdf-next/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![GitHub](https://img.shields.io/badge/github-pdf--next-blue)](https://github.com/ricardofrantz/pdf-next)

It is the desktop sibling of [vscode-pdf Next](https://github.com/ricardofrantz/vscode-pdf-next)
and shares its rendering approach: the latest Mozilla PDF.js (`pdfjs-dist@6.2.108`) parsing in a
real worker thread, dark reading modes that recolour pages instead of filtering them, and reload
that survives a build deleting and recreating the file mid-compile.

## What it does

- **Watches your file, on by default.** Rebuild the PDF and the view updates within a second,
  keeping your page, scroll position and zoom. The interval is in the toolbar — 1s, 2s, 3s, or
  off. If the build deletes the file first, the last render stays on screen and a red dot
  appears until the new file lands.
- **Never shows a half-written file.** A build rewrites a PDF over hundreds of milliseconds and
  the file's metadata changes the instant it starts, so a naive watcher reloads garbage. Before
  reloading, pdf-next checks the file is complete: on Windows the writer normally holds an
  exclusive lock, so simply opening it fails; on macOS and Linux nothing stops you reading a
  partial file, so PDFs are also checked for their `%%EOF` trailer. If it is not ready, the
  reload waits for the next tick.
- **Fits the window to the document.** Open a paper and the window becomes the size of the page
  itself, centred; open a wide figure and the window is wide. It only happens when you open a
  file — rebuilds never move your window. With no file open, it stays a small drop target.
- **Remembers the window size per file.** Resize while reading a paper and reopening it later
  gives you that window back. Stored with the app's preferences, capped at the 80 most recent
  files, so there is no cache to manage.
- **Dock to the left half** with `Ctrl+Shift+←` or the toolbar button, so the PDF takes the left
  half of the screen and your editor keeps the right. It switches to fit-width, because fitting
  a whole page into a tall narrow column just shrinks the text. Press it again to undock: the
  window returns to the size of the page and the zoom returns to fit-page. Your place in the
  document survives both moves.
- **PDF and images.** `.pdf`, plus `.png`, `.jpg`, `.webp` and `.avif`.
- **Follows your system dark mode**, and can recolour PDF pages themselves: night, sepia, or a
  full invert for scans. Shift+click the mode button to go back to plain pages.
- **Text search** with match counts, powered by PDF.js.
- **Keyboard first:** `j`/`k` scroll, `n`/`p` pages, `g`/`G` first and last, `+`/`-` zoom,
  `Ctrl+F` find, `Ctrl+R` reload, `Ctrl+O` open, `Ctrl+Shift+←` dock left.

## Install

Grab the build for your system from [Releases](https://github.com/ricardofrantz/pdf-next/releases):

| System | File | Notes |
| ------ | ---- | ----- |
| Windows | `.exe` installer | Unsigned — SmartScreen shows a warning; choose *More info → Run anyway*. |
| macOS | universal `.dmg` | Intel and Apple Silicon in one file. Unsigned — first launch needs `xattr -d com.apple.quarantine /Applications/pdf-next.app`. |
| Ubuntu | `.AppImage` or `.deb` | AppImage: `chmod +x` and run. |

Then open a file by double-clicking it, dragging it onto the window, pressing `Ctrl+O`, or
passing a path:

```bash
pdf-next paper.pdf
```

## Security

The threat model is the obvious one: you open a PDF someone sent you, and the attacker controls
every byte of it.

- **The window cannot navigate away from the app.** A link annotation in a malicious PDF used to
  be able to replace the entire viewer with an attacker-controlled page — in a window with no
  address bar — and a link pointing back at the asset protocol would be served as HTML at a
  *local* origin, which Tauri trusts with IPC. A navigation guard now rejects anything that is
  not the app's own origin, and external links in documents are inert (internal ones, like a
  table of contents, still work).
- **The webview can read exactly one file**: the one you opened. The asset scope starts empty and
  the opened document is allowed at runtime, so even injected script has no filesystem reach.
- **Two permissions total** — listen and unlisten for events. Everything else, including path
  resolution and the file dialog, is driven from Rust where the frontend cannot reach it.
- No `eval`, no WASM execution, no plugins, no framing, and PDF scripting is off, so a document
  cannot execute anything on its own.

## Memory, measured not claimed

Numbers from Windows 11, WebView2 151, whole process tree, the 15-page *Attention Is All You
Need* paper:

| | Working set | Private bytes |
| --- | --- | --- |
| Window open, no document | 376 MB | 189 MB |
| 15-page PDF open | 431 MB | 257 MB |

**Be clear about what this means.** The document costs about 55–70 MB; everything else is the
WebView2 (Chromium) floor, which is the same floor every Chromium-based app pays and is partly
shared memory counted against every process using it. The binary is ~5 MB and starts instantly,
but "low memory" here means *lower than Electron*, not *lower than a native viewer* — Electron
would ship its own copy of Chromium on top of this. A native renderer such as pdfium would be
dramatically lighter and is the honest alternative if resident memory is the only thing you
care about.

Linux (WebKitGTK) and macOS (WKWebView) use different engines with different, usually smaller,
floors — those are not measured yet.

**Reloading used to leak badly.** Each reload dropped the previous PDF.js document without
destroying it, which kept its worker thread, font and image caches and rendered canvases alive:
**77 MB per reload, unbounded**, so an afternoon of LaTeX would reach several gigabytes. Now the
document is torn down, one worker is shared for the life of the process instead of one spawned
per reload, page views free their canvases instead of waiting for the collector, and reloads are
skipped entirely while the window is hidden.

What remains scales with the document, not with the number of reloads: a 1.2 KB PDF reloaded 20
times grows by **nothing at all**, while a 2.2 MB paper grows ~10 MB per reload and gives much of
it back when idle. That points at the webview caching each cache-busted URL; serving the document
from a purpose-built protocol with `Cache-Control: no-store` is the next step, and would let the
asset protocol be dropped entirely.

## Building

Needs [Rust](https://rustup.rs) and, on Windows, the MSVC build tools:

```bash
bun install
bun run dev      # dev window with reload
bun run build    # installers into src-tauri/target/release/bundle
```

On Ubuntu, install the webview dependencies first:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

`node tools/check_frontend.mjs` enforces the invariants that are easy to break silently: a real
PDF.js worker, streaming instead of whole-file reads, the canvas budget, the one-second poll,
and the mid-build gap behaviour.

## Scope

A viewer, not an editor. No annotations, no forms, no editing, no cloud. It opens a file, keeps
it current, and gets out of the way.

MIT licensed. Built on [Mozilla PDF.js](https://github.com/mozilla/pdf.js) and
[Tauri](https://tauri.app).
