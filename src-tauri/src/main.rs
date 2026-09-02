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

/// Poll cadence in seconds; 0 turns watching off. The watcher re-reads this
/// every half second while it waits, so a change takes effect within one
/// IDLE_TICK rather than at the end of the old interval.
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
    /// Every file the reader has opened this session, canonicalized. The doc
    /// protocol and the markdown renderer serve members of this set and
    /// nothing else; `adopt` is the only way in, and it takes supported kinds
    /// only.
    allowed: HashSet<PathBuf>,
    /// Files that arrived before the frontend was listening — from a Finder
    /// double-click on macOS, or a second `pdf-next` run — waiting to be
    /// collected by `pending_files`. Once `ready` is set they are emitted
    /// live instead.
    pending: Vec<Opening>,
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

/// Where in a document to land: the fragment on a path
/// (`paper.pdf#page=12&search=Figure%203`), or the flags that say the same
/// thing. The field names are the ones RFC 8118 defines for PDF links, so a
/// reference that works in a browser works here too. A key this viewer has no
/// answer for — `zoom`, `view`, `viewrect` — is dropped rather than refused,
/// because a fragment is a hint and the file still opens without it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
struct Target {
    page: Option<u32>,
    nameddest: Option<String>,
    search: Option<String>,
}

/// What has to survive a round trip through a fragment. The others are
/// percent-encoded on the way out so the printed reference can be pasted back
/// in unchanged.
const FRAGMENT_ESCAPES: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'<')
    .add(b'>');

impl Target {
    /// The fragment this target amounts to, rebuilt. It goes on the `opened`
    /// line so a caller reads back what was understood instead of assuming.
    fn fragment(&self) -> String {
        let mut fields: Vec<String> = Vec::new();
        if let Some(page) = self.page {
            fields.push(format!("page={page}"));
        }
        if let Some(destination) = &self.nameddest {
            fields.push(format!("nameddest={}", escape_fragment(destination)));
        }
        if let Some(search) = &self.search {
            fields.push(format!("search={}", escape_fragment(search)));
        }
        fields.join("&")
    }

    /// Let a more specific target win field by field. A fragment written on
    /// the path speaks about that one file, so it overrides a flag that was
    /// aimed at whichever file came next.
    fn overridden_by(&mut self, other: Target) {
        if other.page.is_some() {
            self.page = other.page;
        }
        if other.nameddest.is_some() {
            self.nameddest = other.nameddest;
        }
        if other.search.is_some() {
            self.search = other.search;
        }
    }
}

fn escape_fragment(text: &str) -> String {
    percent_encoding::utf8_percent_encode(text, FRAGMENT_ESCAPES).to_string()
}

/// Read `page=12&search=Figure%203`.
fn parse_fragment(fragment: &str) -> Target {
    let mut target = Target::default();
    for field in fragment.split('&').filter(|field| !field.is_empty()) {
        let (key, value) = field.split_once('=').unwrap_or((field, ""));
        let value = percent_encoding::percent_decode_str(value)
            .decode_utf8_lossy()
            .to_string();
        match key.to_ascii_lowercase().as_str() {
            "page" => target.page = value.parse().ok().filter(|page| *page >= 1),
            "nameddest" | "dest" if !value.is_empty() => target.nameddest = Some(value),
            "search" | "find" if !value.is_empty() => target.search = Some(value),
            _ => {}
        }
    }
    target
}

