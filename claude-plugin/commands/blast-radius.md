---
description: Map the semantic blast radius of a symbol or current git diff before editing or merging.
argument-hint: "[symbol-name | working | staged | commit-or-range]"
---

Perform a semantic blast-radius analysis for `$ARGUMENTS` (default to `working` if empty):

1. If the target is `working`, `staged`, a commit hash, or a git range (`..`), call `mcp__ggs__git_diff_impact`.
2. Otherwise call `mcp__ggs__symbol_context` and `mcp__ggs__analysis_call_graph` (`direction: "callers"`, `maxDepth: 3`).
3. Summarize touched symbols, upstream callers, affected modules, security findings, and the minimum set of tests to run.
4. Offer to visualize the key symbol in the desktop app via `mcp__ggs__ui_show_relation_graph`.
