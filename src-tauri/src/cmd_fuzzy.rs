// Quick Open's fuzzy file matching and the editor's path completion, server-side: the file
// list the backend already caches is scored here, so a keystroke ships ~60 rows over IPC
// instead of the walked tree, and the scoring itself runs at Rust speed instead of in the
// webview's event loop. The tiers mirror the TS scorer in `fuzzy.ts` (a VS Code
// fuzzyScorer port): a label-prefix hit outranks any label hit, which outranks any
// path-only hit - the frontend keeps the TS scorer as the fallback when no folder is open.

use serde::Serialize;
use std::time::Duration;

use crate::cmd_fs::{cached_file_list, walk_files};
use crate::AppState;
use tauri::State;

/// One ranked Quick Open row: the file's path, its label (the basename) and the matched
/// ranges within the label as [start, end) pairs the picker bolds, in UTF-16 code units -
/// the index domain JS string slicing uses.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyFileHit {
    pub path: String,
    pub label: String,
    pub ranges: Vec<(u32, u32)>,
}

/// The tiers of the TS scorer (`fuzzy.ts`), kept apart by wide gaps so the ordering of the
/// two implementations never diverges on real queries.
const LABEL_PREFIX_SCORE: i64 = 1 << 17;
const LABEL_SCORE: i64 = 1 << 16;
const PATH_SCORE: i64 = 1 << 15;

fn is_path_separator(unit: u16) -> bool {
    unit == u16::from(b'/') || unit == u16::from(b'\\')
}

fn is_other_separator(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|byte| b"_-. '\":".contains(&byte))
}

fn is_upper(unit: u16) -> bool {
    unit >= u16::from(b'A') && unit <= u16::from(b'Z')
}

/// A query prepared for scoring: the text as typed and its lowercase form, both as UTF-16
/// code units - the frontend's string index domain, which the TS fallback scorer iterates
/// (`charCodeAt`) and the picker's bolding slices (`label.slice(start, end)`).
struct FuzzyQuery {
    units: Vec<u16>,
    lower: Vec<u16>,
}

impl FuzzyQuery {
    fn new(text: &str) -> FuzzyQuery {
        FuzzyQuery {
            units: text.encode_utf16().collect(),
            lower: text.to_lowercase().encode_utf16().collect(),
        }
    }
}

/// Score `query` against `label` as a case-insensitive subsequence, mirroring the TS
/// scorer's `scoreSequence`: +1 per matched character, +1 for an exact-case match, a
/// steepening bonus for a consecutive run, +8 at the string start, +5 after a path
/// separator, +4 after `_`/`-`/`.`/space, +2 for a camelCase hump outside a run. Matching
/// runs over the lowercased UTF-16 code units, so `Échange.ts` matches `éch` and the
/// returned positions slice the label correctly in JS. Returns the score and the matched
/// positions, or None when the query is not a subsequence of the label.
fn score_label(label: &str, query: &FuzzyQuery) -> Option<(i64, Vec<u32>)> {
    if query.lower.is_empty() {
        return Some((0, Vec::new()));
    }
    let units: Vec<u16> = label.encode_utf16().collect();
    let lower: Vec<u16> = label.to_lowercase().encode_utf16().collect();
    if query.lower.len() > lower.len() {
        return None;
    }
    let mut positions = Vec::with_capacity(query.lower.len());
    let mut score: i64 = 0;
    let mut run: i64 = 0;
    let mut at = 0usize;
    for (index, &wanted) in query.lower.iter().enumerate() {
        let mut found = None;
        for (offset, &unit) in lower.iter().enumerate().skip(at) {
            if unit == wanted {
                found = Some(offset);
                break;
            }
        }
        let hit = found?;
        if hit > at {
            run = 0; // a gap before this match breaks the consecutive run
        }
        score += 1;
        if query.units.get(index) == units.get(hit) {
            score += 1; // exact case
        }
        if run > 0 {
            score += run.min(3) * 6 + (run - 3).max(0) * 3; // a consecutive run, steepening
        }
        if hit == 0 {
            score += 8;
        } else if is_path_separator(lower[hit - 1]) {
            score += 5;
        } else if is_other_separator(lower[hit - 1]) {
            score += 4;
        } else if run == 0 && units.get(hit).is_some_and(|&unit| is_upper(unit)) {
            score += 2; // a camelCase hump
        }
        positions.push(hit as u32);
        run += 1;
        at = hit + 1;
    }
    Some((score, positions))
}