/// One file to open, and where in it. Every route into the window — the launch
/// arguments, a second `pdf-next` run, a Finder double-click, a drop — hands
/// the frontend this shape.
#[derive(Clone, Debug, Serialize)]
struct Opening {
    path: String,
    target: Target,
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

/// Windows canonical paths carry a `\\?\` prefix no person types, and a
/// network path becomes `\\?\UNC\server\share\…`. Both are turned back into
/// the form a person would type; everything the frontend hands back is
/// canonicalized again before use, so the shorter form is as good as the long
/// one.
fn display_path(path: &Path) -> String {
    let shown = path.to_string_lossy();
    if let Some(unc) = shown.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    shown.strip_prefix(r"\\?\").unwrap_or(&shown).to_string()
}

fn describe(path: &Path) -> FileInfo {
    FileInfo {
        path: display_path(path),
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
/// This is also where a file joins the served set: the doc protocol and the
/// markdown renderer answer only for paths recorded here. The set is the
/// files the reader has named — on the command line, in the dialog, by
/// dropping them, or by stepping through a folder — and only of the kinds the
/// viewer can show. The webview can name a path itself, so this is a limit on
/// what is served, not a proof that nothing else is reachable.
fn adopt(watched: &Watched, path: PathBuf) -> Result<FileInfo, String> {
    if !path.exists() {
        return Err(format!("{} does not exist", path.display()));
    }
    if kind_for(&path) == "unknown" {
        return Err(format!(
            "unsupported file type: {}",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
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
///
/// A digit run is compared by its length and then its digits, with leading
/// zeros dropped, so runs longer than a machine integer still order correctly
/// instead of all reading as zero.
fn natural_key(name: &str) -> Vec<(usize, String, String)> {
    let mut parts = Vec::new();
    let mut characters = name.chars().peekable();
    while characters.peek().is_some() {
        let digits: String =
            std::iter::from_fn(|| characters.next_if(char::is_ascii_digit)).collect();
        let text: String =
            std::iter::from_fn(|| characters.next_if(|c| !c.is_ascii_digit())).collect();
        let digits = digits.trim_start_matches('0').to_string();
        parts.push((digits.len(), digits, text.to_lowercase()));
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
fn pending_files(watched: State<'_, Watched>) -> Vec<Opening> {
    let Ok(mut state) = watched.0.lock() else {
        return Vec::new();
    };
    state.ready = true;
    std::mem::take(&mut state.pending)
}

/// Hand files to the window, however they arrived: a Finder double-click or
/// `open -a pdf-next x.pdf` on macOS, or a second `pdf-next x.pdf` while the
/// first is running. Live when the frontend is listening; otherwise every
/// path waits for `pending_files`, and the first also becomes the launch file
/// if there is none yet, so the watcher has something to follow. The frontend
/// opens a path once however many times it hears it, so the overlap is free.
///
/// `focus` is what `--no-focus` turns off. A person handing over a file wants
/// the window; a script opening six figures in a row does not want the desktop
/// yanked six times, and the tabs are there when they look.
fn deliver(app: &AppHandle, files: Vec<(PathBuf, Target)>, focus: bool) {
    let openings: Vec<Opening> = files
        .into_iter()
        .filter_map(|(path, target)| {
            let path = std::fs::canonicalize(path).ok()?;
            Some(Opening {
                path: display_path(&path),
                target,
            })
        })
        .collect();
    if openings.is_empty() {
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
            if state.path.is_none() {
                if let Some(first) = openings.first() {
                    let path = PathBuf::from(&first.path);
                    drop(state);
                    let _ = adopt(&watched, path);
                    state = match watched.0.lock() {
                        Ok(state) => state,
                        Err(_) => return,
                    };
                }
            }
            state.pending.extend(openings.iter().cloned());
        }
        state.ready
    };
    if ready {
        let _ = app.emit("open-files", &openings);
    }
    if focus {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
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
/// beyond the one file the reader opened. Relative links go the same way: a
/// click on `[notes](other.md)` would be a top-level navigation inside the
/// app origin, which the navigation guard allows, and the viewer would be
/// replaced by a blank page with no way back. Absolute links stay, and are
/// stopped by the guard when clicked.
///
/// Same-page links survive, because footnotes are made of them. Every id the
/// document carries is prefixed so it cannot collide with the viewer's own
/// elements, and fragment links are rewritten to match; the frontend scrolls
/// to them rather than letting them navigate.
const MARKDOWN_ID_PREFIX: &str = "md-";

/// ammonia asks this about every relative URL. A fragment is pointed at the
/// prefixed id it will find in the cleaned document; any other relative path
/// is kept as written, for the frontend to resolve against the file's own
/// folder and open as a tab. Nothing here navigates: the click handler
/// intercepts every link, and the webview's navigation guard sits behind it.
fn keep_local_links(url: &str) -> Option<std::borrow::Cow<'_, str>> {
    let Some(fragment) = url.strip_prefix('#') else {
        return Some(std::borrow::Cow::Borrowed(url));
    };
    if fragment.is_empty() {
        return None;
    }
    Some(std::borrow::Cow::Owned(format!(
        "#{MARKDOWN_ID_PREFIX}{fragment}"
    )))
}

/// One TeX equation as MathML, for the sanitizer to read like any other
/// markup. The writer does not escape everything it emits (an operator `<`
/// goes out bare), so nothing here is trusted on its own: it is cleaned with
/// the rest of the document against the MathML allowlist below. No annotation,
/// which would carry the TeX source through unescaped.
fn render_math(tex: &str, display: bool) -> String {
    use pulldown_latex::{config::DisplayMode, push_mathml, Parser, RenderConfig, Storage};
    let storage = Storage::new();
    let parser = Parser::new(tex, &storage);
    let config = RenderConfig {
        display_mode: if display {
            DisplayMode::Block
        } else {
            DisplayMode::Inline
        },
        ..RenderConfig::default()
    };
    let mut mathml = String::new();
    if push_mathml(&mut mathml, parser, config).is_err() {
        // The writer only fails on an unrecoverable parse; show the source so
        // the reader can see what did not typeset.
        let mut fallback = String::from("<code>");
        html_escape_into(&mut fallback, tex);
        fallback.push_str("</code>");
        return fallback;
    }
    mathml
}

fn html_escape_into(out: &mut String, text: &str) {
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
}

/// MathML Core: the elements the equation renderer writes, and the
/// presentation attributes it sets on them. None of them runs anything;
/// `style` is the only one that could say more than it should, and it is
/// filtered below.
const MATHML_TAGS: [&str; 30] = [
    "math",
    "semantics",
    "mrow",
    "mi",
    "mn",
    "mo",
    "mtext",
    "mspace",
    "ms",
    "msup",
    "msub",
    "msubsup",
    "mfrac",
    "msqrt",
    "mroot",
    "mstyle",
    "merror",
    "mpadded",
    "mphantom",
    "mover",
    "munder",
    "munderover",
    "mmultiscripts",
    "mprescripts",
    "mtable",
    "mtr",
    "mtd",
    "maction",
    "menclose",
    "mglyph",
];

const MATHML_ATTRIBUTES: [&str; 35] = [
    "class",
    "style",
    "display",
    "displaystyle",
    "scriptlevel",
    "mathvariant",
    "mathsize",
    "mathcolor",
    "mathbackground",
    "stretchy",
    "symmetric",
    "largeop",
    "movablelimits",
    "fence",
    "separator",
    "form",
    "lspace",
    "rspace",
    "minsize",
    "maxsize",
    "accent",
    "accentunder",
    "linethickness",
    "width",
    "height",
    "depth",
    "voffset",
    "lspace",
    "columnalign",
    "rowalign",
    "columnspacing",
    "rowspacing",
    "columnlines",
    "rowlines",
    "notation",
];

/// The only inline styles that pass: a column alignment on a table cell, and
/// the handful of declarations the equation renderer writes on MathML
/// elements — each one a known property with a value made of nothing but
/// letters, digits, spaces and the punctuation a colour or a length needs.
fn keep_known_styles<'a>(
    element: &str,
    attribute: &str,
    value: &'a str,
) -> Option<std::borrow::Cow<'a, str>> {
    if attribute != "style" {
        return Some(std::borrow::Cow::Borrowed(value));
    }
    if matches!(element, "th" | "td") {
        return matches!(
            value,
            "text-align: left" | "text-align: center" | "text-align: right"
        )
        .then_some(std::borrow::Cow::Borrowed(value));
    }
    if !MATHML_TAGS.contains(&element) {
        return None;
    }
    let every_declaration_known = value.split(';').all(|declaration| {
        let declaration = declaration.trim();
        if declaration.is_empty() {
            return true;
        }
        let Some((property, rest)) = declaration.split_once(':') else {
            return false;
        };
        let known = matches!(
            property.trim(),
            "color" | "margin-left" | "height" | "border-color" | "width"
        );
        let plain = rest.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '#' | '(' | ')' | '%')
        });
        known && plain
    });
    every_declaration_known.then_some(std::borrow::Cow::Borrowed(value))
}

fn render_markdown(source: &str) -> String {
    use pulldown_cmark::{html, Event, Options, Parser};
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options.insert(Options::ENABLE_MATH);

    // `$…$` and `$$…$$` become MathML in the same stream, and the sanitizer
    // reads them along with everything else.
    let mut rendered = String::with_capacity(source.len() + source.len() / 2);
    let events = Parser::new_ext(source, options).map(|event| match event {
        Event::InlineMath(tex) => Event::Html(render_math(&tex, false).into()),
        Event::DisplayMath(tex) => Event::Html(render_math(&tex, true).into()),
        other => other,
    });
    html::push_html(&mut rendered, events);

    let mut builder = ammonia::Builder::default();
    builder.rm_tags(["img"]);
    builder.add_generic_attributes(["id"]);
    builder.id_prefix(Some(MARKDOWN_ID_PREFIX));
    builder.url_relative(ammonia::UrlRelative::Custom(Box::new(keep_local_links)));
    // Task-list checkboxes; forms are inert anyway (form-action 'none').
    builder.add_tags(["input"]);
    builder.add_tag_attributes("input", ["type", "checked", "disabled"]);
    // Footnotes are styled by class, and table columns keep their alignment.
    builder.add_allowed_classes("div", ["footnote-definition"]);
    builder.add_allowed_classes("sup", ["footnote-definition-label", "footnote-reference"]);
    builder.add_tag_attributes("th", ["style"]);
    builder.add_tag_attributes("td", ["style"]);
    // Equations.
    builder.add_tags(MATHML_TAGS);
    for tag in MATHML_TAGS {
        builder.add_tag_attributes(tag, MATHML_ATTRIBUTES);
    }
    builder.attribute_filter(keep_known_styles);
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
                "pdf", "md", "markdown", "png", "jpg", "jpeg", "webp", "avif", "gif", "bmp",
            ],
        )
        .blocking_pick_file()
        .map(|file| file.to_string())
}

/// Wait out one poll interval in IDLE_TICK steps, re-reading the cadence each
/// step. A shorter interval chosen mid-wait cuts the wait short, and 0 holds
/// here until watching is turned back on.
fn wait_for_tick() {
    let started = std::time::Instant::now();
    loop {
        let seconds = POLL_SECONDS.load(Ordering::Relaxed);
        if seconds != 0 && started.elapsed() >= Duration::from_secs(seconds) {
            return;
        }
        std::thread::sleep(IDLE_TICK);
    }
}

/// One `stat` per second. Cheap enough to be invisible, fast enough that a
/// recompile shows up before you look back at the window.
///
/// The lock is held only to read and write the snapshot, never across the
/// disk: the doc protocol and every command take the same lock, and a stat on
/// a slow volume must not stall a page fetch.
fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        wait_for_tick();

        let Some(watched) = app.try_state::<Watched>() else {
            continue;
        };
        let snapshot = {
            let Ok(state) = watched.0.lock() else {
                continue;
            };
            state
                .path
                .clone()
                .map(|path| (path, state.modified, state.len, state.missing))
        };
        let Some((path, recorded_modified, recorded_len, missing)) = snapshot else {
            continue;
        };

        match stat(&path) {
            Some((modified, len)) => {
                let changed = modified != recorded_modified || len != recorded_len;
                let reappeared = missing;
                if (changed || reappeared) && !is_complete(&path) {
                    // Still being written. Leave the recorded stat alone so the
                    // next tick sees it as a change again.
                    continue;
                }
                {
                    let Ok(mut state) = watched.0.lock() else {
                        continue;
                    };
                    if state.path.as_deref() != Some(path.as_path()) {
                        continue; // the reader moved on while the disk answered
                    }
                    state.modified = modified;
                    state.len = len;
                    state.missing = false;
                }
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
                if missing {
                    continue;
                }
                {
                    let Ok(mut state) = watched.0.lock() else {
                        continue;
                    };
                    if state.path.as_deref() != Some(path.as_path()) {
                        continue;
                    }
                    state.missing = true;
                }
                let _ = app.emit(
                    "file-changed",
                    WatchEvent {
                        kind: "missing",
                        revision: REVISION.load(Ordering::Relaxed),
                    },
                );
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
    /// Where to land in the launch file, if the command line said.
    target: Target,
    /// Everything after the first file, for the frontend to open as tabs. The
    /// first one is adopted here, because it is what the watcher follows.
    rest: Vec<Opening>,
    /// This build, for the update check: the version it compares against and
    /// the platform whose installer it should offer.
    version: String,
    platform: String,
}

/// Open a link from a markdown file in the default browser.
///
/// Web and mail only. A `file:` or an application's own scheme handed to the
/// shell is a way to run things, and a document must not have that.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let web = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:");
    if !web || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("not a web link".into());
    }
    open::that_detached(&url).map_err(|error| error.to_string())
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

/// Hand the window to the operating system's own print dialog.
///
/// The dialog is the system's, not one of ours and not the browser's: the
/// print panel on macOS, the GTK print dialog on Linux, and on Windows the
/// print window every other application opens — not WebView2's in-page
/// preview, which is what `window.print()` would give you. Printer, page
/// range, copies, duplex, paper and quality are all the system's to offer, and
/// pdf-next has no print settings of its own to get wrong.
///
/// The frontend has already laid the document out for paper by the time this
/// is called; every platform prints what the webview holds.
#[tauri::command]
fn print_document(webview: tauri::Webview) -> Result<(), String> {
    open_print_dialog(&webview)
}

/// Name the window: the file being read, and which build is reading it.
///
/// The text is the frontend's to compose — it knows the file and the tab — but
/// the window is this side's to set, and WebView2 never passes document.title
/// to the frame. A command rather than `core:window:allow-set-title` so the
/// webview's permission list stays events and nothing else.
#[tauri::command]
fn set_title(title: String, window: tauri::Window) -> Result<(), String> {
    window.set_title(&title).map_err(|error| error.to_string())
}

/// Why Windows would not be able to show a print dialog, if it would not.
///
/// `ShowPrintUI` reports success and then displays nothing at all when there
/// is no working print service — the worst possible answer to Ctrl+P, and one
/// no error path can catch, because there is no error. Asking the spooler for
/// the list of printers first turns that silence into a sentence. It has to be
/// this call and not `GetDefaultPrinter`, which reads the registry and so
/// answers happily while the service behind it is stopped.
#[cfg(windows)]
fn printing_unavailable() -> Option<&'static str> {
    use windows_sys::Win32::Graphics::Printing::{
        EnumPrintersW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    };

    // A zero-length buffer makes this a question rather than a fetch: with
    // printers to list it fails asking for room, and how else it fails — or
    // that it succeeds with nothing to report — is the answer.
    let mut needed: u32 = 0;
    let mut returned: u32 = 0;
    let listed = unsafe {
        EnumPrintersW(
            PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
            std::ptr::null_mut(),
            2,
            std::ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        )
    };
    if listed != 0 {
        return if needed == 0 {
            Some("Windows has no printer installed")
        } else {
            None
        };
    }
    match std::io::Error::last_os_error().raw_os_error() {
        // "Your buffer is too small" — there are printers to name.
        Some(122) => None,
        // The spooler is not answering: stopped, or disabled outright.
        Some(1722) | Some(6) => Some("the Windows Print Spooler service is not running"),
        _ => Some("Windows has no printer installed"),
    }
}

/// WebView2 asked for the system print window rather than its own preview.
///
/// The two ways this can go wrong are not the same, and the difference is the
/// whole point: a runtime older than `ShowPrintUI` (it arrived in
/// ICoreWebView2_16, runtime 110) has no system window to offer, and its own
/// preview is better than a button that does nothing. A dialog that refuses to
/// open is a failure to report — falling back there would answer "print" with
/// the in-page preview this deliberately avoids, which is exactly what
/// Windows does when the print spooler is not running.
#[cfg(windows)]
fn open_print_dialog(webview: &tauri::Webview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
    };
    use windows::core::Interface;

    enum Trouble {
        /// This runtime has never heard of the system print window.
        Unsupported,
        /// It has, and Windows would not open it.
        Refused(String),
    }

    // with_webview runs the closure on the UI thread, where the dialog has to
    // be opened, and swallows whatever it returns — so the outcome comes back
    // through here instead. Reading the slot straight after the call is sound
    // only because this is a synchronous command: Tauri dispatches those on
    // the UI thread, and with_webview runs the closure inline when it is
    // already there. Making this `async fn` would post the closure to the
    // event loop, and every failure would read as success.
    if let Some(reason) = printing_unavailable() {
        return Err(format!("Nothing to print to: {reason}."));
    }

    let trouble: std::sync::Arc<Mutex<Option<Trouble>>> = Default::default();
    let reported = trouble.clone();
    webview
        .with_webview(move |platform| {
            let show = || -> Result<(), Trouble> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|error| Trouble::Refused(error.to_string()))?;
                let printable: ICoreWebView2_16 = core.cast().map_err(|_| Trouble::Unsupported)?;
                unsafe { printable.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM) }
                    .map_err(|error| Trouble::Refused(error.to_string()))
            };
            if let Err(problem) = show() {
                if let Ok(mut slot) = reported.lock() {
                    *slot = Some(problem);
                }
            }
        })
        .map_err(|error| error.to_string())?;

    match trouble.lock().ok().and_then(|mut slot| slot.take()) {
        None => Ok(()),
        Some(Trouble::Unsupported) => webview.print().map_err(|error| error.to_string()),
        Some(Trouble::Refused(message)) => Err(format!(
            "Windows would not open the print dialog ({message}). Is the Print Spooler service running?"
        )),
    }
}

