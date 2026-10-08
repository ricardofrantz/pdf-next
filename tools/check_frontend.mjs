// Source contracts for the things that are easy to break silently and
// expensive to notice: the real worker, streaming, the canvas budget, the
// one-second poll, and the mid-build gap behaviour.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { findNormalizedSpan, normalizeReviewText, reviewLabel, resolveReviewAnchor, reviewAction, reviewStatus, reviewColor, sameReviewQuote, reattachedReviewAnchor } from '../src/review-label.mjs';
import { mapCollapsedIndex, reconcilePendingComment, reconcilePendingComments } from '../src/review-sync.mjs';
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
const pdfCoreSource = await readFile('src/vendor/pdfjs/build/pdf.min.mjs', 'utf8');
const pdfViewerSource = await readFile('src/vendor/pdfjs/web/pdf_viewer.mjs', 'utf8');
const readme = await readFile('README.md', 'utf8');
const page = await readFile('src/index.html', 'utf8');
const smoke = await readFile('src/smoke.mjs', 'utf8');
const smokeHarness = await readFile('tools/smoke.mjs', 'utf8');
const nsisTemplate = await readFile('src-tauri/windows/installer.nsi', 'utf8');
const releaseWorkflow = await readFile('.github/workflows/release.yml', 'utf8');
assert.match(releaseWorkflow, /run: node tools\/check_frontend\.mjs/,
  'Release builds must run frontend regressions before publishing.');
assert.match(releaseWorkflow, /run: cargo test --locked/,
  'Release builds must run Rust regressions before publishing.');

// A sharp canvas at the old scroll position must not satisfy the render gate.
{
  const viewport = { left: 0, top: 100, right: 400, bottom: 500 };
  let rect = { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 };
  const canvas = { width: 800, height: 800, hidden: false,
    getBoundingClientRect: () => rect };
  const view = { renderingState: 3, canvas,
    div: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 900 }) } };
  const sharp = appFunction('sharpPdfViewport', 'async function smokePdfScroll', {
    ui: { container: { getBoundingClientRect: () => viewport,
      clientLeft: 0, clientTop: 0, clientWidth: 400, clientHeight: 400 } },
    window: { devicePixelRatio: 2 },
  });
  assert.equal(sharp(view), false, 'A sharp canvas that misses visible content must fail.');
  rect = { ...rect, top: 100, bottom: 500 };
  assert.equal(sharp(view), true);
  canvas.width = 400;
  assert.equal(sharp(view), false, 'A CSS-scaled low-resolution canvas must fail.');
  canvas.width = 800;
  view.detailView = { renderingState: 1, canvas };
  assert.equal(sharp(view), false, 'An unfinished detail render must fail.');
}

// Run the vendored detail view against a page rounded down by CSS. Percentages
// based on the unrounded viewport would shrink and displace the sharp crop.
{
  const source = pdfViewerSource.slice(
    pdfViewerSource.indexOf('class PDFPageDetailView extends BasePDFPageView'),
    pdfViewerSource.indexOf(';// ./web/struct_tree_layer_builder.js'),
  );
  const canvas = { style: {} };
  class Base {
    constructor(page) { this.div = page.div; this.renderingState = 0; }
    get renderingState() { return this.state; }
    set renderingState(value) { this.state = value; }
    cancelRendering() {}
    _resetCanvas() {}
    _createCanvas() { return { canvas, prevCanvas: null }; }
    _drawCanvas() { return Promise.resolve(); }
    dispatchPageRender() {}
  }
  const Detail = runInNewContext(`${source}\nPDFPageDetailView`, {
    BasePDFPageView: Base,
    RenderingStates: { INITIAL: 0, RUNNING: 1, FINISHED: 3, PAUSED: 2 },
    OutputScale: { pixelRatio: 3, capPixels: (pixels) => pixels },
  });
  const page = {
    div: { clientWidth: 4758, clientHeight: 6732, setAttribute() {} },
    viewport: { width: 4760, height: 6736, scale: 6 },
    maxCanvasPixels: 4_194_304, pdfPage: {},
    _ensureCanvasWrapper: () => ({}), _getRenderingContext: () => ({}),
  };
  page.detailView = new Detail({ pageView: page });
  page.detailView.update({ visibleArea: { minX: 0, minY: 3366, maxX: 793, maxY: 4488 } });
  await page.detailView.draw();
  assert.ok(Math.abs(parseFloat(canvas.style.width) / 100 * page.div.clientWidth - 793) < 0.01,
    'The cropped canvas must cover the visible width of a CSS-rounded page.');
  assert.ok(Math.abs(parseFloat(canvas.style.top) / 100 * page.div.clientHeight - 3366) < 0.01,
    'The cropped canvas must start at the actual visible scroll offset.');
  page.div.clientWidth = page.div.clientHeight = 0;
  page.detailView.renderingState = 0;
  await page.detailView.draw();
  assert.ok(Number.isFinite(parseFloat(canvas.style.width)),
    'A queued draw for a hidden page must not produce infinite CSS dimensions.');
  page.div.clientWidth = 4758;
  page.div.clientHeight = 6732;
  page.detailView.enableOptimizedPartialRendering = true;
  page.pdfPage.recordedBBoxes = {
    isEmpty: (index) => index === 0,
    minX: () => 0,
    maxX: () => 1,
    minY: (index) => index === 2 ? 0 : 0.5,
    maxY: (index) => index === 2 ? 0.1 : 0.6,
  };
  const context = page.detailView._getRenderingContext(canvas, null);
  assert.equal(context.operationsFilter(0), false);
  assert.equal(context.operationsFilter(1), true, 'Visible PDF drawing operations must remain.');
  assert.equal(context.operationsFilter(2), false, 'Off-screen PDF drawing operations must be skipped.');
}

{
  const canvas = { width: 256, height: 256,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    getContext: () => ({ getImageData: () => ({ data: Uint8Array.of(255, 255, 255, 255) }) }) };
  const view = { viewport: { height: 1000 }, canvas,
    div: { getBoundingClientRect: () => ({ top: 0 }) } };
  const scroll = appFunction('smokePdfScroll', '/// Report to the build server', {
    pdfViewer: { getPageView: () => view, update() {} },
    ui: { container: { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, left: 0 }) } },
    state: { file: { name: 'dense-page.pdf' } }, failures: [],
    window: { devicePixelRatio: 1, requestAnimationFrame: (fn) => fn() },
    performance: { now: () => 0 }, eventBus: { on() {}, off() {} },
    sharpPdfViewport: () => true, settles: async () => true,
  });
  await assert.rejects(scroll(), /pixels did not change/,
    'Blank or stale pixels must fail the dense PDF scrolling test.');
}

