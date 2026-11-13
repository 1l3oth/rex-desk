; Runs inside the Windows installer (see bundle.windows.nsis.installerHooks in tauri.conf.json).

; An update copies the new files over the old ones and never removes a file the new version no longer has, so code from
; earlier versions piled up in the install folder (and the server still served old page scripts). The server code is
; deleted just before the new copy goes in. Only payload\app: the person's data lives in %APPDATA%\Rex Desk, never here.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\payload\app"
!macroend
