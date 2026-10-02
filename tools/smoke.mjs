// Open every fixture in the built viewer and check rendering and file access.
//
// The gap this closes: a Tauri app is two programs. `cargo build` proves the
// Rust half compiles and `tauri build` proves a bundle can be made, but
// neither runs the webview, so a frontend that fails to draw ships green. That
// is how 0.9.0 reached macOS with a window that opened and stayed empty.
//
// Under PDF_NEXT_SMOKE the app reports what it rendered and exits on that
// answer. This script runs it once per fixture and fails the build on the
// first blank window.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join, resolve } from 'node:path';

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
function denseReviews(file) {
  return Array.from({ length: 32 }, (_, index) => {
    const id = `r${index + 1}`;
    return {
      id,
      file: basename(file),
      kind: 'pdf',
      at: { page: 1 },
      quote: `Scroll render ${index * 8}`,
      comment: `Smoke review ${id}`,
      action: index % 2 === 0 ? 'delete' : 'improve',
      status: 'open',
      resolution: '',
      color: (index % 16) + 1,
      source: {
        file: `chapter-${index + 1}.tex`,
        agentExtension: { token: `source-${id}` },
      },
      agentExtension: { token: `review-${id}` },
    };
  });
}

function reviewStore(file, revision, reviews = []) {
  return JSON.stringify({
    format: 3,
    revision,
    nextId: reviews.length + 1,
    document: { task: 'PDF review smoke fixture', pdf: basename(file), project: '.' },
    reviews,
  });
}

function validateDenseSidecar(file, revision) {
  const sidecar = join(dirname(file), `${basename(file, extname(file))}_review.json`);
  const store = JSON.parse(readFileSync(sidecar, 'utf8'));
  if (store.format !== 3 || store.revision !== revision || store.nextId !== 33) {
    throw new Error('dense-page sidecar format, revision, or nextId changed');
  }
  if (store.reviews.length !== 32 || new Set(store.reviews.map((review) => review.id)).size !== 32) {
    throw new Error('dense-page sidecar lost or duplicated review IDs');
  }
  const colors = new Set();
  for (let index = 0; index < 32; index += 1) {
    const id = `r${index + 1}`;
    const review = store.reviews[index];
    if (
      review.id !== id ||
      review.quote !== `Scroll render ${index * 8}` ||
      review.action !== (index % 2 === 0 ? 'delete' : 'improve') ||
      review.source?.file !== `chapter-${index + 1}.tex` ||
      review.source?.agentExtension?.token !== `source-${id}` ||
      review.agentExtension?.token !== `review-${id}`
    ) {
      throw new Error(`dense-page review metadata changed for ${id}`);
    }
    colors.add(review.color);
  }
  if (colors.size !== 16) {
    throw new Error('dense-page sidecar lost one or more persistent review colors');
  }
}

