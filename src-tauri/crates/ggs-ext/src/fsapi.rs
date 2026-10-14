//! The extension filesystem (`vscode.workspace.fs`) over one core call: every op
//! confines its path to the workspace folders first, so an extension can never reach
//! outside them. Also the pages' byte services (`backend.run`'s `__`-prefixed commands):
//! a page's own hex and picture machinery reads revision sides and working-tree windows
//! through these — the app's own git and file reads, confined exactly like `ext_fs`.

use std::path::{Path, PathBuf};

use serde::Serialize;

use ggs_git::revision::revision_file_bytes;
use ggs_git::runner::Git;

/// One workspace entry as `ext_fs`'s `list` answers it: name, kind and size, the shape the
/// frontend's `workspace.fs.readDirectory` consumes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtFsEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: u8, // 1 file, 2 directory, 64 symlink — VS Code's FileType bits
    pub size: u64,
}

/// Resolve `path` (absolute, or relative to one of `roots`) and confine it to `roots`: an
/// extension's `workspace.fs` may only touch the open folders (VS Code's own limit).
pub fn confine_to_roots(roots: &[String], path: &str) -> Result<PathBuf, String> {
    if roots.is_empty() {
        return Err("no workspace folder is open".to_string());
    }
    let candidate = Path::new(path);
    let resolved = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        Path::new(&roots[0]).join(candidate)
    };
    let canonical = std::fs::canonicalize(&resolved).or_else(|_| {
        // A not-yet-existing target (a write, a mkdir): walk up to the nearest existing
        // ancestor, canonicalize that, and re-join the missing tail — confinement holds for
        // paths being created however many of their directories are still missing.
        let mut ancestor = resolved
            .parent()
            .ok_or_else(|| format!("{} has no parent", resolved.display()))?
            .to_path_buf();
        let mut tail = std::ffi::OsString::from(
            resolved
                .file_name()
                .ok_or_else(|| format!("{} has no file name", resolved.display()))?,
        );
        loop {
            match std::fs::canonicalize(&ancestor) {
                Ok(canonical) => return Ok::<PathBuf, String>(canonical.join(&tail)),
                Err(_) => {
                    let name = ancestor
                        .file_name()
                        .ok_or_else(|| format!("cannot resolve {}", resolved.display()))?;
                    let Some(parent) = ancestor.parent() else {
                        return Err(format!("cannot resolve {}", resolved.display()));
                    };
                    let mut next = std::ffi::OsString::from(name);
                    next.push(std::path::MAIN_SEPARATOR.to_string());
                    next.push(&tail);
                    tail = next;
                    ancestor = parent.to_path_buf();
                }
            }
        }
    })?;
    for root in roots {
        let Ok(root_canonical) = std::fs::canonicalize(root) else {
            continue;
        };
        if canonical.starts_with(&root_canonical) {
            return Ok(canonical);
        }
    }
    Err(format!(
        "{} is outside the workspace folders — vscode.workspace.fs is confined to them",
        canonical.display()
    ))
}

/// A tiny glob matcher (`find` / `findFiles`): `**` crosses directory boundaries, `*` within
/// one segment, `?` one character. Classic backtracking, no regex dependency.
fn glob_match(pattern: &str, text: &str) -> bool {
    fn segment(seg: &[char], s: &[char]) -> bool {
        let (mut pi, mut si) = (0usize, 0usize);
        let mut star: Option<(usize, usize)> = None;
        while si < s.len() {
            if pi < seg.len() && (seg[pi] == '?' || seg[pi] == s[si]) {
                pi += 1;
                si += 1;
            } else if pi < seg.len() && seg[pi] == '*' {
                star = Some((pi, si));
                pi += 1;
            } else if let Some((sp, ss)) = star {
                pi = sp + 1;
                si = ss + 1;
                star = Some((sp, ss + 1));
            } else {
                return false;
            }
        }
        while pi < seg.len() && seg[pi] == '*' {
            pi += 1;
        }
        pi == seg.len()
    }
    fn walk(pat: &[&str], parts: &[&str]) -> bool {
        match pat.first() {
            None => parts.is_empty(),
            Some(&"**") => (0..=parts.len()).any(|skip| walk(&pat[1..], &parts[skip..])),
            Some(seg) => {
                if parts.is_empty() {
                    return false;
                }
                let seg: Vec<char> = seg.chars().collect();
                let head: Vec<char> = parts[0].chars().collect();
                segment(&seg, &head) && walk(&pat[1..], &parts[1..])
            }
        }
    }
    walk(
        &pattern.split('/').collect::<Vec<_>>(),
        &text.split('/').collect::<Vec<_>>(),
    )
}

