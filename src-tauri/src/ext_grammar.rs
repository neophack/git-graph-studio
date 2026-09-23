//! The TextMate-grammar loader (module 12): what `contributes.grammars` installs into the
//! rope viewer's syntect set. VS Code extensions ship TextMate grammars (`.tmLanguage`
//! plists or `.json`); syntect speaks Sublime's YAML syntax definition — close cousins
//! (both pushdown automata over regexes), so a converter for the core constructs carries
//! most real grammars across:
//!
//! * `match` + `name` (+ `captures`), `begin`/`end` + `name`/`contentName` (the region's
//!   patterns flatten into the pushed context), `patterns` recursion, `repository` +
//!   `include` (a `#name` reference strips to Sublime's plain name), `fileTypes` — plus the
//!   extensions `contributes.languages` declares for the grammar's language id.
//! * Everything else (complex `while` regions, `applyEndPatternLast`, variables,
//!   `$self`/`$base`) is dropped; a regex Oniguruma spells and fancy-regex rejects fails
//!   the whole definition's load, which skips that grammar (plain text) and keeps the rest.
//!
//! The loader never fails the caller: an unreadable or unconvertible grammar logs to stderr
//! and is skipped.

use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::path::Path;

/// The `contributes` slice of an installed package.json, as this loader reads it.
#[derive(Default)]
struct GrammarsManifest {
    /// `{ language?, scopeName, path }` entries.
    grammars: Vec<Json>,
    /// `contributes.languages`' id → extensions, injected into the matching grammar's file
    /// types so the viewer resolves a file of the declared language even when the grammar
    /// itself lists none.
    languages: BTreeMap<String, Vec<String>>,
}

fn read_manifest(dir: &Path) -> GrammarsManifest {
    let mut out = GrammarsManifest::default();
    let Ok(text) = std::fs::read_to_string(dir.join("package.json")) else {
        return out;
    };
    let Ok(manifest) = serde_json::from_str::<Json>(&text) else {
        return out;
    };
    let contributes = manifest.get("contributes").cloned().unwrap_or(Json::Null);
    if let Some(grammars) = contributes.get("grammars").and_then(Json::as_array) {
        out.grammars = grammars.clone();
    }
    if let Some(languages) = contributes.get("languages").and_then(Json::as_array) {
        for language in languages {
            let (Some(id), Some(extensions)) = (
                language.get("id").and_then(Json::as_str),
                language.get("extensions").and_then(Json::as_array),
            ) else {
                continue;
            };
            out.languages.insert(
                id.to_owned(),
                extensions
                    .iter()
                    .filter_map(Json::as_str)
                    .map(str::to_owned)
                    .collect(),
            );
        }
    }
    out
}

/// Read one grammar file into the JSON tree the converter walks: `.json` directly, a
/// `.tmLanguage` plist through the `plist` crate's JSON serialization.
fn read_grammar_json(path: &Path) -> Option<Json> {
    let text = std::fs::read_to_string(path).ok()?;
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        return serde_json::from_str(&text).ok();
    }
    let value = plist::Value::from_reader(std::io::Cursor::new(text.into_bytes())).ok()?;
    serde_json::to_value(value).ok()
}

/// A single-quoted YAML scalar (the only escaping a single-quoted string needs).
fn yaml_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn yaml_list(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| yaml_string(value))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// Convert one TextMate pattern (a JSON object) into Sublime-syntax YAML rule lines at
/// `indent`; returns how many lines were written (0 = nothing convertible).
fn convert_pattern(pattern: &Json, indent: usize, out: &mut String) -> usize {
    let Some(object) = pattern.as_object() else {
        return 0;
    };
    let pad = " ".repeat(indent);
    let before = out.len();
    let match_name = object.get("name").and_then(Json::as_str).unwrap_or("");
    if let Some(begin) = object.get("begin").and_then(Json::as_str) {
        let end = object.get("end").and_then(Json::as_str).unwrap_or("(?=$)");
        // The region: an anonymous pushed context with the end match (popping), then the
        // nested patterns. `contentName` becomes the context's meta_scope.
        out.push_str(&format!("{pad}- match: {}\n", yaml_string(begin)));
        if !match_name.is_empty() {
            out.push_str(&format!("{pad}  scope: {}\n", yaml_string(match_name)));
        }
        let mut body = String::new();
        let content_scope = object
            .get("contentName")
            .and_then(Json::as_str)
            .unwrap_or("");
        if !content_scope.is_empty() {
            body.push_str(&format!(
                "{}- meta_scope: {}\n",
                " ".repeat(indent + 4),
                yaml_string(content_scope)
            ));
        }
        body.push_str(&format!(
            "{}- match: {}\n",
            " ".repeat(indent + 4),
            yaml_string(end)
        ));
        body.push_str(&format!("{}  pop: true\n", " ".repeat(indent + 4)));
        if let Some(nested) = object.get("patterns").and_then(Json::as_array) {
            for child in nested {
                convert_pattern(child, indent + 4, &mut body);
            }
        }
        out.push_str(&format!("{pad}  push:\n{body}"));
        return out.len() - before;
    }
    if let Some(matched) = object.get("match").and_then(Json::as_str) {
        out.push_str(&format!("{pad}- match: {}\n", yaml_string(matched)));
        if !match_name.is_empty() {
            out.push_str(&format!("{pad}  scope: {}\n", yaml_string(match_name)));
        }
        if let Some(captures) = object.get("captures").and_then(Json::as_object) {
            let mut parts = Vec::new();
            for (group, scope) in captures {
                if let Some(scope) = scope.as_str() {
                    if !scope.is_empty() {
                        parts.push(format!("{}: {}", group, yaml_string(scope)));
                    }
                }
            }
            if !parts.is_empty() {
                out.push_str(&format!("{pad}  captures: {{{}}}\n", parts.join(", ")));
            }
        }
        return out.len() - before;
    }
    if let Some(include) = object.get("include").and_then(Json::as_str) {
        // A repository reference (`#name`) strips to Sublime's plain name; anything else
        // (a scope-name reference into another grammar) has nothing to include here.
        if let Some(name) = include.strip_prefix('#') {
            if !name.is_empty() {
                out.push_str(&format!("{pad}- include: {}\n", yaml_string(name)));
            }
        }
        return out.len() - before;
    }
    0
}

