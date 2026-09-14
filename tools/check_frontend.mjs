// Source contracts for the things that are easy to break silently and
// expensive to notice: the real worker, streaming, the canvas budget, the
// one-second poll, and the mid-build gap behaviour.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { findNormalizedSpan, reviewLabel } from '../src/review-label.mjs';
import { mapCollapsedIndex, reconcilePendingComment } from '../src/review-sync.mjs';
import {
  REVIEW_SIZE_DEFAULT,
  REVIEW_SIZE_STEPS,
  nearestReviewSize,
  nextReviewSize,
} from '../src/review-size.mjs';

const app = await readFile('src/app.mjs', 'utf8');
const main = await readFile('src-tauri/src/main.rs', 'utf8');
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const styles = await readFile('src/style.css', 'utf8');
const version = await readFile('src/vendor/PDFJS_VERSION', 'utf8');
const readme = await readFile('README.md', 'utf8');
const page = await readFile('src/index.html', 'utf8');
const smoke = await readFile('src/smoke.mjs', 'utf8');
const nsisTemplate = await readFile('src-tauri/windows/installer.nsi', 'utf8');

// PDF.js must parse in a real worker thread.
assert.match(
  app,
  /GlobalWorkerOptions\.workerSrc = '\.\/vendor\/pdfjs\/build\/pdf\.worker\.min\.mjs'/,
  'PDF.js must point at the vendored worker bundle.',
);
assert.doesNotMatch(
  app,
  /globalThis\.pdfjsWorker\s*=/,
  'Assigning globalThis.pdfjsWorker makes PDF.js parse on the UI thread.',
);