function exclusiveWindowsWrite(file, revision) {
  // The path travels through the environment, never through the command text.
  const suffix = Buffer.from(`\n% pdf-next smoke revision ${revision}\n`, 'ascii').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
$path = $env:PDF_NEXT_SMOKE_PATH
$stream = $null
$deadline = [System.DateTime]::UtcNow.AddSeconds(2)
while ($null -eq $stream) {
  try {
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    if ([System.DateTime]::UtcNow -ge $deadline) { throw }
    Start-Sleep -Milliseconds 100
  }
}
try {
  $original = New-Object byte[] ([int]$stream.Length)
  $read = 0
  while ($read -lt $original.Length) {
    $count = $stream.Read($original, $read, $original.Length - $read)
    if ($count -le 0) { throw 'short read from smoke PDF' }
    $read += $count
  }
  $tail = [System.Convert]::FromBase64String('${suffix}')
  $final = New-Object byte[] ($original.Length + $tail.Length)
  [Array]::Copy($original, 0, $final, 0, $original.Length)
  [Array]::Copy($tail, 0, $final, $original.Length, $tail.Length)
  $stream.Position = 0
  $stream.SetLength(0)
  $middle = [int][Math]::Floor($final.Length / 2)
  $stream.Write($final, 0, $middle)
  $stream.Flush($true)
  Start-Sleep -Milliseconds 1200
  $stream.Write($final, $middle, $final.Length - $middle)
  $stream.SetLength($final.Length)
  $stream.Flush($true)
} finally {
  $stream.Dispose()
}`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    env: { ...process.env, PDF_NEXT_SMOKE_PATH: file },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`exclusive Windows writer failed: ${result.error || result.stderr || result.status}`);
  }
}

function awaitFinalRender(
  output,
  digest,
  reviewRevision,
  initialSourceRevision,
  expectedReviewCounts,
  seconds,
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + Math.min(seconds * 1000, 20_000);
    const poll = () => {
      for (const line of output().split('\n')) {
        if (!line.startsWith('smoke: ready ')) {
          continue;
        }
        const sourceRevision = Number(line.match(/sourceRevision=(\d+)/)?.[1]);
        const currentDigest = line.match(/documentSha256=([a-f\d]{64})/i)?.[1];
        const currentReviewRevision = Number(line.match(/reviewsRevision=(\d+)/)?.[1]);
        const reviewsMatch = Object.entries(expectedReviewCounts).every(
          ([field, value]) => line.includes(`${field}=${value}`),
        );
        if (
          sourceRevision > initialSourceRevision &&
          currentDigest === digest &&
          currentReviewRevision === reviewRevision &&
          reviewsMatch
        ) {
          resolvePromise(sourceRevision);
          return;
        }
      }
      if (Date.now() >= deadline) {
        rejectPromise(new Error(
          `viewer did not render final PDF digest ${digest} with review revision ${reviewRevision} and review checks ${JSON.stringify(expectedReviewCounts)}`,
        ));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function open(binary, file, seconds) {
  return new Promise((resolvePromise) => {
    const checkPdf = /\.pdf$/i.test(file);
    const checkFile = checkPdf || /\.png$/i.test(file);
    const child = spawn(binary, [file, '--no-focus'], {
      env: {
        ...process.env,
        PDF_NEXT_SMOKE: '1',
        PDF_NEXT_SMOKE_TIMEOUT: String(seconds),
        PDF_NEXT_SMOKE_HOLD: checkFile ? '1' : '0',
        // WebKitGTK picks a GPU path that no build server has.
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let checked = false;
    let checking = false;
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!checkFile || checking || !/^smoke: ready .+\n/m.test(output)) {
        return;
      }
      checking = true;
      void (async () => {
        try {
          if (!child.kill(0)) {
            throw new Error('viewer exited before the source-file checks');
          }
          const bytes = readFileSync(file);
          let expectedBytes = bytes;
          const stem = basename(file, extname(file));
          const sidecar = join(dirname(file), `${stem}_review.json`);
          const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
          const stressReload = stem.toLowerCase() === 'dense-page';
          const fixtureReviews = stressReload ? denseReviews(file) : [];
          if (stressReload) {
            const initial = output.match(/sourceRevision=(\d+)/);
            const initialSourceRevision = Number(initial?.[1]);
            if (!Number.isSafeInteger(initialSourceRevision)) {
              throw new Error('initial smoke report did not include a source revision');
            }
            let finalBytes = bytes;
            for (let revision = 1; revision <= 2; revision += 1) {
              finalBytes = Buffer.concat([
                bytes,
                Buffer.from(`\n% pdf-next smoke revision ${revision}\n`, 'ascii'),
              ]);
              writeFileSync(sidecar, reviewStore(file, revision, fixtureReviews));
              writeFileSync(sidecar, '');
              await pause(100);
              writeFileSync(sidecar, reviewStore(file, revision + 1, fixtureReviews));
              if (JSON.parse(readFileSync(sidecar, 'utf8')).revision !== revision + 1) {
                throw new Error('review sidecar did not retain its newest complete revision');
              }

              if (process.platform === 'win32' && revision === 1) {
                exclusiveWindowsWrite(file, revision);
              } else {
                const writable = openSync(file, 'r+');
                try {
                  ftruncateSync(writable, 0);
                  const middle = Math.max(1, Math.floor(finalBytes.length / 2));
                  writeSync(writable, finalBytes, 0, middle, 0);
                  await pause(1200);
                  writeSync(writable, finalBytes, middle, finalBytes.length - middle, middle);
                  ftruncateSync(writable, finalBytes.length);
                } finally {
                  closeSync(writable);
                }
              }

              const replacement = `${file}.replacement`;
              writeFileSync(replacement, finalBytes);
              renameSync(replacement, file);

              unlinkSync(file);
              await pause(1100);
              writeFileSync(file, finalBytes);
            }
            expectedBytes = finalBytes;
            const digest = createHash('sha256').update(finalBytes).digest('hex');
            const renderedRevision = await awaitFinalRender(
              () => output,
              digest,
              3,
              initialSourceRevision,
              {
                reviewsCount: 32,
                uniqueRowIds: 32,
                uniqueTints: 16,
                serializedIds: 32,
                agentExtensions: 32,
              },
              seconds,
            );
            validateDenseSidecar(file, 3);
            checked = true;
            const exclusiveWriterResult = process.platform === 'win32'
              ? 'Windows FileShare.None writer passed'
              : 'Windows exclusive-writer check skipped on this platform';
            output = output.replace(/^smoke: ready (.+)$/m,
              `smoke: ok $1; final SHA-256 ${digest} rendered at source revision ${renderedRevision}, review revision 3; ${exclusiveWriterResult}`);
          } else {
            // Keep access checks quick for the other PDF fixtures. Dense-page
            // above drives the slower incomplete-write and reload assertions.
            const writable = openSync(file, 'r+');
            try {
              writeSync(writable, bytes, 0, 1, 0);
            } finally {
              closeSync(writable);
            }
            const replacement = `${file}.replacement`;
            writeFileSync(replacement, bytes);
            renameSync(replacement, file);
            unlinkSync(file);
            writeFileSync(file, bytes);
            if (checkPdf) {
              writeFileSync(sidecar, reviewStore(file, 1));
              writeFileSync(sidecar, '');
              writeFileSync(sidecar, reviewStore(file, 2));
              if (!JSON.parse(readFileSync(sidecar, 'utf8')).reviews) {
                throw new Error('review sidecar did not retain a complete store');
              }
            }
            checked = true;
            output = output.replace(/^smoke: ready (.+)$/m,
              `smoke: ok $1; source replace/delete-recreate${checkPdf ? ' and sidecar rewrite' : ''} passed`);
          }
          if (!readFileSync(file).equals(expectedBytes)) {
            throw new Error('source bytes differ after the source access checks');
          }
        } catch (error) {
          output = output.replace(/^smoke: ready .+$/m, `smoke: fail source-file check: ${error}`);
        }
        if (!child.kill('SIGTERM')) {
          checked = false;
          output += '\nsmoke: fail viewer exited during the source-file checks\n';
        }
      })();
    });
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
      if (checkFile && !checking) {
        output += '\nsmoke: fail source-file checks did not run\n';
      }
      const passed = checked && !/^smoke: fail\b/m.test(output);
      resolvePromise({ code: checkFile ? (passed ? 0 : -1) : code, output });
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
mkdirSync(join(root, 'scratch'), { recursive: true });
const copies = mkdtempSync(join(root, 'scratch', 'smoke-fixtures-'));
try {
  for (const file of files) {
    const opened = join(copies, basename(file));
    copyFileSync(file, opened);
    if (basename(opened).toLowerCase() === 'dense-page.pdf') {
      const reviews = denseReviews(opened);
      writeFileSync(join(copies, 'dense-page_review.json'), reviewStore(opened, 1, reviews));
    }
    const { code, output } = await open(binary, opened, seconds);
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
} finally {
  rmSync(copies, { recursive: true, force: true });
}

console.log(`\n${files.length - failed}/${files.length} rendered`);
process.exit(failed === 0 ? 0 : 1);
