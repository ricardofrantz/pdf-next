// pdf-next — a tiny PDF/PNG/Markdown viewer that reloads when the file changes.
//
// The Rust side does five things and nothing else: resolve the file to open,
// serve its bytes to the webview, watch it once a second, render markdown to
// sanitized HTML, and open a file dialog on request. PDF and image rendering
// live in the frontend.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{http, AppHandle, Emitter, Manager, State, Theme, WindowEvent};
use tauri_plugin_dialog::DialogExt;

/// Poll cadence in seconds; 0 turns watching off. Changing it takes effect on
/// the next tick.
static POLL_SECONDS: AtomicU64 = AtomicU64::new(1);
const IDLE_TICK: Duration = Duration::from_millis(500);

/// Snapshot of the watched file. `missing` is a state, not an error: TeX-style
/// builds delete and recreate the PDF, and the viewer must hold the last good
/// render across that gap instead of clearing.
#[derive(Default)]
struct WatchState {
    path: Option<PathBuf>,
    modified: Option<SystemTime>,
    len: u64,
    missing: bool,
    /// Every file the reader has opened this session, canonicalized. This is
    /// the whole trust boundary for file access: the doc protocol and the
    /// markdown renderer serve members of this set and nothing else.
    allowed: HashSet<PathBuf>,
    /// Files that arrived before the frontend was listening — from a Finder
    /// double-click on macOS, or a second `pdf-next` run — waiting to be
    /// collected by `pending_files`. Once `ready` is set they are emitted
    /// live instead.
    pending: Vec<String>,
    ready: bool,
}

#[derive(Default)]
struct Watched(Mutex<WatchState>);

/// Bumped on every detected change so the frontend can bust the webview's
/// cache for a path that never changes.
static REVISION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
struct FileInfo {
    path: String,
    name: String,
    kind: &'static str,
    revision: u64,
}

#[derive(Clone, Serialize)]
struct WatchEvent {
    kind: &'static str,
    revision: u64,
}

fn kind_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("pdf") => "pdf",
        Some("png" | "jpg" | "jpeg" | "webp" | "avif" | "gif" | "bmp") => "image",
        Some("md" | "markdown") => "markdown",
        _ => "unknown",
    }
}

fn describe(path: &Path) -> FileInfo {
    FileInfo {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default(),
        kind: kind_for(path),
        revision: REVISION.load(Ordering::Relaxed),
    }
}

fn stat(path: &Path) -> Option<(Option<SystemTime>, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.modified().ok(), metadata.len()))
}