/// macOS runs an NSPrintOperation — the print panel, as a sheet on the window
/// — and Linux runs webkit2gtk's print operation, which is the GTK dialog.
/// Both are the system's own, so wry's own call is already the right one.
///
/// It cannot fail from here: tauri-runtime-wry discards wry's result, and wry
/// returns Ok on macOS even when the webview says it cannot print. The Err arm
/// is honest about the type, not a promise that a failure would reach it.
#[cfg(not(windows))]
fn open_print_dialog(webview: &tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|error| error.to_string())
}

const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "\
usage: pdf-next [files...] [flags]

  pdf-next paper.pdf --night --left        dark pages, filling the left half
  pdf-next NOTES.md --sepia --poll 3       markdown as warm paper, checked every 3s
  pdf-next paper.pdf supp.pdf fig1.png     three tabs, the first one showing
  pdf-next paper.pdf --page 12             open at page 12
  pdf-next paper.pdf --find \"Figure 3\"     open at the first match, highlighted
  pdf-next 'paper.pdf#page=7&search=wake'  the same, written as a link

files   .pdf  .png .jpg .jpeg .webp .avif .gif .bmp  .md .markdown
        A file may carry a fragment saying where to land in it, in the form
        PDF links use: page=N, nameddest=NAME, search=TEXT, joined by &, with
        spaces written %20. Quote it — a shell reads # as a comment.
        If pdf-next is already running, the files open there as new tabs and
        this command returns at once. A file that is already a tab is aimed at
        that page rather than opened twice. Each file opened is printed on
        stdout, with the fragment that was understood.