// Exercise the shipped renderer, including cancellation before the first draw.
// An incomplete bounds cache must never suppress a later valid drawing operation.
{
  const prelude = `Map.prototype.getOrInsertComputed = function(key, create) {
    if (!this.has(key)) this.set(key, create(key));
    return this.get(key);
  }; class Iterator {}`;
  const core = runInNewContext(prelude +
    pdfCoreSource.slice(0, pdfCoreSource.lastIndexOf('export{'))
      .replaceAll('import.meta.url', '"file:///pdf-next/pdf.mjs"') +
    '\n({PDFPageProxy, OPS: globalThis.pdfjsLib.OPS})', {
    console, setTimeout, clearTimeout, DOMMatrix: class {},
  });
  const transport = {
    commonObjs: {}, getRenderingIntent: () => ({ renderingIntent: 1, cacheKey: 'display' }),
    getOptionalContentConfig: () => Promise.resolve({ renderingIntent: 1 }),
    canvasFactory: {}, filterFactory: {},
  };
  const page = new core.PDFPageProxy(0, {}, transport, null);
  page._pumpOperatorList = function({ cacheKey }) {
    const state = this._intentStates.get(cacheKey);
    state.operatorList = { fnArray: [core.OPS.paintSolidColorImageMask],
      argsArray: [null], lastChunk: true, length: 1 };
    state.displayReadyCapability.resolve(false);
  };
  let draws = 0;
  const context = {
    save() {}, restore() {}, transform() {},
    fillRect(x, y, width, height) { if (width === 1 && height === 1) draws++; },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  const canvas = { width: 100, height: 100, getContext: () => context };
  context.canvas = canvas;
  const options = { canvas, viewport: { scale: 1, transform: [1, 0, 0, 1, 0, 0] },
    recordOperations: true };
  const canceled = page.render(options);
  canceled.onContinue = () => canceled.cancel();
  await assert.rejects(canceled.promise, { name: 'RenderingCancelledException' });
  assert.equal(page.recordedBBoxes, null, 'Canceled renders must not cache incomplete operation bounds.');
  await page.render(options).promise;
  assert.equal(page.recordedBBoxes.isEmpty(0), false, 'The completed redraw must record its drawing.');
  let excluded = 0;
  await page.render({ ...options, operationsFilter(index) {
    if (page.recordedBBoxes.isEmpty(index)) {
      excluded++;
      return false;
    }
    return true;
  } }).promise;
  assert.equal(excluded, 0, 'Detail rendering must retain drawing after a canceled base render.');
  assert.equal(draws, 2);
}

// Exercise the app functions with controlled IPC completion order.
function appFunction(name, next, context, source = app) {
  const pattern = new RegExp(`(?:async )?function ${name}\\(`);
  const start = source.search(pattern);
  const end = source.indexOf(`\n${next}`, start);
  assert.ok(start >= 0 && end > start, `Could not locate ${name}.`);
  return runInNewContext(`${source.slice(start, end)}\n${name}`, context);
}

{
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    if (signal === 'SIGTERM') {
      queueMicrotask(() => {
        child.stdout.emit('data', '\nsmoke: fail watchdog expired\n');
        child.emit('close', 1);
      });
    }
    return true;
  };
  const open = appFunction('open', 'const binary = findBinary();', {
    spawn: () => child, process: { env: {} },
    readFileSync: () => Uint8Array.of(37), openSync: () => 1,
    closeSync() {}, writeSync() {}, writeFileSync() {}, renameSync() {}, unlinkSync() {},
    setTimeout: () => 1, clearTimeout() {},
  }, smokeHarness);
  const running = open('viewer', 'fixture.pdf', 90);
  child.stdout.emit('data', 'smoke: ready fixture rendered\n');
  const result = await running;
  assert.notEqual(result.code, 0, 'An explicit viewer failure after readiness must fail the smoke gate.');
}

{
  let released = false;
  let shown = false;
  const image = {
    set src(value) {
      assert.ok(released, 'Switching to an image must release the previous PDF first.');
      shown = true;
    },
    set alt(value) {},
    decode: async () => {},
  };
  const show = appFunction('showImage', 'async function openFile(', {
    state: { generation: 1 },
    ui: { image },
    releaseDocument: async () => { released = true; },
    sourceUrl: () => 'doc://image',
    setImageRotation() {},
    setImageScale() {},
    openingImageScale: () => 1,
    shrinkImageToWindow: async () => {},
    restoreImageView() {},
    trimWindowToContent() {},
    scheduleWrap() {},
  });
  await show({ name: 'swatch.png' }, false, null, 1);
  assert.ok(shown);
}

{
  // A 400 dpi figure is far larger than the screen. It opens whole, not at 100%.
  let scaled = null;
  const show = appFunction('showImage', 'async function openFile(', {
    state: { generation: 1 },
    ui: { image: { set src(value) {}, set alt(value) {}, decode: async () => {} } },
    releaseDocument: async () => {},
    sourceUrl: () => 'doc://figure',
    setImageRotation() {},
    setImageScale(value) { scaled = value; },
    openingImageScale: (fit) => (fit ? 0.25 : 0.5),
    shrinkImageToWindow: async () => {},
    restoreImageView() {},
    trimWindowToContent() {},
    scheduleWrap() {},
  });
  await show({ name: 'figure.png' }, true, null, 1);
  assert.equal(scaled, 0.25, 'A new figure opens at the scale that fits the screen.');
  await show({ name: 'figure.png' }, false, null, 1);
  assert.equal(scaled, 0.5, 'A figure opened into a kept window fits that window.');
}

