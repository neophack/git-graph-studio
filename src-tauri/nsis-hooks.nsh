; Module 15 — Build & Release Pipeline.
; The `ggs` command-line launcher (VS Code's `code` equivalent): the bundled
; binary is named ggs (see `mainBinaryName` in tauri.conf.json), so making the
; command reachable from any terminal only needs the install directory on the
; user's PATH. The deb/rpm packages get /usr/bin/ggs for free. The NSIS hooks
; DO NOT write PATH: an NSIS ReadRegStr is string-length limited, and a user
; PATH past that limit once read back empty — the hook's "Path was empty"
; branch then wrote the install directory alone, wiping the variable
; (2026-09-23). `cmd_assoc::user_path_apply` appends the install directory
; idempotently at every boot instead, with no length limit; only HKCU is
; written — per-user, correct even when the app itself was installed
; per-machine. The uninstaller below still deletes the entry, but only when
; the value is exactly the install directory (the empty shell a fresh install
; leaves) — never by rewriting a multi-entry PATH through NSIS string space.

; WordReplace comes from WordFunc.nsh, included by Tauri's installer.nsi
; before this file.

!macro NSIS_HOOK_POSTINSTALL
  ; PATH is deliberately untouched here — see the module comment. The app's
  ; boot pass (`cmd_assoc::user_path_apply`) appends the install directory
  ; idempotently, without NSIS's string-length read limits.
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The File Associations service (cmd_assoc) writes per-user ProgIds and the
  ; RegisteredApplications entry under HKCU; the installer never owns them, so the
  ; uninstaller removes them here - a leftover would leave "Git Graph Studio" in
  ; Default Apps pointing at a deleted executable.
  DeleteRegValue HKCU "Software\RegisteredApplications" "Git Graph Studio"
  DeleteRegKey HKCU "Software\Git Graph Studio"
  DeleteRegValue HKCU "Software\Classes\.blf" "GGS.blf.1"
  DeleteRegValue HKCU "Software\Classes\.asc" "GGS.asc.1"
  DeleteRegValue HKCU "Software\Classes\.ggx" "GGS.ggx.1"
  DeleteRegValue HKCU "Software\Classes\.bin" "GGS.bin.1"
  DeleteRegValue HKCU "Software\Classes\.hex" "GGS.hex.1"
  DeleteRegKey /ifempty HKCU "Software\Classes\.blf"
  DeleteRegKey /ifempty HKCU "Software\Classes\.asc"
  DeleteRegKey /ifempty HKCU "Software\Classes\.ggx"
  DeleteRegKey /ifempty HKCU "Software\Classes\.bin"
  DeleteRegKey /ifempty HKCU "Software\Classes\.hex"
  ; The ProgIds themselves are ours alone (named GGS.*), so they go unconditionally.
  DeleteRegKey HKCU "Software\Classes\GGS.blf.1"
  DeleteRegKey HKCU "Software\Classes\GGS.asc.1"
  DeleteRegKey HKCU "Software\Classes\GGS.ggx.1"
  DeleteRegKey HKCU "Software\Classes\GGS.bin.1"
  DeleteRegKey HKCU "Software\Classes\GGS.hex.1"
  ; The Explorer context-menu verbs (cmd_assoc's context_menu_apply) - the same four
  ; targets the command writes, removed whatever executable they name: a leftover would
  ; keep "Open with Git Graph Studio" in the right-click menu with a dead command.
  DeleteRegKey HKCU "Software\Classes\*\shell\GitGraphStudio"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\GitGraphStudio"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\GitGraphStudio"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\GitGraphStudio"
  ReadRegStr $R0 HKCU "Environment" "Path"
  ; Only the empty shell a fresh install could leave is deleted — anything
  ; multi-entry belongs to the user and must never be rewritten from NSIS
  ; string space (the module comment's wipe).
  StrCmp $R0 "$INSTDIR" 0 ggs_unpath_done
    DeleteRegValue HKCU "Environment" "Path"
    System::Call 'user32::SendMessageTimeout(p 0xffff, i 0x1A, p 0, t "Environment", i 2, i 5000, *p .r1)'
  ggs_unpath_done:
!macroend
