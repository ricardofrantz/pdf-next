// pdf-next viewer. One file, one window, one job: show the document and keep
// showing the newest version of it.
import * as pdfjsLib from './vendor/pdfjs/build/pdf.min.mjs';

// pdf_viewer.mjs resolves the core library through this global. Never assign
// globalThis.pdfjsWorker: PDF.js reads that as "parse on the UI thread".
globalThis.pdfjsLib = pdfjsLib;

const { getDocument, GlobalWorkerOptions, PDFWorker } = pdfjsLib;
const { EventBus, PDFFindController, PDFLinkService, PDFViewer } = await import(
  './vendor/pdfjs/web/pdf_viewer.mjs'
);

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

GlobalWorkerOptions.workerSrc = './vendor/pdfjs/build/pdf.worker.min.mjs';

// A rendered page canvas is the dominant per-document cost: one A4 page at 200%
// on a 2x display is ~30 MB of RGBA. Raising this to 2^23 (which would keep a
// docked fit-width page on PDF.js's single-canvas path) measured worse here, so
// it stays where it is until someone measures the docked case properly.
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
  wrap: el('wrap'),
  dock: el('dock'),
  tabs: el('tabs'),
  stage: el('stage'),
  imagePrev: el('imagePrev'),
  imageNext: el('imageNext'),
  imageIndex: el('imageIndex'),
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
  imageStage: el('imageStage'),
  status: el('status'),
};

const state = {
  file: null,
  document: null,
  task: null,
  mode: null,
  natural: null,
  docked: false,
  wrap: false,
  imageScale: 'fit',
  statusTimer: 0,
  pendingRevision: null,
  generation: 0,
  siblings: [],
  siblingIndex: -1,
  // Tabs hold paths, never documents: only the active file is ever loaded, so
  // ten open tabs cost the same resident memory as one.
  tabs: [],
  active: -1,
  views: new Map(),
};

// One worker for the life of the process. getDocument would otherwise spawn a
// fresh one per load — a whole thread plus a 1.2 MB module compile on every
// rebuild — and passing it explicitly means loadingTask.destroy() tears down the
// document without terminating the worker, keeping fonts and cmaps warm.
const pdfWorker = new PDFWorker();

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
// A link annotation in an untrusted PDF must not be able to navigate anywhere.
// Internal destinations (contents, cross-references) still work.
linkService.externalLinkEnabled = false;
const findController = new PDFFindController({ eventBus, linkService });

// PDFViewer._resetView drops its page views without freeing their canvases, so
// a reload leaves up to ten backing stores for the garbage collector to notice.
// At one reload per second that is a large, avoidable sawtooth.
class TidyViewer extends PDFViewer {
  _resetView() {
    for (const pageView of this._pages || []) {
      try {
        pageView.destroy();
      } catch {
        // A page already torn down is not an error.
      }
    }
    super._resetView();
  }
}

