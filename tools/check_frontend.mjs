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

// Memory: stream the file, cap the canvas.
assert.match(app, /disableAutoFetch: true/, 'Documents must stream, not load whole.');
assert.match(
  app,
  /const MAX_CANVAS_PIXELS = [\d_]+;[\s\S]*?maxCanvasPixels: MAX_CANVAS_PIXELS/,
  'The canvas budget must be capped; it dominates resident memory.',
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

// Security posture, inherited from the extension.
const csp = config.app?.security?.csp ?? '';
assert.doesNotMatch(csp, /unsafe-eval/, 'CSP must not allow eval.');
assert.match(csp, /worker-src 'self' blob:/, 'CSP must allow the PDF.js worker.');
assert.equal(
  config.app?.security?.assetProtocol?.enable,
  true,
  'The asset protocol carries document bytes into the webview.',
);

// The README must name the runtime it actually ships.
const vendored = version.match(/Version:\s*(\S+)/)?.[1];
assert.ok(vendored, 'src/vendor/PDFJS_VERSION must record a version.');
assert.ok(
  readme.includes(vendored),
  `README.md must mention the vendored PDF.js version (${vendored}).`,
);

console.log(`Frontend contracts passed (PDF.js ${vendored}).`);
