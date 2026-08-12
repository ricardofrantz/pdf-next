// pdf-next viewer. One file, one window, one job: show the document and keep
// showing the newest version of it.
import * as pdfjsLib from './vendor/pdfjs/build/pdf.min.mjs';

// pdf_viewer.mjs resolves the core library through this global. Never assign
// globalThis.pdfjsWorker: PDF.js reads that as "parse on the UI thread".
globalThis.pdfjsLib = pdfjsLib;

const { getDocument, GlobalWorkerOptions } = pdfjsLib;
const { EventBus, PDFFindController, PDFLinkService, PDFViewer } = await import(
  './vendor/pdfjs/web/pdf_viewer.mjs'
);

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

GlobalWorkerOptions.workerSrc = './vendor/pdfjs/build/pdf.worker.min.mjs';

// A rendered page canvas is the dominant cost in this app: one A4 page at 200%
// on a 2x display is ~30 MB of RGBA. Capping it keeps huge pages from turning
// into hundreds of megabytes of resident memory.
const MAX_CANVAS_PIXELS = 4_194_304;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6];
const PAGE_MODES = ['night', 'sepia', 'invert'];
const PAGE_COLORS = {
  night: { background: '#1b1b1b', foreground: '#d6d1c4' },
  sepia: { background: '#f4ecd8', foreground: '#5b4636' },
};

const el = (id) => document.getElementById(id);
const ui = {
  bar: el('bar'),
  open: el('open'),
  prev: el('prev'),
  next: el('next'),
  page: el('page'),
  pages: el('pages'),
  zoom: el('zoom'),
  zoomIn: el('zoomIn'),
  zoomOut: el('zoomOut'),
  mode: el('mode'),
  dock: el('dock'),
  poll: el('poll'),
  waiting: el('waiting'),
  findToggle: el('findToggle'),
  find: el('find'),
  findInput: el('findInput'),
  findCount: el('findCount'),
  findPrev: el('findPrev'),
  findNext: el('findNext'),
  findClose: el('findClose'),
  container: el('viewerContainer'),
  viewer: el('viewer'),
  image: el('image'),
  status: el('status'),
};

const state = {
  file: null,
  document: null,
  loading: null,
  mode: null,
  natural: null,
  docked: false,
  statusTimer: 0,
};

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const findController = new PDFFindController({ eventBus, linkService });
const pdfViewer = new PDFViewer({
  container: ui.container,
  viewer: ui.viewer,
  eventBus,
  linkService,
  findController,
  maxCanvasPixels: MAX_CANVAS_PIXELS,
  textLayerMode: 1,
  annotationMode: 1,
});
linkService.setViewer(pdfViewer);

// ── Status ────────────────────────────────────────────────────────────────

function setStatus(message, { error = false, sticky = false } = {}) {
  window.clearTimeout(state.statusTimer);
  ui.status.textContent = message;
  ui.status.classList.toggle('on', Boolean(message));
  ui.status.classList.toggle('error', error);
  if (message && !sticky) {
    state.statusTimer = window.setTimeout(() => {
      ui.status.classList.remove('on');
    }, 2200);
  }
}

// ── View state, preserved across reloads ──────────────────────────────────

function captureView() {
  if (!state.document) {
    return null;
  }
  return {
    page: pdfViewer.currentPageNumber || 1,
    scale: pdfViewer.currentScaleValue || 'auto',
    top: ui.container.scrollTop,
    left: ui.container.scrollLeft,
  };
}

function restoreView(view) {
  if (!view) {
    return;
  }
  pdfViewer.currentScaleValue = view.scale;
  if (view.page > 1 && view.page <= pdfViewer.pagesCount) {
    pdfViewer.currentPageNumber = view.page;
  }
  // Scroll last: setting the page already moves the container.
  ui.container.scrollTop = view.top;
  ui.container.scrollLeft = view.left;
}

// ── Loading ───────────────────────────────────────────────────────────────

function sourceUrl(file) {
  return `${convertFileSrc(file.path)}?v=${file.revision}`;
}

