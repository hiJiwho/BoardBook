!macro customInstall
  CreateShortCut "$DESKTOP\BoardBook.lnk" "$INSTDIR\BoardBook.exe" "--NotUSB"
  CreateShortCut "$SMPROGRAMS\BoardBook.lnk" "$INSTDIR\BoardBook.exe" "--NotUSB"
!macroend
