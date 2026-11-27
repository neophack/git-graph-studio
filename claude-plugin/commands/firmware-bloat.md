---
description: Analyze ELF firmware ROM/RAM footprint or diff two builds for size regressions.
argument-hint: "<elfPath> [baselineElfPath]"
---

Analyze firmware size for `$ARGUMENTS`:

1. Call `mcp__ggs__elf_inspect` on the target ELF binary to summarize ROM/RAM totals, top sections, and top symbols.
2. If a baseline ELF path is also provided, call `mcp__ggs__elf_diff(beforePath, afterPath)` to rank growing/new symbols and section deltas.
3. Cross-reference the largest or fastest-growing symbols with `mcp__ggs__symbol_context` and suggest concrete flash/RAM optimizations.
