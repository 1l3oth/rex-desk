; Runs inside the Windows installer (see bundle.windows.nsis.installerHooks in tauri.conf.json).

; An update copies the new files over the old ones and never removes a file the new version no longer has, so code from
; earlier versions piled up in the install folder (and the server still served old page scripts). The server code is
; deleted just before the new copy goes in. Only payload\app: the person's data lives in %APPDATA%\Rex Desk, never here.
; Running the installer by hand while Rex Desk is open closes the window but not the server, whose bundled node.exe
; then cannot be replaced ("Error opening file for writing"). Everything still running from the install folder is
; stopped first, the way the in-app update already does it.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$f = '$INSTDIR\'; for ($$i = 0; $$i -lt 20; $$i++) { $$p = @(Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$f, [StringComparison]::OrdinalIgnoreCase) }); if (-not $$p.Count) { break }; $$p | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300 }"`
  Pop $0
  RMDir /r "$INSTDIR\payload\app"
!macroend