/// Collect the files under `dir` whose workspace-relative path matches `pattern` (bounded in
/// depth and count — a `**` over a big tree must not walk forever).
fn walk_find(dir: &Path, prefix: &str, pattern: &str, found: &mut Vec<String>, depth: usize) {
    if depth > 12 || found.len() >= 2000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk_find(&entry.path(), &relative, pattern, found, depth + 1);
        } else if glob_match(pattern, &relative) {
            found.push(relative);
        }
    }
}

/// The core the `ext_fs` command delegates to (and the tests call with plain paths): byte
/// answers pass through `encode` so the command layer can base64 them for the JSON bridge.
pub fn ext_fs_core(
    op: &str,
    roots: &[String],
    path: &str,
    to: Option<&str>,
    data: Option<&str>,
    encode: impl Fn(&[u8]) -> String,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    // `find` takes a glob, not a path — it cannot be confined the way a file target is; its
    // walk starts at the canonical roots and never leaves them.
    if op == "find" {
        let mut found = Vec::new();
        for root in roots {
            let Ok(root_canonical) = std::fs::canonicalize(root) else {
                continue;
            };
            walk_find(&root_canonical, "", path, &mut found, 0);
        }
        return Ok(serde_json::to_value(found).expect("paths serialize"));
    }
    let target = confine_to_roots(roots, path)?;
    match op {
        "exists" => Ok(serde_json::json!(if target.exists() {
            vec![path.to_owned()]
        } else {
            Vec::<String>::new()
        })),
        "read" => {
            let bytes =
                std::fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
            Ok(serde_json::json!({ "data": encode(&bytes) }))
        }
        "write" => {
            let bytes = data
                .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
                .ok_or_else(|| "write needs base64 data".to_owned())?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&target, bytes)
                .map_err(|e| format!("write {}: {e}", target.display()))?;
            Ok(serde_json::json!(()))
        }
        "list" => {
            let mut entries = Vec::new();
            for entry in
                std::fs::read_dir(&target).map_err(|e| format!("read {}: {e}", target.display()))?
            {
                let entry = entry.map_err(|e| e.to_string())?;
                let meta = entry.metadata().map_err(|e| e.to_string())?;
                let kind = if meta.is_dir() {
                    2
                } else if entry.path().is_symlink() {
                    64
                } else {
                    1
                };
                entries.push(ExtFsEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    kind,
                    size: meta.len(),
                });
            }
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(serde_json::to_value(entries).expect("entries serialize"))
        }
        "stat" => {
            let meta = std::fs::metadata(&target)
                .map_err(|e| format!("stat {}: {e}", target.display()))?;
            Ok(serde_json::json!({
                "type": if meta.is_dir() { 2 } else { 1 },
                "size": meta.len(),
                "mtime": meta
                    .modified()
                    .ok()
                    .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            }))
        }
        "mkdir" => {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("mkdir {}: {e}", target.display()))?;
            Ok(serde_json::json!(()))
        }
        // The executable bit extensions set on git hooks and helper scripts they ship —
        // a no-op on Windows, where the mode does not exist.
        "chmod" => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = to
                    .and_then(|mode| u32::from_str_radix(mode, 8).ok())
                    .unwrap_or(0o755);
                let mut permissions = std::fs::metadata(&target)
                    .map_err(|e| format!("chmod {}: {e}", target.display()))?
                    .permissions();
                permissions.set_mode(mode);
                std::fs::set_permissions(&target, permissions)
                    .map_err(|e| format!("chmod {}: {e}", target.display()))?;
            }
            Ok(serde_json::json!(()))
        }
        "delete" => {
            if target.is_dir() {
                std::fs::remove_dir_all(&target)
                    .map_err(|e| format!("delete {}: {e}", target.display()))?;
            } else {
                std::fs::remove_file(&target)
                    .map_err(|e| format!("delete {}: {e}", target.display()))?;
            }
            Ok(serde_json::json!(()))
        }
        "rename" => {
            let to = to.ok_or_else(|| "rename needs a destination".to_owned())?;
            let destination = confine_to_roots(roots, to)?;
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&target, &destination).map_err(|e| format!("rename: {e}"))?;
            Ok(serde_json::json!(()))
        }
        _ => Err(format!("unknown ext_fs op {op}")),
    }
}

// ---------------------------------------------------------------------------
// The pages' byte services (`backend.run`'s `__`-prefixed commands)
// ---------------------------------------------------------------------------

