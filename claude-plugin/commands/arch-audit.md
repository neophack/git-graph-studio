---
description: Audit repository architecture (module graph, import cycles, hotspots, dead code, security).
argument-hint: "[optional-path-prefix]"
---

Run an architecture and code-health audit scoped to `$ARGUMENTS` (or the whole repository if empty):

1. Call `mcp__ggs__project_overview` and `mcp__ggs__analysis_module_graph`.
2. Call `mcp__ggs__analysis_import_cycles`, `mcp__ggs__analysis_metrics`, `mcp__ggs__analysis_dead_code`, and `mcp__ggs__analysis_security`.
3. Present a prioritized report: circular dependencies, top complexity hotspots, dead-code cleanup candidates, and security findings with exact `file:line` references.