/// Is the file finished being written?
///
/// A build tool rewrites a PDF over hundreds of milliseconds, and the metadata
/// changes the moment it starts. Reloading then shows a truncated document. On
/// Windows the writer usually holds an exclusive lock so `File::open` fails
/// outright; on macOS and Linux nothing stops us reading a half-written file,
/// so PDFs are additionally checked for their `%%EOF` trailer.
fn is_complete(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(mut file) = std::fs::File::open(path) else {
        return false; // locked by the writer (Windows) or briefly gone
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    let len = metadata.len();
    if len == 0 {
        return false;
    }
    if kind_for(path) != "pdf" {
        return true;
    }

    let tail = len.min(2048);
    if file.seek(SeekFrom::End(-(tail as i64))).is_err() {
        return false;
    }
    let mut buffer = vec![0u8; tail as usize];
    if file.read_exact(&mut buffer).is_err() {
        return false;
    }
    buffer.windows(5).any(|window| window == b"%%EOF")
}

/// Point the watcher at a file and describe it for the frontend.
///
/// This is also where the webview earns the right to read that one file: the
/// doc protocol serves only paths recorded here, so nothing else on disk is
/// reachable even if a document manages to run script at the app origin.
fn adopt(watched: &Watched, path: PathBuf) -> Result<FileInfo, String> {
    if !path.exists() {
        return Err(format!("{} does not exist", path.display()));
    }
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    let (modified, len) = stat(&canonical).unwrap_or((None, 0));

    let mut state = watched.0.lock().map_err(|error| error.to_string())?;
    state.path = Some(canonical.clone());
    state.modified = modified;
    state.len = len;
    state.missing = false;
    state.allowed.insert(canonical.clone());
    drop(state);

    Ok(describe(&canonical))
}

#[tauri::command]
fn open_path(path: String, watched: State<'_, Watched>) -> Result<FileInfo, String> {
    adopt(&watched, PathBuf::from(path))
}

/// Sort the way a person reads file names: `fig2` before `fig10`.
fn natural_key(name: &str) -> Vec<(u64, String)> {
    let mut parts = Vec::new();
    let mut characters = name.chars().peekable();
    while characters.peek().is_some() {
        let digits: String =
            std::iter::from_fn(|| characters.next_if(char::is_ascii_digit)).collect();
        let text: String =
            std::iter::from_fn(|| characters.next_if(|c| !c.is_ascii_digit())).collect();
        parts.push((digits.parse::<u64>().unwrap_or(0), text.to_lowercase()));
    }
    parts
}

/// Every file of the same kind sitting next to this one, in reading order, so
/// the viewer can step through a folder of figures.
#[tauri::command]
fn siblings(path: String) -> Vec<String> {
    let path = PathBuf::from(path);
    let kind = kind_for(&path);
    let Some(directory) = path.parent() else {
        return Vec::new();
    };

    let mut entries: Vec<PathBuf> = std::fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|candidate| candidate.is_file() && kind_for(candidate) == kind)
        .collect();

    entries.sort_by_key(|candidate| {
        natural_key(&candidate.file_name().unwrap_or_default().to_string_lossy())
    });
    entries
        .into_iter()
        .map(|candidate| candidate.to_string_lossy().to_string())
        .collect()
}

/// The file this window was launched with, if any.
#[tauri::command]
fn initial_file(watched: State<'_, Watched>) -> Option<FileInfo> {
    let state = watched.0.lock().ok()?;
    state.path.as_deref().map(describe)
}

/// Files handed to the app before the frontend was listening. Calling this
/// also marks the frontend ready, so anything that arrives afterwards comes as
/// an `open-files` event instead.
#[tauri::command]
fn pending_files(watched: State<'_, Watched>) -> Vec<String> {
    let Ok(mut state) = watched.0.lock() else {
        return Vec::new();
    };
    state.ready = true;
    std::mem::take(&mut state.pending)
}

/// Hand files to the window, however they arrived: a Finder double-click or
/// `open -a pdf-next x.pdf` on macOS, or a second `pdf-next x.pdf` while the
/// first is running. Live when the frontend is listening; otherwise the first
/// becomes the launch file and the rest wait for `pending_files`.
fn deliver(app: &AppHandle, paths: Vec<PathBuf>) {
    let paths: Vec<String> = paths
        .into_iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    if paths.is_empty() {
        return;
    }
    let Some(watched) = app.try_state::<Watched>() else {
        return;
    };
    let ready = {
        let Ok(mut state) = watched.0.lock() else {
            return;
        };
        if !state.ready {
            let mut paths = paths.iter();
            if state.path.is_none() {
                if let Some(first) = paths.next() {
                    drop(state);
                    let _ = adopt(&watched, PathBuf::from(first));
                    state = match watched.0.lock() {
                        Ok(state) => state,
                        Err(_) => return,
                    };
                }
            }
            state.pending.extend(paths.cloned());
        }
        state.ready
    };
    if ready {
        let _ = app.emit("open-files", &paths);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ── Markdown ──────────────────────────────────────────────────────────────

/// Markdown is a text format; anything bigger than this is not a document a
/// person is reading, and rendering it would only stall the reload loop.
const MARKDOWN_LIMIT: u64 = 10 * 1024 * 1024;

#[derive(Serialize)]
struct MarkdownDoc {
    html: String,
    raw: String,
}

/// CommonMark plus the GitHub extras people actually write, sanitized before
/// it crosses to the webview. The threat model is the same as for PDFs: the
/// attacker controls every byte of the file, and the rendered HTML lands in
/// the app origin — so scripts, event handlers and javascript: URLs must not
/// survive, and they don't: ammonia strips everything outside its allowlist.
/// Images are dropped too, deliberately: loading them would widen file access
/// beyond the one file the reader opened.
fn render_markdown(source: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    let mut rendered = String::with_capacity(source.len() + source.len() / 2);
    html::push_html(&mut rendered, Parser::new_ext(source, options));

    let mut builder = ammonia::Builder::default();
    builder.rm_tags(["img"]);
    // Task-list checkboxes; forms are inert anyway (form-action 'none').
    builder.add_tags(["input"]);
    builder.add_tag_attributes("input", ["type", "checked", "disabled"]);
    builder.clean(&rendered).to_string()
}

/// Rendered and raw in one call, so the raw/rendered toggle costs nothing.
/// Only files the reader has opened may be read — same boundary as the bytes.
#[tauri::command]
fn read_markdown(path: String, watched: State<'_, Watched>) -> Result<MarkdownDoc, String> {
    let canonical =
        std::fs::canonicalize(PathBuf::from(path)).map_err(|error| error.to_string())?;
    {
        let state = watched.0.lock().map_err(|error| error.to_string())?;
        if !state.allowed.contains(&canonical) {
            return Err("file was never opened".into());
        }
    }
    if kind_for(&canonical) != "markdown" {
        return Err("not a markdown file".into());
    }
    let metadata = std::fs::metadata(&canonical).map_err(|error| error.to_string())?;
    if metadata.len() > MARKDOWN_LIMIT {
        return Err("markdown file is larger than 10 MB".into());
    }
    let raw = std::fs::read_to_string(&canonical).map_err(|error| error.to_string())?;
    let html = render_markdown(&raw);
    Ok(MarkdownDoc { html, raw })
}

// ── Serving document bytes ────────────────────────────────────────────────

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("md" | "markdown") => "text/markdown",
        _ => "application/octet-stream",
    }
}