{
  const context = (natural, docked = false) => ({
    state: { docked, reviewOpen: false },
    window: { outerWidth: 1000, innerWidth: 1000, outerHeight: 800, innerHeight: 800,
      screen: { availWidth: 1920, availHeight: 1040 } },
    REVIEW_PANE_WIDTH: 280,
    turnedNatural: () => natural,
    chromeHeight: () => 36,
    imageContainScale: () => 0.4,
  });
  const scale = (natural, fit, docked) =>
    appFunction('openingImageScale', 'function imageContainScale(', context(natural, docked))(fit);
  assert.equal(scale([3200, 2400], true), 0.401,
    'A screen-sized limit leaves room for the frame and the toolbar.');
  assert.equal(scale([640, 480], true), 1, 'A small picture still opens at 100%.');
  assert.equal(scale([3200, 2400], false), 0.4, 'A kept window limits the picture to its stage.');
  assert.equal(scale([3200, 2400], true, true), 0.4, 'A docked window limits the picture to its stage.');
  assert.equal(scale([0, 0], true), 1, 'An undecoded picture keeps 100%.');
}

{
  // The window frame was larger than estimated, so the screen clamped the window.
  const run = async (box, stage) => {
    const calls = [];
    const context = {
      state: { generation: 1, imageScale: 0.3 },
      ui: { imageBox: { offsetWidth: box[0], offsetHeight: box[1] },
        imageStage: { clientWidth: stage[0], clientHeight: stage[1] } },
      windowResized: async () => {},
      stagePadding: () => [0, 0],
      imageContainScale: () => 0.2834,
      setImageScale(value) { calls.push(['scale', value]); },
      trimWindowToContent: async () => { calls.push(['trim']); },
    };
    await appFunction('shrinkImageToWindow', 'function windowResized(', context)(1);
    return calls;
  };
  assert.deepEqual(await run([900, 660], [900, 620]), [['scale', 0.283], ['trim']],
    'A picture taller than its clamped window shrinks into it.');
  assert.deepEqual(await run([900, 620], [900, 620]), [],
    'A picture that fits its window keeps its scale.');
}

{
  const note = { file: 'a.pdf', quote: 'selected text' };
  const state = { file: { path: 'a.pdf' }, generation: 1, pendingNote: note };
  const ui = {
    noteBox: { hidden: false }, noteText: { value: 'unsaved comment' },
    image: { removeAttribute() {} }, markdown: {}, markdownRaw: {},
  };
  const open = appFunction('openFile', 'async function openPath(', {
    state, ui, printPending: false,
    flushCommentSave: async () => {}, captureView: () => null,
    clearPrintPages() {}, setTitle() {}, setStatus() {},
    document: { body: { classList: { add() {}, toggle() {}, remove() {} } } },
    showPdf: async () => {}, loadReviews: async () => {},
  });
  await open({ path: 'a.pdf', name: 'a.pdf', kind: 'pdf' }, { preserveView: true });
  assert.equal(state.pendingNote, note, 'Reloading the same document must preserve the selected quote.');
  assert.equal(ui.noteText.value, 'unsaved comment');
  assert.equal(ui.noteBox.hidden, false);
  await open({ path: 'b.pdf', name: 'b.pdf', kind: 'pdf' });
  assert.equal(state.pendingNote, null, 'Changing documents must clear the old selection.');
  assert.equal(ui.noteText.value, '');
  assert.equal(ui.noteBox.hidden, true);
}

for (const pauseAt of ['save', 'close']) {
  const state = { file: { path: 'a.pdf' }, generation: 1 };
  let finish;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const pause = () => new Promise((resolve) => { finish = resolve; started(); });
  const close = appFunction('closeAll', 'function cycleTab(', {
    state,
    noteSaveInFlight: false,
    flushCommentSave: pauseAt === 'save' ? pause : async () => {},
    invoke: pauseAt === 'close' ? pause : async () => {
      assert.fail('A superseded close must not clear the new watch target.');
    },
  });
  const closing = close();
  await waiting;
  const nextFile = { path: 'b.pdf' };
  state.file = nextFile;
  state.generation += 1;
  finish();
  await closing;
  assert.equal(state.file, nextFile, 'A superseded close must preserve the newly opened document.');
}

{
  const state = { file: { path: 'a.pdf', kind: 'pdf' }, generation: 1, reviews: [] };
  let finish;
  let applied = false;
  const load = appFunction('loadReviews', '/// Disk first.', {
    state,
    pendingComment: null,
    commentSaveTimer: 0,
    window: { clearTimeout() {} },
    invoke: () => new Promise((resolve) => { finish = resolve; }),
    applyReviewStore() { applied = true; },
    setStatus() {},
  });
  const loading = load();
  state.file = { path: 'b.pdf', kind: 'pdf' };
  state.generation += 1;
  finish({ reviews: [{ id: 'r1', file: 'a.pdf' }] });
  await loading;
  assert.equal(applied, false, 'A late review response must not replace another file’s reviews.');
}

{
  const draft = { id: 'r1', comment: 'unsaved edit' };
  const pendingComments = new Map([['a.pdf\u0000r1', { ...draft, path: 'a.pdf' }]]);
  const context = {
    state: { file: { path: 'a.pdf' }, generation: 1, reviews: [draft] },
    pendingComments,
    commentDraftKey: (path, id) => `${path}\u0000${id}`,
    window: { confirm: () => false, clearTimeout() {} },
    invoke: async () => { assert.fail('Canceled deletion must not write.'); },
    applyReviewStore() {},
    setStatus() {},
  };
  const remove = appFunction('deleteReview', 'async function jumpToReview(', context);
  await remove('r1');
  assert.equal(pendingComments.size, 1, 'Canceling removal preserves the pending edit.');
  context.window.confirm = () => true;
  context.invoke = async () => { throw new Error('permission denied'); };
  context.setStatus = () => {};
  await remove('r1');
  assert.equal(pendingComments.size, 1, 'Failed removal preserves the pending edit.');
}