/// One byte service's answer. A soft `error` keeps a missing side data rather than a
/// rejection — the hex view renders the empty side itself; `size` carries the whole file's
/// length where the read is windowed (the streaming consumers stop at it).
#[derive(Serialize)]
pub struct ExtPageBytes {
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// The repo a page names must sit inside the open folders (empty names the first one), and
/// the file path resolves under that repo. Answers the canonical repo root and the confined
/// file target.
fn confine_page_path(
    roots: &[String],
    repo: &str,
    path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = confine_to_roots(roots, repo)?;
    let target = confine_to_roots(&[root.to_string_lossy().into_owned()], path)?;
    Ok((root, target))
}

/// A file's bytes from `offset`, at most `len` (negative: to the end), with the whole size.
fn read_file_window(target: &Path, offset: u64, len: i64) -> Result<(Vec<u8>, u64), String> {
    use std::io::{Read, Seek};
    let mut file = std::fs::File::open(target).map_err(|e| format!("{}: {e}", target.display()))?;
    let size = file
        .metadata()
        .map_err(|e| format!("{}: {e}", target.display()))?
        .len();
    let start = offset.min(size);
    file.seek(std::io::SeekFrom::Start(start))
        .map_err(|e| format!("{}: {e}", target.display()))?;
    let want = if len < 0 {
        size - start
    } else {
        (len as u64).min(size - start)
    };
    let mut bytes = vec![0u8; want as usize];
    let mut read = 0usize;
    while read < bytes.len() {
        let n = file
            .read(&mut bytes[read..])
            .map_err(|e| format!("{}: {e}", target.display()))?;
        if n == 0 {
            bytes.truncate(read);
            break;
        }
        read += n;
    }
    Ok((bytes, size))
}

/// The core `ext_page_revision_bytes` delegates to (and the tests call directly).
pub fn ext_page_revision_bytes_core(
    roots: &[String],
    repo: &str,
    revision: &str,
    path: &str,
    encode: impl Fn(&[u8]) -> String,
) -> Result<ExtPageBytes, String> {
    let (root, target) = confine_page_path(roots, repo, path)?;
    if revision == "*" {
        let (bytes, size) = read_file_window(&target, 0, -1)?;
        return Ok(ExtPageBytes {
            error: None,
            bytes: Some(encode(&bytes)),
            base64: None,
            size: Some(size),
        });
    }
    let relative = target
        .strip_prefix(&root)
        .map_err(|_| format!("{} is not under {}", target.display(), root.display()))?
        .to_string_lossy()
        .replace('\\', "/");
    let git = Git::new(root.to_string_lossy().into_owned());
    match revision_file_bytes(&git, revision, &relative)? {
        Some(bytes) => Ok(ExtPageBytes {
            error: None,
            bytes: Some(encode(&bytes)),
            base64: None,
            size: Some(bytes.len() as u64),
        }),
        // A path missing at the revision (the deleted side of a binary change) is data,
        // not an error: the machinery draws the empty side from exactly this answer.
        None => Ok(ExtPageBytes {
            error: None,
            bytes: None,
            base64: None,
            size: None,
        }),
    }
}

/// The core `ext_page_file_chunk` delegates to (and the tests call directly).
pub fn ext_page_file_chunk_core(
    roots: &[String],
    repo: &str,
    path: &str,
    offset: i64,
    len: i64,
    encode: impl Fn(&[u8]) -> String,
) -> Result<ExtPageBytes, String> {
    let (_, target) = confine_page_path(roots, repo, path)?;
    let (bytes, size) = read_file_window(&target, offset.max(0) as u64, len)?;
    Ok(ExtPageBytes {
        error: None,
        bytes: None,
        base64: Some(encode(&bytes)),
        size: Some(size),
    })
}

#[cfg(test)]
mod ext_fs_tests {
    use super::*;

    fn roots(tmp: &tempfile::TempDir) -> Vec<String> {
        vec![tmp.path().join("ws").to_string_lossy().into_owned()]
    }