const pdfViewer = new TidyViewer({
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
  if (state.file?.kind === 'image') {
    return {
      kind: 'image',
      scale: state.imageScale,
      top: ui.imageStage.scrollTop,
      left: ui.imageStage.scrollLeft,
    };
  }
  if (!state.document) {
    return null;
  }
  return {
    kind: 'pdf',
    page: pdfViewer.currentPageNumber || 1,
    scale: pdfViewer.currentScaleValue || 'auto',
    top: ui.container.scrollTop,
    left: ui.container.scrollLeft,
  };
}

function restoreView(view) {
  if (!view || view.kind === 'image') {
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

function restoreImageView(view) {
  if (!view || view.kind !== 'image') {
    return;
  }
  setImageScale(view.scale, { refit: false });
  ui.imageStage.scrollTop = view.top;
  ui.imageStage.scrollLeft = view.left;
}

// ── Loading ───────────────────────────────────────────────────────────────

function sourceUrl(file) {
  return `${convertFileSrc(file.path)}?v=${file.revision}`;
}

/// Tear the previous document down completely before loading the next one.
///
/// This matters more than anything else in the app: the viewer reloads on every
/// rebuild, and a PDF.js document that is merely dereferenced keeps its worker,
/// font and image caches and rendered canvases alive. Measured at ~77 MB leaked
/// per reload before this was awaited properly.
async function releaseDocument() {
  const task = state.task;
  state.task = null;
  state.document = null;
  if (!task) {
    return;
  }
  try {
    // Drop the page views first so their canvases go with the document.
    pdfViewer.setDocument(null);
    linkService.setDocument(null);
  } catch {
    // An empty viewer is not an error.
  }
  try {
    await task.destroy();
  } catch {
    // A task destroyed mid-flight is expected during rapid rebuilds.
  }
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

/// Everything above the stage — the toolbar, plus the tab strip when it is
/// showing. Measured rather than read from --bar-height: the strip appears and
/// disappears, and a window fit that guessed this would be wrong by its height.
function chromeHeight() {
  const measured = window.innerHeight - ui.stage.clientHeight;
  if (measured > 0 && measured < window.innerHeight) {
    return measured;
  }
  const declared = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--bar-height'),
  );
  return Number.isFinite(declared) ? declared : 36;
}

/// Wrap the window tightly around the document. Only on a fresh open — doing it
/// on every rebuild would make the window jump around while you work.
async function fitWindow(width, height, recenter, exact = false) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return;
  }
  try {
    await invoke('fit_window', { width, height, recenter, exact });
  } catch {
    // A window that will not resize is not worth failing the open over.
  }
}

/// The window size that wraps the document at 100%, in logical pixels. Used on
/// a fresh open, where the page is about to be laid out and a scrollbar may
/// appear; the exact fit in wrapWindowSize() measures what is already there.
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
    state.natural.height + chromeHeight(),
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

// ── Image zoom ────────────────────────────────────────────────────────────

/// An image has no viewer of its own. 'fit' is the CSS default — max-width:100%,
/// height follows — and a number is an explicit width in CSS pixels. Either way
/// the browser scales the bitmap it already decoded, so zoom costs no memory.
function setImageScale(value, { refit = true } = {}) {
  state.imageScale = value;
  document.body.classList.toggle('image-zoomed', value !== 'fit');
  if (value === 'fit') {
    ui.image.style.width = '';
    ui.image.style.height = '';
  } else if (ui.image.naturalWidth) {
    ui.image.style.width = `${Math.round(ui.image.naturalWidth * value)}px`;
    ui.image.style.height = 'auto';
  }
  updateZoomControl(value === 'fit' ? 'auto' : String(value), imageScale());
  if (refit) {
    scheduleWrap();
  }
}

/// What the image is actually displayed at, whether CSS or a number set it.
function imageScale() {
  if (typeof state.imageScale === 'number') {
    return state.imageScale;
  }
  const natural = ui.image.naturalWidth || 0;
  return natural ? ui.image.offsetWidth / natural : 1;
}

/// The scale at which the whole image fits inside the stage, both axes.
function imageContainScale() {
  const { naturalWidth: width, naturalHeight: height } = ui.image;
  if (!width || !height) {
    return 1;
  }
  const style = getComputedStyle(ui.imageStage);
  const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const padY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  return Math.min(
    (ui.imageStage.clientWidth - padX) / width,
    (ui.imageStage.clientHeight - padY) / height,
  );
}

// ── Fitting the window to the content ─────────────────────────────────────

/// The size of what is on screen right now, in logical pixels. Read off the
/// rendered element rather than recomputed, so page rotation, mixed page sizes
/// and the image's own aspect ratio all come along for free. Ceiled: a
/// fractional size rounds down into a one-pixel overflow, which raises a
/// scrollbar, which shrinks the viewport, which raises the other scrollbar.
function contentSize() {
  if (state.file?.kind === 'image') {
    if (!ui.image.naturalWidth) {
      return null;
    }
    return [Math.ceil(ui.image.offsetWidth), Math.ceil(ui.image.offsetHeight)];
  }
  if (!state.document) {
    return null;
  }
  const index = Math.max(0, (pdfViewer.currentPageNumber || 1) - 1);
  const div = pdfViewer.getPageView?.(index)?.div;
  if (div?.offsetWidth) {
    return [Math.ceil(div.offsetWidth), Math.ceil(div.offsetHeight)];
  }
  if (!state.natural) {
    return null;
  }
  const scale = pdfViewer.currentScale || 1;
  return [
    Math.ceil(state.natural.width * scale),
    Math.ceil(state.natural.height * scale),
  ];
}

/// The window that wraps the content exactly. No scrollbar allowance — with an
/// exact window there is nothing left to scroll — and no padding, because
/// body.wrap-on has already taken the stage's padding to zero.
function wrapWindowSize() {
  const content = contentSize();
  return content ? [content[0], content[1] + chromeHeight()] : null;
}

let wrapTimer = 0;
let wrapping = false;

/// Coalesce the refits: holding + would otherwise fire a set_size per step.
function scheduleWrap() {
  if (!state.wrap) {
    return;
  }
  window.clearTimeout(wrapTimer);
  wrapTimer = window.setTimeout(applyWrap, 80);
}

async function applyWrap() {
  const size = wrapWindowSize();
  if (!size) {
    return;
  }
  wrapping = true;
  try {
    await fitWindow(size[0], size[1], false, true);
  } finally {
    // Let the resize land before the resize listener is allowed to treat it as
    // a size the reader chose and remember it.
    window.setTimeout(() => {
      wrapping = false;
    }, 700);
  }
}

/// One button: while it is on, the window follows the content. Zoom out and the
/// window comes in with it; zoom in and it grows, up to the screen.
///
/// The scale has to be a number for that to terminate. A preset — page-fit,
/// page-width, auto — is the opposite instruction: it fits the *content to the
/// window*, so resizing the window would rescale the page, which would resize
/// the window again. Turning wrap on pins the live scale to a number, and
/// choosing a preset later turns wrap off.
function setWrap(on) {
  state.wrap = on;
  document.body.classList.toggle('wrap-on', on);
  ui.wrap.classList.toggle('on', on);
  ui.wrap.setAttribute('aria-pressed', String(on));
  const label = on
    ? 'Window follows the content — click to stop (Ctrl+Shift+F)'
    : 'Fit the window to the content (Ctrl+Shift+F)';
  ui.wrap.title = label;
  ui.wrap.setAttribute('aria-label', label);
}

async function toggleWrap() {
  if (state.wrap) {
    setWrap(false);
    return;
  }
  pinScale();
  setWrap(true);
  if (state.docked) {
    // The dock sets an explicit half-screen size; wrap is about to override it,
    // so the pip should stop claiming the window is docked.
    setDocked(false);
  }
  await applyWrap();
}

/// Freeze whatever scale is showing, so a window resize cannot change it.
function pinScale() {
  if (state.file?.kind === 'image') {
    if (state.imageScale === 'fit') {
      setImageScale(imageScale(), { refit: false });
    }
    return;
  }
  if (state.document) {
    const scale = pdfViewer.currentScale;
    pdfViewer.currentScaleValue = String(scale);
    // Pinning a preset to the number it already resolves to is not a scale
    // change, so PDF.js says nothing and the control would keep reading
    // "Fit page" while it is no longer fitting anything.
    updateZoomControl(String(scale), scale);
  }
}

async function showPdf(file, view, generation) {
  await releaseDocument();
  if (state.generation !== generation) {
    return;
  }
  const task = getDocument({
    url: sourceUrl(file),
    // Reuse the one worker; without this every reload starts a new thread.
    worker: pdfWorker,
    // The asset protocol answers full GETs only (no Accept-Ranges), so range
    // options would be inert. One streamed read per load is what happens.
    disableRange: true,
    cMapUrl: './vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
    wasmUrl: './vendor/pdfjs/wasm/',
    iccUrl: './vendor/pdfjs/iccs/',
  });
  // Held for teardown: dropping this reference is what leaks the worker.
  state.task = task;

  const pdfDocument = await task.promise;
  // A rebuild landing mid-load supersedes this one; its task is already gone.
  if (state.generation !== generation) {
    return;
  }
  state.document = pdfDocument;

  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, null);
  applyPageColors();

  // Never wait forever: if setDocument fails internally, pagesinit never fires
  // and this closure would be retained for the life of the process.
  await Promise.race([
    new Promise((resolve) => {
      eventBus.on('pagesinit', resolve, { once: true });
    }),
    new Promise((resolve) => window.setTimeout(resolve, 10_000)),
  ]);
  if (state.generation !== generation) {
    return;
  }

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

// ── Stepping through a folder ─────────────────────────────────────────────

/// Learn what else is next to the open file, so Left/Right can walk the folder.
/// Failing quietly is fine — the viewer just loses the arrows.
async function loadSiblings(file) {
  state.siblings = [];
  state.siblingIndex = -1;
  if (file.kind !== 'image') {
    updateSiblingControls();
    return;
  }
  try {
    const found = await invoke('siblings', { path: file.path });
    state.siblings = Array.isArray(found) ? found : [];
    state.siblingIndex = state.siblings.indexOf(file.path);
  } catch {
    state.siblings = [];
  }
  updateSiblingControls();
}

function updateSiblingControls() {
  const total = state.siblings.length;
  const position = state.siblingIndex;
  const known = position >= 0 && total > 1;
  ui.imageIndex.textContent = known ? `${position + 1} / ${total}` : '';
  ui.imagePrev.disabled = !known || position <= 0;
  ui.imageNext.disabled = !known || position >= total - 1;
}

/// Step to another file in the folder, keeping the window where it is — a
/// window that jumped on every arrow press would be unusable for browsing.
async function stepSibling(delta) {
  if (state.siblingIndex < 0) {
    return;
  }
  const next = state.siblingIndex + delta;
  const path = state.siblings[next];
  if (!path) {
    return;
  }
  try {
    const file = await invoke('open_path', { path });
    // Walking a folder replaces what the tab is showing rather than opening a
    // tab per file — browsing 200 PNGs must not leave 200 tabs behind.
    const tab = state.tabs[state.active];
    if (tab) {
      state.views.delete(tab.path);
      tab.path = file.path;
      tab.name = file.name;
      tab.kind = file.kind;
      renderTabs();
    }
    await openFile(file, { keepWindow: true });
  } catch (error) {
    setStatus(String(error), { error: true });
  }
}

function showImage(file, fit, view) {
  ui.image.src = sourceUrl(file);
  ui.image.alt = file.name;
  ui.image.decode?.().then(
    () => {
      if (view) {
        restoreImageView(view);
      } else {
        setImageScale('fit', { refit: false });
      }
      if (fit) {
        sizeToDocument(file.path, ui.image.naturalWidth, ui.image.naturalHeight);
      }
      scheduleWrap();
    },
    () => {},
  );
}

async function openFile(
  file,
  { preserveView = false, keepWindow = false, view: given = null } = {},
) {
  // Rebuilds can outpace loading; only the newest one may touch the UI.
  const generation = ++state.generation;
  const view = given || (preserveView ? captureView() : null);
  state.file = file;
  document.body.classList.add('has-file');
  document.body.classList.toggle('kind-pdf', file.kind === 'pdf');
  document.body.classList.toggle('kind-image', file.kind === 'image');
  document.title = `${file.name} — pdf-next`;

  try {
    if (file.kind === 'pdf') {
      await showPdf(file, view, generation);
    } else if (file.kind === 'image') {
      showImage(file, !view && !keepWindow, view);
      void loadSiblings(file);
    } else {
      setStatus(`Unsupported file type: ${file.name}`, { error: true, sticky: true });
      return;
    }
    document.body.classList.remove('file-missing');
  } catch (error) {
    // A load cancelled by a newer rebuild is expected, not a failure to report.
    if (state.generation !== generation) {
      return;
    }
    setStatus(`Could not open ${file.name}: ${error?.message || error}`, {
      error: true,
      sticky: true,
    });
  }
}

async function openPath(path) {
  try {
    const file = await invoke('open_path', { path });
    await openInTab(file);
  } catch (error) {
    setStatus(String(error), { error: true, sticky: true });
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────
//
// A tab is a path and nothing else. Switching tears the current document down
// through the same releaseDocument() path a rebuild uses and loads the next
// one, so six open tabs cost what one costs. The price is a re-parse on switch,
// paid against a worker whose fonts and cmaps are already warm.
//
// It also means a background tab is never stale: it is read from disk at the
// moment you return to it, without anything having to watch it.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

function icon(href) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', href);
  use.setAttributeNS(XLINK_NS, 'xlink:href', href);
  svg.append(use);
  return svg;
}

function renderTabs() {
  document.body.classList.toggle('has-tabs', state.tabs.length > 1);
  ui.tabs.textContent = '';
  if (state.tabs.length < 2) {
    return;
  }
  state.tabs.forEach((tab, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab';
    button.setAttribute('role', 'tab');
    button.title = tab.path;
    button.setAttribute('aria-selected', String(index === state.active));

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = tab.name;
    button.append(label);

    const shut = document.createElement('span');
    shut.className = 'shut';
    shut.setAttribute('aria-label', `Close ${tab.name}`);
    shut.append(icon('#i-close'));
    button.append(shut);

    button.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('.shut')) {
        void closeTab(index);
        return;
      }
      void activateTab(index);
    });
    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        void closeTab(index);
      }
    });
    ui.tabs.append(button);
    if (index === state.active) {
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });
}

