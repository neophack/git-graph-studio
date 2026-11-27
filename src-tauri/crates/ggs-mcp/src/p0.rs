//! P0 MCP tools: live index refresh, atomic symbol rename, semantic git diff impact,
//! symbol git blame, commit detail inspection, and C/C++ compile context & macro expansion.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::process::Command;

use serde_json::Value;

use ggs_analysis::security::scan_file;
use ggs_analysis::Direction;
use ggs_index::symbols::preprocessor::{
    eval_inactive_ranges, expand_macro_at, load_conditions,
};
use ggs_index::symbols::rename::{rename_apply, rename_plan};

use crate::McpServer;

impl McpServer {
    /// `index_refresh`: synchronously update both the persistent symbol index and the
    /// code-analysis engine after file edits so the very next MCP query reflects disk
    /// state immediately.
    pub(crate) fn tool_index_refresh(&self, args: &Value) -> Result<String, (i64, String)> {
        let mut paths: Vec<String> = args
            .get("paths")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(|p| p.replace('\\', "/").trim_start_matches("./").to_owned())
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        // When no explicit paths are provided, ask git status for dirty files so the
        // analysis engine also updates every recently modified/added file.
        if paths.is_empty() {
            if let Ok(output) = Command::new("git")
                .args(["-C", &self.root, "status", "--porcelain"])
                .output()
            {
                if output.status.success() {
                    let text = String::from_utf8_lossy(&output.stdout);
                    for line in text.lines() {
                        if line.len() > 3 {
                            let raw = line[3..].trim();
                            let p = raw.rsplit(" -> ").next().unwrap_or(raw);
                            let clean = p.trim_matches('"').replace('\\', "/");
                            if !clean.is_empty() {
                                paths.push(clean);
                            }
                        }
                    }
                }
            }
        }

        let started = std::time::Instant::now();
        let sym_changed = self.index.refresh_paths_blocking(&self.root, &paths);
        let analysis_updated = if !paths.is_empty() {
            self.analysis.apply_changes_blocking(&self.root, &paths)
        } else {
            false
        };
        let status = self.index.status(&self.root);
        let scope = if paths.is_empty() {
            "disk drift scan".to_owned()
        } else {
            format!("{} path(s)", paths.len())
        };
        Ok(format!(
            "Index refreshed ({scope}) in {} ms — symbol_index_changed={sym_changed}, analysis_updated={analysis_updated}\nfiles: {}, symbols: {}",
            started.elapsed().as_millis(),
            status.files,
            status.symbols
        ))
    }

    /// `symbol_rename`: conflict-checked, encoding/BOM/line-ending preserving workspace
    /// symbol rename. Defaults to `dryRun: true` so the model can inspect the exact
    /// blast radius before applying.
    pub(crate) fn tool_symbol_rename(&self, args: &Value) -> Result<String, (i64, String)> {
        let old_name = Self::arg_str(args, "oldName")?;
        let new_name = Self::arg_str(args, "newName")?;
        let dry_run = args
            .get("dryRun")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(80)
            .clamp(1, 200) as usize;

        if dry_run {
            let plan = self
                .with_store(|store| rename_plan(&self.root, store, &old_name, &new_name))?
                .map_err(|e| (-32603, format!("rename_plan failed: {e}")))?;

            let mut out = format!(
                "Rename preview '{old_name}' → '{new_name}': {} site(s) across {} file(s)",
                plan.sites.len(),
                plan.files
            );
            if !plan.conflicts.is_empty() {
                out.push_str("\nCONFLICTS (apply would refuse):");
                for c in &plan.conflicts {
                    out.push_str(&format!("\n  - {c}"));
                }
            } else {
                out.push_str("\nconflicts: none (safe to apply with dryRun=false)");
            }
            for site in plan.sites.iter().take(limit) {
                out.push_str(&format!(
                    "\n  {}:{}:{}",
                    site.path,
                    site.line + 1,
                    site.column + 1
                ));
            }
            if plan.sites.len() > limit {
                out.push_str(&format!(
                    "\n… +{} more site(s) omitted from preview",
                    plan.sites.len() - limit
                ));
            }
            return Ok(out);
        }

        let outcome = self
            .with_store(|store| rename_apply(&self.root, store, &old_name, &new_name))?
            .map_err(|e| (-32602, format!("rename refused: {e}")))?;

        // Synchronously refresh both indexes on every rewritten file so subsequent calls
        // immediately observe the new symbol name.
        if !outcome.files.is_empty() {
            self.index.refresh_paths_blocking(&self.root, &outcome.files);
            self.analysis
                .apply_changes_blocking(&self.root, &outcome.files);
        }

        let mut out = format!(
            "Renamed '{old_name}' → '{new_name}': {} occurrence(s) rewritten across {} file(s) (index refreshed).",
            outcome.applied,
            outcome.files.len()
        );
        for f in outcome.files.iter().take(limit) {
            out.push_str(&format!("\n  modified: {f}"));
        }
        if outcome.files.len() > limit {
            out.push_str(&format!(
                "\n… +{} more modified file(s)",
                outcome.files.len() - limit
            ));
        }
        if !outcome.errors.is_empty() {
            out.push_str(&format!("\nerrors ({}):", outcome.errors.len()));
            for err in &outcome.errors {
                out.push_str(&format!("\n  {}: {}", err.path, err.message));
            }
        }
        Ok(out)
    }

