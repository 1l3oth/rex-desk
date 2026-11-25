; Runs inside the Windows installer (see bundle.windows.nsis.installerHooks in tauri.conf.json).
!include LogicLib.nsh

; An update copies the new files over the old ones and never removes a file the new version no longer has, so code from
; earlier versions piled up in the install folder (and the server still served old page scripts). So the new version is
; written into an empty payload folder. The working one is never deleted first: it is renamed to payload.old (one quick
; rename on the same disk). Only when every new file matches the list the build wrote (.rex-desk-files: name and size)
; does the installer write the completion marker .rex-desk-complete and drop the backup. When the check fails, or the
; installer dies partway (an antivirus lock, a power cut), the old one goes back: here at the end, at the start of the
; next installer, or when the app starts (payload_swap.rs). When a folder cannot be moved, the install stops and the
; working copy stays; nothing falls back to deleting it. The person's data lives in %APPDATA%\Rex Desk, never in payload.
; The installer holds the named lock Local\RexDeskPayloadSwap the whole time it works on the payload, and the app takes
; the same lock before it puts a backup back, so the two never move folders at the same time. Windows frees the lock
; when the installer dies.

Var RexSwapLock
Var RexResult
Var RexFrom
Var RexTo
Var RexTry
Var RexList
Var RexLine
Var RexChar
Var RexAt
Var RexSize
Var RexPath
Var RexFile
Var RexGot
Var RexCount

; Renames $RexFrom to $RexTo. A virus scanner may still hold a file for a moment, so it tries a few times.
; $RexResult: ok or fail.
Function RexRename
  StrCpy $RexTry 0
  ${Do}
    ClearErrors
    Rename "$RexFrom" "$RexTo"
    ${IfNot} ${Errors}
      StrCpy $RexResult ok
      Return
    ${EndIf}
    IntOp $RexTry $RexTry + 1
    ${If} $RexTry >= 10
      StrCpy $RexResult fail
      Return
    ${EndIf}
    Sleep 500
  ${Loop}
FunctionEnd

; Puts payload.old back as payload. The unfinished payload is moved to payload.broken first and only deleted once the old
; copy is in place; when a rename fails, everything goes back as it was and payload.old is kept. $RexResult: ok or fail.
Function RexRestoreBackup
  RMDir /r "$INSTDIR\payload.broken"
  ${If} ${FileExists} "$INSTDIR\payload\*.*"
    StrCpy $RexFrom "$INSTDIR\payload"
    StrCpy $RexTo "$INSTDIR\payload.broken"
    Call RexRename
    ${If} $RexResult != ok
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $RexFrom "$INSTDIR\payload.old"
  StrCpy $RexTo "$INSTDIR\payload"
  Call RexRename
  ${If} $RexResult != ok
    ${If} ${FileExists} "$INSTDIR\payload.broken\*.*"
      Rename "$INSTDIR\payload.broken" "$INSTDIR\payload"
    ${EndIf}
    StrCpy $RexResult fail
    Return
  ${EndIf}
  RMDir /r "$INSTDIR\payload.broken"
FunctionEnd