/// The `doc://` protocol carries document bytes into the webview, replacing
/// the asset protocol. Two reasons it exists:
///
/// Memory: every reload used to hit the webview's HTTP cache under a fresh
/// cache-busted URL, growing the process by ~10 MB per reload of a real paper.
/// `Cache-Control: no-store` keeps revisions out of the cache entirely.
///
/// Security: the allowlist check lives in this handler, in our own code, and
/// the served set is exactly the files the reader has opened this session.
fn serve_document(app: &AppHandle, request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let deny = |status: u16| {
        http::Response::builder()
            .status(status)
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .expect("static response")
    };
    if request.method() != http::Method::GET {
        return deny(405);
    }
    // convertFileSrc percent-encodes the whole path into the URL path segment.
    let Ok(requested) =
        percent_encoding::percent_decode_str(request.uri().path().trim_start_matches('/'))
            .decode_utf8()
    else {
        return deny(400);
    };
    let Ok(canonical) = std::fs::canonicalize(PathBuf::from(requested.as_ref())) else {
        return deny(404);
    };
    let allowed = app
        .try_state::<Watched>()
        .and_then(|watched| {
            watched
                .0
                .lock()
                .ok()
                .map(|state| state.allowed.contains(&canonical))
        })
        .unwrap_or(false);
    if !allowed {
        return deny(404);
    }
    let Ok(bytes) = std::fs::read(&canonical) else {
        return deny(404);
    };
    http::Response::builder()
        .status(200)
        .header("Content-Type", mime_for(&canonical))
        .header("Content-Length", bytes.len().to_string())
        .header("Cache-Control", "no-store")
        // PDF.js fetches these bytes from the app origin; without this header
        // the cross-origin fetch to doc.localhost is blocked by the webview.
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .expect("document response")
}

/// How much bigger the whole window is than its content, in logical pixels.
fn frame_extents(window: &tauri::Window) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    match (window.outer_size(), window.inner_size()) {
        (Ok(outer), Ok(inner)) => (
            f64::from(outer.width.saturating_sub(inner.width)) / scale,
            f64::from(outer.height.saturating_sub(inner.height)) / scale,
        ),
        _ => (0.0, 40.0),
    }
}