    /// `git_diff_impact`: semantic blast-radius analysis for working-tree changes,
    /// staged changes, a commit, or a git revision range.
    pub(crate) fn tool_git_diff_impact(&self, args: &Value) -> Result<String, (i64, String)> {
        let target = args
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("working");
        let max_depth = args
            .get("maxDepth")
            .and_then(Value::as_u64)
            .unwrap_or(2)
            .clamp(1, 4) as u32;

        let mut cmd = Command::new("git");
        cmd.args(["-C", &self.root]);
        match target {
            "working" | "" => {
                cmd.args(["diff", "--unified=0", "--no-color"]);
            }
            "staged" => {
                cmd.args(["diff", "--cached", "--unified=0", "--no-color"]);
            }
            rev if rev.contains("..") => {
                cmd.args(["diff", "--unified=0", "--no-color", rev]);
            }
            rev => {
                cmd.args(["show", "--format=", "--unified=0", "--no-color", rev]);
            }
        }

        let output = cmd
            .output()
            .map_err(|e| (-32603, format!("git diff failed: {e}")))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Ok(format!(
                "git diff for '{target}' failed: {}",
                err.trim()
            ));
        }

        let diff_text = String::from_utf8_lossy(&output.stdout);
        let changed_ranges = parse_diff_hunks(&diff_text);
        if changed_ranges.is_empty() {
            return Ok(format!("No modified hunks found for target '{target}'."));
        }

        // Map changed line ranges to enclosing symbols in the symbol index.
        let mut touched_symbols: Vec<(String, String, String, usize)> = Vec::new(); // (name, kind, path, line1)
        let mut seen_sym: BTreeSet<(String, String, usize)> = BTreeSet::new();
        for (path, ranges) in &changed_ranges {
            if let Some(outline) = self.index.file_symbols(&self.root, path) {
                for sym in outline {
                    let sym_start = sym.line + 1;
                    let sym_end = sym.end_line + 1;
                    let overlaps = ranges
                        .iter()
                        .any(|&(s, e)| s <= sym_end && e >= sym_start);
                    if overlaps && seen_sym.insert((sym.name.clone(), path.clone(), sym_start)) {
                        touched_symbols.push((
                            sym.name,
                            sym.kind.to_owned(),
                            path.clone(),
                            sym_start,
                        ));
                    }
                }
            }
        }

        // Compute upstream callers (blast radius) from the analysis engine.
        let mut caller_hits: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut affected_files: BTreeSet<String> = BTreeSet::new();
        if let Ok(data_arc) = self.analysis_data() {
            let data = data_arc.lock().unwrap();
            for (name, _, _, _) in touched_symbols.iter().take(30) {
                let graph = data.call_graph(name, None, Direction::Callers, max_depth);
                let mut callers = Vec::new();
                for node in graph.nodes.iter().filter(|n| n.depth > 0).take(12) {
                    affected_files.insert(node.path.clone());
                    callers.push(format!(
                        "{} ({}:{}, d={})",
                        node.name,
                        node.path,
                        node.line + 1,
                        node.depth
                    ));
                }
                if !callers.is_empty() {
                    caller_hits.insert(name.clone(), callers);
                }
            }
        }

        // Run fast security scan on the changed files.
        let mut sec_findings: Vec<String> = Vec::new();
        for path in changed_ranges.keys().take(40) {
            if let Ok(bytes) = std::fs::read(Path::new(&self.root).join(path)) {
                let text = String::from_utf8_lossy(&bytes);
                let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
                for f in scan_file(path, ext, &text) {
                    sec_findings.push(format!(
                        "[{:?}] {} ({}, {}) — {}:{}",
                        f.severity,
                        f.message,
                        f.rule_id,
                        f.cwe,
                        f.path,
                        f.line + 1
                    ));
                }
            }
        }