flags
  --left, --right, --top, --bottom   dock to that half of the screen
  --night, --sepia, --invert, --plain
                                     page appearance for this window only
  --mode <night|sepia|invert|clear>  the same, by name
  --page <n>                         open at that page
  --find <text>                      open at the first match, highlighted
  --dest <name>                      open at a named destination
                                     These three speak about the file named
                                     before them, or the first one when they
                                     come first.
  --no-focus                         hand the file over without raising the
                                     window
  --poll <seconds>                   watch interval; 0 turns watching off
  --wait                             stay attached to the terminal until the
                                     window closes (macOS and Linux; by default
                                     pdf-next returns as soon as it has launched)
  -h, --help                         this text
  -V, --version                      the version

exit status: 0 launched or already running, 1 a file was not found or is
             not a kind pdf-next can show,
             2 the command line could not be understood.
";

/// What the command line asked for.
enum Cli {
    Help,
    Version,
    // Boxed: a run carries the whole command line, and every `--help` would
    // otherwise pay for that much stack.
    Run(Box<Invocation>),
}

/// A launch: files to open (the first is the one the watcher follows), how the
/// window should come up, and whether to hold the terminal.
#[derive(Default)]
struct Invocation {
    files: Vec<(PathBuf, Target)>,
    launch: Launch,
    wait: bool,
    /// Set by `--no-focus`: open the file, leave the window where it is.
    no_focus: bool,
    /// A `--page`/`--find`/`--dest` that arrived before any file, waiting for
    /// the one it speaks about.
    carry: Target,
}