async function releaseDocument() {
  if (state.loading) {
    try {
      await state.loading.destroy();
    } catch {
      // A destroyed-mid-flight task is expected during rapid rebuilds.
    }
    state.loading = null;
  }
  state.document = null;
}

// Window sizes are remembered per file, so reopening the same paper gives you
// back the window you had. Kept in the webview's own storage — no cache file to
// manage, and it is wiped with the app's data like any other preference.
const SIZE_KEY = 'pdf-next.sizes';
const SIZE_LIMIT = 80;

function readSizes() {
  try {
    return JSON.parse(localStorage.getItem(SIZE_KEY) || '{}');
  } catch {
    return {};
  }
}

function rememberedSize(path) {
  const entry = readSizes()[path];
  return Array.isArray(entry) && entry.length === 2 ? entry : null;
}

function rememberSize(path, width, height) {
  if (!path || !(width > 80) || !(height > 80)) {
    return;
  }
  const sizes = readSizes();
  delete sizes[path];
  sizes[path] = [Math.round(width), Math.round(height)];
  const paths = Object.keys(sizes);
  for (const stale of paths.slice(0, Math.max(0, paths.length - SIZE_LIMIT))) {
    delete sizes[stale];
  }
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(sizes));
  } catch {
    // Out of quota is not worth interrupting the reader over.
  }
}

const barHeight = () => {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--bar-height'),
  );
  return Number.isFinite(value) ? value : 36;
};

/// Wrap the window tightly around the document. Only on a fresh open — doing it
/// on every rebuild would make the window jump around while you work.
async function fitWindow(width, height, recenter) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return;
  }
  try {
    await invoke('fit_window', { width, height, recenter });
  } catch {
    // A window that will not resize is not worth failing the open over.
  }
}

/// The window size that wraps the document exactly, in logical pixels.
function autoWindowSize() {
  if (!state.natural) {
    return null;
  }
  const scrollbar = Math.max(
    ui.container.offsetWidth - ui.container.clientWidth,
    0,
  );
  return [
    state.natural.width + scrollbar,
    state.natural.height + barHeight(),
  ];
}

async function sizeToDocument(path, contentWidth, contentHeight) {
  state.natural = { width: contentWidth, height: contentHeight };
  const saved = rememberedSize(path);
  if (saved) {
    await fitWindow(saved[0], saved[1], false);
    return;
  }
  const auto = autoWindowSize();
  if (auto) {
    await fitWindow(auto[0], auto[1], true);
  }
}

async function showPdf(file, view) {
  await releaseDocument();
  const task = getDocument({
    url: sourceUrl(file),
    // Stream the file instead of pulling the whole thing into memory first.
    disableAutoFetch: true,
    disableStream: false,
    rangeChunkSize: 65536,
    cMapUrl: './vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
    wasmUrl: './vendor/pdfjs/wasm/',
    iccUrl: './vendor/pdfjs/iccs/',
  });
  state.loading = task;

  const pdfDocument = await task.promise;
  state.loading = null;
  state.document = pdfDocument;

  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, null);
  applyPageColors();

  await new Promise((resolve) => {
    eventBus.on('pagesinit', resolve, { once: true });
  });

  if (view) {
    restoreView(view);
  } else {
    // PDF.js reports page 1 in points; CSS pixels are 96/72 of that.
    const page = await pdfDocument.getPage(1);
    const { width, height } = page.getViewport({
      scale: 96 / 72,
    });
    await sizeToDocument(file.path, width, height);
    pdfViewer.currentScaleValue = 'page-fit';
  }
  updatePageControls();
}

function showImage(file, fit) {
  ui.image.src = sourceUrl(file);
  ui.image.alt = file.name;
  if (!fit) {
    return;
  }
  ui.image.decode?.().then(
    () =>
      sizeToDocument(file.path, ui.image.naturalWidth, ui.image.naturalHeight),
    () => {},
  );
}

