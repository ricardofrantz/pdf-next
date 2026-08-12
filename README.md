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

- **Watches your file every second.** Rebuild the PDF and the view updates in about a second,
  keeping your page, scroll position and zoom. If the build deletes the file first, the last
  render stays on screen and the indicator turns red until the new file lands.
- **Fits the window to the document.** Open a portrait paper and you get a portrait window,
  sized to the page and centred; open a wide figure and the window is wide. It only happens
  when you open a file — rebuilds never move your window.
- **Dock to the left half** with `Ctrl+Shift+←` or the toolbar button, so the PDF takes the left
  half of the screen and your editor keeps the right. Your page and zoom survive the move.
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
