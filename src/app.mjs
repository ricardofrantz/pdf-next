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

/** A folder under the vendored PDF.js, as an absolute URL. */
function vendorUrl(folder) {
  return new URL(`./vendor/pdfjs/${folder}`, document.baseURI).href;
}

// A rendered page canvas is the dominant per-document cost: one A4 page at 200%
// on a 2x display is ~30 MB of RGBA. Raising this to 2^23 (which would keep a
// docked fit-width page on PDF.js's single-canvas path) measured worse here, so
// it stays where it is until someone measures the docked case properly.
const MAX_CANVAS_PIXELS = 4_194_304;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6];
const PAGE_MODES = ['night', 'sepia', 'invert'];
// null is plain pages: a real stop, so white is always one press away rather
// than something you have to know a modifier for.
const MODE_CYCLE = [null, 'night', 'invert', 'sepia'];
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
  raw: el('raw'),
  dockButtons: {
    left: el('dockLeft'),
    right: el('dockRight'),
    top: el('dockTop'),
    bottom: el('dockBottom'),
    center: el('dockCenter'),
  },
  tabs: el('tabs'),
  stage: el('stage'),
  imagePrev: el('imagePrev'),
  imageNext: el('imageNext'),
  imageIndex: el('imageIndex'),
  poll: el('poll'),
  waiting: el('waiting'),
  update: el('update'),
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
  imageBox: el('imageBox'),
  imageStage: el('imageStage'),
  rotate: el('rotate'),
  markdown: el('markdown'),
  markdownRaw: el('markdownRaw'),
  markdownStage: el('markdownStage'),
  print: el('print'),
  printPages: el('printPages'),
  printRules: el('printRules'),
  status: el('status'),
};

