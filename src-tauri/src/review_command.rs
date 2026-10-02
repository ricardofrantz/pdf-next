//! Headless review commands. This module is called before the viewer CLI
//! parser so review automation never creates a window.

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const HELP: &str = "Usage:\n  pdf-next reviews list <PDF>\n  pdf-next reviews update <PDF> --id rN --patch <JSONfile|-> --expected-revision N [--dry-run]\n\nCommands:\n  list       Print the document's review store as JSON.\n  update     Compare-and-patch one review using the sidecar revision.\n\nOptions:\n  --id ID                    Stable review ID, for example r12.\n  --patch FILE               JSON object of allowed review fields; - reads stdin.\n  --expected-revision N      Required sidecar revision read with the patch.\n  --dry-run                  Validate and print the proposed store without writing.\n  -h, --help                 Show this help.\n\nExamples:\n  pdf-next reviews list paper.pdf\n  pdf-next reviews update paper.pdf --id r12 --patch patch.json --expected-revision 8\n  cat patch.json | pdf-next reviews update paper.pdf --id r12 --patch - --expected-revision 8 --dry-run\n\nAgent workflow: inspect the PDF quote and context, locate the corresponding source in the\nLaTeX entry point or included files, edit the source, then compile it. Record source/build\nresults against the same review ID. Mark a PDF task applied only after a successful build;\nRicardo must verify the rendered PDF before it is resolved. Treat source hints as candidates.\nEquation symbols need surrounding context and position; do not copy symbols blindly.";
const MAX_PATCH_BYTES: usize = 16_000;

/// Handle `reviews` arguments. `None` leaves normal viewer arguments to the
/// existing CLI parser; `Some` is the process exit status for this command.
pub(crate) fn maybe_run<I>(arguments: I) -> Option<i32>
where
    I: IntoIterator<Item = OsString>,
{
    let args: Vec<OsString> = arguments.into_iter().collect();
    if args.first().is_none_or(|arg| arg != "reviews") {
        return None;
    }
    Some(match run(&args[1..]) {
        Ok(output) => {
            println!("{output}");
            0
        }
        Err(CliError::Usage(message)) => {
            eprintln!("pdf-next: {message}\n\n{HELP}");
            2
        }
        Err(CliError::Runtime(message)) => {
            eprintln!("pdf-next: {message}");
            1
        }
    })
}

#[derive(Debug)]
enum CliError {
    Usage(String),
    Runtime(String),
}

fn usage(message: impl Into<String>) -> CliError {
    CliError::Usage(message.into())
}

fn runtime(message: impl Into<String>) -> CliError {
    CliError::Runtime(message.into())
}

fn run(args: &[OsString]) -> Result<String, CliError> {
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(HELP.to_string());
    }
    let command = args[0]
        .to_str()
        .ok_or_else(|| usage("command name must be UTF-8"))?;
    match command {
        "list" => run_list(&args[1..]),
        "update" => run_update(&args[1..]),
        other => Err(usage(format!("unknown reviews command `{other}`"))),
    }
}

fn document_path(arg: &OsString) -> Result<(String, HashSet<PathBuf>), CliError> {
    let canonical = fs::canonicalize(Path::new(arg)).map_err(|error| runtime(error.to_string()))?;
    let metadata = fs::metadata(&canonical).map_err(|error| runtime(error.to_string()))?;
    if !metadata.is_file() {
        return Err(runtime("document is not a regular file"));
    }
    if canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("pdf"))
    {
        return Err(runtime("reviews commands currently require a PDF"));
    }
    let document = canonical
        .to_str()
        .ok_or_else(|| runtime("document path must be UTF-8"))?
        .to_string();
    let allowed = HashSet::from([canonical]);
    Ok((document, allowed))
}

fn run_list(args: &[OsString]) -> Result<String, CliError> {
    if args.len() != 1 {
        return Err(usage("reviews list needs exactly one PDF path"));
    }
    let (document, allowed) = document_path(&args[0])?;
    let store = crate::list_reviews(&document, &allowed).map_err(runtime)?;
    serde_json::to_string_pretty(&store).map_err(|error| runtime(error.to_string()))
}

fn run_update(args: &[OsString]) -> Result<String, CliError> {
    if args.is_empty() {
        return Err(usage("reviews update needs a PDF path"));
    }
    let (document, allowed) = document_path(&args[0])?;
    let mut id = None;
    let mut patch_path = None;
    let mut expected_revision = None;
    let mut dry_run = false;
    let mut rest = args[1..].iter();
    while let Some(option) = rest.next() {
        let name = option
            .to_str()
            .ok_or_else(|| usage("option name must be UTF-8"))?;
        match name {
            "--id" if id.is_none() => {
                id = Some(rest.next().ok_or_else(|| usage("--id needs a value"))?);
            }
            "--patch" if patch_path.is_none() => {
                patch_path = Some(rest.next().ok_or_else(|| usage("--patch needs a value"))?);
            }
            "--expected-revision" if expected_revision.is_none() => {
                let value = rest
                    .next()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| usage("--expected-revision needs a non-negative integer"))?;
                expected_revision = Some(
                    value
                        .parse::<u64>()
                        .map_err(|_| usage("--expected-revision needs a non-negative integer"))?,
                );
            }
            "--dry-run" if !dry_run => dry_run = true,
            "--help" | "-h" => return Ok(HELP.to_string()),
            _ => return Err(usage(format!("unknown or repeated option `{name}`"))),
        }
    }
    let id = id
        .and_then(|value| value.to_str())
        .ok_or_else(|| usage("--id is required and must be UTF-8"))?;
    if !valid_id(id) {
        return Err(usage("--id must be an ID such as r12"));
    }
    let patch_path = patch_path.ok_or_else(|| usage("--patch is required"))?;
    let revision = expected_revision.ok_or_else(|| usage("--expected-revision is required"))?;
    let patch_text = read_patch(patch_path)?;
    let patch: Value = serde_json::from_str(&patch_text)
        .map_err(|error| usage(format!("invalid patch JSON: {error}")))?;
    if !patch.is_object() || patch.as_object().is_some_and(|object| object.is_empty()) {
        return Err(usage("patch must be a non-empty JSON object"));
    }
    let expected = json!({"$revision": revision});
    let store = crate::patch_review_record(&document, id, &patch, &expected, &allowed, dry_run)
        .map_err(runtime)?;
    serde_json::to_string_pretty(&store).map_err(|error| runtime(error.to_string()))
}

