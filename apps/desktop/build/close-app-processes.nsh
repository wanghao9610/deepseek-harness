# Close every process of this application before an install or an uninstall
# touches the installation directory.
#
# electron-builder's own check does not fit this application. It gives up after
# two force-kill rounds in about six seconds, and it terminates single
# processes rather than process trees, while this application runs more than
# one process under its own image name: the desktop shell spawns the harness
# runtime from its own executable through ELECTRON_RUN_AS_NODE, and the
# supervisor restarts a runtime that has served for a minute with no delay.
# Terminating either process alone leaves the other to be found on the next
# scan, which is what raises "cannot be closed" while installed files stay
# locked and the install stalls.
#
# `taskkill /T` terminates each match together with its children, so one pass
# also reaps the shells and pty helpers the runtime started. The shell dies in
# that pass and nothing is left to restart the runtime; further passes only
# clear orphans a previous crash left behind, and the budget below is long
# enough to cover a machine paging them out slowly.

# Passes before the installer reports that it cannot close the application.
!define DSH_CLOSE_ATTEMPTS 20

# Pause between a kill and the check that follows it, in milliseconds.
!define DSH_CLOSE_POLL_MS 500

# Distinct label suffix per insertion: NSIS compiles the installer and the
# uninstaller as one script, and each inserts this macro.
!macro dshNextCloseId
  !ifndef DSH_CLOSE_ID
    !define DSH_CLOSE_ID 0
  !else
    !define /redef /math DSH_CLOSE_ID ${DSH_CLOSE_ID} + 1
  !endif
!macroend

# Report whether any process carries this application's image name.
# Sets the given register to 0 when one is running.
!macro dshFindAppProcess _RESULT
  nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop ${_RESULT}
!macroend

!macro customCheckAppRunning
  !insertmacro dshNextCloseId

  !insertmacro dshFindAppProcess $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK dshCloseApp_${DSH_CLOSE_ID}
      Quit
    ${endIf}

    dshCloseApp_${DSH_CLOSE_ID}:
    DetailPrint "$(appClosing)"
    StrCpy $R1 0
    ${Do}
      IntOp $R1 $R1 + 1
      nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
      Pop $R2
      Sleep ${DSH_CLOSE_POLL_MS}
      !insertmacro dshFindAppProcess $R0
      ${if} $R0 != 0
        ${ExitDo}
      ${endIf}
      ${if} $R1 >= ${DSH_CLOSE_ATTEMPTS}
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDOK
        Quit
      ${endIf}
    ${Loop}
  ${endIf}
!macroend
