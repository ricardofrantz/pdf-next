// Failure capture for smoke runs, and only for them.
//
// This module loads before app.mjs so that a failure *in* app.mjs — a module
// that will not import, a script error before any handler of its own is up —
// still lands somewhere a build server can read. app.mjs decides whether to
// report; this file only remembers, and costs one array in a normal launch.

/** Everything the page has failed at, oldest first. */
export const failures = [];

/// How far the boot sequence got. app.mjs sets this as it passes each step it
/// waits on, so a launch that hangs can say *where* rather than only that it
/// produced nothing.
export const progress = { at: 'start' };

/** Record that the boot reached a step. */
export function mark(step) {
  progress.at = step;
}

/// A launch that never finishes reports nothing at all: every check in app.mjs
/// runs after the awaits that would be stuck. This timer runs instead of them.
///
/// It fires in a normal launch too, where `smoke_report` is a no-op because
/// the process was not started for a smoke run — and app.mjs clears it as soon
/// as it knows this is not one.
let stall = window.setTimeout(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    return;
  }
  const note = failures.length ? ` after: ${failures.join(' | ')}` : '';
  void invoke('smoke_report', {
    ok: false,
    detail: `boot stalled at ${progress.at}${note}`,
  }).catch(() => {});
}, 45_000);

/** Stop the stall report. Called once the boot is known to be progressing. */
export function bootIsFine() {
  window.clearTimeout(stall);
  stall = undefined;
}

/** A short, single-line description of a thrown value. */
function describe(value) {
  if (value instanceof Error) {
    const where = value.stack ? ` @ ${value.stack.split('\n')[1]?.trim() || ''}` : '';
    return `${value.name}: ${value.message}${where}`.trim();
  }
  return String(value);
}

function remember(text) {
  // One line, so a log stays greppable, and capped so a page erroring in a
  // loop cannot fill memory.
  if (failures.length < 20) {
    failures.push(text.replace(/\s+/g, ' ').slice(0, 500));
  }
}

window.addEventListener('error', (event) => {
  if (event.message) {
    const at = event.filename ? ` (${event.filename}:${event.lineno})` : '';
    remember(`${event.message}${at}`);
  } else if (event.target?.src || event.target?.href) {
    // A subresource that did not load fires an error event with no message —
    // this is how a blocked worker, stylesheet or module shows up.
    remember(`failed to load ${event.target.src || event.target.href}`);
  }
}, true);

window.addEventListener('unhandledrejection', (event) => {
  remember(`unhandled rejection: ${describe(event.reason)}`);
});

// PDF.js reports a font, cmap or wasm file it could not fetch by writing to
// the console and carrying on. Nothing throws, the page just comes up missing
// its glyphs — which looks the same as a viewer that works, unless somebody
// is reading the console. Here, somebody is.
for (const level of ['warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...parts) => {
    remember(
      `console.${level}: ${parts.map((part) => (part instanceof Error ? part.message : String(part))).join(' ')}`,
    );
    original(...parts);
  };
}
