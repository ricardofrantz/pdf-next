// Open every fixture in the built viewer and check that it drew something.
//
// The gap this closes: a Tauri app is two programs. `cargo build` proves the
// Rust half compiles and `tauri build` proves a bundle can be made, but
// neither runs the webview, so a frontend that fails to draw ships green. That
// is how 0.9.0 reached macOS with a window that opened and stayed empty.
//
// Under PDF_NEXT_SMOKE the app reports what it rendered and exits on that
// answer. This script runs it once per fixture and fails the build on the
// first blank window.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src-tauri', 'target');

/// Where a build leaves its release output. The release workflow builds macOS
/// for both architectures at once, which lands under the target triple
/// instead, and that universal bundle is the one people install — so it is
/// the one worth testing first.
const releaseDirs = [
  join(target, 'universal-apple-darwin', 'release'),
  join(target, 'release'),
];

/// The binary a reader would actually start, per platform. On macOS that is
/// the one inside the bundle: a bare binary is not the app that ships, and
/// WebKit does not treat the two the same.
function findBinary() {
  if (process.env.PDF_NEXT_BIN) {
    return process.env.PDF_NEXT_BIN;
  }
  const candidates = releaseDirs.flatMap((release) =>
    process.platform === 'darwin'
      ? [join(release, 'bundle', 'macos', 'pdf-next.app', 'Contents', 'MacOS', 'pdf-next')]
      : process.platform === 'win32'
        ? [join(release, 'pdf-next.exe')]
        : [join(release, 'pdf-next')],
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no built viewer found. Looked for:\n  ${candidates.join('\n  ')}\n` +
      `Build it first: bun run build`,
  );
}

/// Run the viewer on one file and return what it said.
function open(binary, file, seconds) {
  return new Promise((resolvePromise) => {
    const child = spawn(binary, [file, '--no-focus'], {
      env: {
        ...process.env,
        PDF_NEXT_SMOKE: '1',
        PDF_NEXT_SMOKE_TIMEOUT: String(seconds),
        // WebKitGTK picks a GPU path that no build server has.
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));

    // Longer than the app's own watchdog, so a hung *process* is still caught
    // but the app's own report is what normally ends the run.
    const kill = setTimeout(() => child.kill('SIGKILL'), (seconds + 30) * 1000);
    child.on('error', (error) => {
      clearTimeout(kill);
      resolvePromise({ code: -1, output: String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      resolvePromise({ code, output });
    });
  });
}

const binary = findBinary();
const fixtures = join(root, 'tests', 'fixtures');
const files = readdirSync(fixtures)
  .filter((name) => /\.(pdf|png|md)$/i.test(name))
  .sort()
  .map((name) => join(fixtures, name));

if (files.length === 0) {
  console.error(`no fixtures in ${fixtures}`);
  process.exit(1);
}

const seconds = Number(process.env.PDF_NEXT_SMOKE_TIMEOUT || 90);
console.log(`smoke: ${binary}\n`);

let failed = 0;
for (const file of files) {
  const { code, output } = await open(binary, file, seconds);
  const verdict = output.split('\n').find((line) => line.startsWith('smoke:')) || '';
  if (code === 0 && verdict.startsWith('smoke: ok')) {
    console.log(`  PASS  ${file}\n        ${verdict}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${file}  (exit ${code})`);
    console.log(
      output
        .trimEnd()
        .split('\n')
        .map((line) => `        ${line}`)
        .join('\n'),
    );
  }
}

console.log(`\n${files.length - failed}/${files.length} rendered`);
process.exit(failed === 0 ? 0 : 1);
