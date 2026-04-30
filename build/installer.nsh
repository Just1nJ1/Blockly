; Custom NSIS installer script for WLKATA StudioX
; Adds checkboxes for desktop and start menu shortcuts

!include "MUI2.nsh"

Var CreateDesktopShortcut
Var CreateStartMenuShortcut

; Custom page for shortcut options
Function customShortcutPage
  nsDialogs::Create 1018
  Pop $0
  
  ${NSD_CreateCheckbox} 0 0 100% 12u "Create Desktop Shortcut"
  Pop $CreateDesktopShortcut
  ${NSD_SetState} $CreateDesktopShortcut ${BST_CHECKED}
  
  ${NSD_CreateCheckbox} 0 20u 100% 12u "Create Start Menu Shortcut"
  Pop $CreateStartMenuShortcut
  ${NSD_SetState} $CreateStartMenuShortcut ${BST_CHECKED}
  
  nsDialogs::Show
FunctionEnd

Function customShortcutPageLeave
  ${NSD_GetState} $CreateDesktopShortcut $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $CreateDesktopShortcut "1"
  ${Else}
    StrCpy $CreateDesktopShortcut "0"
  ${EndIf}
  
  ${NSD_GetState} $CreateStartMenuShortcut $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $CreateStartMenuShortcut "1"
  ${Else}
    StrCpy $CreateStartMenuShortcut "0"
  ${EndIf}
FunctionEnd

!macro customInstall
  ; Create desktop shortcut if selected
  ${If} $CreateDesktopShortcut == "1"
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  ${EndIf}
  
  ; Create start menu shortcut if selected
  ${If} $CreateStartMenuShortcut == "1"
    CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk" "$INSTDIR\Uninstall ${PRODUCT_NAME}.exe"
  ${EndIf}
!macroend

!macro customUnInstall
  ; Remove desktop shortcut
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  
  ; Remove start menu shortcuts
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"
!macroend