const state = {
  file: null,
  document: null,
  task: null,
  mode: null,
  natural: null,
  /// Which screen half the window fills, or null when it is free.
  docked: null,
  wrap: false,
  imageScale: 'fit',
  /// Quarter turns clockwise, as degrees: 0, 90, 180 or 270. Per view, not per
  /// file — a fresh open comes up upright.
  imageRotation: 0,
  markdownScale: 1,
  markdownRaw: false,
  statusTimer: 0,
  /// This build and its platform, from Rust; and the newer release a check
  /// found, if any — { version, url } — which turns the button into a download.
  version: '',
  platform: '',
  update: null,
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

// ── Title ─────────────────────────────────────────────────────────────────

/// The window title carries the build, so "which version are you on?" is
/// answered by looking at the window rather than by hunting for an about box.
/// The version arrives from Rust a moment after the first paint, which is why
/// this is a function and not a constant.
///
/// document.title alone is not enough: WebView2 never passes it to the window,
/// so on Windows the frame kept saying "pdf-next" whatever was open. Rust sets
/// the real one; document.title is set too, for the platforms that follow it.
let sentTitle = null;

function setTitle(name) {
  const app = state.version ? `pdf-next ${state.version}` : 'pdf-next';
  const title = name ? `${name} — ${app}` : app;
  document.title = title;
  // A reload every second would otherwise cross the IPC boundary every second
  // to set the title it already has.
  if (title === sentTitle) {
    return;
  }
  sentTitle = title;
  invoke('set_title', { title }).catch(() => {});
}

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
      rotation: state.imageRotation,
      top: ui.imageStage.scrollTop,
      left: ui.imageStage.scrollLeft,
    };
  }
  if (state.file?.kind === 'markdown') {
    return {
      kind: 'markdown',
      scale: state.markdownScale,
      raw: state.markdownRaw,
      top: ui.markdownStage.scrollTop,
      left: ui.markdownStage.scrollLeft,
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
  if (!view || view.kind !== 'pdf') {
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
  setImageRotation(view.rotation || 0, { refit: false });
  setImageScale(view.scale, { refit: false });
  ui.imageStage.scrollTop = view.top;
  ui.imageStage.scrollLeft = view.left;
}

// ── Loading ───────────────────────────────────────────────────────────────

// Served by the doc protocol with Cache-Control: no-store, so the webview's
// HTTP cache never accumulates a copy per revision. The revision query still
// matters: it makes each reload a distinct URL, so nothing in the pipeline can
// answer from memory.
function sourceUrl(file) {
  return `${convertFileSrc(file.path, 'doc')}?v=${file.revision}`;
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

// Parsed once and kept: the map is consulted on every open and every resize,
// and re-parsing JSON out of localStorage each time is pure waste.
let sizesCache = null;

function readSizes() {
  if (sizesCache) {
    return sizesCache;
  }
  try {
    sizesCache = JSON.parse(localStorage.getItem(SIZE_KEY) || '{}');
  } catch {
    sizesCache = {};
  }
  return sizesCache;
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
  layoutImage();
  updateZoomControl(value === 'fit' ? 'auto' : String(value), imageScale());
  if (refit) {
    scheduleWrap();
  }
}

/// The picture's natural size as it reads on screen: a quarter turn swaps
/// width and height.
function turnedNatural() {
  const { naturalWidth: width, naturalHeight: height } = ui.image;
  return state.imageRotation % 180 === 0 ? [width, height] : [height, width];
}

/// The stage's padding, which fit-width has to leave alone on each side.
function stagePadding() {
  const style = getComputedStyle(ui.imageStage);
  return [
    Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight),
    Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
  ];
}

/// Size the picture and its box for the current scale and rotation.
///
/// Upright, the stylesheet does the work: the box wraps the image, and 'fit'
/// is max-width:100%. Turned, the box is given the turned picture's size —
/// scale times the swapped natural size, or the stage width for 'fit' — and
/// the image inside is given its own, unturned size, then rotated in place by
/// the stylesheet. Scrolling, zoom, wrap and the window fit all read the box.
function layoutImage() {
  const rotation = state.imageRotation;
  const { naturalWidth: width, naturalHeight: height } = ui.image;
  ui.imageBox.style.setProperty('--image-turn', `${rotation}deg`);
  document.body.classList.toggle('image-turned', rotation !== 0);

  if (rotation === 0 || !width) {
    ui.imageBox.style.width = '';
    ui.imageBox.style.height = '';
    if (state.imageScale === 'fit' || !width) {
      ui.image.style.width = '';
      ui.image.style.height = '';
    } else {
      ui.image.style.width = `${Math.round(width * state.imageScale)}px`;
      ui.image.style.height = 'auto';
    }
    return;
  }

  const [turnedWidth, turnedHeight] = turnedNatural();
  let shownWidth;
  if (typeof state.imageScale === 'number') {
    shownWidth = turnedWidth * state.imageScale;
  } else {
    const [padX] = stagePadding();
    shownWidth = Math.min(turnedWidth, ui.imageStage.clientWidth - padX);
  }
  const shownHeight = (shownWidth * turnedHeight) / turnedWidth;
  const quarter = rotation % 180 !== 0;
  ui.imageBox.style.width = `${Math.round(shownWidth)}px`;
  ui.imageBox.style.height = `${Math.round(shownHeight)}px`;
  ui.image.style.width = `${Math.round(quarter ? shownHeight : shownWidth)}px`;
  ui.image.style.height = `${Math.round(quarter ? shownWidth : shownHeight)}px`;
}

/// One button, a quarter turn clockwise per press; four presses is upright.
/// The zoom is untouched — 100% is still one picture pixel per screen pixel —
/// so only the box changes shape, and the window follows it when wrapping.
function setImageRotation(degrees, { refit = true } = {}) {
  state.imageRotation = ((degrees % 360) + 360) % 360;
  const turned = state.imageRotation !== 0;
  ui.rotate.classList.toggle('on', turned);
  ui.rotate.setAttribute('aria-pressed', String(turned));
  ui.rotate.title = turned
    ? `Rotated ${state.imageRotation}° — click for another quarter turn`
    : 'Rotate a quarter turn clockwise';
  ui.rotate.setAttribute('aria-label', ui.rotate.title);
  layoutImage();
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
  const [width, height] = turnedNatural();
  if (!width || !height) {
    return 1;
  }
  const [padX, padY] = stagePadding();
  return Math.min(
    (ui.imageStage.clientWidth - padX) / width,
    (ui.imageStage.clientHeight - padY) / height,
  );
}

// ── Markdown ──────────────────────────────────────────────────────────────

// A reading column plus its margins. The window a fresh markdown file opens
// into, before the reader resizes it and the per-file memory takes over.
const MARKDOWN_WINDOW_WIDTH = 780;

/// Rendered or raw. Both nodes stay in the DOM with the same content, so the
/// toggle is a visibility flip — no re-render, no IPC round trip.
function setRaw(on, { persist = true } = {}) {
  state.markdownRaw = on;
  ui.markdown.hidden = on;
  ui.markdownRaw.hidden = !on;
  ui.raw.classList.toggle('on', on);
  ui.raw.setAttribute('aria-pressed', String(on));
  if (!persist) {
    return;
  }
  try {
    localStorage.setItem('pdf-next.md-raw', on ? '1' : '');
  } catch {
    // Preference only.
  }
}

/// Markdown zoom is CSS zoom on the column: the text reflows at the new size,
/// which is what zooming prose should do — no bitmap scaling involved.
function setMarkdownScale(scale) {
  state.markdownScale = scale;
  ui.markdown.style.zoom = String(scale);
  ui.markdownRaw.style.zoom = String(scale);
  updateZoomControl(String(scale), scale);
  scheduleWrap();
}

/// The HTML arrives already sanitized — ammonia ran on the Rust side — so
/// assigning innerHTML here does not hand the document a script surface, and
/// the CSP forbids inline script besides.
async function showMarkdown(file, view, generation, fit) {
  await releaseDocument();
  const doc = await invoke('read_markdown', { path: file.path });
  if (state.generation !== generation) {
    return;
  }
  ui.markdown.innerHTML = doc.html;
  ui.markdownRaw.textContent = doc.raw;
  setRaw(view?.raw ?? state.markdownRaw, { persist: false });
  setMarkdownScale(view?.scale || 1);
  // Measured with the content laid out; used by undock as well as the fit.
  state.natural = {
    width: MARKDOWN_WINDOW_WIDTH,
    height: Math.max(ui.markdownStage.scrollHeight, 320),
  };
  if (view) {
    ui.markdownStage.scrollTop = view.top;
    ui.markdownStage.scrollLeft = view.left;
    return;
  }
  ui.markdownStage.scrollTop = 0;
  if (!fit) {
    return;
  }
  const saved = rememberedSize(file.path);
  if (saved) {
    await fitWindow(saved[0], saved[1], false);
  } else {
    // Exact: a long document clamps to the screen height without dragging the
    // width down with it, which aspect preservation would do.
    await fitWindow(
      MARKDOWN_WINDOW_WIDTH,
      state.natural.height + chromeHeight(),
      true,
      true,
    );
  }
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
    // The box, not the image: turned a quarter, the image's own box is the
    // wrong way round.
    return [Math.ceil(ui.imageBox.offsetWidth), Math.ceil(ui.imageBox.offsetHeight)];
  }
  if (state.file?.kind === 'markdown') {
    // The column as laid out, and the whole scroll height: prose has no page,
    // so wrapping it means a window the height of the document, up to the
    // screen.
    return [
      Math.ceil(ui.markdown.offsetWidth || MARKDOWN_WINDOW_WIDTH),
      Math.ceil(ui.markdownStage.scrollHeight),
    ];
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
let holdTimer = 0;

/// The app is about to resize the window itself. The resize listener must not
/// take that for a size the reader chose and remember it; the hold lasts long
/// enough for the resize to land and its event to fire.
function holdResize() {
  wrapping = true;
  window.clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => {
    wrapping = false;
  }, 700);
}

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
  holdResize();
  try {
    await fitWindow(size[0], size[1], false, true);
  } finally {
    // Restart the hold now the call has returned, so it covers the resize
    // event that follows rather than the round trip that preceded it.
    holdResize();
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
    setDocked(null);
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
    // The doc protocol answers full GETs only (no Accept-Ranges), so range
    // options would be inert. One streamed read per load is what happens.
    disableRange: true,
    // Absolute, because the worker fetches these itself and a relative path
    // would resolve against the worker's own folder. A wrong folder is a
    // quiet 404: CJK text loses its glyphs, and a scanned page (CCITT and
    // JBIG2 both decode in jbig2.wasm) comes up white.
    cMapUrl: vendorUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl('standard_fonts/'),
    wasmUrl: vendorUrl('wasm/'),
    iccUrl: vendorUrl('iccs/'),
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
  if (!view) {
    // A new picture comes up upright. Reset before the swap so the old turn
    // is not applied to the new bitmap for the frame it takes to decode.
    setImageRotation(0, { refit: false });
  }
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
  // Pages rendered for paper belong to the document that was open then — but
  // not while a dialog is holding them: a rebuild lands every second in the
  // loop this app is for, and clearing here would print blank sheets.
  if (!printPending) {
    clearPrintPages();
  }
  const supported = ['pdf', 'image', 'markdown'].includes(file.kind);
  if (!supported) {
    // Nothing can show this, so nothing of the previous file should stay
    // behind it: the empty state comes back, not a stage with a stale PDF.
    state.file = null;
    state.natural = null;
    await releaseDocument();
    ui.image.removeAttribute('src');
    ui.markdown.textContent = '';
    ui.markdownRaw.textContent = '';
    document.body.classList.remove(
      'has-file',
      'kind-pdf',
      'kind-image',
      'kind-markdown',
      'file-missing',
    );
    setTitle('');
    setStatus(`Unsupported file type: ${file.name}`, { error: true, sticky: true });
    return;
  }
  state.file = file;
  document.body.classList.add('has-file');
  document.body.classList.toggle('kind-pdf', file.kind === 'pdf');
  document.body.classList.toggle('kind-image', file.kind === 'image');
  document.body.classList.toggle('kind-markdown', file.kind === 'markdown');
  setTitle(file.name);

  // Free what the outgoing kind was holding: a decoded bitmap or a rendered
  // markdown DOM kept behind another tab is memory doing nothing.
  if (file.kind !== 'image') {
    ui.image.removeAttribute('src');
  }
  if (file.kind !== 'markdown') {
    ui.markdown.textContent = '';
    ui.markdownRaw.textContent = '';
  }

  try {
    if (file.kind === 'pdf') {
      await showPdf(file, view, generation);
    } else if (file.kind === 'image') {
      showImage(file, !view && !keepWindow, view);
      void loadSiblings(file);
    } else if (file.kind === 'markdown') {
      await showMarkdown(file, view, generation, !view && !keepWindow);
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

async function openPath(path, { activate = true, target = null } = {}) {
  try {
    const file = await invoke('open_path', { path });
    await openInTab(file, { activate, target });
  } catch (error) {
    setStatus(String(error), { error: true, sticky: true });
  }
}

// ── Landing somewhere in particular ───────────────────────────────────────
//
// `pdf-next paper.pdf --page 12`, or the same written as a link,
// `paper.pdf#page=12&search=Figure%203`. The fields are the ones PDF links
// have used for years, so a reference that opens in a browser opens here.

/// Keep only the fields that say something, and nothing at all if none do.
/// Rust sends every field on every open, most of them null.
function asTarget(value) {
  if (!value) {
    return null;
  }
  const page = Number.isFinite(value.page) && value.page >= 1 ? Math.round(value.page) : null;
  const nameddest = value.nameddest || null;
  const search = value.search || null;
  return page || nameddest || search ? { page, nameddest, search } : null;
}

/// A file to open, however it arrived: a bare path from a drop or an Apple
/// Event, or a path with a target from the command line.
function asOpening(value) {
  if (typeof value === 'string') {
    return { path: value, target: null };
  }
  const path = value?.path;
  return typeof path === 'string' ? { path, target: asTarget(value.target) } : null;
}

/// Land where the caller asked. Called once the document is up, because a page
/// number means nothing to PDF.js before there are pages, and because a search
/// runs from the page you are on — so `#page=5&search=Figure` finds the first
/// "Figure" at or after page 5.
async function applyTarget(target) {
  if (!target || state.file?.kind !== 'pdf' || !state.document) {
    return;
  }
  if (target.nameddest) {
    try {
      await linkService.goToDestination(target.nameddest);
    } catch {
      setStatus(`No destination named ${target.nameddest}`, { error: true });
    }
  }
  if (target.page) {
    const landed = Math.min(target.page, pdfViewer.pagesCount || 1);
    pdfViewer.currentPageNumber = landed;
    if (landed !== target.page) {
      setStatus(`Page ${target.page} is past the end — showing ${landed}`);
    }
  }
  if (target.search) {
    // The find bar opens showing what was asked for, and keeps the count, but
    // does not take the keyboard: the reader is here to read.
    ui.findInput.value = target.search;
    ui.find.hidden = false;
    runFind();
  }
  updatePageControls();
}

/// A target is an instruction, not a property of the tab: it fires once, and
/// afterwards the tab remembers the place you left it like any other.
async function consumeTarget(tab) {
  const target = tab?.target;
  if (!target) {
    return;
  }
  tab.target = null;
  await applyTarget(target);
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
///
/// `activate: false` adds the tab and loads nothing: ten files dropped at once
/// cost one parse, not ten, and the one you are looking at stays put. A file
/// already open is left alone in that case.
async function openInTab(file, { activate = true, target = null } = {}) {
  const existing = state.tabs.findIndex((tab) => tab.path === file.path);
  if (existing >= 0) {
    // A file that is already open is aimed rather than opened twice: a second
    // `pdf-next paper.pdf --page 12` moves the tab you are reading. If it is a
    // background tab, the target waits there until you switch to it.
    if (target) {
      state.tabs[existing].target = target;
    }
    if (activate) {
      await activateTab(existing, { force: true });
    } else if (existing === state.active) {
      // Already the one showing: aim it where it stands, without a re-parse.
      await consumeTarget(state.tabs[existing]);
    }
    return;
  }
  const entry = { path: file.path, name: file.name, kind: file.kind, target };
  if (!activate) {
    // Appended, not inserted next to the active tab: files that arrive
    // together must keep the order they arrived in.
    state.tabs.push(entry);
    renderTabs();
    return;
  }
  const at = state.active < 0 ? state.tabs.length : state.active + 1;
  stashView();
  state.tabs.splice(at, 0, entry);
  state.active = at;
  renderTabs();
  await openFile(file);
  await consumeTarget(entry);
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
    // After the remembered view, not before: an explicit page wins over where
    // this tab was last left.
    await consumeTarget(tab);
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
  ui.markdown.textContent = '';
  ui.markdownRaw.textContent = '';
  setImageRotation(0, { refit: false });
  setImageScale('fit', { refit: false });
  document.body.classList.remove(
    'has-file',
    'kind-pdf',
    'kind-image',
    'kind-markdown',
    'file-missing',
  );
  setTitle('');
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
  const kind = state.file?.kind;
  const image = kind === 'image';
  const markdown = kind === 'markdown';
  if (!image && !markdown && !state.document) {
    return;
  }
  const current = image
    ? imageScale()
    : markdown
      ? state.markdownScale
      : pdfViewer.currentScale;
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > current + 0.001)
      : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001);
  if (!next) {
    return;
  }
  if (image) {
    setImageScale(next);
  } else if (markdown) {
    setMarkdownScale(next);
  } else {
    pdfViewer.currentScaleValue = String(next);
  }
}

/// The preset ladder means something slightly different for a bare image: there
/// is no page, so "fit page" is the scale that contains it and the other two
/// fits are the CSS default, which fills the width and lets the height run.
function applyZoomChoice(value) {
  if (state.file?.kind === 'markdown') {
    // Prose has no page to fit; every preset lands back at the natural size.
    const scale = Number(value);
    setMarkdownScale(Number.isFinite(scale) && scale > 0 ? scale : 1);
    return;
  }
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

/// Page colors are drawn into the page canvas, not laid over it, so changing
/// them only shows once the canvas is drawn again. Setting the colors and
/// calling refresh() is not that: refresh() goes through PDFPageView.update(),
/// which — with the page geometry unchanged — resets with keepCanvasWrapper
/// and never calls _resetCanvas(). The old bitmap stays, so leaving sepia used
/// to give a white page with brown text. Dropping each canvas is the fix.
function applyPageColors() {
  const pageColors = PAGE_COLORS[state.mode] || null;
  pdfViewer.pageColors = pageColors;
  const pages = pdfViewer._pages;
  if (!Array.isArray(pages) || !state.document) {
    return;
  }
  for (const pageView of pages) {
    pageView.pageColors = pageColors;
    try {
      // No keepCanvasWrapper: the canvas has to go or the old colors stay.
      pageView.reset();
    } catch {
      // A page that will not reset is redrawn by the next update anyway.
    }
  }
  pdfViewer.update();
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
  const index = MODE_CYCLE.indexOf(state.mode ?? null);
  setMode(MODE_CYCLE[(index + 1) % MODE_CYCLE.length]);
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

// ── Printing ──────────────────────────────────────────────────────────────
//
// One route for all three platforms and all three kinds: lay the document out
// for paper in the webview, then ask the system for its own print dialog — the
// print panel on macOS, the GTK dialog on Linux, the print window every other
// application opens on Windows. Printer, page range, copies, duplex, scaling
// and paper size are the system's to offer; this app has no print settings of
// its own to get wrong, and nothing to keep in sync with three platforms'
// idea of a printer.
//
// Markdown and the raw view print themselves — they are HTML, and the print
// stylesheet reflows them across pages. A PDF cannot: the viewer only ever
// renders the pages you can see, at screen resolution, possibly inverted. So
// every page is rendered again here, at print resolution, on white, into
// #printPages, which is what the dialog then sees. Images take the same route
// for the same reason: one page, one picture, no window chrome.

/// 150 dpi against PDF's 72, the resolution PDF.js itself prints at: sharp on
/// paper without making a 300-page document a gigabyte of canvas.
const PRINT_UNITS = 150 / 72;

/// A print is being prepared: the pages are still being rendered.
let printing = false;
/// The pages are laid out and a dialog has them. This is the one that matters:
/// the dialog outlives the call that opened it on Windows and macOS, and this
/// app reloads the document once a second, so without it the next rebuild —
/// the whole reason the app exists — would empty the DOM the dialog is about
/// to print.
let printPending = false;
/// Whether the window has lost focus since those pages were handed over, which
/// is how the dialog closing is recognised where `afterprint` may not fire.
let printBlurred = false;

/// Drop the rendered pages and the object URLs holding their bitmaps.
///
/// The pages are not kept around: they are the largest thing this app ever
/// allocates, and a document that has been printed once is no more likely to
/// be printed again. Only blob URLs are revoked — an image prints through the
/// same doc:// URL the window is showing, and revoking that would take the
/// picture off the screen.
function clearPrintPages() {
  for (const img of ui.printPages.querySelectorAll('img')) {
    if (img.src.startsWith('blob:')) {
      URL.revokeObjectURL(img.src);
    }
  }
  ui.printPages.textContent = '';
  ui.printRules.textContent = '';
}

/// The dialog is done with the pages: drop them.
function finishPrint() {
  if (!printPending) {
    return;
  }
  printPending = false;
  printBlurred = false;
  clearPrintPages();
}

/// Render every page of the open PDF onto paper-sized images.
///
/// One canvas is reused for all of them and released at the end, so the peak
/// cost is a single page rather than the whole document; what stays is one PNG
/// per page, which is what the print dialog needs in the DOM to offer a page
/// range at all.
async function renderPrintPages(generation) {
  const pdf = state.document;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });

  for (let number = 1; number <= pdf.numPages; number += 1) {
    if (state.generation !== generation) {
      return false; // the file changed under us; that print is stale
    }
    if (pdf.numPages > 4) {
      setStatus(`Preparing page ${number} of ${pdf.numPages}…`, { sticky: true });
    }

    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    canvas.width = Math.floor(viewport.width * PRINT_UNITS);
    canvas.height = Math.floor(viewport.height * PRINT_UNITS);
    // Paper is white whatever the reader's page mode is; a night-mode PDF must
    // not come out of the printer as a solid black rectangle.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: context,
      viewport,
      transform: [PRINT_UNITS, 0, 0, PRINT_UNITS, 0, 0],
      intent: 'print',
    }).promise;
    page.cleanup();

    if (number === 1) {
      // The paper takes the shape of the page, so an A4 document prints at true
      // size on A4 and a landscape slide comes out landscape. Pages of mixed
      // size follow the first, as they do in every other PDF viewer.
      ui.printRules.textContent = `@page { size: ${Math.round(viewport.width)}pt ${Math.round(
        viewport.height,
      )}pt; margin: 0 }`;
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      throw new Error(`page ${number} could not be rendered`);
    }
    const wrapper = document.createElement('div');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.alt = '';
    wrapper.append(img);
    ui.printPages.append(wrapper);
    await img.decode().catch(() => {});
  }

  // Releasing the backing store matters more than the canvas object: a
  // letter-size page at 150 dpi is 5 MB that nothing else would free.
  canvas.width = 0;
  canvas.height = 0;
  return true;
}

/// Ctrl/Cmd+P, and the toolbar button.
async function printDocument() {
  if (!state.file || printing) {
    return;
  }
  printing = true;
  printPending = false;
  printBlurred = false;
  clearPrintPages();
  const generation = state.generation;
  let failed = false;

  try {
    if (state.file.kind === 'pdf') {
      // No document, or a rebuild overtook this print: nothing to send.
      if (!state.document || !(await renderPrintPages(generation))) {
        return;
      }
    } else if (state.file.kind === 'image') {
      const img = document.createElement('img');
      img.src = ui.image.src;
      img.alt = '';
      const wrapper = document.createElement('div');
      wrapper.append(img);
      ui.printPages.append(wrapper);
      await img.decode().catch(() => {});
    }
    setStatus('');
    // Claimed before the call, not after: on Linux the dialog blocks and this
    // does not return until it has been closed.
    printPending = true;
    await invoke('print_document');
  } catch (error) {
    failed = true;
    printPending = false;
    setStatus(`Could not print: ${error?.message || error}`, { error: true, sticky: true });
  } finally {
    printing = false;
    // Every way out that never reached a dialog leaves half-built pages and a
    // "preparing page 3 of 40" that nothing else would ever clear.
    if (!printPending) {
      clearPrintPages();
      if (!failed) {
        setStatus('');
      }
    }
  }
}

// Two ways to hear that the dialog has gone. `afterprint` is the direct one,
// and Windows fires it — measured, including when the system dialog opens onto
// a machine with no print spooler at all. macOS and Linux never go through
// window.print(), so there the window coming back after losing focus stands in
// for it, where it fires: a sheet on macOS may never give the page a blur, and
// the price of missing it is pages held until the next print rather than
// anything printed wrongly.
//
// Windows is left out of that fallback deliberately. Its dialog is a separate
// window and this one stays clickable behind it, so clicking back would
// otherwise throw away the pages the dialog is still holding — the bug this
// whole flag exists to prevent, through a different door.
window.addEventListener('afterprint', finishPrint);
window.addEventListener('blur', () => {
  printBlurred = printPending;
});
window.addEventListener('focus', () => {
  if (printBlurred && state.platform !== 'windows') {
    finishPrint();
  }
});

/// Five targets, one function. An edge fills that half of the screen; center —
/// or the edge the window is already on — undocks: the automatic fit, the
/// window wrapped around the page again, at fit-page.
///
/// Docking anywhere fits the width: a half-screen window is there to be read
/// in, and fit-page in one shrinks the text to fit a shape you did not choose.
/// A short top or bottom half does leave the rest of the page below the fold,
/// which is what scrolling is for. Resizing keeps the scroll offset in
/// pixels, which lands on a different page once the layout reflows, so the
/// reader goes back where it was either way.
async function dockTo(edge) {
  const page = state.document ? pdfViewer.currentPageNumber : 0;
  const undocking = edge === 'center' || state.docked === edge;
  // Docking sets an explicit half-screen size, which wrap would immediately
  // undo. Only one of them can own the window.
  if (state.wrap) {
    window.clearTimeout(wrapTimer);
    setWrap(false);
  }

  // A half-screen window is the app's choice, not the reader's: it must not be
  // remembered as the size to reopen this file at.
  holdResize();
  try {
    if (undocking) {
      const auto = autoWindowSize();
      if (!auto) {
        return;
      }
      await fitWindow(auto[0], auto[1], true);
    } else {
      await invoke('snap', { edge });
    }
  } catch {
    return;
  } finally {
    holdResize();
  }

  setDocked(undocking ? null : edge);
  if (!state.document) {
    return;
  }
  // The preset is set now; the container observer re-applies it once the window
  // has actually changed shape. The delay is for the page: restoring it before
  // the reflow lands puts the scroll offset on the old layout.
  pdfViewer.currentScaleValue = undocking ? 'page-fit' : 'page-width';
  window.setTimeout(() => {
    if (page > 1) {
      pdfViewer.currentPageNumber = page;
    }
  }, 160);
}

function setDocked(edge) {
  state.docked = edge;
  for (const [name, button] of Object.entries(ui.dockButtons)) {
    if (name === 'center') {
      continue; // an action, not a state — it never lights up
    }
    button.classList.toggle('on', edge === name);
    button.setAttribute('aria-pressed', String(edge === name));
  }
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
ui.print.addEventListener('click', printDocument);
// ── Updates ───────────────────────────────────────────────────────────────
//
// One button, and one check at launch. Starting the app asks GitHub for the
// latest release, once, a moment after the first paint; a press asks again.
// If it is newer the button lights up and becomes the download — opened in
// your browser, so the file arrives visibly, from the repo, the same way a
// first install does. Nothing polls: there is no timer and no background
// check, and the launch check is the only network request the app makes on
// its own.

const RELEASES_API =
  'https://api.github.com/repos/ricardofrantz/pdf-next/releases/latest';

/// `v0.6.0` or `0.6.0` → [0, 6, 0]; anything else → null.
function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text || '');
  return match ? match.slice(1, 4).map(Number) : null;
}

function isNewer(candidate, current) {
  for (let i = 0; i < 3; i += 1) {
    if (candidate[i] !== current[i]) {
      return candidate[i] > current[i];
    }
  }
  return false;
}

/// The installer for this platform, in order of preference; null when the
/// release has none, in which case the release page itself is the target.
function pickAsset(assets, platform) {
  const preferred = {
    windows: [/-setup\.exe$/i, /\.msi$/i],
    macos: [/\.dmg$/i],
    linux: [/\.AppImage$/i, /\.deb$/i, /\.rpm$/i],
  }[platform] || [];
  for (const pattern of preferred) {
    const asset = assets.find((entry) => pattern.test(entry?.name || ''));
    if (asset?.browser_download_url) {
      return asset.browser_download_url;
    }
  }
  return null;
}

/// A press, or the one check at launch. `quiet` is the launch: it says
/// nothing unless there is a newer release, so an offline machine or a
/// current build gets no message at all.
async function checkForUpdates({ quiet = false } = {}) {
  if (state.update) {
    try {
      await invoke('open_download', { url: state.update.url });
      setStatus(`Downloading pdf-next ${state.update.version} in your browser`);
    } catch (error) {
      setStatus(String(error), { error: true });
    }
    return;
  }
  ui.update.disabled = true;
  if (!quiet) {
    setStatus('Checking for updates…', { sticky: true });
  }
  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status}`);
    }
    const release = await response.json();
    const latest = parseVersion(release?.tag_name);
    const current = parseVersion(state.version);
    if (!latest || !current) {
      throw new Error('could not read the version number');
    }
    if (!isNewer(latest, current)) {
      if (!quiet) {
        setStatus(`You have the latest version (${state.version})`);
      }
      return;
    }
    const version = latest.join('.');
    const url = pickAsset(release?.assets || [], state.platform) || release?.html_url;
    if (typeof url !== 'string') {
      throw new Error('the release has nothing to download');
    }
    state.update = { version, url };
    ui.update.classList.add('available');
    ui.update.title = `Download pdf-next ${version}`;
    ui.update.setAttribute('aria-label', ui.update.title);
    setStatus(
      quiet
        ? `pdf-next ${version} is available — press the update button to download it`
        : `pdf-next ${version} is available — press the button again to download it`,
      { sticky: true },
    );
  } catch (error) {
    if (!quiet) {
      setStatus(`Could not check for updates: ${error?.message || error}`, {
        error: true,
      });
    }
  } finally {
    ui.update.disabled = false;
  }
}

ui.update.addEventListener('click', () => checkForUpdates());
ui.wrap.addEventListener('click', toggleWrap);
ui.raw.addEventListener('click', () => setRaw(!state.markdownRaw));

// A link in a markdown file must not leave the page. A relative one —
// `[notes](other.md)` — resolves against the app origin, which the navigation
// guard trusts, so following it would replace the viewer with a blank 404 and
// no way back. Rust now refuses relative URLs too; this is the second lock.
// Only same-page anchors — footnotes, and headings that carry an id — do
// anything, and they scroll rather than navigate.
ui.markdown.addEventListener('click', (event) => {
  const anchor =
    event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!anchor) {
    return;
  }
  event.preventDefault();
  const href = anchor.getAttribute('href') || '';
  if (href.startsWith('#')) {
    // Same page: footnotes, and links to headings.
    let id;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const target = id && ui.markdown.querySelector(`[id="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ block: 'start' });
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    // The web: the system browser's, never this window's.
    void invoke('open_link', { url: href }).catch((error) => {
      setStatus(String(error), { error: true });
    });
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return;
  }
  // A path next to this file: another note, a figure, the paper it cites.
  // Opened as a tab when it is a kind pdf-next shows; the backend says so
  // otherwise.
  const target = siblingPath(href);
  if (target) {
    void openPath(target);
  }
});