fn read_patch(path: &OsString) -> Result<String, CliError> {
    if path == "-" {
        return read_bounded(io::stdin().lock());
    }
    let file = fs::File::open(PathBuf::from(path)).map_err(|error| runtime(error.to_string()))?;
    read_bounded(file)
}

fn read_bounded(input: impl Read) -> Result<String, CliError> {
    let mut bytes = Vec::with_capacity(MAX_PATCH_BYTES);
    input
        .take((MAX_PATCH_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| runtime(error.to_string()))?;
    if bytes.len() > MAX_PATCH_BYTES {
        return Err(usage(format!("patch JSON exceeds {MAX_PATCH_BYTES} bytes")));
    }
    String::from_utf8(bytes).map_err(|error| usage(error.to_string()))
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix('r').is_some_and(|number| {
        !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use super::{maybe_run, run, run_list, run_update, CliError, MAX_PATCH_BYTES};
    use std::ffi::OsString;
    use std::fs;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn help_is_consumed_before_viewer_argument_parsing() {
        assert_eq!(maybe_run(arguments(&["reviews", "--help"])), Some(0));
        assert_eq!(maybe_run(arguments(&["paper.pdf"])), None);
    }

    #[test]
    fn unsupported_commands_and_incomplete_updates_are_usage_errors() {
        assert!(matches!(
            run(&arguments(&["delete"])),
            Err(CliError::Usage(_))
        ));
        assert!(matches!(
            run(&arguments(&["update"])),
            Err(CliError::Usage(_))
        ));
    }

    #[test]
    fn list_and_update_use_the_sidecar_revision_cas() {
        let directory = tempfile::tempdir().unwrap();
        let pdf = directory.path().join("paper.pdf");
        let sidecar = directory.path().join("paper_review.json");
        let patch = directory.path().join("patch.json");
        fs::write(&pdf, b"%PDF-1.7\n").unwrap();
        fs::write(
            &sidecar,
            r#"{"format":3,"revision":8,"nextId":2,"document":{"pdf":"paper.pdf","project":"."},"reviews":[{"id":"r1","file":"paper.pdf","kind":"pdf","at":{"page":1},"quote":"selected text","comment":"","action":"improve","status":"open","resolution":"","color":1}]}"#,
        )
        .unwrap();
        let document = pdf.to_str().unwrap();
        let listed: serde_json::Value =
            serde_json::from_str(&run_list(&arguments(&[document])).unwrap()).unwrap();
        assert_eq!(listed["revision"], 8);
        assert_eq!(listed["reviews"][0]["id"], "r1");

        fs::write(&patch, r#"{"color":3}"#).unwrap();
        let updated: serde_json::Value = serde_json::from_str(
            &run_update(&arguments(&[
                document,
                "--id",
                "r1",
                "--patch",
                patch.to_str().unwrap(),
                "--expected-revision",
                "8",
            ]))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(updated["revision"], 9);
        assert_eq!(updated["reviews"][0]["color"], 3);

        fs::write(&patch, r#"{"color":4}"#).unwrap();
        let dry_run: serde_json::Value = serde_json::from_str(
            &run_update(&arguments(&[
                document,
                "--id",
                "r1",
                "--patch",
                patch.to_str().unwrap(),
                "--expected-revision",
                "9",
                "--dry-run",
            ]))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(dry_run["revision"], 9);
        assert_eq!(dry_run["reviews"][0]["color"], 4);

        let stale = run_update(&arguments(&[
            document,
            "--id",
            "r1",
            "--patch",
            patch.to_str().unwrap(),
            "--expected-revision",
            "8",
        ]));
        assert!(matches!(stale, Err(CliError::Runtime(message)) if message.contains("conflict")));
        fs::write(&patch, vec![b' '; MAX_PATCH_BYTES + 1]).unwrap();
        let oversized = run_update(&arguments(&[
            document,
            "--id",
            "r1",
            "--patch",
            patch.to_str().unwrap(),
            "--expected-revision",
            "9",
        ]));
        assert!(
            matches!(oversized, Err(CliError::Usage(message)) if message.contains("16000 bytes"))
        );
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(sidecar).unwrap()).unwrap();
        assert_eq!(persisted["revision"], 9);
        assert_eq!(persisted["reviews"][0]["color"], 3);
    }
}