/// Resize to an exact inner size in logical pixels, clamped to the monitor's
/// usable area. The frontend measures the rendered page, so the window ends up
/// wrapped tightly around the document instead of guessing from an aspect ratio.
///
/// `exact` picks how a clamp is spent. On a fresh open the document is about to
/// be scaled to fit, so shrinking one axis has to shrink the other or the page
/// sits in a letterbox — that is the aspect-preserving path. When the frontend
/// is wrapping the window around content it has already laid out, the content
/// does not rescale; it scrolls. Preserving the aspect there would leave a band
/// of empty desk down the side of a page taller than the screen, so each axis
/// is clamped on its own.
#[tauri::command]
fn fit_window(
    window: tauri::Window,
    width: f64,
    height: f64,
    recenter: bool,
    exact: bool,
) -> Result<(), String> {
    if !(width.is_finite() && height.is_finite() && width > 80.0 && height > 80.0) {
        return Err("implausible window size".into());
    }
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("no monitor")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    // set_size sets the *inner* size, so the title bar and borders have to come
    // off the budget or the window ends up under the taskbar.
    let (frame_width, frame_height) = frame_extents(&window);
    let available_width = f64::from(area.size.width) / scale - frame_width;
    let available_height = f64::from(area.size.height) / scale - frame_height;

    let aspect = width / height;
    let mut inner_width = width.min(available_width);
    let mut inner_height = height.min(available_height);
    if !exact {
        // Keep the document's proportions when the screen forces a clamp.
        if inner_width < width {
            inner_height = inner_height.min(inner_width / aspect);
        }
        if inner_height < height {
            inner_width = inner_width.min(inner_height * aspect);
        }
    }

    // A floor low enough that zooming a figure down still gives you the window
    // you asked for. Below roughly this the toolbar starts to clip, which is
    // the reader's business, not something to silently override.
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            inner_width.max(240.0),
            inner_height.max(160.0),
        )))
        .map_err(|error| error.to_string())?;
    if recenter {
        window.center().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Current inner size in logical pixels, so the frontend can remember it.
#[tauri::command]
fn window_size(window: tauri::Window) -> Result<(f64, f64), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().map_err(|error| error.to_string())?;
    Ok((
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    ))
}

/// 0 turns the watcher off; anything else is the poll cadence in seconds.
#[tauri::command]
fn set_poll_seconds(seconds: u64) {
    POLL_SECONDS.store(seconds.min(60), Ordering::Relaxed);
}

/// Fill half of the usable screen — the other half is where your editor
/// lives. `edge` names the half: left, right, top or bottom.
#[tauri::command]
fn snap(window: tauri::Window, edge: String) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("no monitor")?;
    let area = monitor.work_area();
    let scale = window.scale_factor().unwrap_or(1.0);
    let (frame_width, frame_height) = frame_extents(&window);
    let frame_width = (frame_width * scale).round() as u32;
    let frame_height = (frame_height * scale).round() as u32;

    let half_width = area.size.width / 2;
    let half_height = area.size.height / 2;
    let (x, y, width, height) = match edge.as_str() {
        "left" => (
            area.position.x,
            area.position.y,
            half_width,
            area.size.height,
        ),
        "right" => (
            area.position.x + half_width as i32,
            area.position.y,
            half_width,
            area.size.height,
        ),
        "top" => (
            area.position.x,
            area.position.y,
            area.size.width,
            half_height,
        ),
        "bottom" => (
            area.position.x,
            area.position.y + half_height as i32,
            area.size.width,
            half_height,
        ),
        _ => return Err(format!("unknown dock edge: {edge}")),
    };

    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            width.saturating_sub(frame_width),
            height.saturating_sub(frame_height),
        )))
        .map_err(|error| error.to_string())
}

fn theme_name(theme: Theme) -> &'static str {
    match theme {
        Theme::Dark => "dark",
        _ => "light",
    }
}

/// WebView2 does not resolve `prefers-color-scheme` from the OS on its own, so
/// the shell reports the window theme and the frontend stamps it on <html>.
#[tauri::command]
fn os_theme(window: tauri::Window) -> &'static str {
    window.theme().map(theme_name).unwrap_or("light")
}

