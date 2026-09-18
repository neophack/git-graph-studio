//! The Security report (module 17): rule-based static scanning, v1 without taint
//! tracking. Two kinds of rule share one finding shape — patterns over the raw text
//! (secrets, unsafe constructs) and call-site rules over the parsed calls (dangerous or
//! weak-crypto APIs, resolved by name and receiver the way the call graph does). Every
//! rule names its CWE; severities are error / warning / info.

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::symbols::parse::CallSite;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub rule_id: String,
    pub severity: Severity,
    pub message: String,
    pub path: String,
    /// 0-based.
    pub line: usize,
    /// 0-based byte column (patterns only; call findings carry the call's column).
    pub column: usize,
    pub cwe: String,
}

const ALL: &[&str] = &["*"];
const JS: &[&str] = &["js", "jsx", "ts", "tsx"];

enum RuleKind {
    Pattern(&'static str),
    Calls {
        names: &'static [&'static str],
        receivers: &'static [&'static str],
    },
}

struct Rule {
    id: &'static str,
    severity: Severity,
    message: &'static str,
    cwe: &'static str,
    languages: &'static [&'static str],
    kind: RuleKind,
}

/// The v1 rule set. Ordered for the report's grouping; ids are stable once shipped.
static RULES: &[Rule] = &[
    Rule {
        id: "SEC-001",
        severity: Severity::Error,
        message: "AWS access key id looks hardcoded",
        cwe: "CWE-798",
        languages: ALL,
        kind: RuleKind::Pattern(r"AKIA[0-9A-Z]{16}"),
    },
    Rule {
        id: "SEC-002",
        severity: Severity::Error,
        message: "GitHub token looks hardcoded",
        cwe: "CWE-798",
        languages: ALL,
        kind: RuleKind::Pattern(r"gh[pousr]_[A-Za-z0-9]{36,}"),
    },
    Rule {
        id: "SEC-003",
        severity: Severity::Error,
        message: "secret-looking literal assigned to a credential variable",
        cwe: "CWE-798",
        languages: ALL,
        kind: RuleKind::Pattern(
            r#"(?i)(api[_-]?key|secret|passwd|password|access[_-]?token)\s*([:=]|<-)\s*["'][^"']{8,}["']"#,
        ),
    },
    Rule {
        id: "SEC-004",
        severity: Severity::Error,
        message: "private key material in source",
        cwe: "CWE-321",
        languages: ALL,
        kind: RuleKind::Pattern(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    },
    Rule {
        id: "SEC-005",
        severity: Severity::Warning,
        message: "hardcoded JWT",
        cwe: "CWE-312",
        languages: ALL,
        kind: RuleKind::Pattern(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*"),
    },
    Rule {
        id: "SEC-006",
        severity: Severity::Warning,
        message: "authorization header with a literal bearer token",
        cwe: "CWE-798",
        languages: ALL,
        kind: RuleKind::Pattern(
            r#"(?i)(authorization|bearer)[^\n]{0,24}["'][A-Za-z0-9._\-]{20,}["']"#,
        ),
    },
    Rule {
        id: "DANG-001",
        severity: Severity::Warning,
        message: "eval() executes arbitrary code",
        cwe: "CWE-95",
        languages: JS,
        kind: RuleKind::Calls {
            names: &["eval"],
            receivers: &[],
        },
    },
    Rule {
        id: "DANG-002",
        severity: Severity::Warning,
        message: "eval() executes arbitrary code",
        cwe: "CWE-95",
        languages: &["py"],
        kind: RuleKind::Calls {
            names: &["eval"],
            receivers: &[],
        },
    },
    Rule {
        id: "DANG-003",
        severity: Severity::Warning,
        message: "exec() runs dynamic code",
        cwe: "CWE-95",
        languages: &["py"],
        kind: RuleKind::Calls {
            names: &["exec"],
            receivers: &[],
        },
    },
    Rule {
        id: "DANG-004",
        severity: Severity::Warning,
        message: "shell command from a string",
        cwe: "CWE-78",
        languages: &["py"],
        kind: RuleKind::Calls {
            names: &["system", "popen"],
            receivers: &["os"],
        },
    },
    Rule {
        id: "DANG-005",
        severity: Severity::Warning,
        message: "subprocess with shell=True",
        cwe: "CWE-78",
        languages: &["py"],
        kind: RuleKind::Pattern(r"subprocess\.\w+\([^)\n]{0,120}shell\s*=\s*True"),
    },
    Rule {
        id: "DANG-006",
        severity: Severity::Warning,
        message: "pickle.loads on untrusted data",
        cwe: "CWE-502",
        languages: &["py"],
        kind: RuleKind::Calls {
            names: &["loads", "load"],
            receivers: &["pickle"],
        },
    },
    Rule {
        id: "DANG-007",
        severity: Severity::Warning,
        message: "yaml.load without an explicit Loader",
        cwe: "CWE-502",
        languages: &["py"],
        kind: RuleKind::Pattern(r"yaml\.load\((?![^)\n]*Loader)"),
    },
    Rule {
        id: "DANG-008",
        severity: Severity::Warning,
        message: "TLS verification disabled",
        cwe: "CWE-295",
        languages: &["py"],
        kind: RuleKind::Pattern(r"verify\s*=\s*False"),
    },
    Rule {
        id: "DANG-009",
        severity: Severity::Warning,
        message: "innerHTML assignment (XSS)",
        cwe: "CWE-79",
        languages: JS,
        kind: RuleKind::Pattern(r"\.innerHTML\s*="),
    },
    Rule {
        id: "DANG-010",
        severity: Severity::Warning,
        message: "dangerouslySetInnerHTML (XSS)",
        cwe: "CWE-79",
        languages: JS,
        kind: RuleKind::Pattern(r"dangerouslySetInnerHTML"),
    },
    Rule {
        id: "DANG-011",
        severity: Severity::Info,
        message: "document.write",
        cwe: "CWE-79",
        languages: JS,
        kind: RuleKind::Calls {
            names: &["write"],
            receivers: &["document"],
        },
    },
    Rule {
        id: "DANG-012",
        severity: Severity::Warning,
        message: "SQL built by string concatenation",
        cwe: "CWE-89",
        languages: JS,
        kind: RuleKind::Pattern(r#"(?i)["'](select|insert|update|delete)\s[^\n]{0,80}\+"#),
    },
    Rule {
        id: "DANG-013",
        severity: Severity::Warning,
        message: "SQL built by string concatenation",
        cwe: "CWE-89",
        languages: &["py", "java", "cs"],
        kind: RuleKind::Pattern(
            r#"(?i)["'](select|insert|update|delete)\s[^\n]{0,80}(\+|\bfstring|\s%)"#,
        ),
    },
    Rule {
        id: "DANG-014",
        severity: Severity::Warning,
        message: "Runtime.getRuntime().exec runs a command",
        cwe: "CWE-78",
        languages: &["java"],
        kind: RuleKind::Pattern(r"Runtime\s*\.\s*getRuntime\(\)\s*\.\s*exec"),
    },
    Rule {
        id: "DANG-015",
        severity: Severity::Warning,
        message: "Process.Start runs a command",
        cwe: "CWE-78",
        languages: &["cs"],
        kind: RuleKind::Calls {
            names: &["Start"],
            receivers: &["Process"],
        },
    },
    Rule {
        id: "DANG-016",
        severity: Severity::Warning,
        message: "exec.Command runs a command",
        cwe: "CWE-78",
        languages: &["go"],
        kind: RuleKind::Calls {
            names: &["Command"],
            receivers: &["exec"],
        },
    },
    Rule {
        id: "DANG-017",
        severity: Severity::Warning,
        message: "system()/popen() runs a command",
        cwe: "CWE-78",
        languages: &["c", "h", "cpp", "hpp"],
        kind: RuleKind::Calls {
            names: &["system", "popen"],
            receivers: &[],
        },
    },
    Rule {
        id: "MEM-001",
        severity: Severity::Warning,
        message: "unbounded copy (strcpy/strcat/sprintf/gets)",
        cwe: "CWE-120",
        languages: &["c", "h", "cpp", "hpp"],
        kind: RuleKind::Calls {
            names: &["strcpy", "strcat", "sprintf", "gets"],
            receivers: &[],
        },
    },
    Rule {
        id: "CRYPT-001",
        severity: Severity::Warning,
        message: "weak hash (MD5/SHA-1)",
        cwe: "CWE-327",
        languages: &["py"],
        kind: RuleKind::Calls {
            names: &["md5", "sha1"],
            receivers: &["hashlib"],
        },
    },
    Rule {
        id: "CRYPT-002",
        severity: Severity::Warning,
        message: "weak hash (MD5/SHA-1)",
        cwe: "CWE-327",
        languages: JS,
        kind: RuleKind::Pattern(r#"createHash\(\s*["'](md5|sha1)["']"#),
    },
    Rule {
        id: "CRYPT-003",
        severity: Severity::Warning,
        message: "weak hash (MD5/SHA-1)",
        cwe: "CWE-327",
        languages: &["java"],
        kind: RuleKind::Pattern(r#"MessageDigest\s*\.\s*getInstance\(\s*["'](MD5|SHA-?1)["']"#),
    },
    Rule {
        id: "CRYPT-004",
        severity: Severity::Warning,
        message: "ECB mode cipher",
        cwe: "CWE-327",
        languages: ALL,
        kind: RuleKind::Pattern(r#"(?i)MODE_ECB|Cipher\s*\.\s*getInstance\(\s*["'][^"']*ECB"#),
    },
    Rule {
        id: "CRYPT-005",
        severity: Severity::Warning,
        message: "Math.random is not cryptographic",
        cwe: "CWE-338",
        languages: JS,
        kind: RuleKind::Calls {
            names: &["random"],
            receivers: &["Math"],
        },
    },
    Rule {
        id: "OPS-001",
        severity: Severity::Warning,
        message: "world-writable permission (777)",
        cwe: "CWE-732",
        languages: ALL,
        kind: RuleKind::Pattern(r"chmod\([^)\n]{0,60}777|0o777"),
    },
    Rule {
        id: "NET-001",
        severity: Severity::Info,
        message: "plaintext http:// URL",
        cwe: "CWE-319",
        languages: ALL,
        kind: RuleKind::Pattern(r#"["']http://[^"'\s]{3,}"#),
    },
];

/// A pathological file cannot flood the report.
const MAX_FINDINGS_PER_FILE: usize = 500;

fn rules_for(ext: &str) -> Vec<&'static Rule> {
    RULES
        .iter()
        .filter(|rule| rule.languages.contains(&"*") || rule.languages.contains(&ext))
        .collect()
}

/// Scan one parsed file. `text` is the file as read; `calls` are its call sites.
pub fn scan_file(path: &str, ext: &str, text: &str, calls: &[CallSite]) -> Vec<Finding> {
    let mut findings = Vec::new();
    static PATTERNS: OnceLock<Vec<(&'static Rule, Regex)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        RULES
            .iter()
            .filter_map(|rule| match rule.kind {
                RuleKind::Pattern(source) => Regex::new(source).ok().map(|re| (rule, re)),
                RuleKind::Calls { .. } => None,
            })
            .collect()
    });
    for (rule, regex) in patterns {
        if !rule.languages.contains(&"*") && !rule.languages.contains(&ext) {
            continue;
        }
        for hit in regex.find_iter(text) {
            if findings.len() >= MAX_FINDINGS_PER_FILE {
                return findings;
            }
            let before = &text[..hit.start()];
            findings.push(Finding {
                rule_id: rule.id.to_owned(),
                severity: rule.severity,
                message: rule.message.to_owned(),
                path: path.to_owned(),
                line: before.matches('\n').count(),
                column: hit.start() - before.rfind('\n').map_or(0, |at| at + 1),
                cwe: rule.cwe.to_owned(),
            });
        }
    }
    for rule in rules_for(ext) {
        let RuleKind::Calls { names, receivers } = rule.kind else {
            continue;
        };
        for call in calls {
            if findings.len() >= MAX_FINDINGS_PER_FILE {
                return findings;
            }
            if !names.contains(&call.name.as_str()) {
                continue;
            }
            if !receivers.is_empty()
                && call
                    .receiver
                    .as_deref()
                    .is_none_or(|r| !receivers.contains(&r))
            {
                continue;
            }
            findings.push(Finding {
                rule_id: rule.id.to_owned(),
                severity: rule.severity,
                message: rule.message.to_owned(),
                path: path.to_owned(),
                line: call.line,
                column: call.column,
                cwe: rule.cwe.to_owned(),
            });
        }
    }
    findings.sort_by_key(|f| (f.line, f.column));
    findings.dedup_by_key(|f| (f.rule_id.clone(), f.line, f.column));
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(path: &str, ext: &str, text: &str) -> Vec<Finding> {
        let parsed = crate::symbols::parse::parse_file(text, ext);
        scan_file(path, ext, text, &parsed.calls)
    }

    #[test]
    fn secrets_and_patterns_report_with_lines() {
        let findings = scan(
            "conf.py",
            "py",
            "API_KEY = 'super-secret-value-123'\nurl = \"http://example.com\"\n",
        );
        let ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert!(ids.contains(&"SEC-003"), "{ids:?}");
        assert!(ids.contains(&"NET-001"), "{ids:?}");
        let secret = findings.iter().find(|f| f.rule_id == "SEC-003").unwrap();
        assert_eq!(secret.line, 0);
        assert_eq!(secret.severity, Severity::Error);
        assert_eq!(secret.cwe, "CWE-798");
    }

    #[test]
    fn dangerous_calls_match_name_and_receiver() {
        let findings = scan(
            "s.py",
            "py",
            "import os\ndef run(cmd):\n    os.system(cmd)\n    eval(cmd)\n    md5(x)\n",
        );
        let ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert!(ids.contains(&"DANG-004"), "os.system: {ids:?}");
        assert!(ids.contains(&"DANG-002"), "eval: {ids:?}");
        let system = findings.iter().find(|f| f.rule_id == "DANG-004").unwrap();
        assert_eq!(system.line, 2);
        // A bare md5() without hashlib receiver stays quiet.
        assert!(!ids.contains(&"CRYPT-001"), "{ids:?}");
    }

    #[test]
    fn language_filters_apply() {
        let c = scan(
            "a.c",
            "c",
            "char b[8];\nvoid f(char *s) { strcpy(b, s); system(s); }\n",
        );
        let ids: Vec<&str> = c.iter().map(|f| f.rule_id.as_str()).collect();
        assert!(
            ids.contains(&"MEM-001") && ids.contains(&"DANG-017"),
            "{ids:?}"
        );
        // The JS-only rules never fire on C.
        assert!(!ids.contains(&"DANG-001"), "{ids:?}");
    }

    #[test]
    fn weak_crypto_hashlib_and_createhash() {
        let py = scan("h.py", "py", "import hashlib\nh = hashlib.md5(b'x')\n");
        assert!(py.iter().any(|f| f.rule_id == "CRYPT-001"));
        let js = scan("h.js", "js", "const d = crypto.createHash('md5');\n");
        assert!(js.iter().any(|f| f.rule_id == "CRYPT-002"));
    }
}
