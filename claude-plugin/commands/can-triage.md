---
description: End-to-end CAN/CAN-FD trace triage (.blf/.asc + .dbc) correlated with source code.
argument-hint: "<logPath> [dbcPath]"
---

Triage the CAN trace and optional DBC database from `$ARGUMENTS`:

1. Call `mcp__ggs__can_log_summary` (check both `sortBy: "count"` and `sortBy: "jitter"`) to flag bus load spikes, error frames, and periodic jitter or frame drops.
2. If a `.dbc` path is provided (or found in the repo), call `mcp__ggs__dbc_lookup` and `mcp__ggs__can_signal_query` on anomalous CAN IDs to decode physical values and transitions.
3. Search the repository (`search_text` / `search_symbols` / `symbol_context`) for the corresponding CAN IDs or signal names to pinpoint the firmware/software root cause.