// Memory. These are the ones that compound: the app reloads the document on
// every rebuild, potentially hundreds of times per session.
assert.match(
  app,
  /const MAX_CANVAS_PIXELS = [\d_]+;[\s\S]*?maxCanvasPixels: MAX_CANVAS_PIXELS/,
  'The canvas budget must be capped; it dominates resident memory.',
);
assert.match(
  app,
  /const pdfWorker = new PDFWorker\(\);[\s\S]*?worker: pdfWorker,/,
  'One shared worker: getDocument would otherwise spawn a thread per reload.',
);
assert.match(
  app,
  /async function releaseDocument\(\)[\s\S]*?await task\.destroy\(\)/,
  'The previous document must be destroyed, not just dereferenced (~77 MB/reload).',
);
assert.match(
  app,
  /class TidyViewer extends PDFViewer \{[\s\S]*?pageView\.destroy\(\)/,
  'Page views must free their canvases on reset; PDF.js only drops the references.',
);
assert.match(
  app,
  /document\.visibilityState === 'hidden'[\s\S]*?state\.pendingRevision = revision/,
  'Reloads must be deferred while the window is hidden.',
);
assert.match(
  await readFile('src/vendor/pdfjs/web/pdf_viewer.mjs', 'utf8'),
  /const DEFAULT_CACHE_SIZE = 3;/,
  'Vendored PDF.js keeps 10 rendered pages by default; pdf-next pins it to 3.',
);

// Page colors carry over from vscode-pdf Next, where they were tuned.
assert.match(
  app,
  /night: \{ background: '#1b1b1b', foreground: '#d6d1c4' \}/,
  'Night mode page colors must stay as tuned.',
);
assert.match(
  app,
  /sepia: \{ background: '#f4ecd8', foreground: '#5b4636' \}/,
  'Sepia mode page colors must stay as tuned.',
);
assert.match(
  app,
  /const MODE_CYCLE = \[null, 'night', 'invert', 'sepia'\];/,
  'Plain pages are a stop on the cycle, so white is always one press away.',
);
// Page colors live in the canvas pixels, so a color change is only visible
// once the canvas is drawn again. refresh() is not that: it goes through
// PDFPageView.update(), which resets with keepCanvasWrapper and never calls
// _resetCanvas(), leaving the old bitmap. That showed up as a white page with
// brown text on the way out of sepia.
assert.match(
  app,
  /function applyPageColors\(\)[\s\S]*?pageView\.reset\(\);[\s\S]*?pdfViewer\.update\(\)/,
  'A page-color change must drop each page canvas, or the previous colors stay.',
);

// Inverting the whole page also inverts the text layer and its highlights.
assert.match(
  styles,
  /body\.mode-invert \.pdfViewer \.page \.canvasWrapper \{[^}]*filter: invert\(1\)/s,
  'Invert must be scoped to the canvas so find highlights keep their color.',
);

// The watcher: one second, and a missing file is a state, not a failure.
assert.match(
  main,
  /static POLL_SECONDS: AtomicU64 = AtomicU64::new\(1\)/,
  'Watching must be on by default, at one second.',
);
assert.match(
  main,
  /if missing \{\s*continue;[\s\S]*?state\.missing = true;[\s\S]*?kind: "missing"/,
  'A vanished file must report once and keep the last render on screen.',
);
assert.match(
  main,
  /let reappeared = missing;[\s\S]*?if changed \|\| reappeared/,
  'A file that reappears after a build must trigger a reload.',
);

// Window fitting happens on a fresh open only; refitting on every rebuild would
// make the window jump while you work.
assert.match(
  app,
  /if \(view\) \{[\s\S]*?\} else \{[\s\S]*?await trimWindowToContent\(\{ recenter: true \}\)/,
  'The window may only be trimmed when opening a file, not when reloading it.',
);
assert.match(
  app,
  /pdfViewer\.currentScaleValue = '1';[\s\S]*?await trimWindowToContent/,
  'A fresh PDF open is 100%, then the window hugs that page — not page-fit into a large window.',
);
assert.match(
  app,
  /function pageBoxReady\(\)[\s\S]*?Math\.abs\(scale - 1\)/,
  'Trim must wait for 100% layout, not a leftover page-fit box.',
);
assert.match(
  main,
  /if window\.is_maximized\(\)\.unwrap_or\(false\) \{\s*let _ = window\.unmaximize\(\);/,
  'A maximized window must come off maximize or set_size cannot trim it.',
);
assert.match(
  main,
  /fn is_complete\(path: &Path\) -> bool \{[\s\S]*?File::open\(path\)[\s\S]*?b"%%EOF"/,
  'A file must be complete before a reload; a half-written PDF must not be shown.',
);
assert.match(
  main,
  /if \(changed \|\| reappeared\) && !is_complete\(&path\)/,
  'The watcher must skip ticks where the file is still being written.',
);
assert.match(
  main,
  /fn set_poll_seconds\(seconds: u64\)[\s\S]*?POLL_SECONDS\.store/,
  'The poll cadence must be settable, including 0 for off.',
);
assert.match(
  main,
  /fn watch_review_sidecar\([\s\S]*?"reviews-changed"/,
  'A sidecar change must emit reviews-changed, not file-changed.',
);
assert.match(
  main,
  /fn document_watch_due\(poll_seconds: u64, since_last: Duration\) -> bool \{\s*poll_seconds != 0/,
  'Document poll at 0 must not be required for sidecar watching.',
);
assert.match(
  main,
  /watch_review_sidecar\([\s\S]*?if !document_watch_due/,
  'The sidecar must be stated before the document-poll gate.',
);
assert.match(
  main,
  /fn sidecar_ready\(path: &Path\)[\s\S]*?parse_store/,
  'A half-written sidecar must wait for the next tick.',
);
assert.match(
  main,
  /fn note_sidecar_written\([\s\S]*?state\.sidecar_modified/,
  'A save from the app must not look like an incoming sidecar edit.',
);
assert.match(
  app,
  /showImage\(file, !view && !keepWindow, view\)/,
  'Images must refit only on a fresh open — not on reload, not on a tab switch, and not when stepping through a folder.',
);
assert.match(
  app,
  /async function stepSibling\(delta\)[\s\S]*?openFile\(file, \{ keepWindow: true \}\)/,
  'Walking a folder must not resize the window on every arrow press.',
);
assert.match(
  app,
  /async function dockTo\(edge\)[\s\S]*?if \(!undocking\) \{\s*pdfViewer\.currentScaleValue = 'page-width'/,
  'Docking to any edge must fit the width; undocking trims to the page at 100%.',
);
assert.match(
  app,
  /async function dockTo\(edge\)[\s\S]*?await trimWindowToContent\(\{ recenter: true \}\)/,
  'Undocking must trim the window to the document.',
);
assert.match(
  main,
  /fn fit_window\([\s\S]*?width\.is_finite\(\) && height\.is_finite\(\) && width > 80\.0 && height > 80\.0/,
  'A bogus measurement must never be turned into a window size.',
);

// Wrapping the window around the content. The failure mode here is not a wrong
// size, it is an infinite one: the window resizes, a preset scale recomputes,
// the scale change refits the window, forever.
assert.match(
  app,
  /function pinScale\(\)[\s\S]*?const scale = pdfViewer\.currentScale;\s*pdfViewer\.currentScaleValue = String\(scale\)/,
  'Turning wrap on must pin the scale to a number; a preset would resize forever.',
);
assert.match(
  app,
  /if \(state\.wrap && \(value === 'auto' \|\| value === 'page-fit' \|\| value === 'page-width'\)\) \{\s*setWrap\(false\)/,
  'Choosing a fit preset must turn wrap off — the two are opposite instructions.',
);
assert.match(
  app,
  /async function dockTo\(edge\)[\s\S]*?if \(state\.wrap\) \{[\s\S]*?setWrap\(false\)/,
  'Docking sets an explicit size; wrap must let go of the window first.',
);
assert.match(
  app,
  /function chromeHeight\(\)\s*\{\s*const measured = window\.innerHeight - ui\.stage\.clientHeight/,
  'Chrome height must be measured: the tab strip changes it, --bar-height does not.',
);
assert.match(
  app,
  /function contentSize\(\)[\s\S]*?Math\.ceil\(ui\.imageBox\.offsetWidth\)/,
  'The fit must measure the rendered element, ceiled — a fractional size raises a scrollbar.',
);
assert.match(
  styles,
  /body\.wrap-on #imageStage(?:,\s*body\.hug #imageStage)? \{[^}]*padding: 0/s,
  'An exact fit means no padding: the window frame is the edge of the picture.',
);
assert.match(
  main,
  /fn fit_window\([\s\S]*?exact: bool,[\s\S]*?if !exact \{[\s\S]*?inner_height\.min\(inner_width \/ aspect\)/,
  'Aspect is preserved only on the open-time fit; a wrap clamps each axis alone.',
);

// Tabs hold paths. A tab that held a document would cost ~60 MB of resident
// memory each, which is the opposite of the point of this app.
assert.match(
  app,
  /tabs: \[\],\s*active: -1,\s*views: new Map\(\)/,
  'Tab state is paths and view offsets; the document lives once, in state.document.',
);
assert.doesNotMatch(
  app,
  /tabs\[[^\]]*\]\.(document|task)\b|(document|task): (state\.document|state\.task)/,
  'No tab may retain a PDF document or loading task.',
);
assert.match(
  app,
  /async function activateTab\([\s\S]*?await openFile\(file, \{\s*keepWindow: true,\s*view: state\.views\.get\(tab\.path\) \|\| null,/,
  'Switching tabs reloads through openFile, restoring the view it was left at.',
);
assert.match(
  app,
  /async function stepSibling\(delta\)[\s\S]*?tab\.path = file\.path/,
  'Walking a folder must replace what the tab shows, not open a tab per file.',
);

// Security. An untrusted PDF is the threat model: the attacker controls the
// file, and the app reloads it from disk every second.
const csp = config.app?.security?.csp ?? '';
assert.doesNotMatch(csp, /unsafe-eval/, 'CSP must not allow eval.');
assert.match(csp, /worker-src 'self' blob:/, 'CSP must allow the PDF.js worker.');
assert.match(csp, /object-src 'none'/, 'CSP must forbid plugins.');
assert.match(csp, /base-uri 'none'/, 'CSP must forbid base-tag hijacking.');

// Document bytes travel over the doc protocol, not the asset protocol. The
// no-store header is what stops the webview cache growing ~10 MB per reload,
// and the allowlist in our own handler is the whole filesystem boundary.
assert.equal(
  config.app?.security?.assetProtocol,
  undefined,
  'The asset protocol is gone; the doc protocol replaced it.',
);
const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
assert.doesNotMatch(
  cargo,
  /protocol-asset/,
  'The protocol-asset feature must stay off; the doc protocol serves the bytes.',
);
assert.match(csp, /img-src[^;]*http:\/\/doc\.localhost/, 'CSP must allow doc images.');
assert.match(csp, /connect-src[^;]*http:\/\/doc\.localhost/, 'CSP must allow doc fetches.');
assert.match(
  main,
  /register_uri_scheme_protocol\("doc"/,
  'The doc protocol must be registered.',
);
assert.match(
  main,
  /fn serve_document\([\s\S]*?state\.allowed\.contains\(&canonical\)[\s\S]*?"Cache-Control", "no-store"/,
  'Every served document must pass the allowlist and carry no-store.',
);
assert.match(
  main,
  /fn adopt\([\s\S]*?state\.allowed\.insert\(canonical\.clone\(\)\)/,
  'Opening a file is what grants the webview permission to read exactly it.',
);
assert.match(
  app,
  /convertFileSrc\(file\.path, 'doc'\)/,
  'Document URLs must go through the doc protocol.',
);
assert.match(
  app,
  /visibilityState === 'hidden'[\s\S]*?state\.document\?\.cleanup\(\)/,
  'A hidden window must drop the PDF.js font and image caches.',
);

// Markdown crosses the IPC boundary as HTML, so it must be sanitized before
// it leaves Rust, and images must not widen file access.
assert.match(
  main,
  /fn render_markdown\([\s\S]*?builder\.rm_tags\(\["img"\]\)[\s\S]*?builder\.clean\(/,
  'Markdown must be sanitized by ammonia with images stripped.',
);
assert.match(
  main,
  /fn read_markdown\([\s\S]*?state\.allowed\.contains\(&canonical\)/,
  'read_markdown must serve only files the reader has opened.',
);
assert.match(
  main,
  /fn navigation_guard\(\)[\s\S]*?"tauri" => host == Some\("localhost"\)/,
  'The webview must not be able to navigate away from the app origin.',
);
assert.match(
  app,
  /linkService\.externalLinkEnabled = false/,
  'External links in an untrusted PDF must be inert.',
);
assert.match(
  app,
  /if \(launch\?\.mode\)[\s\S]*?setMode\(requested, false\)/,
  'A command-line appearance flag must not overwrite the saved preference.',
);
const capabilities = JSON.parse(
  await readFile('src-tauri/capabilities/default.json', 'utf8'),
);
assert.deepEqual(
  capabilities.permissions,
  ['core:event:allow-listen', 'core:event:allow-unlisten'],
  'The webview needs events and nothing else; every other permission is reachable by injected script.',
);

// The command line is a contract for programs, not just people: it answers
// --help, exits non-zero on mistakes, prints what it opened, hands a second
// launch to the running window, and on macOS hears files opened from Finder.
assert.match(
  main,
  /"-h" \| "--help" => return Ok\(Cli::Help\)[\s\S]*?"-V" \| "--version" => return Ok\(Cli::Version\)/,
  '--help and --version must be answered, never treated as file names.',
);
assert.match(
  main,
  /if !candidate\.is_file\(\) \{\s*return Err\(\(1, format!\("no such file: \{name\}"\)\)\);/,
  'A missing file must fail with exit status 1, not open an empty window.',
);
// Opening a document at a page or a match is what makes this usable from a
// script: the flags, the link form of the same thing, and the printed line
// that says which was understood.
assert.match(
  main,
  /"--page" => match arguments[\s\S]*?"--find" \| "--search" =>[\s\S]*?"--dest" \| "--nameddest" =>/,
  '--page, --find and --dest must all be accepted.',
);
assert.match(
  main,
  /"page" => target\.page[\s\S]*?"nameddest" \| "dest"[\s\S]*?"search" \| "find"/,
  'A path fragment must be read with the field names PDF links use.',
);
assert.match(
  main,
  /if focus \{\s*if let Some\(window\) = app\.get_webview_window\("main"\)/,
  '--no-focus must be able to hand a file over without raising the window.',
);
assert.match(
  app,
  /async function applyTarget\(target\)[\s\S]*?pdfViewer\.currentPageNumber = landed/,
  'A target must land on its page once the document is up.',
);
assert.match(
  app,
  /async function consumeTarget\(tab\) \{[\s\S]*?tab\.target = null;\s*await applyTarget\(target\);/,
  'A target fires once; afterwards the tab remembers its own view.',
);
assert.match(
  main,
  /"--line" => match arguments[\s\S]*?aimed_at\(&mut invocation\)\.line = Some\(line\)/,
  '--line must bind a 1-based source line the same way --page binds a page.',
);
assert.match(
  main,
  /"line" => target\.line = value\.parse\(\)\.ok\(\)\.filter\(\|line\| \*line >= 1\)/,
  'A path fragment must accept line=N for Markdown.',
);
assert.match(
  app,
  /const line = Number\.isFinite\(value\.line\) && value\.line >= 1 \? Math\.round\(value\.line\) : null/,
  'asTarget must keep a 1-based line so Markdown can be aimed.',
);
assert.match(
  app,
  /async function applyTarget\(target\)[\s\S]*?kind === 'markdown'[\s\S]*?mark\.aim[\s\S]*?\[data-line\][\s\S]*?scrollIntoView/,
  'A Markdown target must scroll to the source line and mark the first search match.',
);
assert.match(
  styles,
  /mark\.aim \{[\s\S]*?background: var\(--aim-highlight\)/,
  'The Markdown search mark must use the aim-highlight token.',
);
assert.match(
  main,
  /_ if text\.starts_with\('-'\) && text\.len\(\) > 1 => \{\s*return Err\(\(2,/,
  'An unknown flag must fail with exit status 2.',
);
assert.match(
  main,
  /Ok\(Cli::Help\) => \{[\s\S]*?return;[\s\S]*?Err\(\(status, message\)\) => \{[\s\S]*?std::process::exit\(status\);[\s\S]*?tauri::Builder::default\(\)/,
  'The command line must be answered before Tauri builds anything.',
);
assert.match(
  main,
  /println!\("opened \{\}\{separator\}\{fragment\}"/,
  'Each opened file must be printed on stdout, with the fragment that was understood, so a caller can verify.',
);
assert.match(
  main,
  /tauri::Builder::default\(\);[\s\S]{0,700}?\.plugin\(tauri_plugin_single_instance::init\(/,
  'single-instance must be the first plugin: a second launch forwards its files and exits.',
);
assert.match(
  main,
  /if !smoke_enabled\(\) \{[\s\S]{0,400}?tauri_plugin_single_instance::init\(/,
  'A smoke run must skip single-instance, or a second run exits 0 without opening anything.',
);
assert.doesNotMatch(
  main,
  /\.plugin\(navigation_guard\(\)\)[\s\S]*?tauri_plugin_single_instance::init\(/,
  'Nothing may be registered before single-instance.',
);
assert.match(
  main,
  /tauri::RunEvent::Opened \{ urls \}[\s\S]*?deliver\(app, files, true\)/,
  'macOS files arrive as an Opened event; without this arm a double-click opens nothing.',
);
assert.match(
  main,
  /fn detach\([\s\S]*?\.arg\("--wait"\)[\s\S]*?\.process_group\(0\)/,
  'The detached child must run with --wait, in its own process group.',
);
assert.match(
  main,
  /!invocation\.wait[\s\S]{0,200}?!cfg!\(debug_assertions\)[\s\S]{0,200}?!must_stay[\s\S]{0,200}?!smoke_enabled\(\)[\s\S]{0,200}?detach\(&arguments\)/,
  'Detach only in release, only without --wait, never when LaunchServices started us.',
);
assert.match(
  app,
  /const openFilesReady = listen\('open-files'[\s\S]*?await openFilesReady;\s*const pending = await invoke\('pending_files'\)/,
  'The open-files listener must be live before pending_files hands over to events.',
);
assert.match(
  readme,
  /## From scripts and agents/,
  'The README must tell a program how to call this.',
);

// 0.9.2's NSIS setup said "Unable to uninstall!" over 0.9.0: it looked up
// Software\<publisher>\pdf-next, 0.9.0 had written `frantz`, and `_?=` was
// empty. The bundled template must keep the fallback, and the config must
// point at it.
assert.equal(
  config.bundle.windows?.nsis?.template,
  'windows/installer.nsi',
  'The Windows NSIS bundle must use the patched installer template.',
);
assert.match(
  nsisTemplate,
  /Function ResolvePreviousInstallDir/,
  'The NSIS template must resolve the old install dir before calling uninstall.exe.',
);
assert.match(
  nsisTemplate,
  /Software\\frantz\\\$\{PRODUCTNAME\}/,
  'The fallback must still find a 0.9.0 install under Software\\frantz.',
);
assert.match(
  nsisTemplate,
  /\$4 == ""[\s\S]*Goto reinst_done/,
  'An empty install dir must overwrite, not run uninstall.exe with `_?=`.',
);
assert.match(
  nsisTemplate,
  /StrCpy \$PassiveMode 1/,
  'A double-click is passive: progress, then the app.',
);
assert.match(
  nsisTemplate,
  /CMDLINE "\/W"/,
  '/W must still open the old wizard.',
);
assert.match(
  nsisTemplate,
  /PassiveMode = 1[\s\S]*WixMode <> 1[\s\S]*Goto reinst_done/,
  'A passive upgrade must overwrite, not uninstall.',
);
assert.equal(
  config.bundle.windows?.nsis?.installMode,
  'currentUser',
  'The setup must not ask for Administrator.',
);

// Updates: the webview may talk to exactly one host, only when asked, and may
// open exactly one kind of URL, checked in Rust.
assert.doesNotMatch(
  csp,
  /https?:\/\/(?!ipc\.localhost|doc\.localhost|api\.github\.com)/,
  'The CSP must name no network host besides api.github.com for the update check.',
);
assert.match(
  main,
  /fn open_download\(url: String\)[\s\S]*?const RELEASES: &str = "https:\/\/github\.com\/ricardofrantz\/pdf-next\/releases\/";[\s\S]*?url\.starts_with\(RELEASES\)/,
  'open_download must refuse anything but a pdf-next release URL.',
);
assert.match(
  app,
  /ui\.update\.addEventListener\('click', \(\) => checkForUpdates\(\)\)/,
  'The update check runs on a press.',
);
assert.match(
  app,
  /window\.setTimeout\(\(\) => \{\s*void checkForUpdates\(\{ quiet: true \}\);\s*\}, \d+\);/,
  'One quiet check at launch, delayed past the first paint.',
);
assert.doesNotMatch(
  app,
  /setInterval\([\s\S]*?checkForUpdates/,
  'No polling for updates: one check at launch, then only on a press.',
);

// Printing: the system's own dialog, over a document laid out for paper.
assert.match(
  main,
  /ShowPrintUI\(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM\)/,
  "On Windows the dialog is the system's print window, not WebView2's in-page preview.",
);
assert.match(
  main,
  /Some\(Trouble::Refused\(message\)\) => Err\(/,
  'A dialog that refuses to open must be reported, never answered with the in-page preview.',
);
assert.match(
  app,
  /function setTitle\(name\)[\s\S]*?`pdf-next \$\{state\.version\}`[\s\S]*?invoke\('set_title', \{ title \}\)/,
  'The window title must carry the build — and be set on the window, since WebView2 never passes document.title to the frame.',
);
assert.match(
  main,
  /fn set_title\(title: String, window: tauri::Window\)[\s\S]*?window\.set_title\(&title\)/,
  'The window title is set from Rust, so the webview keeps its events-only permission list.',
);
assert.match(
  main,
  /fn printing_unavailable\(\)[\s\S]*?EnumPrintersW/,
  'ShowPrintUI succeeds and shows nothing when there is no print service, so ask the spooler first and say so.',
);
assert.match(
  styles,
  /\.sprite \{\s*\n\s*display: none/,
  'The icon sprite is hidden from the stylesheet: the CSP drops style attributes, and the dropped one laid the sprite out above the toolbar.',
);
assert.doesNotMatch(
  await readFile('src/index.html', 'utf8'),
  /style="/,
  'No style attributes in the markup — the CSP blocks them, silently.',
);
assert.ok(
  true,
);
assert.match(
  main,
  /#\[cfg\(not\(windows\)\)\]\s*fn open_print_dialog[\s\S]*?webview\.print\(\)/,
  "Elsewhere wry's own call is already the system dialog: a sheet on macOS, GTK on Linux.",
);
assert.match(
  app,
  /async function printDocument\(\)[\s\S]*?await invoke\('print_document'\)/,
  'The print button and Ctrl+P must ask Rust for the dialog.',
);
assert.match(
  app,
  /key === 'p'\) \{\s*event\.preventDefault\(\)/,
  "Ctrl+P must be taken from the webview, which would print the screen instead.",
);
assert.match(
  app,
  /intent: 'print'[\s\S]*?canvas\.width = 0;\s*canvas\.height = 0;/,
  'One scratch canvas for the whole document, released when the pages are made.',
);
assert.match(
  app,
  /context\.fillStyle = '#ffffff'/,
  'Printed pages are white: a page mode is a property of the screen.',
);
assert.match(
  app,
  /window\.addEventListener\('afterprint', finishPrint\)[\s\S]*?if \(printBlurred && state\.platform !== 'windows'\)/,
  "afterprint is the Windows signal; macOS and Linux never call window.print(), so the window coming back stands in for it there — but never on Windows, whose dialog is a separate window this one stays clickable behind.",
);
assert.match(
  app,
  /if \(!printPending\) \{\s*clearPrintPages\(\);\s*\}/,
  'A rebuild lands every second: opening a file must not empty the pages a dialog is holding.',
);
assert.match(
  styles,
  /@media print \{[\s\S]*?--md-fg: #000000 !important/,
  'The print palette must outrank body.mode-night, which is more specific than a bare id and would otherwise print pale text on white.',
);
assert.doesNotMatch(
  app,
  /await invoke\('print_document'\);\s*clearPrintPages\(\)/,
  'The dialog outlives the call on Windows and macOS: clearing here empties it.',
);
assert.match(
  styles,
  /@media print \{[\s\S]*?body > svg,[\s\S]*?#imageStage \{\s*\n\s*display: none !important/,
  'The on-screen viewer must never be what goes on paper — nor the icon sprite, which is laid out on paper however hidden it looks and pushes page one onto a second sheet.',
);

// Every decoder the worker asks for by name must be vendored next to it.
// The wasm modules are what render bitonal scans (CCITT and JBIG2 both go
// through jbig2.wasm) and JPEG 2000; a missing one draws the picture white,
// silently, and only on the files that use it.
const worker = await readFile('src/vendor/pdfjs/build/pdf.worker.min.mjs', 'utf8');
const wanted = new Set(
  worker.match(/"[\w-]+\.wasm"|\b[\w-]+_nowasm_fallback\.js\b/g)?.map((name) => name.replaceAll('"', '')),
);
assert.ok(wanted.has('jbig2.wasm'), 'The worker is expected to name jbig2.wasm.');
for (const name of wanted) {
  await assert.doesNotReject(
    access(`src/vendor/pdfjs/wasm/${name}`),
    `The worker loads ${name}; it must be vendored in src/vendor/pdfjs/wasm/.`,
  );
}
// And the worker must be told where they are in absolute terms: it fetches
// them itself, and a relative path resolves against its own folder.
assert.match(
  app,
  /function vendorUrl\(folder\) \{\s*return new URL\(`\.\/vendor\/pdfjs\/\$\{folder\}`, document\.baseURI\)\.href;/,
  'vendorUrl must build an absolute URL from the page, not the worker.',
);
for (const option of ['cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl']) {
  assert.match(
    app,
    new RegExp(`${option}: vendorUrl\\('[\\w]+/'\\)`),
    `getDocument's ${option} must go through vendorUrl; a relative path 404s inside the worker.`,
  );
}

// Markdown equations: TeX becomes MathML on the Rust side and goes through
// the same sanitizer as the rest of the document, never around it.
assert.match(main, /options\.insert\(Options::ENABLE_MATH\);/, 'Math must be enabled in pulldown-cmark.');
assert.match(
  main,
  /builder\.add_tags\(MATHML_TAGS\);[\s\S]*?builder\.attribute_filter\(keep_known_styles\);[\s\S]*?builder\.clean\(&rendered\)/,
  'MathML must be allowlisted in ammonia and cleaned with the document, not spliced in after.',
);
assert.match(
  main,
  /annotation: None|\.\.RenderConfig::default\(\)/,
  'No TeX annotation: the renderer writes it unescaped.',
);
const indexHtml = await readFile('src/index.html', 'utf8');
assert.match(
  indexHtml,
  /<link rel="stylesheet" href="\.\/vendor\/pulldown-latex\/styles\.css" \/>/,
  'The math stylesheet (font faces for Latin Modern) must be linked.',
);
for (const file of ['styles.css', 'font/latinmodern-math.woff2', 'font/lmroman12-regular.woff2']) {
  await assert.doesNotReject(access(`src/vendor/pulldown-latex/${file}`), `${file} must be vendored.`);
}

// Markdown links: nothing navigates the webview. Same-page links scroll, web
// links go to the system browser through a command that takes http(s) and
// mailto only, and relative links open as tabs.
assert.match(
  app,
  /if \(\/\^\(https\?:\|mailto:\)\/i\.test\(href\)\) \{[\s\S]*?invoke\('open_link', \{ url: href \}\)/,
  'Web links in markdown must go through open_link.',
);
assert.match(
  main,
  /fn open_link\(url: String\)[\s\S]*?starts_with\("http:\/\/"\)[\s\S]*?starts_with\("https:\/\/"\)[\s\S]*?starts_with\("mailto:"\)[\s\S]*?return Err/,
  'open_link must refuse every scheme but http, https and mailto.',
);
assert.match(app, /const target = siblingPath\(href\);\s*if \(target\) \{\s*void openPath\(target\);/, 'Relative markdown links open as tabs.');

// Smoke mode. Nothing here runs for a reader; it exists so a build server can
// tell a working viewer from a window that opens and draws nothing. Each part
// is easy to drop by accident and silent when dropped, which is the whole
// reason the 0.9.0 macOS build shipped.
assert.match(
  page,
  /<script type="module" src="\.\/smoke\.mjs"><\/script>\s*<script type="module" src="\.\/app\.mjs"><\/script>/,
  'smoke.mjs must load before app.mjs, or a failure inside app.mjs is never seen.',
);
assert.match(
  smoke,
  /addEventListener\('error'[\s\S]*?addEventListener\('unhandledrejection'/,
  'The failure buffer must catch both thrown errors and rejected promises.',
);
assert.match(
  app,
  /if \(launch\?\.smoke\) \{\s*void reportSmoke\(\);/,
  'The frontend must report its verdict when the launch says this is a smoke run.',
);
assert.match(
  app,
  /async function renderedPixels\(\)[\s\S]*?canvas\.width > 0 && canvas\.height > 0/,
  'A PDF counts as shown only when a page canvas has pixels; "no error" is not evidence.',
);
assert.match(
  main,
  /invoke_handler\(tauri::generate_handler!\[[\s\S]*?smoke_report[\s\S]*?\]\)/,
  'smoke_report must be registered, or the frontend can never answer.',
);
assert.match(
  main,
  /fn smoke_finish\([\s\S]*?-> ![\s\S]*?std::process::exit\(if ok \{ 0 \} else \{ 1 \}\)/,
  'The verdict must reach the shell as an exit status.',
);
assert.match(
  main,
  /if smoke_enabled\(\) \{[\s\S]{0,500}?smoke_finish\(false, &format!\("no report within/,
  'A frontend that never answers must still end the run; that is the blank-window case.',
);

assert.match(
  smoke,
  /boot stalled at \$\{progress\.at\}/,
  'A launch that hangs must name the step it hung in; every check in app.mjs runs after it.',
);
assert.match(
  app,
  /mark\('os_theme'\);\s*applyTheme\(await invoke\('os_theme'\)\)/,
  'The first call the boot waits on must be marked, or a hang there looks like a blank window.',
);

// A drop that brings no paths must say so. It is the one way into the app
// that can fail without raising anything, and silence reads as a dead app.
// The frontend waits for the Rust side, which looks on the pasteboard first.
assert.match(
  app,
  /listen\('drop-empty'[\s\S]*?setStatus\(/,
  'A drop the Rust side found nothing for must report itself; silence looks like a broken viewer.',
);
assert.match(
  main,
  /WindowEvent::DragDrop\(DragDropEvent::Drop \{ paths, \.\. \}\)[\s\S]*?paths\.is_empty\(\)/,
  'An empty drop must be caught in Rust, where the pasteboard can still be read.',
);
assert.match(
  main,
  /dropped_paths\(\)[\s\S]*?emit\("drop-empty"[\s\S]*?deliver\(&handle, files, true\)/,
  'A recovered path must be opened, and only a truly empty drop reported as one.',
);
assert.match(
  main,
  /NSPasteboardNameDrag/,
  'The recovery must read the drag pasteboard; the general one holds a different thing.',
);
assert.match(
  main,
  /fn a_file_url_on_the_drag_pasteboard_is_a_dropped_file/,
  'The recovery must be run, not only compiled: a drop is the one path no CI can perform.',
);
assert.match(
  main,
  /registerForDraggedTypes[\s\S]*NSPasteboardTypeFileURL/,
  'The webview must accept a file-URL drop; tao only registers the older filename type, so Finder otherwise never delivers the event.',
);
assert.match(
  main,
  /fn accept_file_url_drops/,
  'Register the current type on the webview, not the window: tao unwraps the older property list and would panic.',
);

// One selection record for Markdown and PDF. The Review panel lists them.
assert.match(
  app,
  /function describeSelection\(\)[\s\S]*?return \{ file, kind: 'markdown', at: atRange\(start, end, 'line'\), quote \}/,
  'describeSelection must return a review record, not a display string.',
);
assert.match(
  app,
  /function formatSelection\(record\)[\s\S]*?`\$\{record\.file\}:\$\{record\.at\.line\}\$\{end\}`[\s\S]*?`\$\{record\.file\} p\.\$\{record\.at\.page\}\$\{end\}`/,
  'The human locator must be derived from the record.',
);
assert.match(
  app,
  /invoke\('append_review', \{\s*document: state\.file\.path,\s*review,/,
  'A new review must append a record, not a markdown block.',
);
assert.match(
  app,
  /listen\('reviews-changed'[\s\S]*?reloadReviewsFromDisk\(\)/,
  'An external sidecar edit must refresh reviews without reloading the document.',
);
assert.match(
  app,
  /async function reloadReviewsFromDisk\(\) \{\s*await loadReviews\(\{ fromDisk: true \}\)/,
  'An agent write must load disk first, not flush a panel draft over it.',
);
assert.doesNotMatch(
  app,
  /async function reloadReviewsFromDisk\(\) \{[^}]*flushCommentSave/,
  'reloadReviewsFromDisk must not write the panel back to disk before reading.',
);
assert.match(
  app,
  /from '\.\/review-sync\.mjs'/,
  'Panel drafts vs agent writes share a reconcile helper.',
);
assert.match(
  app,
  /const COMMENT_SAVE_MS = 400/,
  'A panel comment must write the sidecar as you type.',
);
assert.match(
  app,
  /!typing &&\s*event\.key === 'Enter'[\s\S]*?reviewFromSelection\(\)[\s\S]*?openNoteBox\(\)/,
  'Enter on a selection must open the comment box.',
);
assert.match(
  app,
  /event\.target instanceof HTMLTextAreaElement/,
  'A comment textarea must count as typing, so Enter there is a newline.',
);
assert.doesNotMatch(
  app,
  /save\.textContent = 'Save'/,
  'Panel comments write themselves; there is no extra Save click.',
);
assert.match(page, /id="reviewPane"/, 'The Review panel lives on the right of the stage.');
assert.match(page, /id="reviewSizeDown"/, 'The Review panel has a smaller-text control.');
assert.match(page, /id="reviewSizeUp"/, 'The Review panel has a larger-text control.');
assert.match(
  app,
  /from '\.\/review-size\.mjs'/,
  'Review text size comes from the shared size helper.',
);
assert.match(
  styles,
  /#reviewList \{[\s\S]*?font-size: var\(--review-size/,
  'Review quotes and comments follow the pane size, not a hard-coded 12px.',
);
{
  assert.deepEqual(REVIEW_SIZE_STEPS, [10, 11, 12, 13, 15, 17, 20]);
  assert.equal(REVIEW_SIZE_DEFAULT, 12);
  assert.equal(nearestReviewSize(12), 12);
  assert.equal(nearestReviewSize(14), 13);
  assert.equal(nearestReviewSize(16), 15);
  assert.equal(nearestReviewSize(0), 12);
  assert.equal(nearestReviewSize('nope'), 12);
  assert.equal(nextReviewSize(12, 1), 13);
  assert.equal(nextReviewSize(12, -1), 11);
  assert.equal(nextReviewSize(10, -1), 10);
  assert.equal(nextReviewSize(20, 1), 20);
  assert.equal(nextReviewSize(11, 1), 12);
  assert.equal(nextReviewSize(17, 1), 20);
}
assert.match(page, /id="reviewChip"/, 'A chip after a short hold adds a review.');
assert.match(page, /id="copyPath"/, 'The toolbar copies the full path after zoom.');
assert.match(page, /id="copyName"/, 'The toolbar copies the file name after zoom.');
assert.match(page, /id="reduce"/, 'PDF toolbar can write a smaller name_reduced.pdf.');
assert.match(
  page,
  /id="ask"[\s\S]*?#i-ask[\s\S]*?id="note"[\s\S]*?#i-add-review[\s\S]*?id="notes"[\s\S]*?#i-review/,
  'Copy selection, add review, and review panel each have their own icon.',
);
assert.match(
  app,
  /invoke\('reduce_pdf'/,
  'Reduce size calls the Rust picamatl command.',
);
assert.match(
  app,
  /_reduced\.pdf|reduceOpenPdf/,
  'Reduce opens the written sibling when smaller.',
);
assert.match(
  styles,
  /body:not\(\.has-file\) \.file-only/,
  'Path and name copy stay hidden until a file is open.',
);
assert.match(
  styles,
  /#noteBox \{[\s\S]*?position: fixed;/,
  'The comment box sits on the selection, not pinned to the toolbar corner.',
);
assert.match(
  app,
  /function wrapPdfQuote\([\s\S]*?wrapQuoteFragments\(layer, quote, id/,
  'A quote that spans PDF.js nodes must still receive a tint.',
);
assert.match(
  app,
  /createElement\(asMark \? 'mark' : 'review-q'\)/,
  'PDF quotes wrap matched glyphs in <review-q>, not a textLayer span.',
);
assert.match(
  styles,
  /\.textLayer review-q/,
  'PDF quote wash targets <review-q>, which PDF.js does not absolutize.',
);
assert.deepEqual(
  findNormalizedSpan('hello world from page', 'hello world'),
  { start: 0, end: 11 },
);
assert.deepEqual(
  findNormalizedSpan('the start of a much longer quote lives here', 'start of a much longer quote'),
  { start: 4, end: 32 },
);
assert.equal(findNormalizedSpan('nope', 'missing phrase here'), null);
assert.equal(mapCollapsedIndex('hello', 2), 2);
assert.equal(mapCollapsedIndex('a  b', 1), 1);
assert.equal(mapCollapsedIndex('a  b', 2), 3);
{
  const saved = [{ id: 'r1', comment: 'old' }, { id: 'r2', comment: 'keep' }];
  const draft = { id: 'r1', comment: 'typing' };
  assert.equal(
    reconcilePendingComment(draft, [{ id: 'r2', comment: 'keep' }], saved).keepDraftId,
    null,
    'Agent delete of the draft id drops the draft.',
  );
  assert.equal(
    reconcilePendingComment(
      draft,
      [
        { id: 'r1', comment: 'agent fix' },
        { id: 'r2', comment: 'keep' },
      ],
      saved,
    ).keepDraftId,
    null,
    'Agent edit of that comment drops the draft.',
  );
  assert.equal(
    reconcilePendingComment(
      draft,
      [
        { id: 'r1', comment: 'old' },
        { id: 'r2', comment: 'agent other' },
      ],
      saved,
    ).keepDraftId,
    'r1',
    'Agent edit of another id keeps the in-progress comment.',
  );
}
assert.match(page, /id="reviewMenu"/, 'Right-click on a selection adds a review.');
assert.match(
  app,
  /const REVIEW_CHIP_MS = 500/,
  'The add-review chip waits half a second after the selection settles.',
);
assert.match(
  app,
  /function reviewTint\(id\)[\s\S]*?REVIEW_TINTS/,
  'Review marks cycle a fixed set of tints from the record id.',
);
assert.match(
  app,
  /PDF\.js styles[\s\S]*?position:absolute[\s\S]*?nested span/,
  'PDF quote wash must not nest a span inside the textLayer.',
);
{
  const wrap = app.match(/function wrapQuoteFragments\([\s\S]*?\nfunction wrapPdfQuote/)?.[0] || '';
  assert.ok(wrap, 'wrapQuoteFragments must sit next to wrapPdfQuote.');
  assert.doesNotMatch(
    wrap,
    /createElement\('span'\)/,
    'A nested textLayer span becomes position:absolute and washes the whole line.',
  );
  assert.doesNotMatch(
    wrap,
    /createElement\('mark'\)/,
    'Wrapping PDF.js text in bare createElement(mark) is only for markdown via asMark.',
  );
  assert.match(wrap, /'review-q'/, 'PDF path creates <review-q>.');
}
assert.match(
  app,
  /function wrapQuoteIn\([\s\S]*?asMark: true/,
  'Markdown quotes wrap the matched words.',
);
assert.match(
  styles,
  /\[data-review-tint='1'\][\s\S]*?\[data-review-tint='6'\]/,
  'Six review tints, cycled onto the mark and the panel row.',
);
assert.match(
  app,
  /from '\.\/review-label\.mjs'/,
  'Review numbers come from the shared label helper.',
);
assert.match(styles, /\.review-no/, 'Each highlighted block carries its 1.1 number.');
{
  const pages = [
    { id: 'r1', at: { page: 1 } },
    { id: 'r2', at: { page: 1 } },
    { id: 'r3', at: { page: 1 } },
    { id: 'r4', at: { page: 2 } },
    { id: 'r5', at: { page: 2 } },
  ];
  assert.equal(reviewLabel(pages[0], pages), '1.1');
  assert.equal(reviewLabel(pages[1], pages), '1.2');
  assert.equal(reviewLabel(pages[2], pages), '1.3');
  assert.equal(reviewLabel(pages[3], pages), '2.1');
  assert.equal(reviewLabel(pages[4], pages), '2.2');
  const afterDelete = pages.filter((review) => review.id !== 'r2');
  assert.equal(reviewLabel(afterDelete[1], afterDelete), '1.2');
  const md = [
    { id: 'r1', at: { line: 12 } },
    { id: 'r2', at: { line: 12 } },
    { id: 'r3', at: { line: 40 } },
  ];
  assert.equal(reviewLabel(md[0], md), '1.1');
  assert.equal(reviewLabel(md[1], md), '1.2');
  assert.equal(reviewLabel(md[2], md), '2.1');
}
assert.match(
  app,
  /const REVIEW_PANE_WIDTH = 280/,
  'Opening the Review panel must know how much width to grow.',
);
assert.match(
  styles,
  /body:not\(\.kind-pdf\):not\(\.kind-markdown\) \.review-only/,
  'Ask and Review stay hidden until a PDF or Markdown file is open.',
);
assert.match(
  JSON.stringify(config.app.windows[0]),
  /"width":880/,
  'The empty window must be wide enough for the toolbar.',
);
assert.match(
  JSON.stringify(config.app.windows[0]),
  /"height":520/,
  'The empty window must be tall enough to read the drop target.',
);
assert.doesNotMatch(app, /append_note/, 'append_note is gone.');
assert.doesNotMatch(app, /\.notes\.md/, 'The per-stem notes sidecar is gone.');
assert.match(
  main,
  /fn open_review_document\([\s\S]*?if !allowed\.contains\(&doc_path\)/,
  'Review writes must refuse a document that is not in the open set.',
);
assert.match(
  main,
  /const REVIEW_SUFFIX: &str = "_review\.json"/,
  'The sidecar is {stem}_review.json next to the document.',
);
assert.match(
  main,
  /fn review_sidecar\(doc: &Path\)[\s\S]*?format!\("\{stem\}\{REVIEW_SUFFIX\}"\)/,
  'paper.pdf must own paper_review.json.',
);
assert.match(
  readme,
  /paper_review\.json/,
  'The README must name the per-file sidecar.',
);
assert.doesNotMatch(
  readme,
  /\.notes\.md/,
  'The README must not still describe <stem>.notes.md.',
);

// The fixtures the smoke test opens, one per kind the viewer claims to show.
for (const fixture of [
  'tests/fixtures/hello.pdf',
  'tests/fixtures/three-pages.pdf',
  'tests/fixtures/swatch.png',
  'tests/fixtures/notes.md',
]) {
  await access(fixture);
}

// The README must name the runtime it actually ships.
const vendored = version.match(/Version:\s*(\S+)/)?.[1];
assert.ok(vendored, 'src/vendor/PDFJS_VERSION must record a version.');
assert.ok(
  readme.includes(vendored),
  `README.md must mention the vendored PDF.js version (${vendored}).`,
);

console.log(`Frontend contracts passed (PDF.js ${vendored}).`);