/// Focus the file if it is already open; otherwise add it next to the current
/// tab, where a file opened from the one you are reading belongs.
async function openInTab(file) {
  const existing = state.tabs.findIndex((tab) => tab.path === file.path);
  if (existing >= 0) {
    await activateTab(existing, { force: true });
    return;
  }
  stashView();
  const entry = { path: file.path, name: file.name, kind: file.kind };
  const at = state.active < 0 ? state.tabs.length : state.active + 1;
  state.tabs.splice(at, 0, entry);
  state.active = at;
  renderTabs();
  await openFile(file);
}

/// Park the outgoing file's page, zoom and scroll so the tab comes back to the
/// place you left it rather than to the top of the document.
function stashView() {
  const current = state.tabs[state.active];
  if (!current) {
    return;
  }
  const view = captureView();
  if (view) {
    state.views.set(current.path, view);
  }
}

async function activateTab(index, { force = false } = {}) {
  const tab = state.tabs[index];
  if (!tab || (index === state.active && !force)) {
    return;
  }
  stashView();
  state.active = index;
  renderTabs();
  try {
    const file = await invoke('open_path', { path: tab.path });
    // Keep the name fresh in case the file moved out from under the tab.
    tab.name = file.name;
    tab.kind = file.kind;
    await openFile(file, {
      keepWindow: true,
      view: state.views.get(tab.path) || null,
    });
  } catch (error) {
    setStatus(String(error), { error: true, sticky: true });
  }
}

