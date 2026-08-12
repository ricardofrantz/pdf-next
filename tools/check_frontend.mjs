// Source contracts for the things that are easy to break silently and
// expensive to notice: the real worker, streaming, the canvas budget, the
// one-second poll, and the mid-build gap behaviour.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile('src/app.mjs', 'utf8');
const main = await readFile('src-tauri/src/main.rs', 'utf8');
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const styles = await readFile('src/style.css', 'utf8');
const version = await readFile('src/vendor/PDFJS_VERSION', 'utf8');
const readme = await readFile('README.md', 'utf8');

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
assert.doesNotMatch(
  app,
  /const PAGE_MODES = \[[^\]]*'clear'/,
  'The mode cycle must not land on plain pages; clearing is Shift+click.',
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
  /if !state\.missing \{[\s\S]*?kind: "missing"/,
  'A vanished file must report once and keep the last render on screen.',
);
assert.match(
  main,
  /let reappeared = state\.missing;[\s\S]*?if changed \|\| reappeared/,
  'A file that reappears after a build must trigger a reload.',
);

// Window fitting happens on a fresh open only; refitting on every rebuild would
// make the window jump while you work.
assert.match(
  app,
  /if \(view\) \{[\s\S]*?\} else \{[\s\S]*?await sizeToDocument\(file\.path, width, height\)/,
  'The window may only be refitted when opening a file, not when reloading it.',
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
  app,
  /showImage\(file, !preserveView\)/,
  'Images must refit only on a fresh open, not on reload.',
);
assert.match(
  app,
  /async function toggleDock\(\)[\s\S]*?docking \? 'page-width' : 'page-fit'/,
  'Docking must switch to fit-width and undocking back to fit-page.',
);
assert.match(
  app,
  /async function toggleDock\(\)[\s\S]*?const auto = autoWindowSize\(\);[\s\S]*?await fitWindow\(auto\[0\], auto\[1\], true\)/,
  'Undocking must restore the automatic fit to the document.',
);
assert.match(
  main,
  /fn fit_window\([\s\S]*?width\.is_finite\(\) && height\.is_finite\(\) && width > 80\.0 && height > 80\.0/,
  'A bogus measurement must never be turned into a window size.',
);

// Security. An untrusted PDF is the threat model: the attacker controls the
// file, and the app reloads it from disk every second.
const csp = config.app?.security?.csp ?? '';
assert.doesNotMatch(csp, /unsafe-eval/, 'CSP must not allow eval.');
assert.match(csp, /worker-src 'self' blob:/, 'CSP must allow the PDF.js worker.');
assert.match(csp, /object-src 'none'/, 'CSP must forbid plugins.');
assert.match(csp, /base-uri 'none'/, 'CSP must forbid base-tag hijacking.');
assert.equal(
  config.app?.security?.assetProtocol?.enable,
  true,
  'The asset protocol carries document bytes into the webview.',
);
assert.deepEqual(
  config.app?.security?.assetProtocol?.scope?.allow,
  [],
  'The asset scope must start empty; only the opened file is allowed, at runtime.',
);
assert.match(
  main,
  /fn adopt\([\s\S]*?asset_protocol_scope\(\)\.allow_file\(&canonical\)/,
  'Opening a file is what grants the webview permission to read exactly it.',
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

// The README must name the runtime it actually ships.
const vendored = version.match(/Version:\s*(\S+)/)?.[1];
assert.ok(vendored, 'src/vendor/PDFJS_VERSION must record a version.');
assert.ok(
  readme.includes(vendored),
  `README.md must mention the vendored PDF.js version (${vendored}).`,
);

console.log(`Frontend contracts passed (PDF.js ${vendored}).`);
