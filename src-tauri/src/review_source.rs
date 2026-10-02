use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

pub(crate) fn hint(document: &Path, position: &Value) -> Result<Option<Value>, String> {
    let query = query_position(position)?;
    let Some(directory) = document.parent() else {
        return Ok(None);
    };
    let sidecars = [
        document.with_extension("synctex"),
        document.with_extension("synctex.gz"),
    ];
    let available: Vec<_> = sidecars.iter().filter(|path| path.is_file()).collect();
    // Two maps can make SyncTeX choose an obsolete build.
    if available.len() != 1 {
        return Ok(None);
    }
    let modified = |path: &Path| std::fs::metadata(path).ok()?.modified().ok();
    if !modified(document)
        .zip(modified(available[0]))
        .is_some_and(|(pdf, map)| matching_build_times(pdf, map))
    {
        return Ok(None);
    }
    let Some(search_path) = std::env::var_os("PATH") else {
        return Ok(None);
    };
    let Some(program) = find_synctex(std::env::split_paths(&search_path), directory) else {
        return Ok(None);
    };
    let Some(filename) = document.file_name().and_then(|name| name.to_str()) else {
        return Ok(None);
    };
    let Some(before) = fingerprint(document) else {
        return Ok(None);
    };
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW keeps the console tool inside the review workflow.
        command.creation_flags(0x0800_0000);
    }
    let mut child = match command
        .args(["edit", "-o", &format!("{query}:{filename}"), "-x", ""])
        .env_remove("SYNCTEX_EDITOR")
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return Ok(None),
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(None);
    };
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(65_537).read_to_end(&mut bytes).ok()?;
        (bytes.len() <= 65_536).then_some(bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let bytes = reader.join().ok().flatten();
    if !success || fingerprint(document).as_ref() != Some(&before) {
        return Ok(None);
    }
    let Some(output) = bytes.and_then(|bytes| String::from_utf8(bytes).ok()) else {
        return Ok(None);
    };
    let Some(mut candidate) = source_candidate(&output, directory) else {
        return Ok(None);
    };
    candidate["documentRevision"] = Value::String(before);
    Ok(Some(candidate))
}

fn matching_build_times(pdf: SystemTime, map: SystemTime) -> bool {
    pdf.duration_since(map)
        .or_else(|_| map.duration_since(pdf))
        .is_ok_and(|age| age <= Duration::from_secs(2))
}

fn find_synctex(paths: impl IntoIterator<Item = PathBuf>, directory: &Path) -> Option<PathBuf> {
    let directory = directory.canonicalize().ok()?;
    let name = if cfg!(windows) {
        "synctex.exe"
    } else {
        "synctex"
    };
    for path in paths {
        if !path.is_absolute() {
            continue;
        }
        let Ok(program) = path.join(name).canonicalize() else {
            continue;
        };
        if program.starts_with(&directory) || !program.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&program).ok()?.permissions().mode() & 0o111 == 0 {
                continue;
            }
        }
        return Some(program);
    }
    None
}

fn fingerprint(path: &Path) -> Option<String> {
    crate::document_sha256(path).ok()
}

fn source_candidate(output: &str, directory: &Path) -> Option<Value> {
    let directory = directory.canonicalize().ok()?;
    let mut input = None;
    let mut candidates = BTreeSet::new();
    for line in output.lines() {
        if let Some(path) = line.strip_prefix("Input:") {
            input = Some(path.trim());
        }
        if let Some(line) = line.strip_prefix("Line:") {
            let number: u64 = line.trim().parse().ok()?;
            let path = directory.join(input.take()?).canonicalize().ok()?;
            if number == 0
                || !path.is_file()
                || path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_none_or(|ext| !ext.eq_ignore_ascii_case("tex"))
            {
                return None;
            }
            let relative = path
                .strip_prefix(&directory)
                .ok()?
                .to_str()?
                .replace('\\', "/");
            candidates.insert((relative, number));
        }
    }
    if candidates.len() != 1 {
        return None;
    }
    let (file, line) = candidates.into_iter().next()?;
    Some(json!({"file": file, "line": line, "method": "synctex", "verified": false}))
}