/// Async commands run off the main thread, so the blocking dialog is safe here.
#[tauri::command]
async fn pick_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter(
            "Documents and images",
            &[
                "pdf", "md", "markdown", "png", "jpg", "jpeg", "webp", "avif",
            ],
        )
        .blocking_pick_file()
        .map(|file| file.to_string())
}

/// One `stat` per second. Cheap enough to be invisible, fast enough that a
/// recompile shows up before you look back at the window.
fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        let seconds = POLL_SECONDS.load(Ordering::Relaxed);
        if seconds == 0 {
            std::thread::sleep(IDLE_TICK);
            continue;
        }
        std::thread::sleep(Duration::from_secs(seconds));

        let Some(watched) = app.try_state::<Watched>() else {
            continue;
        };
        let Ok(mut state) = watched.0.lock() else {
            continue;
        };
        let Some(path) = state.path.clone() else {
            continue;
        };

        match stat(&path) {
            Some((modified, len)) => {
                let changed = modified != state.modified || len != state.len;
                let reappeared = state.missing;
                if (changed || reappeared) && !is_complete(&path) {
                    // Still being written. Leave the recorded stat alone so the
                    // next tick sees it as a change again.
                    continue;
                }
                state.modified = modified;
                state.len = len;
                state.missing = false;
                if changed || reappeared {
                    let revision = REVISION.fetch_add(1, Ordering::Relaxed) + 1;
                    let _ = app.emit(
                        "file-changed",
                        WatchEvent {
                            kind: if reappeared { "restored" } else { "changed" },
                            revision,
                        },
                    );
                }
            }
            None => {
                // Mid-build gap. Report it once and keep the current render.
                if !state.missing {
                    state.missing = true;
                    let _ = app.emit(
                        "file-changed",
                        WatchEvent {
                            kind: "missing",
                            revision: REVISION.load(Ordering::Relaxed),
                        },
                    );
                }
            }
        }
    });
}

/// How the window should come up, from the command line.
#[derive(Clone, Default, Serialize)]
struct Launch {
    mode: Option<String>,
    /// Which screen half to fill, if any: left, right, top or bottom.
    dock: Option<String>,
    poll: Option<u64>,
    /// Everything after the first file, for the frontend to open as tabs. The
    /// first one is adopted here, because it is what the watcher follows.
    rest: Vec<String>,
    /// This build, for the update check: the version it compares against and
    /// the platform whose installer it should offer.
    version: String,
    platform: String,
}

/// Open a release download in the default browser.
///
/// The URL comes from the webview, and "open any URL" is exactly the kind of
/// primitive an injected script would love — so only the project's own
/// releases pass, and nothing else is openable from the frontend.
#[tauri::command]
fn open_download(url: String) -> Result<(), String> {
    const RELEASES: &str = "https://github.com/ricardofrantz/pdf-next/releases/";
    if !url.starts_with(RELEASES)
        || url.contains("..")
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("not a pdf-next release".into());
    }
    open::that_detached(&url).map_err(|error| error.to_string())
}

const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "\
usage: pdf-next [files...] [flags]

  pdf-next paper.pdf --night --left        dark pages, filling the left half
  pdf-next NOTES.md --sepia --poll 3       markdown as warm paper, checked every 3s
  pdf-next paper.pdf supp.pdf fig1.png     three tabs, the first one showing

files   .pdf  .png .jpg .jpeg .webp .avif .gif .bmp  .md .markdown
        If pdf-next is already running, the files open there as new tabs and
        this command returns at once. Each file opened is printed on stdout.

flags
  --left, --right, --top, --bottom   dock to that half of the screen
  --night, --sepia, --invert, --plain
                                     page appearance for this window only
  --mode <night|sepia|invert|clear>  the same, by name
  --poll <seconds>                   watch interval; 0 turns watching off
  --wait                             stay attached to the terminal until the
                                     window closes (macOS and Linux; by default
                                     pdf-next returns as soon as it has launched)
  -h, --help                         this text
  -V, --version                      the version

exit status: 0 launched or already running, 1 a file was not found,
             2 the command line could not be understood.
";

/// What the command line asked for.
enum Cli {
    Help,
    Version,
    Run(Invocation),
}

