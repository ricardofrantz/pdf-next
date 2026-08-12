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

const POLL_INTERVAL: Duration = Duration::from_secs(1);

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

/// Point the watcher at a file and describe it for the frontend.
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
    drop(state);

    Ok(describe(&canonical))
}

#[tauri::command]
fn open_path(path: String, watched: State<'_, Watched>) -> Result<FileInfo, String> {
    adopt(&watched, PathBuf::from(path))
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

/// Resize the window so the document fills it without letterboxing, clamped to
/// the monitor's usable area. `aspect` is the document's width/height; `chrome`
/// is the toolbar height in logical pixels.
#[tauri::command]
fn fit_window(window: tauri::Window, aspect: f64, chrome: f64) -> Result<(), String> {
    if !(aspect.is_finite() && aspect > 0.05 && aspect < 20.0) {
        return Err("implausible aspect ratio".into());
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

    const BREATHING_ROOM: f64 = 24.0;
    const SIDE_MARGIN: f64 = 48.0;
    const SCROLLBAR: f64 = 16.0;

    let mut content_height = (available_height - BREATHING_ROOM - chrome).max(240.0);
    let mut content_width = content_height * aspect;
    let max_width = available_width - SIDE_MARGIN;
    if content_width > max_width {
        content_width = max_width;
        content_height = content_width / aspect;
    }

    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            content_width + SCROLLBAR,
            content_height + chrome,
        )))
        .map_err(|error| error.to_string())?;
    window.center().map_err(|error| error.to_string())
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
        std::thread::sleep(POLL_INTERVAL);

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

fn first_path_argument() -> Option<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|candidate| candidate.exists())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Watched::default())
        .invoke_handler(tauri::generate_handler![
            open_path,
            initial_file,
            pick_file,
            os_theme,
            fit_window,
            snap_left
        ])
        .setup(|app| {
            if let Some(path) = first_path_argument() {
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
        .run(tauri::generate_context!())
        .expect("failed to start pdf-next");
}