async function openFile(file, { preserveView = false } = {}) {
  const view = preserveView ? captureView() : null;
  state.file = file;
  document.body.classList.add('has-file');
  document.body.classList.toggle('kind-pdf', file.kind === 'pdf');
  document.body.classList.toggle('kind-image', file.kind === 'image');
  document.title = `${file.name} — pdf-next`;

  try {
    if (file.kind === 'pdf') {
      await showPdf(file, view);
    } else if (file.kind === 'image') {
      showImage(file, !preserveView);
    } else {
      setStatus(`Unsupported file type: ${file.name}`, { error: true, sticky: true });
      return;
    }
    document.body.classList.remove('file-missing');
  } catch (error) {
    setStatus(`Could not open ${file.name}: ${error?.message || error}`, {
      error: true,
      sticky: true,
    });
  }
}

async function openPath(path) {
  try {
    const file = await invoke('open_path', { path });
    await openFile(file);
  } catch (error) {
    setStatus(String(error), { error: true, sticky: true });
  }
}

// ── Page and zoom controls ────────────────────────────────────────────────

function updatePageControls() {
  const count = pdfViewer.pagesCount || 0;
  const current = pdfViewer.currentPageNumber || 1;
  ui.page.value = String(current);
  ui.page.max = String(Math.max(count, 1));
  ui.pages.textContent = count ? `/ ${count}` : '/ —';
  ui.prev.disabled = current <= 1;
  ui.next.disabled = current >= count;
}

function updateZoomControl(scaleValue, scale) {
  const preset = ui.zoom.querySelector(`option[value="${scaleValue}"]`);
  if (preset) {
    removeCustomZoom();
    ui.zoom.value = scaleValue;
    return;
  }
  // Keyboard and button zoom land between presets; show the live percentage in
  // the control rather than letting it read a stale preset.
  let custom = ui.zoom.querySelector('option[value="custom"]');
  if (!custom) {
    custom = document.createElement('option');
    custom.value = 'custom';
    custom.hidden = true;
    ui.zoom.append(custom);
  }
  custom.textContent = `${Math.round(scale * 100)}%`;
  ui.zoom.value = 'custom';
}

function removeCustomZoom() {
  ui.zoom.querySelector('option[value="custom"]')?.remove();
}

function stepZoom(direction) {
  if (!state.document) {
    return;
  }
  const current = pdfViewer.currentScale;
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > current + 0.001)
      : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001);
  if (next) {
    pdfViewer.currentScaleValue = String(next);
  }
}

// ── Page modes ────────────────────────────────────────────────────────────

function applyPageColors() {
  const pageColors = PAGE_COLORS[state.mode] || null;
  pdfViewer.pageColors = pageColors;
  const pages = pdfViewer._pages;
  if (Array.isArray(pages)) {
    for (const pageView of pages) {
      pageView.pageColors = pageColors;
    }
    if (state.document) {
      pdfViewer.refresh();
    }
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const candidate of PAGE_MODES) {
    document.body.classList.toggle(`mode-${candidate}`, candidate === mode);
  }
  document.body.classList.toggle('mode-auto', !mode);
  ui.mode.classList.toggle('on', Boolean(mode));
  ui.mode.setAttribute('aria-pressed', String(Boolean(mode)));
  ui.mode.title = mode
    ? `Page mode: ${mode} (Shift+click to clear)`
    : 'Page mode: off';
  applyPageColors();
  try {
    localStorage.setItem('pdf-next.mode', mode || '');
  } catch {
    // Storage is a convenience here, never a requirement.
  }
}

function cycleMode(clear) {
  if (clear) {
    setMode(null);
    return;
  }
  const index = PAGE_MODES.indexOf(state.mode);
  setMode(PAGE_MODES[(index + 1) % PAGE_MODES.length]);
}

// ── Find ──────────────────────────────────────────────────────────────────

function openFind() {
  if (state.file?.kind !== 'pdf') {
    return;
  }
  ui.find.hidden = false;
  ui.findInput.focus();
  ui.findInput.select();
}

function closeFind() {
  ui.find.hidden = true;
  ui.findCount.textContent = '';
  eventBus.dispatch('findbarclose', { source: null });
  ui.container.focus();
}