; Checks the new payload against the list the build wrote: every file there, with its size. $RexResult: ok or bad.
Function RexCheckPayload
  StrCpy $RexResult bad
  StrCpy $RexCount 0
  ClearErrors
  FileOpen $RexList "$INSTDIR\payload\.rex-desk-files" r
  ${If} ${Errors}
    Return
  ${EndIf}
  ${Do}
    ClearErrors
    FileRead $RexList $RexLine
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    StrCpy $RexChar $RexLine 1 -1
    ${If} $RexChar == "$\n"
      StrCpy $RexLine $RexLine -1
    ${EndIf}
    StrCpy $RexChar $RexLine 1 -1
    ${If} $RexChar == "$\r"
      StrCpy $RexLine $RexLine -1
    ${EndIf}
    ${If} $RexLine == ""
      ${Continue}
    ${EndIf}
    ; "size|relative\path"
    StrCpy $RexAt 0
    ${Do}
      StrCpy $RexChar $RexLine 1 $RexAt
      ${If} $RexChar == "|"
      ${OrIf} $RexChar == ""
        ${Break}
      ${EndIf}
      IntOp $RexAt $RexAt + 1
    ${Loop}
    ${If} $RexChar != "|"
      FileClose $RexList
      Return
    ${EndIf}
    StrCpy $RexSize $RexLine $RexAt
    IntOp $RexAt $RexAt + 1
    StrCpy $RexPath $RexLine "" $RexAt
    ClearErrors
    FileOpen $RexFile "$INSTDIR\payload\$RexPath" r
    ${If} ${Errors}
      DetailPrint "Missing after the copy: $RexPath"
      FileClose $RexList
      Return
    ${EndIf}
    FileSeek $RexFile 0 END $RexGot
    FileClose $RexFile
    ${If} $RexGot != $RexSize
      DetailPrint "Incomplete after the copy: $RexPath"
      FileClose $RexList
      Return
    ${EndIf}
    IntOp $RexCount $RexCount + 1
  ${Loop}
  FileClose $RexList
  ${If} $RexCount > 0
    StrCpy $RexResult ok
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; Waits for the app if it is putting a backup back right now (a few renames), then holds the lock until the end.
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\RexDeskPayloadSwap") p .s'
  Pop $RexSwapLock
  System::Call 'kernel32::WaitForSingleObject(p $RexSwapLock, i 60000) i .s'
  Pop $RexResult
  ${If} $RexResult != 0
  ${AndIf} $RexResult != 128
    Abort "Rex Desk is busy restoring its last version. Nothing was changed. Run the update again in a minute."
  ${EndIf}
  ; Running the installer by hand while Rex Desk is open closes the window but not the server, whose bundled node.exe
  ; then cannot be replaced ("Error opening file for writing"). Everything still running from the install folder is
  ; stopped first, the way the in-app update already does it. The installer is a 32-bit program, so its PowerShell
  ; cannot read the path of a 64-bit process through Get-Process; Win32_Process gives it.
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$f = '$INSTDIR\'; for ($$i = 0; $$i -lt 20; $$i++) { $$p = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$f, [StringComparison]::OrdinalIgnoreCase) }); if (-not $$p.Count) { break }; $$p | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 300 }"`
  Pop $0
  ; A backup left by an install that never finished: when the new copy was checked and marked, only the clean-up was
  ; lost; otherwise the backup is the last copy that worked and goes back first.
  ${If} ${FileExists} "$INSTDIR\payload.old\*.*"
    ${If} ${FileExists} "$INSTDIR\payload\.rex-desk-complete"
      RMDir /r "$INSTDIR\payload.old"
    ${Else}
      Call RexRestoreBackup
      ${If} $RexResult != ok
        Abort "Rex Desk could not put its last working version back (a file in its folder is in use), so the update stopped and nothing was removed. Close Rex Desk and run the update again."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\payload\*.*"
    ${If} ${FileExists} "$INSTDIR\payload.old\*.*"
      Abort "An old Rex Desk backup could not be cleared (a file in it is in use), so the update stopped and the current version stays. Run the update again in a minute."
    ${EndIf}
    StrCpy $RexFrom "$INSTDIR\payload"
    StrCpy $RexTo "$INSTDIR\payload.old"
    Call RexRename
    ${If} $RexResult != ok
      Abort "Rex Desk could not move its current version aside (a file in its folder is in use), so the update stopped and the current version stays. Run the update again in a minute."
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

; The new files are in. A copy that matches the file list gets the completion marker and the backup goes; any other copy
; is replaced by the backup. If even that cannot be done now, the backup stays for the app or the next installer.
!macro NSIS_HOOK_POSTINSTALL
  ; Windows will not rename a folder the installer is working in, so it steps out of payload first.
  SetOutPath "$INSTDIR"
  Call RexCheckPayload
  ${If} $RexResult == ok
    ClearErrors
    FileOpen $RexFile "$INSTDIR\payload\.rex-desk-complete" w
    FileWrite $RexFile "complete"
    FileClose $RexFile
    ${If} ${Errors}
      StrCpy $RexResult bad
    ${EndIf}
  ${EndIf}
  ${If} $RexResult == ok
    RMDir /r "$INSTDIR\payload.old"
  ${ElseIf} ${FileExists} "$INSTDIR\payload.old\*.*"
    DetailPrint "The new version did not install completely, so the last version is put back."
    Call RexRestoreBackup
    ${If} $RexResult != ok
      DetailPrint "The last version could not be put back yet; Rex Desk puts it back when it next starts."
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::ReleaseMutex(p $RexSwapLock)'
  System::Call 'kernel32::CloseHandle(p $RexSwapLock)'
!macroend