        let mut out = format!(
            "Semantic diff impact ({target}): {} file(s) changed, {} symbol(s) touched, {} upstream caller file(s) in blast radius (depth ≤ {max_depth})",
            changed_ranges.len(),
            touched_symbols.len(),
            affected_files.len()
        );
        out.push_str("\nchanged files:");
        for (path, ranges) in changed_ranges.iter().take(25) {
            let span_str = ranges
                .iter()
                .take(4)
                .map(|(s, e)| {
                    if s == e {
                        format!("L{s}")
                    } else {
                        format!("L{s}-{e}")
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            out.push_str(&format!("\n  {path} ({span_str})"));
        }
        if !touched_symbols.is_empty() {
            out.push_str("\ntouched symbols:");
            for (name, kind, path, line) in touched_symbols.iter().take(30) {
                out.push_str(&format!("\n  {kind} {name} — {path}:{line}"));
            }
            if touched_symbols.len() > 30 {
                out.push_str(&format!(
                    "\n  … +{} more symbol(s)",
                    touched_symbols.len() - 30
                ));
            }
        }
        if !caller_hits.is_empty() {
            out.push_str("\nupstream blast radius (callers):");
            for (sym, callers) in caller_hits.iter().take(20) {
                out.push_str(&format!("\n  {sym} ← {}", callers.join("; ")));
            }
        }
        if !sec_findings.is_empty() {
            out.push_str(&format!(
                "\nsecurity findings in changed files ({}):",
                sec_findings.len()
            ));
            for f in sec_findings.iter().take(15) {
                out.push_str(&format!("\n  {f}"));
            }
        }
        Ok(out)
    }

    /// `git_blame_symbol`: summarize authorship and recent commits over a symbol's exact
    /// declaration-to-end line span.
    pub(crate) fn tool_git_blame_symbol(&self, args: &Value) -> Result<String, (i64, String)> {
        let name = Self::arg_str(args, "name")?;
        let asked_path = args
            .get("path")
            .and_then(Value::as_str)
            .map(|p| p.replace('\\', "/"));

        let mut defs = self.index.lookup(&self.root, &name).unwrap_or_default();
        if let Some(wanted) = &asked_path {
            defs.retain(|d| d.path == *wanted);
        }
        let Some(def) = defs.first() else {
            return Ok(format!("No symbol named '{name}' is declared in the index."));
        };
        let start = def.line + 1;
        let end = (def.end_line + 1).max(start);

        let output = Command::new("git")
            .args([
                "-C",
                &self.root,
                "blame",
                "--line-porcelain",
                &format!("-L{start},{end}"),
                "--",
                &def.path,
            ])
            .output()
            .map_err(|e| (-32603, format!("git blame failed: {e}")))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Ok(format!(
                "git blame failed for {} ({}:{start}-{end}): {}",
                name,
                def.path,
                err.trim()
            ));
        }

        let text = String::from_utf8_lossy(&output.stdout);
        let mut commits: HashMap<String, (String, i64, String, usize)> = HashMap::new(); // hash -> (author, ts, summary, lines)
        let mut cur_hash = String::new();
        let mut cur_author = String::new();
        let mut cur_ts: i64 = 0;
        let mut cur_summary = String::new();

        for line in text.lines() {
            if let Some(first) = line.split_whitespace().next() {
                if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
                    cur_hash = first[..8].to_owned();
                    continue;
                }
            }
            if let Some(a) = line.strip_prefix("author ") {
                cur_author = a.to_owned();
            } else if let Some(t) = line.strip_prefix("author-time ") {
                cur_ts = t.parse().unwrap_or(0);
            } else if let Some(s) = line.strip_prefix("summary ") {
                cur_summary = s.to_owned();
            } else if line.starts_with('\t') && !cur_hash.is_empty() {
                let entry = commits.entry(cur_hash.clone()).or_insert_with(|| {
                    (cur_author.clone(), cur_ts, cur_summary.clone(), 0)
                });
                entry.3 += 1;
            }
        }

        let mut rows: Vec<(String, String, i64, String, usize)> = commits
            .into_iter()
            .map(|(h, (a, ts, s, n))| (h, a, ts, s, n))
            .collect();
        rows.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.4.cmp(&a.4)));

        let total_lines = end - start + 1;
        let mut out = format!(
            "git blame for {} {} — {}:{start}-{end} ({total_lines} lines, {} distinct commit(s)):",
            def.kind,
            def.name,
            def.path,
            rows.len()
        );
        for (hash, author, _, summary, lines) in rows.iter().take(15) {
            out.push_str(&format!(
                "\n  {hash}  {lines:>3} line(s)  {author} — {summary}"
            ));
        }
        if rows.len() > 15 {
            out.push_str(&format!("\n  … +{} more commit(s)", rows.len() - 15));
        }
        Ok(out)
    }

    /// `git_commit_detail`: bounded commit metadata, file stats, and optional patch.
    pub(crate) fn tool_git_commit_detail(&self, args: &Value) -> Result<String, (i64, String)> {
        let rev = args
            .get("rev")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("HEAD");
        let include_patch = args
            .get("includePatch")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let max_lines = args
            .get("maxLines")
            .and_then(Value::as_u64)
            .unwrap_or(120)
            .clamp(20, 400) as usize;

        let mut cmd = Command::new("git");
        cmd.args([
            "-C",
            &self.root,
            "show",
            "--no-color",
            "--stat",
            if include_patch { "-p" } else { "--no-patch" },
            rev,
        ]);
        let output = cmd
            .output()
            .map_err(|e| (-32603, format!("git show failed: {e}")))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Ok(format!("git show '{rev}' failed: {}", err.trim()));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let lines: Vec<&str> = text.lines().collect();
        let shown = lines.len().min(max_lines);
        let mut out = lines[..shown].join("\n");
        if lines.len() > shown {
            out.push_str(&format!(
                "\n… +{} more line(s) truncated (raise maxLines up to 400)",
                lines.len() - shown
            ));
        }
        Ok(out)
    }

    /// `compile_context`: inspect active C/C++ preprocessor macros (`.ggs/conditions.json`
    /// plus `compile_commands.json` `-D`/`-I` flags when present), evaluate inactive
    /// `#ifdef`/`#if` ranges in a file, and/or expand a `#define` macro.
    pub(crate) fn tool_compile_context(&self, args: &Value) -> Result<String, (i64, String)> {
        let path = args
            .get("path")
            .and_then(Value::as_str)
            .map(|p| p.replace('\\', "/"));
        let macro_name = args
            .get("macroName")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let call_line = args.get("callLine").and_then(Value::as_str);

        let mut macros = load_conditions(&self.root).macros;
        let mut include_dirs: Vec<String> = Vec::new();
        let mut cc_source: Option<String> = None;

        // Also inspect compile_commands.json if present at root or build/.
        for candidate in ["compile_commands.json", "build/compile_commands.json"] {
            let cc_path = Path::new(&self.root).join(candidate);
            if let Ok(raw) = std::fs::read_to_string(&cc_path) {
                if let Ok(entries) = serde_json::from_str::<Vec<Value>>(&raw) {
                    cc_source = Some(format!("{candidate} ({} entries)", entries.len()));
                    if let Some(rel) = &path {
                        if let Some(entry) = entries.iter().find(|e| {
                            e.get("file")
                                .and_then(Value::as_str)
                                .is_some_and(|f| f.replace('\\', "/").ends_with(rel))
                        }) {
                            let cmd_tokens = extract_compile_tokens(entry);
                            parse_compiler_flags(&cmd_tokens, &mut macros, &mut include_dirs);
                        }
                    }
                    break;
                }
            }
        }

        let mut out = format!(
            "Compile context for {}:",
            path.as_deref().unwrap_or("(workspace)")
        );
        if let Some(src) = &cc_source {
            out.push_str(&format!("\ncompile_commands: {src}"));
        } else {
            out.push_str("\ncompile_commands: none found");
        }

        let mut macro_rows: Vec<(&String, &Option<i64>)> = macros.iter().collect();
        macro_rows.sort_by(|a, b| a.0.cmp(b.0));
        out.push_str(&format!("\nconfigured macros ({}):", macro_rows.len()));
        for (k, v) in macro_rows.iter().take(40) {
            match v {
                Some(n) => out.push_str(&format!("\n  #define {k} {n}")),
                None => out.push_str(&format!("\n  #undef {k}")),
            }
        }
        if macro_rows.len() > 40 {
            out.push_str(&format!("\n  … +{} more macro(s)", macro_rows.len() - 40));
        }

        if !include_dirs.is_empty() {
            out.push_str(&format!("\ninclude paths ({}):", include_dirs.len()));
            for inc in include_dirs.iter().take(20) {
                out.push_str(&format!("\n  -I {inc}"));
            }
        }

        if let Some(rel) = &path {
            match self.resolve_repo_path(rel) {
                Ok(abs) => match std::fs::read_to_string(&abs) {
                    Ok(text) => {
                        let inactive = eval_inactive_ranges(&text, &macros);
                        if inactive.is_empty() {
                            out.push_str(&format!("\ninactive branches in {rel}: none"));
                        } else {
                            out.push_str(&format!(
                                "\ninactive branches in {rel} ({} range(s), 1-based inclusive):",
                                inactive.len()
                            ));
                            for r in inactive.iter().take(40) {
                                out.push_str(&format!(
                                    "\n  lines {}-{}",
                                    r.start_line + 1,
                                    r.end_line + 1
                                ));
                            }
                        }
                    }
                    Err(e) => out.push_str(&format!("\ncould not read {rel}: {e}")),
                },
                Err(msg) => out.push_str(&format!("\n{msg}")),
            }
        }

        if let Some(name) = macro_name {
            let expanded = self.with_store(|store| expand_macro_at(store, name, call_line))?;
            match expanded {
                Some(exp) => {
                    out.push_str(&format!(
                        "\nmacro expansion for '{name}' ({}:{}):",
                        exp.path,
                        exp.line + 1
                    ));
                    if !exp.params.is_empty() {
                        out.push_str(&format!("\n  params: ({})", exp.params.join(", ")));
                    }
                    out.push_str(&format!("\n  definition: {}", exp.definition));
                    out.push_str(&format!("\n  expanded:   {}", exp.expanded));
                }
                None => out.push_str(&format!("\nmacro '{name}' was not found in the symbol index.")),
            }
        }

        Ok(out)
    }
}