function runFind(type = '', again = false, backwards = false) {
  eventBus.dispatch('find', {
    source: null,
    type,
    query: ui.findInput.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: backwards,
    matchDiacritics: false,
    ...(again ? { findPrevious: backwards } : {}),
  });
}

/// One button, two states. Docked is a tall half-screen column, where fitting
/// the whole page just shrinks the text — so it fits the width. Undocked is the
/// automatic fit: the window wrapped around the page again, at fit-page.
///
/// Resizing keeps the scroll offset in pixels, which lands on a different page
/// once the layout reflows, so the reader goes back where it was either way.
async function toggleDock() {
  const page = state.document ? pdfViewer.currentPageNumber : 0;
  const docking = !state.docked;

  try {
    if (docking) {
      await invoke('snap_left');
    } else {
      const auto = autoWindowSize();
      if (!auto) {
        return;
      }
      await fitWindow(auto[0], auto[1], true);
    }
  } catch {
    return;
  }

  setDocked(docking);
  if (!state.document) {
    return;
  }
  window.setTimeout(() => {
    pdfViewer.currentScaleValue = docking ? 'page-width' : 'page-fit';
    if (page > 1) {
      pdfViewer.currentPageNumber = page;
    }
  }, 160);
}

function setDocked(docked) {
  state.docked = docked;
  ui.dock.classList.toggle('on', docked);
  ui.dock.setAttribute('aria-pressed', String(docked));
  const label = docked
    ? 'Undock and fit the window to the page (Ctrl+Shift+Left)'
    : 'Fill the left half of the screen (Ctrl+Shift+Left)';
  ui.dock.title = label;
  ui.dock.setAttribute('aria-label', label);
}

// ── Wiring ────────────────────────────────────────────────────────────────

ui.open.addEventListener('click', async () => {
  const picked = await invoke('pick_file');
  if (picked) {
    await openPath(picked);
  }
});

ui.prev.addEventListener('click', () => {
  pdfViewer.currentPageNumber = Math.max(1, pdfViewer.currentPageNumber - 1);
});

ui.next.addEventListener('click', () => {
  pdfViewer.currentPageNumber = Math.min(
    pdfViewer.pagesCount,
    pdfViewer.currentPageNumber + 1,
  );
});

ui.page.addEventListener('change', () => {
  const requested = Number(ui.page.value);
  if (Number.isFinite(requested)) {
    pdfViewer.currentPageNumber = Math.min(
      Math.max(1, Math.trunc(requested)),
      pdfViewer.pagesCount || 1,
    );
  }
  updatePageControls();
});

ui.zoom.addEventListener('change', () => {
  if (ui.zoom.value === 'custom') {
    return;
  }
  pdfViewer.currentScaleValue = ui.zoom.value;
});

ui.zoomIn.addEventListener('click', () => stepZoom(1));
ui.zoomOut.addEventListener('click', () => stepZoom(-1));
ui.mode.addEventListener('click', (event) => cycleMode(event.shiftKey || event.altKey));
ui.dock.addEventListener('click', toggleDock);

ui.poll.addEventListener('change', () => {
  const seconds = Number(ui.poll.value) || 0;
  invoke('set_poll_seconds', { seconds });
  try {
    localStorage.setItem('pdf-next.poll', String(seconds));
  } catch {
    // Preference only.
  }
});

// Remember the window size per file, so reopening restores the shape you left.
let sizeTimer = 0;
window.addEventListener('resize', () => {
  if (!state.file) {
    return;
  }
  window.clearTimeout(sizeTimer);
  sizeTimer = window.setTimeout(async () => {
    try {
      const [width, height] = await invoke('window_size');
      rememberSize(state.file.path, width, height);
    } catch {
      // Nothing to remember if the size cannot be read.
    }
  }, 600);
});
ui.findToggle.addEventListener('click', () => (ui.find.hidden ? openFind() : closeFind()));
ui.findClose.addEventListener('click', closeFind);
ui.findNext.addEventListener('click', () => runFind('again', true, false));
ui.findPrev.addEventListener('click', () => runFind('again', true, true));