{
  const key = 'a.pdf\u0000r1';
  const pendingComments = new Map([[key, { id: 'r1', path: 'a.pdf', comment: 'first', expectedComment: '' }]]);
  const saved = [];
  let releaseFirst;
  const context = {
    state: { file: { path: 'a.pdf' }, reviews: [{ id: 'r1' }], reviewConflicts: new Map() },
    pendingComments,
    commentSaveTimer: 0,
    commentFlushPromise: null,
    window: { clearTimeout() {} },
    commentDraftKey: (path, id) => `${path}\u0000${id}`,
    reviewStateKey: (path, id) => `${path}\u0000${id}`,
    renderReviewList() {},
    updateReviewComment: async (pending) => {
      saved.push(pending.comment);
      if (saved.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      if (pendingComments.get(key) === pending) pendingComments.delete(key);
    },
  };
  const flush = appFunction('flushCommentSave', 'async function updateReviewComment(', context);
  const first = flush();
  pendingComments.set(key, { id: 'r1', path: 'a.pdf', comment: 'second', expectedComment: 'first' });
  const second = flush();
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(saved, ['first', 'second'], 'A flush requested during a save also saves the newer draft.');
  assert.equal(pendingComments.size, 0);
}

{
  const original = [{ id: 'b1', file: 'b.pdf' }];
  const state = { file: { path: 'a.pdf' }, generation: 1, reviews: [], reviewConflicts: new Set() };
  const pending = { id: 'r1', path: 'a.pdf', comment: 'edited', expectedComment: 'old' };
  const pendingComments = new Map([['a.pdf\u0000r1', pending]]);
  let finish;
  const update = appFunction('updateReviewComment', 'async function deleteReview(', {
    state,
    pendingComments,
    commentDraftKey: (path, id) => `${path}\u0000${id}`,
    invoke: () => new Promise((resolve) => { finish = resolve; }),
    setStatus() {},
    selectReview() {},
    applyReviewStore() {},
    renderReviewList() {},
    reviewRowById() { return null; },
  });
  const updating = update(pending, { quiet: true });
  state.file = { path: 'b.pdf' };
  state.generation += 1;
  state.reviews = original;
  finish({ reviews: [{ id: 'r1', file: 'a.pdf' }] });
  await updating;
  assert.equal(state.reviews, original, 'A late comment save must not change another file’s panel.');
}

{
  let stateDigest;
  const state = {
    file: { path: 'a.pdf' }, generation: 1,
    pendingNote: { file: 'a.pdf', kind: 'pdf', at: { page: 1 }, quote: 'text', anchor: { position: { page: 1, x: 20, y: 30 } } },
    pendingNotePdf: { path: 'a.pdf', document: {}, digestPromise: new Promise((resolve) => { stateDigest = resolve; }) },
  };
  let finish;
  let applied = false;
  let appended;
  let statusMessage = '';
  const save = appFunction('saveNote', 'async function optionalSourceHint(', {
    state,
    noteSaveInFlight: false,
    structuredClone: (value) => JSON.parse(JSON.stringify(value)),
    REVIEW_TINTS: 16,
    ui: { noteText: { value: 'comment' }, noteAction: { value: 'improve' }, noteSave: {}, noteBox: {}, noteQuote: {}, noteRef: {} },
    pdfDocumentDigest: async () => 'sha256:wrong-current-document',
    optionalSourceHint: async () => null,
    invoke: (_command, args) => {
      if (_command === 'append_review') { appended = args.review; return new Promise((resolve) => { finish = resolve; }); }
      return null;
    },
    applyReviewStore() { applied = true; },
    setReviewOpen() {},
    selectReview() {},
    setStatus(message) { statusMessage = message; },
  });
  state.generation += 1;
  state.file.revision = 2;
  const saving = save();
  state.generation += 1;
  stateDigest('sha256:captured-original-document');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appended?.anchor?.documentRevision, 'sha256:captured-original-document', `A same-path rebuild keeps the digest captured with the selection. ${statusMessage}`);
  state.file.path = 'b.pdf';
  state.generation += 1;
  finish({ reviews: [{ id: 'r1', file: 'a.pdf' }] });
  await saving;
  assert.equal(applied, false, 'A late new-review save must not change another file’s panel.');
}

{
  const state = {
    file: { kind: 'pdf', revision: 1 }, reviewLocations: new Map(), generation: 1,
    reviews: [{ id: 'r1', at: { page: 1, end: 4_294_967_295 }, quote: 'quote' }],
  };
  let visited = 0;
  const paint = appFunction('paintPdfMarks', 'function paintReviewMarks(', {
    state,
    pdfPaintSerial: 0,
    reviewStateKey: (path, id) => `${path}\u0000${id}`,
    pdfDocumentDigest: async () => 'sha256:test',
    reviewAction,
    reviewStatus,
    resolveReviewAnchor,
    renderReviewList() {},
    pdfViewer: { pagesCount: 3 },
    pdfReviewTextPages: async () => [
      { page: 1, text: 'quote' }, { page: 2, text: 'other' }, { page: 3, text: 'else' },
    ],
    ui: { viewer: {
      querySelectorAll: () => [],
      querySelector: () => {
        visited += 1;
        assert.ok(visited <= 3, 'An imported review must not scan beyond the PDF page count.');
        return null;
      },
    } },
  });
  await paint();
  assert.equal(visited, 1, 'The stored end page cannot expand work beyond its unique text match.');
}

{
  const state = { file: { kind: 'pdf' }, document: {}, generation: 1 };
  let printed = false;
  const print = appFunction('printDocument', '// Two ways to hear', {
    state, printing: false, printPending: false, printBlurred: false,
    clearPrintPages() {},
    renderPrintPages: async () => { state.generation += 1; return true; },
    invoke: async () => { printed = true; },
    setStatus() {},
  });
  await print();
  assert.equal(printed, false, 'A superseded print must not open the dialog.');
}

for (const release of ['0.9.0', '0.9.1']) {
  const manifest = await readFile(
    `winget/RicardoFrantz.pdf-next/${release}/RicardoFrantz.pdf-next.installer.yaml`,
    'utf8',
  );
  assert.doesNotMatch(manifest, /^\s*DisplayVersion:/m, 'WinGet must omit redundant DisplayVersion.');
}

