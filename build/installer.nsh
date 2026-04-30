; Custom NSIS installer script for WLKATA StudioX
; Adds a custom page with checkboxes for shortcuts

!include "nsDialogs.nsh"
!include "MUI2.nsh"

; Suppress warning 6010 (unreferenced function) - the Page custom directive
; inside the customWelcomePage macro references these functions but NSIS
; doesn't track references across macro boundaries.
!pragma warning disable 6010

Var DesktopShortcutCheckbox
Var StartMenuShortcutCheckbox
Var CreateDesktopShortcut
Var CreateStartMenuShortcut

Function ShortcutOptionsPage
  !insertmacro MUI_HEADER_TEXT "Shortcut Options" "Choose which shortcuts to create."

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 0 100% 12u "Create Desktop Shortcut"
  Pop $DesktopShortcutCheckbox
  ${NSD_SetState} $DesktopShortcutCheckbox ${BST_CHECKED}

  ${NSD_CreateCheckbox} 0 20u 100% 12u "Create Start Menu Shortcut"
  Pop $StartMenuShortcutCheckbox
  ${NSD_SetState} $StartMenuShortcutCheckbox ${BST_CHECKED}

  nsDialogs::Show
FunctionEnd

Function ShortcutOptionsPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $CreateDesktopShortcut
  ${NSD_GetState} $StartMenuShortcutCheckbox $CreateStartMenuShortcut
FunctionEnd

!macro customInit
  StrCpy $CreateDesktopShortcut ${BST_CHECKED}
  StrCpy $CreateStartMenuShortcut ${BST_CHECKED}
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  Page custom ShortcutOptionsPage ShortcutOptionsPageLeave
!macroend

!macro customInstall
  ${If} $CreateDesktopShortcut == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  ${EndIf}

  ${If} $CreateStartMenuShortcut == ${BST_CHECKED}
    CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"
!macroend