ui.findInput.addEventListener('input', () => runFind(''));
ui.findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runFind('again', true, event.shiftKey);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeFind();
  }
});

eventBus.on('pagechanging', updatePageControls);
eventBus.on('pagesloaded', updatePageControls);
eventBus.on('scalechanging', (event) => {
  // On a window resize PDF.js reports the computed scale with no preset, even
  // though it is still tracking "fit page" — so fall back to the live value.
  const value = event.presetValue || pdfViewer.currentScaleValue || event.scale;
  updateZoomControl(String(value), event.scale);
});
eventBus.on('updatefindmatchescount', ({ matchesCount }) => {
  ui.findCount.textContent = matchesCount?.total
    ? `${matchesCount.current}/${matchesCount.total}`
    : '';
});
eventBus.on('updatefindcontrolstate', ({ matchesCount, state: findState }) => {
  if (findState === 1) {
    ui.findCount.textContent = 'No match';
    return;
  }
  ui.findCount.textContent = matchesCount?.total
    ? `${matchesCount.current}/${matchesCount.total}`
    : '';
});

window.addEventListener('keydown', (event) => {
  const typing =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement;
  const key = event.key.toLowerCase();

  if ((event.ctrlKey || event.metaKey) && key === 'o') {
    event.preventDefault();
    ui.open.click();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'arrowleft') {
    event.preventDefault();
    toggleDock();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'f') {
    event.preventDefault();
    openFind();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'r') {
    event.preventDefault();
    if (state.file) {
      openFile(state.file, { preserveView: true });
    }
    return;
  }
  if (typing) {
    return;
  }
  if (key === 'escape' && !ui.find.hidden) {
    closeFind();
    return;
  }
  if (state.file?.kind !== 'pdf') {
    return;
  }
  switch (key) {
    case 'j':
      ui.container.scrollBy({ top: 90 });
      break;
    case 'k':
      ui.container.scrollBy({ top: -90 });
      break;
    case 'n':
      ui.next.click();
      break;
    case 'p':
      ui.prev.click();
      break;
    case 'g':
      pdfViewer.currentPageNumber = event.shiftKey ? pdfViewer.pagesCount : 1;
      break;
    case '+':
    case '=':
      stepZoom(1);
      break;
    case '-':
      stepZoom(-1);
      break;
    default:
      return;
  }
  event.preventDefault();
});

// Drag and drop, straight from the OS.
listen('tauri://drag-drop', async (event) => {
  const [path] = event.payload?.paths || [];
  if (path) {
    await openPath(path);
  }
});

// The watcher fires at most once a second, and only when something moved.
listen('file-changed', async (event) => {
  const { kind, revision } = event.payload || {};
  if (!state.file) {
    return;
  }
  if (kind === 'missing') {
    document.body.classList.add('file-missing');
    ui.waiting.hidden = false;
    setStatus('Rebuilding — waiting for the file', { sticky: true });
    return;
  }
  document.body.classList.remove('file-missing');
  ui.waiting.hidden = true;
  await openFile({ ...state.file, revision }, { preserveView: true });
  setStatus('Reloaded');
});

// ── Theme ─────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

listen('theme-changed', (event) => applyTheme(event.payload));

// ── Start ─────────────────────────────────────────────────────────────────

applyTheme(await invoke('os_theme'));

try {
  const saved = localStorage.getItem('pdf-next.mode');
  setMode(PAGE_MODES.includes(saved) ? saved : null);
} catch {
  setMode(null);
}

// Watching is on by default at one second; the control only exists to slow it
// down or stop it.
try {
  const saved = localStorage.getItem('pdf-next.poll');
  const seconds = ['0', '1', '2', '3'].includes(saved) ? Number(saved) : 1;
  ui.poll.value = String(seconds);
  await invoke('set_poll_seconds', { seconds });
} catch {
  ui.poll.value = '1';
}

const initial = await invoke('initial_file');
if (initial) {
  await openFile(initial);
}
ui.container.focus();