/** A relative link, resolved against the folder of the file being read. */
function siblingPath(href) {
  const bare = href.split(/[?#]/, 1)[0];
  let relative;
  try {
    relative = decodeURIComponent(bare);
  } catch {
    return null;
  }
  const from = state.file?.path;
  if (!relative || !from) {
    return null;
  }
  const cut = Math.max(from.lastIndexOf('/'), from.lastIndexOf('\\'));
  return from.slice(0, cut + 1) + relative;
}
for (const [edge, button] of Object.entries(ui.dockButtons)) {
  button.addEventListener('click', () => dockTo(edge));
}
ui.imagePrev.addEventListener('click', () => stepSibling(-1));
ui.imageNext.addEventListener('click', () => stepSibling(1));
ui.rotate.addEventListener('click', () => setImageRotation(state.imageRotation + 90));

// A turned picture at 'fit' is sized by script, not by max-width, so it has to
// be laid out again when the stage changes shape. Upright it costs nothing.
new ResizeObserver(() => {
  if (state.file?.kind === 'image' && state.imageRotation !== 0 && state.imageScale === 'fit') {
    layoutImage();
  }
}).observe(ui.imageStage);

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

// A preset — fit page, fit width, auto — is a promise about the viewport, and
// PDF.js on its own only keeps it at the size the viewport had when it was
// chosen. Re-applying the same preset makes it recompute; it says nothing if
// the scale comes out unchanged. Watched on the container rather than the
// window, because the tab strip appearing takes height off the viewport
// without the window changing at all. One frame per burst of resize events.
let refitFrame = 0;
new ResizeObserver(() => {
  if (!state.document || !Number.isNaN(Number.parseFloat(pdfViewer.currentScaleValue))) {
    return;
  }
  window.cancelAnimationFrame(refitFrame);
  refitFrame = window.requestAnimationFrame(() => {
    if (state.document) {
      pdfViewer.currentScaleValue = pdfViewer.currentScaleValue;
    }
  });
}).observe(ui.container);

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
  if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
    const dockKeys = {
      arrowleft: 'left',
      arrowright: 'right',
      arrowup: 'top',
      arrowdown: 'bottom',
      enter: 'center',
    };
    if (dockKeys[key]) {
      event.preventDefault();
      void dockTo(dockKeys[key]);
      return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'f') {
    event.preventDefault();
    void toggleWrap();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'u') {
    event.preventDefault();
    if (state.file?.kind === 'markdown') {
      setRaw(!state.markdownRaw);
    }
    return;
  }
  // WebView2 has Ctrl+P of its own, and it would print the viewer as it stands
  // on screen — window chrome, one visible page. Ours has to win.
  if ((event.ctrlKey || event.metaKey) && key === 'p') {
    event.preventDefault();
    void printDocument();
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
  // The same reading keys work on a markdown column as on a PDF.
  if (state.file?.kind === 'markdown') {
    switch (key) {
      case 'j':
        ui.markdownStage.scrollBy({ top: 90 });
        break;
      case 'k':
        ui.markdownStage.scrollBy({ top: -90 });
        break;
      case 'g':
        ui.markdownStage.scrollTo({
          top: event.shiftKey ? ui.markdownStage.scrollHeight : 0,
        });
        break;
      default:
        return;
    }
    event.preventDefault();
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

// Files arriving from outside: dropped on the window, double-clicked in the
// Finder, or handed over by a second `pdf-next file.pdf` while this one runs.
// Several at once open as tabs, and the first one is the one you end up
// looking at.
async function openMany(items) {
  const [first, ...rest] = items.map(asOpening).filter(Boolean);
  if (first === undefined) {
    return;
  }
  await openPath(first.path, { target: first.target });
  // The rest become tabs and nothing more: a tab is read from disk when it is
  // switched to, so loading it now would be a parse nobody sees. A target
  // travels with the tab and fires when you get there.
  for (const item of rest) {
    await openPath(item.path, { activate: false, target: item.target });
  }
}

listen('tauri://drag-drop', (event) => openMany(event.payload?.paths || []));
// Registered before startup asks for `pending_files`, so nothing can fall in
// the gap between the two.
const openFilesReady = listen('open-files', (event) =>
  openMany(Array.isArray(event.payload) ? event.payload : []),
);

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
  if (document.visibilityState === 'hidden') {
    // A hidden window does not need warm font and image caches; they rebuild
    // lazily on return. cleanup() refuses to run mid-render, which is fine —
    // that tick is simply skipped.
    try {
      await state.document?.cleanup();
    } catch {
      // Rendering in flight; nothing to free this time.
    }
    return;
  }
  if (state.pendingRevision === null) {
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

// Raw markdown is a way of reading, not a per-file quirk, so it is a global
// preference like the page mode.
try {
  setRaw(localStorage.getItem('pdf-next.md-raw') === '1', { persist: false });
} catch {
  setRaw(false, { persist: false });
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
state.version = String(launch?.version || '');
state.platform = String(launch?.platform || '');
setTitle(state.file?.name || '');
if (typeof launch?.poll === 'number') {
  // The flag wins over the saved preference, which was already sent above.
  // The control only knows a few values; a --poll it cannot show is left
  // reading whatever it did, while the watcher runs at what was asked.
  if (ui.poll.querySelector(`option[value="${launch.poll}"]`)) {
    ui.poll.value = String(launch.poll);
  }
  await invoke('set_poll_seconds', { seconds: launch.poll }).catch(() => {});
}
if (launch?.mode) {
  const requested = launch.mode === 'clear' ? null : launch.mode;
  if (requested === null || PAGE_MODES.includes(requested)) {
    setMode(requested, false);
  }
}

const initial = await invoke('initial_file');
// Files that reached the app before this code was listening — a Finder
// double-click on macOS lands here. Asking also switches the app to live
// `open-files` events, so the listener must be in place first.
await openFilesReady;
const pending = await invoke('pending_files').catch(() => []);
if (initial) {
  await openInTab(initial, { target: asTarget(launch?.target) });
  // Extra paths on the command line become tabs; the first one stays showing.
  // The launch file may be queued again among the pending ones; openInTab
  // knows it already and leaves it alone.
  for (const item of [...(launch?.rest || []), ...pending]) {
    const opening = asOpening(item);
    if (opening) {
      await openPath(opening.path, { activate: false, target: opening.target });
    }
  }
  if (['left', 'right', 'top', 'bottom'].includes(launch?.dock)) {
    await dockTo(launch.dock);
  }
} else if (pending.length) {
  await openMany(pending);
}
ui.container.focus();

// The launch check, after the document is up so the first paint never waits on
// the network. Quiet: an offline machine or a current build hears nothing.
window.setTimeout(() => {
  void checkForUpdates({ quiet: true });
}, 3000);
