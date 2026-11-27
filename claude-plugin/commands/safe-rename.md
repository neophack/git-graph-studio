---
description: Conflict-checked, encoding-preserving workspace symbol rename.
argument-hint: "<oldName> <newName>"
---

Safely rename a symbol across the workspace using `$ARGUMENTS`:

1. Parse `<oldName>` and `<newName>` from `$ARGUMENTS`.
2. Call `mcp__ggs__symbol_rename` with `dryRun: true` first.
3. If conflicts exist, report them clearly and stop.
4. If zero conflicts exist, confirm the site count and apply with `dryRun: false`, then verify with `mcp__ggs__git_diff_impact(target="working")`.
