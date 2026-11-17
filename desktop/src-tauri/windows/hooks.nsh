; Runs inside the Windows installer (see bundle.windows.nsis.installerHooks in tauri.conf.json).

; An update copies the new files over the old ones and never removes a file the new version no longer has, so code from
; earlier versions piled up in the install folder (and the server still served old page scripts). The server code is
; deleted just before the new copy goes in. Only payload\app: the person's data lives in %APPDATA%\Rex Desk, never here.
; Running the installer by hand while Rex Desk is open closes the window but not the server, whose bundled node.exe
; then cannot be replaced ("Error opening file for writing"). Everything still running from the install folder is
; stopped first, the way the in-app update already does it. The installer is a 32-bit program, so its PowerShell cannot
; read the path of a 64-bit process through Get-Process; Win32_Process gives it.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$f = '$INSTDIR\'; for ($$i = 0; $$i -lt 20; $$i++) { $$p = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$f, [StringComparison]::OrdinalIgnoreCase) }); if (-not $$p.Count) { break }; $$p | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 300 }"`
  Pop $0
  RMDir /r "$INSTDIR\payload\app"
  ; On a drive Windows compresses to save space, the install folder was compressed too, and so was everything written into
  ; it: node.exe and the server's files. On a busy hard disk Node then needed minutes just to load (0% CPU, before any
  ; Rex Desk code ran), and the window stayed black. The folder and what is left in it are made uncompressed before the
  ; new files go in, so they are written uncompressed; a drive that is not compressed makes this a quick no-op.
  CreateDirectory "$INSTDIR"
  nsExec::Exec `compact.exe /u /s:"$INSTDIR" /i /q`
  Pop $0
!macroend
