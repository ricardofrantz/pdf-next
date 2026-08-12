// pdf-next — a tiny PDF/PNG viewer that reloads when the file changes.
//
// The Rust side does four things and nothing else: resolve the file to open,
// hand its path to the webview, watch it once a second, and open a file dialog
// on request. All rendering lives in the frontend.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Theme, WindowEvent};
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
/// configured asset scope is empty, so nothing else on disk is reachable even
/// if a document manages to run script at the app origin.
fn adopt(app: &AppHandle, watched: &Watched, path: PathBuf) -> Result<FileInfo, String> {
    if !path.exists() {
        return Err(format!("{} does not exist", path.display()));
    }
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    let (modified, len) = stat(&canonical).unwrap_or((None, 0));
    let _ = app.asset_protocol_scope().allow_file(&canonical);

    let mut state = watched.0.lock().map_err(|error| error.to_string())?;
    state.path = Some(canonical.clone());
    state.modified = modified;
    state.len = len;
    state.missing = false;
    drop(state);

    Ok(describe(&canonical))
}

#[tauri::command]
fn open_path(
    app: AppHandle,
    path: String,
    watched: State<'_, Watched>,
) -> Result<FileInfo, String> {
    adopt(&app, &watched, PathBuf::from(path))
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

/// Fill the left half of the usable screen — the other half is where your
/// editor lives.
#[tauri::command]
fn snap_left(window: tauri::Window) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("no monitor")?;
    let area = monitor.work_area();
    let scale = window.scale_factor().unwrap_or(1.0);
    let (frame_width, frame_height) = frame_extents(&window);
    let frame_width = (frame_width * scale).round() as u32;
    let frame_height = (frame_height * scale).round() as u32;

    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            area.position.x,
            area.position.y,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            (area.size.width / 2).saturating_sub(frame_width),
            area.size.height.saturating_sub(frame_height),
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
            &["pdf", "png", "jpg", "jpeg", "webp", "avif"],
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
    dock: bool,
    poll: Option<u64>,
    /// Everything after the first file, for the frontend to open as tabs. The
    /// first one is adopted here, because it is what the watcher follows.
    rest: Vec<String>,
}

/// `pdf-next paper.pdf figure.png --night --left --poll 2`
///
/// Flags are deliberately few: appearance, docking, and the watch interval —
/// the three things you would otherwise have to click after every launch.
/// Several files open as tabs, with the first one showing.
fn parse_arguments() -> (Option<PathBuf>, Launch) {
    let mut launch = Launch::default();
    let mut path = None;
    let mut args = std::env::args_os().skip(1).peekable();

    while let Some(argument) = args.next() {
        let text = argument.to_string_lossy().to_string();
        match text.as_str() {
            "--left" | "--dock" | "--dock-left" => launch.dock = true,
            "--night" | "--dark" => launch.mode = Some("night".into()),
            "--sepia" | "--reader" => launch.mode = Some("sepia".into()),
            "--invert" => launch.mode = Some("invert".into()),
            "--plain" | "--light" => launch.mode = Some("clear".into()),
            "--mode" => {
                if let Some(value) = args.next() {
                    launch.mode = Some(value.to_string_lossy().to_string());
                }
            }
            "--poll" => {
                if let Some(value) = args.next() {
                    launch.poll = value.to_string_lossy().parse().ok();
                }
            }
            _ => {
                let candidate = PathBuf::from(&argument);
                if !candidate.exists() {
                    continue;
                }
                if path.is_none() {
                    path = Some(candidate);
                } else {
                    launch.rest.push(candidate.to_string_lossy().to_string());
                }
            }
        }
    }

    (path, launch)
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
    tauri::Builder::default()
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .manage(Watched::default())
        .invoke_handler(tauri::generate_handler![
            open_path,
            initial_file,
            pick_file,
            os_theme,
            fit_window,
            window_size,
            set_poll_seconds,
            launch_options,
            siblings,
            snap_left
        ])
        .setup(|app| {
            let (path, launch) = parse_arguments();
            if let Some(seconds) = launch.poll {
                POLL_SECONDS.store(seconds.min(60), Ordering::Relaxed);
            }
            app.manage(launch);
            if let Some(path) = path {
                let _ = adopt(app.handle(), &app.state::<Watched>(), path);
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
        .run(tauri::generate_context!())
        .expect("failed to start pdf-next");
}
