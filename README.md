# pdf-next

A small, fast PDF, image and markdown viewer that **reloads the moment the file changes** —
built for the LaTeX and Typst compile loop, where you rebuild and want to see the result
without touching anything.

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
- **Dock to any half of the screen** — five toolbar buttons, or `Ctrl+Shift+←` / `→` / `↑` /
  `↓`, fill the left, right, top or bottom half, so the document takes one half and your
  editor keeps the other. Any dock switches to fit-width, because a half-screen window is for
  reading in, and fitting a whole page into one just shrinks the text. The center button (or
  `Ctrl+Shift+Enter`, or pressing the same edge again) undocks: the window returns to the size
  of the page, centred, and the zoom returns to fit-page. Your place in the document survives
  every move.
- **Fit the window to the content** with `Ctrl+Shift+F` or the toolbar button — the other
  direction from everything above. Set a figure to the size you want it and the window comes to
  the picture: no padding, no border of background, the frame exactly on the edges. It stays on,
  so zooming out brings the window in with it and zooming in pushes it back out, up to the size
  of your screen. Choosing a fit preset from the zoom menu turns it off again, because fitting
  the content to the window is the opposite instruction.
- **Tabs, without the memory.** Open several files and they line up in a strip; `←` / `→`,
  `Ctrl+Tab` or `Ctrl+1`…`9` move between them, `Ctrl+W` closes one. A tab is a path, not a
  loaded document — only the file you are looking at is in memory, so six open papers cost what
  one costs, and a background tab is read fresh from disk when you come back to it rather than
  going stale. Switching costs a re-parse, against a worker that is already warm.
- **Walk a folder of figures.** With a single file open, `←` / `→` (or the toolbar arrows) step
  through every image next to it, in reading order — `fig2` before `fig10`, not after it. The
  toolbar shows your position, and the window stays where it is instead of resizing on every
  press. A rotate button next to the arrows turns the picture a quarter turn clockwise per
  press; the next file comes up upright again.
- **PDF, images and markdown.** `.pdf`, plus `.png`, `.jpg`, `.webp` and `.avif`, plus `.md`.
  Images zoom too, with the same control and keys as a PDF.
