// Failure capture for smoke runs, and only for them.
//
// This module loads before app.mjs so that a failure *in* app.mjs — a module
// that will not import, a script error before any handler of its own is up —
// still lands somewhere a build server can read. app.mjs decides whether to
// report; this file only remembers, and costs one array in a normal launch.

/** Everything the page has failed at, oldest first. */
export const failures = [];

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
