; Runs inside the Windows installer (see bundle.windows.nsis.installerHooks in tauri.conf.json).
!include LogicLib.nsh

; An update copies the new files over the old ones and never removes a file the new version no longer has, so code from
; earlier versions piled up in the install folder (and the server still served old page scripts). So the new version is
; written into an empty payload folder. The working one is not deleted first: it is renamed to payload.old (one quick
; rename on the same disk) and only removed once the new copy is complete. When the copy fails, or the installer dies
; partway (an antivirus lock, a power cut), the old one goes back: here at the end, at the start of the next installer, or
; when the app starts (payload_swap.rs). The person's data lives in %APPDATA%\Rex Desk, never in payload.
; Running the installer by hand while Rex Desk is open closes the window but not the server, whose bundled node.exe
; then cannot be replaced ("Error opening file for writing"). Everything still running from the install folder is
; stopped first, the way the in-app update already does it. The installer is a 32-bit program, so its PowerShell cannot
; read the path of a 64-bit process through Get-Process; Win32_Process gives it.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$f = '$INSTDIR\'; for ($$i = 0; $$i -lt 20; $$i++) { $$p = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$f, [StringComparison]::OrdinalIgnoreCase) }); if (-not $$p.Count) { break }; $$p | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 300 }"`
  Pop $0
  ; A backup left by an install that never finished is the last copy that worked: it goes back before anything else.
  ${If} ${FileExists} "$INSTDIR\payload.old\app\src\server.js"
    RMDir /r "$INSTDIR\payload"
    Rename "$INSTDIR\payload.old" "$INSTDIR\payload"
  ${EndIf}
  RMDir /r "$INSTDIR\payload.old"
  ${If} ${FileExists} "$INSTDIR\payload\*.*"
    ; A virus scanner may still hold a file for a moment: try the rename a few times.
    StrCpy $1 0
    ${Do}
      ClearErrors
      Rename "$INSTDIR\payload" "$INSTDIR\payload.old"
      ${IfNot} ${Errors}
        ${Break}
      ${EndIf}
      IntOp $1 $1 + 1
      ${If} $1 >= 10
        ${Break}
      ${EndIf}
      Sleep 500
    ${Loop}
    ${If} ${FileExists} "$INSTDIR\payload.old\*.*"
      ; When the backup was made: the app waits a while before it puts a backup back, in case this installer still runs.
      FileOpen $2 "$INSTDIR\payload.old\.rex-desk-swap" w
      FileWrite $2 "installing"
      FileClose $2
    ${Else}
      ; The folder could not be moved: install over it as before (no way back, but the update still goes in).
      RMDir /r "$INSTDIR\payload\app"
    ${EndIf}
  ${EndIf}
  ; On a drive Windows compresses to save space, the install folder was compressed too, and so was everything written into
  ; it: node.exe and the server's files. On a busy hard disk Node then needed minutes just to load (0% CPU, before any
  ; Rex Desk code ran), and the window stayed black. The folder and what is left in it are made uncompressed before the
  ; new files go in, so they are written uncompressed; a drive that is not compressed makes this a quick no-op.
  CreateDirectory "$INSTDIR"
  nsExec::Exec `compact.exe /u /s:"$INSTDIR" /i /q`
  Pop $0
!macroend

; The new files are in. A complete copy (its node.exe and its server) drops the backup; an incomplete one is replaced by it.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\payload.old\*.*"
    ${If} ${FileExists} "$INSTDIR\payload\node\node.exe"
    ${AndIf} ${FileExists} "$INSTDIR\payload\app\src\server.js"
      RMDir /r "$INSTDIR\payload.old"
    ${Else}
      RMDir /r "$INSTDIR\payload"
      Rename "$INSTDIR\payload.old" "$INSTDIR\payload"
      Delete "$INSTDIR\payload\.rex-desk-swap"
    ${EndIf}
  ${EndIf}
!macroend