{
  const { watchPdfRendering } = await import('../src/pdf-rendering.mjs');
  const previousWindow = globalThis.window;
  const queries = [];
  const events = new Map();
  const updates = [];
  const viewer = {
    pdfDocument: {},
    _pages: [{
      canvas: { width: 800 },
      reset() { this.canvas = null; updates.push('reset'); },
      update() { assert.equal(this.canvas, null); updates.push('scale'); },
    }],
    update() { updates.push('render'); },
  };
  globalThis.window = {
    devicePixelRatio: 1,
    matchMedia(query) {
      const media = { query, handler: null,
        addEventListener(event, fn) { this.handler = fn; },
        removeEventListener() { this.handler = null; },
      };
      queries.push(media);
      return media;
    },
    addEventListener(name, handler) { events.set(name, handler); },
  };
  try {
    watchPdfRendering(viewer);
    globalThis.window.devicePixelRatio = 2;
    queries[0].handler();
    assert.deepEqual(updates, ['reset', 'scale', 'render']);
    assert.match(queries[1].query, /2dppx/);
    events.get('resize')();
    assert.equal(updates.length, 3, 'Resizing at unchanged density must not discard canvases.');
    globalThis.window.devicePixelRatio = 1.5;
    events.get('resize')();
    assert.match(queries.at(-1).query, /1.5dppx/);
    assert.deepEqual(updates.slice(-3), ['reset', 'scale', 'render']);
  } finally {
    globalThis.window = previousWindow;
  }
}

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
assert.match(app, /enableOptimizedPartialRendering: true/,
  'High-density detail rendering must skip drawing operations outside the visible crop.');
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
  /await showImage\(file, !view && !keepWindow, view, generation\)/,
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
  /invoke\('append_review', \{\s*document: path,\s*review,/,
  'A new review must append a record, not a markdown block.',
);
assert.match(
  app,
  /listen\('reviews-changed'[\s\S]*?reloadReviewsFromDisk\(\)/,
  'An external sidecar edit must refresh reviews without reloading the document.',
);
assert.match(app, /await openFile\(\{ \.\.\.state\.file, revision \}, \{ preserveView: true \}\);[\s\S]*?state\.file\?\.kind === 'pdf'[\s\S]*?reportSmoke\(\)/,
  'A completed PDF watcher reload reports its final revision to the held native smoke harness.');
assert.match(app, /documentSha256=\$\{digest\.slice\('sha256:'\.length\)\}; sourceRevision=\$\{file\.revision\}; reviewsRevision=\$\{state\.reviewRevision\}/,
  'Native reload reports include the PDF digest, file revision, and sidecar revision.');
assert.match(app, /reviewsCount=\$\{reviews\.length\}/,
  'Native readiness reports how many review rows were loaded.');
assert.match(app, /uniqueRowIds=\$\{rowIds\.size\}; uniqueTints=\$\{tints\.size\}; serializedIds=\$\{serializedIds\.size\}; agentExtensions=\$\{agentExtensions\.length\}; nextId=\$\{state\.nextId\}/,
  'Dense native readiness reports stable row IDs, all tints, preserved extensions, and next ID.');
assert.match(app, /textContent = 'Reattach selection'[\s\S]*?pointerdown'[\s\S]*?preventDefault\(\)[\s\S]*?sameReviewQuote/,
  'Manual reattachment keeps the PDF text selection and accepts only the original quote.');
assert.match(app, /textContent = 'Use disk'[\s\S]*?textContent = 'Save my draft'[\s\S]*?expectedComment: String\(current\.comment \|\| ''\)/,
  'Same-field conflicts require an explicit choice before the user draft is rebased.');
assert.match(app, /textContent = 'Copy draft'[\s\S]*?textContent = 'Discard draft'/,
  'A draft for a removed record can be copied or discarded without recreating the review.');
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
assert.equal(findNormalizedSpan('repeat quote repeat quote', 'repeat quote'), null,
  'A repeated full quote is ambiguous; never fall back to its first occurrence.');
assert.deepEqual(reviewLabel({ id: 'r17', at: { page: 4 } }, []), 'r17',
  'Review badges use stable IDs, independent of location and list order.');
assert.equal(reviewAction({ comment: 'please delete this' }), 'improve',
  'Legacy comments never imply the Delete action.');
assert.equal(reviewStatus({}), 'open', 'Legacy reviews remain open until explicitly changed.');
assert.equal(sameReviewQuote({ quote: ' A selected phrase ' }, 'a  selected phrase'), true);
assert.equal(sameReviewQuote({ quote: 'original phrase' }, 'different phrase'), false,
  'Manual reattachment cannot silently change the requested text.');
{
  const oldAnchor = { prefix: 'before', position: { page: 1, x: 10, y: 20 } };
  const nextAnchor = reattachedReviewAnchor(oldAnchor, {
    prefix: 'new before', position: { page: 3, x: 30, y: 40 },
  }, { page: 1 }, 'original phrase');
  assert.equal(nextAnchor.position.page, 3);
  assert.deepEqual(nextAnchor.original, {
    anchor: oldAnchor, at: { page: 1 }, quote: 'original phrase',
  }, 'Manual reattachment retains the original quote, location, and anchor.');
}
assert.equal(reviewColor({ id: 'r17', color: 5 }), 5, 'Persisted colors survive reorder and reload.');
assert.equal(reviewColor({ id: 'r17' }), 1, 'Legacy colors have a stable deterministic fallback.');
assert.equal(new Set(Array.from({ length: 16 }, (_, i) => reviewColor({ id: `r${i + 1}` })).slice(0, 16)).size, 16);
assert.equal(new Set(Array.from({ length: 30 }, (_, i) => reviewColor({ id: `r${i + 1}` })).slice(0, 16)).size, 16,
  'Thirty reviews can use every available tint while stable IDs keep badge identity.');
const thirtyIds = Array.from({ length: 30 }, (_, i) => ({ id: `r${i + 1}` }));
assert.equal(new Set(thirtyIds.map((review) => reviewLabel(review, thirtyIds))).size, 30,
  'Thirty review badges remain individually addressable.');
assert.equal(new Set([...thirtyIds].reverse().map((review) => `${review.id}:${reviewColor(review)}`)).size, 30,
  'Stable review color assignments do not depend on list order.');
const reviewStateKey = appFunction('reviewStateKey', 'function draftsForPath(', {});
assert.notEqual(reviewStateKey('a.pdf', 'r1'), reviewStateKey('b.pdf', 'r1'),
  'Review conflicts and location state are isolated by document path.');
{
  const hint = appFunction('optionalSourceHint', '/// Ask is', {
    invoke: async () => ({ file: 'chapters/main.tex', line: 14, method: 'synctex', verified: false,
      documentRevision: 'sha256:abc' }),
    window: { setTimeout: () => 1, clearTimeout() {} },
    setStatus() {},
  });
  const value = await hint('paper.pdf', { page: 1, x: 36, y: 72 }, 'sha256:abc');
  assert.equal(value.verified, false, 'Source hints remain explicitly unverified.');
  assert.equal(value.documentRevision, 'sha256:abc');
}
{
  const expectedComment = '  agent note\n';
  const draft = { id: 'r1', comment: 'my edit', expectedComment };
  const unchanged = reconcilePendingComment(draft, [{ id: 'r1', comment: expectedComment }], []);
  assert.equal(unchanged.pending.expectedComment, expectedComment,
    'Reconciliation must preserve the exact disk comment used by backend compare-and-swap.');
  assert.equal(unchanged.conflict, null);
  const changed = reconcilePendingComment(draft, [{ id: 'r1', comment: 'agent note' }], []);
  assert.equal(changed.conflict, 'changed',
    'Whitespace-only changes on disk still change the compare-and-swap value.');
}
{
  const pages = [{ page: 1, text: 'aaaa' }];
  assert.equal(resolveReviewAnchor(pages, 'aaa').status, 'ambiguous',
    'Overlapping quote occurrences cannot be treated as a unique selection.');
  assert.equal(resolveReviewAnchor(pages, 'aaa', { prefix: 'missing' }).status, 'ambiguous',
    'An unmatched context does not make overlapping repeated quotes unique.');
  assert.deepEqual(resolveReviewAnchor(pages, 'aaa', { prefix: 'a' }),
    { status: 'located', page: 1, start: 1, end: 4 },
    'Context can disambiguate an overlapping occurrence.');
}
{
  const pages = [
    { page: 2, text: 'start alpha repeated phrase end. second repeated phrase elsewhere.' },
    { page: 8, text: 'before repeated phrase after' },
  ];
  assert.deepEqual(resolveReviewAnchor(pages, 'repeated phrase', {
    position: { page: 2, x: 36, y: 72 }, prefix: 'start alpha ', suffix: ' end.',
  }), { status: 'located', page: 2, start: 12, end: 27 });
  assert.deepEqual(resolveReviewAnchor(pages, 'repeated phrase', {
    position: { page: 2, x: 36, y: 72 }, prefix: 'before ', suffix: ' after',
  }), { status: 'located', page: 8, start: 7, end: 22 });
  assert.equal(resolveReviewAnchor(pages, 'repeated phrase', {
    position: { page: 2 }, prefix: 'no matching context ', suffix: 'missing',
  }).status, 'ambiguous');
  assert.equal(resolveReviewAnchor(pages, 'deleted passage', {
    position: { page: 2 }, prefix: '', suffix: '',
  }).status, 'unlocated');
  assert.equal(resolveReviewAnchor([
    { page: 2, text: 'the selected repeated phrase remains here' },
    { page: 9, text: 'an unrelated repeated phrase remains here' },
  ], 'repeated phrase', { position: { page: 2 }, prefix: '', suffix: '' }).status, 'ambiguous',
  'A quote still present on its former page is ambiguous if it also appears elsewhere.');
}
{
  // PDF.js 6.3.289 text items for a pdflatex page with \emph{non}linear and
  // $u_\tau$, joined with spaces as pdfReviewTextPages joins them.
  const items = ['The', ' ', 'non', 'linear term dominates when the friction velocity', ' ', 'u', 'τ',
    ' ', 'grows large. We', 'measure the Reynolds number', ' ', 'Re', 'τ', ' ', '= 180 in the channel.', '1'];
  const pages = [{ page: 1, text: items.join(' ') }];
  const word = resolveReviewAnchor(pages, 'The nonlinear term');
  assert.equal(word.status, 'located', 'A quote across a font change inside a word is located.');
  assert.equal(normalizeReviewText(pages[0].text).slice(word.start, word.end), 'the non linear term');
  assert.equal(resolveReviewAnchor(pages, 'velocity uτ grows').status, 'located',
    'A quote across inline math pieces is located.');
  assert.equal(resolveReviewAnchor([{ page: 1, text: 'u τ and u τ' }], 'uτ').status, 'ambiguous',
    'A repeated quote stays ambiguous when spaces are ignored.');
  assert.equal(resolveReviewAnchor([{ page: 3, text: 'flow within the wa ke region' }], 'in the wake').status,
    'unlocated', 'A match that ignores spaces must start at a word boundary.');
  assert.equal(resolveReviewAnchor([{ page: 3, text: 'the wa kes form' }], 'the wake').status,
    'unlocated', 'A match that ignores spaces must end at a word boundary.');
  assert.deepEqual(resolveReviewAnchor([{ page: 1, text: 'ab and a b' }], 'ab'),
    { status: 'located', page: 1, start: 0, end: 2 },
    'An exact match wins over a match that ignores spaces.');
  assert.equal(resolveReviewAnchor([{ page: 1, text: 'u τ here' }, { page: 2, text: 'u τ there' }], 'uτ', {
    prefix: '', suffix: 'there',
  }).status, 'located', 'Context still selects one candidate when spaces are ignored.');
}
assert.equal(mapCollapsedIndex('hello', 2), 2);
assert.equal(mapCollapsedIndex('a  b', 1), 1);
assert.equal(mapCollapsedIndex('a  b', 2), 3);
{
  const saved = [{ id: 'r1', comment: 'old' }, { id: 'r2', comment: 'keep' }];
  const draft = { id: 'r1', comment: 'typing' };
  assert.equal(
    reconcilePendingComment(draft, [{ id: 'r2', comment: 'keep' }], saved).keepDraftId,
    'r1',
    'Agent deletion preserves an orphaned draft for recovery.',
  );
  assert.equal(reconcilePendingComment(draft, [{ id: 'r2', comment: 'keep' }], saved).conflict, 'removed');
  assert.equal(
    reconcilePendingComment(
      draft,
      [
        { id: 'r1', comment: 'agent fix' },
        { id: 'r2', comment: 'keep' },
      ],
      saved,
    ).keepDraftId,
    'r1',
    'Agent edit of that comment preserves the draft for conflict resolution.',
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
{
  const state = { file: { path: 'a.pdf' }, generation: 2, reviews: [], reviewConflicts: new Map() };
  const pending = { id: 'r4', path: 'a.pdf', comment: 'mine', expectedComment: 'original' };
  const key = 'a.pdf\u0000r4';
  const pendingComments = new Map([[key, pending]]);
  let args;
  const update = appFunction('updateReviewComment', 'async function deleteReview(', {
    state, pendingComments,
    HTMLTextAreaElement: class {},
    commentDraftKey: (path, id) => `${path}\u0000${id}`,
    reviewStateKey: (path, id) => `${path}\u0000${id}`,
    invoke: async (_command, payload) => {
      args = payload;
      throw new Error('review comment conflict');
    },
    loadReviews: async () => {},
    setStatus() {}, renderReviewList() {}, reviewRowById() { return null; },
  });
  assert.equal(await update(pending, { quiet: true }), false);
  assert.equal(JSON.stringify(args), JSON.stringify({
    document: 'a.pdf', id: 'r4', expectedComment: 'original', comment: 'mine',
  }));
  assert.equal(pendingComments.get(key), pending, 'A same-field conflict keeps the unsaved draft.');
  assert.equal(state.reviewConflicts.get(key).reason, 'changed');
}
{
  const pending = new Map([
    ['r1', { id: 'r1', comment: 'mine 1', expectedComment: 'old 1' }],
    ['r2', { id: 'r2', comment: 'mine 2', expectedComment: 'old 2' }],
  ]);
  const result = reconcilePendingComments(pending, [
    { id: 'r1', comment: 'agent 1' }, { id: 'r2', comment: 'old 2' },
  ], [{ id: 'r1', comment: 'old 1' }, { id: 'r2', comment: 'old 2' }]);
  assert.equal(result.pending.size, 2, 'One external edit must not discard another pending row.');
  assert.equal(result.conflicts.has('r1'), true, 'Same-field edits are reported as conflicts.');
  assert.equal(result.conflicts.has('r2'), false, 'Independent draft remains saveable.');
}
{
  const pending = { id: 'r1', path: 'a.pdf', comment: 'mine', expectedComment: 'old', original: { id: 'r1' } };
  const pendingComments = new Map([['a.pdf\u0000r1', pending]]);
  const state = { file: { path: 'a.pdf' }, generation: 1, reviewConflicts: new Map() };
  let retry;
  const saveDraft = appFunction('saveDraftAfterConflict', 'async function reattachReview(', {
    state, pendingComments,
    commentDraftKey: (path, id) => `${path}\u0000${id}`,
    reviewStateKey: (path, id) => `${path}\u0000${id}`,
    invoke: async () => ({ reviews: [{ id: 'r1', comment: 'agent' }] }),
    applyReviewStore() {}, renderReviewList() {},
    updateReviewComment: async (draft) => { retry = draft; return true; },
    setStatus() {},
  });
  await saveDraft('r1');
  assert.equal(retry.expectedComment, 'agent', 'Explicit Save my draft uses the refreshed disk comment for CAS.');
  assert.equal(retry.comment, 'mine');
}
{
  const pending = { id: 'r1', path: 'a.pdf', comment: 'mine', expectedComment: 'old', original: { id: 'r1', quote: 'audit quote' } };
  const pendingComments = new Map([['a.pdf\u0000r1', pending]]);
  const state = { file: { path: 'a.pdf' }, generation: 1, reviewConflicts: new Map() };
  let updated = false;
  const saveDraft = appFunction('saveDraftAfterConflict', 'async function reattachReview(', {
    state, pendingComments,
    commentDraftKey: (path, id) => `${path}\u0000${id}`,
    reviewStateKey: (path, id) => `${path}\u0000${id}`,
    invoke: async () => ({ reviews: [] }),
    applyReviewStore() {}, renderReviewList() {},
    updateReviewComment: async () => { updated = true; },
    setStatus() {},
  });
  await saveDraft('r1');
  assert.equal(updated, false, 'An explicitly removed record is never recreated by saving its draft.');
  assert.equal(pendingComments.get('a.pdf\u0000r1'), pending, 'The removed record keeps its quote and draft for copying.');
  assert.equal(state.reviewConflicts.get('a.pdf\u0000r1').reason, 'removed');
}
{
  const pending = { id: 'r1', path: 'a.pdf', comment: 'mine', expectedComment: 'old', original: { id: 'r1', quote: 'audit quote' } };
  const pendingComments = new Map([['a.pdf\u0000r1', pending]]);
  const conflict = new Map([['a.pdf\u0000r1', { reason: 'changed' }]]);
  const state = { file: { path: 'a.pdf' }, generation: 1, reviewConflicts: conflict };
  let status = '';
  let updated = false;
  const saveDraft = appFunction('saveDraftAfterConflict', 'async function reattachReview(', {
    state, pendingComments,
    commentDraftKey: (path, id) => `${path}\u0000${id}`,
    reviewStateKey: (path, id) => `${path}\u0000${id}`,
    invoke: async () => null,
    applyReviewStore() {}, renderReviewList() {},
    updateReviewComment: async () => { updated = true; },
    setStatus(message) { status = message; },
  });
  await saveDraft('r1');
  assert.equal(updated, false, 'A missing sidecar does not authorize rebasing a draft or recreating a review.');
  assert.equal(pendingComments.get('a.pdf\u0000r1'), pending, 'The draft survives a temporarily missing sidecar.');
  assert.equal(conflict.get('a.pdf\u0000r1').reason, 'changed');
  assert.match(status, /temporarily unavailable/);
}
{
  const pending = { id: 'r1', path: 'a.pdf', comment: 'saved edit', expectedComment: 'saved edit', original: { id: 'r1', comment: 'old' } };
  const pendingComments = new Map([['a.pdf\u0000r1', pending]]);
  const state = {
    file: { path: 'a.pdf', kind: 'pdf' }, generation: 1, reviewDocumentPath: 'a.pdf',
    reviewConflicts: new Map(), reviewLocations: new Map(), reviews: [],
  };
  const load = appFunction('loadReviews', '/// Disk first.', {
    state, pendingComments,
    commentDraftKey: (path, id) => `${path}\u0000${id}`,
    reviewStateKey: (path, id) => `${path}\u0000${id}`,
    draftsForPath: () => new Map([['r1', pending]]),
    reconcilePendingComments,
    invoke: async () => ({ revision: 2, reviews: [{ id: 'r1', comment: 'saved edit' }] }),
    applyReviewStore() {}, setStatus() {},
  });
  await load();
  assert.equal(pendingComments.has('a.pdf\u0000r1'), false, 'A draft reconciled to the saved disk value is removed from the pending map.');
}
{
  const records = Array.from({ length: 32 }, (_, index) => ({ id: `r${index + 1}`, quote: `Scroll render ${index * 8}`, comment: '' }));
  const draft = { id: 'r1', path: 'a.pdf', comment: 'unsaved', expectedComment: '', original: records[0] };
  const pendingComments = new Map([['a.pdf\u0000r1', draft]]);
  const state = {
    file: { path: 'a.pdf', kind: 'pdf' }, generation: 1, reviewDocumentPath: 'a.pdf',
    reviewRevision: 4, reviews: records, reviewConflicts: new Map(), reviewLocations: new Map(),
  };
  let read = null;
  let rendered = null;
  const load = appFunction('loadReviews', '/// Disk first.', {
    state, pendingComments,
    commentDraftKey: (path, id) => `${path}\u0000${id}`,
    reviewStateKey: (path, id) => `${path}\u0000${id}`,
    draftsForPath: () => new Map([['r1', pendingComments.get('a.pdf\u0000r1')]].filter(([, item]) => item)),
    reconcilePendingComments,
    invoke: async () => read,
    applyReviewStore(store, options) { rendered = { store, options }; state.reviews = store.reviews; },
    setStatus() {},
  });
  await load();
  assert.equal(state.reviews.length, 32, 'A missing sidecar cannot erase the last valid review panel.');
  assert.equal(pendingComments.get('a.pdf\u0000r1'), draft, 'A missing sidecar preserves pending drafts.');
  assert.equal(rendered, null, 'A null IPC result is not treated as a valid empty store.');
  read = { revision: 5, nextId: 33, reviews: records };
  await load();
  assert.equal(state.reviews.length, 32, 'The panel restores when its sidecar returns.');
  read = { revision: 6, nextId: 1, reviews: [] };
  await load();
  assert.equal(state.reviews.length, 0, 'A valid empty store clears reviews.');
}
{
  const state = { file: { path: 'a.pdf' }, reviewDocumentPath: 'a.pdf', reviewRevision: 8, reviews: [] };
  let reloads = 0;
  const apply = appFunction('applyReviewStore', 'async function loadReviews(', {
    state, reviewPaintSignature: () => '', loadReviews() { reloads += 1; },
    reviewIdNum: () => 1,
    renderReviewList() {}, paintReviewMarks() {},
  });
  assert.equal(apply({ revision: 7, reviews: [] }), false, 'A late mutation response cannot roll the panel back behind a newer watcher read.');
  assert.equal(reloads, 1, 'A stale mutation response triggers one authoritative reread.');
  assert.equal(apply({ revision: 2, reviews: [{ id: 'r1' }] }, { authoritative: true }), true,
    'An authoritative disk read can represent a reset/imported revision counter.');
  assert.equal(state.reviewRevision, 2);
}
assert.match(page, /id="reviewMenu"/, 'Right-click on a selection adds a review.');
assert.match(
  app,
  /const REVIEW_CHIP_MS = 500/,
  'The add-review chip waits half a second after the selection settles.',
);
assert.match(
  app,
  /function reviewTint\(review\)[\s\S]*?REVIEW_TINTS/,
  'Review marks use the persisted color from the record.',
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
  /\[data-review-tint='1'\][\s\S]*?\[data-review-tint='16'\]/,
  'Sixteen review tints are available in light and dark themes.',
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
  assert.equal(reviewLabel(pages[0], pages), 'r1');
  assert.equal(reviewLabel(pages[1], pages), 'r2');
  assert.equal(reviewLabel(pages[2], pages), 'r3');
  assert.equal(reviewLabel(pages[3], pages), 'r4');
  assert.equal(reviewLabel(pages[4], pages), 'r5');
  const afterDelete = pages.filter((review) => review.id !== 'r2');
  assert.equal(reviewLabel(afterDelete[1], afterDelete), 'r3');
  const md = [
    { id: 'r1', at: { line: 12 } },
    { id: 'r2', at: { line: 12 } },
    { id: 'r3', at: { line: 40 } },
  ];
  assert.equal(reviewLabel(md[0], md), 'r1');
  assert.equal(reviewLabel(md[1], md), 'r2');
  assert.equal(reviewLabel(md[2], md), 'r3');
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
  'tests/fixtures/dense-page.pdf',
  'tests/fixtures/jbig2.pdf',
  'tests/fixtures/jpeg2000.pdf',
  'tests/fixtures/swatch.png',
  'tests/fixtures/large-figure.png',
  'tests/fixtures/notes.md',
]) {
  await access(fixture);
}

// The README must name the runtime it actually ships.
const vendored = version.match(/Version:\s*(\S+)/)?.[1];
assert.ok(vendored, 'src/vendor/PDFJS_VERSION must record a version.');
for (const source of [
  pdfCoreSource,
  worker,
  pdfViewerSource,
]) {
  assert.equal(source.match(/pdfjsVersion = (\S+)/)?.[1], vendored,
    'Core, worker, and viewer must match the recorded PDF.js version.');
}
const viewerCss = await readFile('src/vendor/pdfjs/web/pdf_viewer.css', 'utf8');
for (const match of viewerCss.matchAll(/url\(["']?(images\/[^)'"\s]+)["']?\)/g)) {
  await access(`src/vendor/pdfjs/web/${match[1]}`);
}
assert.ok(
  readme.includes(vendored),
  `README.md must mention the vendored PDF.js version (${vendored}).`,
);

const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
const rustVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
assert.equal(packageInfo.version, config.version, 'Frontend and bundle versions must agree.');
assert.equal(rustVersion, config.version, 'Rust and bundle versions must agree.');
const releaseTag = process.env.GITHUB_REF?.match(/^refs\/tags\/v(.+)$/)?.[1];
if (releaseTag) {
  assert.equal(releaseTag, config.version, 'The release tag must match the built version.');
}

console.log(`Frontend contracts passed (PDF.js ${vendored}).`);