/// Score one file for a query: the label tiers first, the path around the label as the
/// lowest tier. The path tier's positions are shifted into label coordinates as an empty
/// range set (the picker bolds label hits; a path-only hit keeps the row unbolded, as in
/// the TS picker).
fn score_file(path: &str, label_range: (usize, usize), query: &FuzzyQuery) -> Option<i64> {
    let label = &path[label_range.0..label_range.1];
    if let Some((score, _)) = score_label(label, query) {
        // A query that prefixes the basename tops the label tier; the closer to the full
        // name, the better, so typing most of a filename prefers the shorter file.
        let label_lower: Vec<u16> = label.to_lowercase().encode_utf16().collect();
        if label_lower.starts_with(&query.lower) {
            let boost = (query.lower.len() as f64 * 100.0 / label_lower.len() as f64).round() as i64;
            return Some(LABEL_PREFIX_SCORE + boost + score);
        }
        return Some(LABEL_SCORE + score);
    }
    // A path hit: the whole path is the target, at the lowest tier.
    score_label(path, query).map(|(score, _)| score + PATH_SCORE)
}

/// The [start, end) bold ranges of the matched label positions (adjacent positions merged).
fn merge_positions(positions: &[u32]) -> Vec<(u32, u32)> {
    let mut ranges: Vec<(u32, u32)> = Vec::new();
    for &position in positions {
        match ranges.last_mut() {
            Some(last) if last.1 == position => last.1 = position + 1,
            _ => ranges.push((position, position + 1)),
        }
    }
    ranges
}

/// Quick Open's query: the open folder's file list scored in Rust, the best `limit` rows
/// first. An empty query returns the first files as walked, like the TS source does.
#[tauri::command]
pub async fn fuzzy_files(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<FuzzyFileHit>, String> {
    const TTL: Duration = Duration::from_secs(5);
    let limit = limit.unwrap_or(60).clamp(1, 200);
    let root = state
        .first_repo()
        .ok_or_else(|| "No folder is open".to_string())?;
    let files = cached_file_list(&state.file_list_cache, &root, TTL, walk_files);

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(files
            .iter()
            .take(limit)
            .map(|path| {
                let start = path.rfind('/').map(|at| at + 1).unwrap_or(0);
                FuzzyFileHit { path: path.clone(), label: path[start..].to_owned(), ranges: Vec::new() }
            })
            .collect());
    }

    let query = FuzzyQuery::new(trimmed);
    let mut scored: Vec<(i64, usize)> = Vec::new();
    for (index, path) in files.iter().enumerate() {
        let label_start = path.rfind('/').map(|at| at + 1).unwrap_or(0);
        if let Some(score) = score_file(path, (label_start, path.len()), &query) {
            scored.push((score, index));
        }
    }
    // Best score first; equal scores keep the walk order (directories were walked in order).
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.truncate(limit);

    Ok(scored
        .into_iter()
        .map(|(_, index)| {
            let path = &files[index];
            let start = path.rfind('/').map(|at| at + 1).unwrap_or(0);
            let label = &path[start..];
            // The label hits carry their bold ranges; a path-only hit carries none.
            let ranges = score_label(label, &query)
                .map(|(_, positions)| merge_positions(&positions))
                .unwrap_or_default();
            FuzzyFileHit { path: path.clone(), label: label.to_owned(), ranges }
        })
        .collect())
}

/// One path-completion entry: the next segment of the typed path, directories with a
/// trailing slash (the shape the editor's path source maps onto its options).
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    pub label: String,
    pub is_dir: bool,
}

/// The editor's path completion, server-side over the cached file list: the entries of the
/// typed fragment's folder that share the last segment's prefix (mirrors `pathOptions` in
/// `autocomplete.ts`, which stays as the fallback).
#[tauri::command]
pub async fn path_completions(
    state: State<'_, AppState>,
    prefix: String,
    limit: Option<usize>,
) -> Result<Vec<PathEntry>, String> {
    const TTL: Duration = Duration::from_secs(5);
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let root = state
        .first_repo()
        .ok_or_else(|| "No folder is open".to_string())?;
    let files = cached_file_list(&state.file_list_cache, &root, TTL, walk_files);

    let typed = prefix.replace('\\', "/");
    Ok(path_entries(&files, &typed, limit))
}

/// The pure core of `path_completions`: the entries of the typed fragment's folder that
/// share the last segment's prefix (mirrors `pathOptions` in `autocomplete.ts`, which stays
/// as the frontend's fallback).
fn path_entries(files: &[String], typed: &str, limit: usize) -> Vec<PathEntry> {
    if !typed.contains('/') {
        return Vec::new();
    }
    let typed = typed.strip_prefix("./").unwrap_or(typed);
    let folder_end = typed.rfind('/').map(|at| at + 1).unwrap_or(0);
    let (folder, partial) = typed.split_at(folder_end);
    let partial = partial.to_lowercase();

    // The distinct next segments under the folder, directories folding their subtree into
    // one trailing-slash entry.
    let mut entries: Vec<(String, bool)> = Vec::new();
    for file in files {
        let name = file.replace('\\', "/");
        if !folder.is_empty() && !name.starts_with(folder) {
            continue;
        }
        let rest = &name[folder.len()..];
        let Some((entry, _)) = rest.split_once('/') else {
            if rest.is_empty() || !rest.to_lowercase().starts_with(&partial) {
                continue;
            }
            push_unique(&mut entries, rest.to_owned(), false, limit);
            continue;
        };
        let directory = format!("{entry}/");
        if !entry.to_lowercase().starts_with(&partial) {
            continue;
        }
        push_unique(&mut entries, directory, true, limit);
    }
    entries
        .into_iter()
        .map(|(label, is_dir)| PathEntry { label, is_dir })
        .collect()
}