    #[test]
    fn paths_are_confined_to_the_workspace_roots() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("ws")).unwrap();
        let roots = roots(&tmp);
        // A relative path resolves against the first root.
        std::fs::write(tmp.path().join("ws/file.txt"), b"x").unwrap();
        let resolved = confine_to_roots(&roots, "file.txt").unwrap();
        assert!(resolved.ends_with("file.txt"));
        // An absolute path outside the roots is refused.
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, b"x").unwrap();
        assert!(confine_to_roots(&roots, &outside.to_string_lossy()).is_err());
        // A `..` escape canonicalizes outside too.
        assert!(confine_to_roots(&roots, "../ws2/file").is_err());
        // A not-yet-existing file inside is fine (its parent canonicalizes).
        assert!(confine_to_roots(&roots, "newdir/newfile.txt").is_ok());
    }

    #[test]
    fn read_write_list_stat_mkdir_delete_rename_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("ws")).unwrap();
        let roots = roots(&tmp);
        let encode = |bytes: &[u8]| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(bytes)
        };

        ext_fs_core(
            "write",
            &roots,
            "notes/a.txt",
            None,
            Some(&encode(b"hello")),
            encode,
        )
        .unwrap();
        let read = ext_fs_core("read", &roots, "notes/a.txt", None, None, encode).unwrap();
        assert_eq!(read["data"], encode(b"hello"));

        ext_fs_core("mkdir", &roots, "empty", None, None, encode).unwrap();
        let list = ext_fs_core("list", &roots, ".", None, None, encode).unwrap();
        let names: Vec<&str> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"notes") && names.contains(&"empty"));

        let stat = ext_fs_core("stat", &roots, "notes/a.txt", None, None, encode).unwrap();
        assert_eq!(stat["type"], 1);
        assert_eq!(stat["size"], 5);

        ext_fs_core(
            "rename",
            &roots,
            "notes/a.txt",
            Some("notes/b.txt"),
            None,
            encode,
        )
        .unwrap();
        assert!(
            ext_fs_core("exists", &roots, "notes/a.txt", None, None, encode).unwrap()[0].is_null()
        );
        let found = ext_fs_core("exists", &roots, "notes/b.txt", None, None, encode).unwrap();
        assert_eq!(found.as_array().unwrap().len(), 1);

        ext_fs_core("delete", &roots, "notes", None, None, encode).unwrap();
        assert!(!tmp.path().join("ws/notes").exists());
    }

    #[test]
    fn find_walks_the_globs() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(ws.join("src/deep")).unwrap();
        std::fs::create_dir_all(ws.join(".git")).unwrap();
        std::fs::write(ws.join("src/main.rs"), b"").unwrap();
        std::fs::write(ws.join("src/deep/util.rs"), b"").unwrap();
        std::fs::write(ws.join(".git/config"), b"").unwrap();
        let roots = roots(&tmp);
        let encode = |_: &[u8]| String::new();

        let all_rs = ext_fs_core("find", &roots, "**/*.rs", None, None, encode).unwrap();
        let list = all_rs.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|p| p.as_str().unwrap().ends_with(".rs")));

        let top = ext_fs_core("find", &roots, "src/*.rs", None, None, encode).unwrap();
        assert_eq!(top.as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_glob_matcher_understands_double_star_and_question() {
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "main.rs"));
        assert!(!glob_match("src/*.rs", "src/deep/util.rs"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("a?c", "abbc"));
        assert!(glob_match("*.json", "package.json"));
    }
}

#[cfg(test)]
mod page_bytes_tests {
    use crate::test_git::*;
    use ggs_testkit::Scratch;
    use base64::Engine as _;

    use super::*;

    fn encode(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn revision_bytes_answer_a_committed_file_and_mark_a_missing_side() {
        let scratch = Scratch::new("page-revision-bytes");
        let repo_path = scratch.path("repo");
        let git = scratch.repo("repo");
        let binary: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a];
        std::fs::write(repo_path.join("logo.bin"), binary).unwrap();
        git.output(&["add", "logo.bin"]).unwrap();
        git.output(&["commit", "-m", "binary"]).unwrap();
        let hash = crate::test_git::rev(&git, "HEAD");

        let root = repo_path.to_string_lossy().into_owned();
        let roots = [root.clone()];
        let answer =
            ext_page_revision_bytes_core(&roots, &root, &hash, "logo.bin", encode).unwrap();
        assert_eq!(answer.error, None);
        assert_eq!(
            answer.bytes.as_deref(),
            Some(
                base64::engine::general_purpose::STANDARD
                    .encode(binary)
                    .as_str()
            )
        );
        assert_eq!(answer.size, Some(binary.len() as u64));

        // A path missing at the revision is the deleted side's data, not an error.
        let missing =
            ext_page_revision_bytes_core(&roots, &root, &hash, "gone.bin", encode).unwrap();
        assert_eq!(missing.error, None);
        assert_eq!(missing.bytes, None);

        // A path that leaves the repo is refused — the services are workspace-confined.
        assert!(
            ext_page_revision_bytes_core(&roots, &root, &hash, "../../outside.bin", encode)
                .is_err()
        );
    }

    #[test]
    fn file_chunk_answers_windows_and_the_whole_size() {
        let scratch = Scratch::new("page-file-chunk");
        let dir = scratch.path("repo");
        std::fs::create_dir_all(&dir).unwrap();
        let data: Vec<u8> = (0..=255u8).collect();
        std::fs::write(dir.join("blob.bin"), &data).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let roots = [root.clone()];

        let window = ext_page_file_chunk_core(&roots, &root, "blob.bin", 250, 10, encode).unwrap();
        assert_eq!(window.error, None);
        assert_eq!(
            window.base64.as_deref(),
            Some(encode(&data[250..]).as_str())
        );
        assert_eq!(window.size, Some(256));

        let to_end = ext_page_file_chunk_core(&roots, &root, "blob.bin", 200, -1, encode).unwrap();
        assert_eq!(
            to_end.base64.as_deref(),
            Some(encode(&data[200..]).as_str())
        );
    }
}