async function closeTab(index) {
  const tab = state.tabs[index];
  if (!tab) {
    return;
  }
  state.views.delete(tab.path);
  state.tabs.splice(index, 1);
  if (!state.tabs.length) {
    await closeAll();
    return;
  }
  if (index < state.active) {
    state.active -= 1;
    renderTabs();
    return;
  }
  if (index > state.active) {
    renderTabs();
    return;
  }
  // The closed tab was the one showing: take its right-hand neighbour, or the
  // last tab if it was the rightmost.
  state.active = Math.min(index, state.tabs.length - 1);
  renderTabs();
  await activateTab(state.active, { force: true });
}

/// Back to the small empty window you get on a cold start.
async function closeAll() {
  state.tabs = [];
  state.active = -1;
  state.views.clear();
  state.file = null;
  state.natural = null;
  state.siblings = [];
  state.siblingIndex = -1;
  state.pendingRevision = null;
  await releaseDocument();
  ui.image.removeAttribute('src');
  setImageScale('fit', { refit: false });
  document.body.classList.remove('has-file', 'kind-pdf', 'kind-image', 'file-missing');
  document.title = 'pdf-next';
  ui.waiting.hidden = true;
  updateSiblingControls();
  renderTabs();
  closeFind();
  setStatus('');
}

