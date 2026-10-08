# Threat model: pdf-next

## What this project does and where untrusted input enters
pdf-next is a desktop viewer for PDF, image and Markdown files, built with Tauri 2. It
reloads a file when it changes on disk, for LaTeX and Typst work. It has two halves:
- A Rust backend (`src-tauri/src/`): file access, file watching, the `doc:` protocol that
  serves document bytes to the webview, Markdown rendering (pulldown-cmark, then
  ammonia), PDF reduction (picamatl), review notes stored in `_review.json` sidecars,
  and SyncTeX lookups (`review_source.rs`).
- A webview frontend (`src/`): our code in `app.mjs`, `pdf-rendering.mjs`,
  `review-*.mjs`, and a vendored copy of Mozilla PDF.js in `src/vendor/`.

Untrusted input:
- Every file the user opens: PDF, PNG/JPEG and other images, Markdown, and the
  `_review.json` and `.synctex(.gz)` files next to it. Assume a hostile file was
  downloaded or arrived in a cloned repository.
- The folder the file sits in. Other files there (including a planted `synctex`
  program) are hostile too.
- The webview itself, once a hostile file is open. Treat every Tauri command call from
  the webview as untrusted. The commands are listed in `generate_handler!` in
  `src-tauri/src/main.rs`.
- Responses from `https://api.github.com` (the update check), which the CSP allows.

Trusted: command-line arguments and files the user picks in the open dialog (the
choice, not the content), and the user's `PATH`.

## Components that matter most / least
- Most: the IPC boundary. Every `#[tauri::command]` in `main.rs`, especially
  `open_link` (web and mail links only), `open_download` (project releases only),
  `read_markdown`, `read_json`, `siblings`, the review commands (`append_review`,
  `update_review`, `patch_review`, `delete_review`, `review_source_hint`), and
  `reduce_pdf`. The "allowed" set in `Watched` (only files the user opened may be read)
  and `serve_document` for the `doc:` protocol. Markdown sanitizing with ammonia.
  `navigation_guard`, which keeps a link in a PDF from replacing the viewer page.
  `find_synctex`, which must never run a program from the document's own folder.
  The CSP in `src-tauri/tauri.conf.json` and the capability file
  `src-tauri/capabilities/default.json`.
- In scope: our frontend code in `src/*.mjs` (DOM writes, review labels), image and
  large-figure handling, the file watcher.
- PDF.js itself: a PDF.js bug counts when it is reachable with the version and options
  we ship and it gets out of the PDF.js sandbox, for example script running in the
  webview. We forward such reports to Mozilla. Crashes or slow rendering inside
  PDF.js alone are out of scope.
- Out of scope: `winget/`, release and apt packaging workflows, `tools/` scripts,
  `docs/`, Windows- and macOS-only code paths unless the bug also affects Linux.

## How to exercise it
- `cd src-tauri && cargo test` runs the Rust tests.
- `node tools/check_frontend.mjs` runs the frontend source checks.
- `xvfb-run -a node tools/smoke.mjs` opens every file in `tests/fixtures/` (PDFs
  including JBIG2 and JPEG 2000, PNGs, Markdown) in the built release binary
  `src-tauri/target/release/pdf-next`, and checks that it renders.
- Open a file by hand: `xvfb-run -a src-tauri/target/release/pdf-next <file>`.
  `tests/make_fixtures.py` shows how the fixtures are made.

## How we rate severity
- Critical: a file (PDF, image, Markdown or sidecar) that runs a program or code on the
  machine, or reads or writes a file the user did not open, with no user action beyond
  opening the file.
- High: script running in the webview from a file (CSP bypass, Markdown sanitizer
  bypass, DOM injection); a Tauri command that a compromised webview can use to read,
  list, write or delete files outside the allowed set, or to open a URL or scheme that
  the command should refuse; running a `synctex` planted next to the document.
- Medium: the same as High but needing a further click on something the user would not
  expect to be dangerous; leaking a local path or file content to the network; a
  crafted `_review.json` that corrupts other review data.
- Low: a file that crashes or freezes the viewer; very high memory use from one file;
  spoofed UI inside the window.

## Anything to leave alone
- Slow rendering of a valid but large PDF or image.
- Bugs that need a hostile `PATH` or hostile command-line arguments.
- Known PDF.js upstream issues already fixed in a newer PDF.js release: report them as
  "update PDF.js", one report for all of them.