/// Parse unified-0 diff output into `path -> Vec<(start_line_1based, end_line_1based)>`.
fn parse_diff_hunks(diff: &str) -> BTreeMap<String, Vec<(usize, usize)>> {
    let mut out: BTreeMap<String, Vec<(usize, usize)>> = BTreeMap::new();
    let mut cur_file: Option<String> = None;
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("+++ b/") {
            cur_file = Some(rest.trim().replace('\\', "/"));
        } else if line.starts_with("+++ /dev/null") {
            cur_file = None;
        } else if line.starts_with("@@ ") {
            let Some(file) = cur_file.as_ref() else {
                continue;
            };
            // Format: @@ -old_start,old_len +new_start,new_len @@
            if let Some(plus_part) = line.split(" +").nth(1) {
                let range_tok = plus_part.split_whitespace().next().unwrap_or("");
                let (start_s, count_s) = match range_tok.split_once(',') {
                    Some((s, c)) => (s, c),
                    None => (range_tok, "1"),
                };
                if let (Ok(start), Ok(count)) = (start_s.parse::<usize>(), count_s.parse::<usize>())
                {
                    let begin = start.max(1);
                    let end = if count == 0 { begin } else { begin + count - 1 };
                    out.entry(file.clone()).or_default().push((begin, end));
                }
            }
        }
    }
    out
}