/// A launch: files to open (the first is the one the watcher follows), how the
/// window should come up, and whether to hold the terminal.
#[derive(Default)]
struct Invocation {
    files: Vec<PathBuf>,
    launch: Launch,
    wait: bool,
}

/// `pdf-next paper.pdf figure.png --night --left --poll 2`
///
/// Flags are deliberately few: appearance, docking, the watch interval and
/// `--wait` — the things you would otherwise have to click after every launch.
/// Anything else is answered, never swallowed: a program calling this must be
/// able to learn the contract from `--help`, and a mistyped path must fail
/// with an exit status instead of a blank window. `Err` carries that status
/// and a message for stderr. Relative paths resolve against `cwd`, because a
/// second instance forwards its arguments to a process with a different one.
fn parse_cli<I>(arguments: I, cwd: Option<&Path>) -> Result<Cli, (i32, String)>
where
    I: IntoIterator<Item = std::ffi::OsString>,
{
    let mut invocation = Invocation::default();
    let mut arguments = arguments.into_iter();

    while let Some(argument) = arguments.next() {
        let text = argument.to_string_lossy().to_string();
        match text.as_str() {
            "-h" | "--help" => return Ok(Cli::Help),
            "-V" | "--version" => return Ok(Cli::Version),
            "--wait" | "--foreground" => invocation.wait = true,
            "--left" | "--dock" | "--dock-left" => invocation.launch.dock = Some("left".into()),
            "--right" | "--dock-right" => invocation.launch.dock = Some("right".into()),
            "--top" | "--up" | "--dock-top" => invocation.launch.dock = Some("top".into()),
            "--bottom" | "--down" | "--dock-bottom" => {
                invocation.launch.dock = Some("bottom".into())
            }
            "--night" | "--dark" => invocation.launch.mode = Some("night".into()),
            "--sepia" | "--reader" => invocation.launch.mode = Some("sepia".into()),
            "--invert" => invocation.launch.mode = Some("invert".into()),
            "--plain" | "--light" => invocation.launch.mode = Some("clear".into()),
            "--mode" => match arguments.next() {
                Some(value) => invocation.launch.mode = Some(value.to_string_lossy().to_string()),
                None => {
                    return Err((
                        2,
                        "--mode needs a name: night, sepia, invert or clear".into(),
                    ))
                }
            },
            "--poll" => match arguments
                .next()
                .and_then(|v| v.to_string_lossy().parse().ok())
            {
                Some(seconds) => invocation.launch.poll = Some(seconds),
                None => return Err((2, "--poll needs a whole number of seconds".into())),
            },
            // macOS used to pass a process serial number to launched apps.
            _ if text.starts_with("-psn_") => {}
            _ if text.starts_with('-') && text.len() > 1 => {
                return Err((2, format!("unknown flag {text} (try --help)")));
            }
            _ => {
                let given = PathBuf::from(&argument);
                let candidate = match (given.is_absolute(), cwd) {
                    (false, Some(cwd)) => cwd.join(&given),
                    _ => given,
                };
                if !candidate.is_file() {
                    return Err((1, format!("no such file: {text}")));
                }
                invocation.files.push(candidate);
            }
        }
    }

    Ok(Cli::Run(invocation))
}

/// Was this process started by LaunchServices — Finder, the Dock, `open`?
/// Then the file comes as an Apple Event to *this* process and it must stay
/// alive to receive it. Terminal.app also sets this variable, to its own
/// identifier, and shells inherit it — hence the exact comparison.
#[cfg(target_os = "macos")]
fn launched_by_launch_services(identifier: &str) -> bool {
    std::env::var("__CFBundleIdentifier").as_deref() == Ok(identifier)
}

/// A viewer launched from a command line should hand the prompt back, like
/// `code` or `open` do — a script (or an agent) that opens a PDF must not be
/// held hostage until someone closes the window, and a shell tool's timeout
/// must not take the window down with it. Re-run ourselves detached, in a
/// process group of our own, and let this process exit. `--wait` opts out;
/// debug builds never detach, because `tauri dev` is watching this process.
#[cfg(unix)]
fn detach(arguments: &[std::ffi::OsString]) -> bool {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    Command::new(executable)
        .args(arguments)
        .arg("--wait")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .is_ok()
}