function cycleTab(delta) {
  if (state.tabs.length < 2) {
    return;
  }
  const count = state.tabs.length;
  void activateTab((state.active + delta + count) % count);
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
  const image = state.file?.kind === 'image';
  if (!image && !state.document) {
    return;
  }
  const current = image ? imageScale() : pdfViewer.currentScale;
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > current + 0.001)
      : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001);
  if (!next) {
    return;
  }
  if (image) {
    setImageScale(next);
  } else {
    pdfViewer.currentScaleValue = String(next);
  }
}

/// The preset ladder means something slightly different for a bare image: there
/// is no page, so "fit page" is the scale that contains it and the other two
/// fits are the CSS default, which fills the width and lets the height run.
function applyZoomChoice(value) {
  if (state.file?.kind !== 'image') {
    pdfViewer.currentScaleValue = value;
    return;
  }
  if (value === 'page-fit') {
    setImageScale(imageContainScale());
  } else if (value === 'auto' || value === 'page-width') {
    setImageScale('fit');
  } else {
    const scale = Number(value);
    if (Number.isFinite(scale) && scale > 0) {
      setImageScale(scale);
    }
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

function setMode(mode, persist = true) {
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
  if (!persist) {
    // A command-line flag styles this window; it is not a new preference.
    return;
  }
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
  // Docking sets an explicit half-screen size, which wrap would immediately
  // undo. Only one of them can own the window.
  if (state.wrap) {
    window.clearTimeout(wrapTimer);
    setWrap(false);
  }

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
  const value = ui.zoom.value;
  if (value === 'custom') {
    return;
  }
  // A fit preset is the opposite instruction to wrap — it sizes the content to
  // the window — so asking for one turns wrap off rather than fighting it.
  if (state.wrap && (value === 'auto' || value === 'page-fit' || value === 'page-width')) {
    setWrap(false);
  }
  applyZoomChoice(value);
});

ui.zoomIn.addEventListener('click', () => stepZoom(1));
ui.zoomOut.addEventListener('click', () => stepZoom(-1));
ui.mode.addEventListener('click', (event) => cycleMode(event.shiftKey || event.altKey));
ui.wrap.addEventListener('click', toggleWrap);
ui.dock.addEventListener('click', toggleDock);
ui.imagePrev.addEventListener('click', () => stepSibling(-1));
ui.imageNext.addEventListener('click', () => stepSibling(1));

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
// A size the app chose for itself while wrapping is not a size the reader chose.
let sizeTimer = 0;
window.addEventListener('resize', () => {
  if (!state.file || wrapping) {
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
  scheduleWrap();
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
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'f') {
    event.preventDefault();
    void toggleWrap();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'w') {
    event.preventDefault();
    void closeTab(state.active);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'tab') {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key >= '1' && key <= '9') {
    event.preventDefault();
    void activateTab(Number(key) - 1);
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
  // Zoom is the one thing that means the same in both modes.
  if (key === '+' || key === '=') {
    event.preventDefault();
    stepZoom(1);
    return;
  }
  if (key === '-') {
    event.preventDefault();
    stepZoom(-1);
    return;
  }
  // Left and Right step through the tabs whenever there are tabs to step
  // through. With a single file open there is nothing to switch to, so they go
  // back to walking the folder — which is what they are for in a folder of
  // figures opened one at a time.
  if (state.tabs.length > 1 && (key === 'arrowright' || key === 'arrowleft')) {
    event.preventDefault();
    cycleTab(key === 'arrowright' ? 1 : -1);
    return;
  }
  // Arrows walk the folder in image mode; in a PDF they scroll the page, which
  // is what a reader expects there.
  if (state.file?.kind === 'image') {
    if (key === 'arrowright' || key === 'pagedown' || key === ' ') {
      event.preventDefault();
      stepSibling(1);
    } else if (key === 'arrowleft' || key === 'pageup') {
      event.preventDefault();
      stepSibling(-1);
    }
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
    default:
      return;
  }
  event.preventDefault();
});

// Drag and drop, straight from the OS. Several files at once open as tabs, and
// the first one is the one you end up looking at.
listen('tauri://drag-drop', async (event) => {
  const paths = event.payload?.paths || [];
  for (const path of paths) {
    await openPath(path);
  }
  if (paths.length > 1) {
    await activateTab(state.tabs.findIndex((tab) => tab.path === paths[0]));
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
  // Rebuilding with the window minimised is the common case in a compile loop;
  // re-parsing a document nobody is looking at is pure waste. Catch up on the
  // newest revision when the window comes back.
  if (document.visibilityState === 'hidden') {
    state.pendingRevision = revision;
    return;
  }
  await openFile({ ...state.file, revision }, { preserveView: true });
  setStatus('Reloaded');
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || state.pendingRevision === null) {
    return;
  }
  const revision = state.pendingRevision;
  state.pendingRevision = null;
  if (state.file) {
    await openFile({ ...state.file, revision }, { preserveView: true });
  }
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

// Command-line flags style this launch without changing saved preferences.
const launch = await invoke('launch_options').catch(() => ({}));
if (launch?.poll !== null && launch?.poll !== undefined) {
  ui.poll.value = String(launch.poll);
}
if (launch?.mode) {
  const requested = launch.mode === 'clear' ? null : launch.mode;
  if (requested === null || PAGE_MODES.includes(requested)) {
    setMode(requested, false);
  }
}

const initial = await invoke('initial_file');
if (initial) {
  await openInTab(initial);
  // Extra paths on the command line become tabs; the first one stays showing.
  for (const path of launch?.rest || []) {
    await openPath(path);
  }
  if (state.tabs.length > 1) {
    await activateTab(0);
  }
  if (launch?.dock) {
    await toggleDock();
  }
}
ui.container.focus();