/// Convert a parsed TextMate grammar (JSON tree) into a Sublime-syntax YAML document;
/// None when nothing of it survives (no name, no contexts).
fn convert_grammar(grammar: &Json, extra_extensions: &[String]) -> Option<String> {
    let name = grammar.get("name").and_then(Json::as_str)?;
    let scope = grammar
        .get("scopeName")
        .and_then(Json::as_str)
        .unwrap_or("source.unknown");
    let mut extensions: Vec<String> = grammar
        .get("fileTypes")
        .and_then(Json::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    for extra in extra_extensions {
        let bare = extra.trim_start_matches('.');
        if !extensions.iter().any(|existing| existing == bare) {
            extensions.push(bare.to_owned());
        }
    }

    let mut main = String::new();
    if let Some(patterns) = grammar.get("patterns").and_then(Json::as_array) {
        for pattern in patterns {
            convert_pattern(pattern, 4, &mut main);
        }
    }
    if main.is_empty() {
        main.push_str("    - match: ''\n");
    }
    // The repository: each named context becomes a top-level context the includes resolve to.
    let mut repository = String::new();
    if let Some(repo) = grammar.get("repository").and_then(Json::as_object) {
        for (context_name, definition) in repo {
            // A repository entry may be the patterns list itself, or `{ patterns: [...] }`.
            let patterns = definition
                .get("patterns")
                .and_then(Json::as_array)
                .cloned()
                .or_else(|| {
                    definition
                        .as_array()
                        .cloned()
                        .or_else(|| Some(vec![definition.clone()]))
                });
            let mut body = String::new();
            if let Some(patterns) = patterns {
                for pattern in &patterns {
                    convert_pattern(pattern, 4, &mut body);
                }
            }
            if body.is_empty() {
                body.push_str("    - match: ''\n");
            }
            repository.push_str(&format!("  {}:\n{}", context_name, body));
        }
    }

    let mut yaml = String::from("%YAML 1.2\n---\n");
    yaml.push_str(&format!("name: {}\n", yaml_string(name)));
    if !extensions.is_empty() {
        yaml.push_str(&format!("file_extensions: {}\n", yaml_list(&extensions)));
    }
    yaml.push_str(&format!("scope: {}\n", yaml_string(scope)));
    yaml.push_str("contexts:\n  main:\n");
    yaml.push_str(&main);
    yaml.push_str(&repository);
    Some(yaml)
}

/// Load every grammar an installed package declares into the builder. A grammar that fails
/// to read, convert or parse (an Oniguruma-only regex, say) is logged and skipped — the
/// file highlights as plain text, never fails the viewer.
pub fn add_grammars_from(dir: &Path, builder: &mut syntect::parsing::SyntaxSetBuilder) {
    let manifest = read_manifest(dir);
    for declared in &manifest.grammars {
        let path = match declared.get("path").and_then(Json::as_str) {
            Some(path) => dir.join(path),
            None => continue,
        };
        let fallback_name = declared
            .get("language")
            .and_then(Json::as_str)
            .unwrap_or("Extension");
        let extra = declared
            .get("language")
            .and_then(Json::as_str)
            .and_then(|id| manifest.languages.get(id))
            .cloned()
            .unwrap_or_default();
        let Some(grammar) = read_grammar_json(&path) else {
            eprintln!(
                "[extensions] grammar {} is unreadable; skipped",
                path.display()
            );
            continue;
        };
        let Some(yaml) = convert_grammar(&grammar, &extra) else {
            eprintln!(
                "[extensions] grammar {} carries no convertible content; skipped",
                path.display()
            );
            continue;
        };
        match syntect::parsing::SyntaxDefinition::load_from_str(&yaml, true, Some(fallback_name)) {
            Ok(definition) => builder.add(definition),
            Err(error) => eprintln!(
                "[extensions] grammar {} did not load ({error}); skipped",
                path.display()
            ),
        }
    }
}

/// The loader over the whole extensions home — what the rope viewer's syntax set builds
/// with (each installed package's grammars join syntect's defaults).
pub fn add_extension_grammars(builder: &mut syntect::parsing::SyntaxSetBuilder) {
    let Ok(home) = crate::cmd_ext::extensions_home_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&home) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            add_grammars_from(&entry.path(), builder);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal package with a JSON TextMate grammar (match, begin/end, repository,
    /// include) and the language declaring its extension.
    fn package_with_grammar(dir: &Path) {
        std::fs::create_dir_all(dir.join("syntaxes")).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"ml","publisher":"acme","version":"1.0.0",
                "contributes":{
                    "languages":[{"id":"mylang","aliases":["MyLang"],"extensions":[".mylang"]}],
                    "grammars":[{"language":"mylang","scopeName":"source.mylang","path":"./syntaxes/mylang.tmLanguage.json"}]
                }}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("syntaxes/mylang.tmLanguage.json"),
            r##"{
                "name": "MyLang",
                "scopeName": "source.mylang",
                "fileTypes": ["mylang"],
                "patterns": [
                    { "match": "\\bhello\\b", "name": "keyword.hello.mylang" },
                    { "begin": "\"", "end": "\"", "name": "punctuation.definition.string.begin.mylang", "contentName": "string.quoted.mylang", "patterns": [ { "include": "#escape" } ] },
                    { "include": "#word" }
                ],
                "repository": {
                    "word": { "patterns": [ { "match": "\\bworld\\b", "name": "keyword.world.mylang" } ] },
                    "escape": { "match": "\\\\.", "name": "constant.character.escape.mylang" }
                }
            }"##,
        )
        .unwrap();
    }

    #[test]
    fn a_json_grammar_loads_and_highlights_by_its_extension() {
        let tmp = tempfile::tempdir().unwrap();
        package_with_grammar(tmp.path());
        let mut builder = syntect::parsing::SyntaxSetBuilder::new();
        add_grammars_from(tmp.path(), &mut builder);
        let set = builder.build();
        // The grammar's own fileTypes plus the language's declared `.mylang` resolve.
        let syntax = set
            .find_syntax_by_extension("mylang")
            .expect("the grammar loaded");
        assert_eq!(syntax.name, "MyLang");
        // And it parses: the keyword scope appears on a match.
        let mut parser = syntect::parsing::ParseState::new(syntax);
        let ops = parser.parse_line("hello world", &set).unwrap();
        let mut stack = syntect::parsing::ScopeStack::new();
        let mut scopes = Vec::new();
        for (position, op) in &ops {
            if *position > 0 {
                scopes.push(stack.to_string());
                break;
            }
            stack.apply(op).unwrap();
        }
        assert!(
            scopes.join(" ").contains("keyword.hello"),
            "scopes: {scopes:?}"
        );
    }

    #[test]
    fn a_tmlanguage_plist_loads_the_same_way() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("syntaxes")).unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"contributes":{"grammars":[{"language":"p","path":"./syntaxes/p.tmLanguage"}]}}"#,
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("syntaxes/p.tmLanguage"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>name</key><string>PlistLang</string>
    <key>scopeName</key><string>source.plistlang</string>
    <key>fileTypes</key><array><string>plang</string></array>
    <key>patterns</key><array><dict><key>match</key><string>alpha</string><key>name</key><string>keyword.alpha</string></dict></array>
</dict></plist>"#,
        )
        .unwrap();
        let mut builder = syntect::parsing::SyntaxSetBuilder::new();
        add_grammars_from(tmp.path(), &mut builder);
        let set = builder.build();
        assert_eq!(
            set.find_syntax_by_extension("plang").unwrap().name,
            "PlistLang"
        );
    }

    #[test]
    fn an_unconvertible_grammar_is_skipped_without_failing_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("syntaxes")).unwrap();
        // Broken grammar first, a working one second: the loader skips the first.
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"contributes":{"grammars":[
                {"language":"bad","path":"./syntaxes/broken.tmLanguage.json"},
                {"language":"good","path":"./syntaxes/good.tmLanguage.json"}
            ]}}"#,
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("syntaxes/broken.tmLanguage.json"),
            "{ not json",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("syntaxes/good.tmLanguage.json"),
            r#"{"name":"Good","fileTypes":["good"],"patterns":[{"match":"x","name":"keyword.x"}]}"#,
        )
        .unwrap();
        let mut builder = syntect::parsing::SyntaxSetBuilder::new();
        add_grammars_from(tmp.path(), &mut builder);
        let set = builder.build();
        assert!(set.find_syntax_by_extension("good").is_some());
        assert!(set.find_syntax_by_extension("brokenjson").is_none());
    }
}
