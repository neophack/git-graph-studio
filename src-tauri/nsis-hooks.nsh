; Module 15 — Build & Release Pipeline.
; The `ggs` command-line launcher (VS Code's `code` equivalent): the bundled
; binary is named ggs (see `mainBinaryName` in tauri.conf.json), so making the
; command reachable from any terminal only needs the install directory on the
; user's PATH. The deb/rpm packages get /usr/bin/ggs for free; this hook
; covers the NSIS installer, which does not touch PATH by itself. The
; uninstaller removes the directory again. Only HKCU is written — the default
; install mode is per-user, and a per-user entry is correct even when the app
; itself was installed per-machine.

; WordReplace comes from WordFunc.nsh, included by Tauri's installer.nsi
; before this file.

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 HKCU "Environment" "Path"
  ; Idempotent: an upgrade reinstalls into the same directory, and a duplicate
  ; PATH entry would grow the variable on every update.
  ${WordReplace} "$R0" "$INSTDIR" "GGS-ON-PATH" "+" $R1
  StrCmp $R1 "$R0" 0 ggs_path_done
    StrCmp $R0 "" 0 ggs_path_append
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
      Goto ggs_path_notify
    ggs_path_append:
      WriteRegExpandStr HKCU "Environment" "Path" "$R0;$INSTDIR"
    ggs_path_notify:
      ; Already-running terminals keep their PATH; this makes new explorer-spawned
      ; ones see it without a logoff.
      System::Call 'user32::SendMessageTimeout(p 0xffff, i 0x1A, p 0, t "Environment", i 2, i 5000, *p .r1)'
  ggs_path_done:
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
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrCmp $R0 "" ggs_unpath_done
  StrCmp $R0 "$INSTDIR" ggs_unpath_exact
  ${WordReplace} "$R0" "$INSTDIR;" "" "+" $R1
  ${WordReplace} "$R1" ";$INSTDIR" "" "+" $R1
  StrCmp $R1 "$R0" ggs_unpath_done ggs_unpath_write
  ggs_unpath_write:
    WriteRegExpandStr HKCU "Environment" "Path" "$R1"
    System::Call 'user32::SendMessageTimeout(p 0xffff, i 0x1A, p 0, t "Environment", i 2, i 5000, *p .r1)'
    Goto ggs_unpath_done
  ggs_unpath_exact:
    DeleteRegValue HKCU "Environment" "Path"
  ggs_unpath_done:
!macroend