/// Which target a `--page`, `--find` or `--dest` is about: the file named
/// before it, or — when the flags come first — the one named next. Both orders
/// are natural to type, so both mean the same thing.
fn aimed_at(invocation: &mut Invocation) -> &mut Target {
    match invocation.files.last_mut() {
        Some((_, target)) => target,
        None => &mut invocation.carry,
    }
}

/// Resolve one argument the way the caller meant it, against the directory the
/// caller was in — which is not this process's own when a second instance
/// forwards its arguments.
fn against(path: PathBuf, cwd: Option<&Path>) -> PathBuf {
    match (path.is_absolute(), cwd) {
        (false, Some(cwd)) => cwd.join(path),
        _ => path,
    }
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
            "--page" => match arguments
                .next()
                .and_then(|value| value.to_string_lossy().parse::<u32>().ok())
                .filter(|page| *page >= 1)
            {
                Some(page) => aimed_at(&mut invocation).page = Some(page),
                None => return Err((2, "--page needs a page number, counting from 1".into())),
            },
            "--find" | "--search" => match arguments.next() {
                Some(value) if !value.is_empty() => {
                    aimed_at(&mut invocation).search = Some(value.to_string_lossy().to_string())
                }
                _ => return Err((2, "--find needs the text to look for".into())),
            },
            "--dest" | "--nameddest" => match arguments.next() {
                Some(value) if !value.is_empty() => {
                    aimed_at(&mut invocation).nameddest = Some(value.to_string_lossy().to_string())
                }
                _ => return Err((2, "--dest needs the name of a destination".into())),
            },
            "--no-focus" | "--background" => invocation.no_focus = true,
            // macOS used to pass a process serial number to launched apps.
            _ if text.starts_with("-psn_") => {}
            _ if text.starts_with('-') && text.len() > 1 => {
                return Err((2, format!("unknown flag {text} (try --help)")));
            }
            _ => {
                // `paper.pdf#page=12` is a path and a fragment — but only if
                // the part before the `#` is a file. A file whose name really
                // contains a `#` keeps its whole name, and keeps its OsString
                // too, which a lossy split would have flattened.
                let split = text.split_once('#').filter(|(before, _)| {
                    !before.is_empty() && against(PathBuf::from(before), cwd).is_file()
                });
                let (name, candidate, fragment) = match split {
                    Some((before, fragment)) => (
                        before.to_string(),
                        against(PathBuf::from(before), cwd),
                        parse_fragment(fragment),
                    ),
                    None => (
                        text.clone(),
                        against(PathBuf::from(&argument), cwd),
                        Target::default(),
                    ),
                };
                if !candidate.is_file() {
                    return Err((1, format!("no such file: {name}")));
                }
                if kind_for(&candidate) == "unknown" {
                    return Err((1, format!("not a file pdf-next can show: {name}")));
                }
                let mut target = std::mem::take(&mut invocation.carry);
                target.overridden_by(fragment);
                invocation.files.push((candidate, target));
            }
        }
    }

    Ok(Cli::Run(Box::new(invocation)))
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
        Ok(Cli::Run(invocation)) => *invocation,
        Err((status, message)) => {
            eprintln!("pdf-next: {message}");
            std::process::exit(status);
        }
    };

    // Say what happened, in canonical form, so a caller can verify rather
    // than assume. Printed once, by the process the caller ran.
    for (file, target) in &invocation.files {
        let shown = std::fs::canonicalize(file).unwrap_or_else(|_| file.clone());
        let fragment = target.fragment();
        let separator = if fragment.is_empty() { "" } else { "#" };
        println!("opened {}{separator}{fragment}", display_path(&shown));
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
        .map(|(path, target)| Opening {
            path: path.to_string_lossy().to_string(),
            target,
        })
        .collect();
    if let Some((_, target)) = &first {
        launch.target = target.clone();
    }
    launch.version = VERSION.to_string();
    launch.platform = std::env::consts::OS.to_string();

    tauri::Builder::default()
        // Must be the first plugin: a second launch hands its files to the
        // running window and exits before anything else initializes.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let cwd = PathBuf::from(cwd);
            let arguments = argv.into_iter().skip(1).map(std::ffi::OsString::from);
            let (files, focus) = match parse_cli(arguments, Some(&cwd)) {
                Ok(Cli::Run(invocation)) => (invocation.files, !invocation.no_focus),
                _ => (Vec::new(), true),
            };
            deliver(app, files, focus);
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
            open_download,
            open_link,
            print_document,
            set_title
        ])
        .setup(move |app| {
            if let Some(seconds) = launch.poll {
                POLL_SECONDS.store(seconds.min(60), Ordering::Relaxed);
            }
            app.manage(launch);
            if let Some((path, _)) = first {
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
                    .map(|path| (path, Target::default()))
                    .collect();
                deliver(app, files, true);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::{natural_key, open_download, open_link, parse_cli, render_markdown, Cli, Target};
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
        std::fs::write(dir.join("c.txt"), b"plain\n").unwrap();

        // A file that exists but cannot be shown is answered, not swallowed.
        let refused = parse_cli(["c.txt"].map(OsString::from), Some(&dir))
            .err()
            .unwrap();
        assert_eq!(refused.0, 1);
        assert!(refused.1.contains("c.txt"));

        let parsed = parse_cli(
            ["a.pdf", "--night", "b.md", "--wait", "-psn_0_1"].map(OsString::from),
            Some(&dir),
        );
        let Ok(Cli::Run(invocation)) = parsed else {
            panic!("expected a run");
        };
        assert_eq!(
            invocation.files,
            vec![
                (dir.join("a.pdf"), Target::default()),
                (dir.join("b.md"), Target::default()),
            ]
        );
        assert_eq!(invocation.launch.mode.as_deref(), Some("night"));
        assert!(invocation.wait);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_page_can_be_asked_for_by_flag_or_by_fragment() {
        let dir = std::env::temp_dir().join(format!("pdf-next-aim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.pdf"), b"%PDF-1.7\n%%EOF\n").unwrap();
        std::fs::write(dir.join("b.pdf"), b"%PDF-1.7\n%%EOF\n").unwrap();
        // A name that really contains a `#` keeps all of it.
        std::fs::write(dir.join("odd#name.pdf"), b"%PDF-1.7\n%%EOF\n").unwrap();

        let aim = |words: &[&str]| {
            let parsed = parse_cli(words.iter().map(OsString::from), Some(&dir));
            let Ok(Cli::Run(invocation)) = parsed else {
                panic!("expected a run");
            };
            invocation
        };

        // A flag speaks about the file before it, and about the next one when
        // it comes first.
        let before = aim(&["a.pdf", "--page", "12", "b.pdf", "--find", "wake"]);
        assert_eq!(before.files[0].1.page, Some(12));
        assert_eq!(before.files[1].1.search.as_deref(), Some("wake"));
        assert_eq!(before.files[0].1.search, None);
        let after = aim(&["--page", "3", "a.pdf"]);
        assert_eq!(after.files[0].1.page, Some(3));

        // The fragment is the RFC 8118 one, spaces and all, and it wins over a
        // flag aimed at the same file.
        let linked = aim(&["--page", "3", "a.pdf#page=7&search=Figure%203&zoom=150"]);
        let target = &linked.files[0].1;
        assert_eq!(target.page, Some(7));
        assert_eq!(target.search.as_deref(), Some("Figure 3"));
        assert_eq!(target.fragment(), "page=7&search=Figure%203");
        assert_eq!(linked.files[0].0, dir.join("a.pdf"));

        let odd = aim(&["odd#name.pdf"]);
        assert_eq!(odd.files[0].0, dir.join("odd#name.pdf"));
        assert_eq!(odd.files[0].1, Target::default());

        assert!(!aim(&["a.pdf"]).no_focus);
        assert!(aim(&["a.pdf", "--no-focus"]).no_focus);
        assert_eq!(cli(&["--page", "0"]).err().map(|e| e.0), Some(2));
        assert_eq!(cli(&["--find"]).err().map(|e| e.0), Some(2));

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
    fn links_are_kept_for_the_frontend_to_route() {
        let html = render_markdown(
            "[here](other.md) [site](https://example.com/x) [run](javascript:alert(1)) note[^1]\n\n[^1]: the note",
        );
        // Relative and web links survive as written; the click handler decides.
        assert!(html.contains("href=\"other.md\""), "{html}");
        assert!(html.contains("href=\"https://example.com/x\""));
        assert!(!html.contains("javascript:"), "{html}");
        // Footnotes keep working: the reference points at the prefixed id.
        assert!(html.contains("href=\"#md-1\""), "{html}");
        assert!(html.contains("id=\"md-1\""), "{html}");
        assert!(!html.contains("id=\"1\""));
        assert!(html.contains("class=\"footnote-definition\""), "{html}");
    }

    #[test]
    fn equations_become_mathml() {
        let html = render_markdown("mass $E = mc^2$ and\n\n$$\\int_0^1 x\\,dx$$\n");
        assert!(html.contains("<math"), "{html}");
        assert!(html.contains("display=\"block\""), "{html}");
        assert!(html.contains("<msup>"), "{html}");
        assert!(!html.contains("<annotation"), "{html}");
        // A colour the renderer wrote survives the style filter.
        let colour = render_markdown("$\\color{red}{x}$");
        assert!(colour.contains("style=\"color: rgb("), "{colour}");
    }

    #[test]
    fn equations_cannot_smuggle_markup() {
        let html = render_markdown("$\\text{<b onclick=x>hi</b>}$ and $x < 1$");
        // The tag is text, not an element.
        assert!(!html.contains("<b"), "{html}");
        assert!(
            html.contains("<mtext>&lt;b onclick=x&gt;hi&lt;/b&gt;</mtext>"),
            "{html}"
        );
        // A bare `<` in an operator is re-serialized escaped.
        assert!(html.contains("<mo>&lt;</mo>"), "{html}");
        // MathML written straight into the document meets the same allowlist:
        // the elements stay, a style the renderer would never write does not.
        let raw = render_markdown("<math><mi style=\"background: url(x)\">x</mi></math>");
        assert!(raw.contains("<math><mi>x</mi></math>"), "{raw}");
    }

    #[test]
    fn matrices_and_spaces_survive_the_sanitizer() {
        let html = render_markdown(
            "$$\\begin{pmatrix} A & B \\\\ C & D \\end{pmatrix}$$\n\nand $\\text{a b } x$\n",
        );
        assert!(html.contains("<mtable"), "{html}");
        assert!(html.contains("<mtr><mtd>"), "{html}");
        // The renderer's `&nbsp;` is one character by the time it is served,
        // not five that would show as text.
        assert!(!html.contains("&amp;nbsp;"), "{html}");
        assert!(
            html.contains("<mtext>a b\u{a0}</mtext>") || html.contains("<mtext>a b&nbsp;</mtext>"),
            "{html}"
        );
    }

    #[test]
    fn table_columns_keep_their_alignment() {
        let html = render_markdown("| a | b |\n|:--|--:|\n| 1 | 2 |\n");
        assert!(html.contains("style=\"text-align: right\""), "{html}");
        let html = render_markdown("<p style=\"color: red\">x</p>");
        assert!(!html.contains("style="), "{html}");
    }

    #[test]
    fn windows_paths_are_shown_the_way_people_type_them() {
        use super::display_path;
        use std::path::Path;
        assert_eq!(display_path(Path::new(r"\\?\C:\a\b.pdf")), r"C:\a\b.pdf");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\b.pdf")),
            r"\\server\share\b.pdf"
        );
        assert_eq!(display_path(Path::new("/home/x/b.pdf")), "/home/x/b.pdf");
    }

    #[test]
    fn folders_sort_the_way_people_read_them() {
        let mut names = vec!["fig10", "fig2", "fig1", "Fig02"];
        names.sort_by_key(|name| natural_key(name));
        assert_eq!(names, vec!["fig1", "fig2", "Fig02", "fig10"]);
        let long = "1234567890123456789012345";
        assert!(natural_key(long) > natural_key("999"));
        assert!(natural_key(long) < natural_key("1234567890123456789012346"));
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

    #[test]
    fn only_web_links_leave_for_the_browser() {
        // Same as above: no success path, it would open a browser.
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ms-msdt:/id x",
            "https://example.com/a b",
            "http://example.com/\u{7}",
            "other.md",
        ] {
            assert!(open_link(url.into()).is_err(), "{url} must be refused");
        }
    }
}
