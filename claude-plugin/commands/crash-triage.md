---
description: Triage a Windows minidump (.dmp/.mdmp) and correlate loaded modules with source code.
argument-hint: "<dumpPath> [hexVirtualAddress]"
---

Triage the Windows minidump specified in `$ARGUMENTS`:

1. Call `mcp__ggs__dmp_summary` (passing `address` if a hex VA was provided) to inspect OS/arch, PID, thread count, exception stream presence, and loaded modules.
2. Correlate relevant modules or crash-site symbols back to the repository with `mcp__ggs__search_symbols` and `mcp__ggs__symbol_context`.