fn query_position(position: &Value) -> Result<String, String> {
    let invalid = || "invalid PDF position".to_string();
    let page = position["page"]
        .as_u64()
        .filter(|page| *page > 0 && *page <= 1_000_000)
        .ok_or_else(invalid)?;
    let coordinate = |name: &str| {
        position[name]
            .as_f64()
            .filter(|value| value.is_finite() && (0.0..=1_000_000.0).contains(value))
            .ok_or_else(invalid)
    };
    Ok(format!("{page}:{}:{}", coordinate("x")?, coordinate("y")?))
}

#[cfg(test)]
mod tests {
    use super::{query_position, source_candidate};
    use serde_json::json;

    #[test]
    fn mapping_requires_matching_build_times_in_both_directions() {
        let now = std::time::SystemTime::now();
        let near = now + std::time::Duration::from_secs(1);
        let stale = now + std::time::Duration::from_secs(3);
        assert!(super::matching_build_times(now, near));
        assert!(super::matching_build_times(near, now));
        assert!(!super::matching_build_times(now, stale));
        assert!(!super::matching_build_times(stale, now));
    }

    #[test]
    fn executable_resolution_rejects_relative_and_project_paths() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let trusted = directory.path().join("tex-bin");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&trusted).unwrap();
        let name = if cfg!(windows) {
            "synctex.exe"
        } else {
            "synctex"
        };
        for folder in [&project, &trusted] {
            let file = folder.join(name);
            std::fs::write(&file, b"not executed").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        assert!(
            super::find_synctex([std::path::PathBuf::from("."), project.clone()], &project)
                .is_none()
        );
        assert_eq!(
            super::find_synctex([project.clone(), trusted.clone()], &project),
            Some(trusted.join(name).canonicalize().unwrap())
        );
    }

    #[test]
    fn real_synctex_maps_an_included_equation_when_tex_tools_are_available() {
        if std::process::Command::new("pdflatex")
            .arg("--version")
            .output()
            .is_err()
            || std::process::Command::new("synctex")
                .arg("--version")
                .output()
                .is_err()
        {
            eprintln!("TeX tools unavailable; native source mapping test skipped");
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("chapters")).unwrap();
        std::fs::write(
            directory.path().join("paper.tex"),
            r"\documentclass{article}
\begin{document}
\input{chapters/methods}
\end{document}",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("chapters/methods.tex"),
            r"Equation context for source mapping.
\begin{equation}
E = mc^2
\end{equation}",
        )
        .unwrap();
        let compiled = std::process::Command::new("pdflatex")
            .args([
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-synctex=1",
                "paper.tex",
            ])
            .current_dir(directory.path())
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stdout)
        );
        let pdf = directory.path().join("paper.pdf");
        let candidate = super::hint(&pdf, &json!({"page":1,"x":150,"y":140}))
            .unwrap()
            .unwrap();
        assert_eq!(candidate["file"], "chapters/methods.tex");
        assert_eq!(candidate["method"], "synctex");
        assert!(candidate["line"].as_u64().unwrap() > 0);
        assert!(candidate["documentRevision"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        let allowed = std::collections::HashSet::from([pdf.clone()]);
        let review: crate::Review = serde_json::from_value(json!({
            "file":"paper.pdf", "kind":"pdf", "at":{"page":1},
            "quote":"Equation context for source mapping.", "action":"delete",
            "anchor":{"position":{"page":1,"x":150,"y":140}}
        }))
        .unwrap();
        let store = crate::write_review(pdf.to_str().unwrap(), review, &allowed).unwrap();
        let id = store.reviews[0].id.clone();
        let before = crate::document_sha256(&pdf).unwrap();
        std::fs::write(
            directory.path().join("chapters/methods.tex"),
            r"\begin{equation}
E = mc^2
\end{equation}",
        )
        .unwrap();
        let compile = || {
            std::process::Command::new("pdflatex")
                .args([
                    "-interaction=nonstopmode",
                    "-halt-on-error",
                    "-synctex=1",
                    "paper.tex",
                ])
                .current_dir(directory.path())
                .output()
                .unwrap()
        };
        assert!(compile().status.success());
        let after = crate::document_sha256(&pdf).unwrap();
        assert_ne!(before, after);
        let applied = crate::patch_review_record(
            pdf.to_str().unwrap(),
            &id,
            &json!({"status":"applied", "resolution":"Removed selected sentence and rebuilt.",
                "source":{"file":"chapters/methods.tex"},
                "build":{"success":true,"documentRevision":after}}),
            &json!({"$revision":store.revision}),
            &allowed,
            false,
        )
        .unwrap();
        assert_eq!(applied.reviews[0].id, id);
        assert_eq!(
            applied.reviews[0].quote,
            "Equation context for source mapping."
        );
        assert_eq!(applied.reviews[0].action, "delete");
        std::fs::remove_file(pdf.with_extension("synctex.gz")).unwrap();
        assert!(super::hint(&pdf, &json!({"page":1,"x":150,"y":140}))
            .unwrap()
            .is_none());
        std::fs::write(
            directory.path().join("chapters/methods.tex"),
            r"\undefinedcommand",
        )
        .unwrap();
        assert!(!compile().status.success());
        assert!(crate::patch_review_record(
            pdf.to_str().unwrap(),
            &id,
            &json!({"status":"applied", "build":{"success":false}}),
            &json!({"$revision":applied.revision}),
            &allowed,
            false
        )
        .is_err());
        let unchanged = crate::list_reviews(pdf.to_str().unwrap(), &allowed).unwrap();
        assert_eq!(unchanged.revision, applied.revision);
        assert_eq!(unchanged.reviews[0].quote, applied.reviews[0].quote);
    }

    #[test]
    fn position_uses_pdf_points_and_requires_finite_nonnegative_values() {
        assert_eq!(
            query_position(&json!({"page": 4, "x": 72.5, "y": 144.0})).unwrap(),
            "4:72.5:144"
        );
        for position in [
            json!({"page": 0, "x": 1, "y": 2}),
            json!({"page": 1, "x": -1, "y": 2}),
            json!({"page": 1, "x": "NaN", "y": 2}),
            json!({"page": 1, "x": 1, "y": 2_000_000}),
        ] {
            assert!(query_position(&position).is_err());
        }
    }

    #[test]
    fn mapping_accepts_existing_included_tex_source() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("chapters")).unwrap();
        std::fs::write(directory.path().join("chapters/methods.tex"), "Text").unwrap();
        let candidate = source_candidate(
            "SyncTeX result begin\nInput:chapters/methods.tex\nLine:143\nColumn:-1\nSyncTeX result end\n",
            directory.path(),
        )
        .unwrap();
        assert_eq!(candidate["file"], "chapters/methods.tex");
        assert_eq!(candidate["line"], 143);
        assert_eq!(candidate["verified"], false);
    }

    #[test]
    fn mapping_rejects_ambiguous_or_outside_sources() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("a.tex"), "Text").unwrap();
        std::fs::write(directory.path().join("b.tex"), "Text").unwrap();
        assert!(source_candidate(
            "Input:a.tex\nLine:3\nInput:b.tex\nLine:9\n",
            directory.path()
        )
        .is_none());
        let outside = tempfile::tempdir().unwrap();
        let path = outside.path().join("outside.tex");
        std::fs::write(&path, "Text").unwrap();
        assert!(source_candidate(
            &format!("Input:{}\nLine:1\n", path.display()),
            directory.path()
        )
        .is_none());
    }

    #[test]
    fn mapping_deduplicates_identical_candidates() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("a.tex"), "Text").unwrap();
        let candidate = source_candidate(
            "Input:a.tex\nLine:3\nInput:a.tex\nLine:3\n",
            directory.path(),
        )
        .unwrap();
        assert_eq!(candidate["line"], 3);
    }
}
