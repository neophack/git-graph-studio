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

; What lives outside the install directory (2026-10-12, the owner's direction: an uninstall
; leaves nothing of the program behind). Runs after Tauri's own removal and its app-is-
; running check, so a cancelled uninstall has touched nothing. Never on an update: the new
; version's installer runs this uninstaller with /UPDATE and must find the user's state —
; and the remote daemon the bundled GGS Remote package upgrades in place — as it was.
;
; Two tiers. Always: what the program put there and can rebuild — GGS Remote's tray daemon
; (its logon task, the process, its binary), the daemon's asset cache (whose version-keyed
; entries once served a reinstalled build's predecessor), the runtime files, the bytecode
; cache and the symbol indexes. Only with the uninstaller's own "Delete the application
; data" box ticked: the whole of ~/.ggs — settings, keybindings, extensions, the Claude
; state, the sealed provider keys, and the remote password, certificates and device key
; (the link's identity: a reinstall then gets a new link). Only the profile's own ~/.ggs is
; ever removed: a GGS_HOME override may name any directory, and an uninstaller must not
; recursively delete a path an environment variable chose.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    StrCpy $R5 "$PROFILE\.ggs"
    ; Every nsExec is capped: a child the uninstaller waits on must never hold the
    ; uninstall open (the 2026-10-12 stuck uninstall: taskkill /T with two /FI filters
    ; matched nothing and blocked forever, leaving the page parked on the last
    ; "Delete file" line — the log text only moves on file operations).
    ; The logon task first: it restarts a daemon that exits on failure, and a killed one
    ; reads as failed. The Run value is the fallback autostart some systems are given.
    nsExec::Exec /TIMEOUT=8000 'schtasks /Delete /TN "GGS Remote" /F'
    Pop $R6
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GGS Remote"
    ; A clean stop takes the tray icon with it; capped, since a wedged daemon's admin call
    ; would otherwise hold the uninstaller for its 30 s read timeout. Whatever is left of
    ; this user's daemon is then ended outright (another user's is theirs to keep).
    ${If} ${FileExists} "$R5\remote\bin\ggs-remote.exe"
      nsExec::Exec /TIMEOUT=3000 '"$R5\remote\bin\ggs-remote.exe" stop'
      Pop $R6
      Sleep 800
    ${EndIf}
    ReadEnvStr $R7 USERNAME
    ; No /T: the daemon's descendants are this machine's own app windows, which the
    ; app-is-running check already asked about — and /T beside two /FI filters hangs
    ; taskkill forever when the pair matches nothing (reproduced 2026-10-12).
    nsExec::Exec /TIMEOUT=8000 'taskkill /F /FI "IMAGENAME eq ggs-remote.exe" /FI "USERNAME eq $R7"'
    Pop $R6
    Sleep 500
    RMDir /r "$R5\remote\bin"
    RMDir /r "$R5\remote\cache"
    Delete "$R5\remote\loopback.json"
    Delete "$R5\remote\daemon.lock"
    RMDir /r "$R5\cache"
    RMDir /r "$R5\index"
    ${If} $DeleteAppDataCheckboxState = 1
      RMDir /r "$R5"
    ${EndIf}
  ${EndIf}
!macroend
