---
name: ggs-engineering-brain
description: Use Git Graph Studio's persistent symbol index, refactoring engine, semantic git impact analyzer, and native binary parsers (CAN/DBC, ELF, DTS, DMP, CSV) to navigate large codebases and diagnose embedded/systems artifacts with minimal token usage.
---

# Git Graph Studio Engineering Brain

Prefer `mcp__ggs__*` tools over blind file reads or broad regex greps. The index is persistent and warm.

## 1. Progressive Disclosure Ladder (Code Navigation)
1. Call `project_overview` once to get repository size, languages, hub files, module graph edges, and dead-code count.
2. Drill down with `directory_tree(path, depth)` → `file_outline(path)` → `symbol_context(name)`.
3. Use `read_file(path, startLine, endLine)` only for the exact line window you need.
4. For C/C++ files with `#ifdef` / `#if` or heavy macros, call `compile_context(path, macroName, callLine)` before reasoning about active branches.

## 2. Edit & Refactor Loop
1. **Before editing**: check blast radius via `symbol_references`, `analysis_call_graph(direction="callers")`, and `git_blame_symbol`.
2. **Cross-file rename**: never edit occurrences one by one; run `symbol_rename(oldName, newName, dryRun=true)` first, confirm zero conflicts, then `symbol_rename(..., dryRun=false)`.
3. **After editing**: run `index_refresh(paths=[...])`, then `git_diff_impact(target="working")`, `analysis_dead_code`, and `analysis_security`.

## 3. Binary & Systems Engineering Senses
When the user asks about hardware logs, firmware, device trees, crash dumps, or telemetry tables:
- **CAN / CAN-FD traces (`.blf`, `.asc`) + `.dbc`**: run `can_log_summary` (check errors, bus load, high-jitter IDs) → `dbc_lookup` → `can_signal_query` → correlate CAN IDs / signal names back to source handlers via `search_text` / `symbol_context`.
- **Firmware / ELF (`.elf`, `.o`, `.so`)**: run `elf_inspect` for ROM/RAM footprint and top symbols, or `elf_diff(beforePath, afterPath)` for size regressions.
- **Device Trees (`.dts`, `.dtsi`, `.dtb`)**: run `dts_inspect(path, query)` to inspect nodes, `compatible` drivers, and properties.
- **Windows Minidumps (`.dmp`, `.mdmp`)**: run `dmp_summary(path, address)` to inspect OS/PID/exception/modules and map crash VAs to modules.
- **Large CSV/TSV logs**: run `csv_profile(path)` to inspect schema, numeric min/max/avg, and sample rows without loading megabytes of text.

## 4. Human Visual Handoff (Desktop Workbench)
After pinpointing a root cause, complex call chain, or diff, call `ui_open_location`, `ui_show_relation_graph`, or `ui_open_diff` so the user can visually verify your finding in Git Graph Studio.