- **Markdown, rendered or raw.** A `.md` opens as a typeset reading column — GitHub-style
  tables, task lists, footnotes and strikethrough included — parsed by
  [pulldown-cmark](https://github.com/pulldown-cmark/pulldown-cmark) in Rust and sanitized by
  [ammonia](https://github.com/rust-ammonia/ammonia) before the HTML ever reaches the window,
  so a hostile file cannot script anything. `Ctrl+U` (or the toolbar button) flips to the raw
  text and back; zoom reflows the text rather than scaling a bitmap. Edit the file and the
  view reloads within a second, keeping your scroll position — the same watch loop as PDFs.
- **Equations, typeset.** `$…$` and `$$…$$` are TeX, turned into MathML by
  [pulldown-latex](https://github.com/carloskiki/pulldown-latex) in the same Rust pass and set
  in Latin Modern — no JavaScript math engine, nothing fetched, and the MathML meets the same
  sanitizer as the prose.
- **Links go where you would expect.** A `#heading` or footnote scrolls; a web link opens in
  your browser; a relative link — `[notes](other.md)`, `[fig](fig1.png)`, the paper it
  cites — opens as a new tab, if it is a kind pdf-next shows. Nothing ever navigates the
  viewer itself.
  Local images referenced by the file are deliberately not loaded: the viewer reads exactly
  the files you opened, nothing next to them.
- **Follows your system dark mode**, and can recolour PDF pages themselves. The mode button
  cycles Clear → Night → Invert → Sepia, so plain white pages are always one press away;
  Shift+click it to jump straight back to Clear from anywhere.
- **Text search** with match counts, powered by PDF.js.
- **Opens at a page, or at a figure.** `--page 12`, `--find "Figure 3"` and `--dest results`
  say where to land, and the same thing can be written on the path the way a PDF link is —
  `paper.pdf#page=7&search=wake`. A file already open is aimed rather than opened twice, so a
  running window jumps to the page you asked for; `--no-focus` hands a file over without
  raising the window. The `opened` line prints the fragment that was understood, which is what
  lets a script — or an agent — check rather than assume.
- **Print with `Ctrl+P`**, to the system's own dialog — the real one, with your printer list,
  page range, copies, duplex, paper size and scaling. pdf-next adds no print settings of its
  own: it lays the document out for paper, then hands the window to macOS's print panel, the
  GTK dialog, or WebView2's print preview, whichever the machine has. A PDF is re-rendered at
  150 dpi on white, so what comes out is the page and not the screen — no toolbar, no dark
  mode, no window chrome — and an A4 paper prints at true size on A4. Markdown reflows across
  sheets as text, and an image gets a sheet to itself. A document whose pages are not all the
  same size follows the first one, as it does in every other viewer. If the machine has nothing
  to print to — no printer, or a stopped print service — it says so rather than opening nothing.
- **The title says which build you are running** — `paper.pdf — pdf-next 0.9.0` — so a bug report
  can name a version without hunting for an about box.
- **Tells you when there is a newer version.** A few seconds after launch the app asks
  GitHub for the latest release, once; if it is newer, the last toolbar button lights up and a
  press fetches the installer for your system — `.exe`, `.dmg` or `.AppImage` — in your
  browser, from the repo's own Releases page. Pressing the button checks again on demand.
  Nothing polls: that one request at launch is the only network access the app makes on its
  own, downloads only ever happen on a press, and GitHub is the only host it can reach.
- **Keyboard first:** `j`/`k` scroll, `n`/`p` pages, `g`/`G` first and last, `+`/`-` zoom,
  `←`/`→` tabs (or folder, with one file open), `Ctrl+W` close, `Ctrl+F` find, `Ctrl+R` reload,
  `Ctrl+O` open, `Ctrl+P` print, `Ctrl+U` raw markdown,
  `Ctrl+Shift+F` fit window to content,
  `Ctrl+Shift+←`/`→`/`↑`/`↓` dock to a screen half, `Ctrl+Shift+Enter` undock.

## Install

| System | Command |
| ------ | ------- |
| Windows | `winget install RicardoFrantz.pdf-next` |
| macOS | `brew install --cask ricardofrantz/tap/pdf-next` |
| Debian, Ubuntu | add the repository below, then `sudo apt install pdf-next` |

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://ricardofrantz.github.io/pdf-next/pdf-next.asc \
  | sudo tee /etc/apt/keyrings/pdf-next.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/pdf-next.asc] https://ricardofrantz.github.io/pdf-next stable main" \
  | sudo tee /etc/apt/sources.list.d/pdf-next.list > /dev/null
sudo apt update && sudo apt install pdf-next
```

Or take the file itself from [Releases](https://github.com/ricardofrantz/pdf-next/releases):
`.exe` or `.msi` for Windows, a universal `.dmg` for macOS, `.deb`, `.rpm` or `.AppImage`
(`chmod +x` and run) for Linux.

The builds are not code signed yet, so Windows SmartScreen warns once — *More info → Run
anyway* — and macOS quarantines the app and refuses its first launch, whether it came from
Homebrew or the `.dmg`. Let that copy through once:

```bash
xattr -dr com.apple.quarantine /Applications/pdf-next.app
```

Signing, and how each of these channels is published, are described in
[docs/distribution.md](./docs/distribution.md); what the app does with the network, in
[PRIVACY.md](./PRIVACY.md).

Then open a file by double-clicking it, dragging it onto the window, pressing `Ctrl+O`, or
passing a path:

```bash
pdf-next paper.pdf
```

### Command line

```bash
pdf-next paper.pdf --night --left        # dark pages, filling the left half
pdf-next figure.png --invert             # inverted, for a white-background plot
pdf-next thesis.pdf --sepia --poll 3     # warm paper, check for rebuilds every 3s
pdf-next NOTES.md --sepia                # markdown as warm paper, reloading as you write
pdf-next paper.pdf supp.pdf fig1.png     # three tabs, the first one showing
pdf-next paper.pdf --page 12             # open at page 12
pdf-next paper.pdf --find "Figure 3"     # open at the first match, highlighted
pdf-next 'paper.pdf#page=7&search=wake'  # the same, written as a link
```

| Flag | Effect |
| ---- | ------ |
| `--left` | Dock to the left half of the screen (implies fit-width). |
| `--right` | Dock to the right half (implies fit-width). |
| `--top` / `--bottom` | Dock to the top or bottom half (implies fit-width). |
| `--night` / `--dark` | Dark pages, light text. |
| `--sepia` / `--reader` | Warm paper. |
| `--invert` | Invert the page, for scans and white-background figures. |
| `--plain` / `--light` | Original page colors. |
| `--mode <name>` | Same as the above, by name. |
| `--page <n>` | Open at that page. |
| `--find <text>` | Open at the first match, highlighted. |
| `--dest <name>` | Open at a named destination. |
| `--no-focus` | Hand the file over without raising the window. |
| `--poll <seconds>` | Watch interval; `0` turns watching off. |
| `--wait` | Stay attached to the terminal until the window closes (macOS and Linux — see below). |
| `--help`, `--version` | Print and exit. |

Appearance flags style that window only — they do not change your saved default.

Run it again with another file while it is open and the file joins the running window as
a new tab — the second command returns at once instead of opening a second viewer.

### From scripts and agents

pdf-next behaves like a command-line tool, so a script — or a coding agent — can call it
without guessing:

```bash
pdf-next report.pdf            # prints "opened /abs/path/report.pdf" and returns at once
pdf-next --help                # usage, exit 0
pdf-next missing.pdf           # "pdf-next: no such file: missing.pdf", exit 1
pdf-next --bogus               # "unknown flag --bogus (try --help)", exit 2
```

**Pointing at a place in a document.** `--page 12`, `--find "Figure 3"` and `--dest intro`
say where to land; the same thing can be written on the path as a fragment, in the form PDF
links have always used — `paper.pdf#page=7`, `#nameddest=results`, `#search=Figure%203`,
joined with `&`. Quote it: a shell reads `#` as the start of a comment. The `opened` line
prints the fragment that was understood, so a caller can check rather than assume:

```bash
pdf-next 'paper.pdf#page=7&search=wake' --no-focus
# opened /abs/path/paper.pdf#page=7&search=wake
```

A page past the end lands on the last page and says so. A `--find` with no match leaves the
document where it was, with the find bar showing the query and no results. The three flags
speak about the file named before them, or about the first file when they come first, so
several documents can be aimed at in one command.

If the file is already open in a tab, it is aimed rather than opened a second time — a
running window jumps to the page you asked for. `--no-focus` hands the file over without
raising the window, which is what you want when a script opens six figures in a row.

Exit status is `0` when the file was launched or handed to the running window, `1` for a
file that does not exist or is not a kind pdf-next can show, `2` for a command line it
could not understand. Relative paths
resolve against the caller's directory, including when they are forwarded to a running
instance. On macOS and Linux the launched process detaches by default (own process group,
so a shell tool's timeout cannot take the window down); pass `--wait` to hold the terminal,
as a compile loop might want. On Windows a GUI executable never holds the console.

macOS: a `.app` is not on your `PATH`. Either use the standard idiom — `open -a pdf-next
report.pdf` — which delivers the file to the app (or the running window) the way Finder does,
or make a one-line shim once:

```bash
printf '#!/bin/sh\nexec /Applications/pdf-next.app/Contents/MacOS/pdf-next "$@"\n' \
  > /usr/local/bin/pdf-next && chmod +x /usr/local/bin/pdf-next
```

Then `which pdf-next`, `pdf-next --help` and `pdf-next report.pdf` all work as above. If your
agent has a project instructions file, one line — *"open PDFs with `pdf-next <file>`; use
`open -a pdf-next` on macOS if the shim is missing"* — saves it rediscovering this each time.

## Security

The threat model is the obvious one: you open a PDF someone sent you, and the attacker controls
every byte of it.

- **The window cannot navigate away from the app.** A link annotation in a malicious PDF used to
  be able to replace the entire viewer with an attacker-controlled page — in a window with no
  address bar — and a link pointing back at the asset protocol would be served as HTML at a
  *local* origin, which Tauri trusts with IPC. A navigation guard now rejects anything that is
  not the app's own origin, and external links in documents are inert (internal ones, like a
  table of contents, still work).
- **The webview can read exactly the files you opened.** Document bytes are served by a
  purpose-built `doc://` protocol whose handler checks every request against the set of files
  you opened this session — an allowlist in our own Rust code, populated only by the open
  path. Even injected script has no reach beyond that.
- **Markdown is sanitized before it exists as HTML.** A `.md` is parsed and scrubbed by
  ammonia on the Rust side; scripts, event handlers and `javascript:` URLs never cross into
  the window, images are stripped so a file cannot probe your disk, and the CSP forbids
  inline script besides.
- **One network host, on request only.** The CSP names `api.github.com` and nothing else, so
  the update check can ask for the latest release when you press the button — and an injected
  script has nowhere else to talk to. The download itself is opened in your browser through a
  Rust command that accepts only URLs under this project's Releases; the webview cannot ask
  the OS to open anything else.
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

What remains scales with the document, not with the number of reloads. The ~10 MB-per-reload
growth that used to point at the webview caching each cache-busted URL is gone: documents are
served from a purpose-built `doc://` protocol with `Cache-Control: no-store`, so no revision
ever enters the HTTP cache, and the asset protocol has been dropped entirely. On top of that,
hiding the window now also releases the PDF.js font and image caches (they rebuild lazily when
you come back), and a background tab holds neither a decoded image nor a rendered markdown DOM.

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