fn push_unique(entries: &mut Vec<(String, bool)>, label: String, is_dir: bool, limit: usize) {
    if entries.len() >= limit && !entries.iter().any(|(existing, _)| *existing == label) {
        return;
    }
    match entries.iter_mut().find(|(existing, _)| *existing == label) {
        Some(slot) => slot.1 |= is_dir,
        None => entries.push((label, is_dir)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score(path: &str, query: &str) -> Option<i64> {
        let start = path.rfind('/').map(|at| at + 1).unwrap_or(0);
        score_file(path, (start, path.len()), &FuzzyQuery::new(query))
    }

    #[test]
    fn tiers_order_prefix_label_path() {
        let prefix = score("src/main.rs", "ma").unwrap();
        let label = score("src/perm-mangle.rs", "ma").unwrap(); // label hit, no prefix
        let path = score("src/ma/other.txt", "ma").unwrap(); // label miss, path hit
        assert!(prefix > label, "{prefix} vs {label}");
        assert!(label > path, "{label} vs {path}");
        assert!(path >= PATH_SCORE);
    }

    #[test]
    fn the_prefix_tier_is_case_insensitive() {
        // "Main.rs" must reach the prefix tier for a lowercase "ma" query, outranking a
        // mid-label hit of the same characters.
        let prefix = score("src/Main.rs", "ma").unwrap();
        let mid_label = score("src/perm-mangle.rs", "ma").unwrap();
        assert!(prefix >= LABEL_PREFIX_SCORE);
        assert!(mid_label < LABEL_PREFIX_SCORE);
        assert!(prefix > mid_label);
    }

    #[test]
    fn non_subsequences_do_not_match() {
        assert!(score("src/main.rs", "mxyz").is_none());
        assert!(score("src/main.rs", "").is_some());
    }

    #[test]
    fn consecutive_runs_score_higher() {
        let run = score("src/convert.rs", "conv").unwrap();
        let scattered = score("src/convert.rs", "cov").unwrap();
        assert!(run > scattered);
    }

    #[test]
    fn ranges_merge_adjacent_positions() {
        assert_eq!(merge_positions(&[0, 1, 2, 5]), vec![(0, 3), (5, 6)]);
        assert_eq!(merge_positions(&[]), Vec::<(u32, u32)>::new());
    }

    #[test]
    fn path_entries_list_folders_and_files_of_the_fragment() {
        let files = vec![
            "src/main.rs".to_owned(),
            "src/lib/mod.rs".to_owned(),
            "src/lib/util.rs".to_owned(),
            "README.md".to_owned(),
        ];
        let labels = |prefix: &str| {
            path_entries(&files, prefix, 200)
                .into_iter()
                .map(|entry| (entry.label, entry.is_dir))
                .collect::<Vec<_>>()
        };
        // A folder fragment lists its directory, slash-marked; a deeper fragment its files.
        assert_eq!(labels("./sr"), vec![("src/".to_owned(), true)]);
        assert_eq!(labels("src/lib/"), vec![("mod.rs".to_owned(), false), ("util.rs".to_owned(), false)]);
        assert_eq!(labels("src/m"), vec![("main.rs".to_owned(), false)]);
        // Not a path fragment (no slash): nothing, the word source takes over instead.
        assert_eq!(labels("src"), Vec::<(String, bool)>::new());
    }

    #[test]
    fn path_entries_cap_the_result() {
        let files: Vec<String> = (0..50).map(|n| format!("src/file{n}.txt")).collect();
        assert_eq!(path_entries(&files, "src/", 10).len(), 10);
    }

    #[test]
    fn bold_ranges_are_utf16_code_unit_offsets() {
        // `é` is one UTF-16 code unit but two UTF-8 bytes; the frontend slices the label by
        // UTF-16 units, so byte offsets would bold the wrong character.
        let ranges = |label: &str, query: &str| {
            let (_, positions) = score_label(label, &FuzzyQuery::new(query)).unwrap();
            merge_positions(&positions)
        };
        assert_eq!(ranges("résumé.md", "s"), vec![(2, 3)]);
        assert_eq!(ranges("résumé.md", "su"), vec![(2, 4)]);
        assert_eq!(ranges("résumé.md", "sm"), vec![(2, 3), (4, 5)]);
    }

    #[test]
    fn matching_folds_case_for_non_ascii_letters() {
        // `Échange.ts` must match `éch`, as the TS fallback's Unicode-aware toLowerCase does.
        assert!(score("src/Échange.ts", "éch").is_some());
        let (_, positions) = score_label("Échange.ts", &FuzzyQuery::new("éch")).unwrap();
        assert_eq!(merge_positions(&positions), vec![(0, 3)]);
    }
}