/// The release binary is a Windows GUI executable: no console of its own, so
/// nothing it prints goes anywhere. If it was started from one, borrow it, so
/// `--help` and `opened …` reach the person (or program) that typed them.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE,
    };
    // SAFETY: plain Win32 calls with no pointers. Only attach when stdout is
    // not already something — a pipe or file the caller redirected to must be
    // left alone, and attaching would replace it with the console.
    unsafe {
        if GetStdHandle(STD_OUTPUT_HANDLE).is_null() {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[tauri::command]
fn launch_options(launch: State<'_, Launch>) -> Launch {
    launch.inner().clone()
}

/// The webview must never leave the app's own origin.
///
/// A malicious PDF can carry a link annotation pointing anywhere. Without this,
/// clicking it replaces the whole viewer with an attacker-controlled page — in a
/// window with no address bar — and a link to the asset protocol would even be
/// served back as HTML at a *local* origin, which Tauri trusts with IPC. This is
/// top-level navigation only: subresources, fetches and PDF.js range requests
/// are unaffected.
fn navigation_guard() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("nav-guard")
        .on_navigation(|_webview, url| {
            let host = url.host_str();
            match url.scheme() {
                "tauri" => host == Some("localhost"),
                "http" | "https" => host == Some("tauri.localhost"),
                _ => false,
            }
        })
        .build()
}

fn main() {
    #[cfg(windows)]
    attach_console();

    // The command line is answered before any window exists, so `--help`,
    // `--version` and a mistyped path cost nothing and block nothing.
    let arguments: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let cwd = std::env::current_dir().ok();
    let invocation = match parse_cli(arguments.iter().cloned(), cwd.as_deref()) {
        Ok(Cli::Help) => {
            print!("pdf-next {VERSION} — tiny PDF, image and markdown viewer with live reload\n\n{USAGE}");
            return;
        }
        Ok(Cli::Version) => {
            println!("pdf-next {VERSION}");
            return;
        }
        Ok(Cli::Run(invocation)) => invocation,
        Err((status, message)) => {
            eprintln!("pdf-next: {message}");
            std::process::exit(status);
        }
    };

    // Say what happened, in canonical form, so a caller can verify rather
    // than assume. Printed once, by the process the caller ran.
    for file in &invocation.files {
        let shown = std::fs::canonicalize(file).unwrap_or_else(|_| file.clone());
        let shown = shown.to_string_lossy();
        // Windows canonical paths carry a `\\?\` prefix no person types.
        println!("opened {}", shown.strip_prefix(r"\\?\").unwrap_or(&shown));
    }
    let _ = std::io::Write::flush(&mut std::io::stdout());

    let context = tauri::generate_context!();

    #[cfg(unix)]
    {
        #[cfg(target_os = "macos")]
        let must_stay = launched_by_launch_services(&context.config().identifier);
        #[cfg(not(target_os = "macos"))]
        let must_stay = false;
        if !invocation.wait && !cfg!(debug_assertions) && !must_stay && detach(&arguments) {
            return;
        }
    }

    let Invocation {
        files, mut launch, ..
    } = invocation;
    let mut files = files.into_iter();
    let first = files.next();
    launch.rest = files
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    launch.version = VERSION.to_string();
    launch.platform = std::env::consts::OS.to_string();

    tauri::Builder::default()
        // Must be the first plugin: a second launch hands its files to the
        // running window and exits before anything else initializes.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let cwd = PathBuf::from(cwd);
            let arguments = argv.into_iter().skip(1).map(std::ffi::OsString::from);
            let files = match parse_cli(arguments, Some(&cwd)) {
                Ok(Cli::Run(invocation)) => invocation.files,
                _ => Vec::new(),
            };
            deliver(app, files);
        }))
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .manage(Watched::default())
        .register_uri_scheme_protocol("doc", |ctx, request| {
            serve_document(ctx.app_handle(), &request)
        })
        .invoke_handler(tauri::generate_handler![
            open_path,
            initial_file,
            pending_files,
            pick_file,
            os_theme,
            fit_window,
            window_size,
            set_poll_seconds,
            launch_options,
            siblings,
            read_markdown,
            snap,
            open_download
        ])
        .setup(move |app| {
            if let Some(seconds) = launch.poll {
                POLL_SECONDS.store(seconds.min(60), Ordering::Relaxed);
            }
            app.manage(launch);
            if let Some(path) = first {
                let _ = adopt(&app.state::<Watched>(), path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::ThemeChanged(theme) = event {
                        let _ = handle.emit("theme-changed", theme_name(*theme));
                    }
                });
            }
            spawn_watcher(app.handle().clone());
            Ok(())
        })
        .build(context)
        .expect("failed to start pdf-next")
        .run(|app, event| {
            // macOS delivers files opened from Finder, the Dock or `open -a`
            // as an Apple Event, not as arguments; without this arm a
            // double-clicked PDF opens an empty window.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                let files = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                deliver(app, files);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::{open_download, parse_cli, render_markdown, Cli};
    use std::ffi::OsString;

    fn cli(words: &[&str]) -> Result<Cli, (i32, String)> {
        parse_cli(words.iter().map(OsString::from), None)
    }

    #[test]
    fn help_and_version_are_answered_not_swallowed() {
        assert!(matches!(cli(&["--help"]), Ok(Cli::Help)));
        assert!(matches!(cli(&["-h"]), Ok(Cli::Help)));
        assert!(matches!(cli(&["--version"]), Ok(Cli::Version)));
        assert!(matches!(cli(&["-V"]), Ok(Cli::Version)));
    }

    #[test]
    fn mistakes_have_exit_codes() {
        assert_eq!(cli(&["--nope"]).err().map(|e| e.0), Some(2));
        assert_eq!(cli(&["--poll", "soon"]).err().map(|e| e.0), Some(2));
        assert_eq!(cli(&["--mode"]).err().map(|e| e.0), Some(2));
        let missing = cli(&["definitely-not-here.pdf"]).err().unwrap();
        assert_eq!(missing.0, 1);
        assert!(missing.1.contains("definitely-not-here.pdf"));
    }

    #[test]
    fn files_resolve_against_the_callers_directory() {
        let dir = std::env::temp_dir().join(format!("pdf-next-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.pdf"), b"%PDF-1.7\n%%EOF\n").unwrap();
        std::fs::write(dir.join("b.md"), b"# hi\n").unwrap();

        let parsed = parse_cli(
            ["a.pdf", "--night", "b.md", "--wait", "-psn_0_1"].map(OsString::from),
            Some(&dir),
        );
        let Ok(Cli::Run(invocation)) = parsed else {
            panic!("expected a run");
        };
        assert_eq!(invocation.files, vec![dir.join("a.pdf"), dir.join("b.md")]);
        assert_eq!(invocation.launch.mode.as_deref(), Some("night"));
        assert!(invocation.wait);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hostile_markdown_is_inert() {
        let html = render_markdown(
            "# Hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n\
             [link](javascript:alert(1))\n\n<p onclick=\"alert(1)\">text</p>",
        );
        assert!(html.contains("<h1>"));
        assert!(!html.contains("<script"));
        assert!(!html.contains("<img"));
        assert!(!html.contains("javascript:"));
        assert!(!html.contains("onclick"));
        assert!(!html.contains("onerror"));
    }

    #[test]
    fn github_extras_render() {
        let html = render_markdown(
            "| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] not yet\n\n~~gone~~",
        );
        assert!(html.contains("<table>"));
        assert!(html.contains("checkbox"));
        assert!(html.contains("<del>"));
    }
    #[test]
    fn only_pdf_next_releases_are_openable() {
        // The success path is deliberately untested: it would open a browser.
        for url in [
            "https://github.com/someone-else/pdf-next/releases/download/v1/x.exe",
            "https://evil.example/pdf-next/releases/x.exe",
            "https://github.com/ricardofrantz/pdf-next/releases/../../settings",
            "https://github.com/ricardofrantz/pdf-next/releases/x.exe --flag",
            "file:///etc/passwd",
        ] {
            assert!(open_download(url.into()).is_err(), "{url} must be refused");
        }
    }
}