fn extract_compile_tokens(entry: &Value) -> Vec<String> {
    if let Some(arr) = entry.get("arguments").and_then(Value::as_array) {
        return arr
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
    }
    entry
        .get("command")
        .and_then(Value::as_str)
        .map(|s| s.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default()
}

fn parse_compiler_flags(
    tokens: &[String],
    macros: &mut HashMap<String, Option<i64>>,
    includes: &mut Vec<String>,
) {
    let mut i = 0;
    while i < tokens.len() {
        let tok = &tokens[i];
        if let Some(def) = tok.strip_prefix("-D") {
            let spec = if def.is_empty() && i + 1 < tokens.len() {
                i += 1;
                tokens[i].as_str()
            } else {
                def
            };
            if let Some((k, v)) = spec.split_once('=') {
                let val = v.parse::<i64>().unwrap_or(1);
                macros.insert(k.to_owned(), Some(val));
            } else if !spec.is_empty() {
                macros.insert(spec.to_owned(), Some(1));
            }
        } else if let Some(undef) = tok.strip_prefix("-U") {
            let name = if undef.is_empty() && i + 1 < tokens.len() {
                i += 1;
                tokens[i].as_str()
            } else {
                undef
            };
            if !name.is_empty() {
                macros.insert(name.to_owned(), None);
            }
        } else if let Some(inc) = tok.strip_prefix("-I") {
            let dir = if inc.is_empty() && i + 1 < tokens.len() {
                i += 1;
                tokens[i].as_str()
            } else {
                inc
            };
            if !dir.is_empty() {
                includes.push(dir.to_owned());
            }
        } else if tok == "-isystem" && i + 1 < tokens.len() {
            i += 1;
            includes.push(tokens[i].clone());
        }
        i += 1;
    }
}
